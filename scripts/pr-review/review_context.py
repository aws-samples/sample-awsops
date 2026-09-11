"""Pin recovery labels to PR HEAD and separate trusted CI code from target-base context."""
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
    if event not in ("pull_request_target", "pull_request") or not SHA.fullmatch(workflow_sha):
        raise ValueError("unsupported review event")
    payload = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    pr = payload["pull_request"]
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
    checkout_sha = subprocess.run(
        ["git", "rev-parse", "HEAD"], capture_output=True, text=True, check=True, timeout=10,
    ).stdout.strip()
    if event == "pull_request":
        # Labeling is the explicit recovery approval. A generic label or synchronize event
        # cannot authorize a newer commit. The workflow checks this again before checkout.
        if payload.get("action") != "labeled" or payload.get("label", {}).get("name") != f"ci-review:{head}":
            raise ValueError("recovery requires an explicit label matching the full PR HEAD SHA")
        if checkout_sha != head:
            raise ValueError("recovery checkout does not match the approved PR HEAD")
        response = subprocess.run(
            ["gh", "api", f"repos/{repository}/pulls/{number}"],
            capture_output=True, text=True, check=True, timeout=30,
        )
        if len(response.stdout) > 1_000_000:
            raise ValueError("PR metadata exceeds size limit")
        current = json.loads(response.stdout)
        if current.get("number") != number or current.get("state") != "open" or current["head"]["sha"] != head:
            raise ValueError("PR changed after recovery approval")
    elif checkout_sha != workflow_sha:
        # pull_request_target uses the DEFAULT branch's immutable GITHUB_SHA; the PR target
        # can differ (e.g. dev -> main). Only the model's source context uses target base SHA.
        raise ValueError("automatic review checkout must match the trusted workflow commit")
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
