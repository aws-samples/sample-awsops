"""Execute workflow shell steps against local CLI fixtures; never call AWS."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

import yaml


ROOT = Path(__file__).resolve().parents[2]
SHA = "a" * 40


def step(file, job, name):
    workflow = yaml.safe_load((ROOT / ".github/workflows" / file).read_text())
    return next(item["run"] for item in workflow["jobs"][job]["steps"] if item.get("name") == name)


class DeploymentWorkflowTests(unittest.TestCase):
    def run_step(self, script, *, changes=None, **overrides):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            working = root / "terraform/foundation"
            working.mkdir(parents=True)
            scripts = root / "scripts/v2"
            scripts.mkdir(parents=True)
            shutil.copyfile(ROOT / "scripts/v2/ci_dns_policy.py", scripts / "ci_dns_policy.py")
            binaries = root / "bin"
            binaries.mkdir()
            for name in ("terraform", "gh", "curl"):
                file = binaries / name
                file.write_text(
                    "#!/usr/bin/env python3\n"
                    "import json,os,pathlib,sys\n"
                    "name=pathlib.Path(sys.argv[0]).name\n"
                    "with open(os.environ['COMMAND_LOG'],'a') as f:\n"
                    " f.write(json.dumps([name,*sys.argv[1:]])+'\\n')\n"
                    "if name=='gh': print(os.environ['CURRENT_SHA'])\n"
                    "elif name=='terraform' and sys.argv[1:3]==['show','-json']:\n"
                    " print(os.environ['PLAN_JSON'])\n"
                )
                file.chmod(0o755)
            log = root / "commands.jsonl"
            env = {
                **os.environ, "PATH": str(binaries) + os.pathsep + os.environ["PATH"],
                "COMMAND_LOG": str(log), "CURRENT_SHA": SHA,
                "GITHUB_SHA": SHA, "GITHUB_REPOSITORY": "example/awsops", "TARGET": "dev",
                "ALLOW_DNS_CHANGES": "false",
                "PLAN_JSON": json.dumps({
                    "format_version": "1.2", "planned_values": {},
                    "resource_changes": changes or [],
                }),
                **overrides,
            }
            result = subprocess.run(
                ["bash", "-c", script], cwd=working, env=env,
                text=True, capture_output=True, timeout=15,
            )
            commands = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
            return result, commands

    def test_apply_blocks_dns_changes_before_calling_terraform_apply(self):
        script = step("terraform.yml", "apply", "terraform apply (exact saved plan — never re-planned)")
        result, commands = self.run_step(script, changes=[{
            "address": "aws_route53_record.alias", "type": "aws_route53_record",
            "change": {"actions": ["delete"]},
        }])
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("DNS change", result.stderr)
        self.assertFalse(any(command[:2] == ["terraform", "apply"] for command in commands))

    def test_apply_rechecks_current_branch_and_uses_exact_saved_plan(self):
        script = step("terraform.yml", "apply", "terraform apply (exact saved plan — never re-planned)")
        result, commands = self.run_step(script, CURRENT_SHA="b" * 40)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(command[0] == "terraform" for command in commands))
        result, commands = self.run_step(script)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(["terraform", "apply", "-input=false", "tfplan"], commands)

    def test_dns_free_bootstrap_cannot_publish_service_dns(self):
        script = step("terraform.yml", "plan", "terraform plan")
        result, commands = self.run_step(
            script, DISPATCH="true", PLAN_SCOPE="ecr-bootstrap", PUBLISH_SERVICE_DNS="true",
            CF_CERTIFICATE_ARN="", ALB_CERTIFICATE_ARN="",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("-target=aws_ecr_repository.web", commands[0])
        self.assertIn("-var=publish_service_dns=false", commands[0])

    def test_plan_treats_inputs_as_arguments_and_rejects_unknown_scope(self):
        script = step("terraform.yml", "plan", "terraform plan")
        value = '$(printf injected);value'
        result, commands = self.run_step(
            script, DISPATCH="true", PLAN_SCOPE="full", PUBLISH_SERVICE_DNS="false",
            CF_CERTIFICATE_ARN=value, ALB_CERTIFICATE_ARN="",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("-var=existing_cf_certificate_arn=" + value, commands[0])
        self.assertNotIn("injected", result.stdout)
        result, commands = self.run_step(
            script, DISPATCH="true", PLAN_SCOPE="invalid", PUBLISH_SERVICE_DNS="false",
            CF_CERTIFICATE_ARN="", ALB_CERTIFICATE_ARN="",
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(commands, [])

    def test_smoke_retains_host_sni_and_tls_without_service_dns(self):
        script = step("deploy-web.yml", "deploy", "Smoke test")
        result, commands = self.run_step(
            script, PUBLIC_URL="https://dev.example.com", CLOUDFRONT_DOMAIN="d123.cloudfront.net",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        curl = commands[0]
        self.assertIn("dev.example.com:443:d123.cloudfront.net:443", curl)
        self.assertIn("https://dev.example.com/api/health", curl)
        self.assertNotIn("-k", curl)
        self.assertNotIn("--insecure", curl)


if __name__ == "__main__":
    unittest.main()
