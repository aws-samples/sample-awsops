"""Private plan workflow contracts; no AWS or GitHub calls."""
import base64
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]


def workflow():
    return yaml.safe_load((ROOT / ".github/workflows/terraform.yml").read_text())


def named(job, name):
    return next(step for step in job["steps"] if step.get("name") == name)


def test_only_manual_plans_create_attempt_specific_encrypted_handoff():
    plan = workflow()["jobs"]["plan"]
    validation = named(plan, "Validate saved-plan Lambda assets")
    assert "ci_tf_assets.py pack" in validation["run"]
    assert "github.event_name" not in validation["if"]
    assert validation.get("continue-on-error") is not True
    for name in ("Encrypt plan artifact", "Upload plan artifact (encrypted)"):
        assert "github.event_name == 'workflow_dispatch'" in named(plan, name)["if"]
    upload = named(plan, "Upload plan artifact (encrypted)")
    assert upload["with"]["name"] == "tfplan-${{ github.run_attempt }}"
    assert upload["with"]["retention-days"] == 1
    assert set(upload["with"]["path"].split()) == {
        "terraform/foundation/tfplan.enc", "terraform/foundation/tfassets.enc"}


def test_private_publication_is_required_and_uses_a_scoped_protected_session():
    publish = workflow()["jobs"]["publish"]
    assert publish["name"] == "Publish private plan"
    assert publish["needs"] == ["plan"]
    assert "github.event_name == 'workflow_dispatch'" in publish["if"]
    assert "inputs.mode == 'plan'" in publish["if"]
    assert publish["environment"] == "${{ github.ref_name == 'main' && 'production' || 'development' }}"
    credentials = next(step for step in publish["steps"]
                       if step.get("uses", "").startswith("aws-actions/configure-aws-credentials"))
    assert credentials["with"]["inline-session-policy"] == "${{ steps.policy.outputs.session_policy }}"
    assert credentials["with"]["unset-current-credentials"] is True
    operation = named(publish, "Publish authenticated private plan")
    assert "ci_private_plan.py publish" in operation["run"]
    assert operation.get("continue-on-error") is not True
    assert "TF_PLAN_ENC_KEY" in operation["env"]
    assert "terraform apply" not in str(publish)


def test_unconfigured_stack_skips_publication_without_failing_manual_plan():
    config = workflow()["jobs"]
    assert config["plan"]["outputs"]["skip"] == "${{ steps.restore.outputs.skip }}"
    gate = config["publish"]["if"]
    assert "needs.plan.result == 'success'" in gate
    assert "needs.plan.outputs.skip != '1'" in gate


def test_apply_finalizer_removes_only_current_run_private_scratch(tmp_path):
    foundation = tmp_path / "terraform/foundation"
    foundation.mkdir(parents=True)
    owned = foundation.parent / ".private-plan-123-2-fixture"
    other = foundation.parent / ".private-plan-999-1-fixture"
    owned.mkdir()
    other.mkdir()
    (owned / "tfplan").write_text("private fixture")
    (other / "tfplan").write_text("other operation")
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    step = named(workflow()["jobs"]["apply"], "Clean sensitive files off the runner")
    assert step["if"] == "always()"
    result = subprocess.run(["bash", "-c", step["run"]], cwd=foundation,
                            env={**os.environ, "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "2",
                                 "PRIVATE_PLAN_DIR": ""}, text=True, capture_output=True)
    assert result.returncode == 0, result.stderr
    assert not owned.exists()
    assert (other / "tfplan").read_text() == "other operation"


@pytest.mark.parametrize("case", ["expired", "recent", "broad_prefix", "state_key", "unversioned", "truncated"])
def test_documented_purge_preparation_rejects_unsafe_deletions(tmp_path, case):
    document = (ROOT / "docs/runbooks/dev-repo-setup.md").read_text()
    code = document.split('python3 - "$PLAN_PREFIX" "$PURGE_DIR" <<\'PY\'\n', 1)[1].split("\nPY", 1)[0]
    prefix = "ci/tfplans/aws-samples/sample-awsops/dev/" + "a" * 40 + "/123/1/"
    row = {"Key": prefix + "plan-" + "b" * 64 + ".bin", "VersionId": "fixture-version",
           "LastModified": "2020-01-01T00:00:00Z"}
    data = {"Versions": [row]}
    if case == "recent":
        row["LastModified"] = "2999-01-01T00:00:00Z"
    elif case == "broad_prefix":
        prefix = "ci/tfplans/"
    elif case == "state_key":
        row["Key"] = "state/terraform.tfstate"
    elif case == "unversioned":
        row["VersionId"] = "null"
    elif case == "truncated":
        data["NextToken"] = "more"
    (tmp_path / "versions.json").write_text(json.dumps(data))
    result = subprocess.run([sys.executable, "-c", code, prefix, str(tmp_path)],
                            text=True, capture_output=True)
    assert (result.returncode == 0) is (case == "expired")
    assert (tmp_path / "delete.json").exists() is (case == "expired")


@pytest.mark.parametrize("target,missing,expected", [
    ("main", None, ("PRIVATE_MAIN_ROLE", "PRIVATE_MAIN_BACKEND")),
    ("dev", None, ("PRIVATE_DEV_ROLE", "PRIVATE_DEV_BACKEND")),
    ("atomoh", None, ("PRIVATE_DEV_ROLE", "PRIVATE_USER_BACKEND")),
    ("main", "MAIN_ROLE", None),
    ("atomoh", "USER_BACKEND_B64", None),
    ("other", None, None),
])
def test_publisher_stack_selection_has_no_cross_stack_fallback(tmp_path, target, missing, expected):
    binary = tmp_path / "python3"
    binary.write_text(f"#!{sys.executable}\n" + """
import json, os, pathlib, sys
args = sys.argv[1:]
with open(os.environ["COMMAND_LOG"], "w") as output:
    json.dump([args[args.index("--role-arn")+1],
        pathlib.Path(args[args.index("--backend")+1]).read_text()], output)
print('{"status":"policy_ready"}')
""")
    binary.chmod(0o700)
    env = {**os.environ, "PATH": str(tmp_path) + os.pathsep + os.environ["PATH"],
           "RUNNER_TEMP": str(tmp_path), "GITHUB_ENV": str(tmp_path / "environment"),
           "GITHUB_OUTPUT": str(tmp_path / "outputs"), "COMMAND_LOG": str(tmp_path / "commands"),
           "TARGET": target, "PLAN_SCOPE": "full", "GITHUB_REPOSITORY": "fixture/repo",
           "GITHUB_SHA": "a" * 40, "GITHUB_RUN_ID": "123",
           "MAIN_ROLE": "PRIVATE_MAIN_ROLE", "DEV_ROLE": "PRIVATE_DEV_ROLE"}
    for kind in ("MAIN", "DEV", "USER"):
        env[f"{kind}_BACKEND_B64"] = base64.b64encode(f"PRIVATE_{kind}_BACKEND".encode()).decode()
    if missing:
        env[missing] = ""
    step = named(workflow()["jobs"]["publish"], "Select private publication scope")
    result = subprocess.run(["/bin/bash", "--noprofile", "--norc", "-c", step["run"]],
                            cwd=tmp_path, env=env, text=True, capture_output=True)
    assert "PRIVATE" not in result.stdout + result.stderr
    if expected:
        assert result.returncode == 0
        assert json.loads((tmp_path / "commands").read_text()) == list(expected)
    else:
        assert result.returncode != 0
        assert not (tmp_path / "commands").exists()


def test_public_artifact_is_replaced_only_after_private_publication():
    publish = workflow()["jobs"]["publish"]
    upload = named(publish, "Replace encrypted handoff with safe reference")
    operation = named(publish, "Publish authenticated private plan")
    assert publish["steps"].index(upload) > publish["steps"].index(operation)
    assert upload["uses"].startswith("actions/upload-artifact@v4")
    assert upload["with"]["name"] == "tfplan-${{ github.run_attempt }}"
    assert upload["with"]["overwrite"] is True
    assert upload["with"]["path"] == "${{ steps.publish.outputs.reference_file }}"
    assert upload["with"]["retention-days"] == 5
    assert upload["with"]["if-no-files-found"] == "error"
    assert named(publish, "Remove private publication scratch")["if"] == "always()"


@pytest.mark.parametrize("variant", [
    "valid", "wrong_status", "wrong_store", "wrong_policy", "invalid_result", "invalid_policy",
])
def test_policy_adapter_masks_before_outputs_and_refuses_invalid_results(variant):
    root = "/private-fixture"
    result = {"status": "policy_ready", "store_file": root + "/policy/store.json",
              "session_policy_file": root + "/policy/session-policy.json"}
    if variant == "wrong_status":
        result["status"] = "failed"
    if variant == "wrong_store":
        result["store_file"] = "/another/store.json"
    if variant == "wrong_policy":
        result["session_policy_file"] = "/another/policy.json"
    policy = json.dumps({"Version": "2012-10-17", "Statement": [{
        "Effect": "Allow", "Action": "s3:GetObject",
        "Resource": "arn:aws:s3:::fixture-private-bucket/ci/tfplans/*",
        "Condition": {"StringEquals": {"aws:ResourceAccount": "123456789012"}},
    }]})
    files = {root + "/policy-result.json": "{bad" if variant == "invalid_result" else json.dumps(result),
             root + "/policy/session-policy.json": "{bad" if variant == "invalid_policy" else policy}
    script = named(workflow()["jobs"]["publish"],
                   "Mask and publish the storage session restriction")["with"]["script"]
    harness = """
const data = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const events = [];
const core = {setSecret: x => events.push(['mask', x]),
  setOutput: (k,v) => events.push(['output', k, v]), setFailed: x => events.push(['failed', x])};
const readFileSync = name => {if (!(name in data.files)) throw Error(); return data.files[name];};
new Function('require','core','process',data.script)(
  name => {if(name !== 'fs') throw Error(); return {readFileSync};},
  core, {env: {PRIVATE_PLAN_DIR: data.root}});
process.stdout.write(JSON.stringify(events));
"""
    run = subprocess.run(["node", "-e", harness], input=json.dumps({
        "root": root, "files": files, "script": script,
    }), text=True, capture_output=True, check=True)
    events = json.loads(run.stdout)
    outputs = [event for event in events if event[0] == "output"]
    if variant != "valid":
        assert not outputs
        assert [event[0] for event in events] == ["failed"]
    else:
        assert [event[1] for event in outputs] == ["session_policy", "store_file"]
        masks = [event[1] for event in events[:events.index(outputs[0])] if event[0] == "mask"]
        assert policy in masks
        assert "fixture-private-bucket" in masks
        assert "123456789012" in masks


@pytest.mark.parametrize("policy,valid", [("", False), (" \n\t", False), ("{}", True),
                                         ('{"Version":"2012-10-17","Statement":[]}', True)])
def test_missing_session_restriction_cannot_reach_credentials(policy, valid):
    step = named(workflow()["jobs"]["publish"], "Require the private storage session restriction")
    run = subprocess.run(["/bin/bash", "--noprofile", "--norc", "-c", step["run"]],
                         env={**os.environ, "SESSION_POLICY": policy}, text=True, capture_output=True)
    assert (run.returncode == 0) is valid


def test_exact_apply_requires_reviewed_hash_and_preserves_existing_gates():
    config = workflow()
    inputs = config[True]["workflow_dispatch"]["inputs"]
    assert len(inputs) <= 10
    assert "reviewed_plan_sha256" in inputs
    job = config["jobs"]["apply"]
    guard = named(job, "Verify the saved plan belongs to this deployed commit and branch")
    assert "REVIEWED_PLAN_SHA256" in guard["env"]
    assert "^[a-f0-9]{64}$" in guard["run"]
    restore = named(job, "Restore privately reviewed plan and assets")
    assert "ci_private_plan.py restore" in restore["run"]
    assert '--reviewed-plan-sha256 "$REVIEWED_PLAN_SHA256"' in restore["run"]
    assert restore["env"]["TF_PLAN_ENC_KEY"] == "${{ secrets.TF_PLAN_ENC_KEY }}"
    assert not any(step.get("name") in {"Download the approved plan", "Decrypt the approved plan"}
                   for step in job["steps"])
    apply = named(job, "terraform apply (exact saved plan — never re-planned)")
    assert "terraform apply -input=false tfplan" in apply["run"]
    assert job["steps"].index(restore) < job["steps"].index(
        named(job, "Recheck branch immediately before apply")) < job["steps"].index(apply)
