"""Unit tests for spc_render.render_spc — pure aws.spc generation for multi-account/region fan-out."""
import os
import sys
import re
import unittest.mock as mock

sys.path.insert(0, os.path.dirname(__file__))
from spc_render import render_spc  # noqa: E402


def _conn_names(spc):
    return re.findall(r'connection\s+"([^"]+)"', spc)


def test_host_only_no_role_arn_no_external_id():
    spc = render_spc([
        {"account_id": "123456789012", "is_host": True, "role_name": "AWSopsReadOnlyRole",
         "external_id": None, "all_regions": True, "regions": []},
    ])
    assert 'connection "aws_123456789012"' in spc
    assert "assume_role_arn" not in spc        # host uses the task role's default chain
    assert "assume_role_external_id" not in spc
    assert 'regions = ["*"]' in spc


def test_non_host_with_external_id():
    spc = render_spc([
        {"account_id": "210987654321", "is_host": False, "role_name": "AWSopsReadOnlyRole",
         "external_id": "ext-1", "all_regions": False, "regions": ["us-east-1", "eu-west-1"]},
    ])
    assert 'assume_role_arn = "arn:aws:iam::210987654321:role/AWSopsReadOnlyRole"' in spc
    assert 'assume_role_external_id = "ext-1"' in spc
    assert 'regions = ["us-east-1", "eu-west-1"]' in spc


def test_non_host_without_external_id_omits_line():
    spc = render_spc([
        {"account_id": "210987654321", "is_host": False, "role_name": "AWSopsReadOnlyRole",
         "external_id": None, "all_regions": True, "regions": []},
    ])
    assert "assume_role_arn" in spc
    assert "assume_role_external_id" not in spc


def test_empty_regions_not_all_is_skipped():
    spc = render_spc([
        {"account_id": "310987654321", "is_host": False, "role_name": "AWSopsReadOnlyRole",
         "external_id": "x", "all_regions": False, "regions": []},
    ])
    assert "aws_310987654321" not in spc   # skipped: not all-regions and nothing enabled


def test_connection_name_is_account_id_and_aggregator_present():
    spc = render_spc([
        {"account_id": "123456789012", "is_host": True, "role_name": "AWSopsReadOnlyRole",
         "external_id": None, "all_regions": True, "regions": []},
        {"account_id": "210987654321", "is_host": False, "role_name": "AWSopsReadOnlyRole",
         "external_id": "ext-1", "all_regions": False, "regions": ["us-east-1"]},
    ])
    assert "aws_123456789012" in _conn_names(spc)
    assert "aws_210987654321" in _conn_names(spc)
    # aggregator spans all per-account connections so existing `aws.*` queries fan out
    assert 'connection "aws"' in spc
    assert 'type = "aggregator"' in spc
    assert 'connections = ["aws_*"]' in spc


def test_hcl_escaping_of_values():
    spc = render_spc([
        {"account_id": "210987654321", "is_host": False, "role_name": "AWSopsReadOnlyRole",
         "external_id": 'a"b\\c', "all_regions": False, "regions": ["us-east-1"]},
    ])
    assert 'assume_role_external_id = "a\\"b\\\\c"' in spc


def test_hcl_escapes_dollar_and_percent_template_markers():
    """M2 regression: a literal ${...} or %{...} in operator-supplied external_id must NOT be
    interpreted by Steampipe's HCL2 parser as an interpolation/template directive — it must render
    as HCL2's own doubling-escape ($$/%%) so the parser treats it as a literal $ / %. Unescaped,
    this either crashes aws.spc parsing (fail-closed) or evaluates an unintended expression."""
    spc = render_spc([
        {"account_id": "210987654321", "is_host": False, "role_name": "AWSopsReadOnlyRole",
         "external_id": "${aws_caller_identity}", "all_regions": False, "regions": ["us-east-1"]},
    ])
    assert 'assume_role_external_id = "$${aws_caller_identity}"' in spc
    assert "${aws_caller_identity}" not in spc.replace("$${aws_caller_identity}", "")  # no bare ${...} survives

    spc2 = render_spc([
        {"account_id": "310987654321", "is_host": False, "role_name": "AWSopsReadOnlyRole",
         "external_id": "50%{template}", "all_regions": False, "regions": ["us-east-1"]},
    ])
    assert 'assume_role_external_id = "50%%{template}"' in spc2


def test_host_included_even_when_flag_false_and_no_regions():
    # C1 regression guard: ensureHostRow may seed the host without account_regions; the host must
    # still scan all regions (not be skipped), else the whole inventory empties.
    spc = render_spc([
        {"account_id": "123456789012", "is_host": True, "role_name": "AWSopsReadOnlyRole",
         "external_id": None, "all_regions": False, "regions": []},
    ])
    assert 'connection "aws_123456789012"' in spc
    assert 'regions = ["*"]' in spc


# --- Supervisor / blast-radius tests (gen_spc_entrypoint) ---
# NOTE: gen_spc_entrypoint imports boto3 + pg8000.native. Import it LOCALLY inside each test below
# (not at module level) so a CI environment missing those deps only fails these specific tests —
# not the pure render_spc tests above, which have no such dependency and must always collect/run.


def test_no_aurora_secret_anywhere():
    """M1: no Aurora secret (master or otherwise) is read/expected by this module at all — the
    entrypoint uses IAM database auth exclusively. Static guard against reintroducing AURORA_SECRET."""
    import inspect
    import gen_spc_entrypoint
    src = inspect.getsource(gen_spc_entrypoint)
    assert "AURORA_SECRET" not in src, "gen_spc_entrypoint must not reference any Aurora secret"
    assert "AURORA_SECRET" not in os.environ


def test_generate_auth_token_uses_iam_auth_not_a_secret():
    """_generate_auth_token must call boto3 rds.generate_db_auth_token (IAM auth) with the
    dedicated steampipe_reader user — never read a password/secret from anywhere (M1 fix)."""
    import gen_spc_entrypoint
    fake_client = mock.MagicMock()
    fake_client.generate_db_auth_token.return_value = "signed-iam-token"
    with mock.patch.dict(os.environ, {
        "AURORA_ENDPOINT": "aurora.cluster.example.com",
        "AURORA_DATABASE": "awsops",
        "AWS_REGION": "ap-northeast-2",
    }), mock.patch("boto3.client", return_value=fake_client) as boto_client:
        token = gen_spc_entrypoint._generate_auth_token()
    assert token == "signed-iam-token"
    boto_client.assert_called_once_with("rds", region_name="ap-northeast-2")
    fake_client.generate_db_auth_token.assert_called_once_with(
        DBHostname="aurora.cluster.example.com", Port=5432,
        DBUsername=gen_spc_entrypoint.AURORA_USER,
    )


def test_start_steampipe_never_receives_a_password_env():
    """The Steampipe subprocess inherits the parent env unchanged (no explicit env= override that
    could carry a password/secret) — confirms M1's blast-radius elimination at the Popen call site."""
    import gen_spc_entrypoint
    with mock.patch("subprocess.Popen") as popen:
        gen_spc_entrypoint._start_steampipe()
    _, kwargs = popen.call_args
    assert "env" not in kwargs, "no explicit env override — nothing sensitive to strip"


def test_stop_steampipe_service_runs_the_canonical_stop_command():
    """M-A: restarting must explicitly run `steampipe service stop --force` (not rely solely on
    terminate()/kill() of our own Popen handle), since `service start --foreground` manages an
    embedded PostgreSQL + on-disk service-state lock that our process-level kill does not
    guarantee is released before the next `service start`."""
    import gen_spc_entrypoint
    with mock.patch("subprocess.run") as run:
        gen_spc_entrypoint._stop_steampipe_service()
    args, kwargs = run.call_args
    assert args[0] == ["steampipe", "service", "stop", "--force"]
    assert kwargs.get("timeout") == 30


def test_stop_steampipe_service_is_best_effort_on_failure():
    """A failing/timed-out `service stop` must not raise — the caller always proceeds to attempt
    `_start_steampipe()` regardless, which fails closed via the existing crash-restart path."""
    import gen_spc_entrypoint
    with mock.patch("subprocess.run", side_effect=Exception("boom")):
        gen_spc_entrypoint._stop_steampipe_service()  # must not raise


def test_restart_steampipe_performs_full_sequence_when_old_still_current():
    """M-1 (round 8) happy path: when `old` still matches `proc_ref[0]` at lock-acquisition time
    (the normal, non-racing case), _restart_steampipe must terminate/wait, stop-service, and
    start a fresh process, updating proc_ref[0]."""
    import threading
    import gen_spc_entrypoint

    class FakeProc:
        def __init__(self, name):
            self.name = name
            self.terminated = False

        def terminate(self):
            self.terminated = True

        def wait(self, timeout=None):
            return 0

    old = FakeProc("old")
    new = FakeProc("new")
    proc_ref = [old]
    restart_lock = threading.Lock()

    with mock.patch.object(gen_spc_entrypoint, "_stop_steampipe_service") as stop_svc, \
         mock.patch.object(gen_spc_entrypoint, "_start_steampipe", return_value=new) as start:
        gen_spc_entrypoint._restart_steampipe(proc_ref, restart_lock, old)

    assert old.terminated is True
    stop_svc.assert_called_once()
    start.assert_called_once()
    assert proc_ref[0] is new


def test_restart_steampipe_is_a_noop_when_old_already_replaced():
    """M-1 (round 8) regression test — THE race fix: if `proc_ref[0]` no longer matches `old` by
    the time the lock is acquired (another restart already won the race and replaced it),
    _restart_steampipe must be a complete no-op: it must NOT call terminate()/stop_service/
    start_steampipe again, which would otherwise clobber whatever the winning caller just
    started. This is the exact scenario the round-7 CI review flagged: two independent restart
    paths racing to call the GLOBAL `steampipe service stop --force`, with a stale caller killing
    a freshly-started process."""
    import threading
    import gen_spc_entrypoint

    class FakeProc:
        def __init__(self):
            self.terminated = False

        def terminate(self):
            self.terminated = True

    stale_old = FakeProc()  # what THIS caller thinks is the current process
    already_started_by_someone_else = FakeProc()
    proc_ref = [already_started_by_someone_else]  # ...but proc_ref[0] has already moved on
    restart_lock = threading.Lock()

    with mock.patch.object(gen_spc_entrypoint, "_stop_steampipe_service") as stop_svc, \
         mock.patch.object(gen_spc_entrypoint, "_start_steampipe") as start:
        gen_spc_entrypoint._restart_steampipe(proc_ref, restart_lock, stale_old)

    assert stale_old.terminated is False, "a stale caller must not terminate a process it doesn't own"
    stop_svc.assert_not_called()
    start.assert_not_called()
    assert proc_ref[0] is already_started_by_someone_else, "the winning caller's process must survive untouched"


def test_signal_handler_does_not_deadlock_when_caller_holds_proc_lock():
    """Regression test for M3: the signal handler must not touch proc_lock at all. Simulate the
    worst case — the SAME thread already holds proc_lock (as the main supervisor loop does mid-
    restart) — and confirm the handler still completes (via SystemExit) instead of self-deadlocking
    on a non-reentrant threading.Lock."""
    import threading
    import pytest
    import gen_spc_entrypoint

    class FakeProc:
        def __init__(self):
            self.terminated = False

        def terminate(self):
            self.terminated = True

    fake = FakeProc()
    proc_ref = [fake]
    proc_lock = threading.Lock()
    stop = threading.Event()

    proc_lock.acquire()  # simulate: this thread already holds proc_lock (mid-restart window)
    try:
        with pytest.raises(SystemExit):
            gen_spc_entrypoint._on_signal(15, None, proc_ref, stop)
    finally:
        proc_lock.release()

    assert stop.is_set()
    assert fake.terminated
