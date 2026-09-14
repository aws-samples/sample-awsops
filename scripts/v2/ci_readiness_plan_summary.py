"""Project a narrow readiness rollout for review without publishing plan values."""
import base64
import copy
import json
import sys

LIMIT = 32 * 1024 * 1024
GROUP = "aws_cognito_user_group.deployment_verifiers[0]"
MEMBER = "aws_cognito_user_in_group.demo_readiness[0]"
COLLECTOR = "aws_lambda_function.inv_sync[0]"
ACTIONS = {"no-op", "read", "create", "update", "delete", "forget"}


def digest(value):
    try:
        return isinstance(value, str) and len(base64.b64decode(value, validate=True)) == 32
    except (ValueError, TypeError):
        return False


def resources(state):
    return {item["address"]: item.get("values", {})
            for item in state.get("root_module", {}).get("resources", [])
            if isinstance(item, dict) and isinstance(item.get("address"), str)}


def has_unknown(value):
    if isinstance(value, dict):
        return any(has_unknown(item) for item in value.values())
    if isinstance(value, list):
        return any(has_unknown(item) for item in value)
    return value is not False and value is not None


def project(plan):
    if not isinstance(plan, dict) or not plan.get("format_version"):
        raise ValueError()
    prior = resources(plan.get("prior_state", {}).get("values", {}))
    pool = prior.get("aws_cognito_user_pool.main", {}).get("id")
    user = prior.get("aws_cognito_user.demo[0]", {}).get("username")
    cloudfront = prior.get("aws_cloudfront_distribution.main", {}).get("id")
    changes, complete, new_hash, truncated = [], True, None, False
    for item in plan.get("resource_changes", []):
        change = item["change"]
        actions = change["actions"]
        if not isinstance(actions, list) or not actions or any(a not in ACTIONS for a in actions):
            raise ValueError()
        if actions in (["no-op"], ["read"]):
            continue
        if len(changes) == 256:
            complete, truncated = False, True
            break
        address = item.get("address")
        before, after = change.get("before") or {}, change.get("after") or {}
        unknown = change.get("after_unknown") or {}
        checks = {}
        if address == GROUP:
            checks = {
                "create_only": actions == ["create"] and change.get("before") is None,
                "verifier_name": after.get("name") == "deployment-verifiers",
                "existing_pool": bool(pool) and after.get("user_pool_id") == pool,
                "no_iam_role": after.get("role_arn") is None and not unknown.get("role_arn"),
                "known_identity": not any(unknown.get(key) for key in ("name", "user_pool_id")),
            }
        elif address == MEMBER:
            checks = {
                "create_only": actions == ["create"] and change.get("before") is None,
                "verifier_group": after.get("group_name") == "deployment-verifiers",
                "existing_pool": bool(pool) and after.get("user_pool_id") == pool,
                "existing_managed_demo": bool(user) and after.get("username") == user,
                "known_identity": not any(unknown.get(key) for key in ("group_name", "user_pool_id", "username")),
            }
        elif address == COLLECTOR:
            changed = {key for key in before.keys() | after.keys() if before.get(key) != after.get(key)}
            checks = {
                "update_only": actions == ["update"],
                "code_only": changed <= {"source_code_hash", "code_sha256", "last_modified"},
                "known_code_hash": digest(after.get("source_code_hash")) and not unknown.get("source_code_hash"),
            }
            if checks["known_code_hash"]:
                new_hash = after["source_code_hash"]
        else:
            # Do not expose dynamic resource keys, names, module paths or values.
            address = "other_resource"
        matched = bool(checks) and all(checks.values())
        complete = complete and matched
        row = {"resource": address, "actions": actions, "matches_expected_scope": matched, "checks": checks}
        if address == COLLECTOR and new_hash:
            row["configured_code_sha256"] = new_hash
        changes.append(row)
    outputs = []
    for name, change in plan.get("output_changes", {}).items():
        if change.get("actions") in (["no-op"], ["read"]):
            continue
        before, after = copy.deepcopy(change.get("before")), copy.deepcopy(change.get("after"))
        matched = False
        if name == "agentcore" and isinstance(before, dict) and isinstance(after, dict):
            enabled = after.pop("deployment_readiness_enabled", None)
            old_enabled = before.pop("deployment_readiness_enabled", None)
            known = after.pop("readiness_cloudfront_id", None)
            before.pop("readiness_cloudfront_id", None)
            matched = (type(old_enabled) is bool and enabled is True and bool(cloudfront)
                       and known == cloudfront and before == after)
        elif name == "runtime_deployment" and isinstance(before, dict) and isinstance(after, dict):
            previous = before.get("inventory", {}).pop("sync_code_sha256", None)
            current = after.get("inventory", {}).pop("sync_code_sha256", None)
            matched = digest(previous) and digest(current) and current == new_hash and before == after
        matched = matched and not has_unknown(change.get("after_unknown"))
        complete = complete and matched
        outputs.append({"output": name if name in {"agentcore", "runtime_deployment"} else "other_output",
                        "matches_expected_scope": matched})
    return {"schema_version": 1, "review_kind": "bounded_readiness_rollout",
            "all_changes_match_expected_scope": complete,
            "resource_changes": changes, "output_changes": outputs, "truncated": truncated,
            "limitation": "Other changes require private exact-plan inspection; this report is not approval."}


if __name__ == "__main__":
    try:
        data = sys.stdin.buffer.read(LIMIT + 1)
        if len(data) > LIMIT:
            raise ValueError()
        print(json.dumps(project(json.loads(data)), indent=2, sort_keys=True))
    except (ValueError, TypeError, KeyError, AttributeError, RecursionError):
        print('{"error":"readiness_plan_summary_unavailable"}')
        sys.exit(1)
