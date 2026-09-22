import json
import os
import socket
import subprocess
import threading
import time
import urllib.request


_ROOT_DIR = os.path.dirname(os.path.dirname(__file__))
_SD_CPP_DIR = os.path.join(_ROOT_DIR, "sd_cpp")
_MODELS_DIR = os.path.join(_ROOT_DIR, "models", "Qwen-Image-2.1")
_LOG_PATH = os.path.join(_SD_CPP_DIR, "qwen_server.log")

_SERVER_HOST = os.environ.get("QWEN_IMAGE_SERVER_HOST", "127.0.0.1")
_SERVER_PORT = int(os.environ.get("QWEN_IMAGE_SERVER_PORT", "7862"))
_SERVER_URL = f"http://{_SERVER_HOST}:{_SERVER_PORT}/"

SD_SERVER_EXE = os.path.join(_SD_CPP_DIR, "sd-server.exe")
DIFFUSION_MODEL = os.path.join(_MODELS_DIR, "qwen-image-2.1-Q4_K_M.gguf")
TEXT_ENCODER = os.path.join(_MODELS_DIR, "text_encoders", "Qwen3VL-8B-Instruct-Q4_K_M.gguf")
VISION_ENCODER = os.path.join(_MODELS_DIR, "text_encoders", "mmproj-Qwen3VL-8B-Instruct-F16.gguf")
VAE_MODEL = os.path.join(_MODELS_DIR, "vae", "qwen_image_2.1_vae_bf16.safetensors")

# Verified on RTX 5070 Ti 16GB: DiT stays fully in VRAM (fast sampling),
# VAE tiling avoids the 1024px decode OOM, ~50s per 1024x1024 / 20 steps.
# --llm_vision (Qwen3-VL mmproj) is required for reference-image editing.
_SERVER_ARGS = [
    "--diffusion-model", DIFFUSION_MODEL,
    "--vae", VAE_MODEL,
    "--llm", TEXT_ENCODER,
    "--llm_vision", VISION_ENCODER,
    "--cfg-scale", "6.0",
    "--sampling-method", "euler",
    "--diffusion-fa",
    "--vae-tiling",
    "--listen-ip", _SERVER_HOST,
    "--listen-port", str(_SERVER_PORT),
]

_process = None
_lock = threading.Lock()

# Localhost checks must bypass HTTP_PROXY/HTTPS_PROXY env vars (e.g. a dead local
# proxy would otherwise swallow every request and the server would look offline).
_no_proxy_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def get_server_url() -> str:
    return _SERVER_URL


def _is_process_alive(proc) -> bool:
    return proc is not None and proc.poll() is None


def _http_ok() -> bool:
    try:
        with _no_proxy_opener.open(_SERVER_URL, timeout=2.0) as response:
            return response.status == 200
    except Exception:
        return False


def _port_open(host: str, port: int) -> bool:
    try:
        with socket.create_connection((host, port), timeout=1.0):
            return True
    except OSError:
        return False


def _missing_files() -> list:
    return [path for path in (SD_SERVER_EXE, DIFFUSION_MODEL, TEXT_ENCODER, VISION_ENCODER, VAE_MODEL) if not os.path.isfile(path)]


def get_status() -> dict:
    with _lock:
        managed = _is_process_alive(_process)
        pid = _process.pid if managed else None

    reachable = _http_ok()
    port_open = _port_open(_SERVER_HOST, _SERVER_PORT)
    mode = "managed" if managed else "external" if reachable else "stopped"
    missing = _missing_files()

    return {
        "url": get_server_url(),
        "managed": managed,
        "pid": pid,
        "reachable": reachable,
        "port_open": port_open,
        "mode": mode,
        "missing_files": missing,
    }


def _wait_until_ready(timeout: float = 300.0) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        if _http_ok():
            return True
        time.sleep(1.0)
    return False


def start_server() -> dict:
    global _process

    with _lock:
        if _is_process_alive(_process):
            status = get_status()
            status["message"] = "Qwen-Image 2.1 server is already managed by WebUI."
            status["action"] = "noop"
            return status

    if _http_ok():
        status = get_status()
        status["message"] = "Qwen-Image 2.1 server is already running externally."
        status["action"] = "noop"
        return status

    missing = _missing_files()
    if missing:
        status = get_status()
        status["message"] = "Cannot start: missing file(s): " + ", ".join(os.path.relpath(p, _ROOT_DIR) for p in missing)
        status["action"] = "error"
        return status

    command = [SD_SERVER_EXE] + _SERVER_ARGS
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

    ready = _wait_until_ready(timeout=300.0)
    status = get_status()
    status["action"] = "start"
    if ready:
        status["message"] = f"Qwen-Image 2.1 server started (PID {proc.pid})."
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
        status["message"] = "No managed Qwen-Image 2.1 server is running."
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
    status["message"] = "Managed Qwen-Image 2.1 server stopped."
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
    model = "Q4_K_M (qwen-image-2.1) + Qwen3VL-8B TE" if not status.get("missing_files") else "files missing"
    message = status.get("message") or ""
    return (
        f"Mode: {mode} | Reachable: {reachable} | PID: {pid} | Model: {model}"
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
