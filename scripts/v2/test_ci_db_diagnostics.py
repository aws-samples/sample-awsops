import json
import unittest
from pathlib import Path
import yaml
from ci_db_diagnostics import collect, configuration_snapshot


class DatabaseDiagnosticsTests(unittest.TestCase):
    def config(self):
        return {"project": "awsops-dev", "region": "ap-northeast-2", "account": "123456789012"}

    def test_classifies_only_database_events_without_echoing_messages(self):
        errors = [
            ("PAM authentication failed for user \"awsops_web\"", "iam_database_auth"),
            ("password authentication failed SECRET", "database_auth"),
            ("role \"awsops_web\" does not exist", "web_role_missing"),
            ("permission denied for table SECRET", "database_permission"),
            ("Connection terminated due to connection timeout", "connection_timeout"),
            ("getaddrinfo ENOTFOUND SECRET", "database_dns"),
            ("connect ECONNREFUSED SECRET", "connection_refused"),
            ("Could not load credentials from any providers SECRET", "aws_credentials"),
            ("unable to verify the first certificate SECRET", "tls"),
            ("unrecognized SECRET", "unclassified"),
        ]
        calls = []

        def aws(args):
            calls.append(args)
            if args[0] == "sts":
                return {"Account": self.config()["account"]}
            return {"events": [
                {"message": json.dumps({"evt": "db_ping_failed", "err": error}), "timestamp": 1000 + i}
                for i, (error, _) in enumerate(errors)
            ] + [{"message": '{"evt":"other","err":"SECRET"}', "timestamp": 2000}]}

        result = collect(self.config(), aws, now_ms=5_000_000)
        self.assertEqual(result["events"], len(errors))
        self.assertEqual(result["categories"], sorted({category for _, category in errors}))
        self.assertFalse(result["truncated"])
        self.assertNotIn("SECRET", json.dumps(result))
        self.assertEqual([args[:2] for args in calls], [["sts", "get-caller-identity"], ["logs", "filter-log-events"]])
        self.assertIn("/ecs/awsops-dev-web", calls[1])

    def test_identity_and_scope_fail_before_log_access(self):
        for changed in [{"project": "../other"}, {"region": "us-east-1"}, {"account": "bad"}]:
            with self.assertRaises(ValueError):
                collect({**self.config(), **changed}, lambda _: self.fail("AWS call"), 0)
        calls = []
        with self.assertRaises(ValueError):
            collect(self.config(), lambda args: calls.append(args) or {"Account": "999999999999"}, 0)
        self.assertEqual(len(calls), 1)

    def test_pagination_is_bounded_and_incomplete_results_are_labeled(self):
        calls = []

        def aws(args):
            calls.append(args)
            if args[0] == "sts":
                return {"Account": self.config()["account"]}
            return {"events": [], "nextToken": str(len(calls))}

        result = collect(self.config(), aws, 5_000_000)
        self.assertTrue(result["truncated"])
        self.assertEqual(result["events"], 0)
        self.assertEqual(len(calls), 4)

    def test_workflow_diagnostics_are_opt_in_dev_and_plan_only(self):
        root = Path(__file__).resolve().parents[2]
        workflow = yaml.safe_load((root / ".github/workflows/terraform.yml").read_text())
        steps = workflow["jobs"]["plan"]["steps"]
        diag = next(step for step in steps if step.get("name") == "Read safe development database diagnostics")
        self.assertIn("env.TARGET == 'dev'", diag["if"])
        self.assertIn("vars.CI_DB_DIAGNOSTICS_DEV == 'true'", diag["if"])
        self.assertNotIn("secrets.", json.dumps(diag))
        self.assertFalse(any(step.get("name") == diag["name"] for step in workflow["jobs"]["apply"]["steps"]))

    def test_configuration_projection_exposes_booleans_not_resource_values(self):
        account = self.config()["account"]
        documents = {
            "rds": {"DBClusters": [{"Status": "available", "IAMDatabaseAuthenticationEnabled": True,
                "Endpoint": "PRIVATE_ENDPOINT", "DatabaseName": "awsops", "DbClusterResourceId": "cluster-example",
                "VpcSecurityGroups": [{"VpcSecurityGroupId": "sg-db"}]}]},
            "ecs": {"services": [{"taskDefinition": "PRIVATE_DEFINITION", "runningCount": 1,
                "networkConfiguration": {"awsvpcConfiguration": {"securityGroups": ["sg-web"]}}}]},
            "definition": {"taskDefinition": {"taskRoleArn": f"arn:aws:iam::{account}:role/awsops-dev-task",
                "containerDefinitions": [{"name": "web", "environment": [
                    {"name": name, "value": value} for name, value in {
                        "AURORA_ENDPOINT": "PRIVATE_ENDPOINT", "AURORA_DATABASE": "awsops",
                        "AURORA_USER": "awsops_web", "AWS_REGION": "ap-northeast-2",
                    }.items()]}]}},
            "ec2": {"SecurityGroups": [{"IpPermissions": [{"IpProtocol": "tcp", "FromPort": 5432,
                "ToPort": 5432, "UserIdGroupPairs": [{"GroupId": "sg-web"}]}]}]},
            "iam": {"PolicyDocument": {"Statement": [{"Effect": "Allow", "Action": ["rds-db:connect"],
                "Resource": f"arn:aws:rds-db:ap-northeast-2:{account}:dbuser:cluster-example/awsops_web"}]}},
        }
        def aws(args):
            return documents["definition" if args[1] == "describe-task-definition" else args[0]]
        result = configuration_snapshot(self.config(), aws)
        self.assertTrue(all(value is True for key, value in result.items()
                            if key not in {"explicit_credential_override", "web_running_count"}))
        self.assertFalse(result["explicit_credential_override"])
        self.assertNotIn("PRIVATE", json.dumps(result))
        self.assertNotIn(account, json.dumps(result))
        documents["ec2"]["SecurityGroups"][0]["IpPermissions"] = []
        documents["iam"]["PolicyDocument"]["Statement"][0]["Resource"] = "different"
        result = configuration_snapshot(self.config(), aws)
        self.assertFalse(result["db_ingress_from_web_groups"])
        self.assertFalse(result["identity_policy_has_expected_connect_allow"])
