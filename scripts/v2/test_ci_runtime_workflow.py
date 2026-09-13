"""Deployment permission/account gates and saved assets are required, not optional."""
from pathlib import Path
import unittest

import yaml


class RuntimeWorkflowTests(unittest.TestCase):
    def workflow(self):
        path = Path(__file__).resolve().parents[2] / ".github/workflows/terraform.yml"
        return yaml.safe_load(path.read_text())

    def test_plan_and_apply_validate_intended_role_before_assuming_it(self):
        for name in ("plan", "apply"):
            job = self.workflow()["jobs"][name]
            self.assertIn("AWS_ACCOUNT_ID_DEV", job["env"])
            steps = job["steps"]
            checks = [i for i, step in enumerate(steps) if "ci_runtime_policy.py verify-role" in step.get("run", "")]
            configured = [i for i, step in enumerate(steps) if step.get("uses", "").startswith("aws-actions/configure-aws-credentials")]
            self.assertEqual(len(checks), 1)
            self.assertLess(checks[0], configured[0])
            callers = [i for i, step in enumerate(steps) if "ci_runtime_policy.py verify-caller" in step.get("run", "")]
            self.assertEqual(len(callers), 1)
            self.assertGreater(callers[0], configured[0])

    def test_plan_publishes_only_encrypted_plan_and_bound_assets(self):
        steps = self.workflow()["jobs"]["plan"]["steps"]
        text = "\n".join(step.get("run", "") for step in steps)
        self.assertIn("ci_tf_assets.py prepare", text)
        self.assertIn("ci_tf_assets.py pack", text)
        self.assertIn("-in tfassets.tar.gz -out tfassets.enc", text)
        upload = next(step for step in steps if step.get("uses", "").startswith("actions/upload-artifact"))
        self.assertEqual(set(upload["with"]["path"].split()), {
            "terraform/foundation/tfplan.enc", "terraform/foundation/tfassets.enc",
        })

    def test_apply_verifies_assets_and_runtime_scope_before_any_terraform_apply(self):
        steps = self.workflow()["jobs"]["apply"]["steps"]
        restore = [i for i, step in enumerate(steps) if "ci_tf_assets.py restore" in step.get("run", "")]
        apply = [i for i, step in enumerate(steps) if "terraform apply -input=false tfplan" in step.get("run", "")]
        self.assertEqual(len(restore), 1)
        self.assertEqual(len(apply), 1)
        self.assertLess(restore[0], apply[0])
        self.assertIn("ci_runtime_policy.py check-plan", steps[apply[0]]["run"])
        self.assertEqual(steps[apply[0]]["env"]["AWSOPS_CI_ASSETS_READY"], "1")
        self.assertNotIn("-auto-approve", steps[apply[0]]["run"])

    def test_sensitive_and_generated_files_are_cleaned_even_on_failure(self):
        for name in ("plan", "apply"):
            cleanup = self.workflow()["jobs"][name]["steps"][-1]
            self.assertEqual(cleanup["if"], "always()")
            for filename in ("tfassets.tar.gz", "tfassets.enc", "tfplan"):
                self.assertIn(filename, cleanup["run"])
        self.assertIn("ci-runtime.auto.tfvars.json",
                      self.workflow()["jobs"]["plan"]["steps"][-1]["run"])
