"""Offline permission-boundary tests; no AWS credentials or API calls."""
import base64
import fnmatch
import importlib
import json
import os
from pathlib import Path
import subprocess

import pytest


ACCOUNT = "123456789012"
REGION = "ap-northeast-2"
PROJECT = "fixture-dev"
ARN = f"arn:aws:ecs:{REGION}:{ACCOUNT}:"
CLUSTER = ARN + f"cluster/{PROJECT}"
SERVICE = ARN + f"service/{PROJECT}/{PROJECT}-web"
TASK = ARN + f"task/{PROJECT}/" + "a" * 32
FUNCTION = f"arn:aws:lambda:{REGION}:{ACCOUNT}:function:{PROJECT}-inv-sync"
ECR = f"arn:aws:ecr:{REGION}:{ACCOUNT}:repository/{PROJECT}-web"
BUCKET = "arn:aws:s3:::fixture-state"
STATE = BUCKET + "/dev/terraform.tfstate"
BACKEND = 'bucket = "fixture-state"\nkey = "dev/terraform.tfstate"\nregion = "ap-northeast-2"\nencrypt = true\nuse_lockfile = true\n'
ENV = {
    "GITHUB_REPOSITORY": "aws-samples/sample-awsops",
    "GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_REF": "refs/heads/dev",
    "GITHUB_WORKFLOW_REF": "aws-samples/sample-awsops/.github/workflows/collect-runtime.yml@refs/heads/dev",
    "GITHUB_SHA": "a" * 40, "TARGET": "dev", "AWS_REGION": REGION,
    "AWS_ACCOUNT_ID_DEV": ACCOUNT, "CI_ROLE_ARN": f"arn:aws:iam::{ACCOUNT}:role/fixture-ci",
    "RUNTIME_MODE": "collect", "PIN_SHA": "b" * 40,
    "BACKEND_B64": base64.b64encode(BACKEND.encode()).decode(),
}


def helpers():
    return importlib.import_module("ci_verifier_sessions")


def deployment():
    return {
        "schema_version": 1, "account_id": ACCOUNT, "region": REGION, "project": PROJECT,
        "features": {"inventory": True, "agentcore": True, "workers": True},
        "web": {"cluster": PROJECT, "service": PROJECT + "-web",
                "task_role_arn": f"arn:aws:iam::{ACCOUNT}:role/{PROJECT}-task"},
        "inventory": {"sync_function_name": PROJECT + "-inv-sync", "sync_function_arn": FUNCTION,
                      "sync_code_sha256": base64.b64encode(b"x" * 32).decode()},
        "known": {"cloudfront_distribution_id": "E123456789ABC"},
    }


def permitted(policy, action, resource, context):
    """Evaluate the allow/condition forms emitted by this bounded policy builder."""
    for statement in policy["Statement"]:
        actions = statement["Action"]
        resources = statement["Resource"]
        if not isinstance(actions, list):
            actions = [actions]
        if not isinstance(resources, list):
            resources = [resources]
        if statement["Effect"] != "Allow" or not any(fnmatch.fnmatchcase(action, a) for a in actions):
            continue
        if not any(fnmatch.fnmatchcase(resource, r) for r in resources):
            continue
        matches = True
        for operator, conditions in statement.get("Condition", {}).items():
            assert operator in ("StringEquals", "ArnEquals")
            for key, values in conditions.items():
                values = values if isinstance(values, list) else [values]
                if context.get(key) not in values:
                    matches = False
        if matches:
            return True
    return False


def test_backend_reads_only_the_bound_key_and_workspace_listing_prefix():
    policy = helpers().backend_policy(ENV)
    owner = {"aws:ResourceAccount": ACCOUNT}
    assert permitted(policy, "s3:GetObject", STATE, owner)
    assert not permitted(policy, "s3:GetObject", STATE + ".backup", owner)
    assert not permitted(policy, "s3:GetObject", BUCKET + "/other/terraform.tfstate", owner)
    assert not permitted(policy, "s3:GetObject", STATE, {"aws:ResourceAccount": "999999999999"})
    assert permitted(policy, "s3:GetBucketLocation", BUCKET, owner)
    assert permitted(policy, "s3:ListBucket", BUCKET, {**owner, "s3:prefix": "env:/"})
    assert not permitted(policy, "s3:ListBucket", BUCKET, {**owner, "s3:prefix": ""})
    assert not permitted(policy, "s3:ListBucket", BUCKET, {**owner, "s3:prefix": "other/"})
    for action in ("s3:PutObject", "s3:DeleteObject", "s3:GetObjectVersion"):
        assert not permitted(policy, action, STATE, owner)
    assert not permitted(policy, "s3:GetObject", STATE + ".tflock", owner)


def test_backend_custom_workspace_prefix_is_literal_and_never_grants_workspace_objects():
    env = {**ENV, "BACKEND_B64": base64.b64encode(
        (BACKEND + 'workspace_key_prefix = "workspaces/team"\n').encode()).decode()}
    policy = helpers().backend_policy(env)
    owner = {"aws:ResourceAccount": ACCOUNT}
    assert permitted(policy, "s3:ListBucket", BUCKET, {**owner, "s3:prefix": "workspaces/team/"})
    assert not permitted(policy, "s3:ListBucket", BUCKET, {**owner, "s3:prefix": "env:/"})
    assert not permitted(policy, "s3:GetObject", BUCKET + "/workspaces/team/other/dev/terraform.tfstate", owner)


@pytest.mark.parametrize("explicit_key", [False, True])
def test_backend_kms_requires_the_own_s3_service_and_bound_encryption_context(explicit_key):
    key = f"arn:aws:kms:{REGION}:{ACCOUNT}:key/11111111-1111-1111-1111-111111111111"
    backend = BACKEND + (f'kms_key_id = "{key}"\n' if explicit_key else "")
    policy = helpers().backend_policy({**ENV, "BACKEND_B64": base64.b64encode(backend.encode()).decode()})
    context = {"aws:ResourceAccount": ACCOUNT, "aws:RequestedRegion": REGION,
               "kms:ViaService": f"s3.{REGION}.amazonaws.com",
               "kms:EncryptionContext:aws:s3:arn": STATE}
    assert permitted(policy, "kms:Decrypt", key, context)
    assert permitted(policy, "kms:Decrypt", key, {**context, "kms:EncryptionContext:aws:s3:arn": BUCKET})
    for change in ({"kms:ViaService": None}, {"kms:ViaService": f"secretsmanager.{REGION}.amazonaws.com"},
                   {"aws:ResourceAccount": "999999999999"},
                   {"aws:RequestedRegion": "us-east-1"},
                   {"kms:EncryptionContext:aws:s3:arn": "arn:aws:s3:::other/key"}):
        assert not permitted(policy, "kms:Decrypt", key, {**context, **change})
    assert not permitted(policy, "kms:Encrypt", key, context)
    if explicit_key:
        assert not permitted(policy, "kms:Decrypt", key[:-1] + "2", context)


@pytest.mark.parametrize("backend", [
    BACKEND + 'endpoint = "https://other.example.test"\n',
    BACKEND + 'role_arn = "arn:aws:iam::123456789012:role/other"\n',
    BACKEND + 'key = "other"\n',
    BACKEND.replace("dev/terraform.tfstate", "*"),
    BACKEND.replace("dev/terraform.tfstate", "${other}"),
    BACKEND.replace('encrypt = true', 'encrypt = false'),
    BACKEND.replace(REGION, "us-east-1"),
    BACKEND + 'workspace_key_prefix = ""\n',
    BACKEND + 'workspace_key_prefix = "team/*"\n',
    BACKEND + 'kms_key_id = "arn:aws:kms:us-east-1:999999999999:key/11111111-1111-1111-1111-111111111111"\n',
])
def test_invalid_backend_cannot_create_a_session_policy(backend):
    with pytest.raises(ValueError):
        helpers().backend_policy({**ENV, "BACKEND_B64": base64.b64encode(backend.encode()).decode()})


@pytest.mark.parametrize("key,value", [
    ("GITHUB_REPOSITORY", "other/repo"), ("GITHUB_EVENT_NAME", "pull_request"),
    ("GITHUB_REF", "refs/heads/main"), ("TARGET", "main"), ("AWS_REGION", "us-east-1"),
    ("AWS_ACCOUNT_ID_DEV", ""), ("AWS_ACCOUNT_ID_DEV", "１" * 12),
    ("CI_ROLE_ARN", f"arn:aws:iam::999999999999:role/fixture-ci"),
    ("GITHUB_WORKFLOW_REF", "aws-samples/sample-awsops/.github/workflows/deploy-web.yml@refs/heads/dev"),
    ("RUNTIME_MODE", "deploy"), ("GITHUB_SHA", ""), ("PIN_SHA", "latest"), ("TF_WORKSPACE", "other"),
])
def test_wrong_dispatch_context_cannot_create_any_policy(key, value):
    env = {**ENV, key: value}
    for build in (lambda: helpers().backend_policy(env),
                  lambda: helpers().workload_policy(env, deployment())):
        with pytest.raises(ValueError):
            build()


def test_workload_permissions_are_limited_to_web_inspection_and_own_collector():
    policy = helpers().workload_policy(ENV, deployment())
    region = {"aws:RequestedRegion": REGION}
    cluster = {**region, "ecs:cluster": CLUSTER}
    for action, resource, context in (
        ("ecr:BatchGetImage", ECR, region), ("ecs:DescribeServices", SERVICE, cluster),
        ("ecs:DescribeTasks", TASK, cluster), ("ecs:ListTasks", "*", cluster),
        ("ecs:DescribeTaskDefinition", "*", region),
        ("lambda:GetFunctionConfiguration", FUNCTION, region), ("lambda:InvokeFunction", FUNCTION, region),
    ):
        assert permitted(policy, action, resource, context), action
        assert not permitted(policy, action, resource, {**context, "aws:RequestedRegion": "us-east-1"})
    assert not permitted(policy, "ecr:BatchGetImage", ECR.replace("-web", "-worker"), region)
    assert not permitted(policy, "ecs:DescribeServices", SERVICE.replace("-web", "-steampipe"), cluster)
    assert not permitted(policy, "ecs:DescribeTasks", TASK.replace(f"task/{PROJECT}/", "task/other/"), cluster)
    assert not permitted(policy, "ecs:ListTasks", "*", region)
    assert not permitted(policy, "ecs:ListTasks", "*", {**cluster, "ecs:cluster": CLUSTER + "-other"})
    assert not permitted(policy, "lambda:InvokeFunction", FUNCTION + "-other", region)
    for action in ("ecs:RunTask", "ecs:UpdateService", "ecs:StopTask", "ecr:GetAuthorizationToken",
                   "ecr:PutImage", "lambda:UpdateFunctionCode", "iam:PassRole", "ssm:GetParameter",
                   "secretsmanager:GetSecretValue", "bedrock:InvokeModel", "sqs:SendMessage",
                   "states:StartExecution", "s3:GetObject", "kms:Decrypt"):
        assert not any(permitted(policy, action, resource, {**cluster, "aws:ResourceAccount": ACCOUNT})
                       for resource in ("*", ECR, SERVICE, TASK, FUNCTION, STATE))


def test_prepare_does_not_grant_collector_access_or_require_activated_features():
    value = deployment()
    value["features"] = {k: False for k in value["features"]}
    value["inventory"] = {}
    policy = helpers().workload_policy({**ENV, "RUNTIME_MODE": "prepare", "PIN_SHA": ""}, value)
    region = {"aws:RequestedRegion": REGION}
    assert permitted(policy, "ecr:BatchGetImage", ECR, region)
    for action in ("lambda:GetFunctionConfiguration", "lambda:InvokeFunction"):
        assert not permitted(policy, action, FUNCTION, region)


@pytest.mark.parametrize("path,value", [
    (("account_id",), "999999999999"), (("region",), "us-east-1"), (("schema_version",), 2),
    (("schema_version",), True),
    (("project",), "other*"), (("web", "cluster"), "other"),
    (("web", "service"), "other-web"), (("web", "task_role_arn"), "arn:aws:iam::123456789012:role/other"),
    (("features", "inventory"), False), (("features", "agentcore"), "true"),
    (("inventory", "sync_function_arn"), FUNCTION + "-other"),
    (("inventory", "sync_function_name"), "other"), (("inventory", "sync_code_sha256"), "bad"),
    (("known", "cloudfront_distribution_id"), "../other"),
])
def test_workload_policy_rejects_unbound_or_incomplete_state(path, value):
    data = deployment()
    target = data
    for part in path[:-1]:
        target = target[part]
    target[path[-1]] = value
    with pytest.raises(ValueError):
        helpers().workload_policy(ENV, data)


def test_policies_fit_sts_inline_limit_even_for_maximum_supported_names():
    data = deployment()
    longest = "p" * 40
    data = json.loads(json.dumps(data).replace(PROJECT, longest))
    policies = [helpers().backend_policy(ENV), helpers().workload_policy(ENV, data)]
    for policy in policies:
        assert len(json.dumps(policy, separators=(",", ":"))) <= 2048
        assert all(s["Effect"] == "Allow" and s.get("Condition") for s in policy["Statement"])


def test_cli_masks_and_publishes_a_nonempty_restriction_and_fails_closed(tmp_path):
    tmp_path.chmod(0o700)
    output = tmp_path / "github-output"
    source = Path(__file__).with_name("ci_verifier_sessions.py")
    env = {k: v for k, v in os.environ.items() if not k.startswith(("AWS_", "GITHUB_", "TF_"))}
    env.update(ENV, GITHUB_ACTIONS="true", GITHUB_OUTPUT=str(output), PYTHONDONTWRITEBYTECODE="1",
               AWS_EC2_METADATA_DISABLED="true", AWS_CONFIG_FILE="/dev/null",
               AWS_SHARED_CREDENTIALS_FILE="/dev/null")
    cmd = ["python3", str(source), "backend", "--directory", str(tmp_path)]
    result = subprocess.run(cmd, env=env, text=True, capture_output=True)
    assert result.returncode == 0
    assert result.stderr == ""
    published = dict(line.split("=", 1) for line in output.read_text().splitlines())
    expected = helpers().backend_policy(ENV)
    assert json.loads(published["session_policy"]) == expected
    assert result.stdout.splitlines()[0] == "::add-mask::" + published["session_policy"]
    assert all(line.startswith("::add-mask::") for line in result.stdout.splitlines())
    path = Path(published["policy_file"])
    assert path.parent == tmp_path and path.stat().st_mode & 0o777 == 0o600
    assert json.loads(path.read_text()) == expected
    failed = subprocess.run(cmd, env=env, text=True, capture_output=True)
    assert failed.returncode != 0  # Never reuse/overwrite a policy file.
    assert failed.stdout == "" and failed.stderr.strip() == "verifier_session_policy_unavailable"


def test_cli_refuses_public_or_linked_runtime_state_without_echoing_it(tmp_path):
    tmp_path.chmod(0o700)
    source = Path(__file__).with_name("ci_verifier_sessions.py")
    state = tmp_path / "runtime.json"
    state.write_text(json.dumps({**deployment(), "private": "DO_NOT_PRINT"}))
    state.chmod(0o644)
    env = {**ENV, "PATH": os.environ["PATH"], "GITHUB_ACTIONS": "true", "GITHUB_OUTPUT": str(tmp_path / "output"),
           "PYTHONDONTWRITEBYTECODE": "1", "AWS_EC2_METADATA_DISABLED": "true",
           "AWS_CONFIG_FILE": "/dev/null", "AWS_SHARED_CREDENTIALS_FILE": "/dev/null"}
    for candidate in (state, tmp_path / "link.json"):
        if candidate != state:
            state.chmod(0o600)
            candidate.symlink_to(state)
        result = subprocess.run(["python3", str(source), "workload", "--directory", str(tmp_path),
                                 "--deployment-file", str(candidate)], env=env, text=True, capture_output=True)
        assert result.returncode != 0
        assert result.stdout == ""
        assert result.stderr.strip() == "verifier_session_policy_unavailable"
        assert not (tmp_path / "output").exists()


def test_cli_does_not_emit_a_policy_outside_actions_or_without_output_publication(tmp_path):
    tmp_path.chmod(0o700)
    source = Path(__file__).with_name("ci_verifier_sessions.py")
    for extra in ({"GITHUB_OUTPUT": str(tmp_path / "output")}, {"GITHUB_ACTIONS": "true"}):
        env = {**ENV, "PATH": os.environ["PATH"], "PYTHONDONTWRITEBYTECODE": "1", **extra}
        result = subprocess.run(["python3", str(source), "backend", "--directory", str(tmp_path)],
                                env=env, text=True, capture_output=True)
        assert result.returncode != 0
        assert result.stdout == ""
        assert result.stderr.strip() == "verifier_session_policy_unavailable"
        assert not list(tmp_path.iterdir())
