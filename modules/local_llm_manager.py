import os
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request


_ROOT_DIR = os.path.dirname(os.path.dirname(__file__))
_LOCAL_LLM_DIR = os.path.join(_ROOT_DIR, "local-llm")
_LOCAL_LLM_URL = os.environ.get("LOCAL_LLM_EMBED_URL", "http://127.0.0.1:7820/")

_process = None
_lock = threading.Lock()


def get_local_llm_url() -> str:
    return _LOCAL_LLM_URL if _LOCAL_LLM_URL.endswith("/") else _LOCAL_LLM_URL + "/"


def _status_url() -> str:
    return get_local_llm_url() + "api/status"


def _is_process_alive(proc) -> bool:
    return proc is not None and proc.poll() is None


def _http_status() -> tuple[bool, dict | None]:
    try:
        with urllib.request.urlopen(_status_url(), timeout=1.5) as response:
            import json
            data = json.loads(response.read().decode("utf-8", errors="ignore"))
            return True, data
    except Exception:
        return False, None


def _port_open(host: str, port: int) -> bool:
    try:
        with socket.create_connection((host, port), timeout=1.0):
            return True
    except OSError:
        return False


def _parse_host_port(url: str) -> tuple[str, int]:
    from urllib.parse import urlparse

    parsed = urlparse(url)
    host = parsed.hostname or "127.0.0.1"
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    return host, port


def get_status() -> dict:
    with _lock:
        managed = _is_process_alive(_process)
        pid = _process.pid if managed else None

    reachable, data = _http_status()
    host, port = _parse_host_port(get_local_llm_url())
    port_open = _port_open(host, port)
    managed_label = "managed" if managed else "external" if reachable else "stopped"
    model_name = None
    if data and isinstance(data, dict):
        model_name = ((data.get("model_info") or {}).get("model_name") or None)

    return {
        "url": get_local_llm_url(),
        "managed": managed,
        "pid": pid,
        "reachable": reachable,
        "port_open": port_open,
        "mode": managed_label,
        "model_name": model_name,
    }


def _wait_until_ready(timeout: float = 30.0) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        reachable, _ = _http_status()
        if reachable:
            return True
        time.sleep(0.5)
    return False


def start_server() -> dict:
    global _process

    with _lock:
        if _is_process_alive(_process):
            status = get_status()
            status["message"] = "Local LLM server is already managed by WebUI."
            status["action"] = "noop"
            return status

    reachable, _ = _http_status()
    if reachable:
        status = get_status()
        status["message"] = "Local LLM server is already running externally."
        status["action"] = "noop"
        return status

    command = [sys.executable, "app.py"]
    creationflags = 0
    preexec_fn = None
    startupinfo = None

    if os.name == "nt":
        creationflags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    else:
        preexec_fn = os.setsid

    proc = subprocess.Popen(
        command,
        cwd=_LOCAL_LLM_DIR,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL,
        creationflags=creationflags,
        startupinfo=startupinfo,
        preexec_fn=preexec_fn,
    )

    with _lock:
        _process = proc

    ready = _wait_until_ready(timeout=30.0)
    status = get_status()
    status["action"] = "start"
    if ready:
        status["message"] = f"Local LLM server started (PID {proc.pid})."
    else:
        status["message"] = f"Local LLM process started (PID {proc.pid}), but the server is not reachable yet."
    return status


def stop_server() -> dict:
    global _process

    with _lock:
        proc = _process

    if not _is_process_alive(proc):
        status = get_status()
        status["message"] = "No managed Local LLM process is running."
        status["action"] = "noop"
        return status

    try:
        if os.name == "nt":
            proc.terminate()
        else:
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
    status["message"] = "Managed Local LLM server stopped."
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
    model_name = status.get("model_name") or "model not loaded"
    message = status.get("message") or ""
    return (
        f"Mode: {mode} | Reachable: {reachable} | PID: {pid} | Model: {model_name}"
        + (f"\n\n{message}" if message else "")
    )


def status_payload(status: dict) -> str:
    import json

    return json.dumps(
        {
            "url": status.get("url"),
            "reachable": bool(status.get("reachable")),
            "managed": bool(status.get("managed")),
            "action": status.get("action") or "status",
        }
    )