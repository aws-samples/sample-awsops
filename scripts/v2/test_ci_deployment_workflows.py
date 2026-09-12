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
CF = "arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-3333-4444-555555555555"
ALB = CF.replace("us-east-1", "ap-northeast-2")
CONFIG = {"domain": "dev.example.com", "aliases": [], "region": "ap-northeast-2",
          "cf_arn": None, "alb_arn": None}


def step(file, job, name):
    workflow = yaml.safe_load((ROOT / ".github/workflows" / file).read_text())
    return next(item["run"] for item in workflow["jobs"][job]["steps"] if item.get("name") == name)


class DeploymentWorkflowTests(unittest.TestCase):
    def run_step(self, script, *, changes=None, files=None, **overrides):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            working = root / "terraform/foundation"
            working.mkdir(parents=True)
            scripts = root / "scripts/v2"
            scripts.mkdir(parents=True)
            shutil.copyfile(ROOT / "scripts/v2/ci_dns_policy.py", scripts / "ci_dns_policy.py")
            for name, content in (files or {}).items():
                (working / name).write_text(content)
            binaries = root / "bin"
            binaries.mkdir()
            for name in ("terraform", "gh", "curl", "aws", "openssl"):
                file = binaries / name
                file.write_text(
                    "#!/usr/bin/env python3\n"
                    "import json,os,pathlib,sys\n"
                    "name=pathlib.Path(sys.argv[0]).name\n"
                    "with open(os.environ['COMMAND_LOG'],'a') as f:\n"
                    " f.write(json.dumps([name,*sys.argv[1:]])+'\\n')\n"
                    "if name=='gh': print(os.environ['CURRENT_SHA'])\n"
                    "elif name=='terraform' and sys.argv[1:3]==['show','-json']:\n"
                    " print(os.environ['TEST_STATE_JSON'] if len(sys.argv)==3 else os.environ['PLAN_JSON'])\n"
                    "elif name=='terraform' and sys.argv[1]=='console':\n"
                    " print(json.dumps(os.environ['CONFIG_JSON']))\n"
                    "elif name=='terraform' and sys.argv[1]=='plan':\n"
                    " p=pathlib.Path('ci-deployment.tfvars.json')\n"
                    " if p.exists():\n"
                    "  with open(os.environ['COMMAND_LOG'],'a') as f: f.write(json.dumps(['tfvars',json.loads(p.read_text())])+'\\n')\n"
                    "elif name=='aws':\n"
                    " args=sys.argv[1:]\n"
                    " if args[:2]==['ecr','batch-check-layer-availability']:\n"
                    "  sys.exit(int(os.environ.get('ECR_EXIT','0')))\n"
                    " elif args[:2]==['sts','get-caller-identity']: print('{\"Account\":\"123456789012\"}')\n"
                    " elif args[:2]==['acm','list-certificates']:\n"
                    "  region=args[args.index('--region')+1]\n"
                    "  arn=os.environ['CF_ARN'].replace('us-east-1',region)\n"
                    "  print(json.dumps({'CertificateSummaryList':[] if os.environ.get('NO_CERT') else [{'CertificateArn':arn}]}))\n"
                    " elif args[:2]==['acm','describe-certificate']:\n"
                    "  arn=args[args.index('--certificate-arn')+1]\n"
                    "  print(json.dumps({'Certificate':{'CertificateArn':arn,'Status':'ISSUED','Type':'IMPORTED',\n"
                    "   'KeyAlgorithm':'EC_secp384r1','SubjectAlternativeNames':['dev.example.com'],\n"
                    "   'NotBefore':'2020-01-01T00:00:00+00:00','NotAfter':'2099-01-01T00:00:00+00:00'}}))\n"
                    " elif args[:2]==['acm','get-certificate']: print('{\"Certificate\":\"offline fixture\"}')\n"
                    " else: sys.exit(98)\n"
                )
                file.chmod(0o755)
            log = root / "commands.jsonl"
            env = {
                **os.environ, "PATH": str(binaries) + os.pathsep + os.environ["PATH"],
                "COMMAND_LOG": str(log), "CURRENT_SHA": SHA,
                "GITHUB_SHA": SHA, "GITHUB_REPOSITORY": "example/awsops", "TARGET": "dev",
                "ALLOW_DNS_CHANGES": "false",
                "TEST_STATE_JSON": json.dumps({"format_version": "1.0"}),
                "CONFIG_JSON": json.dumps(CONFIG), "CF_ARN": CF,
                "CF_CERTIFICATE_ARN": "", "ALB_CERTIFICATE_ARN": "",
                "PUBLISH_SERVICE_DNS": "true", "PLAN_SCOPE": "full",
                "GITHUB_STEP_SUMMARY": str(root / "summary.md"),
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

    def test_plan_and_apply_block_ecs_rollout_with_unchanged_cloudmap(self):
        # Confirmed provider plan shape: only the ECS task revision changes; ECS
        # registers replacement task IPs even when both Cloud Map resources are no-op.
        registry = [{"registry_arn": "arn:aws:servicediscovery:ap-northeast-2:"
                     "123456789012:service/srv-example"}]
        task = "arn:aws:ecs:ap-northeast-2:123456789012:task-definition/steampipe:"
        changes = [
            {"address": kind + "." + name, "type": kind, "change": {"actions": ["no-op"]}}
            for kind, name in (("aws_service_discovery_private_dns_namespace", "main[0]"),
                               ("aws_service_discovery_service", "steampipe[0]"))
        ] + [{
            "address": "aws_ecs_service.steampipe[0]", "type": "aws_ecs_service",
            "change": {"actions": ["update"],
                       "before": {"task_definition": task + "1", "service_registries": registry},
                       "after": {"task_definition": task + "2", "service_registries": registry},
                       "after_unknown": {}},
        }]
        for job, name in (("plan", "Check planned DNS operations"),
                          ("apply", "terraform apply (exact saved plan — never re-planned)")):
            with self.subTest(job=job):
                result, commands = self.run_step(step("terraform.yml", job, name), changes=changes)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("DNS change", result.stderr)
                self.assertIn("aws_ecs_service.steampipe[0]", result.stderr)
                self.assertFalse(any(c[:2] == ["terraform", "apply"] for c in commands))

    def test_apply_blocks_unknown_ecs_registries(self):
        script = step("terraform.yml", "apply", "terraform apply (exact saved plan — never re-planned)")
        result, commands = self.run_step(script, changes=[{
            "address": "aws_ecs_service.steampipe[0]", "type": "aws_ecs_service",
            "change": {"actions": ["update"], "before": {"service_registries": []},
                       "after": {}, "after_unknown": {"service_registries": True}},
        }])
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("DNS change", result.stderr)
        self.assertFalse(any(c[:2] == ["terraform", "apply"] for c in commands))

    def test_apply_allows_web_rollout_with_empty_registries(self):
        script = step("terraform.yml", "apply", "terraform apply (exact saved plan — never re-planned)")
        result, commands = self.run_step(script, changes=[{
            "address": "aws_ecs_service.web", "type": "aws_ecs_service",
            "change": {"actions": ["update"],
                       "before": {"task_definition": "web:1", "service_registries": []},
                       "after": {"service_registries": []},
                       "after_unknown": {"task_definition": True, "service_registries": []}},
        }])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(["terraform", "apply", "-input=false", "tfplan"], commands)

    def test_apply_rechecks_current_branch_and_uses_exact_saved_plan(self):
        script = step("terraform.yml", "apply", "terraform apply (exact saved plan — never re-planned)")
        result, commands = self.run_step(script, CURRENT_SHA="b" * 40)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(command[0] == "terraform" for command in commands))
        result, commands = self.run_step(script)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(["terraform", "apply", "-input=false", "tfplan"], commands)

    def test_dns_free_bootstrap_uses_typed_overrides_without_certificate_discovery(self):
        script = step("terraform.yml", "plan", "Check existing certificates without changing DNS")
        script += "\n" + step("terraform.yml", "plan", "terraform plan")
        result, commands = self.run_step(
            script, DISPATCH="true", PLAN_SCOPE="ecr-bootstrap", PUBLISH_SERVICE_DNS="true",
            CF_CERTIFICATE_ARN="", ALB_CERTIFICATE_ARN="",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        plan = next(c for c in commands if c[:2] == ["terraform", "plan"])
        self.assertIn("-target=aws_ecr_repository.web", plan)
        self.assertIn("-var-file=ci-deployment.tfvars.json", plan)
        self.assertIn(["tfvars", {"publish_service_dns": False, "existing_cf_certificate_arn": None,
                                 "existing_alb_certificate_arn": None}], commands)
        self.assertFalse(any(c[:2] == ["aws", "acm"] for c in commands))

    def test_plan_treats_inputs_as_arguments_and_rejects_unknown_scope(self):
        script = step("terraform.yml", "plan", "terraform plan")
        value = {"publish_service_dns": False, "existing_cf_certificate_arn": None,
                 "existing_alb_certificate_arn": ALB}
        result, commands = self.run_step(
            script, DISPATCH="true", PLAN_SCOPE="full",
            files={"ci-deployment.tfvars.json": json.dumps(value)},
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(["tfvars", value], commands)
        result, commands = self.run_step(
            script, DISPATCH="true", PLAN_SCOPE="invalid", PUBLISH_SERVICE_DNS="false",
            files={"ci-deployment.tfvars.json": json.dumps(value)},
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(commands, [])

    def test_certificate_to_plan_roundtrip_preserves_existing_managed_stack(self):
        script = step("terraform.yml", "plan", "Check existing certificates without changing DNS")
        script += "\n" + step("terraform.yml", "plan", "terraform plan")
        resources = [
            {"address": "aws_acm_certificate." + name, "type": "aws_acm_certificate",
             "name": name, "mode": "managed", "values": {"arn": arn}}
            for name, arn in (("cf", CF), ("alb", ALB))
        ]
        resources.append({"address": 'aws_route53_record.alias["dev.example.com"]',
                          "type": "aws_route53_record", "name": "alias", "mode": "managed",
                          "values": {"name": "dev.example.com"}})
        state = {"format_version": "1.0", "values": {"root_module": {"resources": resources}}}
        result, commands = self.run_step(script, DISPATCH="true", TEST_STATE_JSON=json.dumps(state))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(["tfvars", {"publish_service_dns": True, "existing_cf_certificate_arn": None,
                                 "existing_alb_certificate_arn": None}], commands)
        self.assertFalse(any(c[:3] == ["aws", "acm", "list-certificates"] for c in commands))
        self.assertFalse(any("state" in c for c in commands))  # no state writes/moves/imports

    def test_missing_certificate_stops_before_plan_and_explicit_input_is_never_shell_code(self):
        script = step("terraform.yml", "plan", "Check existing certificates without changing DNS")
        script += "\n" + step("terraform.yml", "plan", "terraform plan")
        result, commands = self.run_step(script, DISPATCH="true", NO_CERT="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("No existing public", result.stderr)
        self.assertFalse(any(c[:2] == ["terraform", "plan"] for c in commands))
        result, commands = self.run_step(script, DISPATCH="true", CF_CERTIFICATE_ARN='$(printf injected);value')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(c[:2] == ["terraform", "plan"] for c in commands))
        self.assertNotIn("injected", result.stdout)

    def test_external_stack_dispatch_roundtrip_retains_attached_certificates_and_absent_aliases(self):
        script = step("terraform.yml", "plan", "Check existing certificates without changing DNS")
        script += "\n" + step("terraform.yml", "plan", "terraform plan")
        state = {"format_version": "1.0", "values": {"root_module": {"resources": [
            {"address": "aws_cloudfront_distribution.main", "type": "aws_cloudfront_distribution",
             "name": "main", "mode": "managed", "values": {"viewer_certificate": [{"acm_certificate_arn": CF}]}},
            {"address": "aws_lb_listener.https", "type": "aws_lb_listener",
             "name": "https", "mode": "managed", "values": {"certificate_arn": ALB}},
        ]}}}
        for _ in range(2):
            result, commands = self.run_step(script, DISPATCH="true", TEST_STATE_JSON=json.dumps(state))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn(["tfvars", {"publish_service_dns": False, "existing_cf_certificate_arn": CF,
                                     "existing_alb_certificate_arn": ALB}], commands)
            self.assertFalse(any(c[:3] == ["aws", "acm", "list-certificates"] for c in commands))

    def test_plan_dns_gate_rejects_cloudmap_service_and_unrelated_bootstrap_changes(self):
        script = step("terraform.yml", "plan", "Check planned DNS operations")
        for kind, scope in (("aws_service_discovery_service", "full"), ("aws_ecs_service", "ecr-bootstrap")):
            result, commands = self.run_step(script, PLAN_SCOPE=scope, changes=[{
                "address": kind + ".main", "type": kind, "change": {"actions": ["create"]},
            }])
            self.assertNotEqual(result.returncode, 0, result.stdout)

    def test_build_repository_check_fails_fast_with_existing_push_permission(self):
        script = step("deploy-web.yml", "build", "Verify the web ECR repository exists before building")
        for code in ("0", "254"):
            result, commands = self.run_step(script, PROJECT="awsops-v2-dev", ECR_EXIT=code)
            self.assertEqual(result.returncode == 0, code == "0")
            self.assertEqual(commands[0][:3], ["aws", "ecr", "batch-check-layer-availability"])
            self.assertIn("sha256:" + "0" * 64, commands[0])
            self.assertIn("awsops-v2-dev-web", commands[0])
        workflow = yaml.safe_load((ROOT / ".github/workflows/deploy-web.yml").read_text())
        steps = workflow["jobs"]["build"]["steps"]
        check = next(i for i, s in enumerate(steps) if s.get("name", "").startswith("Verify the web ECR"))
        build = next(i for i, s in enumerate(steps) if s.get("uses", "").startswith("docker/build-push"))
        self.assertLess(check, build)
        self.assertNotIn("continue-on-error", steps[check])

    def test_preflight_is_dispatch_only_and_demo_secret_stays_in_plan(self):
        workflow = yaml.safe_load((ROOT / ".github/workflows/terraform.yml").read_text())
        self.assertNotIn("actions", workflow["permissions"])
        self.assertEqual(workflow["jobs"]["apply"]["permissions"]["actions"], "read")
        steps = workflow["jobs"]["plan"]["steps"]
        cert = next(s for s in steps if s.get("id") == "dns")
        self.assertIn("github.event_name == 'workflow_dispatch'", cert["if"])
        self.assertNotIn("TF_VAR_demo_password", cert["env"])
        plan = next(s for s in steps if s.get("name") == "terraform plan")
        self.assertIn("TF_VAR_demo_password", plan["env"])
        cleanup = next(s for s in steps if s.get("name") == "Clean sensitive files off the runner")
        self.assertEqual(cleanup["if"], "always()")
        self.assertIn("ci-state.json", cleanup["run"])
        self.assertIn("ci-deployment.tfvars.json", cleanup["run"])

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
