#!/usr/bin/env python3
"""Bind web promotion to the current build or an authenticated build artifact."""
import argparse
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


def build_receipt(c, digest):
    validate_context(c)
    require(matches(DIGEST, digest), "Missing build digest")
    return {"schema": 1, "repository": c["repository"], "workflow": WORKFLOW,
            "branch": c["branch"], "sha": c["sha"], "run_id": c["run_id"],
            "attempt": c["attempt"], "project": c["project"], "digest": digest}


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
    return command(["gh", "api", path], binary=binary)


def aws_request(operation, args):
    argv = ["aws", "ecr", operation, "--region", "ap-northeast-2", "--output", "json",
            "--no-cli-pager"]
    for key, value in args.items():
        argv += ["--" + key, value]
    return command(argv)


def validate_run(run, c, pin_sha, producer_run):
    require(isinstance(run, dict) and str(run.get("id")) == producer_run
            and run.get("status") == "completed" and run.get("conclusion") == "success"
            and run.get("event") in {"push", "workflow_dispatch"}
            and run.get("path") == WORKFLOW and run.get("head_sha") == pin_sha
            and run.get("head_branch") == c["branch"]
            and run.get("repository", {}).get("full_name") == REPOSITORY
            and run.get("head_repository", {}).get("full_name") == REPOSITORY
            and matches(NUMBER, str(run.get("run_attempt"))),
            "Producer must be a successful same-repository, branch and source Deploy Web run")


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
    attempt = str(run["run_attempt"])
    result = api(run_path + "/artifacts?per_page=100")
    require(isinstance(result, dict) and isinstance(result.get("artifacts"), list)
            and result.get("total_count") == len(result["artifacts"])
            and len(result["artifacts"]) <= 100, "Incomplete build artifact listing")
    artifacts = [a for a in result["artifacts"]
                 if a.get("name") == f"web-build-{producer_run}-{attempt}"]
    require(len(artifacts) == 1, "Current producer attempt has no unique build receipt")
    artifact = artifacts[0]
    require(artifact.get("expired") is False and matches(NUMBER, str(artifact.get("id")))
            and isinstance(artifact.get("size_in_bytes"), int)
            and 0 < artifact["size_in_bytes"] <= 1024 * 1024, "Build receipt is unavailable")
    data = api(f"repos/{REPOSITORY}/actions/artifacts/{artifact['id']}/zip", binary=True)
    receipt = receipt_from_archive(data, artifact)
    require(isinstance(receipt, dict), "Invalid build receipt")
    expected = build_receipt(c | {"sha": pin_sha, "run_id": producer_run, "attempt": attempt},
                             receipt.get("digest"))
    require(receipt == expected, "Build receipt source or stack mismatch")
    latest = api(run_path)
    validate_run(latest, c, pin_sha, producer_run)
    require(latest["run_attempt"] == run["run_attempt"], "Producer attempt changed")
    return receipt["digest"]


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
    parser.add_argument("mode", choices=("receipt", "pin"))
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    env = os.environ
    c = {"repository": env.get("GITHUB_REPOSITORY"), "branch": env.get("GITHUB_REF_NAME"),
         "sha": env.get("GITHUB_SHA"), "event": env.get("GITHUB_EVENT_NAME"),
         "run_id": env.get("GITHUB_RUN_ID"), "attempt": env.get("GITHUB_RUN_ATTEMPT"),
         "project": env.get("IMAGE_PROJECT")}
    if args.mode == "receipt":
        require(args.output is not None, "Build receipt destination is required")
        body = build_receipt(c, env.get("IMAGE_DIGEST"))
        with args.output.open("x") as output:
            os.chmod(args.output, 0o600)
            json.dump(body, output, sort_keys=True)
        return
    digest = resolve_digest(c, pin_sha=env.get("PIN_SHA") or c["sha"],
                            fresh_digest=env.get("FRESH_DIGEST", ""),
                            fresh_project=env.get("FRESH_PROJECT", ""),
                            producer_run=env.get("IMAGE_BUILD_RUN_ID", ""))
    pin_image(c["project"] + "-web", digest)
    # A digest is intentionally public; no account, role, configuration or token.
    print("Approved web image promoted: " + digest)
    if env.get("GITHUB_OUTPUT"):
        with open(env["GITHUB_OUTPUT"], "a") as output:
            output.write("digest=" + digest + "\n")


if __name__ == "__main__":
    try:
        main()
    except (ImageError, ValueError, KeyError, TypeError, OSError):
        print("::error::Web image provenance or promotion failed; verify the producer run and rebuild if its receipt expired.",
              file=sys.stderr)
        sys.exit(1)
