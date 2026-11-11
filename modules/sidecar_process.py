"""Keep stable-diffusion.cpp sidecars from outliving the WebUI.

The Qwen / Krea 2 / Anima sidecars are ``sd_cpp/sd-server.exe`` child processes. On
Windows a child survives its parent unless it is placed in a Job Object configured with
``JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE``: the kernel closes the last handle when the WebUI
process dies for *any* reason (normal exit, Ctrl+C, crash, Task Manager / Stop-Process)
and terminates everything left in the job. ``spawn()`` is a drop-in ``subprocess.Popen``
that does that.

``sweep_orphans()`` cleans up sidecars left behind by *earlier* runs - processes whose
parent is gone, which is exactly the state that keeps ``sd-server.exe`` holding VRAM
with no WebUI running.  A sidecar whose parent is still alive belongs to a running
WebUI (possibly a second instance) and is never touched.
"""

from __future__ import annotations

import os
import subprocess

SD_SERVER_EXE_NAME = "sd-server.exe"
SAVE_RECEIVER_MARKER = "save_receiver.py"

_job = None
_job_failed = False


# --------------------------------------------------------------- job object
def _job_handle():
    """A process-lifetime Job Object with kill-on-close, or None when unavailable."""
    global _job, _job_failed

    if os.name != "nt":
        return None
    if _job is not None or _job_failed:
        return _job

    try:
        import ctypes
        from ctypes import wintypes

        class _IoCounters(ctypes.Structure):
            _fields_ = [
                ("ReadOperationCount", ctypes.c_ulonglong),
                ("WriteOperationCount", ctypes.c_ulonglong),
                ("OtherOperationCount", ctypes.c_ulonglong),
                ("ReadTransferCount", ctypes.c_ulonglong),
                ("WriteTransferCount", ctypes.c_ulonglong),
                ("OtherTransferCount", ctypes.c_ulonglong),
            ]

        class _BasicLimitInformation(ctypes.Structure):
            _fields_ = [
                ("PerProcessUserTimeLimit", wintypes.LARGE_INTEGER),
                ("PerJobUserTimeLimit", wintypes.LARGE_INTEGER),
                ("LimitFlags", wintypes.DWORD),
                ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ctypes.c_size_t),
                ("PriorityClass", wintypes.DWORD),
                ("SchedulingClass", wintypes.DWORD),
            ]

        class _ExtendedLimitInformation(ctypes.Structure):
            _fields_ = [
                ("BasicLimitInformation", _BasicLimitInformation),
                ("IoInfo", _IoCounters),
                ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed", ctypes.c_size_t),
            ]

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateJobObjectW.restype = wintypes.HANDLE
        kernel32.CreateJobObjectW.argtypes = [wintypes.LPVOID, wintypes.LPCWSTR]
        job = kernel32.CreateJobObjectW(None, None)
        if not job:
            raise OSError(ctypes.get_last_error(), "CreateJobObjectW failed")

        info = _ExtendedLimitInformation()
        info.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not kernel32.SetInformationJobObject(
            job,
            9,  # JobObjectExtendedLimitInformation
            ctypes.byref(info),
            ctypes.sizeof(info),
        ):
            raise OSError(ctypes.get_last_error(), "SetInformationJobObject failed")

        _job = job
    except Exception as error:
        print(f"sidecar: kill-on-close job object unavailable: {error}")
        _job_failed = True
        _job = None

    return _job


def _attach(proc) -> None:
    job = _job_handle()
    if job is None or proc is None:
        return

    try:
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
        if not kernel32.AssignProcessToJobObject(job, int(proc._handle)):
            error = ctypes.get_last_error()
            print(f"sidecar: could not attach pid {proc.pid} to the kill-on-close job ({error})")
    except Exception as error:
        print(f"sidecar: could not attach pid {getattr(proc, 'pid', '?')} to the kill-on-close job: {error}")


def spawn(command, **kwargs):
    """``subprocess.Popen`` that also dies with the WebUI."""
    proc = subprocess.Popen(command, **kwargs)
    _attach(proc)
    return proc


# ------------------------------------------------------------------ orphans
def _is_sidecar(info: dict) -> bool:
    name = (info.get("name") or "").lower()
    if name == SD_SERVER_EXE_NAME:
        return True
    cmdline = " ".join(info.get("cmdline") or []).lower()
    return name.startswith("python") and SAVE_RECEIVER_MARKER in cmdline


def orphaned_sidecars() -> list:
    """Sidecar processes whose owning WebUI no longer exists."""
    try:
        import psutil
    except ImportError:
        return []

    result = []
    for proc in psutil.process_iter(["pid", "name", "ppid", "cmdline"]):
        try:
            info = proc.info
            if not _is_sidecar(info):
                continue
            parent_pid = info.get("ppid") or 0
            if parent_pid and psutil.pid_exists(parent_pid):
                continue  # a running WebUI owns it
            result.append(proc)
        except (psutil.Error, OSError):
            continue
    return result


def sweep_orphans() -> list[int]:
    """Stop sidecars left behind by a previous WebUI run; returns the killed pids."""
    stopped = []
    for proc in orphaned_sidecars():
        try:
            label = f"{proc.info.get('name') or 'sidecar'} (pid {proc.pid})"
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except Exception:
                proc.kill()
                proc.wait(timeout=10)
            stopped.append(proc.pid)
            print(f"sidecar: stopped stale {label} left over from a previous run")
        except Exception as error:
            print(f"sidecar: could not stop stale pid {proc.pid}: {error}")
    return stopped
