"""stable-diffusion.cpp sidecar used by the DiT backends.

One child process hosts one model configuration. Switching model files restarts
it; measurements on this machine put a restart at ~0.5 s plus the model load, so
the swap stays cheap even without the server's newer hot-load API.

The server exposes the native job API used here:
    POST /sdcpp/v1/img_gen      -> {id, poll_url, status}
    GET  /sdcpp/v1/jobs/<id>    -> {status, result: {images: [{b64_json, index}]}, error}
"""

from __future__ import annotations

import atexit
import json
import os
import socket
import subprocess
import threading
import time
import urllib.request

from modules import model_registry, shared, sidecar_process

SD_CPP_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "sd_cpp")
SERVER_EXE = os.path.join(SD_CPP_DIR, "sd-server.exe")
LOG_PATH = os.path.join(SD_CPP_DIR, "anima_server.log")

DEFAULT_PORT = 7866
STARTUP_TIMEOUT = 300.0
POLL_INTERVAL = 0.25

# Speed switches that do not change the maths: flash attention in the DiT and direct
# convolutions in the VAE decoder. Measured on a 2B Anima checkpoint / RTX 5070 Ti,
# 20 steps, CFG 4: 832x1216 drops from 27.9s to 16.0s and 512x768 from 8.5s to 5.6s.
# They are also what keeps the cost per pixel flat as the resolution grows - without
# flash attention a 1 MP job pays ~30% more per pixel than a 0.4 MP one. Older sd.cpp
# builds do not know the flags, so they are only passed when the executable lists them
# in --help.
PERF_FLAGS = ("--diffusion-fa", "--vae-conv-direct")

_perf_flags_cache: dict[tuple[str, float], tuple[str, ...]] = {}


def supported_perf_flags() -> tuple[str, ...]:
    """The PERF_FLAGS entries this sd-server build accepts (probed once per executable)."""
    try:
        stamp = os.path.getmtime(SERVER_EXE)
    except OSError:
        return ()

    key = (SERVER_EXE, stamp)
    if key in _perf_flags_cache:
        return _perf_flags_cache[key]

    flags: tuple[str, ...] = ()
    try:
        probe = subprocess.run(
            [SERVER_EXE, "--help"],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=60,
            check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        text = probe.stdout.decode("utf-8", "replace")
        flags = tuple(flag for flag in PERF_FLAGS if flag in text)
    except Exception:
        flags = ()

    _perf_flags_cache[key] = flags
    return flags


class SdcppError(RuntimeError):
    def __init__(self, message, details=""):
        hint = _failure_hint(details or "")
        tail = " ".join((details or "").strip().splitlines()[-2:])[:300]
        text = message
        if hint:
            text = f"{message}. {hint}"
        elif tail:
            text = f"{message}: {tail}"
        super().__init__(text)
        self.details = details


def _failure_hint(details: str) -> str:
    if "llm_adapter" in details or "t_embedder" in details:
        return (
            "This checkpoint looks like Anima 2.9B; stable-diffusion.cpp builds the text adapter "
            "1024 wide and rejects the 2048-wide tensors. Use a 2B Anima model (Nova Anime AM v4.0 or earlier)"
        )
    if "can not found lora" in details or "invalid lora" in details:
        return (
            "the sidecar cannot resolve that LoRA from models/Anima/loras; a stable-diffusion.cpp "
            "instance from an older WebUI run may still hold the port without the LoRA folder - "
            "stop it (scripts/kill-webuis.ps1) or change the sidecar port in the DiT settings"
        )
    if "cannot make enough memory available" in details or "reported free 0.00" in details:
        return (
            "the GPU ran out of free VRAM; the SD checkpoint is parked automatically, so close other "
            "GPU apps or lower the resolution"
        )
    return ""


def get_port() -> int:
    try:
        return int(shared.opts.anima_server_port or DEFAULT_PORT)
    except Exception:
        return DEFAULT_PORT


def port_is_taken(port: int) -> bool:
    """True when something already accepts connections on 127.0.0.1:port."""
    try:
        with socket.create_connection(("127.0.0.1", int(port)), timeout=0.5):
            return True
    except OSError:
        return False


def _orphaned_sidecar(port: int):
    """The sd-server.exe listening on *port* whose WebUI parent is gone, if any."""
    try:
        import psutil
    except ImportError:
        return None

    try:
        listeners = [
            conn.pid
            for conn in psutil.net_connections(kind="tcp")
            if conn.pid and conn.status == psutil.CONN_LISTEN and conn.laddr and conn.laddr.port == port
        ]
    except (psutil.Error, OSError):
        return None

    mine = os.getpid()
    for pid in set(listeners) - {mine}:
        try:
            proc = psutil.Process(pid)
            if os.path.normcase(os.path.abspath(proc.exe())) != os.path.normcase(os.path.abspath(SERVER_EXE)):
                continue
            parent_pid = proc.ppid()
            if not parent_pid or not psutil.pid_exists(parent_pid):
                return proc
            # a WebUI that is still running owns it - leave it alone
            if "python" not in " ".join(psutil.Process(parent_pid).cmdline()).lower():
                return proc
        except (psutil.Error, OSError):
            continue
    return None


def _reclaim_orphaned_sidecar(port: int) -> bool:
    """Stop a sidecar left behind by a previous run so the port can be bound again."""
    try:
        import psutil
    except ImportError:
        return False

    proc = _orphaned_sidecar(port)
    if proc is None:
        return False

    try:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except psutil.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=10)
    except (psutil.Error, OSError):
        return False
    print(f"stopped leftover stable-diffusion.cpp sidecar (pid {proc.pid}) holding port {port}")
    return True


class SdcppServer:
    """Process + HTTP client for one sd.cpp server instance."""

    def __init__(self):
        self._lock = threading.RLock()
        self._proc = None
        self._config = None
        self._port = DEFAULT_PORT
        # localhost calls must bypass the system proxy, otherwise a dead proxy
        # swallows every request and the sidecar looks offline
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    # ------------------------------------------------------------------ http
    def _url(self, path: str) -> str:
        return f"http://127.0.0.1:{self._port}{path}"

    def _request(self, method: str, path: str, body=None, timeout: float = 30.0):
        data = json.dumps(body).encode("utf-8") if body is not None else None
        request = urllib.request.Request(
            self._url(path), data=data, method=method,
            headers={"Content-Type": "application/json"} if data is not None else {},
        )
        with self._opener.open(request, timeout=timeout) as response:
            payload = response.read().decode("utf-8", "replace")
        return json.loads(payload) if payload else {}

    def is_alive(self) -> bool:
        with self._lock:
            return self._proc is not None and self._proc.poll() is None

    def health(self) -> bool:
        try:
            with self._opener.open(self._url("/"), timeout=2.0) as response:
                return response.status == 200
        except Exception:
            return False

    def ready_for(self, model: str, text_encoder: str, vae: str) -> bool:
        """True when this process already serves exactly this model configuration."""
        config = self._config_for(model, text_encoder, vae, get_port())
        with self._lock:
            return self._proc is not None and self._proc.poll() is None and self._config == config

    # --------------------------------------------------------------- process
    @staticmethod
    def _config_for(model: str, text_encoder: str, vae: str, port: int) -> tuple:
        # the speed flags belong to the identity too: a sidecar started before this
        # build of the WebUI knew them has to be restarted, not reused
        return (os.path.abspath(model), os.path.abspath(text_encoder), os.path.abspath(vae), port, supported_perf_flags())

    @staticmethod
    def _args(model, text_encoder, vae, port, flags=()):
        return [
            SERVER_EXE,
            "--diffusion-model", model,
            "--llm", text_encoder,
            "--vae", vae,
            "--listen-ip", "127.0.0.1",
            "--listen-port", str(port),
            "--lora-model-dir", model_registry.lora_dir(),
            "--vae-tiling",
            *flags,
        ]

    def _log_tail(self, limit=1200):
        try:
            with open(LOG_PATH, "rb") as handle:
                handle.seek(0, os.SEEK_END)
                size = handle.tell()
                handle.seek(max(0, size - limit))
                return handle.read().decode("utf-8", "replace")
        except OSError:
            return ""

    def ensure_running(self, model: str, text_encoder: str, vae: str) -> None:
        """Start the sidecar, or restart it when the model configuration changed."""
        port = get_port()
        config = self._config_for(model, text_encoder, vae, port)

        with self._lock:
            if self.is_alive() and self._config == config and self.health():
                return

            self.stop()
            self._port = port

            for label, path in (("diffusion model", model), ("text encoder", text_encoder), ("VAE", vae)):
                if not path or not os.path.isfile(path):
                    raise SdcppError(f"Anima {label} not found: {path}")

            os.makedirs(SD_CPP_DIR, exist_ok=True)
            # the sidecar scans its LoRA directory at startup; an absent folder is
            # reported as a scan error, so make sure it exists
            os.makedirs(model_registry.lora_dir(), exist_ok=True)

            # A sidecar left behind by a previous WebUI run keeps the port warm. The new
            # child would fail to bind, and the jobs would go to the old process with the
            # old launch arguments (no LoRA folder, for one) - so reclaim the port from an
            # orphan, and say so when something else holds it.
            if port_is_taken(port):
                _reclaim_orphaned_sidecar(port)
                deadline = time.time() + 10.0
                while port_is_taken(port) and time.time() < deadline:
                    time.sleep(POLL_INTERVAL)
            if port_is_taken(port):
                raise SdcppError(
                    f"port {port} is already used by another stable-diffusion.cpp instance, "
                    "probably a sidecar left over from a previous WebUI run; stop it "
                    "(scripts/kill-webuis.ps1) or change the sidecar port in the DiT settings"
                )

            log = open(LOG_PATH, "wb")
            try:
                self._proc = sidecar_process.spawn(
                    self._args(model, text_encoder, vae, port, config[-1]),
                    cwd=SD_CPP_DIR,
                    stdout=log,
                    stderr=subprocess.STDOUT,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
            finally:
                log.close()

            self._config = config
            deadline = time.time() + STARTUP_TIMEOUT
            while time.time() < deadline:
                if self._proc.poll() is not None:
                    details = self._log_tail()
                    self._proc = None
                    self._config = None
                    raise SdcppError("stable-diffusion.cpp exited while loading the Anima model", details)
                if self.health():
                    # make sure we are talking to *our* server: a stale process on the
                    # same port would answer health checks but host another model
                    self._verify_loaded_model(os.path.basename(model))
                    return
                time.sleep(POLL_INTERVAL)

            self.stop()
            raise SdcppError("stable-diffusion.cpp did not become ready in time", self._log_tail())

    def _verify_loaded_model(self, expected_stem: str) -> None:
        try:
            info = self._request("GET", "/sdapi/v1/options", timeout=10.0)
        except Exception:
            return

        loaded = str(info.get("sd_model_checkpoint") or "")
        if loaded and os.path.splitext(loaded)[0] != os.path.splitext(expected_stem)[0]:
            self.stop()
            raise SdcppError(
                f"port {self._port} is already used by another stable-diffusion.cpp instance "
                f"(loaded: {loaded!r}); change the sidecar port in the DiT settings"
            )

    def stop(self) -> None:
        with self._lock:
            proc = self._proc
            self._proc = None
            self._config = None
            if proc is None:
                return
            try:
                proc.terminate()
                proc.wait(timeout=15)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass

    # ------------------------------------------------------------------ jobs
    def submit(self, payload: dict) -> str:
        response = self._request("POST", "/sdcpp/v1/img_gen", payload, timeout=60.0)
        job_id = response.get("id") or response.get("job_id")
        if not job_id:
            raise SdcppError("sd.cpp did not return a job id", json.dumps(response)[:500])
        return job_id

    def poll(self, job_id: str) -> dict:
        return self._request("GET", f"/sdcpp/v1/jobs/{job_id}", timeout=15.0)

    def wait(self, job_id: str, on_progress=None, cancel_check=None, timeout: float = 3600.0) -> dict:
        started = time.time()
        while True:
            if cancel_check is not None and cancel_check():
                try:
                    self._request("POST", f"/sdcpp/v1/jobs/{job_id}/cancel", timeout=10.0)
                except Exception:
                    pass
                raise SdcppError("cancelled")

            try:
                status = self.poll(job_id)
            except Exception as error:
                if not self.is_alive():
                    raise SdcppError("stable-diffusion.cpp stopped while generating", self._log_tail()) from error
                if time.time() - started > timeout:
                    raise SdcppError("sd.cpp job timed out") from error
                time.sleep(POLL_INTERVAL)
                continue

            state = str(status.get("status") or "")
            if state in ("completed", "failed", "cancelled"):
                if state != "completed":
                    message = status.get("error") or f"sd.cpp job {state}"
                    raise SdcppError(str(message)[:2000])
                return status

            if on_progress is not None:
                on_progress(time.time() - started)

            if time.time() - started > timeout:
                raise SdcppError("sd.cpp job timed out")
            time.sleep(POLL_INTERVAL)


server = SdcppServer()
# without this a Ctrl+C or a closed console leaves sd-server.exe holding the port
atexit.register(server.stop)
