"""stable-diffusion.cpp sidecar used by the DiT backends.

One child process hosts one model configuration. Switching model files restarts
it; measurements on this machine put a restart at ~0.5 s plus the model load, so
the swap stays cheap even without the server's newer hot-load API.

The server exposes the native job API used here:
    POST /sdcpp/v1/img_gen      -> {id, poll_url, status}
    GET  /sdcpp/v1/jobs/<id>    -> {status, result: {images: [{b64_json, index}]}, error}
"""

from __future__ import annotations

import json
import os
import subprocess
import threading
import time
import urllib.request

from modules import shared

SD_CPP_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "sd_cpp")
SERVER_EXE = os.path.join(SD_CPP_DIR, "sd-server.exe")
LOG_PATH = os.path.join(SD_CPP_DIR, "anima_server.log")

DEFAULT_PORT = 7866
STARTUP_TIMEOUT = 300.0
POLL_INTERVAL = 0.25


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
    return ""


def get_port() -> int:
    try:
        return int(shared.opts.anima_server_port or DEFAULT_PORT)
    except Exception:
        return DEFAULT_PORT


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

    # --------------------------------------------------------------- process
    @staticmethod
    def _args(model, text_encoder, vae, port):
        return [
            SERVER_EXE,
            "--diffusion-model", model,
            "--llm", text_encoder,
            "--vae", vae,
            "--listen-ip", "127.0.0.1",
            "--listen-port", str(port),
            "--vae-tiling",
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
        config = (os.path.abspath(model), os.path.abspath(text_encoder), os.path.abspath(vae), port)

        with self._lock:
            if self.is_alive() and self._config == config and self.health():
                return

            self.stop()
            self._port = port

            for label, path in (("diffusion model", model), ("text encoder", text_encoder), ("VAE", vae)):
                if not path or not os.path.isfile(path):
                    raise SdcppError(f"Anima {label} not found: {path}")

            os.makedirs(SD_CPP_DIR, exist_ok=True)
            log = open(LOG_PATH, "wb")
            try:
                self._proc = subprocess.Popen(
                    self._args(model, text_encoder, vae, port),
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

            status = self.poll(job_id)
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
