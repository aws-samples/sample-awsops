"""The container health probe can observe PostgreSQL, never start a service."""
import ast
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
from unittest import mock

import pytest


def load():
    path = Path(__file__).with_name("healthcheck.py")
    assert path.is_file(), "Non-spawning health probe is required"
    spec = importlib.util.spec_from_file_location("steampipe_healthcheck", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize("result,expected", [([[1]], 0), ([], 1), ([[0]], 1), (RuntimeError("PRIVATE_PASSWORD"), 1)])
def test_health_is_only_a_bounded_loopback_select(result, expected, monkeypatch, capsys):
    module = load()
    monkeypatch.setenv("STEAMPIPE_DATABASE_PASSWORD", "PRIVATE_PASSWORD")
    connection = mock.Mock()
    if isinstance(result, Exception):
        connection.run.side_effect = result
    else:
        connection.run.return_value = result
    with mock.patch.object(module.pg8000.native, "Connection", return_value=connection) as connect, \
            mock.patch("subprocess.Popen", side_effect=AssertionError("health must not spawn")), \
            mock.patch("boto3.client", side_effect=AssertionError("health must not call AWS")):
        assert module.check_health() == expected
    assert connect.call_args.kwargs["host"] == "127.0.0.1"
    assert connect.call_args.kwargs["port"] == 9193
    assert connect.call_args.kwargs["timeout"] == 2
    assert connect.call_args.kwargs["password"] == "PRIVATE_PASSWORD"
    connection.run.assert_called_once_with("SELECT 1")
    connection.close.assert_called_once()
    assert "PRIVATE_PASSWORD" not in str(capsys.readouterr())


def test_absent_service_fails_health_without_autostart(monkeypatch):
    module = load()
    monkeypatch.setenv("STEAMPIPE_DATABASE_PASSWORD", "fixture")
    with mock.patch.object(module.pg8000.native, "Connection", side_effect=ConnectionRefusedError), \
            mock.patch("subprocess.Popen", side_effect=AssertionError("must not start Steampipe")) as spawn:
        assert module.check_health() == 1
        spawn.assert_not_called()
    tree = ast.parse(Path(module.__file__).read_text())
    imports = {alias.name for node in ast.walk(tree) if isinstance(node, ast.Import) for alias in node.names}
    assert imports <= {"os", "signal", "ssl", "sys", "pg8000.native"}


def test_missing_password_makes_no_connection(monkeypatch):
    module = load()
    monkeypatch.delenv("STEAMPIPE_DATABASE_PASSWORD", raising=False)
    with mock.patch.object(module.pg8000.native, "Connection") as connect:
        assert module.check_health() == 1
        connect.assert_not_called()


def test_process_alarm_bounds_an_unresponsive_connection():
    module = load()
    script = """
import importlib.util, time, sys
spec = importlib.util.spec_from_file_location("health", sys.argv[1])
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)
h.HEALTH_DEADLINE_SECONDS = 1
h.pg8000.native.Connection = lambda **kwargs: time.sleep(30)
sys.exit(h.main())
"""
    result = subprocess.run([sys.executable, "-B", "-c", script, module.__file__],
        timeout=3, capture_output=True, text=True,
        env={**os.environ, "STEAMPIPE_DATABASE_PASSWORD": "PRIVATE_PASSWORD"})
    assert result.returncode == 1
    assert "PRIVATE_PASSWORD" not in result.stdout + result.stderr


def test_health_probe_is_in_the_image():
    module = load()
    dockerfile = Path(module.__file__).with_name("Dockerfile").read_text()
    assert "healthcheck.py /app/" in dockerfile
