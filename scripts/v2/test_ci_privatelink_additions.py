"""Additive dev configuration must preserve existing private datasource connections."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile

import pytest

SCRIPT = Path(__file__).with_name("ci_privatelink_additions.py")
BASE = {
    "existing": {
        "kind": "clickhouse",
        "service_name": "com.amazonaws.vpce.ap-northeast-2.vpce-svc-0123456789abcdef0",
        "ports": [8123],
        "publish_dns": True,
    },
}
NEW = {
    "extra": {
        "kind": "clickhouse",
        "service_name": "com.amazonaws.vpce.ap-northeast-2.vpce-svc-0123456789abcdef1",
        "ports": [8123],
        "publish_dns": False,
    },
}


def module():
    assert SCRIPT.exists(), "A bounded additive configuration helper is required"
    spec = importlib.util.spec_from_file_location("privatelink_additions", SCRIPT)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def test_merge_keeps_existing_endpoint_and_dns_and_does_not_mutate_inputs():
    existing, additions = copy.deepcopy(BASE), copy.deepcopy(NEW)
    merged = module().merge_additions(existing, additions, "ap-northeast-2")
    assert merged == {**BASE, **NEW}
    assert existing == BASE and additions == NEW


def test_existing_names_cannot_be_replaced_even_with_identical_values():
    with pytest.raises(ValueError):
        module().merge_additions(BASE, BASE, "ap-northeast-2")


@pytest.mark.parametrize("field,value", [
    ("kind", "custom_mcp"), ("kind", []), ("ports", [0]), ("ports", [True]),
    ("ports", [8123, 8123]), ("ports", [1.5]), ("publish_dns", "false"),
    ("service_name", "com.amazonaws.vpce.us-east-1.vpce-svc-0123456789abcdef1"),
    ("endpoint", "https://PRIVATE-SENTINEL.example"),
])
def test_rejects_unreviewed_kinds_invalid_ports_regions_and_extra_fields(field, value):
    addition = copy.deepcopy(NEW)
    addition["extra"][field] = value
    with pytest.raises(ValueError):
        module().merge_additions(BASE, addition, "ap-northeast-2")


def test_new_entries_require_an_explicit_dns_choice():
    addition = copy.deepcopy(NEW)
    del addition["extra"]["publish_dns"]
    with pytest.raises(ValueError):
        module().merge_additions(BASE, addition, "ap-northeast-2")


def run_cli(directory, additions, *, target="dev", scope="full", stdin=None):
    assert SCRIPT.exists()
    return subprocess.run(
        [sys.executable, str(SCRIPT)], cwd=directory, text=True, capture_output=True,
        input=json.dumps(json.dumps(BASE)) if stdin is None else stdin,
        env={**os.environ, "TARGET": target, "PLAN_SCOPE": scope, "AWS_REGION": "ap-northeast-2",
             "CI_PRIVATELINK_ADDITIONS_DEV": additions},
    )


def test_cli_creates_private_override_without_rewriting_protected_tfvars():
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        protected = root / "terraform.tfvars"
        protected.write_text('# PRIVATE-SENTINEL\nproject = "existing"\n')
        before = protected.read_bytes()
        result = run_cli(root, json.dumps(NEW))
        assert result.returncode == 0, result.stderr
        output = root / "ci-privatelink.auto.tfvars.json"
        assert json.loads(output.read_text()) == {"privatelink_endpoints": {**BASE, **NEW}}
        assert stat.S_IMODE(output.stat().st_mode) == 0o600
        assert protected.read_bytes() == before
        assert "PRIVATE-SENTINEL" not in result.stdout + result.stderr


@pytest.mark.parametrize("target,scope,value", [
    ("main", "full", json.dumps(NEW)),
    ("dev", "ecr-bootstrap", json.dumps(NEW)),
    ("dev", "full", '{"extra": "PRIVATE-SENTINEL"}'),
])
def test_invalid_configuration_removes_stale_override_and_prints_no_input(target, scope, value):
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        output = root / "ci-privatelink.auto.tfvars.json"
        output.write_text('{"stale":true}')
        result = run_cli(root, value, target=target, scope=scope)
        assert result.returncode != 0
        assert not output.exists()
        assert "PRIVATE-SENTINEL" not in result.stdout + result.stderr


def test_empty_opt_in_is_noop_and_duplicate_json_keys_are_rejected():
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        output = root / "ci-privatelink.auto.tfvars.json"
        output.write_text('{"stale":true}')
        result = run_cli(root, "", target="main")
        assert result.returncode == 0
        assert not output.exists()
        encoded = json.dumps(NEW["extra"])
        result = run_cli(root, '{"extra":' + encoded + ',"extra":' + encoded + '}')
        assert result.returncode != 0
        assert not output.exists()


def test_workflow_clears_old_override_before_base_evaluation_and_gates_additions():
    import yaml
    root = SCRIPT.parents[2]
    workflow = yaml.safe_load((root / ".github/workflows/terraform.yml").read_text())
    steps = workflow["jobs"]["plan"]["steps"]
    reset = next(i for i, s in enumerate(steps) if s.get("name") == "Remove stale additive PrivateLink configuration")
    init = next(i for i, s in enumerate(steps) if s.get("name") == "terraform init")
    merge = next(i for i, s in enumerate(steps) if s.get("name") == "Configure additive development PrivateLink endpoints")
    assert reset < init < merge
    assert "git ls-files -- ci-privatelink.auto.tfvars.json" in steps[reset]["run"]
    value = steps[merge]["env"]["CI_PRIVATELINK_ADDITIONS_DEV"]
    assert "env.TARGET == 'dev'" in value and "'full'" in value
    assert "secrets.CI_PRIVATELINK_ADDITIONS_DEV" in value
    assert "jsonencode(var.privatelink_endpoints)" in steps[merge]["run"]
    cleanup = next(s for s in steps if s.get("name") == "Clean sensitive files off the runner")
    assert cleanup["if"] == "always()"
    assert "ci-privatelink.auto.tfvars.json" in cleanup["run"]
