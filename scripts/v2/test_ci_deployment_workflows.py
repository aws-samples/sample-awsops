"""Execute workflow shell steps against local CLI fixtures; never call AWS."""
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

import yaml

from test_ci_dev_domain import plan_fixture, record


ROOT = Path(__file__).resolve().parents[2]
SHA = "a" * 40
CF = "arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-3333-4444-555555555555"
ALB = CF.replace("us-east-1", "ap-northeast-2")
CONFIG = {"domain": "dev.example.com", "zone": "dev.example.com", "aliases": [], "region": "ap-northeast-2",
          "cf_arn": None, "alb_arn": None}


def workflow_step(file, job, name):
    workflow = yaml.safe_load((ROOT / ".github/workflows" / file).read_text())
    return next(item for item in workflow["jobs"][job]["steps"] if item.get("name") == name)


def step(file, job, name):
    return workflow_step(file, job, name)["run"]


def expression(value, context):
    """Evaluate the small boolean/context subset used by these real YAML steps."""
    if not isinstance(value, str) or not value.startswith("${{"):
        return value
    code = value[3:-2].strip().replace("&&", " and ").replace("||", " or ")
    def lookup(match):
        current = context
        for key in match[0].split("."):
            current = current.get(key, {}) if isinstance(current, dict) else {}
        return repr(current if current != {} else "")
    code = re.sub(r"\b(?:github|inputs|steps|vars|secrets|env)(?:\.[a-zA-Z_][a-zA-Z_0-9]*)+", lookup, code)
    return eval(code, {"__builtins__": {}}, {})


class DeploymentWorkflowTests(unittest.TestCase):
    def run_step(self, script, *, changes=None, files=None, context=None, **overrides):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            working = root / "terraform/foundation"
            working.mkdir(parents=True)
            scripts = root / "scripts/v2"
            scripts.mkdir(parents=True)
            shutil.copyfile(ROOT / "scripts/v2/ci_dns_policy.py", scripts / "ci_dns_policy.py")
            shutil.copyfile(ROOT / "scripts/v2/ci_dev_domain.py", scripts / "ci_dev_domain.py")
            shutil.copyfile(ROOT / "scripts/v2/ci_runtime_policy.py", scripts / "ci_runtime_policy.py")
            shutil.copyfile(ROOT / "scripts/v2/deployment-smoke.mjs", scripts / "deployment-smoke.mjs")
            for name in ("ci_failure_diagnostics.py", "ci_plan_inspect.py",
                         "ci_tf_assets.py", "ci_plan_context.py"):
                shutil.copyfile(ROOT / "scripts/v2" / name, scripts / name)
            subprocess.run(["git", "init", "-q", str(root)], check=True)
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
                    "if name=='terraform' and os.environ.get('ASSERT_NO_GITHUB_CHANNELS')=='true':\n"
                    " assert not any(k in os.environ for k in ('GITHUB_OUTPUT','GITHUB_ENV','GITHUB_PATH','GITHUB_STATE','GITHUB_STEP_SUMMARY','TF_PLAN_ENC_KEY'))\n"
                    " assert not any(k.startswith(('TF_LOG','TF_CLI_ARGS')) for k in os.environ)\n"
                    " assert os.environ.get('AWS_SESSION_TOKEN')=='KEEP_STS'\n"
                    "with open(os.environ['COMMAND_LOG'],'a') as f:\n"
                    " f.write(json.dumps([name,*sys.argv[1:]])+'\\n')\n"
                    "if name=='gh': print(os.environ['CURRENT_SHA'])\n"
                    "elif name=='terraform' and sys.argv[1:3]==['show','-json']:\n"
                    " print(os.environ['TEST_STATE_JSON'] if len(sys.argv)==3 else os.environ['PLAN_JSON'])\n"
                    "elif name=='terraform' and sys.argv[1]=='console':\n"
                    " config=json.loads(os.environ['CONFIG_JSON'])\n"
                    " p=pathlib.Path('ci-domain.auto.tfvars.json')\n"
                    " if p.exists():\n"
                    "  override=json.loads(p.read_text())\n"
                    "  for key,var in [('domain','domain_name'),('zone','hosted_zone_name'),('domain_rollout','ci_domain_rollout')]:\n"
                    "   if var in override: config[key]=override[var]\n"
                    " with open(os.environ['COMMAND_LOG'],'a') as f: f.write(json.dumps(['console-config',config])+'\\n')\n"
                    " print(json.dumps(json.dumps(config)))\n"
                    "elif name=='terraform' and sys.argv[1]=='plan':\n"
                    " p=pathlib.Path('ci-domain.auto.tfvars.json')\n"
                    " if p.exists():\n"
                    "  with open(os.environ['COMMAND_LOG'],'a') as f: f.write(json.dumps(['domain-vars',json.loads(p.read_text())])+'\\n')\n"
                    " p=pathlib.Path('ci-deployment.tfvars.json')\n"
                    " if p.exists():\n"
                    "  with open(os.environ['COMMAND_LOG'],'a') as f: f.write(json.dumps(['tfvars',json.loads(p.read_text())])+'\\n')\n"
                    "elif name=='aws':\n"
                    " args=sys.argv[1:]\n"
                    " if args[:2]==['ecr','batch-check-layer-availability']:\n"
                    "  sys.exit(int(os.environ.get('ECR_EXIT','0')))\n"
                    " elif args[:2]==['sts','get-caller-identity']: print('{\"Account\":\"123456789012\"}')\n"
                    " elif args[:2]==['acm','describe-certificate']:\n"
                    "  arn=args[args.index('--certificate-arn')+1]\n"
                    "  print(json.dumps({'Certificate':{'CertificateArn':arn,'Status':'ISSUED','Type':'IMPORTED',\n"
                    "   'KeyAlgorithm':'EC_secp384r1','SubjectAlternativeNames':['dev.example.com'],\n"
                    "   'NotBefore':'2020-01-01T00:00:00+00:00','NotAfter':'2099-01-01T00:00:00+00:00'}}))\n"
                    " elif args[:2]==['acm','get-certificate']: print('{\"Certificate\":\"offline fixture\"}')\n"
                    " else: sys.exit(98)\n"
                    "elif name=='openssl': sys.exit(int(os.environ.get('OPENSSL_EXIT','0')))\n"
                )
                file.chmod(0o755)
            log = root / "commands.jsonl"
            env = {
                **os.environ, "PATH": str(binaries) + os.pathsep + os.environ["PATH"],
                "COMMAND_LOG": str(log), "CURRENT_SHA": SHA,
                "GITHUB_SHA": SHA, "GITHUB_REPOSITORY": "example/awsops", "TARGET": "dev",
                "ALLOW_DNS_CHANGES": "false",
                "AWS_ACCOUNT_ID_DEV": "123456789012",
                "TEST_STATE_JSON": json.dumps({"format_version": "1.0"}),
                "CONFIG_JSON": json.dumps(CONFIG), "CF_ARN": CF,
                "CF_CERTIFICATE_ARN": "", "ALB_CERTIFICATE_ARN": "",
                "PUBLISH_SERVICE_DNS": "true", "PLAN_SCOPE": "full",
                "GITHUB_STEP_SUMMARY": str(root / "summary.md"),
                "GITHUB_OUTPUT": str(root / "outputs"),
                "PLAN_JSON": json.dumps(plan_fixture(changes or [], rollout=False)),
                "ADVISORY": "false", "DOMAIN_ROLLOUT": "false",
                **overrides,
            }
            if isinstance(script, str):
                script = [{"run": script}]
            context = {**(context or {}), "env": env, "steps": {}}
            for item in script:
                step_env = dict(env)
                for key, value in item.get("env", {}).items():
                    resolved = expression(value, context)
                    step_env[key] = str(resolved).lower() if isinstance(resolved, bool) else str(resolved)
                result = subprocess.run(
                    ["bash", "-c", item["run"]], cwd=working, env=step_env,
                    text=True, capture_output=True, timeout=15,
                )
                if result.returncode:
                    break
                if item.get("id"):
                    output = Path(env["GITHUB_OUTPUT"])
                    context["steps"][item["id"]] = {"outputs": dict(
                        line.split("=", 1) for line in output.read_text().splitlines()
                    )} if output.exists() else {"outputs": {}}
            commands = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
            summary = root / "summary.md"
            result.summary = summary.read_text() if summary.exists() else ""
            result.files = {p.name: p.read_text() for p in working.iterdir() if p.is_file()}
            return result, commands

    def test_real_yaml_wires_dispatch_rollout_and_managed_output_to_preflight(self):
        workflow = yaml.safe_load((ROOT / ".github/workflows/terraform.yml").read_text())
        inputs = workflow[True]["workflow_dispatch"]["inputs"]
        self.assertEqual(inputs["domain_rollout"]["type"], "boolean")
        self.assertIs(inputs["domain_rollout"]["default"], False)
        items = [workflow_step("terraform.yml", "plan", name) for name in (
            "Configure dev domain overrides", "Check existing certificates without changing DNS", "terraform plan",
        )]
        for event, rollout in (("workflow_dispatch", True), ("workflow_dispatch", False),
                               ("pull_request", False), ("push", False)):
            with self.subTest(event=event, rollout=rollout):
                result, commands = self.run_step(items, context={
                    "github": {"event_name": event},
                    "inputs": {"domain_rollout": rollout, "plan_scope": "full",
                               "allow_dns_changes": True, "publish_service_dns": False},
                    "vars": {"DOMAIN_NAME_DEV": "dev.example.com", "HOSTED_ZONE_NAME_DEV": "dev.example.com",
                             "CERTIFICATE_MODE_DEV": "managed"},
                })
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(["domain-vars", {"domain_name": "dev.example.com", "hosted_zone_name": "dev.example.com",
                                                "ci_domain_rollout": rollout}], commands)
                self.assertIn(["tfvars", {"publish_service_dns": False, "existing_cf_certificate_arn": None,
                                          "existing_alb_certificate_arn": None}], commands)
                if event != "workflow_dispatch":
                    self.assertFalse(any(c[0] == "aws" for c in commands))

    def test_advisory_yaml_reports_cloudmap_and_cannot_activate_rollout(self):
        change = {"address": "aws_service_discovery_service.steampipe", "type": "aws_service_discovery_service",
                  "change": {"actions": ["create"]}}
        items = [workflow_step("terraform.yml", "plan", "Configure dev domain overrides"),
                 workflow_step("terraform.yml", "plan", "Check planned DNS operations")]
        for event in ("pull_request", "push"):
            result, _ = self.run_step(items, changes=[change], context={
                "github": {"event_name": event, "base_ref": "dev", "ref_name": "dev"},
                "inputs": {"domain_rollout": True}, "vars": {},
            })
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(json.loads(result.files["ci-domain.auto.tfvars.json"])["ci_domain_rollout"])
            self.assertIn(change["address"], result.summary)
            self.assertNotIn("public_zone", result.summary)

    def test_tracked_domain_override_is_rejected_and_cleanup_preserves_it(self):
        script = "git add -f ci-domain.auto.tfvars.json\n"
        script += step("terraform.yml", "plan", "Configure dev domain overrides")
        original = '{"domain_name":"untrusted.example.net"}'
        result, _ = self.run_step(script, files={"ci-domain.auto.tfvars.json": original})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("tracked", result.stdout + result.stderr)
        self.assertEqual(result.files["ci-domain.auto.tfvars.json"], original)
        cleanup = "git add -f ci-domain.auto.tfvars.json\n" + step(
            "terraform.yml", "plan", "Clean sensitive files off the runner")
        result, _ = self.run_step(cleanup, files={"ci-domain.auto.tfvars.json": original})
        self.assertEqual(result.files["ci-domain.auto.tfvars.json"], original)
        ignored = subprocess.run(
            ["git", "check-ignore", "--no-index", "terraform/foundation/ci-domain.auto.tfvars.json"],
            cwd=ROOT, capture_output=True, text=True,
        )
        self.assertEqual(ignored.returncode, 0, ignored.stderr)

    def test_apply_scope_is_pinned_to_plan_not_current_domain_env(self):
        change = {"address": "aws_service_discovery_service.steampipe[0]", "type": "aws_service_discovery_service",
                  "change": {"actions": ["create"], "before": None,
                             "after": {"name": "steampipe", "dns_config": [{"namespace_id": "ns-owned"}]}}}
        script = step("terraform.yml", "apply", "terraform apply (exact saved plan — never re-planned)")
        for rollout in (False, True):
            for allow in (False, True):
                plan = plan_fixture([change], rollout=rollout)
                plan["variables"]["ci_runtime_rollout"]["value"] = True
                plan["planned_values"]["root_module"]["resources"].append({
                    "address": "aws_service_discovery_private_dns_namespace.main[0]",
                    "type": "aws_service_discovery_private_dns_namespace", "mode": "managed",
                    "values": {"id": "ns-owned", "name": "awsops-dev.internal", "vpc": "vpc-0123"},
                })
                plan["planned_values"]["root_module"]["resources"].append({
                    "address": "aws_vpc.main[0]", "type": "aws_vpc", "mode": "managed",
                    "values": {"id": "vpc-0123"},
                })
                result, commands = self.run_step(
                    script, PLAN_JSON=json.dumps(plan),
                    ALLOW_DNS_CHANGES=str(allow).lower(), DOMAIN_ROLLOUT=str(not rollout).lower(),
                    DOMAIN_NAME_DEV="changed.example.net", HOSTED_ZONE_NAME_DEV="example.net",
                )
                self.assertEqual(result.returncode == 0, allow and not rollout, result.stderr)
                self.assertEqual(any(c[:2] == ["terraform", "apply"] for c in commands), allow and not rollout)

    def test_override_with_rollout_false_refuses_published_old_domain_dispatch(self):
        items = [workflow_step("terraform.yml", "plan", name) for name in (
            "Configure dev domain overrides", "Check existing certificates without changing DNS", "terraform plan",
        )]
        for host, zone in (("old.example.net", "example.net"),
                           ("dev.example.com", "example.com")):
            state = {"format_version": "1.0", "values": {"root_module": {"resources": [
                {"address": f'aws_route53_record.alias["{host}"]', "mode": "managed",
                 "type": "aws_route53_record", "name": "alias",
                 "values": {"name": host, "zone_id": "ZOLD", "type": "A"}},
                {"address": "data.aws_route53_zone.main", "mode": "data",
                 "type": "aws_route53_zone", "name": "main",
                 "values": {"name": zone + ".", "zone_id": "ZOLD"}},
            ]}}}
            for event in ("workflow_dispatch", "pull_request", "push"):
                with self.subTest(host=host, zone=zone, event=event):
                    result, commands = self.run_step(items, TEST_STATE_JSON=json.dumps(state), context={
                        "github": {"event_name": event},
                        "inputs": {"domain_rollout": False, "plan_scope": "full",
                                   "allow_dns_changes": True, "publish_service_dns": True},
                        "vars": {"DOMAIN_NAME_DEV": "dev.example.com",
                                 "HOSTED_ZONE_NAME_DEV": "dev.example.com"},
                    })
                    advisory = event != "workflow_dispatch"
                    self.assertEqual(result.returncode == 0, advisory, result.stderr)
                    self.assertEqual(any(c[:2] == ["terraform", "plan"] for c in commands), advisory)
                    self.assertFalse(any(c[:2] == ["aws", "acm"] for c in commands))
                    if advisory:
                        self.assertFalse(any(c[0] == "aws" for c in commands))
                        self.assertIn(["tfvars", {"publish_service_dns": True,
                                                 "existing_cf_certificate_arn": None,
                                                 "existing_alb_certificate_arn": None}], commands)
                    else:
                        self.assertIn("Published old-domain", result.stderr)

    def test_saved_old_alias_plan_is_refused_independently_of_current_overrides(self):
        for host, zone in (("old.example.net", "ZOLD"), ("dev.example.com", "ZPARENT")):
            change = record(host=host, zone_id=zone)
            change["change"].update(actions=["delete"], before=change["change"]["after"], after=None)
            saved = plan_fixture([change, record()], rollout=False)
            for job, name in (("plan", "Check planned DNS operations"),
                              ("apply", "terraform apply (exact saved plan — never re-planned)")):
                for current_rollout in (False, True):
                    with self.subTest(host=host, zone=zone, job=job, current_rollout=current_rollout):
                        result, commands = self.run_step(
                            [workflow_step("terraform.yml", job, name)], PLAN_JSON=json.dumps(saved),
                            # None of these current values can rewrite saved-plan policy.
                            DOMAIN_NAME_DEV=host, HOSTED_ZONE_NAME_DEV="example.net",
                            DOMAIN_ROLLOUT=str(current_rollout).lower(), ADVISORY="true",
                            context={"github": {"event_name": "workflow_dispatch"},
                                     "inputs": {"allow_dns_changes": True, "plan_scope": "full",
                                                "domain_rollout": current_rollout}},
                        )
                        self.assertNotEqual(result.returncode, 0)
                        self.assertIn("Published old-domain", result.stderr)
                        self.assertFalse(any(c[:2] == ["terraform", "apply"] for c in commands))
            for event in ("pull_request", "push"):
                result, _ = self.run_step(
                    [workflow_step("terraform.yml", "plan", "Check planned DNS operations")],
                    PLAN_JSON=json.dumps(saved), context={"github": {"event_name": event}, "inputs": {}},
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(change["address"], json.loads(result.summary)["dns_changes"])

    def test_override_retains_unpublished_same_domain_and_ecr_dispatch(self):
        items = [workflow_step("terraform.yml", "plan", name) for name in (
            "Configure dev domain overrides", "Check existing certificates without changing DNS", "terraform plan",
        )]
        for scope, host, zone in (("full", None, "dev.example.com"),
                                  ("full", "dev.example.com", "dev.example.com"),
                                  ("ecr-bootstrap", "old.example.net", "example.net")):
            resources = [{"address": "data.aws_route53_zone.main", "mode": "data",
                          "type": "aws_route53_zone", "name": "main",
                          "values": {"name": zone + ".", "zone_id": "Z123CHILD"}}]
            if host:
                resources.append({"address": f'aws_route53_record.alias["{host}"]', "mode": "managed",
                                  "type": "aws_route53_record", "name": "alias",
                                  "values": {"name": host, "zone_id": "Z123CHILD", "type": "A"}})
            with self.subTest(scope=scope, host=host):
                result, commands = self.run_step(
                    items, TEST_STATE_JSON=json.dumps({
                        "format_version": "1.0", "values": {"root_module": {"resources": resources}},
                    }), context={
                        "github": {"event_name": "workflow_dispatch"},
                        "inputs": {"domain_rollout": False, "plan_scope": scope,
                                   "allow_dns_changes": scope == "full", "publish_service_dns": False},
                        "vars": {"DOMAIN_NAME_DEV": "dev.example.com",
                                 "HOSTED_ZONE_NAME_DEV": "dev.example.com"},
                    },
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertTrue(any(c[:2] == ["terraform", "plan"] for c in commands))
                self.assertFalse(any(c[:2] == ["aws", "acm"] for c in commands))
                if scope == "ecr-bootstrap":
                    self.assertTrue(any("-target=aws_ecr_repository.web" in c for c in commands))

    def test_dev_repo_override_reaches_console_and_automatic_plan(self):
        script = step("terraform.yml", "plan", "Configure dev domain overrides")
        script += "\n" + step("terraform.yml", "plan", "Check existing certificates without changing DNS")
        script += "\n" + step("terraform.yml", "plan", "terraform plan")
        result, commands = self.run_step(
            script, DOMAIN_NAME_DEV="dev.example.com", HOSTED_ZONE_NAME_DEV="dev.example.com",
            CERTIFICATE_MODE_DEV="preserve", CERTIFICATE_MODE="preserve", ADVISORY="true",
            DISPATCH="false", CF_CERTIFICATE_ARN=CF, ALB_CERTIFICATE_ARN=ALB,
            CONFIG_JSON=json.dumps({**CONFIG, "domain": "old.example.net", "zone": "example.net"}),
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(["console-config", {**CONFIG, "domain_rollout": False}], commands)
        self.assertIn(["domain-vars", {"domain_name": "dev.example.com",
                                       "hosted_zone_name": "dev.example.com", "ci_domain_rollout": False}], commands)
        plan = next(c for c in commands if c[:2] == ["terraform", "plan"])
        self.assertIn("-var-file=ci-deployment.tfvars.json", plan)
        self.assertIn(["tfvars", {"publish_service_dns": False, "existing_cf_certificate_arn": CF,
                                  "existing_alb_certificate_arn": ALB}], commands)

    def test_managed_dev_full_plan_defers_service_dns_and_refuses_conflicting_arns(self):
        script = step("terraform.yml", "plan", "Check existing certificates without changing DNS")
        script += "\n" + step("terraform.yml", "plan", "terraform plan")
        for supplied in ("", CF):
            result, commands = self.run_step(
                script, DISPATCH="true", CERTIFICATE_MODE="managed", ALLOW_DNS_CHANGES="true",
                PUBLISH_SERVICE_DNS="false", CF_CERTIFICATE_ARN=supplied,
            )
            if supplied:
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("conflict", result.stderr)
                self.assertFalse(any(c[0] == "aws" for c in commands))
            else:
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(["tfvars", {"publish_service_dns": False,
                                          "existing_cf_certificate_arn": None,
                                          "existing_alb_certificate_arn": None}], commands)
            self.assertFalse(any(c[:2] == ["aws", "acm"] for c in commands))

    def test_dev_apply_uses_saved_zone_and_blocks_unrelated_dns_even_with_permission(self):
        from test_ci_dev_domain import record
        script = step("terraform.yml", "apply", "terraform apply (exact saved plan — never re-planned)")
        result, commands = self.run_step(script, PLAN_JSON=json.dumps(plan_fixture([record(zone_id="ZPARENT")], rollout=True)),
                                         ALLOW_DNS_CHANGES="true")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(c[:2] == ["terraform", "apply"] for c in commands))
        result, commands = self.run_step(script, PLAN_JSON=json.dumps(plan_fixture([record()], rollout=True)), ALLOW_DNS_CHANGES="true")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(["terraform", "apply", "-input=false", "tfplan"], commands)
        self.assertIn("Z123CHILD", result.stdout)
        self.assertNotIn("MUST-NOT-PRINT", result.stdout)

    def test_cleanup_removes_generated_domain_override_after_failure(self):
        result, _ = self.run_step(
            step("terraform.yml", "plan", "Clean sensitive files off the runner"),
            files={"ci-domain.auto.tfvars.json": '{"domain_name":"stale.invalid"}',
                   "ci-deployment.tfvars.json": "{}", "terraform.tfvars": "protected"},
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.files, {})

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
        script = step("terraform.yml", "apply", "Recheck branch immediately before apply")
        script += "\n" + step("terraform.yml", "apply", "terraform apply (exact saved plan — never re-planned)")
        result, commands = self.run_step(script, CURRENT_SHA="b" * 40)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(command[0] == "terraform" for command in commands))
        result, commands = self.run_step(script)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(["terraform", "apply", "-input=false", "tfplan"], commands)
        workflow = yaml.safe_load((ROOT / ".github/workflows/terraform.yml").read_text())
        steps = workflow["jobs"]["apply"]["steps"]
        apply_index = next(i for i, s in enumerate(steps) if s.get("name") == "terraform apply (exact saved plan — never re-planned)")
        self.assertEqual(steps[apply_index - 1]["name"], "Recheck branch immediately before apply")
        self.assertIn("GH_TOKEN", steps[apply_index - 1]["env"])
        self.assertNotIn("GH_TOKEN", steps[apply_index]["env"])

    def test_apply_rechecks_ecr_scope(self):
        result, commands = self.run_step(
            step("terraform.yml", "apply", "terraform apply (exact saved plan — never re-planned)"),
            PLAN_SCOPE="ecr-bootstrap", changes=[{
                "address": "aws_ecs_service.web", "type": "aws_ecs_service",
                "change": {"actions": ["update"]},
            }],
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ECR bootstrap", result.stderr)
        self.assertFalse(any(c[:2] == ["terraform", "apply"] for c in commands))

    def test_automatic_dev_plan_preserves_external_certificates_without_overrides(self):
        script = step("terraform.yml", "plan", "Configure dev domain overrides")
        script += "\n" + step("terraform.yml", "plan", "Check existing certificates without changing DNS")
        script += "\n" + step("terraform.yml", "plan", "terraform plan")
        state = {"format_version": "1.0", "values": {"root_module": {"resources": [
            {"address": "aws_cloudfront_distribution.main", "mode": "managed",
             "type": "aws_cloudfront_distribution", "name": "main",
             "values": {"viewer_certificate": [{"acm_certificate_arn": CF}]}},
            {"address": "aws_lb_listener.https", "mode": "managed", "type": "aws_lb_listener",
             "name": "https", "values": {"certificate_arn": ALB}},
        ]}}}
        result, commands = self.run_step(
            script, DISPATCH="false", DOMAIN_NAME_DEV="", HOSTED_ZONE_NAME_DEV="",
            CERTIFICATE_MODE_DEV="", CERTIFICATE_MODE="preserve", ADVISORY="true",
            TEST_STATE_JSON=json.dumps(state),
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        plan = next(c for c in commands if c[:2] == ["terraform", "plan"])
        self.assertIn("-var-file=ci-deployment.tfvars.json", plan)
        self.assertIn(["tfvars", {"publish_service_dns": False,
                                 "existing_cf_certificate_arn": CF,
                                 "existing_alb_certificate_arn": ALB}], commands)
        workflow = yaml.safe_load((ROOT / ".github/workflows/terraform.yml").read_text())
        preflight = next(s for s in workflow["jobs"]["plan"]["steps"]
                         if s.get("name") == "Check existing certificates without changing DNS")
        self.assertIn("env.TARGET == 'dev'", preflight["if"])

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
        self.assertIn("managed", result.summary)

    def test_persistent_managed_mode_allows_dns_free_ecr_only_bootstrap(self):
        script = step("terraform.yml", "plan", "Configure dev domain overrides")
        script += "\n" + step("terraform.yml", "plan", "Check existing certificates without changing DNS")
        script += "\n" + step("terraform.yml", "plan", "terraform plan")
        result, commands = self.run_step(
            script, DISPATCH="true", PLAN_SCOPE="ecr-bootstrap",
            DOMAIN_NAME_DEV="dev.example.com", HOSTED_ZONE_NAME_DEV="dev.example.com",
            CERTIFICATE_MODE_DEV="managed", CERTIFICATE_MODE="managed",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        plan = next(c for c in commands if c[:2] == ["terraform", "plan"])
        self.assertIn("-target=aws_ecr_repository.web", plan)
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
        result, commands = self.run_step(script, DISPATCH="true")
        self.assertNotEqual(result.returncode, 0)
        self.assertRegex(result.stderr, "explicit.*ARN")
        self.assertFalse(any(c[:2] == ["terraform", "plan"] for c in commands))
        self.assertFalse(any(c[:2] == ["aws", "acm"] for c in commands))
        result, commands = self.run_step(script, DISPATCH="true", CF_CERTIFICATE_ARN='$(printf injected);value')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(c[:2] == ["terraform", "plan"] for c in commands))
        self.assertNotIn("injected", result.stdout)
        self.assertFalse(any(c[0] == "aws" for c in commands))

    def test_external_certificate_summary_redacts_arns_and_account_and_chain_failure_blocks_plan(self):
        script = step("terraform.yml", "plan", "Check existing certificates without changing DNS")
        script += "\n" + step("terraform.yml", "plan", "terraform plan")
        result, commands = self.run_step(script, DISPATCH="true", CF_CERTIFICATE_ARN=CF, ALB_CERTIFICATE_ARN=ALB)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("arn:", result.summary)
        self.assertNotIn("123456789012", result.summary)
        self.assertIn("external:55555555", result.summary)
        result, commands = self.run_step(script, DISPATCH="true", CF_CERTIFICATE_ARN=CF,
                                         ALB_CERTIFICATE_ARN=ALB, OPENSSL_EXIT="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(c[:2] == ["terraform", "plan"] for c in commands))

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

    def test_advisory_preflight_is_offline_and_demo_secret_stays_in_plan(self):
        workflow = yaml.safe_load((ROOT / ".github/workflows/terraform.yml").read_text())
        self.assertNotIn("actions", workflow["permissions"])
        self.assertEqual(workflow["jobs"]["apply"]["permissions"]["actions"], "read")
        steps = workflow["jobs"]["plan"]["steps"]
        cert = next(s for s in steps if s.get("id") == "dns")
        self.assertIn("github.event_name == 'workflow_dispatch'", cert["if"])
        self.assertEqual(cert["env"]["ADVISORY"], "${{ github.event_name != 'workflow_dispatch' }}")
        self.assertNotIn("TF_VAR_demo_password", cert["env"])
        plan = next(s for s in steps if s.get("name") == "terraform plan")
        self.assertIn("TF_VAR_demo_password", plan["env"])
        cleanup = next(s for s in steps if s.get("name") == "Clean sensitive files off the runner")
        self.assertEqual(cleanup["if"], "always()")
        self.assertIn("ci-state.json", cleanup["run"])
        self.assertIn("ci-deployment.tfvars.json", cleanup["run"])

    def test_smoke_retains_host_sni_and_tls_without_service_dns(self):
        script = "cd ../..\n" + step("deploy-web.yml", "deploy", "Smoke test")
        result, commands = self.run_step(
            script, PUBLIC_URL="https://dev.example.com", CLOUDFRONT_DOMAIN="d123.cloudfront.net",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        curl = commands[0]
        self.assertIn("dev.example.com:443:d123.cloudfront.net:443", curl)
        self.assertIn("https://dev.example.com/api/health", curl)
        self.assertNotIn("-k", curl)
        self.assertNotIn("--insecure", curl)

    def test_smoke_rejects_malformed_destinations_before_curl(self):
        script = "cd ../..\n" + step("deploy-web.yml", "deploy", "Smoke test")
        for url, domain in (
            ("https://dev.example.com/path", "d123.cloudfront.net"),
            ("https://user@dev.example.com", "d123.cloudfront.net"),
            ("https://dev.example.com:8443", "d123.cloudfront.net"),
            ("https://dev.example.com", "foo.d123.cloudfront.net"),
            ("https://dev.example.com/$(touch injected)", "d123.cloudfront.net"),
        ):
            result, commands = self.run_step(script, PUBLIC_URL=url, CLOUDFRONT_DOMAIN=domain)
            self.assertNotEqual(result.returncode, 0, result.stdout)
            self.assertFalse(any(c[0] == "curl" for c in commands))


if __name__ == "__main__":
    unittest.main()
