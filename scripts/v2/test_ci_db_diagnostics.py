import json
import unittest
from pathlib import Path
import yaml
from ci_db_diagnostics import collect


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
