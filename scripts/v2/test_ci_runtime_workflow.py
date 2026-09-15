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
        uploads = {step["with"]["name"]: step for step in steps
                   if step.get("uses", "").startswith("actions/upload-artifact")}
        failure_name = "terraform-failure-plan-${{ github.run_attempt }}"
        handoff_name = "tfplan-${{ github.run_attempt }}"
        self.assertEqual(set(uploads), {handoff_name, failure_name})
        upload = uploads[handoff_name]
        self.assertIn("github.event_name == 'workflow_dispatch'", upload["if"])
        self.assertEqual(set(upload["with"]["path"].split()), {
            "terraform/foundation/tfplan.enc", "terraform/foundation/tfassets.enc",
        })
        failure = uploads[failure_name]
        self.assertIn("failure()", failure["if"])
        self.assertIn("cancelled()", failure["if"])
        self.assertIn("github.event_name == 'workflow_dispatch'", failure["if"])
        self.assertEqual(failure["with"]["path"], "${{ steps.private_plan.outputs.diagnostics_file }}")
        self.assertTrue(failure["with"]["include-hidden-files"])
        self.assertEqual(failure["with"]["retention-days"], 5)

    def test_apply_verifies_assets_and_runtime_scope_before_any_terraform_apply(self):
        steps = self.workflow()["jobs"]["apply"]["steps"]
        restore = [i for i, step in enumerate(steps) if "ci_private_plan.py restore" in step.get("run", "")]
        apply = [i for i, step in enumerate(steps) if "terraform apply -input=false tfplan" in step.get("run", "")]
        self.assertEqual(len(restore), 1)
        self.assertEqual(len(apply), 1)
        self.assertLess(restore[0], apply[0])
        self.assertEqual(steps[restore[0]]["env"]["TF_PLAN_ENC_KEY"], "${{ secrets.TF_PLAN_ENC_KEY }}")
        self.assertIn('--reviewed-plan-sha256 "$REVIEWED_PLAN_SHA256"', steps[restore[0]]["run"])
        self.assertIn("ci_runtime_policy.py check-plan", steps[apply[0]]["run"])
        self.assertEqual(steps[apply[0]]["env"]["CI_ASSETS_READY"], "true")
        self.assertNotIn("-auto-approve", steps[apply[0]]["run"])

    def test_repo_fill_rate_is_read_only_by_the_plan_override_step(self):
        workflow = self.workflow()
        name = "CI_STEAMPIPE_AWS_FILL_RATE_DEV"
        step = next(s for s in workflow["jobs"]["plan"]["steps"]
                    if s.get("name") == "Configure development runtime profile")
        self.assertEqual(step["env"].get(name),
                         "${{ env.TARGET == 'dev' && (inputs.plan_scope || 'full') == 'full' && vars." + name + " || '' }}")
        self.assertEqual(str(workflow).count(name), 2)
        self.assertNotIn(name, str(workflow["jobs"]["apply"]))
        self.assertNotIn("ci_runtime_policy.py overrides", str(workflow["jobs"]["apply"]))

    def test_workflow_and_layer_guards_use_the_same_ready_contract(self):
        for name in ("plan", "apply"):
            step = next(s for s in self.workflow()["jobs"][name]["steps"]
                        if s.get("name", "").startswith("terraform " + name))
            self.assertEqual(step["env"]["CI_ASSETS_READY"], "true")
        root = Path(__file__).resolve().parents[2]
        for name in ("workers.tf", "steampipe.tf"):
            text = (root / "terraform/foundation" / name).read_text()
            self.assertIn('"$${CI_ASSETS_READY:-}" = "true"', text)
            self.assertNotIn("AWSOPS_CI_ASSETS_READY", text)

    def test_sensitive_and_generated_files_are_cleaned_even_on_failure(self):
        for name in ("plan", "apply"):
            cleanup = self.workflow()["jobs"][name]["steps"][-1]
            self.assertEqual(cleanup["if"], "always()")
            for filename in ("tfassets.tar.gz", "tfassets.enc", "tfplan"):
                self.assertIn(filename, cleanup["run"])
        self.assertIn("ci-runtime.auto.tfvars.json",
                      self.workflow()["jobs"]["plan"]["steps"][-1]["run"])
