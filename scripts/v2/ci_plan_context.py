"""Verify a saved Terraform plan's GitHub run before downloading it for apply."""
import argparse
import json
import re
import sys


def validate_run(run, repository, branch, commit):
    if branch not in {"main", "dev", "atomoh", "ssminji", "whchoi"}:
        raise ValueError("unsupported deployment branch")
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("expected a full immutable commit SHA")
    if not isinstance(run, dict) or run.get("path") != ".github/workflows/terraform.yml":
        raise ValueError("plan must come from the Terraform workflow")
    for field in ("repository", "head_repository"):
        source = run.get(field)
        if not isinstance(source, dict) or source.get("full_name") != repository:
            raise ValueError("plan repository does not match the deployment repository")
    if run.get("event") not in {"push", "workflow_dispatch"}:
        raise ValueError("plan event must be a trusted branch push or dispatch")
    if run.get("head_branch") != branch:
        raise ValueError("plan branch does not match the deployment stack")
    if run.get("head_sha") != commit:
        raise ValueError("plan commit does not match the deployment commit")
    if run.get("status") != "completed":
        raise ValueError("plan run must be complete")
    if run.get("conclusion") != "success":
        raise ValueError("plan run must be successful")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--branch", required=True)
    parser.add_argument("--commit", required=True)
    args = parser.parse_args()
    try:
        validate_run(json.load(sys.stdin), args.repository, args.branch, args.commit)
    except (ValueError, TypeError) as error:
        print(f"Refusing saved-plan apply: {error}", file=sys.stderr)
        return 1
    print(f"Verified Terraform plan for {args.repository}:{args.branch}@{args.commit}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
