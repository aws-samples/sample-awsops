"""Verify state-read commands against a localhost backend that denies all writes."""
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from threading import Thread
import unittest

from ci_dev_domain import plan_rollout, plan_scope


@unittest.skipUnless(shutil.which("terraform"), "Terraform CLI is required")
class TerraformReadTests(unittest.TestCase):
    def test_dev_auto_override_is_identical_in_console_and_saved_plan(self):
        helper = Path(__file__).with_name("ci_dev_domain.py")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            env = {k: v for k, v in os.environ.items() if not k.startswith(("TF_", "AWS_"))}
            env.update(CHECKPOINT_DISABLE="1", TF_DATA_DIR=str(root / ".terraform"),
                       TARGET="dev", DOMAIN_NAME_DEV="new.dev.example.com",
                       HOSTED_ZONE_NAME_DEV="dev.example.com", CERTIFICATE_MODE_DEV="managed",
                       DOMAIN_ROLLOUT="true", PLAN_SCOPE="full")
            env.pop("GITHUB_OUTPUT", None)
            variables = (Path(__file__).resolve().parents[2] / "terraform/foundation/variables.tf").read_text()
            marker = re.search(r'variable "ci_domain_rollout" \{[^}]*\}', variables)
            self.assertIsNotNone(marker, "The saved-plan rollout marker must be a declared Terraform variable")
            (root / "main.tf").write_text(marker[0] + "\n" +
                'variable "domain_name" { type = string }\n'
                'variable "hosted_zone_name" { type = string }\n'
                'variable "extra_domain_aliases" {\n type = list(string)\n default = []\n}\n'
                'variable "existing_cf_certificate_arn" {\n type = string\n default = null\n}\n'
                'output "selected" {\n value = { domain = var.domain_name, '
                'zone = var.hosted_zone_name, certificate = var.existing_cf_certificate_arn }\n}\n'
            )
            protected = root / "terraform.tfvars"
            protected.write_text('domain_name = "old.example.net"\nhosted_zone_name = "example.net"\n')
            original = protected.read_bytes()

            def run(*args, expression=None):
                result = subprocess.run(args, cwd=root, env=env, input=expression, text=True,
                                        capture_output=True, timeout=20)
                self.assertEqual(result.returncode, 0, result.stderr)
                return result.stdout

            run("terraform", "init", "-backend=false", "-input=false", "-no-color")
            run("terraform", "plan", "-input=false", "-lock=false", "-no-color", "-out=default.tfplan")
            default = json.loads(run("terraform", "show", "-json", "default.tfplan"))
            self.assertIs(default["variables"]["ci_domain_rollout"]["value"], False)
            self.assertFalse(plan_rollout(default, "dev", "full"))
            run(sys.executable, str(helper), "overrides")
            selected = json.loads(json.loads(run(
                "terraform", "console", "-no-color", expression=(
                    "jsonencode({domain=var.domain_name,zone=var.hosted_zone_name,"
                    "certificate=var.existing_cf_certificate_arn})\n"),
            )))
            self.assertEqual(selected, {"domain": "new.dev.example.com",
                                        "zone": "dev.example.com", "certificate": None})
            (root / "ci-deployment.tfvars.json").write_text('{"existing_cf_certificate_arn":null}')
            run("terraform", "plan", "-input=false", "-lock=false", "-no-color",
                "-var-file=ci-deployment.tfvars.json", "-out=tfplan")
            saved = json.loads(run("terraform", "show", "-json", "tfplan"))
            self.assertEqual(saved["variables"]["extra_domain_aliases"]["value"], [])
            self.assertEqual(plan_scope(saved), ({"new.dev.example.com"}, "dev.example.com"))
            self.assertTrue(plan_rollout(saved, "dev", "full"))
            self.assertEqual(saved["planned_values"]["outputs"]["selected"]["value"], selected)
            self.assertEqual(protected.read_bytes(), original)

    def test_console_and_show_read_without_locks_and_preserve_json_null(self):
        requests = []

        class Backend(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                requests.append(self.command)
                self.send_response(200)
                self.end_headers()
                self.wfile.write(json.dumps({
                    "version": 4, "terraform_version": "1.15.7", "serial": 0,
                    "lineage": "00000000-0000-0000-0000-000000000000",
                    "outputs": {}, "resources": [],
                }).encode())

            def deny(self):
                requests.append(self.command)
                self.send_response(403)
                self.end_headers()

            do_LOCK = do_UNLOCK = do_POST = do_PUT = do_DELETE = deny

        server = HTTPServer(("127.0.0.1", 0), Backend)
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                address = f"http://127.0.0.1:{server.server_port}"
                (root / "main.tf").write_text(
                    'terraform {\n backend "http" {\n'
                    f' address = "{address}/state"\n lock_address = "{address}/lock"\n'
                    f' unlock_address = "{address}/lock"\n }}\n}}\n'
                    'variable "certificate" {\n type = string\n default = null\n}\n'
                    'variable "publish" {\n type = bool\n default = true\n}\n'
                )
                # Exercise JSON var-file roundtrip, not just jsonencode in isolation.
                (root / "inputs.tfvars.json").write_text(json.dumps({"certificate": None, "publish": True}))
                env = {k: v for k, v in os.environ.items() if not k.startswith("TF_")}
                env.update(CHECKPOINT_DISABLE="1", TF_DATA_DIR=str(root / ".terraform"))

                def terraform(*args, expression=None):
                    result = subprocess.run(
                        ["terraform", *args], cwd=root, env=env, input=expression,
                        text=True, capture_output=True, timeout=20,
                    )
                    self.assertEqual(result.returncode, 0, result.stderr)
                    return result.stdout

                terraform("init", "-input=false", "-no-color")
                requests.clear()
                state = json.loads(terraform("show", "-json"))
                self.assertEqual(state["format_version"], "1.0")
                encoded = json.loads(terraform(
                    "console", "-no-color", "-var-file=inputs.tfvars.json",
                    expression="jsonencode({certificate=var.certificate,publish=var.publish})\n",
                ))
                self.assertEqual(json.loads(encoded), {"certificate": None, "publish": True})
                self.assertTrue(requests)
                self.assertEqual(set(requests), {"GET"}, "ReadOnlyAccess must not need a state lock/write")
                self.assertNotIn("-lock=false", terraform("console", "-help"))
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
