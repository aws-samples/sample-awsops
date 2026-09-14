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
            "account_sha256": hashlib.sha256(c["account"].encode()).hexdigest(),
            "project": c["project"], "digest": digest}


def command(args, *, binary=False):
    # Never surface stderr, which can contain authentication or registry details.
    try:
        result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                timeout=90, check=True)
        require(len(result.stdout) <= 1024 * 1024, "Oversized provider response")
        return result.stdout if binary else json.loads(result.stdout)
    except (subprocess.SubprocessError, OSError, ValueError):
        raise ImageError("Image provenance provider request failed") from None


def github(path, binary=False):
    return command(["gh", "api", "--hostname", "github.com", path], binary=binary)


def aws_request(operation, args):
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
    require(timestamp(job.get("started_at")) <= timestamp(artifact.get("created_at"))
            <= timestamp(job.get("completed_at")), "Receipt was not created during its build job")
    require(job.get("conclusion") in {"success", "failure", "cancelled", "timed_out", "skipped", "neutral", "action_required"},
            "Producing job has an unknown conclusion")
    if job["conclusion"] != "success":
        return False
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
            return json.loads(archive.read(entries[0]))
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
    validate_run(run, c, pin_sha, producer_run)
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
        require(matches(NUMBER, attempt) and int(attempt) <= run["run_attempt"],
                "Invalid producing attempt")
        expected = build_receipt(c | {"sha": pin_sha, "run_id": producer_run,
            "attempt": attempt, "job_id": receipt.get("job_id")}, receipt.get("digest"))
        require(receipt == expected and artifact["name"] == f"web-build-{producer_run}-{attempt}",
                "Build receipt source, job, account or stack mismatch")
        produced = api(run_path + f"/attempts/{attempt}")
        validate_run(produced, c, pin_sha, producer_run)
        require(str(produced["run_attempt"]) == attempt, "Producing attempt mismatch")
        job = api(f"repos/{REPOSITORY}/actions/jobs/{receipt['job_id']}")
        if not validate_producing_job(job, receipt, artifact):
            continue
        require(attempt not in valid, "Ambiguous producer receipts")
        valid[attempt] = receipt["digest"]
    require(valid, "No retained successful build receipt; rebuild or use reviewed operator recovery")
    latest = api(run_path)
    validate_run(latest, c, pin_sha, producer_run)
    require(latest["run_attempt"] == run["run_attempt"], "Producer attempt changed")
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
    if branch == "dev":
        require(role[1] == env.get("AWS_ACCOUNT_ID_DEV"), "Development role account mismatch")
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


def pin_image(repository, digest, aws=aws_request):
    require(matches(PROJECT, repository.removesuffix("-web")) and repository.endswith("-web")
            and matches(DIGEST, digest), "Invalid image selection")
    result = aws("batch-get-image", {"repository-name": repository, "image-ids": f"imageDigest={digest}"})
    require(not result.get("failures") and len(result.get("images", [])) == 1,
            "Approved image digest is unavailable")
    image = result["images"][0]
    manifest = image.get("imageManifest")
    require(isinstance(manifest, str) and image.get("imageId", {}).get("imageDigest") == digest
            and "sha256:" + hashlib.sha256(manifest.encode()).hexdigest() == digest,
            "Approved image manifest mismatch")
    try:
        result = aws("put-image", {"repository-name": repository, "image-tag": "web-latest",
                                   "image-manifest": manifest})
        require(result.get("image", {}).get("imageId", {}).get("imageDigest") == digest,
                "Promoted image digest mismatch")
    except ImageError:
        # ImageAlreadyExists is harmless only if an independent read confirms the
        # desired digest. Never trust a substring in a CLI error message.
        current = aws("batch-get-image", {"repository-name": repository, "image-ids": "imageTag=web-latest"})
        require(not current.get("failures") and len(current.get("images", [])) == 1
                and current["images"][0].get("imageId", {}).get("imageDigest") == digest,
                "Image promotion failed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("receipt", "check-role", "verify-role"))
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    env = os.environ
    if args.mode == "check-role":
        role_context(env)
        return
    verify_caller(env)
    if args.mode == "verify-role":
        return
    c = environment_context(env)
    require(env.get("GITHUB_JOB") == "build" and args.output is not None, "Build job/output required")
    response = github(f"repos/{REPOSITORY}/actions/runs/{c['run_id']}/attempts/{c['attempt']}/jobs?per_page=100")
    require(response.get("total_count") == len(response.get("jobs", [])), "Incomplete build job listing")
    jobs = [j for j in response["jobs"] if j.get("name") == BUILD_JOB
            and str(j.get("run_id")) == c["run_id"] and str(j.get("run_attempt")) == c["attempt"]
            and j.get("head_sha") == c["sha"] and j.get("status") == "in_progress"]
    require(len(jobs) == 1, "Cannot identify the producing build job")
    body = build_receipt(c | {"job_id": str(jobs[0]["id"])}, env.get("IMAGE_DIGEST"))
    with args.output.open("x") as output:
        os.chmod(args.output, 0o600)
        json.dump(body, output, sort_keys=True)


if __name__ == "__main__":
    try:
        main()
    except (ImageError, ValueError, KeyError, TypeError, OSError):
        print("::error::Web image provenance or promotion failed; verify the producer run and rebuild if its receipt expired.",
              file=sys.stderr)
        sys.exit(1)
