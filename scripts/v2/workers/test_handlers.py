"""Tests for handlers.py's dispatch-site gates. Focused on the `_network_path` handler's
NETWORK_PATH_CHECK_ENABLED short-circuit (L5 docs-consistency + safety fix: the module docstring in
network_path.py used to claim handlers.py already gated this at import time — it didn't; this test
proves the gate now actually exists at the dispatch site)."""
import handlers


def test_network_path_handler_disabled_when_flag_not_set(monkeypatch):
    monkeypatch.delenv("NETWORK_PATH_CHECK_ENABLED", raising=False)
    result, artifact = handlers._network_path({"run_id": "r1"}, dry_run=False)
    assert result["status"] == "disabled"
    assert artifact is None


def test_network_path_handler_disabled_when_flag_is_not_literally_true(monkeypatch):
    monkeypatch.setenv("NETWORK_PATH_CHECK_ENABLED", "false")
    result, _artifact = handlers._network_path({"run_id": "r1"}, dry_run=False)
    assert result["status"] == "disabled"


def test_network_path_handler_dry_run_bypasses_the_gate(monkeypatch):
    # dry_run is a pure no-op probe (used by SFN/test-invoke tooling) — must not require the flag.
    monkeypatch.delenv("NETWORK_PATH_CHECK_ENABLED", raising=False)
    result, _artifact = handlers._network_path({"run_id": "r1"}, dry_run=True)
    assert result["dry_run"] is True


def test_network_path_handler_proceeds_when_flag_enabled(monkeypatch):
    monkeypatch.setenv("NETWORK_PATH_CHECK_ENABLED", "true")
    calls = {}

    class FakeConn:
        def close(self):
            calls["closed"] = True

    class FakeWdb:
        @staticmethod
        def connect():
            return FakeConn()

    class FakeNpc:
        @staticmethod
        def run(payload, conn):
            calls["ran"] = payload
            return {"run_id": payload["run_id"], "status": "succeeded"}

    monkeypatch.setitem(__import__("sys").modules, "db", FakeWdb)
    monkeypatch.setitem(__import__("sys").modules, "network_path", FakeNpc)
    result, artifact = handlers._network_path({"run_id": "r1"}, dry_run=False)
    assert result["status"] == "succeeded"
    assert calls["ran"]["run_id"] == "r1"
    assert calls["closed"] is True
    assert artifact is None
