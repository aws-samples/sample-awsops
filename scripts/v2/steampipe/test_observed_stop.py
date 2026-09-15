"""A CLI exit code cannot substitute for observing the embedded listener stop."""
import errno
from pathlib import Path
import socket
import subprocess
import sys
import threading
from types import SimpleNamespace
from unittest import mock

import pytest

sys.path.insert(0, str(Path(__file__).parent))
import gen_spc_entrypoint as entrypoint


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    state = SimpleNamespace(now=0.0, sleeps=[])

    def sleep(seconds):
        state.sleeps.append(seconds)
        state.now += seconds

    monkeypatch.setattr(entrypoint, "time", SimpleNamespace(
        monotonic=lambda: state.now, sleep=sleep))
    return state


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
        assert entrypoint._steampipe_listener_closed() is None
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
            mock.patch.object(entrypoint, "_steampipe_listener_closed", side_effect=lambda **kwargs: observe(port, **kwargs)):
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
            mock.patch.object(entrypoint, "_steampipe_listener_closed", side_effect=lambda **kwargs: observe(port, **kwargs)), \
            mock.patch.object(entrypoint, "_start_steampipe") as start:
        with pytest.raises(entrypoint.SteampipeRestartError, match="steampipe_service_stop_failed"):
            entrypoint._restart_steampipe(refs, threading.Lock(), proc, stop, fatal, prepare)
        assert stop.is_set() and fatal.is_set() and refs[0] is None
        prepare.assert_not_called()
        start.assert_not_called()


def test_stop_retries_real_listener_until_it_closes(listener, clock):
    server, port = listener
    observe = entrypoint._steampipe_listener_closed

    def sample(**kwargs):
        if clock.now >= 0.4:
            server.close()
        return observe(port, **kwargs)

    with mock.patch.object(entrypoint.subprocess, "run", return_value=mock.Mock(returncode=0)), \
            mock.patch.object(entrypoint, "_steampipe_listener_closed", side_effect=sample) as probe:
        assert entrypoint._stop_steampipe_service() is True
    assert probe.call_count == 3
    assert clock.sleeps == [0.2, 0.2]


def test_stop_retries_unconfirmed_probe_without_calling_it_open(clock, capsys):
    with mock.patch.object(entrypoint.subprocess, "run", return_value=mock.Mock(returncode=1)), \
            mock.patch.object(entrypoint, "_steampipe_listener_closed",
                              side_effect=[None, None, True]) as probe:
        assert entrypoint._stop_steampipe_service() is True
    assert probe.call_count == 3
    assert clock.now == pytest.approx(0.4)
    assert "listener_open" not in capsys.readouterr().err


@pytest.mark.parametrize("observation,reason", [
    (False, "listener_open"), (None, "listener_unconfirmed"),
])
def test_stop_poll_has_one_bounded_deadline(observation, reason, clock, capsys):
    with mock.patch.object(entrypoint.subprocess, "run",
                           return_value=mock.Mock(returncode=7)) as stop, \
            mock.patch.object(entrypoint, "_steampipe_listener_closed",
                              return_value=observation) as probe:
        assert entrypoint._stop_steampipe_service() is False
    assert clock.now == pytest.approx(10.0)
    assert stop.call_count == 1
    assert probe.call_count > 1
    assert all(0 < call.kwargs["timeout"] <= 1 for call in probe.call_args_list)
    assert all(0 < duration <= 0.2 for duration in clock.sleeps)
    output = capsys.readouterr().err
    assert reason in output and "exit_code=7" in output


def test_slow_probes_share_the_deadline_and_last_probe_is_clamped(clock):
    def sample(*, timeout):
        clock.now += timeout
        return None

    with mock.patch.object(entrypoint.subprocess, "run", return_value=mock.Mock(returncode=0)), \
            mock.patch.object(entrypoint, "_steampipe_listener_closed", side_effect=sample) as probe:
        assert entrypoint._stop_steampipe_service() is False
    assert clock.now == pytest.approx(10.0)
    assert 0 < probe.call_args.kwargs["timeout"] < 1
    assert all(0 < call.kwargs["timeout"] <= 1 for call in probe.call_args_list)
