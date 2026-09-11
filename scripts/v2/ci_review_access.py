"""Build a reviewable CI access plan from a live trust readback; performs no API writes."""
import argparse
import copy
import json
import os
from pathlib import Path
import re

ISSUER = "token.actions.githubusercontent.com"


def build_plan(trust, repository, reviewer_id, recovery_pr, oidc):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*", repository):
        raise ValueError("invalid repository")
    if reviewer_id < 1 or recovery_pr < 1:
        raise ValueError("reviewer and recovery PR must be explicit positive IDs")
    if oidc.get("use_default") is not True:
        raise ValueError("custom OIDC claims require separate review")
    if type(oidc.get("use_immutable_subject")) is not bool or not isinstance(oidc.get("sub_claim_prefix"), str):
        raise ValueError("explicit verified immutable-subject mode and subject prefix are required")
    owner, name = map(re.escape, repository.split("/"))
    immutable = oidc["use_immutable_subject"]
    prefix = oidc["sub_claim_prefix"]
    pattern = rf"repo:{owner}@[0-9]+/{name}@[0-9]+" if immutable else rf"repo:{owner}/{name}"
    if not isinstance(prefix, str) or not re.fullmatch(pattern, prefix):
        raise ValueError("subject prefix must match this repository's verified OIDC format")
    providers, denies = set(), []
    for statement in trust["Statement"]:
        if statement.get("Effect") == "Deny":
            denies.append(copy.deepcopy(statement))
            continue
        action = statement.get("Action")
        principal = statement.get("Principal", {})
        provider = principal.get("Federated")
        if (statement.get("Effect") != "Allow" or
                action not in ("sts:AssumeRoleWithWebIdentity", ["sts:AssumeRoleWithWebIdentity"]) or
                set(principal) != {"Federated"} or not isinstance(provider, str) or
                not re.fullmatch(r"arn:aws:iam::[0-9]{12}:oidc-provider/token\.actions\.githubusercontent\.com", provider)):
            raise ValueError("unmanaged trust relationship requires separate review")
        conditions = statement.get("Condition", {})
        if set(conditions) - {"StringEquals", "StringLike"}:
            raise ValueError("additional trust restrictions require separate review")
        if conditions.get("StringEquals", {}).get(f"{ISSUER}:aud") != "sts.amazonaws.com":
            raise ValueError("expected STS audience restriction is missing")
        for operator, values in conditions.items():
            allowed = {f"{ISSUER}:sub"} if operator == "StringLike" else {f"{ISSUER}:aud", f"{ISSUER}:sub"}
            if set(values) - allowed:
                raise ValueError("additional trust restrictions require separate review")
        providers.add(provider)
    if len(providers) != 1:
        raise ValueError("one existing GitHub identity provider is required")
    provider = providers.pop()
    subjects = [
        f"{prefix}:ref:refs/heads/dev",
        f"{prefix}:ref:refs/heads/main",
        f"{prefix}:environment:ci-review-auto",
        f"{prefix}:environment:ci-review-recovery",
    ]
    policy = {"Version": "2012-10-17", "Statement": [{
        "Sid": "AwsopsReviewProtectedSubjects",
        "Effect": "Allow", "Principal": {"Federated": provider},
        "Action": "sts:AssumeRoleWithWebIdentity",
        "Condition": {"StringEquals": {f"{ISSUER}:aud": "sts.amazonaws.com", f"{ISSUER}:sub": subjects}},
    }, *denies]}
    settings = {
        "can_admins_bypass": False,
        "deployment_branch_policy": {"protected_branches": False, "custom_branch_policies": True},
    }
    return {"trust_policy": policy, "environments": {
        "ci-review-auto": {
            "settings": copy.deepcopy(settings),
            "branch_policies": [{"name": "dev", "type": "branch"}, {"name": "main", "type": "branch"}],
        },
        "ci-review-recovery": {
            "settings": {**copy.deepcopy(settings), "prevent_self_review": False,
                         "reviewers": [{"type": "User", "id": reviewer_id}]},
            # GitHub evaluates the actual execution ref for pull_request environments.
            "branch_policies": [{"name": f"refs/pull/{recovery_pr}/merge", "type": "branch"}],
        },
    }}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--trust-file", required=True)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--oidc-config-file", required=True)
    parser.add_argument("--reviewer-id", type=int, required=True)
    parser.add_argument("--recovery-pr", type=int, required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    trust = json.loads(Path(args.trust_file).read_text())
    oidc = json.loads(Path(args.oidc_config_file).read_text())
    plan = build_plan(trust, args.repository, args.reviewer_id, args.recovery_pr, oidc)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    # The live provider ARN can contain an account ID. Keep generated plans local/private.
    with os.fdopen(os.open(output, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as handle:
        handle.write(json.dumps(plan, indent=2) + "\n")
    os.chmod(output, 0o600)
    print("Prepared two protected environments and exact repository trust subjects.")
