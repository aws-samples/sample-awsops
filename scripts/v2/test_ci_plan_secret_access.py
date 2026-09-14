"""The actual Plan step must bind an optional reader grant to its configured role."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[2]


class PlanSecretAccessTests(unittest.TestCase):
    def run_step(self, role_name, *, target="dev", configured="plan-reader"):
        workflow = yaml.safe_load((ROOT / ".github/workflows/terraform.yml").read_text())
        step = next(s for s in workflow["jobs"]["plan"]["steps"] if s.get("name") == "terraform plan")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "ci-deployment.tfvars.json").write_text("{}")
            binary = root / "terraform"
            binary.write_text("#!/usr/bin/env python3\nimport json,os,sys\n"
                              "open(os.environ['CALLS'],'w').write(json.dumps(sys.argv[1:]))\n")
            binary.chmod(0o700)
            env = dict(os.environ, PATH=str(root) + os.pathsep + os.environ["PATH"],
                       CALLS=str(root / "calls"), TARGET=target, DISPATCH="false",
                       PLAN_SCOPE="", TF_VAR_ci_migrations_enabled="false",
                       TF_VAR_ci_terraform_plan_role_name=role_name,
                       PLAN_ROLE_ARN=f"arn:aws:iam::123456789012:role/platform/{configured}")
            result = subprocess.run(["bash", "-euo", "pipefail", "-c", step["run"]],
                                    cwd=root, env=env, capture_output=True, timeout=10)
            calls = json.loads((root / "calls").read_text()) if (root / "calls").exists() else []
            return result.returncode, calls

    def test_disabled_grant_does_not_change_plan_inputs(self):
        code, calls = self.run_step("")
        self.assertEqual(code, 0)
        self.assertFalse(any("ci_terraform_plan_role_name" in arg for arg in calls))

    def test_role_name_matches_the_actual_configured_plan_role(self):
        code, calls = self.run_step("plan-reader")
        self.assertEqual(code, 0)
        self.assertIn("-var=ci_terraform_plan_role_name=plan-reader", calls)
        self.assertIn("-lock=false", calls)

    def test_wrong_role_or_non_dev_context_stops_before_terraform(self):
        for values in [("other-role", "dev"), ("plan-reader", "main")]:
            with self.subTest(values=values):
                code, calls = self.run_step(values[0], target=values[1])
                self.assertNotEqual(code, 0)
                self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
