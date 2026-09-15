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

    def rate_overrides(self, rate, target="dev", profile="true", account=ACCOUNT):
        return self.module.runtime_overrides(target, profile, account, "full",
            DIGEST, DIGEST, False, steampipe_fill_rate=rate)

    def test_fill_rate_is_optional_and_changes_only_the_existing_rate_variable(self):
        baseline = self.module.runtime_overrides("dev", "true", ACCOUNT, "full",
                                                 DIGEST, DIGEST, False)
        self.assertEqual(self.rate_overrides(""), baseline)
        for raw, expected in (("0.1", 0.1), ("10", 10), ("20", 20), ("1e1", 10)):
            with self.subTest(rate=raw):
                self.assertEqual(self.rate_overrides(raw),
                                 {**baseline, "steampipe_aws_fill_rate": expected})

    def test_fill_rate_requires_dev_profile_and_existing_account_validation(self):
        for target in ("main", "atomoh", "ssminji", "whchoi"):
            with self.subTest(target=target), self.assertRaisesRegex(ValueError, "CI_STEAMPIPE_AWS_FILL_RATE_DEV"):
                self.rate_overrides("10", target=target)
            self.assertNotIn("steampipe_aws_fill_rate", self.rate_overrides("", target=target))
        for profile in ("", "false"):
            with self.subTest(profile=profile), self.assertRaisesRegex(ValueError, "CI_READONLY_RUNTIME_DEV"):
                self.rate_overrides("10", profile=profile)
        with self.assertRaisesRegex(ValueError, "AWS_ACCOUNT_ID_DEV"):
            self.rate_overrides("10", account="")
        with self.assertRaisesRegex(ValueError, "Build both runtime images"):
            self.module.runtime_overrides("dev", "true", ACCOUNT, "full", "", "", False,
                                          steampipe_fill_rate="10")

    def test_fill_rate_rejects_nonfinite_out_of_range_and_non_numeric_inputs(self):
        for raw in ("NaN", "Infinity", "-inf", "1e9999", "0", "-1", "0.09",
                    "20.01", " ", "not-a-rate", "true", True, 10, None, []):
            with self.subTest(value=raw), self.assertRaisesRegex(ValueError, "CI_STEAMPIPE_AWS_FILL_RATE_DEV"):
                self.rate_overrides(raw)

    def test_fill_rate_requires_full_scope_and_does_not_change_bootstrap_defaults(self):
        for scope in ("ecr-bootstrap", "runtime-ecr-bootstrap"):
            with self.subTest(scope=scope):
                with self.assertRaisesRegex(ValueError, "full dev scope"):
                    self.module.runtime_overrides("dev", "true", ACCOUNT, scope,
                        DIGEST, DIGEST, False, steampipe_fill_rate="10")
                baseline = self.module.runtime_overrides("dev", "true", ACCOUNT, scope,
                    DIGEST, DIGEST, False)
                self.assertNotIn("steampipe_aws_fill_rate", baseline)

    def test_actual_plan_step_scopes_the_rate_to_dev_and_refuses_invalid_input(self):
        from test_ci_deployment_workflows import DeploymentWorkflowTests, workflow_step
        step = workflow_step("terraform.yml", "plan", "Configure development runtime profile")
        harness = DeploymentWorkflowTests()
        cases = [("dev", "true", "", True, None), ("dev", "true", "10", True, 10),
                 ("dev", "false", "10", False, None), ("dev", "", "10", False, None),
                 ("dev", "true", "NaN", False, None), ("dev", "true", "20.01", False, None)]
        cases += [(target, "true", "invalid-unused-setting", True, None)
                  for target in ("main", "atomoh", "ssminji", "whchoi")]
        for target, profile, rate, allowed, expected in cases:
            with self.subTest(target=target, profile=profile, rate=rate):
                result, calls = harness.run_step([step], TARGET=target,
                    files={"ci-runtime.auto.tfvars.json": '{"steampipe_aws_fill_rate":15}'}, context={
                    "github": {"event_name": "pull_request"}, "inputs": {},
                    "vars": {"CI_READONLY_RUNTIME_DEV": profile,
                             "CI_STEAMPIPE_AWS_FILL_RATE_DEV": rate},
                })
                self.assertEqual(result.returncode == 0, allowed, result.stderr)
                self.assertEqual(calls, [])  # Override preparation makes no provider call.
                if allowed:
                    values = json.loads(result.files["ci-runtime.auto.tfvars.json"])
                    self.assertEqual(values.get("steampipe_aws_fill_rate"), expected)
                else:
                    self.assertIn("CI_STEAMPIPE_AWS_FILL_RATE_DEV", result.stderr)
                    self.assertNotIn("ci-runtime.auto.tfvars.json", result.files)

    def test_rate_scope_uses_dispatch_inputs_without_inherited_sibling_environment(self):
        from test_ci_deployment_workflows import DeploymentWorkflowTests, workflow_step, expression
        step = workflow_step("terraform.yml", "plan", "Configure development runtime profile")
        harness = DeploymentWorkflowTests()
        cases = [("dev", {}, "10", 10), ("dev", {"plan_scope": "full"}, "10", 10)]
        cases += [("dev", {"plan_scope": scope}, "invalid-unused", None)
                  for scope in ("ecr-bootstrap", "runtime-ecr-bootstrap")]
        cases += [(target, {"plan_scope": "full"}, "invalid-unused", None)
                  for target in ("main", "atomoh", "ssminji", "whchoi")]
        for target, inputs, rate, expected in cases:
            with self.subTest(target=target, inputs=inputs):
                context = {"github": {"event_name": "workflow_dispatch"},
                           "inputs": {"runtime_rollout": False, **inputs},
                           "env": {"TARGET": target}, "vars": {
                               "CI_READONLY_RUNTIME_DEV": "true", "CI_STEAMPIPE_AWS_FILL_RATE_DEV": rate,
                               "STEAMPIPE_IMAGE_DIGEST_DEV": DIGEST, "WORKER_IMAGE_DIGEST_DEV": DIGEST}}
                # GitHub resolves the whole step env map against inherited context, not siblings.
                resolved = {key: expression(value, context) for key, value in step["env"].items()}
                self.assertEqual(resolved["CI_STEAMPIPE_AWS_FILL_RATE_DEV"], rate if expected else "")
                result, calls = harness.run_step([step], TARGET=target, PLAN_SCOPE="", context=context)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(calls, [])
                self.assertEqual(json.loads(result.files["ci-runtime.auto.tfvars.json"])
                                 .get("steampipe_aws_fill_rate"), expected)

    def test_saved_plan_keeps_the_rate_when_later_configuration_changes(self):
        # Real provider-free Terraform input resolution: do not invent an asset format.
        for saved, rate, expected in ((None, "", 2), (3, "", 3), (3, "10", 10)):
            with self.subTest(saved=saved, rate=rate), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                values = self.rate_overrides(rate)
                declarations = [
                    'variable "steampipe_aws_fill_rate" {\n type = number\n default = 2\n}',
                    'output "rate" { value = var.steampipe_aws_fill_rate }',
                ]
                declarations += [f'variable "{key}" {{ default = {json.dumps(value)} }}'
                                 for key, value in values.items() if key != "steampipe_aws_fill_rate"]
                (root / "main.tf").write_text("\n".join(declarations))
                if saved is not None:
                    (root / "terraform.tfvars.json").write_text(json.dumps({"steampipe_aws_fill_rate": saved}))
                overrides = root / "ci-runtime.auto.tfvars.json"
                overrides.write_text(json.dumps(values))
                env = {k: v for k, v in os.environ.items() if not k.startswith(("AWS_", "TF_"))}
                env.update(CHECKPOINT_DISABLE="1", TF_CLI_CONFIG_FILE="/dev/null",
                           AWS_CONFIG_FILE="/dev/null", AWS_SHARED_CREDENTIALS_FILE="/dev/null",
                           AWS_EC2_METADATA_DISABLED="true")
                for args in (["init", "-backend=false", "-input=false", "-no-color"],
                             ["plan", "-input=false", "-no-color", "-out=tfplan"]):
                    result = subprocess.run(["terraform", *args], cwd=root, env=env,
                                            capture_output=True, text=True, timeout=15)
                    self.assertEqual(result.returncode, 0, result.stderr)
                overrides.write_text('{"steampipe_aws_fill_rate":20}')
                env["CI_STEAMPIPE_AWS_FILL_RATE_DEV"] = "20"
                snapshot = json.loads(subprocess.check_output(
                    ["terraform", "show", "-json", "tfplan"], cwd=root, env=env, timeout=15))
                self.assertEqual(snapshot["variables"]["steampipe_aws_fill_rate"]["value"], expected)
                self.assertEqual(snapshot["planned_values"]["outputs"]["rate"]["value"], expected)

    def test_bootstrap_enables_only_existing_core_flags_without_fake_images(self):
        value = self.module.runtime_overrides("dev", "true", ACCOUNT, "runtime-ecr-bootstrap", "", "", False)
        self.assertEqual(value, {
            "agentcore_enabled": True, "workers_enabled": True, "steampipe_enabled": True,
            "inventory_host_only": True, "ci_runtime_profile_enabled": True,
            "ci_runtime_rollout": False,
        })

    def test_dedicated_readiness_override_is_independent_and_tristate(self):
        for profile in ("", "false", "true"):
            for setting, expected in (("", None), ("true", True), ("false", False)):
                with self.subTest(profile=profile, setting=setting):
                    values = self.module.runtime_overrides("dev", profile, ACCOUNT, "full",
                        DIGEST, DIGEST, False, readiness=setting)
                    if expected is None:
                        self.assertNotIn("ci_readiness_enabled", values)
                    else:
                        self.assertIs(values["ci_readiness_enabled"], expected)
        for setting in ("yes", "TRUE", " false ", "0"):
            with self.assertRaisesRegex(ValueError, "CI_READINESS_ENABLED_DEV"):
                self.module.runtime_overrides("dev", "", ACCOUNT, "full", "", "", False,
                                              readiness=setting)
        for target in ("main", "atomoh", "ssminji", "whchoi"):
            with self.assertRaisesRegex(ValueError, "readiness|READINESS"):
                self.module.runtime_overrides(target, "", ACCOUNT, "full", "", "", False,
                                              readiness="true")

    def test_actual_workflow_wires_only_the_dedicated_dev_readiness_setting(self):
        from test_ci_deployment_workflows import DeploymentWorkflowTests, workflow_step
        step = workflow_step("terraform.yml", "plan", "Configure development runtime profile")
        harness = DeploymentWorkflowTests()
        for target, flag, profile, expected in [
            ("dev", "", "true", None), ("dev", "true", "", True),
            ("dev", "false", "true", False), ("main", "true", "true", None),
            ("atomoh", "true", "true", None),
        ]:
            with self.subTest(target=target, flag=flag, profile=profile):
                result, _ = harness.run_step([step], TARGET=target, context={
                    "github": {"event_name": "pull_request"},
                    "vars": {"CI_READINESS_ENABLED_DEV": flag, "CI_READONLY_RUNTIME_DEV": profile},
                    "inputs": {},
                })
                self.assertEqual(result.returncode, 0, result.stderr)
                values = json.loads(result.files["ci-runtime.auto.tfvars.json"])
                if expected is None:
                    self.assertNotIn("ci_readiness_enabled", values)
                else:
                    self.assertIs(values["ci_readiness_enabled"], expected)
        result, _ = harness.run_step([step], TARGET="dev", context={
            "github": {"event_name": "pull_request"},
            "vars": {"CI_READINESS_ENABLED_DEV": "invalid"}, "inputs": {},
        })
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("CI_READINESS_ENABLED_DEV", result.stderr)
        self.assertNotIn("ci-runtime.auto.tfvars.json", result.files)

    def test_unset_preserves_tfvars_and_explicit_false_revokes_its_true_value(self):
        # Terraform's real input resolution, without providers/backend/AWS, catches precedence regressions.
        for setting, saved, expected in [("", None, False), ("", True, True), ("", False, False),
                                         ("false", True, False), ("true", False, True)]:
            with self.subTest(setting=setting, saved=saved), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                root.joinpath("main.tf").write_text(
                    'variable "ci_readiness_enabled" { default = false }\n'
                    'variable "ci_runtime_profile_enabled" { default = false }\n'
                    'variable "ci_runtime_rollout" { default = false }\n')
                if saved is not None:
                    root.joinpath("terraform.tfvars.json").write_text(json.dumps({"ci_readiness_enabled": saved}))
                values = self.module.runtime_overrides("dev", "", ACCOUNT, "full", "", "", False,
                                                      readiness=setting)
                root.joinpath("ci-runtime.auto.tfvars.json").write_text(json.dumps(values))
                env = {k: v for k, v in os.environ.items() if not k.startswith(("AWS_", "TF_"))}
                env.update(CHECKPOINT_DISABLE="1", AWS_EC2_METADATA_DISABLED="true",
                           AWS_CONFIG_FILE="/dev/null", AWS_SHARED_CREDENTIALS_FILE="/dev/null",
                           TF_CLI_CONFIG_FILE="/dev/null")
                result = subprocess.run(["terraform", "console"], cwd=root, env=env,
                    input="var.ci_readiness_enabled\n", capture_output=True, text=True, timeout=15)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.strip(), str(expected).lower())

    def test_explicit_plan_override_follows_varfiles_but_unset_adds_no_override(self):
        from test_ci_deployment_workflows import DeploymentWorkflowTests, workflow_step
        step = workflow_step("terraform.yml", "plan", "terraform plan")
        harness = DeploymentWorkflowTests()
        for flag in ("", "true", "false"):
            result, commands = harness.run_step([step], TARGET="dev",
                TF_VAR_ci_migrations_enabled="false",
                files={"ci-deployment.tfvars.json": '{"ci_readiness_enabled":true}'},
                context={"github": {"event_name": "workflow_dispatch"},
                         "inputs": {"plan_scope": "full"}, "vars": {"CI_READINESS_ENABLED_DEV": flag}})
            self.assertEqual(result.returncode, 0, result.stderr)
            argv = next(c for c in commands if c[:2] == ["terraform", "plan"])
            overrides = [a for a in argv if a.startswith("-var=ci_readiness_enabled=")]
            self.assertEqual(overrides, [f"-var=ci_readiness_enabled={flag}"] if flag else [])
            if flag:
                self.assertGreater(argv.index(overrides[0]), argv.index("-var-file=ci-deployment.tfvars.json"))

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

    def test_real_saved_plan_cli_readiness_booleans_keep_their_meaning(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            root.joinpath("main.tf").write_text(
                'variable "ci_readiness_enabled" {\n type = bool\n default = false\n nullable = false\n}\n'
                'output "effective" { value = var.ci_readiness_enabled }\n')
            subprocess.run(["terraform", "init", "-backend=false", "-input=false", "-no-color"],
                           cwd=root, check=True, capture_output=True)
            for literal in ("true", "false"):
                subprocess.run(["terraform", "plan", "-input=false", "-no-color", "-out=plan",
                                f"-var=ci_readiness_enabled={literal}"], cwd=root, check=True, capture_output=True)
                actual = json.loads(subprocess.check_output(["terraform", "show", "-json", "plan"], cwd=root))
                self.assertIs(actual["planned_values"]["outputs"]["effective"]["value"], literal == "true")
                plan = self.plan()
                plan["variables"]["ci_readiness_enabled"] = actual["variables"]["ci_readiness_enabled"]
                self.assertEqual(self.module.check_plan(plan, "dev", "full", ACCOUNT)["runtime_policy"], "verified")
                if literal == "true":
                    with self.assertRaisesRegex(ValueError, "readiness.*dev-only"):
                        self.module.check_plan(plan, "main", "full", ACCOUNT)
                else:
                    self.assertEqual(self.module.check_plan(plan, "main", "full", ACCOUNT)["runtime_policy"], "not_applicable")

    def test_saved_readiness_rejects_noncanonical_or_nonboolean_values(self):
        for value in (None, 0, 1, [], {}, "TRUE", "False", " true ", "1", ""):
            with self.subTest(value=value):
                plan = self.plan()
                plan["variables"]["ci_readiness_enabled"] = {"value": value}
                with self.assertRaisesRegex(ValueError, "metadata must be boolean"):
                    self.module.check_plan(plan, "dev", "full", ACCOUNT)

    def test_readiness_is_public_dev_only_even_without_the_runtime_profile(self):
        plan = self.plan()
        plan["variables"]["ci_readiness_enabled"] = {"value": True}
        self.module.check_plan(plan, "dev", "full", ACCOUNT)
        for target in ("main", "atomoh", "ssminji", "whchoi"):
            with self.assertRaisesRegex(ValueError, "readiness.*dev-only"):
                self.module.check_plan(plan, target, "full", ACCOUNT)

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

    def test_rate_task_revision_does_not_require_weakening_core_or_dns_guards(self):
        from ci_dns_policy import check_plan as check_dns_plan
        registry = f"arn:aws:servicediscovery:ap-northeast-2:{ACCOUNT}:service/srv-owned"
        cluster = f"arn:aws:ecs:ap-northeast-2:{ACCOUNT}:cluster/awsops-dev"
        task_prefix = f"arn:aws:ecs:ap-northeast-2:{ACCOUNT}:task-definition/awsops-dev-steampipe:"
        task = self.change("aws_ecs_task_definition.steampipe[0]", "aws_ecs_task_definition",
                           {"arn": task_prefix + "2", "container_definitions": json.dumps([{
                               "name": "steampipe", "environment": [
                                   {"name": "STEAMPIPE_AWS_FILL_RATE", "value": "10"}]}])},
                           ["delete", "create"])
        service = self.change("aws_ecs_service.steampipe[0]", "aws_ecs_service", {
            "name": "awsops-dev-steampipe", "cluster": cluster,
            "service_registries": [{"registry_arn": registry}], "task_definition": task_prefix + "2",
        }, ["update"])
        service["change"]["before"] = {**service["change"]["after"], "task_definition": task_prefix + "1"}
        plan = self.plan([task, service], profile=True)
        plan["variables"]["steampipe_aws_fill_rate"] = {"value": 10}
        plan["planned_values"]["root_module"]["resources"] += [
            {"address": "aws_ecs_cluster.main", "values": {"arn": cluster, "name": "awsops-dev"}},
            {"address": "aws_service_discovery_private_dns_namespace.main[0]",
             "values": {"id": "ns-owned", "name": "awsops-dev.internal", "vpc": "vpc-0123"}},
            {"address": "aws_service_discovery_service.steampipe[0]", "values": {
                "name": "steampipe", "arn": registry, "dns_config": [{"namespace_id": "ns-owned"}]}},
        ]
        self.assertEqual(self.module.check_plan(plan, "dev", "full", ACCOUNT)["runtime_policy"], "verified")
        # A service roll still has private discovery effects: the new knob grants no DNS bypass.
        with self.assertRaisesRegex(ValueError, "DNS change prohibited"):
            check_dns_plan(plan, False, "full", target="dev")
        for actions in (["delete", "create"], ["create", "delete"], ["forget"]):
            rejected = copy.deepcopy(plan)
            rejected["resource_changes"][1]["change"]["actions"] = actions
            with self.assertRaisesRegex(ValueError, "teardown"):
                self.module.check_plan(rejected, "dev", "full", ACCOUNT)

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
