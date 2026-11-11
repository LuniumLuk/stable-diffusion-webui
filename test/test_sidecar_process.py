"""Unit tests for modules/sidecar_process.py (orphan detection, no real processes)."""

import sys
import types

from modules import sidecar_process


class FakeProcess:
    def __init__(self, pid, name, ppid, cmdline=()):
        self.pid = pid
        self.info = {"pid": pid, "name": name, "ppid": ppid, "cmdline": list(cmdline)}
        self.terminated = False
        self.killed = False

    def terminate(self):
        self.terminated = True

    def wait(self, timeout=None):
        return 0

    def kill(self):
        self.killed = True


class FakePsutil(types.SimpleNamespace):
    class Error(Exception):
        pass

    def __init__(self, processes, alive_pids):
        super().__init__()
        self._processes = processes
        self._alive = set(alive_pids)

    def process_iter(self, attrs=None):
        return list(self._processes)

    def pid_exists(self, pid):
        return pid in self._alive


def install(monkeypatch, processes, alive_pids):
    fake = FakePsutil(processes, alive_pids)
    monkeypatch.setitem(sys.modules, "psutil", fake)
    return fake


def test_is_sidecar_matches_the_server_and_the_receiver():
    assert sidecar_process._is_sidecar({"name": "sd-server.exe", "cmdline": []})
    assert sidecar_process._is_sidecar({"name": "python.exe", "cmdline": ["python", "sd_cpp/save_receiver.py"]})
    assert not sidecar_process._is_sidecar({"name": "python.exe", "cmdline": ["python", "webui.py"]})
    assert not sidecar_process._is_sidecar({"name": "cmd.exe", "cmdline": ["cmd", "/c", "sd-server.exe"]})


def test_live_parent_keeps_a_sidecar(monkeypatch):
    live = FakeProcess(200, "sd-server.exe", 100)
    install(monkeypatch, [live], alive_pids={100})

    assert sidecar_process.orphaned_sidecars() == []


def test_dead_parent_marks_a_sidecar_orphaned(monkeypatch):
    orphan = FakeProcess(201, "sd-server.exe", 101)
    install(monkeypatch, [orphan], alive_pids=set())

    assert [proc.pid for proc in sidecar_process.orphaned_sidecars()] == [201]


def test_sweep_only_kills_orphans(monkeypatch):
    owned = FakeProcess(300, "sd-server.exe", 400)
    orphan = FakeProcess(301, "sd-server.exe", 401)
    other = FakeProcess(302, "notepad.exe", 401)
    install(monkeypatch, [owned, orphan, other], alive_pids={400})

    assert sidecar_process.sweep_orphans() == [301]
    assert orphan.terminated
    assert not owned.terminated
    assert not other.terminated


def test_missing_psutil_is_not_fatal(monkeypatch):
    monkeypatch.setitem(sys.modules, "psutil", None)

    assert sidecar_process.orphaned_sidecars() == []
    assert sidecar_process.sweep_orphans() == []
