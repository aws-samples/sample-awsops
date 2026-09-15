"""Unit tests for spc_render.render_spc — pure aws.spc generation for multi-account/region fan-out."""
import os
import sys
import re
import json
import configparser
from pathlib import Path
import unittest.mock as mock
import pytest

sys.path.insert(0, os.path.dirname(__file__))
from spc_render import LimiterConfig, limiter_config_from_env, render_spc  # noqa: E402
import spc_render


def _profiles(rows):
    parser = configparser.RawConfigParser()
    parser.read_string(spc_render.render_aws_config(rows))
    return parser


def _conn_names(spc):
    return re.findall(r'connection\s+"([^"]+)"', spc)


def _connection_attributes(body):
    return set(re.findall(r"^  ([a-z0-9_]+) =", body, re.M))


def test_contract_scanner_keeps_digit_attributes_visible_to_the_allowlist():
    body = "  s3_force_path_style = true\n  unsupported3_attribute = true\n"
    assert _connection_attributes(body) == {"s3_force_path_style", "unsupported3_attribute"}


def test_host_only_no_role_arn_no_external_id():
    spc = render_spc([
        {"account_id": "123456789012", "is_host": True, "role_name": "AWSopsReadOnlyRole",
         "external_id": None, "all_regions": True, "regions": []},
    ])
    assert 'connection "aws_123456789012"' in spc
    assert "assume_role_arn" not in spc        # host uses the task role's default chain
    assert "assume_role_external_id" not in spc
    assert 'regions = ["*"]' in spc
    assert "profile =" not in spc


def test_legacy_self_host_keeps_ambient_credentials_and_all_regions():
    rows = [{"account_id": "self", "is_host": True, "all_regions": False, "regions": []}]
    spc = render_spc(rows)
    assert 'connection "aws_self"' in spc
    assert 'regions = ["*"]' in spc
    assert "profile =" not in spc
    assert spc_render.render_aws_config(rows) == ""


@pytest.mark.parametrize("is_host", [False, None, "true", 1])
def test_self_sentinel_cannot_create_a_member_profile(is_host):
    row = {"account_id": "self", "is_host": is_host, "all_regions": True,
           "regions": [], "role_name": "AWSopsReadOnlyRole", "external_id": "fixture"}
    for render in (render_spc, spc_render.render_aws_config):
        with pytest.raises(ValueError, match="invalid AWS profile"):
            render([row])


def test_non_host_with_external_id():
    rows = [
        {"account_id": "210987654321", "is_host": False, "role_name": "AWSopsReadOnlyRole",
         "external_id": "ext-1", "all_regions": False, "regions": ["us-east-1", "eu-west-1"]},
    ]
    spc = render_spc(rows)
    assert 'profile = "aws_210987654321"' in spc
    assert dict(_profiles(rows)["profile aws_210987654321"]) == {
        "role_arn": "arn:aws:iam::210987654321:role/AWSopsReadOnlyRole",
        "credential_source": "EcsContainer", "external_id": "ext-1",
    }
    assert 'regions = ["us-east-1", "eu-west-1"]' in spc


def test_non_host_without_external_id_omits_line():
    rows = [
        {"account_id": "210987654321", "is_host": False, "role_name": "AWSopsReadOnlyRole",
         "external_id": None, "all_regions": True, "regions": []},
    ]
    assert 'profile = "aws_210987654321"' in render_spc(rows)
    assert "external_id" not in _profiles(rows)["profile aws_210987654321"]


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
    rows = [
        {"account_id": "210987654321", "is_host": False, "role_name": "AWSopsReadOnlyRole",
         "external_id": 'a"b\\c', "all_regions": False, "regions": ["us-east-1"]},
    ]
    with pytest.raises(ValueError, match="invalid AWS profile"):
        spc_render.render_aws_config(rows)
    assert spc_render._hcl('a"b\\c') == '"a\\"b\\\\c"'


def test_hcl_escapes_dollar_and_percent_template_markers():
    """M2 regression: a literal ${...} or %{...} in operator-supplied external_id must NOT be
    interpreted by Steampipe's HCL2 parser as an interpolation/template directive — it must render
    as HCL2's own doubling-escape ($$/%%) so the parser treats it as a literal $ / %. Unescaped,
    this either crashes aws.spc parsing (fail-closed) or evaluates an unintended expression."""
    assert spc_render._hcl("${aws_caller_identity}") == '"$${aws_caller_identity}"'
    assert spc_render._hcl("50%{template}") == '"50%%{template}"'
    for external_id in ["${aws_caller_identity}", "50%{template}"]:
        with pytest.raises(ValueError, match="invalid AWS profile"):
            spc_render.render_aws_config([{"account_id": "210987654321", "is_host": False,
                "role_name": "AWSopsReadOnlyRole", "external_id": external_id, "all_regions": True, "regions": []}])


def test_rendered_connection_attributes_match_pinned_upstream_plugin_schema():
    contract = json.loads((Path(__file__).parent / "fixtures/aws-plugin-0.142.0-contract.json").read_text())
    assert "s3_force_path_style" in contract["connection_hcl_attributes"]
    assert "s" not in contract["connection_hcl_attributes"]
    rows = [
        {"account_id": "123456789012", "is_host": True, "all_regions": True, "regions": []},
        {"account_id": "210987654321", "is_host": False, "all_regions": True, "regions": [],
         "role_name": "AWSopsReadOnlyRole", "external_id": "fixture-external-id"},
    ]
    assert spc_render.PLUGIN == contract["plugin"]
    connections = dict(re.findall(r'^connection "([^"]+)" \{\n(.*?)^\}', render_spc(rows), re.M | re.S))
    assert set(connections) == {"aws_123456789012", "aws_210987654321", "aws"}
    assert re.search(r'^  profile = "aws_210987654321"$', connections["aws_210987654321"], re.M)
    assert "profile" not in _connection_attributes(connections["aws_123456789012"])
    for name, body in connections.items():
        attributes = _connection_attributes(body)
        allowed = {"plugin", "type", "connections"} if name == "aws" else {"plugin", *contract["connection_hcl_attributes"]}
        assert attributes <= allowed, attributes - allowed
        assert attributes.isdisjoint({"access_key", "secret_key", "session_token", "credential_process"})
    parser = _profiles(rows)
    assert parser.sections() == ["profile aws_210987654321"]  # No host/default role override.
    assert set(parser[parser.sections()[0]]) == set(contract["credential_profile_keys"])


@pytest.mark.parametrize("field,value", [
    ("external_id", "value\n[default]\ncredential_process=evil"),
    ("external_id", "value\rrole_arn=evil"), ("external_id", "value\x00hidden"),
    ("role_name", "Role\ncredential_process=evil"), ("account_id", "123\n[default]"),
])
def test_profile_values_cannot_inject_ini_sections_or_credentials(field, value):
    row = {"account_id": "210987654321", "is_host": False, "role_name": "AWSopsReadOnlyRole",
           "external_id": "fixture-external-id", "all_regions": True, "regions": []}
    with pytest.raises(ValueError, match="invalid AWS profile"):
        spc_render.render_aws_config([{**row, field: value}])


def test_external_id_changes_only_profile_content_and_remains_reload_visible():
    row = {"account_id": "210987654321", "is_host": False, "role_name": "AWSopsReadOnlyRole",
           "external_id": "first-value", "all_regions": True, "regions": []}
    changed = {**row, "external_id": "second-value"}
    assert render_spc([row]) == render_spc([changed])
    assert spc_render.render_aws_config([row]) != spc_render.render_aws_config([changed])

def test_generated_profiles_resolve_ecs_source_and_assume_role_with_real_sdk(tmp_path):
    """Exercise an AWS SDK credential resolver, not a mirror of the rendered strings."""
    import botocore.session
    rows = [{"account_id": "210987654321", "is_host": False, "role_name": "AWSopsReadOnlyRole",
             "external_id": "fixture-external-id", "all_regions": True, "regions": []},
            {"account_id": "310987654321", "is_host": False, "role_name": "AWSopsReadOnlyRole",
             "external_id": None, "all_regions": True, "regions": []}]
    path = tmp_path / "config"
    path.write_text(spc_render.render_aws_config(rows))
    source = {"AccessKeyId": "FIXTURE_ECS_KEY", "SecretAccessKey": "FIXTURE_ECS_SECRET",
              "Token": "FIXTURE_ECS_TOKEN", "Expiration": "2099-01-01T00:00:00Z"}
    sts = mock.Mock()
    sts.assume_role.return_value = {"Credentials": {
        "AccessKeyId": "FIXTURE_TARGET_KEY", "SecretAccessKey": "FIXTURE_TARGET_SECRET",
        "SessionToken": "FIXTURE_TARGET_TOKEN", "Expiration": "2099-01-01T00:00:00Z"}}
    with mock.patch.dict(os.environ, {
        "AWS_CONFIG_FILE": str(path), "AWS_SHARED_CREDENTIALS_FILE": str(tmp_path / "absent"),
        "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI": "/fixture",
        "AWS_DEFAULT_REGION": "ap-northeast-2", "AWS_EC2_METADATA_DISABLED": "true",
    }, clear=True), mock.patch("botocore.utils.ContainerMetadataFetcher.retrieve_full_uri", return_value=source):
        for row in rows:
            sts.reset_mock()
            session = botocore.session.Session(profile=f"aws_{row['account_id']}")
            with mock.patch.object(session, "create_client", return_value=sts):
                credentials = session.get_credentials().get_frozen_credentials()
            assert credentials.access_key == "FIXTURE_TARGET_KEY"
            request = sts.assume_role.call_args.kwargs
            assert request["RoleArn"] == f"arn:aws:iam::{row['account_id']}:role/AWSopsReadOnlyRole"
            assert request.get("ExternalId") == row["external_id"]
        sts.reset_mock()
        session = botocore.session.Session()
        with mock.patch.object(session, "create_client", return_value=sts):
            assert session.get_credentials().get_frozen_credentials().access_key == "FIXTURE_ECS_KEY"
        sts.assume_role.assert_not_called()
    assert "FIXTURE_ECS" not in path.read_text()
    assert "FIXTURE_TARGET" not in path.read_text()


def test_host_included_even_when_flag_false_and_no_regions():
    # C1 regression guard: ensureHostRow may seed the host without account_regions; the host must
    # still scan all regions (not be skipped), else the whole inventory empties.
    spc = render_spc([
        {"account_id": "123456789012", "is_host": True, "role_name": "AWSopsReadOnlyRole",
         "external_id": None, "all_regions": False, "regions": []},
    ])
    assert 'connection "aws_123456789012"' in spc
    assert 'regions = ["*"]' in spc


def test_default_plugin_limiter_is_rendered_once_and_is_global():
    spc = render_spc([{
        "account_id": "123456789012", "is_host": True,
        "role_name": "AWSopsReadOnlyRole", "external_id": None,
        "all_regions": True, "regions": [],
    }])
    assert spc.count('plugin "aws"') == 1
    assert 'limiter "awsops_global"' in spc
    assert "max_concurrency = 4" in spc
    assert "bucket_size = 4" in spc
    assert "fill_rate = 2.0" in spc
    assert "scope =" not in spc


def test_custom_limiter_values_are_rendered():
    spc = render_spc([], LimiterConfig(2, 3, 0.5))
    assert "max_concurrency = 2" in spc
    assert "bucket_size = 3" in spc
    assert "fill_rate = 0.5" in spc


def test_limiter_env_validation_fails_closed():
    with pytest.raises(ValueError, match="STEAMPIPE_AWS_MAX_CONCURRENCY"):
        limiter_config_from_env({"STEAMPIPE_AWS_MAX_CONCURRENCY": "0"})
    with pytest.raises(ValueError, match="STEAMPIPE_AWS_BUCKET_SIZE"):
        limiter_config_from_env({"STEAMPIPE_AWS_BUCKET_SIZE": "41"})
    with pytest.raises(ValueError, match="STEAMPIPE_AWS_FILL_RATE"):
        limiter_config_from_env({"STEAMPIPE_AWS_FILL_RATE": "0"})


@pytest.mark.parametrize("fill_rate", ["nan", "inf", "-inf"])
def test_limiter_env_rejects_non_finite_fill_rate(fill_rate):
    with pytest.raises(ValueError, match="STEAMPIPE_AWS_FILL_RATE"):
        limiter_config_from_env({"STEAMPIPE_AWS_FILL_RATE": fill_rate})


# --- Supervisor / blast-radius tests (gen_spc_entrypoint) ---
# NOTE: gen_spc_entrypoint imports boto3 + pg8000.native. Import it LOCALLY inside each test below
# (not at module level) so a CI environment missing those deps only fails these specific tests —
# not the pure render_spc tests above, which have no such dependency and must always collect/run.


def test_entrypoint_renders_with_validated_limiter_config_and_logs_effective_values(capsys):
    import gen_spc_entrypoint

    rows = [{"account_id": "123456789012"}]
    limiter = LimiterConfig(2, 3, 0.5)
    with mock.patch.object(gen_spc_entrypoint, "limiter_config_from_env", return_value=limiter) as config, \
         mock.patch.object(gen_spc_entrypoint, "render_spc", return_value="rendered") as render:
        assert gen_spc_entrypoint._render_spc(rows) == "rendered"

    config.assert_called_once_with()
    render.assert_called_once_with(rows, limiter)
    record = json.loads(capsys.readouterr().err)
    assert record == {
        "event": "steampipe_limiter_config",
        "max_concurrency": 2,
        "bucket_size": 3,
        "fill_rate": 0.5,
    }


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
    with mock.patch("subprocess.run", return_value=mock.Mock(returncode=0)) as run, \
            mock.patch.object(gen_spc_entrypoint, "_steampipe_listener_closed", return_value=True):
        assert gen_spc_entrypoint._stop_steampipe_service() is True
    args, kwargs = run.call_args
    assert args[0] == ["steampipe", "service", "stop", "--force"]
    assert kwargs.get("timeout") == 30


def test_stop_steampipe_service_reports_failure_without_breaking_best_effort_shutdown():
    """Shutdown can ignore False, but restart must not confuse it with a clean full stop."""
    import gen_spc_entrypoint
    with mock.patch("subprocess.run", side_effect=Exception("boom")):
        assert gen_spc_entrypoint._stop_steampipe_service() is False


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

    with mock.patch.object(gen_spc_entrypoint, "_stop_steampipe_service", return_value=True) as stop_svc, \
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
