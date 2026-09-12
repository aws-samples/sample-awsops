"""Exercise mock-test isolation with a local Terraform CLI fixture, never AWS."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]


class TerraformTestRunnerTests(unittest.TestCase):
    def test_runner_uses_tracked_copy_no_backend_and_propagates_test_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binary = root / "terraform"
            binary.write_text(
                "#!/usr/bin/env python3\n"
                "import json, os, pathlib, sys\n"
                "cwd=pathlib.Path.cwd()\n"
                "if sys.argv[1:]==['version','-json']:\n"
                " print(json.dumps({'terraform_version':'1.15.7'})); sys.exit(0)\n"
                "with open(os.environ['TF_FIXTURE_LOG'],'a') as log:\n"
                " log.write(json.dumps({'args':sys.argv[1:],'cwd':str(cwd),\n"
                "  'files':[str(p.relative_to(cwd)) for p in cwd.rglob('*') if p.is_file()],\n"
                "  'env':{k:v for k,v in os.environ.items() if k in ['TF_VAR_domain_name',\n"
                "    'TF_CLI_ARGS_init','TF_DATA_DIR','GH_TOKEN','AWS_PROFILE','AWS_CONFIG_FILE']}})+'\\n')\n"
                "if sys.argv[1]=='test': sys.exit(int(os.environ.get('TF_FIXTURE_EXIT','0')))\n"
            )
            binary.chmod(0o755)
            for exit_code in ("0", "23"):
                log = root / "commands.jsonl"
                log.write_text("")
                result = subprocess.run(
                    ["bash", str(ROOT / "scripts/v2/terraform-test.sh")], cwd=ROOT,
                    env={**os.environ, "PATH": str(root) + os.pathsep + os.environ["PATH"],
                         "TMPDIR": str(root), "TF_FIXTURE_LOG": str(log), "TF_FIXTURE_EXIT": exit_code,
                         "AWS_PROFILE": "must-not-use", "GH_TOKEN": "fixture-only",
                         "TF_DATA_DIR": str(root / "must-not-use"),
                         "TF_VAR_domain_name": "must-not-use.example",
                         "TF_CLI_ARGS_init": "-backend-config=must-not-use.hcl"},
                    capture_output=True, text=True, timeout=30,
                )
                self.assertEqual(result.returncode, int(exit_code), result.stderr)
                calls = [json.loads(line) for line in log.read_text().splitlines()]
                self.assertEqual([c["args"][0] for c in calls], ["init", "validate", "test"])
                self.assertIn("-backend=false", calls[0]["args"])
                self.assertIn("-lockfile=readonly", calls[0]["args"])
                for call in calls:
                    self.assertTrue(call["cwd"].startswith(str(root) + "/awsops-terraform-test."))
                    self.assertFalse(Path(call["cwd"]).exists(), "temporary copy must be cleaned")
                    self.assertEqual(call["env"]["AWS_CONFIG_FILE"], "/dev/null")
                    self.assertNotIn("must-not-use", json.dumps(call["env"]))
                    self.assertNotIn("GH_TOKEN", call["env"])
                    self.assertIn("tests/dns_deferred.tftest.hcl", call["files"])
                    for forbidden in ("backend.hcl", "terraform.tfvars", "ci-state.json",
                                      "ci-deployment.tfvars.json", "tfplan", "terraform.tfstate"):
                        self.assertNotIn(forbidden, call["files"])


if __name__ == "__main__":
    unittest.main()
