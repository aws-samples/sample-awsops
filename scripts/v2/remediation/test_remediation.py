# scripts/v2/remediation/test_remediation.py
"""ADR-029+036 remediation substrate tests — catalog loader + fail-closed gating (Task 3).
No live AWS / no DB: a fake conn and a monkeypatched SSM client exercise every gate branch."""
import ast
import json
import os
import pathlib
import sys

_HERE = pathlib.Path(__file__).resolve().parent
# action_catalog.py does `import db` (scripts/v2/workers/db.py, shipped in the same artifact).
sys.path.insert(0, str(_HERE))
sys.path.insert(0, str(_HERE.parent / "workers"))
os.environ.setdefault("AWS_REGION", "ap-northeast-2")

import action_catalog as ac  # noqa: E402


_ACTION_ROW = (
    "ec2-detach-sg",          # name
    "ssm",                    # executor_type
    "ec2:instance",           # target_resource_type
    "RemediationAutomationRole",  # assume_role_ref
    '["resourceArn"]',        # required_inputs (JSON text — loader must parse)
    '{"mode":"describe"}',    # dry_run_contract (JSON text)
    "onFailure-reattach",     # rollback_ref
    "four_eyes",              # approval_mode
    '{"accounts":["self"]}',  # conditions (JSON text)
    True,                     # enabled
)


class _FakeConn:
    """Minimal pg8000-shaped conn: .run(sql, **params) -> list-of-row-tuples."""

    def __init__(self, rows):
        self._rows = rows
        self.calls = []

    def run(self, sql, **params):
        self.calls.append((sql, params))
        return self._rows


class _FakeParam:
    def __init__(self, value):
        self._value = value

    def get_parameter(self, Name):  # noqa: N803 (mirror boto3 signature)
        return {"Parameter": {"Value": self._value}}


def test_module_compiles():
    src = (_HERE / "action_catalog.py").read_text()
    ast.parse(src)  # raises SyntaxError on a broken module


def test_load_action_parses_json_columns():
    conn = _FakeConn([_ACTION_ROW])
    a = ac.load_action(conn, "ec2-detach-sg")
    assert a["name"] == "ec2-detach-sg"
    assert a["enabled"] is True
    # JSON text columns must be decoded to native structures.
    assert a["required_inputs"] == ["resourceArn"]
    assert a["dry_run_contract"] == {"mode": "describe"}
    assert a["conditions"] == {"accounts": ["self"]}


def test_load_action_missing_returns_none():
    assert ac.load_action(_FakeConn([]), "nope") is None


def test_gate_flag_off_when_env_unset(monkeypatch):
    monkeypatch.delenv("REMEDIATION_ENABLED", raising=False)
    # SSM on + enabled row would otherwise pass — flag must short-circuit first.
    monkeypatch.setattr(ac, "_ssm", _FakeParam("true"))
    a, reason = ac.gate(_FakeConn([_ACTION_ROW]), "ec2-detach-sg")
    assert a is None and reason == "flag_off"


def test_gate_killswitch_off_when_param_false(monkeypatch):
    monkeypatch.setenv("REMEDIATION_ENABLED", "true")
    monkeypatch.setattr(ac, "_ssm", _FakeParam("false"))
    a, reason = ac.gate(_FakeConn([_ACTION_ROW]), "ec2-detach-sg")
    assert a is None and reason == "killswitch_off"


def test_gate_killswitch_fail_closed_on_ssm_error(monkeypatch):
    class _Boom:
        def get_parameter(self, Name):  # noqa: N803
            raise RuntimeError("ssm unreachable")

    monkeypatch.setenv("REMEDIATION_ENABLED", "true")
    monkeypatch.setattr(ac, "_ssm", _Boom())
    a, reason = ac.gate(_FakeConn([_ACTION_ROW]), "ec2-detach-sg")
    assert a is None and reason == "killswitch_off"


def test_gate_unknown_action(monkeypatch):
    monkeypatch.setenv("REMEDIATION_ENABLED", "true")
    monkeypatch.setattr(ac, "_ssm", _FakeParam("true"))
    a, reason = ac.gate(_FakeConn([]), "ghost")
    assert a is None and reason == "unknown_action"


def test_gate_action_disabled_row(monkeypatch):
    monkeypatch.setenv("REMEDIATION_ENABLED", "true")
    monkeypatch.setattr(ac, "_ssm", _FakeParam("true"))
    disabled = _ACTION_ROW[:-1] + (False,)
    a, reason = ac.gate(_FakeConn([disabled]), "ec2-detach-sg")
    assert a is None and reason == "action_disabled"


def test_gate_passes_only_when_all_three_pass(monkeypatch):
    monkeypatch.setenv("REMEDIATION_ENABLED", "true")
    monkeypatch.setattr(ac, "_ssm", _FakeParam("true"))
    a, reason = ac.gate(_FakeConn([_ACTION_ROW]), "ec2-detach-sg")
    assert reason is None
    assert a is not None and a["name"] == "ec2-detach-sg"


# ADR-040/041 §4 — the executor-side control plane is decoupled by target_resource_type. An external:
# DATA-write is gated by the integrations-write plane; enabling one plane can NEVER enable the other.
_SLACK_ROW = ("slack.post_message", "lambda", "external:slack", "integrations-slack-write",
              '["channel","text"]', '{"mode":"preview"}', None, "four_eyes", '{"accounts":["self"]}', True)

def test_gate_external_uses_integrations_write_flag(monkeypatch):
    # REMEDIATION on, INTEGRATIONS_WRITE off → an external action is flag_off (the AWS flag does NOT enable it).
    monkeypatch.setenv("REMEDIATION_ENABLED", "true")
    monkeypatch.delenv("INTEGRATIONS_WRITE_ENABLED", raising=False)
    monkeypatch.setattr(ac, "_ssm", _FakeParam("true"))
    a, reason = ac.gate(_FakeConn([_SLACK_ROW]), "slack.post_message")
    assert a is None and reason == "flag_off"

def test_gate_external_flag_does_not_enable_aws(monkeypatch):
    # ADVERSARIAL: INTEGRATIONS_WRITE on, REMEDIATION off → an AWS-resource action is STILL flag_off.
    monkeypatch.setenv("INTEGRATIONS_WRITE_ENABLED", "true")
    monkeypatch.delenv("REMEDIATION_ENABLED", raising=False)
    monkeypatch.setattr(ac, "_ssm", _FakeParam("true"))
    a, reason = ac.gate(_FakeConn([_ACTION_ROW]), "ec2-detach-sg")
    assert a is None and reason == "flag_off"

def test_gate_external_passes_with_its_own_flag(monkeypatch):
    monkeypatch.setenv("INTEGRATIONS_WRITE_ENABLED", "true")
    monkeypatch.delenv("REMEDIATION_ENABLED", raising=False)
    monkeypatch.setattr(ac, "_ssm", _FakeParam("true"))
    a, reason = ac.gate(_FakeConn([_SLACK_ROW]), "slack.post_message")
    assert reason is None and a is not None and a["name"] == "slack.post_message"


# ---------------------------------------------------------------------------
# Task 4: remediation_executor.py — dry-run / execute / rollback skeleton.
# No live AWS / no DB: monkeypatch db.connect, cat.gate, _assume.
# ---------------------------------------------------------------------------
import remediation_executor as ex  # noqa: E402


class _ExecConn:
    """Records every .run() and .close() so we can assert NO terminal write happened."""

    def __init__(self):
        self.calls = []
        self.closed = False

    def run(self, sql, **params):
        self.calls.append((sql, params))
        return []

    def close(self):
        self.closed = True


def _boom_assume(*_a, **_k):  # pragma: no cover - must never be reached on a blocked path
    raise AssertionError("_assume must not be called when the action is gate-blocked")


def test_executor_module_compiles():
    src = (_HERE / "remediation_executor.py").read_text()
    ast.parse(src)  # raises SyntaxError on a broken module


def test_dry_run_fns_are_pure_and_declare_no_mutation():
    # A poisoned session: any boto3 attribute access raises — proves dry-run never touches AWS.
    class _PoisonSession:
        def __getattr__(self, _name):
            raise AssertionError("dry-run must not touch boto3 / the session")

    sess = _PoisonSession()
    flag = ex._flag_dry_run({"flagKey": "beta", "value": True}, sess)
    assert flag["mutates"] is False and flag["would_set"] == "beta"
    ops = ex._opsitem_dry_run({"title": "investigate"}, sess)
    assert ops["mutates"] is False and ops["would_create_opsitem_title"] == "investigate"


def test_handler_gate_blocked_fails_closed_no_terminal_write(monkeypatch):
    conn = _ExecConn()
    monkeypatch.setattr(ex.db, "connect", lambda: conn)
    monkeypatch.setattr(ex.cat, "gate", lambda _c, _n: (None, "killswitch_off"))
    # If the role were ever assumed on a blocked path that is a safety violation.
    monkeypatch.setattr(ex, "_assume", _boom_assume)

    import pytest  # noqa: E402

    with pytest.raises(RuntimeError, match="^blocked:killswitch_off$"):
        ex.lambda_handler(
            {"job_id": "j1", "action": "app-feature-flag-set", "phase": "execute"}, None)
    # Fail-closed: no UPDATE/INSERT at all → no terminal status written.
    assert conn.calls == []
    assert conn.closed is True  # finally: conn.close() still ran


def test_handler_rollback_without_handler_raises_manual(monkeypatch):
    conn = _ExecConn()
    monkeypatch.setattr(ex.db, "connect", lambda: conn)
    # incident-manager-enrich has rb=None; gate must pass for us to reach the rollback branch.
    # (ADR-034 gave opscenter-create-opsitem a real rollback = _opsitem_resolve, so the no-rollback
    #  MANUAL_INTERVENTION path is now exercised via the enrich action.)
    monkeypatch.setattr(ex.cat, "gate", lambda _c, _n: ({"name": "incident-manager-enrich"}, None))
    monkeypatch.setattr(ex, "_assume", lambda _arn: object())
    monkeypatch.setenv("ACTION_ROLE_INCIDENT_MANAGER_ENRICH", "arn:aws:iam::1:role/x")

    import pytest  # noqa: E402

    with pytest.raises(RuntimeError, match="MANUAL_INTERVENTION_REQUIRED"):
        ex.lambda_handler(
            {"job_id": "j2", "action": "incident-manager-enrich", "phase": "rollback"}, None)
    assert conn.closed is True


# ---------------------------------------------------------------------------
# Task 5: ssm_bridge.build_start_params + record_ssm_start + status_resume.
# No live AWS / no DB: a fake conn + monkeypatched boto3 clients.
# ---------------------------------------------------------------------------
import ssm_bridge as sb  # noqa: E402
import record_ssm_start as rss  # noqa: E402
import status_resume as sr  # noqa: E402


def test_ssm_modules_compile():
    for f in ("ssm_bridge.py", "record_ssm_start.py", "status_resume.py"):
        ast.parse((_HERE / f).read_text())  # raises SyntaxError on a broken module


_SSM_ACTION = {
    "name": "ec2-create-tags",
    "assume_role_ref": "RemediationAutomationRole",
    "conditions": {"accounts": ["self"]},
}


def test_build_start_params_host_only_omits_target_locations(monkeypatch):
    monkeypatch.delenv("ALLOW_CROSS_ACCOUNT_MUTATION", raising=False)
    monkeypatch.setenv("EC2_CREATE_TAGS_DOC", "AWSops-ec2-create-tags")
    monkeypatch.setenv("ASSUME_ROLE_REMEDIATIONAUTOMATIONROLE", "arn:aws:iam::1:role/r")
    params = sb.build_start_params(_SSM_ACTION, {"resourceId": "i-0abc"}, dry_run=True)
    assert "TargetLocations" not in params
    assert params["DocumentName"] == "AWSops-ec2-create-tags"
    assert params["Parameters"]["AutomationAssumeRole"] == ["arn:aws:iam::1:role/r"]
    assert params["Parameters"]["ResourceId"] == ["i-0abc"]
    assert params["Parameters"]["DryRun"] == ["true"]


def test_build_start_params_xacct_requires_flag_and_nonself_account(monkeypatch):
    monkeypatch.setenv("EC2_CREATE_TAGS_DOC", "AWSops-ec2-create-tags")
    monkeypatch.setenv("ASSUME_ROLE_REMEDIATIONAUTOMATIONROLE", "arn:aws:iam::1:role/r")
    action = {**_SSM_ACTION,
              "conditions": {"accounts": ["self", "222222222222"], "regions": ["ap-northeast-2"]}}
    # flag unset → host-only even though a non-self account is present
    monkeypatch.delenv("ALLOW_CROSS_ACCOUNT_MUTATION", raising=False)
    assert "TargetLocations" not in sb.build_start_params(action, {}, dry_run=False)
    # flag set but only 'self' in conditions → still host-only
    monkeypatch.setenv("ALLOW_CROSS_ACCOUNT_MUTATION", "true")
    assert "TargetLocations" not in sb.build_start_params(_SSM_ACTION, {}, dry_run=False)
    # flag set AND a non-self account → emit TargetLocations
    p = sb.build_start_params(action, {}, dry_run=False)
    assert p["TargetLocations"] == [{"Accounts": ["222222222222"],
                                     "Regions": ["ap-northeast-2"],
                                     "ExecutionRoleName": "RemediationAutomationRole"}]
    assert p["Parameters"]["DryRun"] == ["false"]


def test_record_ssm_start_blocked_never_starts_automation(monkeypatch):
    conn = _ExecConn()
    monkeypatch.setattr(rss.db, "connect", lambda: conn)
    monkeypatch.setattr(rss.cat, "gate", lambda _c, _n: (None, "killswitch_off"))

    class _BoomSsm:
        def start_automation_execution(self, **_k):  # pragma: no cover - must never run
            raise AssertionError("start_automation_execution must not run on a blocked path")

    monkeypatch.setattr(rss, "_ssm", _BoomSsm())

    import pytest  # noqa: E402

    with pytest.raises(RuntimeError, match="^blocked:killswitch_off$"):
        rss.lambda_handler(
            {"job_id": "j3", "action": "ec2-create-tags", "taskToken": "tok"}, None)
    # Fail-closed: no claim/UPDATE at all → automation never started.
    assert conn.calls == []
    assert conn.closed is True


def test_status_resume_routes_success_and_failure(monkeypatch):
    calls = {"success": [], "failure": [], "finished": []}

    class _FakeSfn:
        def send_task_success(self, taskToken, output):  # noqa: N803
            calls["success"].append((taskToken, output))

        def send_task_failure(self, taskToken, error, cause):  # noqa: N803
            calls["failure"].append((taskToken, error, cause))

    conn = _ExecConn()
    # Return the parked row (job_id, task_token) for the lookup-by-exec-id SELECT.
    conn.run = lambda sql, **p: [("j4", "tok4")]  # type: ignore[assignment]
    monkeypatch.setattr(sr.db, "connect", lambda: conn)
    monkeypatch.setattr(sr, "_sfn", _FakeSfn())
    monkeypatch.setattr(sr.db, "finish_job",
                        lambda _c, jid, st, result=None: calls["finished"].append((jid, st)))

    ok = sr.lambda_handler({"detail": {"ExecutionId": "e1", "Status": "Success"}}, None)
    assert ok == {"matched": True, "status": "Success"}
    assert len(calls["success"]) == 1 and calls["finished"] == [("j4", "succeeded")]

    bad = sr.lambda_handler({"detail": {"ExecutionId": "e1", "Status": "Failed"}}, None)
    assert bad == {"matched": True, "status": "Failed"}
    assert len(calls["failure"]) == 1


# ---------------------------------------------------------------------------
# Task 6: catalog-aware dispatcher + reaper reconciliation (backward-compatible).
# No live AWS / no DB: a stub _sfn records start_execution; a fake conn records reaper SELECTs.
# The existing P2 GREEN path (noop/noop-heavy -> workers SM) MUST stay byte-compatible.
# ---------------------------------------------------------------------------
# dispatcher.py reads os.environ["STATE_MACHINE_ARN"] at import + builds a boto3 client. Set the env
# and a region BEFORE importing so the import succeeds with no live AWS.
os.environ.setdefault("STATE_MACHINE_ARN", "arn:aws:states:ap-northeast-2:1:stateMachine:workers")
import dispatcher as dsp  # noqa: E402
import reaper as rp  # noqa: E402


class _StubSfn:
    """Records every start_execution; exposes .exceptions.ExecutionAlreadyExists like the real client."""

    class exceptions:  # noqa: N801 (mirror boto3 client.exceptions namespace)
        class ExecutionAlreadyExists(Exception):
            pass

    def __init__(self):
        self.starts = []

    def start_execution(self, stateMachineArn, name, input):  # noqa: N803
        self.starts.append({"sm": stateMachineArn, "name": name, "input": json.loads(input)})


def _sqs_event(body):
    return {"Records": [{"messageId": "m1", "body": json.dumps(body)}]}


def test_dispatcher_modules_compile():
    for f in ("dispatcher.py", "reaper.py"):
        ast.parse((_HERE.parent / "workers" / f).read_text())


def test_dispatcher_routes_action_to_remediation_sm(monkeypatch):
    stub = _StubSfn()
    monkeypatch.setattr(dsp, "_sfn", stub)
    monkeypatch.setattr(dsp, "_REM_SM_ARN", "arn:aws:states:ap-northeast-2:1:stateMachine:remediation")
    out = dsp.lambda_handler(_sqs_event({
        "job_id": "a1", "type": "action", "action": "ec2-detach-sg",
        "executor_type": "ssm", "plan_id": "p1", "payload": {"resourceArn": "x"}, "dry_run": True}), None)
    assert out == {"batchItemFailures": []}
    assert len(stub.starts) == 1
    s = stub.starts[0]
    assert s["sm"].endswith(":remediation") and s["name"] == "a1"
    assert s["input"]["action"] == "ec2-detach-sg"
    assert s["input"]["runtime"] == "ssm"  # executor_type drives the remediation SM Choice
    assert s["input"]["plan_id"] == "p1" and s["input"]["dry_run"] is True


def test_dispatcher_drops_action_when_remediation_off(monkeypatch):
    stub = _StubSfn()
    monkeypatch.setattr(dsp, "_sfn", stub)
    monkeypatch.setattr(dsp, "_REM_SM_ARN", "")  # remediation substrate OFF (no infra / flag off)
    out = dsp.lambda_handler(_sqs_event({
        "job_id": "a2", "type": "action", "action": "ec2-detach-sg", "executor_type": "ssm"}), None)
    # DROPPED (not retried, not DLQ'd): no execution started, no batch failure.
    assert out == {"batchItemFailures": []}
    assert stub.starts == []


def test_dispatcher_p2_noop_paths_unchanged(monkeypatch):
    """Backward-compat: noop -> workers SM (lambda), noop-heavy -> workers SM (fargate)."""
    stub = _StubSfn()
    monkeypatch.setattr(dsp, "_sfn", stub)
    monkeypatch.setattr(dsp, "_REM_SM_ARN", "arn:aws:states:ap-northeast-2:1:stateMachine:remediation")
    dsp.lambda_handler(_sqs_event({"job_id": "n1", "type": "noop", "payload": {}}), None)
    dsp.lambda_handler(_sqs_event({"job_id": "n2", "type": "noop-heavy", "payload": {}}), None)
    assert len(stub.starts) == 2
    assert all(s["sm"] == dsp._SM_ARN for s in stub.starts)  # NOT the remediation SM
    assert stub.starts[0]["input"]["runtime"] == "lambda"
    assert stub.starts[1]["input"]["runtime"] == "fargate"
    assert "action" not in stub.starts[0]["input"]  # P2 input shape is unchanged


def test_reaper_remediation_select_excludes_manual_intervention(monkeypatch):
    """The reaper reconciliation SELECT must scope to running/awaiting_approval and NEVER touch
    'manual_intervention' (a terminal operator state); and it must never UPDATE remediation rows."""
    seen = []

    class _ReapConn:
        def run(self, sql, **params):
            seen.append(sql)
            return []  # no rows for any query

        def close(self):
            pass

    monkeypatch.setattr(rp.db, "connect", lambda: _ReapConn())
    monkeypatch.setattr(rp, "_dispatch_enabled", lambda: True)
    out = rp.lambda_handler({}, None)
    assert out["stale_remediation_rows"] == 0
    # Find the remediation reconciliation SELECT.
    rem = [s for s in seen if "automation_execution_id IS NOT NULL" in s]
    assert len(rem) == 1
    sql = rem[0]
    assert sql.lstrip().startswith("SELECT")  # read-only: never UPDATEs remediation rows
    assert "'manual_intervention'" not in sql  # never reaps a terminal operator state
    assert "'running'" in sql and "'awaiting_approval'" in sql


# ---------------------------------------------------------------------------
# Task 7: remediation.asl.json — dry-run -> approval (fail-closed) -> ssm/lambda/fargate
# -> rollback -> terminal MANUAL_INTERVENTION_REQUIRED. JSON-parse after substituting the
# templatefile `${...}` placeholders ($.subnets_json is an unquoted array literal).
# ---------------------------------------------------------------------------
import re as _re  # noqa: E402


def _load_asl():
    raw = (_HERE / "remediation.asl.json").read_text()
    # `${subnets_json}` is the only UNQUOTED placeholder (a JSON array literal at apply time).
    raw = raw.replace("${subnets_json}", '["subnet-a", "subnet-b"]')
    # Every other `${...}` sits inside a JSON string → swap for a plain token.
    raw = _re.sub(r"\$\{[a-zA-Z0-9_]+\}", "SUBST", raw)
    return json.loads(raw)


def test_asl_parses_and_starts_with_dry_run():
    asl = _load_asl()  # raises JSONDecodeError on malformed ASL
    assert asl["StartAt"] == "DryRunFirst"
    assert set(["DryRunFirst", "ApprovalWait", "Route", "RunSsm", "RunCodeLambda",
                "RunCodeFargate", "Rollback", "ManualIntervention", "MarkFailed",
                "JobFailed", "JobManual"]).issubset(asl["States"].keys())


def test_asl_route_choice_has_ssm_branch():
    states = _load_asl()["States"]
    choices = states["Route"]["Choices"]
    ssm = [c for c in choices if c.get("StringEquals") == "ssm"]
    assert len(ssm) == 1 and ssm[0]["Next"] == "RunSsm"
    assert all(c["Variable"] == "$.runtime" for c in choices)
    assert states["Route"]["Default"] == "UnknownRuntime"


def test_asl_ssm_branch_uses_wait_for_task_token():
    run_ssm = _load_asl()["States"]["RunSsm"]
    assert run_ssm["Resource"] == "arn:aws:states:::lambda:invoke.waitForTaskToken"
    # The Choice routes ssm here; on error it rolls back (never silently ends).
    assert run_ssm["Catch"][0]["Next"] == "Rollback"
    assert run_ssm.get("End") is True


def test_asl_approval_wait_fails_closed_on_timeout():
    aw = _load_asl()["States"]["ApprovalWait"]
    assert aw["Resource"] == "arn:aws:states:::lambda:invoke.waitForTaskToken"
    # Finite timeout (not absent / not 0) so an un-approved action cannot hang forever.
    assert isinstance(aw["TimeoutSeconds"], int) and aw["TimeoutSeconds"] > 0
    # A States.Timeout Catch must route to MarkFailed (fail CLOSED — no execution).
    timeout_catch = [c for c in aw["Catch"] if "States.Timeout" in c["ErrorEquals"]]
    assert len(timeout_catch) == 1 and timeout_catch[0]["Next"] == "MarkFailed"


def test_asl_rollback_failure_goes_to_manual_intervention():
    states = _load_asl()["States"]
    rb = states["Rollback"]
    # On rollback FAILURE -> ManualIntervention (never an infinite retry loop).
    catch = [c for c in rb["Catch"] if "States.ALL" in c["ErrorEquals"]]
    assert len(catch) == 1 and catch[0]["Next"] == "ManualIntervention"
    assert rb["Next"] == "MarkFailed"  # rollback SUCCESS still records failed
    # ManualIntervention flags the terminal-operator status via status_updater.
    mi = states["ManualIntervention"]
    assert mi["Parameters"]["Payload"]["manual_intervention"] is True
    assert mi["Next"] == "JobManual"


def test_asl_jobmanual_is_terminal_fail():
    jm = _load_asl()["States"]["JobManual"]
    assert jm["Type"] == "Fail"
    assert jm["Error"] == "ManualInterventionRequired"


def test_db_terminal_set_includes_manual_intervention():
    # ast-level assertion: db._TERMINAL widened to include 'manual_intervention'.
    src = (_HERE.parent / "workers" / "db.py").read_text()
    tree = ast.parse(src)
    found = None
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and any(
                isinstance(t, ast.Name) and t.id == "_TERMINAL" for t in node.targets):
            found = {el.value for el in node.value.elts}
    assert found is not None and "manual_intervention" in found


# ======================================================================================
# Task 10 — Fargate executor CLI shim (CMD path). No live AWS / no DB: ast-level assertions
# prove the shim compiles, delegates to remediation_executor, and forwards --phase.
# ======================================================================================
_CLI_SRC = (_HERE / "remediation_executor_cli.py").read_text()


def test_cli_module_compiles():
    ast.parse(_CLI_SRC)  # raises SyntaxError on a broken module


def test_cli_imports_remediation_executor():
    tree = ast.parse(_CLI_SRC)
    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                imported.add(alias.name)
    assert "remediation_executor" in imported, "CLI must reuse remediation_executor.lambda_handler"


def test_cli_defines_and_forwards_phase():
    tree = ast.parse(_CLI_SRC)
    # --phase is a registered argparse argument (with an execute-by-default).
    phase_args = [
        c for c in ast.walk(tree)
        if isinstance(c, ast.Call)
        and isinstance(c.func, ast.Attribute) and c.func.attr == "add_argument"
        and c.args and isinstance(c.args[0], ast.Constant) and c.args[0].value == "--phase"
    ]
    assert phase_args, "CLI must register a --phase argument"
    assert any(
        kw.arg == "default" and getattr(kw.value, "value", None) == "execute"
        for kw in phase_args[0].keywords
    ), "--phase must default to execute"
    # The lambda-style event passed to lambda_handler carries a 'phase' key sourced from args.phase.
    phase_forwarded = False
    for node in ast.walk(tree):
        if isinstance(node, ast.Dict):
            for k, v in zip(node.keys, node.values):
                if (isinstance(k, ast.Constant) and k.value == "phase"
                        and isinstance(v, ast.Attribute) and v.attr == "phase"):
                    phase_forwarded = True
    assert phase_forwarded, "CLI must forward args.phase into the executor event"


def test_cli_calls_lambda_handler():
    tree = ast.parse(_CLI_SRC)
    assert any(
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute) and node.func.attr == "lambda_handler"
        for node in ast.walk(tree)
    ), "CLI must delegate to remediation_executor.lambda_handler"
