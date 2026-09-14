"""Deployment workflow contracts; provenance unit tests are independent."""
import os
from pathlib import Path
import subprocess
import unittest
import yaml

SHA = "a" * 40
REPO = "aws-samples/sample-awsops"


class WorkflowTest(unittest.TestCase):
    root = Path(__file__).resolve().parents[2]

    def workflow(self, name):
        return yaml.safe_load((self.root / ".github/workflows" / name).read_text())

    def test_image_proof_uses_only_explicit_preview_secret_references(self):
        proof = self.workflow("deploy-web.yml")["jobs"]["image-proof"]
        self.assertNotRegex(yaml.safe_dump(proof), r"\bsecrets\s*\[")
        selected = proof["env"]["USER_TFVARS_B64"]
        for branch in ("atomoh", "ssminji", "whchoi"):
            self.assertIn(
                f"github.ref_name == '{branch}' && secrets.TF_TFVARS_PREVIEW_{branch}",
                selected)
        self.assertTrue(selected.rstrip().endswith("|| '' }}"))

    def test_dev_roll_requires_migration_and_build_proof_with_explicit_secrets(self):
        web = self.workflow("deploy-web.yml")
        migrate = web["jobs"]["migrate-dev"]
        self.assertEqual(migrate["needs"], ["guard", "image-proof"])
        self.assertIn("needs.image-proof.result == 'success'", migrate["if"])
        self.assertIn("needs.image-proof.outputs.digest != ''", migrate["if"])
        proof = web["jobs"]["image-proof"]
        self.assertEqual(proof["needs"], ["guard", "build"])
        self.assertIn("needs.build.result == 'skipped'", proof["if"])
        self.assertTrue(any("ci_web_deploy.py preflight-image" in s.get("run", "") for s in proof["steps"]))
        self.assertEqual(migrate["uses"], "./.github/workflows/deploy-migrations.yml")
        self.assertEqual(migrate["with"], {"from_deploy_web": True})
        expected = ["TF_TFVARS_DEV", "TF_BACKEND_HCL_DEV", "AWS_ACCOUNT_ID_DEV",
                    "AWS_CI_BUILD_DEV_ROLE_ARN", "AWS_CI_DEPLOYER_DEV_ROLE_ARN"]
        self.assertEqual(migrate["secrets"], {k: "${{ secrets." + k + " }}" for k in expected})
        deploy = web["jobs"]["deploy"]
        self.assertEqual(deploy["needs"], ["guard", "build", "image-proof", "migrate-dev"])
        self.assertIn("needs.guard.result == 'success'", deploy["if"])
        self.assertIn("needs.migrate-dev.result == 'success'", deploy["if"])
        self.assertIn("github.event_name == 'workflow_dispatch' || github.ref_name != 'main'", deploy["if"])
        steps = deploy["steps"]
        pin = next(s for s in steps if s.get("id") == "pin")
        self.assertEqual(pin["env"]["FRESH_DIGEST"], "${{ needs.build.outputs.digest }}")
        self.assertEqual(pin["env"]["IMAGE_BUILD_RUN_ID"], "${{ inputs.image_build_run_id }}")
        self.assertEqual(pin["env"]["PREFLIGHT_DIGEST"], "${{ needs.image-proof.outputs.digest }}")
        self.assertNotIn('imageTag="web-', pin["run"])
        self.assertIn("ci_web_deploy.py deploy", pin["run"])
        self.assertEqual(pin["env"]["MIGRATED_SHA"], "${{ needs.migrate-dev.outputs.source_sha }}")
        self.assertEqual(pin["env"]["MIGRATED_PROJECT"], "${{ needs.migrate-dev.outputs.project }}")
        self.assertLess(steps.index(pin), next(i for i, s in enumerate(steps)
                                             if s.get("name") == "Verify exact deployment and healthy running web image"))
        self.assertEqual(deploy["outputs"]["expected_image_digest"], "${{ steps.pin.outputs.digest }}")
        self.assertEqual(deploy["outputs"]["expected_runtime_digest"], "${{ steps.pin.outputs.runtime_digest }}")
        self.assertFalse(deploy["concurrency"]["cancel-in-progress"])

    def test_migration_guard_accepts_only_explicit_dev_web_push_or_dev_dispatch(self):
        workflow = self.workflow("deploy-migrations.yml")
        self.assertFalse(workflow[True]["workflow_call"]["inputs"]["from_deploy_web"]["default"])
        script = workflow["jobs"]["guard"]["steps"][0]["run"]
        env = dict(os.environ, GITHUB_REPOSITORY=REPO, GITHUB_REF="refs/heads/dev",
                   GITHUB_EVENT_NAME="push", MIGRATION_FROM_DEPLOY_WEB="true",
                   GITHUB_WORKFLOW_REF=REPO + "/.github/workflows/deploy-web.yml@refs/heads/dev")
        cases = [({}, True), ({"GITHUB_EVENT_NAME": "workflow_dispatch"}, True),
                 ({"MIGRATION_FROM_DEPLOY_WEB": ""}, False),
                 ({"GITHUB_EVENT_NAME": "pull_request"}, False),
                 ({"GITHUB_REPOSITORY": "other/repo"}, False),
                 ({"GITHUB_REF": "refs/heads/main"}, False),
                 ({"GITHUB_WORKFLOW_REF": REPO + "/.github/workflows/other.yml@refs/heads/dev"}, False)]
        for changes, allowed in cases:
            with self.subTest(changes=changes):
                result = subprocess.run(["bash", "-euo", "pipefail", "-c", script],
                                        env=env | changes, capture_output=True, timeout=5)
                self.assertEqual(result.returncode == 0, allowed)

    def test_invalid_image_inputs_fail_before_migration_or_build(self):
        web = self.workflow("deploy-web.yml")
        script = web["jobs"]["guard"]["steps"][0]["run"]
        env = dict(os.environ, GITHUB_EVENT_NAME="workflow_dispatch", GITHUB_SHA=SHA,
                   GITHUB_REPOSITORY=REPO, GITHUB_REF="refs/heads/dev", GITHUB_OUTPUT="/dev/null",
                   BUILD="false", IMAGE_SHA="", PRODUCER_RUN="123", SCHEMA_ACK="false", VERIFY_DATABASE="false")
        for changes, allowed in [({}, True), ({"PRODUCER_RUN": ""}, False),
                                 ({"IMAGE_SHA": "short"}, False),
                                 ({"BUILD": "true"}, False),
                                 ({"BUILD": "true", "PRODUCER_RUN": ""}, True),
                                 ({"GITHUB_EVENT_NAME": "pull_request"}, False)]:
            with self.subTest(changes=changes):
                result = subprocess.run(["bash", "-euo", "pipefail", "-c", script],
                                        env=env | changes, capture_output=True, timeout=5)
                self.assertEqual(result.returncode == 0, allowed)
        self.assertEqual(web["jobs"]["build"]["needs"], ["guard"])

    def test_rollback_is_explicit_and_never_runs_current_migrations(self):
        script = self.workflow("deploy-web.yml")["jobs"]["guard"]["steps"][0]["run"]
        import tempfile
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / "output"
            env = dict(os.environ, GITHUB_EVENT_NAME="workflow_dispatch", GITHUB_SHA=SHA,
                       GITHUB_REPOSITORY=REPO, GITHUB_REF="refs/heads/dev", GITHUB_OUTPUT=str(output),
                       BUILD="false", IMAGE_SHA="c" * 40, PRODUCER_RUN="123",
                       SCHEMA_ACK="false", VERIFY_DATABASE="false")
            denied = subprocess.run(["bash", "-euo", "pipefail", "-c", script], env=env, capture_output=True)
            self.assertNotEqual(denied.returncode, 0)
            allowed = subprocess.run(["bash", "-euo", "pipefail", "-c", script],
                                     env=env | {"SCHEMA_ACK": "true"}, capture_output=True)
            self.assertEqual(allowed.returncode, 0, allowed.stderr)
            self.assertIn("migration_required=false", output.read_text())
            self.assertIn("rollback=true", output.read_text())


if __name__ == "__main__":
    unittest.main()
