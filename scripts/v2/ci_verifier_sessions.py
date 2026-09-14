"""Temporary permissions for manual development verification; no AWS calls."""
import argparse
import base64
import json
import os
from pathlib import Path
import re
import stat
import sys

from ci_runtime_policy import verify_role


REGION = "ap-northeast-2"
REPO = "aws-samples/sample-awsops"


def require(condition):
    if not condition:
        raise ValueError("invalid_verifier_scope")


def parse_backend_fields(encoded, account, workspace="default"):
    """Shared audit/verifier parser; reject endpoint, credential and role overrides."""
    require(workspace in ("", "default"))
    require(isinstance(account, str) and re.fullmatch(r"[0-9]{12}", account))
    require(isinstance(encoded, str) and 0 < len(encoded) <= 22000)
    text = base64.b64decode("".join(encoded.split()), validate=True).decode()
    require(len(text) <= 16384)
    fields = {}
    allowed = {"bucket", "key", "region", "encrypt", "use_lockfile", "workspace_key_prefix", "kms_key_id"}
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith(("#", "//")):
            continue
        match = re.fullmatch(r'\s*(\w+)\s*=\s*("(?:[^"\\]|\\.)*"|true|false)\s*(?:(?:#|//).*)?', line)
        require(match and match[1] in allowed and match[1] not in fields)
        fields[match[1]] = json.loads(match[2])
    bucket, key = fields.get("bucket", ""), fields.get("key", "")
    require(isinstance(bucket, str) and re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", bucket))
    require(isinstance(key, str) and re.fullmatch(r"[A-Za-z0-9._/-]{1,512}", key))
    require(fields.get("region") == REGION and fields.get("encrypt", True) is True)
    require(all(isinstance(v, (str, bool)) and "${" not in str(v) and "%{" not in str(v)
                for v in fields.values()))
    kms = fields.get("kms_key_id", "*")
    require(isinstance(kms, str) and (kms == "*" or re.fullmatch(
        re.escape(f"arn:aws:kms:{REGION}:{account}:key/") + r"[a-f0-9-]{36}", kms)))
    return fields


def context(env):
    account, mode = env.get("AWS_ACCOUNT_ID_DEV"), env.get("RUNTIME_MODE")
    require(env.get("GITHUB_REPOSITORY") == REPO
            and env.get("GITHUB_EVENT_NAME") == "workflow_dispatch"
            and env.get("GITHUB_REF") == "refs/heads/dev" and env.get("TARGET") == "dev"
            and env.get("GITHUB_WORKFLOW_REF") == f"{REPO}/.github/workflows/collect-runtime.yml@refs/heads/dev"
            and env.get("AWS_REGION") == REGION and env.get("TF_WORKSPACE", "default") in ("", "default"))
    require(isinstance(account, str) and re.fullmatch(r"[0-9]{12}", account))
    verify_role(account, env.get("CI_ROLE_ARN"))
    require(re.fullmatch(r"[a-f0-9]{40}", env.get("GITHUB_SHA", "")))
    require(mode in ("prepare", "collect"))
    require(re.fullmatch(r"[a-f0-9]{40}", env.get("PIN_SHA", "")) if mode == "collect"
            else env.get("PIN_SHA", "") == "")
    return account, mode


def allow(actions, resources, condition):
    return {"Effect": "Allow", "Action": actions, "Resource": resources, "Condition": condition}


def policy(statements):
    value = {"Version": "2012-10-17", "Statement": statements}
    require(len(json.dumps(value, separators=(",", ":"))) <= 2048)
    return value


def backend_policy(env):
    account, _ = context(env)
    fields = parse_backend_fields(env.get("BACKEND_B64"), account, env.get("TF_WORKSPACE", "default"))
    prefix = fields.get("workspace_key_prefix", "env:")
    # Empty means a whole-bucket workspace listing; do not silently broaden the session.
    require(isinstance(prefix, str) and re.fullmatch(r"[A-Za-z0-9._:/-]{1,512}", prefix))
    bucket = f"arn:aws:s3:::{fields['bucket']}"
    state_object = f"{bucket}/{fields['key']}"
    owner = {"StringEquals": {"aws:ResourceAccount": account}}
    return policy([
        allow(["sts:GetCallerIdentity"], "*", {"StringEquals": {"aws:RequestedRegion": REGION}}),
        allow(["s3:GetBucketLocation"], bucket, owner),
        allow(["s3:GetObject"], state_object, owner),
        # Terraform 1.15.7 lists workspace_key_prefix + "/" even for default workspace.
        allow(["s3:ListBucket"], bucket, {"StringEquals": {
            "aws:ResourceAccount": account, "s3:prefix": [fields["key"], prefix + "/"]}}),
        allow(["kms:Decrypt"], fields.get("kms_key_id", "*"), {"StringEquals": {
            "aws:ResourceAccount": account, "aws:RequestedRegion": REGION,
            "kms:ViaService": f"s3.{REGION}.amazonaws.com",
            "kms:EncryptionContext:aws:s3:arn": [bucket, state_object]}}),
    ])


def workload_policy(env, value):
    account, mode = context(env)
    require(isinstance(value, dict) and type(value.get("schema_version")) is int
            and value["schema_version"] == 1
            and value.get("account_id") == account and value.get("region") == REGION)
    project, web, features = value.get("project"), value.get("web"), value.get("features")
    require(isinstance(project, str) and re.fullmatch(r"[a-z][a-z0-9-]{1,39}", project))
    require(isinstance(web, dict) and web.get("cluster") == project
            and web.get("service") == f"{project}-web"
            and web.get("task_role_arn") == f"arn:aws:iam::{account}:role/{project}-task")
    require(isinstance(features, dict) and all(type(features.get(k)) is bool
            for k in ("inventory", "agentcore", "workers")))
    arn = lambda service, resource: f"arn:aws:{service}:{REGION}:{account}:{resource}"
    region = {"StringEquals": {"aws:RequestedRegion": REGION}}
    cluster = {"StringEquals": {"aws:RequestedRegion": REGION},
               "ArnEquals": {"ecs:cluster": arn("ecs", f"cluster/{project}")}}
    statements = [
        # DescribeTaskDefinition has no resource-level IAM support. The controller
        # validates its returned family; this single read remains region restricted.
        allow(["sts:GetCallerIdentity", "ecs:DescribeTaskDefinition"], "*", region),
        allow(["ecr:BatchGetImage"], arn("ecr", f"repository/{project}-web"), region),
        allow(["ecs:DescribeServices"], arn("ecs", f"service/{project}/{project}-web"), region),
        allow(["ecs:DescribeTasks"], arn("ecs", f"task/{project}/*"), cluster),
        # ListTasks without containerInstance uses Resource:* plus the cluster condition.
        allow(["ecs:ListTasks"], "*", cluster),
    ]
    if mode == "collect":
        inventory, known = value.get("inventory"), value.get("known")
        function = arn("lambda", f"function:{project}-inv-sync")
        require(all(features[k] for k in ("inventory", "agentcore", "workers")))
        require(isinstance(inventory, dict) and inventory.get("sync_function_name") == f"{project}-inv-sync"
                and inventory.get("sync_function_arn") == function)
        fingerprint = inventory.get("sync_code_sha256")
        require(isinstance(fingerprint, str) and re.fullmatch(r"[A-Za-z0-9+/]{43}=", fingerprint)
                and base64.b64encode(base64.b64decode(fingerprint, validate=True)).decode() == fingerprint)
        require(isinstance(known, dict) and isinstance(known.get("cloudfront_distribution_id"), str)
                and re.fullmatch(r"[A-Z0-9]{5,32}", known["cloudfront_distribution_id"]))
        statements.append(allow(["lambda:GetFunctionConfiguration", "lambda:InvokeFunction"], function, region))
    return policy(statements)


def private_directory(value):
    directory = Path(value)
    require(directory.is_absolute() and directory.resolve(strict=True) == directory)
    require(directory.is_dir() and directory.stat().st_mode & 0o777 == 0o700)
    return directory


def read_deployment(file):
    path = Path(file)
    require(path.is_absolute() and path.parent == private_directory(str(path.parent)))
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), "rb") as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_mode & 0o777 == 0o600 and info.st_size <= 16384)
        text = stream.read(16385)
    require(len(text) <= 16384)
    return json.loads(text)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("phase", choices=("backend", "workload"))
    parser.add_argument("--directory", required=True)
    parser.add_argument("--deployment-file")
    args = parser.parse_args()
    require(os.environ.get("GITHUB_ACTIONS") == "true" and os.environ.get("GITHUB_OUTPUT"))
    directory = private_directory(args.directory)
    value = backend_policy(os.environ) if args.phase == "backend" else workload_policy(
        os.environ, read_deployment(args.deployment_file))
    path = directory / f"{args.phase}-policy.json"
    text = json.dumps(value, separators=(",", ":"))
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as stream:
        stream.write(text)
    resources = set()
    for statement in value["Statement"]:
        items = statement["Resource"]
        resources.update(item for item in (items if isinstance(items, list) else [items])
                         if item.startswith("arn:"))
    # Standard Actions masking commands precede publishing the step output. No
    # policy/ARN text is emitted by the CLI outside the guarded Actions context.
    for masked in [text, *sorted(resources)]:
        escaped = masked.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
        print(f"::add-mask::{escaped}", flush=True)
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        output.write(f"policy_file={path}\n")
        output.write(f"session_policy={text}\n")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, TypeError, OSError):
        print("verifier_session_policy_unavailable", file=sys.stderr)
        sys.exit(1)
