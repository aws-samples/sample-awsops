"""Host-only inventory fails before rendering; all AWS/DB calls are mocked."""
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
from unittest import mock

import pytest
from botocore.awsrequest import AWSResponse
from botocore.exceptions import ClientError

sys.path.insert(0, os.path.dirname(__file__))
import gen_spc_entrypoint as entrypoint

ACCOUNT = "123456789012"
HOST = {"account_id": ACCOUNT, "is_host": True, "role_name": "AWSopsReadOnlyRole",
        "external_id": None, "all_regions": False, "regions": []}
ENV = {"INVENTORY_HOST_ONLY": "true", "EXPECTED_HOST_ACCOUNT_ID": ACCOUNT}


@pytest.fixture(autouse=True)
def clear_identity_client():
    entrypoint._host_sts_client.cache_clear()
    yield
    entrypoint._host_sts_client.cache_clear()


def test_default_mode_preserves_existing_render_without_sts():
    with mock.patch.dict(os.environ, {}, clear=True), mock.patch.object(entrypoint, "boto3") as sdk:
        assert 'regions = ["*"]' in entrypoint._render_spc([HOST])
        sdk.client.assert_not_called()


def test_verified_host_keeps_all_regions_without_self_assume():
    with mock.patch.dict(os.environ, ENV, clear=True), mock.patch.object(entrypoint, "boto3") as sdk:
        sdk.client.return_value.get_caller_identity.return_value = {"Account": ACCOUNT}
        result = entrypoint._render_spc([HOST])
        assert 'regions = ["*"]' in result
        assert "assume_role_arn" not in result
        sdk.client.assert_called_once()
        assert sdk.client.call_args.args == ("sts",)


@pytest.mark.parametrize("rows", [
    [], [HOST, HOST], [{**HOST, "is_host": False}], [{**HOST, "is_host": 1}],
    [{**HOST, "account_id": "999999999999"}], [None],
    [HOST, {**HOST, "account_id": "999999999999", "is_host": False}],
])
def test_invalid_enabled_scope_never_reaches_renderer(rows):
    with mock.patch.dict(os.environ, ENV, clear=True), mock.patch.object(entrypoint, "boto3") as sdk, \
            mock.patch.object(entrypoint, "render_spc") as render:
        sdk.client.return_value.get_caller_identity.return_value = {"Account": ACCOUNT}
        with pytest.raises(entrypoint.HostScopeError):
            entrypoint._render_spc(rows)
        render.assert_not_called()


@pytest.mark.parametrize("change", [
    {"EXPECTED_HOST_ACCOUNT_ID": ""}, {"EXPECTED_HOST_ACCOUNT_ID": "self"},
    {"INVENTORY_HOST_ONLY": "TRUE"}, {"INVENTORY_HOST_ONLY": "invalid"},
])
def test_invalid_configuration_fails_before_any_sdk_call(change):
    with mock.patch.dict(os.environ, {**ENV, **change}, clear=True), \
            mock.patch.object(entrypoint, "boto3") as sdk:
        with pytest.raises(entrypoint.HostScopeError):
            entrypoint._render_spc([HOST])
        sdk.client.assert_not_called()


@pytest.mark.parametrize("response", [{}, {"Account": "999999999999"}, None])
def test_actual_sts_account_must_match(response):
    with mock.patch.dict(os.environ, ENV, clear=True), mock.patch.object(entrypoint, "boto3") as sdk, \
            mock.patch.object(entrypoint, "render_spc") as render:
        sdk.client.return_value.get_caller_identity.return_value = response
        with pytest.raises(entrypoint.HostScopeError):
            entrypoint._render_spc([HOST])
        render.assert_not_called()


def test_identity_failure_is_redacted_and_cannot_render():
    with mock.patch.dict(os.environ, ENV, clear=True), mock.patch.object(entrypoint, "boto3") as sdk, \
            mock.patch.object(entrypoint, "render_spc") as render:
        sdk.client.return_value.get_caller_identity.side_effect = ClientError(
            {"Error": {"Code": "AccessDenied", "Message": "PRIVATE_REMOTE_DETAIL"}}, "GetCallerIdentity")
        with pytest.raises(entrypoint.HostScopeError, match="^host_identity_unavailable$"):
            entrypoint._render_spc([HOST])
        render.assert_not_called()


def test_invalid_boot_scope_cannot_write_or_start_inventory():
    with mock.patch.dict(os.environ, {**ENV, "AURORA_ENDPOINT": "fixture", "AURORA_DATABASE": "fixture"}, clear=True), \
            mock.patch.object(entrypoint, "fetch_rows", return_value=[]), \
            mock.patch.object(entrypoint, "write_spc") as write, \
            mock.patch.object(entrypoint, "_start_steampipe") as start:
        with pytest.raises(SystemExit) as error:
            entrypoint.main()
        assert error.value.code == 1
        write.assert_not_called()
        start.assert_not_called()


def test_watchdog_scope_rejection_stops_running_inventory_instead_of_keeping_stale_scope():
    proc = mock.Mock()
    stop = mock.Mock()
    stop.wait.side_effect = [False, True]
    with mock.patch.object(entrypoint, "fetch_rows", return_value=[]), \
            mock.patch.object(entrypoint, "_render_spc", side_effect=entrypoint.HostScopeError("invalid_host_scope")), \
            mock.patch.object(entrypoint, "write_spc") as write, \
            mock.patch.object(entrypoint, "_stop_steampipe_service") as shutdown:
        entrypoint._scope_watchdog("previous", [proc], threading.Lock(), stop)
        stop.set.assert_called_once()
        shutdown.assert_called_once()
        proc.terminate.assert_called_once()
        write.assert_not_called()


def sts_response(account=ACCOUNT, error=None, status=200):
    if error:
        xml = (f'<ErrorResponse><Error><Type>Sender</Type><Code>{error}</Code>'
               '<Message>PRIVATE_REMOTE_DETAIL</Message></Error><RequestId>fixture</RequestId></ErrorResponse>')
    else:
        xml = ('<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">'
               f'<GetCallerIdentityResult><Account>{account}</Account><UserId>fixture</UserId>'
               f'<Arn>arn:aws:sts::{account}:assumed-role/fixture/session</Arn></GetCallerIdentityResult>'
               '<ResponseMetadata><RequestId>fixture</RequestId></ResponseMetadata></GetCallerIdentityResponse>')
    class Raw:
        def stream(self, *args, **kwargs):
            yield xml.encode()
    return AWSResponse("https://sts.example.test", status, {"content-type": "text/xml"}, Raw())


@pytest.mark.parametrize("error,status", [("Throttling", 400), ("InternalFailure", 500)])
def test_real_sdk_retries_transient_identity_before_rendering(error, status):
    # Real botocore retry/response handling, with transport fully replaced before a request.
    with mock.patch.dict(os.environ, {**ENV, "AWS_ACCESS_KEY_ID": "testing",
                                     "AWS_SECRET_ACCESS_KEY": "testing",
                                     "AWS_EC2_METADATA_DISABLED": "true"}, clear=True):
        client = entrypoint._host_sts_client("ap-northeast-2")
        with mock.patch.object(client._endpoint.http_session, "send", side_effect=[
            sts_response(error=error, status=status), sts_response(error=error, status=status), sts_response(),
        ]) as send, mock.patch("botocore.endpoint.time.sleep") as sleep:
            result = entrypoint._render_spc([HOST])
        assert 'regions = ["*"]' in result
        assert send.call_count == 3
        assert sleep.call_count == 2


@pytest.mark.parametrize("responses,expected_calls,code", [
    ([sts_response(error="Throttling", status=400)] * 3, 3, "host_identity_unavailable"),
    ([sts_response(error="AccessDenied", status=403)], 1, "host_identity_unavailable"),
    ([sts_response(account="999999999999")], 1, "actual_host_account_mismatch"),
])
def test_retry_budget_exhaustion_and_permanent_failures_never_render(responses, expected_calls, code):
    with mock.patch.dict(os.environ, {**ENV, "AWS_ACCESS_KEY_ID": "testing",
                                     "AWS_SECRET_ACCESS_KEY": "testing",
                                     "AWS_EC2_METADATA_DISABLED": "true"}, clear=True):
        client = entrypoint._host_sts_client("ap-northeast-2")
        with mock.patch.object(client._endpoint.http_session, "send", side_effect=responses) as send, \
                mock.patch("botocore.endpoint.time.sleep"), mock.patch.object(entrypoint, "render_spc") as render:
            with pytest.raises(entrypoint.HostScopeError, match=f"^{code}$"):
                entrypoint._render_spc([HOST])
        assert send.call_count == expected_calls
        render.assert_not_called()


def test_fatal_shutdown_reaps_uncooperative_child_before_stopping_service():
    calls = []
    proc = mock.Mock()
    proc.terminate.side_effect = lambda: calls.append("terminate")
    def wait(timeout=None):
        calls.append(("wait", timeout))
        if calls.count(("wait", timeout)) == 1:
            raise subprocess.TimeoutExpired("fixture", timeout)
        return -signal.SIGKILL
    proc.wait.side_effect = wait
    proc.kill.side_effect = lambda: calls.append("kill")
    stop = mock.Mock()
    stop.wait.return_value = False
    with mock.patch.object(entrypoint, "fetch_rows", return_value=[]), \
            mock.patch.object(entrypoint, "_stop_steampipe_service", side_effect=lambda: calls.append("service-stop")), \
            mock.patch.object(entrypoint, "_render_spc", side_effect=entrypoint.HostScopeError("invalid_enabled_host_scope")):
        entrypoint._scope_watchdog("old", [proc], threading.Lock(), stop)
    assert calls == ["terminate", ("wait", 30), "kill", ("wait", 30), "service-stop"]


def test_queued_scope_restart_cannot_revive_a_fatally_stopped_collector():
    """Force an update restart to wait until a second watchdog has revoked scope."""
    ready, release, stop = threading.Event(), threading.Event(), threading.Event()
    proc = mock.Mock()
    proc.wait.return_value = 0
    proc_ref, lock = [proc], threading.Lock()
    errors = []
    restart = entrypoint._restart_steampipe
    def delayed_restart(*args, **kwargs):
        ready.set()
        assert release.wait(2)
        return restart(*args, **kwargs)
    def render(rows):
        if threading.current_thread().name == "scope-update":
            return "new scope"
        raise entrypoint.HostScopeError("invalid_enabled_host_scope")
    def update():
        try:
            entrypoint._scope_watchdog("old scope", proc_ref, lock, stop)
        except BaseException as error:
            errors.append(error)
    with mock.patch.object(entrypoint, "SCOPE_WATCH_INTERVAL", 0.001), \
            mock.patch.object(entrypoint, "fetch_rows", return_value=[]), \
            mock.patch.object(entrypoint, "_render_spc", side_effect=render), \
            mock.patch.object(entrypoint, "write_spc"), \
            mock.patch.object(entrypoint, "_restart_steampipe", side_effect=delayed_restart), \
            mock.patch.object(entrypoint, "_start_steampipe") as start, \
            mock.patch.object(entrypoint, "_stop_steampipe_service"):
        thread = threading.Thread(target=update, name="scope-update")
        thread.start()
        try:
            assert ready.wait(2)
            entrypoint._scope_watchdog("old scope", proc_ref, lock, stop)
        finally:
            release.set()
            thread.join(3)
        assert not thread.is_alive() and not errors
        start.assert_not_called()


def test_fatal_during_crash_backoff_does_not_restart_and_exits_nonzero():
    backoff = threading.Event()
    class Stop(threading.Event):
        def wait(self, timeout=None):
            if timeout == 2:
                backoff.set()
            return super().wait(timeout)
    stop = Stop()
    threads = []
    def worker_thread(*args, **kwargs):
        thread = threading.Thread(*args, **kwargs)
        threads.append(thread)
        return thread
    proxy = mock.Mock(Event=mock.Mock(side_effect=[stop, threading.Event()]),
                      Lock=threading.Lock, Thread=worker_thread)
    fetch_count = 0
    def fetch():
        nonlocal fetch_count
        fetch_count += 1
        if fetch_count == 1:
            return [HOST]
        assert backoff.wait(2)
        return []
    def render(rows):
        if rows:
            return "verified scope"
        raise entrypoint.HostScopeError("invalid_enabled_host_scope")
    def old_backoff(seconds):
        backoff.set()
        assert stop.wait(2)
    proc = mock.Mock()
    proc.wait.return_value = 1
    with mock.patch.dict(os.environ, {"AURORA_ENDPOINT": "fixture", "AURORA_DATABASE": "fixture"}), \
            mock.patch.object(entrypoint, "threading", proxy), \
            mock.patch.object(entrypoint, "SCOPE_WATCH_INTERVAL", 0.001), \
            mock.patch.object(entrypoint, "fetch_rows", side_effect=fetch), \
            mock.patch.object(entrypoint, "_render_spc", side_effect=render), \
            mock.patch.object(entrypoint, "write_spc"), mock.patch.object(entrypoint.signal, "signal"), \
            mock.patch.object(entrypoint.time, "time", return_value=1), \
            mock.patch.object(entrypoint.time, "sleep", side_effect=old_backoff), \
            mock.patch.object(entrypoint, "_start_steampipe", return_value=proc) as start, \
            mock.patch.object(entrypoint, "_stop_steampipe_service"):
        try:
            entrypoint.main()
            code = 0
        except SystemExit as error:
            code = error.code
        for thread in threads:
            thread.join(2)
            assert not thread.is_alive()
        assert stop.is_set()
        start.assert_called_once()
        assert code == 1


@pytest.mark.parametrize("mode,expected", [("fatal", 1), ("sigterm", 0)])
def test_actual_supervisor_process_exit_classification(mode, expected):
    script = r'''
import os, signal, subprocess, sys, threading, types
sys.path.insert(0, sys.argv[1])
import gen_spc_entrypoint as e
account = "123456789012"
host = {"account_id": account, "is_host": True, "regions": [], "all_regions": True}
class Proc:
    def __init__(self): self.done = threading.Event()
    def terminate(self): self.done.set()
    def kill(self): self.done.set()
    def wait(self, timeout=None):
        if not self.done.wait(timeout or 3): raise subprocess.TimeoutExpired("fixture", timeout)
        return 0
proc = Proc()
calls = 0
def fetch():
    global calls
    calls += 1
    return [host] if calls == 1 or sys.argv[2] == "sigterm" else []
e.fetch_rows = fetch
e._host_sts_client = lambda region: types.SimpleNamespace(get_caller_identity=lambda: {"Account": account})
e.write_spc = lambda text: None
e._start_steampipe = lambda: proc
e._stop_steampipe_service = lambda: None
e.SCOPE_WATCH_INTERVAL = 0.01
if sys.argv[2] == "sigterm":
    threading.Timer(0.1, lambda: os.kill(os.getpid(), signal.SIGTERM)).start()
e.main()
'''
    result = subprocess.run([sys.executable, "-B", "-c", script, str(Path(entrypoint.__file__).parent), mode],
                            capture_output=True, text=True, timeout=6, env={
                                "PATH": os.environ.get("PATH", ""), **ENV,
                                "AURORA_ENDPOINT": "fixture", "AURORA_DATABASE": "fixture",
                                "AWS_EC2_METADATA_DISABLED": "true",
                            })
    assert result.returncode == expected, result.stderr
    if mode == "fatal":
        assert "invalid_enabled_host_scope" in result.stderr
