"""Offline account, immutable-image and private runtime rollout boundaries."""
import argparse
import copy
import json
import os
from pathlib import Path
import re
import sys

SCOPES = ("full", "ecr-bootstrap", "runtime-ecr-bootstrap")
DEV_TARGETS = ("dev", "atomoh", "ssminji", "whchoi")
REPOSITORIES = {
    "aws_ecr_repository.steampipe[0]": "steampipe",
    "aws_ecr_repository.agentcore[0]": "agentcore",
    "aws_ecr_repository.worker[0]": "worker",
}
PRIVATE_DNS = {
    "aws_service_discovery_private_dns_namespace.main[0]",
    "aws_service_discovery_service.steampipe[0]",
    "aws_ecs_service.steampipe[0]",
}
READONLY_PROFILE_FLAGS = (
    "remediation_enabled", "integrations_write_enabled",
    "rca_writeback_enabled", "diagnosis_notify_enabled",
)
CORE = set(REPOSITORIES) | PRIVATE_DNS | {
    "aws_lambda_function.inv_sync[0]", "aws_sqs_queue.jobs[0]",
    "aws_ssm_parameter.agentcore_runtime_arn[0]",
    "aws_ssm_parameter.agentcore_interpreter_id[0]",
    "aws_ssm_parameter.agentcore_memory_id[0]",
    "aws_sfn_state_machine.workers[0]", "aws_lambda_event_source_mapping.dispatcher[0]",
}
OVERRIDES = Path("ci-runtime.auto.tfvars.json")
RUNTIME_FLAGS = ("agentcore_enabled", "workers_enabled", "steampipe_enabled", "inventory_host_only")
NETWORK_TYPES = {
    "aws_vpc", "aws_subnet", "aws_nat_gateway", "aws_internet_gateway",
    "aws_route", "aws_route_table", "aws_route_table_association",
}


def account_id(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{12}", value):
        raise ValueError("AWS_ACCOUNT_ID_DEV must be an explicit 12-digit account")
    return value


def runtime_overrides(target, enabled, expected_account, scope, steampipe_digest, worker_digest,
                      rollout, *, advisory=False, retire=False):
    if (scope not in SCOPES or enabled not in ("", "false", "true")
            or type(rollout) is not bool or type(retire) is not bool):
        raise ValueError("Invalid runtime profile or scope")
    profile = target == "dev" and enabled == "true"
    if retire and (target != "dev" or scope != "full" or advisory or rollout or profile):
        raise ValueError("Runtime retirement requires manual dev/full with profile and rollout off")
    if target not in DEV_TARGETS:
        if rollout or retire or scope == "runtime-ecr-bootstrap":
            raise ValueError("Runtime operation requires a development target")
        return {}
    if scope == "runtime-ecr-bootstrap" and target != "dev":
        raise ValueError("Runtime bootstrap is dev-only")
    if rollout and (scope != "full" or advisory or (target == "dev" and not profile)):
        raise ValueError("Runtime rollout requires manual full scope and the dev activation profile on dev")
    result = {"ci_runtime_profile_enabled": profile, "ci_runtime_rollout": rollout, "ci_runtime_retire": retire}
    if profile or rollout or retire:
        account_id(expected_account)
    if retire:
        return {**result, **{key: False for key in RUNTIME_FLAGS}}
    if not profile:
        return result
    result.update({key: True for key in RUNTIME_FLAGS})
    for key, value in (("steampipe_image_digest", steampipe_digest), ("worker_image_digest", worker_digest)):
        if value:
            if not re.fullmatch(r"sha256:[a-f0-9]{64}", value):
                raise ValueError("Runtime images require validated immutable sha256 digests")
            result[key] = value
        elif scope == "full" and not advisory:
            raise ValueError("Build both runtime images and configure their digests before a full plan")
    return result


def verify_role(expected_account, configured_role):
    expected = account_id(expected_account)
    role = re.fullmatch(r"arn:aws:iam::(\d{12}):role/([A-Za-z0-9_+=,.@/-]+)",
                        configured_role.strip() if isinstance(configured_role, str) else "")
    if not role or role[1] != expected:
        raise ValueError("Configured CI role must belong to the intended development account")
    return role[2].split("/")[-1]


def verify_caller(caller, expected_account, configured_role):
    role_name = verify_role(expected_account, configured_role)
    expected = account_id(expected_account)
    arn = caller.get("Arn") if isinstance(caller, dict) else None
    identity = re.fullmatch(r"arn:aws:sts::(\d{12}):assumed-role/([^/]+)/[^/]+", arn or "")
    if (not identity or identity[1] != expected
            or caller.get("Account") != expected or identity[2] != role_name):
        raise ValueError("Configured role and live caller must match the intended development account and role")


def _variables(plan):
    values = plan.get("variables")
    if not isinstance(values, dict):
        raise ValueError("Missing saved plan variables")
    return {key: value["value"] for key, value in values.items()
            if isinstance(value, dict) and "value" in value}


def _resources(module):
    if not isinstance(module, dict):
        return []
    return list(module.get("resources", [])) + [
        resource for child in module.get("child_modules", []) for resource in _resources(child)
    ]


def _vpc(plan, variables):
    if variables.get("create_network") is False:
        value = variables.get("existing_vpc_id")
    else:
        roots = [
            plan.get("planned_values", {}).get("root_module"),
            plan.get("prior_state", {}).get("values", {}).get("root_module"),
        ]
        values = [r.get("values", {}).get("id") for root in roots for r in _resources(root)
                  if r.get("address") == "aws_vpc.main[0]"]
        value = next((item for item in values if item), None)
    if not isinstance(value, str) or not re.fullmatch(r"vpc-[a-f0-9]+", value):
        raise ValueError("Private discovery requires the resolved foundation VPC")
    return value


def _resource_values(plan, address):
    for resource in plan.get("resource_changes", []):
        if resource.get("address") == address:
            return resource.get("change", {}).get("after") or {}
    for root in (plan.get("planned_values", {}).get("root_module"),
                 plan.get("prior_state", {}).get("values", {}).get("root_module")):
        for resource in _resources(root):
            if resource.get("address") == address:
                return resource.get("values", {})
    return {}


def _single_block(value, block):
    fields = value.get(block) if isinstance(value, dict) else None
    if not isinstance(fields, list) or len(fields) != 1 or not isinstance(fields[0], dict):
        raise ValueError("Private discovery needs exactly one resolved block")
    return fields[0]


def _reference_binding(plan, resource, block, field, dependency, attribute):
    expected = _resource_values(plan, dependency).get(attribute)
    actual = _single_block(resource["change"]["after"], block).get(field)
    if expected is not None:
        if not isinstance(expected, str) or not expected or actual != expected:
            raise ValueError("Private discovery points outside this deployment")
        return
    # First creation has provider-generated IDs. Accept the exact dependency
    # reference only when both resources are being created in this saved plan.
    dependency_created = any(
        item.get("address") == dependency and item.get("change", {}).get("actions") == ["create"]
        for item in plan["resource_changes"]
    )
    unknown = _single_block(resource["change"].get("after_unknown"), block).get(field)
    if (not dependency_created or resource["change"]["actions"] != ["create"]
            or actual is not None or unknown is not True):
        raise ValueError("Private discovery identity is unresolved")
    address = re.sub(r"\[0\]$", "", resource["address"])
    expressions = [
        item.get("expressions", {}) for item in _resources(plan.get("configuration", {}).get("root_module"))
        if item.get("address") == address
    ]
    if len(expressions) != 1:
        raise ValueError("Missing private discovery configuration reference")
    expression = _single_block(expressions[0], block).get(field)
    refs = expression.get("references") if isinstance(expression, dict) else None
    exact = f"{dependency}.{attribute}"
    allowed = {exact, dependency, re.sub(r"\[0\]$", "", dependency)}
    if not isinstance(refs, list) or exact not in refs or not all(ref in allowed for ref in refs):
        raise ValueError("Private discovery must reference its own configured dependency")


def _validate_discovery_service(plan, variables, resource):
    namespace = _resource_values(plan, "aws_service_discovery_private_dns_namespace.main[0]")
    if namespace.get("name") != f"{variables['project']}.internal" or namespace.get("vpc") != _vpc(plan, variables):
        raise ValueError("Inventory service requires the owned private namespace and VPC")
    _reference_binding(plan, resource, "dns_config", "namespace_id",
                       "aws_service_discovery_private_dns_namespace.main[0]", "id")


def _validate_private(plan, variables, resource):
    after, kind = resource["change"]["after"], resource["type"]
    if resource["address"].split(".")[0] != kind:
        raise ValueError("Private discovery resource type does not match its address")
    if kind == "aws_service_discovery_private_dns_namespace":
        if after.get("name") != f"{variables['project']}.internal" or after.get("vpc") != _vpc(plan, variables):
            raise ValueError("Private discovery namespace must match this deployment and VPC")
    elif kind == "aws_service_discovery_service":
        if after.get("name") != "steampipe":
            raise ValueError("Only the inventory discovery service is permitted")
        _validate_discovery_service(plan, variables, resource)
    elif kind == "aws_ecs_service":
        if after.get("name") != f"{variables['project']}-steampipe":
            raise ValueError("Only the inventory ECS registration is permitted")
        cluster = _resource_values(plan, "aws_ecs_cluster.main")
        if not after.get("cluster") or after["cluster"] not in (cluster.get("arn"), cluster.get("id"), cluster.get("name")):
            raise ValueError("Inventory ECS registration must use the owned cluster")
        address = "aws_service_discovery_service.steampipe[0]"
        service = _resource_values(plan, address)
        if service.get("name") != "steampipe":
            raise ValueError("Inventory discovery service is missing")
        change = next((r for r in plan["resource_changes"] if r.get("address") == address),
                      {"address": address, "change": {"actions": ["no-op"], "after": service}})
        _validate_discovery_service(plan, variables, change)
        _reference_binding(plan, resource, "service_registries", "registry_arn", address, "arn")
    else:
        raise ValueError("Unexpected private discovery resource")


def _before_inspection(plan):
    """Validation view only: never rewrite the saved plan or authorize via unknown future IDs."""
    inspection = copy.deepcopy(plan)
    for resource in inspection.get("resource_changes", []):
        change = resource.get("change", {})
        if isinstance(change.get("before"), dict):
            change["after"] = change["before"]
        change["actions"], change["after_unknown"] = ["no-op"], {}
    return inspection


def _configuration(plan, address):
    address = re.sub(r"\[.*\]$", "", address)
    matches = [r for r in _resources(plan.get("configuration", {}).get("root_module"))
               if r.get("address") == address]
    return matches[0] if len(matches) == 1 else {}


def _core_gated(plan, address):
    resource = _configuration(plan, address)
    gates = {"local.sp", "local.we", "local.ac_count", "local.core_runtime_enabled",
             "var.steampipe_enabled", "var.workers_enabled", "var.agentcore_enabled"}
    for key in ("count_expression", "for_each_expression"):
        refs = resource.get(key, {}).get("references", [])
        if isinstance(refs, list) and refs and all(isinstance(r, str) for r in refs):
            if set(refs) <= gates | {"local.agent_lambdas"} and set(refs) & gates:
                return True
    return False


def _has_unknown(value):
    if isinstance(value, dict):
        return any(_has_unknown(v) for v in value.values())
    if isinstance(value, list):
        return any(_has_unknown(v) for v in value)
    return value is not False and value is not None


def _web_environment_cleanup(resource, project):
    change = resource["change"]
    before, after = change.get("before"), change.get("after")
    if (resource["address"] != "aws_ecs_task_definition.web"
            or resource["type"] != "aws_ecs_task_definition"
            or change["actions"] not in (["update"], ["create", "delete"], ["delete", "create"])
            or not isinstance(before, dict) or not isinstance(after, dict)
            or before.get("family") != after.get("family") or after.get("family") != f"{project}-web"):
        return False
    computed = {"id", "arn", "arn_without_revision", "revision"}
    ignored = computed | {"container_definitions"}
    unknown = change.get("after_unknown") or {}
    if not isinstance(unknown, dict) or _has_unknown({k: v for k, v in unknown.items() if k not in computed}):
        return False
    if {k: v for k, v in before.items() if k not in ignored} != {k: v for k, v in after.items() if k not in ignored}:
        return False
    try:
        old, new = json.loads(before["container_definitions"]), json.loads(after["container_definitions"])
        if not isinstance(old, list) or not isinstance(new, list) or len(old) != len(new):
            return False
        changed = False
        allowed = {"INV_SYNC_FUNCTION", "INVENTORY_HOST_ONLY", "JOBS_QUEUE_URL",
                   "SSM_RUNTIME_ARN_PARAM", "SSM_INTERPRETER_ID_PARAM", "SSM_MEMORY_ID_PARAM"}
        for previous, following in zip(old, new):
            if previous == following:
                continue
            if previous.get("name") != "web" or following.get("name") != "web":
                return False
            if {k: v for k, v in previous.items() if k != "environment"} != {
                    k: v for k, v in following.items() if k != "environment"}:
                return False
            a, b = {}, {}
            for source, result in ((previous, a), (following, b)):
                for entry in source.get("environment", []):
                    if set(entry) != {"name", "value"} or entry["name"] in result:
                        return False
                    result[entry["name"]] = entry["value"]
            differences = {k for k in a.keys() | b.keys() if a.get(k) != b.get(k)}
            if not differences <= allowed or any(k in b and b[k] not in ("", "false") for k in differences):
                return False
            changed |= bool(differences)
        return changed
    except (ValueError, KeyError, TypeError, AttributeError):
        return False


def _web_service_cleanup(plan, resource, variables):
    change = resource["change"]
    before, after = change.get("before"), change.get("after")
    if (resource["address"] != "aws_ecs_service.web" or resource["type"] != "aws_ecs_service"
            or change["actions"] != ["update"] or not isinstance(before, dict) or not isinstance(after, dict)
            or after.get("name") != f"{variables['project']}-web"):
        return False
    if {k: v for k, v in before.items() if k != "task_definition"} != {
            k: v for k, v in after.items() if k != "task_definition"}:
        return False
    cluster = _resource_values(plan, "aws_ecs_cluster.main")
    if not after.get("cluster") or after["cluster"] not in (cluster.get("arn"), cluster.get("id"), cluster.get("name")):
        return False
    definition = next((r for r in plan["resource_changes"] if r.get("address") == "aws_ecs_task_definition.web"), None)
    if not definition or not _web_environment_cleanup(definition, variables["project"]):
        return False
    unknown = change.get("after_unknown") or {}
    if not isinstance(unknown, dict) or _has_unknown({k: v for k, v in unknown.items() if k != "task_definition"}):
        return False
    expected = definition["change"]["after"].get("arn")
    if expected:
        return after.get("task_definition") == expected
    refs = _configuration(plan, resource["address"]).get("expressions", {}).get("task_definition", {}).get("references", [])
    return (after.get("task_definition") is None and unknown.get("task_definition") is True
            and isinstance(refs, list) and "aws_ecs_task_definition.web.arn" in refs
            and all(r in ("aws_ecs_task_definition.web", "aws_ecs_task_definition.web.arn") for r in refs))


def _retirement_change(plan, inspection, variables, resource):
    address, kind, change = resource["address"], resource["type"], resource["change"]
    if address not in CORE and (_web_environment_cleanup(resource, variables["project"])
                               or _web_service_cleanup(plan, resource, variables)):
        return
    if (address in ("aws_ecs_service.web", "aws_ecs_task_definition.web")
            or kind.startswith(("aws_rds_", "aws_db_", "aws_cognito_", "aws_kms_"))
            or kind == "aws_ecs_cluster"):
        raise ValueError("Retirement must preserve shared application infrastructure")
    if change["actions"] != ["delete"] or change.get("after") is not None or not isinstance(change.get("before"), dict):
        raise ValueError("Retirement permits true runtime deletion, not creation, update, replacement or forget")
    if address in CORE:
        if kind != address.split(".")[0]:
            raise ValueError("Runtime retirement resource type mismatch")
        if address in PRIVATE_DNS:
            prior = next(r for r in inspection["resource_changes"] if r.get("address") == address)
            _validate_private(inspection, variables, prior)
        return
    if (kind.startswith("aws_service_discovery")
            or kind == "aws_ecs_service" and change["before"].get("service_registries")
            or not _core_gated(plan, address)):
        raise ValueError("Retirement contains an unrelated resource change")
    if kind.startswith(("aws_security_group", "aws_vpc_security_group")):
        before = change["before"]
        if (address != "aws_security_group.steampipe[0]" or before.get("name") != f"{variables['project']}-steampipe-sg"
                or before.get("vpc_id") != _vpc(inspection, variables)):
            raise ValueError("Retirement must preserve shared network security groups")


def _check_accounts(value, expected):
    if isinstance(value, dict):
        for item in value.values():
            _check_accounts(item, expected)
    elif isinstance(value, list):
        for item in value:
            _check_accounts(item, expected)
    elif isinstance(value, str):
        arn = re.match(r"^arn:aws:[a-z0-9-]+:[a-z0-9-]*:(\d{12}):", value)
        if arn and arn[1] != expected:
            raise ValueError("A runtime resource belongs to a different account")


def check_plan(plan, target, scope, expected_account, *, advisory=False):
    if scope not in SCOPES or not isinstance(plan, dict) or not plan.get("format_version"):
        raise ValueError("Invalid runtime plan scope or document")
    variables = _variables(plan)
    rollout = variables.get("ci_runtime_rollout", False)
    profile = variables.get("ci_runtime_profile_enabled", False)
    retire = variables.get("ci_runtime_retire", False)
    if any(type(value) is not bool for value in (rollout, profile, retire)):
        raise ValueError("Runtime operation metadata must be boolean")
    if profile and target != "dev":
        raise ValueError("The generated runtime profile is dev-only")
    if retire and (target != "dev" or scope != "full" or advisory or rollout or profile
                   or variables.get("ci_domain_rollout")):
        raise ValueError("Runtime retirement requires manual dev/full with other rollout/profile intent off")
    if retire and any(variables.get(flag) is not False for flag in RUNTIME_FLAGS):
        raise ValueError("Runtime retirement requires all core and host-only flags off")
    if rollout and (target not in DEV_TARGETS or scope != "full" or advisory or variables.get("ci_domain_rollout")):
        raise ValueError("Runtime rollout requires a manual development full plan without domain rollout")
    if target not in DEV_TARGETS:
        if scope == "runtime-ecr-bootstrap":
            raise ValueError("Runtime bootstrap is dev-only")
        return {"runtime_policy": "not_applicable"}
    if target != "dev" and scope == "runtime-ecr-bootstrap":
        raise ValueError("Runtime bootstrap is dev-only")
    expected = account_id(expected_account)
    project = variables.get("project")
    if not isinstance(project, str) or not re.fullmatch(r"[a-z][a-z0-9-]{1,39}", project):
        raise ValueError("Invalid deployment project")
    if variables.get("region") != "ap-northeast-2":
        raise ValueError("Development runtime must use the intended Seoul region")
    if profile or rollout or scope == "runtime-ecr-bootstrap":
        for flag in READONLY_PROFILE_FLAGS:
            if variables.get(flag) is not False:
                raise ValueError(f"Read-only runtime activation requires {flag}=false")
    changes = plan.get("resource_changes", [])
    if not isinstance(changes, list):
        raise ValueError("Missing plan changes")
    inspection = _before_inspection(plan) if retire else None
    private = []
    for resource in changes:
        address, kind = resource.get("address"), resource.get("type")
        change = resource.get("change")
        if not isinstance(address, str) or not isinstance(kind, str) or not isinstance(change, dict):
            raise ValueError("Malformed resource change")
        actions = change.get("actions")
        if actions in (["no-op"], ["read"]):
            continue
        if not isinstance(actions, list) or not actions or any(
                action not in ("create", "update", "delete", "forget") for action in actions):
            raise ValueError("Invalid resource actions")
        after = change.get("after")
        _check_accounts(after, expected)
        if (rollout or retire) and (kind.startswith(("aws_route53", "aws_acm_")) or kind in NETWORK_TYPES):
            raise ValueError("Runtime operations must preserve public DNS, certificates and network topology")
        if retire:
            _check_accounts(change.get("before"), expected)
            _retirement_change(plan, inspection, variables, resource)
            if address in PRIVATE_DNS:
                private.append(address)
            continue
        if scope == "runtime-ecr-bootstrap":
            if (address not in REPOSITORIES or kind != "aws_ecr_repository" or actions != ["create"]
                    or not isinstance(after, dict) or after.get("name") != f"{project}-{REPOSITORIES[address]}"):
                raise ValueError("Runtime ECR bootstrap may create only the three expected repositories")
        if not advisory and address in CORE and any(a in actions for a in ("delete", "forget")):
            raise ValueError("Runtime teardown requires a separately reviewed retirement")
        if rollout and kind == "aws_security_group" and "delete" in actions:
            raise ValueError("Runtime rollout must not replace attached security groups")
        registries = after.get("service_registries") if isinstance(after, dict) else None
        before = change.get("before")
        old_registries = before.get("service_registries") if isinstance(before, dict) else None
        unknown = change.get("after_unknown") or {}
        if not isinstance(unknown, dict):
            raise ValueError("Malformed unknown resource attributes")
        is_private = kind.startswith("aws_service_discovery") or (
            kind == "aws_ecs_service" and (registries or old_registries
                or unknown.get("service_registries")))
        if not is_private:
            continue
        if advisory and not rollout:
            private.append(address)
            continue
        unchanged_registration = (
            address == "aws_ecs_service.steampipe[0]" and actions == ["update"]
            and registries and registries == old_registries
            and after.get("cluster") == before.get("cluster")
            and not _has_unknown(unknown.get("service_registries"))
        )
        if ((not rollout and not unchanged_registration)
                or address not in PRIVATE_DNS or not isinstance(after, dict)):
            raise ValueError("Private discovery changes require the scoped runtime rollout")
        if "delete" in actions:
            raise ValueError("Private discovery retirement requires a separate review")
        _validate_private(plan, variables, resource)
        private.append(address)
    return {"runtime_policy": "advisory" if advisory else "verified", "private_dns_changes": private}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("overrides", "verify-role", "verify-caller", "check-plan"))
    parser.add_argument("--target", default=os.environ.get("TARGET", ""))
    parser.add_argument("--scope", choices=SCOPES, default=os.environ.get("PLAN_SCOPE", "full") or "full")
    parser.add_argument("--advisory", choices=("true", "false"), default=os.environ.get("ADVISORY", "false"))
    args = parser.parse_args()
    try:
        account = os.environ.get("AWS_ACCOUNT_ID_DEV", "")
        if args.command == "verify-role":
            if args.target in DEV_TARGETS:
                verify_role(account, os.environ.get("CI_ROLE_ARN", ""))
            print(json.dumps({"configured_account_verified": args.target in DEV_TARGETS}))
        elif args.command == "verify-caller":
            if args.target in DEV_TARGETS:
                verify_caller(json.load(sys.stdin), account, os.environ.get("CI_ROLE_ARN", ""))
            print(json.dumps({"account_and_role_verified": args.target in DEV_TARGETS}))
        elif args.command == "check-plan":
            print(json.dumps(check_plan(json.load(sys.stdin), args.target, args.scope, account,
                                        advisory=args.advisory == "true")))
        else:
            if OVERRIDES.is_symlink():
                raise ValueError("Runtime override path must not be a symlink")
            OVERRIDES.unlink(missing_ok=True)
            rollout = os.environ.get("RUNTIME_ROLLOUT", "false")
            retire = os.environ.get("RUNTIME_RETIRE", "false")
            if rollout not in ("true", "false") or retire not in ("true", "false"):
                raise ValueError("RUNTIME_ROLLOUT and RUNTIME_RETIRE must be true or false")
            if retire == "true" and (os.environ.get("GITHUB_EVENT_NAME") != "workflow_dispatch"
                                     or os.environ.get("GITHUB_REF") != "refs/heads/dev"):
                raise ValueError("Runtime retirement requires a dev workflow_dispatch")
            value = runtime_overrides(
                args.target, os.environ.get("CI_READONLY_RUNTIME_DEV", ""), account, args.scope,
                os.environ.get("STEAMPIPE_IMAGE_DIGEST_DEV", ""), os.environ.get("WORKER_IMAGE_DIGEST_DEV", ""),
                rollout == "true", advisory=args.advisory == "true", retire=retire == "true",
            )
            with OVERRIDES.open("x") as output:
                json.dump(value, output)
            print(json.dumps({"runtime_profile_enabled": value.get("ci_runtime_profile_enabled", False),
                              "runtime_rollout": value.get("ci_runtime_rollout", False),
                              "runtime_retire": value.get("ci_runtime_retire", False)}))
    except ValueError as error:
        print(f"Runtime deployment policy refused: {error}", file=sys.stderr)
        return 1
    except (KeyError, TypeError, AttributeError, OSError):
        print("Runtime deployment policy refused invalid account, scope, image, or plan inputs.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
