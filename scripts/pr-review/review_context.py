"""Resolve immutable review metadata; manual recovery reviews only its selected PR HEAD."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys

SHA = re.compile(r"[0-9a-f]{40}")


def review_context():
    repository = os.environ["GITHUB_REPOSITORY"]
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*", repository):
        raise ValueError("invalid repository")
    event = os.environ["GITHUB_EVENT_NAME"]
    workflow_sha = os.environ["GITHUB_SHA"]
    if event == "workflow_dispatch":
        number_input = os.environ.get("PR_NUMBER_INPUT", "")
        expected_head = os.environ.get("EXPECTED_HEAD_INPUT", "")
        if not re.fullmatch(r"[1-9][0-9]{0,11}", number_input) or not SHA.fullmatch(expected_head):
            raise ValueError("recovery requires a PR number and an explicit full HEAD SHA")
        # No shell interpolation; input is validated before the authenticated read.
        response = subprocess.run(
            ["gh", "api", f"repos/{repository}/pulls/{number_input}"],
            capture_output=True, text=True, check=True, timeout=30,
        )
        if len(response.stdout) > 1_000_000:
            raise ValueError("PR metadata exceeds size limit")
        pr = json.loads(response.stdout)
        if pr.get("number") != int(number_input):
            raise ValueError("PR metadata does not match the requested number")
    elif event == "pull_request_target":
        pr = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())["pull_request"]
        expected_head = None
    else:
        raise ValueError("unsupported review event")

    if not isinstance(pr, dict):
        raise ValueError("invalid PR metadata")
    number = pr["number"]
    if type(number) is not int or number < 1 or pr.get("state") != "open":
        raise ValueError("review requires an open PR")
    for side in ("head", "base"):
        if pr[side]["repo"]["full_name"] != repository:
            raise ValueError("review requires head and base in the same repository")
        if not isinstance(pr[side]["sha"], str) or not SHA.fullmatch(pr[side]["sha"]):
            raise ValueError("invalid immutable commit SHA")
    if pr["base"].get("ref") not in ("dev", "main"):
        raise ValueError("review requires a dev or main integration target")
    head, base = pr["head"]["sha"], pr["base"]["sha"]
    if expected_head is not None:
        # Dispatch runs maintainer-selected CI code, never arbitrary code from another PR.
        # Pin the workflow run to the same commit so its check attaches to the reviewed HEAD.
        if expected_head != head or workflow_sha != head:
            raise ValueError("recovery workflow ref and expected HEAD must match the current PR HEAD")
    elif workflow_sha != base:
        raise ValueError("automatic review workflow must use the trusted base commit")
    title = pr.get("title", "")
    if not isinstance(title, str):
        raise ValueError("invalid PR title")
    return {"number": str(number), "head_sha": head, "base_sha": base,
            "title_json": json.dumps(title, ensure_ascii=True)}


if __name__ == "__main__":
    try:
        outputs = review_context()
    except (KeyError, TypeError, ValueError, OSError, subprocess.SubprocessError) as exc:
        # Never print raw authenticated API responses or CLI diagnostics into workflow outputs.
        detail = str(exc) if type(exc) is ValueError else type(exc).__name__
        print(f"review context rejected: {detail}", file=sys.stderr)
        sys.exit(1)
    for key, value in outputs.items():
        print(f"{key}={value}")
