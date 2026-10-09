"""Krea 2 sidecar manager: drives sd_cpp/sd-server.exe for the Krea 2 tab.

Krea 2 (12B MMDiT + Wan 2.1 VAE + Qwen3-VL-4B text encoder) cannot run in the
A1111 pipeline; it is served by stable-diffusion.cpp on its own port, mirroring
the Qwen-Image 2.1 sidecar (modules/qwen_image_manager.py).

Default weights = "Krea 2 Turbo Edit v1.1 uncensored" (ChrisColeTech GGUF with
baked-in NSFW refusal-reduction LoRAs); the Krea Noct V4 int8 merge and the
official Krea-2-Turbo Q6_K GGUF act as fallbacks.  Override with the
KREA2_MODEL_FILE env var (absolute path, or a file name inside
models/Krea-2/diffusion_models/).  The VAE defaults to wan_2.1 (sd.cpp docs) and
falls back to qwen_image_vae (Comfy-Org Krea-2 package); override with
KREA2_VAE_FILE.

Reference-image editing (Krea 2 community edit LoRAs, sd.cpp >= master-9xx):
references are passed through the Qwen3-VL vision projector
(text_encoders/mmproj-Qwen3VL-4B-Instruct-F16.gguf) plus VAE latents, using the
"krea2_edit" preset that matches the identity-edit LoRA in the default merge
(verified best identity + scene retention).  Override the preset with
KREA2_REF_PRESET (krea2_ostris_edit for other community edit LoRAs, "auto" for
sd.cpp's default, "off" to disable reference support).
"""
import json
import os
import socket
import subprocess
import threading
import time
import urllib.request


_ROOT_DIR = os.path.dirname(os.path.dirname(__file__))
_SD_CPP_DIR = os.path.join(_ROOT_DIR, "sd_cpp")
_MODELS_DIR = os.path.join(_ROOT_DIR, "models", "Krea-2")
_LOG_PATH = os.path.join(_SD_CPP_DIR, "krea2_server.log")

_SERVER_HOST = os.environ.get("KREA2_IMAGE_SERVER_HOST", "127.0.0.1")
_SERVER_PORT = int(os.environ.get("KREA2_IMAGE_SERVER_PORT", "7864"))
_SERVER_URL = f"http://{_SERVER_HOST}:{_SERVER_PORT}/"

SD_SERVER_EXE = os.path.join(_SD_CPP_DIR, "sd-server.exe")
TEXT_ENCODER = os.path.join(_MODELS_DIR, "text_encoders", "Qwen3VL-4B-Instruct-Q4_K_M.gguf")
# Vision projector for reference-image editing - the edit LoRAs read the
# reference through the Qwen3-VL conditioner (sd.cpp --llm_vision).
VISION_ENCODER = os.path.join(_MODELS_DIR, "text_encoders", "mmproj-Qwen3VL-4B-Instruct-F16.gguf")

# First existing file wins.
# Q4_K_M = fast native path at every tested resolution (512..1024x1536);
# Q6_K = max quality (native up to ~768px, needs --offload-to-cpu for 1024+ on 16GB);
# Noct V4 int8 = needs a newer sd.cpp build (master-890 fails its workspace check);
# official Krea-2-Turbo Q6_K = baseline/fallback.
_MODEL_PREFERENCE = [
    "Krea2_turbo_uncensored_edit_v1.1-Q4_K_M.gguf",  # uncensored turbo merge (5 LoRAs baked in)
    "Krea2_turbo_uncensored_edit-v1.1-Q6_K.gguf",  # same merge, higher precision
    "Krea-2-Turbo-Q6_K.gguf",  # official baseline
    "KreaNoct_V4_int8_convrot.safetensors",  # dedicated NSFW photoreal merge (build-dependent)
]
_VAE_PREFERENCE = ["wan_2.1_vae.safetensors", "qwen_image_vae.safetensors"]


def _diffusion_model() -> str:
    override = os.environ.get("KREA2_MODEL_FILE", "").strip()
    if override:
        return override if os.path.isabs(override) else os.path.join(_MODELS_DIR, "diffusion_models", override)
    for name in _MODEL_PREFERENCE:
        candidate = os.path.join(_MODELS_DIR, "diffusion_models", name)
        if os.path.isfile(candidate):
            return candidate
    return os.path.join(_MODELS_DIR, "diffusion_models", _MODEL_PREFERENCE[0])


def get_model_name() -> str:
    """Active diffusion model (file stem) - shown in the UI and the infotext."""
    return os.path.splitext(os.path.basename(_diffusion_model()))[0]


def _vae_model() -> str:
    override = os.environ.get("KREA2_VAE_FILE", "").strip()
    if override:
        return override if os.path.isabs(override) else os.path.join(_MODELS_DIR, "vae", override)
    for name in _VAE_PREFERENCE:
        candidate = os.path.join(_MODELS_DIR, "vae", name)
        if os.path.isfile(candidate):
            return candidate
    return os.path.join(_MODELS_DIR, "vae", _VAE_PREFERENCE[0])


def _ref_preset() -> str:
    """Reference-image edit preset sent to sd.cpp via --ref-image-args.

    "krea2_edit" matches the identity-edit LoRA baked into the default uncensored
    merge; "krea2_ostris_edit" suits other community edit LoRAs; "auto" leaves
    sd.cpp's own default (krea2_ostris_edit); "off" disables reference support.
    """
    override = (os.environ.get("KREA2_REF_PRESET") or "krea2_edit").strip()
    return "" if override.lower() in ("", "off", "none") else override


def _server_args() -> list:
    # Krea 2 Turbo is distilled: 8 steps at CFG 1.0 (per the model cards).  The
    # desktop tab sends per-request steps/cfg; these defaults cover the raw
    # sd.cpp web UI.  --vae-tiling keeps the VAE decode memory in check.
    args = [
        "--diffusion-model", _diffusion_model(),
        "--vae", _vae_model(),
        "--llm", TEXT_ENCODER,
        "--steps", "8",
        "--cfg-scale", "1.0",
        "--sampling-method", "euler",
        "--diffusion-fa",
        "--vae-tiling",
        # 64x64 VAE tiles: measured ~0.8s faster decode than the 32x32 default
        # (fewer tiles = less per-tile overhead; the decode runs on the CPU here).
        "--vae-tile-size", "64x64",
        # The Q6_K DiT uses ~10GB of the 16GB card; keeping the text encoder (2.4GB)
        # and VAE in RAM leaves enough VRAM for the sampling workspace.  Auto-fit
        # sometimes places the TE in VRAM (it did when system RAM was busy) and then
        # sampling dies in the workspace check - pinning here is deterministic.
        "--params-backend", "te=cpu,vae=cpu",
    ]
    # Reference-image editing: needs the vision projector; the preset override is
    # only sent when it differs from sd.cpp's own default (krea2_ostris_edit).
    preset = _ref_preset()
    if preset and os.path.isfile(VISION_ENCODER):
        if preset.lower() != "auto":
            args += ["--ref-image-args", f"preset={preset}"]
        args += ["--llm_vision", VISION_ENCODER]
    args += ["--listen-ip", _SERVER_HOST, "--listen-port", str(_SERVER_PORT)]
    return args


_process = None
_lock = threading.Lock()

# Localhost checks must bypass HTTP_PROXY/HTTPS_PROXY env vars (see qwen_image_manager).
_no_proxy_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def get_server_url() -> str:
    return _SERVER_URL


def get_log_path() -> str:
    """Path of the sd-server stdout/stderr log (progress bars are parsed from it)."""
    return _LOG_PATH


def _is_process_alive(proc) -> bool:
    return proc is not None and proc.poll() is None


def is_managed() -> bool:
    """True when THIS process manages a live sd-server child (no network probe)."""
    with _lock:
        return _is_process_alive(_process)


def _http_ok() -> bool:
    try:
        with _no_proxy_opener.open(_SERVER_URL, timeout=2.0) as response:
            return response.status == 200
    except Exception:
        return False


def _port_open(host: str, port: int) -> bool:
    # Loopback connects answer in microseconds; a 0.5s cap keeps probes cheap on
    # machines where a closed port reports "refused" only after a ~2s delay.
    try:
        with socket.create_connection((host, port), timeout=0.5):
            return True
    except OSError:
        return False


def _missing_files() -> list:
    paths = [SD_SERVER_EXE, _diffusion_model(), TEXT_ENCODER, _vae_model()]
    if _ref_preset():
        paths.append(VISION_ENCODER)
    return [path for path in paths if not os.path.isfile(path)]


def get_status() -> dict:
    with _lock:
        managed = _is_process_alive(_process)
        pid = _process.pid if managed else None

    # Probe order matters: no listener = definitely not reachable, and the TCP
    # probe is much cheaper than a full HTTP attempt when the port is closed
    # (delayed loopback connection-refused on some machines, e.g. ~2s here).
    port_open = _port_open(_SERVER_HOST, _SERVER_PORT)
    reachable = _http_ok() if port_open else False
    mode = "managed" if managed else "external" if reachable else "stopped"
    missing = _missing_files()

    return {
        "url": get_server_url(),
        "managed": managed,
        "pid": pid,
        "reachable": reachable,
        "port_open": port_open,
        "mode": mode,
        "model": get_model_name(),
        "missing_files": missing,
    }


def _wait_until_ready(proc, timeout: float = 300.0) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        if _http_ok():
            return True
        if proc is not None and proc.poll() is not None:
            # Stopped externally mid-startup (an engine switch / another job released
            # the server while it was still loading): bail out now instead of probing
            # a dead port for the full timeout (that left callers' "starting" flag
            # stuck for minutes - see qwen_image_manager for the py-spy finding).
            return False
        time.sleep(0.5)
    return False


def start_server() -> dict:
    global _process

    with _lock:
        if _is_process_alive(_process):
            status = get_status()
            status["message"] = "Krea 2 server is already managed by WebUI."
            status["action"] = "noop"
            return status

    if _port_open(_SERVER_HOST, _SERVER_PORT) and _http_ok():
        status = get_status()
        status["message"] = "Krea 2 server is already running externally."
        status["action"] = "noop"
        return status

    missing = _missing_files()
    if missing:
        status = get_status()
        status["message"] = "Cannot start: missing file(s): " + ", ".join(os.path.relpath(p, _ROOT_DIR) for p in missing)
        status["action"] = "error"
        return status

    command = [SD_SERVER_EXE] + _server_args()
    creationflags = 0
    startupinfo = None
    if os.name == "nt":
        creationflags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW

    log_file = open(_LOG_PATH, "ab", buffering=0)
    try:
        proc = subprocess.Popen(
            command,
            cwd=_SD_CPP_DIR,
            stdout=log_file,
            stderr=log_file,
            stdin=subprocess.DEVNULL,
            creationflags=creationflags,
            startupinfo=startupinfo,
        )
    finally:
        log_file.close()

    with _lock:
        _process = proc

    ready = _wait_until_ready(proc, timeout=300.0)
    status = get_status()
    status["action"] = "start"
    if ready:
        status["message"] = f"Krea 2 server started (PID {proc.pid}, model {status.get('model')})."
    elif _is_process_alive(proc):
        status["message"] = (
            f"sd-server process started (PID {proc.pid}) but did not become reachable within 300s. "
            f"Check {os.path.relpath(_LOG_PATH, _ROOT_DIR)}."
        )
    else:
        status["message"] = (
            f"sd-server exited during startup. Check {os.path.relpath(_LOG_PATH, _ROOT_DIR)}."
        )
    return status


def stop_server() -> dict:
    global _process

    with _lock:
        proc = _process

    if not _is_process_alive(proc):
        status = get_status()
        status["message"] = "No managed Krea 2 server is running."
        status["action"] = "noop"
        return status

    try:
        proc.terminate()
        proc.wait(timeout=10)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass

    with _lock:
        if _process is proc:
            _process = None

    status = get_status()
    status["message"] = "Managed Krea 2 server stopped."
    status["action"] = "stop"
    return status


def restart_server() -> dict:
    stop_server()
    status = start_server()
    status["action"] = "restart"
    if status.get("message"):
        status["message"] = status["message"].replace("started", "restarted", 1)
    return status


def format_status_markdown(status: dict) -> str:
    mode = status.get("mode") or "stopped"
    reachable = "yes" if status.get("reachable") else "no"
    pid = status.get("pid") or "-"
    model = status.get("model") if not status.get("missing_files") else "files missing"
    message = status.get("message") or ""
    return (
        f"Mode: {mode} | Reachable: {reachable} | PID: {pid} | Model: {model} | Defaults: 8 steps / CFG 1.0"
        + (f"\n\n{message}" if message else "")
    )


def status_payload(status: dict) -> str:
    return json.dumps(
        {
            "url": status.get("url"),
            "reachable": bool(status.get("reachable")),
            "managed": bool(status.get("managed")),
            "action": status.get("action") or "status",
        }
    )
