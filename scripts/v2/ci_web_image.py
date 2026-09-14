#!/usr/bin/env python3
"""Bind web promotion to the current build or an authenticated build artifact."""
import argparse
from datetime import datetime
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit
import zipfile

REPOSITORY = "aws-samples/sample-awsops"
WORKFLOW = ".github/workflows/deploy-web.yml"
BRANCHES = {"main", "dev", "atomoh", "ssminji", "whchoi"}
SHA = re.compile(r"[a-f0-9]{40}")
DIGEST = re.compile(r"sha256:[a-f0-9]{64}")
NUMBER = re.compile(r"[1-9][0-9]{0,14}")
PROJECT = re.compile(r"[a-z][a-z0-9-]{1,39}")
BUILD_JOB = "Build & push (arm64)"
BUILD_STEPS = {"Build and push (arm64)", "Record the image producer",
               "Retain the build receipt for explicit reuse"}
ACCOUNT = re.compile(r"[0-9]{12}")
IMAGE_MEDIA = {
    "application/vnd.docker.distribution.manifest.v2+json": "application/vnd.docker.container.image.v1+json",
    "application/vnd.oci.image.manifest.v1+json": "application/vnd.oci.image.config.v1+json",
}
INDEX_MEDIA = {"application/vnd.oci.image.index.v1+json",
               "application/vnd.docker.distribution.manifest.list.v2+json"}
LAYER_MEDIA = {"application/vnd.docker.image.rootfs.diff.tar.gzip",
               "application/vnd.oci.image.layer.v1.tar",
               "application/vnd.oci.image.layer.v1.tar+gzip",
               "application/vnd.oci.image.layer.v1.tar+zstd"}
# Diagnostic labels only: command() also serves the consumer's ECS/STS calls.
AWS_OPERATION_LABELS = {
    ("sts", "get-caller-identity"): "sts:GetCallerIdentity",
    ("ecr", "batch-get-image"): "ecr:BatchGetImage",
    ("ecr", "get-download-url-for-layer"): "ecr:GetDownloadUrlForLayer",
    ("ecr", "put-image"): "ecr:PutImage",
    ("ecs", "update-service"): "ecs:UpdateService",
    ("ecs", "describe-services"): "ecs:DescribeServices",
    ("ecs", "list-tasks"): "ecs:ListTasks",
    ("ecs", "describe-tasks"): "ecs:DescribeTasks",
    ("ecs", "describe-task-definition"): "ecs:DescribeTaskDefinition",
}


class ImageError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise ImageError(message)


def matches(pattern, value):
    return isinstance(value, str) and pattern.fullmatch(value) is not None


def validate_context(c):
    require(c.get("repository") == REPOSITORY and c.get("branch") in BRANCHES
            and c.get("event") in {"push", "workflow_dispatch"}, "Invalid deployment context")
    for key, pattern in (("sha", SHA), ("run_id", NUMBER), ("attempt", NUMBER), ("project", PROJECT)):
        require(matches(pattern, c.get(key)), "Invalid deployment identity")
    require(matches(re.compile(r"[0-9]{12}"), c.get("account")), "Expected account is required")


def build_receipt(c, digest):
    validate_context(c)
    require(matches(DIGEST, digest), "Missing build digest")
    require(matches(NUMBER, c.get("job_id")), "Build job identity is required")
    return {"schema": 2, "repository": c["repository"], "workflow": WORKFLOW,
            "branch": c["branch"], "sha": c["sha"], "run_id": c["run_id"],
            "attempt": c["attempt"], "job_id": c["job_id"],
            "project": c["project"], "digest": digest}


def child_environment(tool, config_dir):
    # Runner-installed AWS CLI, gh and curl only, never caller-selected tools,
    # profiles, credential providers, CA bundles, proxies or command hooks.
    env = {key: os.environ[key] for key in ("TMPDIR", "LANG", "LC_ALL")
           if key in os.environ}
    env["PATH"] = "/usr/local/bin:/usr/bin:/bin"
    if tool == "aws":
        keys = ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN")
        require(all(os.environ.get(key) for key in keys), "Exported temporary AWS credentials are required")
        env.update({key: os.environ[key] for key in keys})
        env.update(AWS_CONFIG_FILE=os.devnull, AWS_SHARED_CREDENTIALS_FILE=os.devnull,
                   BOTO_CONFIG=os.devnull, AWS_EC2_METADATA_DISABLED="true",
                   AWS_IGNORE_CONFIGURED_ENDPOINT_URLS="true", AWS_MAX_ATTEMPTS="1", AWS_PAGER="")
    elif tool == "gh":
        token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
        require(token, "Explicit GitHub token is required")
        env.update(GH_TOKEN=token, GH_CONFIG_DIR=config_dir, GH_PROMPT_DISABLED="1",
                   GH_NO_UPDATE_NOTIFIER="1")
    return env


def command(args, *, binary=False, stdin_payload=None):
    # Never surface stderr, which can contain authentication or registry details.
    require(args and args[0] in {"aws", "gh", "curl"}, "Unsupported image provider")
    require(args[0] != "curl" or args[:2] == ["curl", "-q"], "Default curl configuration is forbidden")
    require(stdin_payload is None or (args[:4] == ["curl", "-q", "-K", "-"]
            and isinstance(stdin_payload, bytes)), "Only explicit curl configuration may use stdin")
    label = (AWS_OPERATION_LABELS.get(tuple(args[1:3]), "aws") if args[0] == "aws"
             else {"gh": "github:api", "curl": "curl:config-download"}[args[0]])
    try:
        with tempfile.TemporaryDirectory(prefix="web-image-config-") as config_dir:
            input_options = {"stdin": subprocess.DEVNULL} if stdin_payload is None else {"input": stdin_payload}
            result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    timeout=90, check=True, env=child_environment(args[0], config_dir),
                                    **input_options)
        require(len(result.stdout) <= 1024 * 1024, f"Oversized provider response [{label}]")
        return result.stdout if binary else json.loads(result.stdout)
    except (subprocess.SubprocessError, OSError, ValueError):
        raise ImageError(f"Image provenance provider request failed [{label}]") from None


def github(path, binary=False):
    args = ["gh", "api", "--hostname", "github.com", path]
    if not binary and path.startswith(f"repos/{REPOSITORY}/compare/"):
        # gh filters locally before stdout; do not cap the entire commits/files payload.
        args += ["--jq", "{status: .status, merge_base_commit: {sha: .merge_base_commit.sha}}"]
    return command(args, binary=binary)


def aws_request(operation, args):
    require(operation in {"batch-get-image", "get-download-url-for-layer", "put-image"},
            "Unsupported image operation")
    argv = ["aws", "ecr", operation, "--region", "ap-northeast-2", "--output", "json",
            "--no-cli-pager"]
    for key, value in args.items():
        argv += ["--" + key, value]
    return command(argv)


def validate_run(run, c, pin_sha, producer_run):
    require(isinstance(run, dict) and str(run.get("id")) == producer_run
            and run.get("status") == "completed"
            and run.get("event") in {"push", "workflow_dispatch"}
            and run.get("path") == WORKFLOW and run.get("head_sha") == pin_sha
            and run.get("head_branch") == c["branch"]
            and run.get("repository", {}).get("full_name") == REPOSITORY
            and run.get("head_repository", {}).get("full_name") == REPOSITORY
            and matches(NUMBER, str(run.get("run_attempt"))),
            "Producer must be a completed same-repository, branch and source Deploy Web run")
    return int(run["run_attempt"])


def timestamp(value):
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        require(parsed.tzinfo is not None, "Missing artifact/job time zone")
        return parsed
    except (TypeError, ValueError, AttributeError):
        raise ImageError("Invalid artifact/job timestamp") from None


def validate_producing_job(job, receipt, artifact):
    require(isinstance(job, dict) and str(job.get("id")) == receipt["job_id"]
            and str(job.get("run_id")) == receipt["run_id"]
            and str(job.get("run_attempt")) == receipt["attempt"]
            and job.get("head_sha") == receipt["sha"] and job.get("name") == BUILD_JOB
            and job.get("status") == "completed",
            "Receipt must belong to a completed matching build job")
    require(job.get("conclusion") in {"success", "failure", "cancelled", "timed_out", "skipped",
                                     "neutral", "action_required", "stale", "startup_failure"},
            "Producing job has an unknown conclusion")
    if job["conclusion"] != "success":
        return False
    require(timestamp(job.get("started_at")) <= timestamp(artifact.get("created_at"))
            <= timestamp(job.get("completed_at")), "Receipt was not created during its build job")
    steps = job.get("steps")
    require(isinstance(steps, list) and BUILD_STEPS.issubset({
        step.get("name") for step in steps
        if step.get("status") == "completed" and step.get("conclusion") == "success"
    }), "Producer build or receipt publication did not complete")
    return True


def receipt_from_archive(data, artifact):
    require(isinstance(data, bytes) and 0 < len(data) <= 1024 * 1024
            and artifact.get("digest") == "sha256:" + hashlib.sha256(data).hexdigest(),
            "Build artifact digest mismatch")
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = archive.infolist()
            require(len(entries) == 1 and entries[0].filename == "web-build.json"
                    and 0 < entries[0].file_size <= 4096
                    and stat.S_IFMT(entries[0].external_attr >> 16) in (0, stat.S_IFREG),
                    "Invalid build artifact contents")
            with archive.open(entries[0]) as receipt_file:
                body = receipt_file.read(4097)
            require(0 < len(body) <= 4096, "Invalid build artifact contents")
            return json.loads(body)
    except (ValueError, OSError, zipfile.BadZipFile, RuntimeError):
        raise ImageError("Invalid build artifact") from None


def resolve_digest(c, *, pin_sha, fresh_digest="", fresh_project="", producer_run="", api=github):
    validate_context(c)
    require(matches(SHA, pin_sha), "Image source must be a full commit SHA")
    if fresh_digest:
        require(pin_sha == c["sha"] and fresh_project == c["project"] and not producer_run,
                "A fresh build can promote only its own source and stack")
        require(matches(DIGEST, fresh_digest), "Invalid current build digest")
        return fresh_digest
    require(c["event"] == "workflow_dispatch" and matches(NUMBER, producer_run)
            and producer_run != c["run_id"], "Reused images require a completed producer run")
    run_path = f"repos/{REPOSITORY}/actions/runs/{producer_run}"
    run = api(run_path)
    run_attempt = validate_run(run, c, pin_sha, producer_run)
    result = api(run_path + "/artifacts?per_page=100")
    require(isinstance(result, dict) and isinstance(result.get("artifacts"), list)
            and result.get("total_count") == len(result["artifacts"])
            and len(result["artifacts"]) <= 100, "Incomplete build artifact listing")
    artifacts = [a for a in result["artifacts"]
                 if re.fullmatch(rf"web-build-{producer_run}-[1-9][0-9]*", a.get("name", ""))]
    require(0 < len(artifacts) <= 20, "No bounded producer receipt set; rebuild if receipts expired")
    valid = {}
    for artifact in artifacts:
        if artifact.get("expired") is True:
            continue
        require(artifact.get("expired") is False and matches(NUMBER, str(artifact.get("id")))
                and type(artifact.get("size_in_bytes")) is int
                and 0 < artifact["size_in_bytes"] <= 1024 * 1024, "Build receipt is unavailable")
        source = artifact.get("workflow_run", {})
        require(source.get("id") == run["id"] and source.get("head_sha") == pin_sha
                and source.get("head_branch") == c["branch"]
                and source.get("repository_id") == run["repository"].get("id")
                and source.get("head_repository_id") == run["head_repository"].get("id")
                and type(source.get("repository_id")) is int, "Artifact workflow identity mismatch")
        data = api(f"repos/{REPOSITORY}/actions/artifacts/{artifact['id']}/zip", binary=True)
        receipt = receipt_from_archive(data, artifact)
        require(isinstance(receipt, dict), "Invalid build receipt")
        attempt = receipt.get("attempt")
        require(matches(NUMBER, attempt) and int(attempt) <= run_attempt,
                "Invalid producing attempt")
        expected = build_receipt(c | {"sha": pin_sha, "run_id": producer_run,
            "attempt": attempt, "job_id": receipt.get("job_id")}, receipt.get("digest"))
        require(receipt == expected and artifact["name"] == f"web-build-{producer_run}-{attempt}",
                "Build receipt source, job or stack mismatch")
        produced = api(run_path + f"/attempts/{attempt}")
        produced_attempt = validate_run(produced, c, pin_sha, producer_run)
        require(produced_attempt == int(attempt), "Producing attempt mismatch")
        job = api(f"repos/{REPOSITORY}/actions/jobs/{receipt['job_id']}")
        if not validate_producing_job(job, receipt, artifact):
            continue
        require(attempt not in valid, "Ambiguous producer receipts")
        valid[attempt] = receipt["digest"]
    require(valid, "No retained successful build receipt; rebuild current source with receipt-enabled wiring")
    latest = api(run_path)
    latest_attempt = validate_run(latest, c, pin_sha, producer_run)
    require(latest_attempt == run_attempt, "Producer attempt changed")
    return valid[max(valid, key=int)]


def role_context(env):
    branch = env.get("GITHUB_REF_NAME")
    require(env.get("GITHUB_REPOSITORY") == REPOSITORY and branch in BRANCHES
            and env.get("GITHUB_REF") == f"refs/heads/{branch}"
            and env.get("GITHUB_EVENT_NAME") in {"push", "workflow_dispatch"}
            and env.get("GITHUB_WORKFLOW_REF") == f"{REPOSITORY}/{WORKFLOW}@refs/heads/{branch}",
            "Only the samples Deploy Web workflow is allowed")
    role = re.fullmatch(r"arn:aws:iam::([0-9]{12}):role/([A-Za-z0-9_+=,.@/-]+)",
                        env.get("CI_ROLE_ARN", ""))
    require(role, "Explicit branch release role is required")
    dev_account = env.get("AWS_ACCOUNT_ID_DEV", "")
    require(matches(re.compile(r"[0-9]{12}"), dev_account), "Explicit development account is required")
    if branch != "main":
        require(role[1] == dev_account, "Development role account mismatch")
    else:
        require(role[1] != dev_account, "Production role must not use the development account")
    return role[1], role[2].split("/")[-1]


def verify_caller(env, aws=None):
    account, role = role_context(env)
    value = (aws or (lambda: command(["aws", "sts", "get-caller-identity",
        "--region", "ap-northeast-2", "--output", "json", "--no-cli-pager"])))()
    require(value.get("Account") == account and str(value.get("Arn", "")).startswith(
        f"arn:aws:sts::{account}:assumed-role/{role}/"), "Actual branch account/role mismatch")
    return account


def environment_context(env):
    return {"repository": env.get("GITHUB_REPOSITORY"), "branch": env.get("GITHUB_REF_NAME"),
            "sha": env.get("GITHUB_SHA"), "event": env.get("GITHUB_EVENT_NAME"),
            "run_id": env.get("GITHUB_RUN_ID"), "attempt": env.get("GITHUB_RUN_ATTEMPT"),
            "project": env.get("IMAGE_PROJECT"), "account": role_context(env)[0]}


def verify_source_and_migration(c, pin_sha, env, api=github):
    validate_context(c)
    require(matches(SHA, pin_sha), "Expected image source SHA is required")
    current = api(f"repos/{REPOSITORY}/git/ref/heads/{c['branch']}")
    require(current.get("object", {}).get("sha") == c["sha"], "Branch moved; dispatch current HEAD")
    rollback = pin_sha != c["sha"]
    if rollback:
        require(c["event"] == "workflow_dispatch" and env.get("ROLLBACK_SCHEMA_COMPATIBLE") == "true",
                "Older image rollback requires explicit schema compatibility acknowledgement")
        comparison = api(f"repos/{REPOSITORY}/compare/{pin_sha}...{c['sha']}")
        require(comparison.get("status") == "ahead"
                and comparison.get("merge_base_commit", {}).get("sha") == pin_sha,
                "Rollback image must be an ancestor of the dispatched branch")
        require(not env.get("MIGRATED_SHA") and not env.get("MIGRATED_PROJECT"),
                "Rollback must not run current-source migrations")
    elif c["branch"] == "dev":
        require(env.get("MIGRATED_SHA") == c["sha"] and env.get("MIGRATED_PROJECT") == c["project"],
                "Matching-source development migration receipt is required")
    return rollback


def json_object(data):
    try:
        value = json.loads(data)
    except (ValueError, TypeError):
        raise ImageError("Invalid image JSON") from None
    require(isinstance(value, dict), "Invalid image JSON")
    return value


def image_identity(image, repository, digest, account, tag=None):
    require(isinstance(image, dict) and image.get("registryId") == account
            and image.get("repositoryName") == repository
            and isinstance(image.get("imageId"), dict)
            and image["imageId"].get("imageDigest") == digest
            and (tag is None or image["imageId"].get("imageTag") == tag),
            "Approved image registry, repository or digest mismatch")


def get_image(repository, digest, account, aws, tag=None):
    # No acceptedMediaTypes filter: AWS documents only image-manifest values, not
    # indexes/lists. Digest reads preserve the stored representation without
    # translation. Tag reads below establish identity, never select a replacement.
    result = aws("batch-get-image", {"registry-id": account, "repository-name": repository,
                 "image-ids": f"imageTag={tag}" if tag else f"imageDigest={digest}"})
    require(isinstance(result, dict) and not result.get("failures")
            and isinstance(result.get("images"), list) and result["images"],
            "Approved image digest is unavailable")
    image = result["images"][0]
    image_identity(image, repository, digest, account, tag)
    # ECR digest reads can return one identical row per tag (live-confirmed).
    # Only the tag may differ; never select images[0] across conflicting evidence.
    for other in result["images"][1:]:
        image_identity(other, repository, digest, account, tag)
        require(other.get("imageManifest") == image.get("imageManifest")
                and other.get("imageManifestMediaType") == image.get("imageManifestMediaType"),
                "Conflicting image manifests for the approved digest")
    return image


def manifest_body(image):
    manifest = image.get("imageManifest")
    require(isinstance(manifest, str) and 0 < len(manifest.encode()) <= 1024 * 1024
            and "sha256:" + hashlib.sha256(manifest.encode()).hexdigest() == image["imageId"]["imageDigest"],
            "Approved image manifest mismatch")
    body = json_object(manifest)
    media = image.get("imageManifestMediaType")
    require(media in IMAGE_MEDIA or media in INDEX_MEDIA, "Unsupported image manifest media type")
    require(body.get("mediaType", media) == media and type(body.get("schemaVersion")) is int
            and body["schemaVersion"] == 2 and "artifactType" not in body and "subject" not in body,
            "Approved image media type or schema mismatch")
    # ECR can carry media outside the manifest; never reserialize the original bytes.
    body["mediaType"] = media
    return body


def descriptor(value, media_types):
    require(isinstance(value, dict) and value.get("mediaType") in media_types
            and matches(DIGEST, value.get("digest"))
            and type(value.get("size")) is int and value["size"] > 0,
            "Invalid image descriptor")


def verify_arm_image(repository, image, account, aws):
    body = manifest_body(image)
    if body["mediaType"] in INDEX_MEDIA:
        entries = body.get("manifests")
        require(isinstance(entries, list) and 0 < len(entries) <= 20
                and "config" not in body and "layers" not in body, "Invalid image index")
        arm, attestation_refs = [], []
        for entry in entries:
            descriptor(entry, IMAGE_MEDIA)
            platform = entry.get("platform")
            require(isinstance(platform, dict) and isinstance(platform.get("os"), str)
                    and isinstance(platform.get("architecture"), str)
                    and platform["os"] and platform["architecture"], "Invalid image index platform")
            if platform["os"] == "linux" and platform["architecture"] == "arm64":
                arm.append(entry)
            elif platform["os"] == "unknown" or platform["architecture"] == "unknown":
                annotations = entry.get("annotations", {})
                require(platform == {"os": "unknown", "architecture": "unknown"}
                        and isinstance(annotations, dict)
                        and annotations.get("vnd.docker.reference.type") == "attestation-manifest",
                        "Unrecognized image index attestation")
                attestation_refs.append(annotations.get("vnd.docker.reference.digest"))
        require(len(arm) == 1, "Image index must contain exactly one linux/arm64 image")
        require(all(reference == arm[0]["digest"] for reference in attestation_refs),
                "Image index attestation must reference its ARM64 image")
        child = get_image(repository, arm[0]["digest"], account, aws)
        body = manifest_body(child)
        require(body["mediaType"] == arm[0]["mediaType"]
                and len(child["imageManifest"].encode()) == arm[0]["size"],
                "Image index child mismatch")
    require(body["mediaType"] in IMAGE_MEDIA and "manifests" not in body,
            "Invalid executable image manifest")
    config = body.get("config")
    descriptor(config, {IMAGE_MEDIA[body["mediaType"]]})
    require(config["size"] <= 1024 * 1024, "Oversized image configuration")
    require(isinstance(body.get("layers"), list), "Invalid executable image layers")
    for layer in body["layers"]:
        descriptor(layer, LAYER_MEDIA)
    response = aws("get-download-url-for-layer", {"registry-id": account,
                   "repository-name": repository, "layer-digest": config["digest"]})
    require(isinstance(response, dict) and response.get("layerDigest") == config["digest"]
            and isinstance(response.get("downloadUrl"), str), "Image configuration is unavailable")
    download_url = response["downloadUrl"]
    require(all(33 <= ord(char) < 127 for char in download_url),
            "Invalid image configuration download URL")
    try:
        url = urlsplit(download_url)
        port = url.port
    except ValueError:
        raise ImageError("Invalid image configuration download URL") from None
    require(url.scheme == "https" and not url.username and not url.password
            and port in (None, 443) and re.fullmatch(
                r"[a-z0-9.-]+\.s3[.-]ap-northeast-2\.amazonaws\.com", url.hostname or ""),
            "Invalid image configuration download URL")
    # No redirects; download only the config blob, never image layers. Provider
    # URLs/config bytes stay private, and command() suppresses raw error output.
    payload = ('url = "' + download_url.replace("\\", "\\\\").replace('"', '\\"') + '"\n').encode()
    data = command(["curl", "-q", "-K", "-", "--fail", "--silent", "--show-error", "--proto", "=https",
                    "--max-time", "90", "--max-filesize", str(1024 * 1024)],
                   binary=True, stdin_payload=payload)
    require(isinstance(data, bytes) and len(data) == config["size"]
            and "sha256:" + hashlib.sha256(data).hexdigest() == config["digest"],
            "Image configuration digest mismatch")
    actual = json_object(data)
    require(actual.get("os") == "linux" and actual.get("architecture") == "arm64",
            "Approved image must run linux/arm64")


def pin_image(repository, digest, aws=None, *, account, source_tag=None):
    """Low-level publisher; CI callers must use promote() for the guard chain."""
    aws = aws_request if aws is None else aws
    require(matches(PROJECT, repository.removesuffix("-web")) and repository.endswith("-web")
            and matches(DIGEST, digest) and matches(ACCOUNT, account), "Invalid image selection")
    image = get_image(repository, digest, account, aws)
    verify_arm_image(repository, image, account, aws)
    if source_tag is not None:
        require(re.fullmatch(r"web-[a-f0-9]{40}", source_tag), "Invalid source image tag")
        get_image(repository, digest, account, aws, source_tag)
    try:
        try:
            # NamedTemporaryFile creates an owned 0600 file and cleans it on
            # normal success/failure; file:// avoids Linux's per-argument cap.
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8",
                    prefix="web-image-manifest-", suffix=".json") as manifest_file:
                manifest_file.write(image["imageManifest"])
                manifest_file.flush()
                result = aws("put-image", {"registry-id": account, "repository-name": repository,
                             "image-tag": "web-latest", "image-digest": digest,
                             "image-manifest": "file://" + manifest_file.name,
                             "image-manifest-media-type": image["imageManifestMediaType"]})
        except ImageError:
            # Any failed PutImage is harmless only if an independent read proves
            # the desired effect. A still-old tag is not an invalid candidate.
            current = get_image(repository, digest, account, aws, "web-latest")
        else:
            require(isinstance(result, dict), "Invalid image promotion response")
            current = result.get("image")
            image_identity(current, repository, digest, account, "web-latest")
        manifest_body(current)
        require(current["imageManifestMediaType"] == image["imageManifestMediaType"],
                "Promoted image media type mismatch")
    except (ImageError, ValueError, KeyError, TypeError, AttributeError, OSError):
        raise ImageError("Image publication could not be confirmed") from None


def promote(env=None, *, api=None, aws=None, caller=None, expected_digest=None):
    """The supported CI write entrypoint: no caller-supplied repository or skipped guard."""
    env = os.environ if env is None else env
    api = github if api is None else api
    aws = aws_request if aws is None else aws
    verify_caller(env, caller)
    c = environment_context(env)
    validate_context(c)
    expected = expected_digest if expected_digest is not None else env.get("PREFLIGHT_DIGEST", "")
    require(matches(DIGEST, expected), "A validated preflight image digest is required")
    pin = env.get("PIN_SHA") or c["sha"]
    rollback = verify_source_and_migration(c, pin, env, api)
    digest = resolve_digest(c, pin_sha=pin, fresh_digest=env.get("FRESH_DIGEST", ""),
                            fresh_project=env.get("FRESH_PROJECT", ""),
                            producer_run=env.get("IMAGE_BUILD_RUN_ID", ""), api=api)
    require(expected == digest, "Validated image digest changed")
    # Producer lookup may take time; repeat source/migration checks immediately before publication.
    verify_source_and_migration(c, pin, env, api)
    pin_image(c["project"] + "-web", digest, aws, account=c["account"],
              source_tag=f"web-{pin}" if env.get("FRESH_DIGEST") else None)
    return {"digest": digest, "image_sha": pin, "rollback": rollback}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("receipt", "check-role", "verify-role", "promote"))
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    env = os.environ
    if args.mode == "check-role":
        role_context(env)
        return
    if args.mode == "promote":
        print(json.dumps(promote(env), sort_keys=True))
        return
    verify_caller(env)
    if args.mode == "verify-role":
        return
    c = environment_context(env)
    validate_context(c)
    require(env.get("GITHUB_JOB") == "build" and args.output is not None, "Build job/output required")
    response = github(f"repos/{REPOSITORY}/actions/runs/{c['run_id']}/attempts/{c['attempt']}/jobs?per_page=100")
    require(isinstance(response, dict) and isinstance(response.get("jobs"), list)
            and all(isinstance(job, dict) for job in response["jobs"])
            and type(response.get("total_count")) is int
            and response["total_count"] == len(response["jobs"]) <= 100,
            "Incomplete build job listing")
    jobs = [j for j in response["jobs"] if j.get("name") == BUILD_JOB
            and str(j.get("run_id")) == c["run_id"] and str(j.get("run_attempt")) == c["attempt"]
            and j.get("head_sha") == c["sha"] and j.get("status") == "in_progress"]
    require(len(jobs) == 1, "Cannot identify the producing build job")
    body = build_receipt(c | {"job_id": str(jobs[0]["id"])}, env.get("IMAGE_DIGEST"))
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as output:
        json.dump(body, output, sort_keys=True)


if __name__ == "__main__":
    try:
        main()
    except ImageError as error:
        # All ImageError messages are fixed local diagnostics; provider data is
        # collapsed at its boundary and must never be interpolated into them.
        print(f"::error::{error}", file=sys.stderr)
        sys.exit(1)
    except (ValueError, KeyError, TypeError, AttributeError, OSError):
        print("::error::Web image provenance or promotion failed", file=sys.stderr)
        sys.exit(1)
