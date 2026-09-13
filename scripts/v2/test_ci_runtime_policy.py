"""Runtime activation is account-bound, digest-pinned and private-DNS scoped."""
import importlib.util
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

def load():
    path = Path(__file__).with_name("ci_runtime_policy.py")
    spec = importlib.util.spec_from_file_location("ci_runtime_policy", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

ACCOUNT = "012345678901"
DIGEST = "sha256:" + "a" * 64

class RuntimePolicyTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(Path(__file__).with_name("ci_runtime_policy.py").is_file(),
                        "Runtime activation policy is not implemented")
        self.module = load()

    def test_profile_is_opt_in_and_does_not_modify_other_branches(self):
        self.assertEqual(self.module.runtime_overrides("main", "true", "", "full", "", "", False), {})
        self.assertEqual(self.module.runtime_overrides("dev", "", ACCOUNT, "full", "", "", False),
                         {"ci_runtime_profile_enabled": False, "ci_runtime_rollout": False})
        self.assertEqual(self.module.runtime_overrides("dev", "false", ACCOUNT, "full", "", "", False),
                         {"ci_runtime_profile_enabled": False, "ci_runtime_rollout": False})

    def test_bootstrap_enables_only_existing_core_flags_without_fake_images(self):
        value = self.module.runtime_overrides("dev", "true", ACCOUNT, "runtime-ecr-bootstrap", "", "", False)
        self.assertEqual(value, {
            "agentcore_enabled": True, "workers_enabled": True, "steampipe_enabled": True,
            "inventory_host_only": True, "ci_readiness_enabled": True, "ci_runtime_profile_enabled": True,
            "ci_runtime_rollout": False,
        })

    def test_full_activation_requires_both_immutable_digests(self):
        for first, second in (("", DIGEST), (DIGEST, ""), ("latest", DIGEST)):
            with self.assertRaises(ValueError):
                self.module.runtime_overrides("dev", "true", ACCOUNT, "full", first, second, True)
        value = self.module.runtime_overrides("dev", "true", ACCOUNT, "full", DIGEST, DIGEST, True)
        self.assertEqual(value["steampipe_image_digest"], DIGEST)
        self.assertEqual(value["worker_image_digest"], DIGEST)
        self.assertTrue(value["ci_runtime_rollout"])

    def test_advisory_plans_are_honest_about_missing_images(self):
        value = self.module.runtime_overrides("dev", "true", ACCOUNT, "full", "", "", False, advisory=True)
        self.assertNotIn("steampipe_image_digest", value)
        self.assertFalse(value["ci_runtime_rollout"])

    def test_invalid_profile_account_or_scope_fails(self):
        for profile, account, scope in (("yes", ACCOUNT, "full"), ("true", "", "full"),
                                        ("true", "61525506239", "full"), ("true", ACCOUNT, "unknown")):
            with self.assertRaises(ValueError):
                self.module.runtime_overrides("dev", profile, account, scope, DIGEST, DIGEST, False)

    def test_caller_must_match_independent_account_and_configured_role(self):
        role = f"arn:aws:iam::{ACCOUNT}:role/team/CustomDeployRole"
        caller = {"Account": ACCOUNT, "Arn": f"arn:aws:sts::{ACCOUNT}:assumed-role/CustomDeployRole/GitHubActions"}
        self.module.verify_caller(caller, ACCOUNT, role)
        self.module.verify_caller(caller, ACCOUNT, " " + role + "\n")
        with self.assertRaises(ValueError):
            self.module.verify_role(ACCOUNT, role.replace(ACCOUNT, "999999999999"))
        for bad in ({"Account": "999999999999", "Arn": caller["Arn"]},
                    {"Account": ACCOUNT, "Arn": caller["Arn"].replace("CustomDeployRole/", "Admin/")},
                    {"Account": ACCOUNT, "Arn": "not-an-arn"}):
            with self.assertRaises(ValueError):
                self.module.verify_caller(bad, ACCOUNT, role)
        for target in ("dev", "atomoh", "ssminji", "whchoi"):
            result = subprocess.run([sys.executable, str(Path(self.module.__file__)), "verify-role"],
                env={**os.environ, "TARGET": target, "AWS_ACCOUNT_ID_DEV": "",
                     "CI_ROLE_ARN": role}, capture_output=True)
            self.assertNotEqual(result.returncode, 0, target)

    def plan(self, changes=(), rollout=False, profile=False):
        values = {
            "project": "awsops-dev", "region": "ap-northeast-2",
            "ci_runtime_rollout": rollout, "ci_domain_rollout": False,
            "ci_runtime_profile_enabled": profile,
            "agentcore_enabled": False, "workers_enabled": False,
            "steampipe_enabled": False, "inventory_host_only": False, "ci_readiness_enabled": False,
            "remediation_enabled": False, "integrations_write_enabled": False,
            "rca_writeback_enabled": False, "diagnosis_notify_enabled": False,
            "create_network": True,
        }
        return {"format_version": "1.2", "variables": {k: {"value": v} for k, v in values.items()},
                "planned_values": {"root_module": {"resources": [
                    {"address": "aws_vpc.main[0]", "values": {"id": "vpc-0123"}}
                ]}},
                "resource_changes": list(changes)}

    def change(self, address, kind, after, actions=None):
        return {"address": address, "type": kind,
                "change": {"actions": actions or ["create"], "before": None, "after": after, "after_unknown": {}}}

    def test_repository_bootstrap_cannot_mutate_any_other_resource(self):
        changes = [self.change("aws_ecr_repository.steampipe[0]", "aws_ecr_repository",
                               {"name": "awsops-dev-steampipe"})]
        self.module.check_plan(self.plan(changes), "dev", "runtime-ecr-bootstrap", ACCOUNT)
        changes.append(self.change("aws_lambda_function.inv_sync[0]", "aws_lambda_function", {}))
        with self.assertRaises(ValueError):
            self.module.check_plan(self.plan(changes), "dev", "runtime-ecr-bootstrap", ACCOUNT)

    def test_frozen_or_unrequested_notification_flags_fail(self):
        for flag in ("remediation_enabled", "integrations_write_enabled", "rca_writeback_enabled",
                     "diagnosis_notify_enabled"):
            plan = self.plan(rollout=True)
            plan["variables"][flag]["value"] = True
            with self.assertRaises(ValueError):
                self.module.check_plan(plan, "dev", "full", ACCOUNT)

    def test_active_profile_checks_readonly_flags_without_a_rollout_marker(self):
        for flag in self.module.READONLY_PROFILE_FLAGS:
            for advisory in (False, True):
                plan = self.plan(profile=True)
                plan["variables"][flag]["value"] = True
                with self.assertRaises(ValueError):
                    self.module.check_plan(plan, "dev", "full", ACCOUNT, advisory=advisory)
        plan = self.plan(profile=True)
        self.module.check_plan(plan, "dev", "full", ACCOUNT)

    def test_direct_dev_host_only_requires_the_verified_profile(self):
        plan = self.plan()
        plan["variables"]["inventory_host_only"]["value"] = True
        with self.assertRaises(ValueError):
            self.module.check_plan(plan, "dev", "full", ACCOUNT)
        plan["variables"]["ci_runtime_profile_enabled"]["value"] = True
        self.module.check_plan(plan, "dev", "full", ACCOUNT)

    def test_retirement_is_unsupported_in_saved_plans_and_workflow_inputs(self):
        plan = self.plan()
        plan["variables"]["ci_runtime_retire"] = {"value": True}
        with self.assertRaisesRegex(ValueError, "not supported"):
            self.module.check_plan(plan, "dev", "full", ACCOUNT)
        workflow = (Path(__file__).resolve().parents[2] / ".github/workflows/terraform.yml").read_text()
        self.assertNotIn("      runtime_retire:", workflow)

    def test_preview_rollout_is_explicit_and_does_not_force_the_dev_profile(self):
        change = self.change("aws_service_discovery_private_dns_namespace.main[0]",
                             "aws_service_discovery_private_dns_namespace",
                             {"name": "awsops-dev.internal", "vpc": "vpc-0123"})
        for target in ("atomoh", "ssminji", "whchoi"):
            value = self.module.runtime_overrides(target, "true", ACCOUNT, "full", "", "", True)
            self.assertEqual(value, {"ci_runtime_profile_enabled": False,
                                    "ci_runtime_rollout": True})
            with self.assertRaises(ValueError):
                self.module.check_plan(self.plan([change]), target, "full", ACCOUNT)
            self.module.check_plan(self.plan([change], rollout=True), target, "full", ACCOUNT)
            with self.assertRaises(ValueError):
                self.module.runtime_overrides(target, "", ACCOUNT, "full", "", "", True, advisory=True)

    def test_ordinary_plans_preserve_governed_notifications_and_empty_advisory_plans(self):
        plan = self.plan()
        plan["variables"]["diagnosis_notify_enabled"]["value"] = True
        plan.pop("resource_changes")
        self.assertEqual(self.module.check_plan(plan, "dev", "full", ACCOUNT)["runtime_policy"], "verified")
        self.assertEqual(self.module.check_plan(plan, "dev", "full", ACCOUNT, advisory=True)["runtime_policy"], "advisory")

    def test_private_namespace_requires_explicit_rollout_and_exact_name(self):
        change = self.change("aws_service_discovery_private_dns_namespace.main[0]",
                             "aws_service_discovery_private_dns_namespace",
                             {"name": "awsops-dev.internal", "vpc": "vpc-0123"})
        with self.assertRaises(ValueError):
            self.module.check_plan(self.plan([change]), "dev", "full", ACCOUNT)
        result = self.module.check_plan(self.plan([change], True), "dev", "full", ACCOUNT)
        self.assertEqual(result["private_dns_changes"], [change["address"]])
        change["change"]["after"]["name"] = "other.internal"
        with self.assertRaises(ValueError):
            self.module.check_plan(self.plan([change], True), "dev", "full", ACCOUNT)
        change["change"]["after"].update(name="awsops-dev.internal", vpc="vpc-9999")
        with self.assertRaises(ValueError):
            self.module.check_plan(self.plan([change], True), "dev", "full", ACCOUNT)

    def test_runtime_rollout_never_authorizes_public_dns_or_certificate_changes(self):
        for kind in ("aws_route53_record", "aws_acm_certificate", "aws_route53_zone"):
            change = self.change("unexpected.resource", kind, {})
            with self.assertRaises(ValueError):
                self.module.check_plan(self.plan([change], True), "dev", "full", ACCOUNT)

    def test_service_discovery_cannot_register_an_unrelated_ecs_service(self):
        change = self.change("aws_ecs_service.other", "aws_ecs_service",
                             {"name": "other", "service_registries": [{"registry_arn": "arn:any"}]})
        with self.assertRaises(ValueError):
            self.module.check_plan(self.plan([change], True), "dev", "full", ACCOUNT)

    def test_discovery_service_must_bind_to_the_owned_namespace(self):
        change = self.change("aws_service_discovery_service.steampipe[0]", "aws_service_discovery_service",
                             {"name": "steampipe", "dns_config": [{"namespace_id": "ns-foreign"}]})
        plan = self.plan([change], True)
        plan["planned_values"]["root_module"]["resources"].append({
            "address": "aws_service_discovery_private_dns_namespace.main[0]",
            "values": {"id": "ns-owned", "name": "awsops-dev.internal", "vpc": "vpc-0123"},
        })
        with self.assertRaises(ValueError):
            self.module.check_plan(plan, "dev", "full", ACCOUNT)
        change["change"]["after"]["dns_config"][0]["namespace_id"] = "ns-owned"
        self.module.check_plan(plan, "dev", "full", ACCOUNT)

    def test_new_namespace_binding_requires_the_actual_terraform_reference(self):
        namespace = self.change("aws_service_discovery_private_dns_namespace.main[0]",
                                "aws_service_discovery_private_dns_namespace",
                                {"name": "awsops-dev.internal", "vpc": "vpc-0123"})
        service = self.change("aws_service_discovery_service.steampipe[0]", "aws_service_discovery_service",
                              {"name": "steampipe", "dns_config": [{"namespace_id": None}]})
        service["change"]["after_unknown"] = {"dns_config": [{"namespace_id": True}]}
        plan = self.plan([namespace, service], True)
        with self.assertRaises(ValueError):
            self.module.check_plan(plan, "dev", "full", ACCOUNT)
        plan["configuration"] = {"root_module": {"resources": [{
            "address": "aws_service_discovery_service.steampipe",
            "expressions": {"dns_config": [{"namespace_id": {"references": [
                "aws_service_discovery_private_dns_namespace.main[0].id",
                "aws_service_discovery_private_dns_namespace.main[0]",
                "aws_service_discovery_private_dns_namespace.main",
            ]}}]},
        }]}}
        self.module.check_plan(plan, "dev", "full", ACCOUNT)

    def test_ecs_registration_cannot_point_at_another_owned_account_service(self):
        arn = f"arn:aws:servicediscovery:ap-northeast-2:{ACCOUNT}:service/srv-owned"
        cluster = f"arn:aws:ecs:ap-northeast-2:{ACCOUNT}:cluster/awsops-dev"
        service = self.change("aws_ecs_service.steampipe[0]", "aws_ecs_service", {
            "name": "awsops-dev-steampipe", "cluster": cluster,
            "service_registries": [{"registry_arn": arn.replace("srv-owned", "srv-foreign")}],
        })
        plan = self.plan([service], True)
        plan["planned_values"]["root_module"]["resources"] += [
            {"address": "aws_ecs_cluster.main", "values": {"arn": cluster, "name": "awsops-dev"}},
            {"address": "aws_service_discovery_private_dns_namespace.main[0]",
             "values": {"id": "ns-owned", "name": "awsops-dev.internal", "vpc": "vpc-0123"}},
            {"address": "aws_service_discovery_service.steampipe[0]",
             "values": {"name": "steampipe", "arn": arn, "dns_config": [{"namespace_id": "ns-owned"}]}},
        ]
        with self.assertRaises(ValueError):
            self.module.check_plan(plan, "dev", "full", ACCOUNT)
        service["change"]["after"]["service_registries"][0]["registry_arn"] = arn
        self.module.check_plan(plan, "dev", "full", ACCOUNT)
        # A task revision with the same owned registration needs DNS permission from
        # the separate DNS policy, but not another activation-profile transition.
        plan["variables"]["ci_runtime_rollout"]["value"] = False
        service["change"]["actions"] = ["update"]
        service["change"]["before"] = dict(service["change"]["after"])
        self.module.check_plan(plan, "dev", "full", ACCOUNT)
        self.module.check_plan(plan, "atomoh", "full", ACCOUNT)
        service["change"]["after"]["service_registries"] = [{"registry_arn": arn + "-foreign"}]
        for target in ("dev", "atomoh", "ssminji", "whchoi"):
            with self.assertRaises(ValueError):
                self.module.check_plan(plan, target, "full", ACCOUNT)

    def test_runtime_rollout_cannot_replace_attached_groups_or_change_vpc(self):
        for kind, actions in (("aws_security_group", ["delete", "create"]), ("aws_vpc", ["update"])):
            with self.assertRaises(ValueError):
                self.module.check_plan(self.plan([self.change("resource.test", kind, {}, actions)], True),
                                       "dev", "full", ACCOUNT)

    def test_unintentional_runtime_teardown_and_foreign_account_are_rejected(self):
        delete = self.change("aws_lambda_function.inv_sync[0]", "aws_lambda_function", None, ["delete"])
        with self.assertRaises(ValueError):
            self.module.check_plan(self.plan([delete]), "dev", "full", ACCOUNT)
        foreign = self.change("aws_ecr_repository.worker[0]", "aws_ecr_repository",
                              {"name": "awsops-dev-worker", "arn": "arn:aws:ecr:ap-northeast-2:999999999999:repository/x"})
        with self.assertRaises(ValueError):
            self.module.check_plan(self.plan([foreign]), "dev", "runtime-ecr-bootstrap", ACCOUNT)
        for actions in (["delete", "create"], ["create", "delete"], ["forget"]):
            for address in self.module.CORE:
                with self.assertRaises(ValueError):
                    self.module.check_plan(self.plan([self.change(address, "aws_resource", {}, actions)]),
                                           "dev", "full", ACCOUNT)
        for target in ("atomoh", "ssminji", "whchoi"):
            with self.assertRaises(ValueError):
                self.module.check_plan(self.plan([foreign]), target, "full", ACCOUNT)

    def test_embedded_arns_check_every_account_without_rejecting_wildcards(self):
        own = f"arn:aws:iam::{ACCOUNT}:role/owned"
        foreign = "arn:aws:iam::999999999999:role/foreign"
        for field in ("policy", "assume_role_policy", "container_definitions", "definition"):
            for value in (json.dumps({"Resource": [own, foreign]}), f"prefix {own} then {foreign}"):
                change = self.change("aws_iam_role_policy.fixture", "aws_iam_role_policy", {field: value})
                with self.assertRaisesRegex(ValueError, "different account"):
                    self.module.check_plan(self.plan([change]), "dev", "full", ACCOUNT)
        safe = json.dumps({"Resource": [own, "arn:aws:iam::*:role/AWSopsReadOnlyRole",
                                       "arn:aws:iam::aws:policy/ReadOnlyAccess"]})
        change = self.change("aws_iam_role_policy.fixture", "aws_iam_role_policy", {"policy": safe})
        self.module.check_plan(self.plan([change]), "dev", "full", ACCOUNT)
