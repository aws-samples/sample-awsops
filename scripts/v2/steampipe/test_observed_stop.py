"""A CLI exit code cannot substitute for observing the embedded listener stop."""
import errno
from pathlib import Path
import socket
import subprocess
import sys
import threading
from unittest import mock

import pytest

sys.path.insert(0, str(Path(__file__).parent))
import gen_spc_entrypoint as entrypoint


@pytest.fixture
def listener():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as server:
        server.bind(("127.0.0.1", 0))
        server.listen()
        yield server, server.getsockname()[1]


def test_real_loopback_listener_is_open_until_closed(listener):
    server, port = listener
    assert entrypoint._steampipe_listener_closed(port) is False
    server.close()
    assert entrypoint._steampipe_listener_closed(port) is True


@pytest.mark.parametrize("error", [
    TimeoutError("PRIVATE_SOCKET_DETAIL"),
    OSError(errno.ECONNRESET, "PRIVATE_SOCKET_DETAIL"),
    OSError(errno.EACCES, "PRIVATE_SOCKET_DETAIL"),
    OSError("PRIVATE_SOCKET_DETAIL"),
])
def test_only_connection_refused_proves_listener_closed(error, capsys):
    with mock.patch.object(entrypoint.socket, "create_connection", side_effect=error) as connect:
        assert entrypoint._steampipe_listener_closed() is False
    connect.assert_called_once_with(("127.0.0.1", 9193), timeout=1)
    assert "PRIVATE_SOCKET_DETAIL" not in repr(capsys.readouterr())


@pytest.mark.parametrize("returncode", [0, 1])
@pytest.mark.parametrize("closed", [False, True])
def test_completed_stop_command_requires_observed_closure(listener, returncode, closed, capsys):
    server, port = listener
    if closed:
        server.close()
    observe = entrypoint._steampipe_listener_closed
    with mock.patch.object(entrypoint.subprocess, "run",
                           return_value=mock.Mock(returncode=returncode, stderr=b"PRIVATE_CLI_DETAIL")) as run, \
            mock.patch.object(entrypoint, "_steampipe_listener_closed", side_effect=lambda: observe(port)):
        assert entrypoint._stop_steampipe_service() is closed
    run.assert_called_once_with(["steampipe", "service", "stop", "--force"],
                                timeout=30, capture_output=True)
    output = capsys.readouterr()
    assert "PRIVATE_CLI_DETAIL" not in repr(output)
    assert ("steampipe_service_stop_failed" in output.err) is not closed


@pytest.mark.parametrize("error", [
    subprocess.TimeoutExpired("steampipe", 30, stderr=b"PRIVATE_CLI_DETAIL"),
    OSError("PRIVATE_CLI_DETAIL"),
])
def test_uncompleted_stop_command_remains_fail_closed(error, capsys):
    with mock.patch.object(entrypoint.subprocess, "run", side_effect=error), \
            mock.patch.object(entrypoint, "_steampipe_listener_closed") as observe:
        assert entrypoint._stop_steampipe_service() is False
    observe.assert_not_called()
    output = capsys.readouterr()
    assert "steampipe_service_stop_failed" in output.err
    assert "PRIVATE_CLI_DETAIL" not in repr(output)


def test_zero_exit_with_surviving_listener_prevents_publish_and_restart(listener):
    _, port = listener
    observe = entrypoint._steampipe_listener_closed
    stop, fatal = threading.Event(), threading.Event()
    proc = mock.Mock()
    refs = [proc]
    prepare = mock.Mock()
    with mock.patch.object(entrypoint.subprocess, "run", return_value=mock.Mock(returncode=0)), \
            mock.patch.object(entrypoint, "_steampipe_listener_closed", side_effect=lambda: observe(port)), \
            mock.patch.object(entrypoint, "_start_steampipe") as start:
        with pytest.raises(entrypoint.SteampipeRestartError, match="steampipe_service_stop_failed"):
            entrypoint._restart_steampipe(refs, threading.Lock(), proc, stop, fatal, prepare)
        assert stop.is_set() and fatal.is_set() and refs[0] is None
        prepare.assert_not_called()
        start.assert_not_called()
