import json
import copy
import io
import os
import runpy
import subprocess
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch
import yaml
import ci_db_diagnostics as diagnostics
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
            ("timeout exceeded when trying to connect", "connection_timeout"),
            ("Connection terminated unexpectedly", "connection_lost"),
            ("sorry, too many clients already", "connection_limit"),
            ("remaining connection slots are reserved for non-replication superuser connections", "connection_limit"),
            ("too many connections for role awsops_web", "connection_limit"),
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
                {"message": json.dumps({"evt": "db_ping_failed", "err": error}), "timestamp": 1_500_000 + i}
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
        self.assertEqual(result["status"], "partial")
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
                "ServerlessV2ScalingConfiguration": {"MinCapacity": 0.5, "MaxCapacity": 2},
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
        for key in ("cluster_available", "iam_database_auth_enabled", "endpoint_matches_cluster",
                    "database_matches", "user_matches", "region_matches", "task_role_matches",
                    "db_ingress_from_web_groups", "identity_policy_has_expected_connect_allow"):
            self.assertIs(result[key], True)
        self.assertFalse(result["credential_env_override_declared"])
        self.assertFalse(result["credential_secret_override_declared"])
        self.assertEqual(result["status"], "available")
        self.assertNotIn("PRIVATE", json.dumps(result))
        self.assertNotIn(account, json.dumps(result))
        documents["ec2"]["SecurityGroups"][0]["IpPermissions"] = []
        documents["iam"]["PolicyDocument"]["Statement"][0]["Resource"] = "different"
        result = configuration_snapshot(self.config(), aws)
        self.assertFalse(result["db_ingress_from_web_groups"])
        self.assertFalse(result["identity_policy_has_expected_connect_allow"])


class AdvisoryDiagnosticsTests(unittest.TestCase):
    """Exercise the real CLI; only external AWS processes are replaced."""

    def setUp(self):
        self.config = {"project": "awsops-dev", "region": "ap-northeast-2", "account": "123456789012"}
        self.private = "PRIVATE_FIXTURE_VALUE"
        self.calls = []
        self.documents = {
            ("sts", "get-caller-identity"): {"Account": self.config["account"]},
            ("logs", "filter-log-events"): {"events": [
                {"message": json.dumps({"evt": "db_ping_failed", "err": "ETIMEDOUT " + self.private}),
                 "timestamp": 4_999_000}
            ]},
            ("rds", "describe-db-clusters"): {"DBClusters": [{
                "Status": "available", "IAMDatabaseAuthenticationEnabled": True,
                "ServerlessV2ScalingConfiguration": {"MinCapacity": 0.5, "MaxCapacity": 2},
                "Endpoint": self.private, "DatabaseName": "awsops",
                "DbClusterResourceId": "cluster-example",
                "VpcSecurityGroups": [{"VpcSecurityGroupId": "sg-db"}],
            }]},
            ("ecs", "describe-services"): {"services": [{
                "taskDefinition": "service-target-revision",
                "runningCount": 2, "desiredCount": 2,
                "deployments": [
                    {"status": "PRIMARY", "taskDefinition": "service-target-revision", "runningCount": 1},
                    {"status": "ACTIVE", "taskDefinition": "old-running-revision", "runningCount": 1},
                ],
                "networkConfiguration": {"awsvpcConfiguration": {"securityGroups": ["sg-web"]}},
            }], "failures": []},
            ("ecs", "describe-task-definition"): {"taskDefinition": {
                "taskRoleArn": "arn:aws:iam::123456789012:role/awsops-dev-task",
                "containerDefinitions": [{"name": "web", "environment": [
                    {"name": k, "value": v} for k, v in {
                        "AURORA_ENDPOINT": self.private, "AURORA_DATABASE": "awsops",
                        "AURORA_USER": "awsops_web", "AWS_REGION": "ap-northeast-2",
                    }.items()
                ], "secrets": [], "environmentFiles": []}],
            }},
            ("ec2", "describe-security-groups"): {"SecurityGroups": [{"IpPermissions": [{
                "IpProtocol": "tcp", "FromPort": 5432, "ToPort": 5432,
                "UserIdGroupPairs": [{"GroupId": "sg-web"}],
            }]}]},
            ("iam", "get-role-policy"): {"PolicyDocument": {"Statement": [{
                "Effect": "Allow", "Action": "rds-db:connect",
                "Resource": "arn:aws:rds-db:ap-northeast-2:123456789012:dbuser:cluster-example/awsops_web",
            }]}},
            ("rds", "describe-db-log-files"): {"DescribeDBLogFiles": [
                {"LogFileName": "error/postgresql.log.latest", "LastWritten": 4_900_000, "Size": 1000},
            ]},
            ("rds", "download-db-log-file-portion"): {
                "LogFileData": 'LOG: role "other" password authentication failed\n'
                               'FATAL: role "awsops_web" PAM authentication failed PRIVATE_FIXTURE_VALUE\n'
                               'FATAL: role "awsops_web" no pg_hba.conf entry, SSL off PRIVATE_FIXTURE_VALUE\n',
                "Marker": "opaque-tail-position", "AdditionalDataPending": False,
            },
            ("cloudwatch", "get-metric-data"): {"MetricDataResults": [
                {"Id": key, "StatusCode": "Complete", "Timestamps": [], "Values": []}
                for key in ("iam_requests", "iam_success", "iam_failure", "iam_invalid_token",
                            "iam_permissions", "iam_throttling", "iam_server_error",
                            "cpu", "free_memory", "capacity")
            ]},
        }

    def failed_read(self, operation, code="AccessDenied"):
        return subprocess.CalledProcessError(
            254, ["aws", *operation], output=self.private,
            stderr=f"An error occurred ({code}): {self.private}")

    def aws_process(self, argv, **kwargs):
        self.assertEqual(argv[0], "aws")
        operation = tuple(argv[1:3])
        self.assertIn(operation, self.documents, "Unexpected AWS operation")
        self.calls.append(argv)
        document = self.documents[operation]
        if callable(document):
            document = document(argv)
        if isinstance(document, Exception):
            raise document
        return subprocess.CompletedProcess(argv, 0, json.dumps(document), self.private)

    def invoke(self, arguments=("--target", "dev"), environment=None):
        stdout, stderr = io.StringIO(), io.StringIO()
        exit_code = 0
        env = {"GITHUB_EVENT_NAME": "workflow_dispatch", "CI_DB_DIAGNOSTICS_DEV": "true",
               **(environment or {})}
        with patch.dict(os.environ, env), patch("sys.argv", ["ci_db_diagnostics.py", *arguments]), \
                patch("sys.stdin", io.StringIO(json.dumps(json.dumps(self.config)))), \
                patch("subprocess.run", side_effect=self.aws_process), \
                patch("time.time", return_value=5000), \
                redirect_stdout(stdout), redirect_stderr(stderr):
            try:
                runpy.run_path(str(Path(diagnostics.__file__)), run_name="__main__")
            except SystemExit as exited:
                exit_code = exited.code
        combined = stdout.getvalue() + stderr.getvalue()
        self.assertNotIn(self.private, combined)
        self.assertNotIn(self.config["account"], combined)
        self.assertNotIn("arn:", combined)
        self.assertNotIn("Traceback", combined)
        payload = json.loads(stdout.getvalue()) if stdout.getvalue().strip() else {}
        return payload, exit_code

    def test_missing_log_group_keeps_configuration(self):
        op = ("logs", "filter-log-events")
        self.documents[op] = self.failed_read(op, "ResourceNotFoundException")
        result, _ = self.invoke()
        self.assertIn("logs", result)
        self.assertEqual(result["logs"]["status"], "unavailable")
        self.assertTrue(result["configuration"]["endpoint_matches_cluster"])

    def test_missing_inline_policy_keeps_logs_and_other_configuration(self):
        op = ("iam", "get-role-policy")
        self.documents[op] = self.failed_read(op, "NoSuchEntity")
        result, _ = self.invoke()
        self.assertIn("logs", result)
        self.assertEqual(result["logs"]["category_counts"], {"connection_timeout": 1})
        config = result["configuration"]
        self.assertTrue(config["endpoint_matches_cluster"])
        self.assertTrue(config["sources_unavailable"]["identity_policy"])
        self.assertIsNone(config["identity_policy_has_expected_connect_allow"])

    def test_missing_cluster_keeps_service_and_logs(self):
        op = ("rds", "describe-db-clusters")
        self.documents[op] = self.failed_read(op, "DBClusterNotFoundFault")
        result, _ = self.invoke()
        self.assertIn("logs", result)
        self.assertEqual(result["logs"]["events"], 1)
        self.assertTrue(result["configuration"]["sources_unavailable"]["cluster"])
        self.assertIsNone(result["configuration"]["endpoint_matches_cluster"])
        self.assertTrue(result["configuration"]["user_matches"])
        self.assertFalse(result["configuration"]["sources_unavailable"]["identity_policy"])
        self.assertIn("derived_unavailable", result["configuration"])
        self.assertTrue(result["configuration"]["derived_unavailable"]["identity_policy_has_expected_connect_allow"])

    def test_missing_service_response_keeps_cluster_and_logs(self):
        self.documents[("ecs", "describe-services")] = {
            "services": [], "failures": [{"arn": self.private, "reason": "MISSING"}]}
        result, _ = self.invoke()
        self.assertIn("logs", result)
        self.assertEqual(result["logs"]["events"], 1)
        self.assertTrue(result["configuration"]["cluster_available"])
        self.assertIsNone(result["configuration"]["user_matches"])
        self.assertTrue(result["configuration"]["sources_unavailable"]["service_target_definition"])
        self.assertFalse(result["configuration"]["sources_unavailable"]["db_security_groups"])
        self.assertIn("derived_unavailable", result["configuration"])
        self.assertTrue(result["configuration"]["derived_unavailable"]["db_ingress_from_web_groups"])

    def test_second_page_failure_retains_first_page_and_actual_window(self):
        first = copy.deepcopy(self.documents[("logs", "filter-log-events")])
        first["nextToken"] = "page-two"
        def pages(argv):
            if "--next-token" in argv:
                self.assertEqual(argv[argv.index("--next-token") + 1], "page-two")
                raise self.failed_read(("logs", "filter-log-events"))
            return first
        self.documents[("logs", "filter-log-events")] = pages
        result, _ = self.invoke()
        self.assertIn("logs", result)
        logs = result["logs"]
        self.assertEqual(logs["status"], "partial")
        self.assertEqual(logs["events"], 1)
        self.assertEqual(logs["pages_read"], 1)
        self.assertTrue(logs["truncated"])
        self.assertEqual(logs["scan_order"], "oldest_first")
        self.assertEqual(logs["window_start_ms"], 1_400_000)
        self.assertEqual(logs["window_end_ms"], 5_000_000)
        self.assertEqual(logs["earliest_timestamp_ms"], 4_999_000)
        self.assertEqual(logs["latest_timestamp_ms"], 4_999_000)
        for argv in self.calls:
            if argv[1] == "logs":
                self.assertEqual(argv[argv.index("--end-time") + 1], "5000000")
                self.assertEqual(argv[argv.index("--limit") + 1], "100")
                self.assertIn("--no-paginate", argv)

    def test_pghba_is_not_mislabeled_tls_and_counts_explain_discarded_records(self):
        messages = [
            {"evt": "db_ping_failed", "err": 'no pg_hba.conf entry for host PRIVATE_FIXTURE_VALUE, no encryption'},
            {"evt": "db_ping_failed", "err": 'no pg_hba.conf entry for host PRIVATE_FIXTURE_VALUE, SSL off'},
            {"evt": "db_ping_failed", "err": "SSL certificate error"},
            {"evt": "other", "err": "ETIMEDOUT"},
            [],
        ]
        self.documents[("logs", "filter-log-events")] = {"events": [
            {"message": json.dumps(message), "timestamp": 4_999_000} for message in messages
        ] + [{"message": "not json " + self.private, "timestamp": 4_999_000},
             {"message": json.dumps({"evt": "db_ping_failed", "err": "ETIMEDOUT"}), "timestamp": 5_000_000}]}
        result, _ = self.invoke()
        self.assertIn("logs", result)
        self.assertEqual(result["logs"]["category_counts"], {"database_hba": 2, "tls": 1})
        self.assertEqual(result["logs"]["events"], 3)
        self.assertEqual(result["logs"]["ignored"], 3)
        self.assertEqual(result["logs"]["unparsed"], 1)

    def test_declared_credentials_and_environment_files_are_not_runtime_proof(self):
        container = self.documents[("ecs", "describe-task-definition")]["taskDefinition"]["containerDefinitions"][0]
        container["secrets"] = [{"name": "AWS_SESSION_TOKEN", "valueFrom": self.private}]
        container["environmentFiles"] = [{"type": "s3", "value": self.private}]
        result, _ = self.invoke()
        config = result["configuration"]
        self.assertIn("credential_secret_override_declared", config)
        self.assertTrue(config["credential_secret_override_declared"])
        self.assertFalse(config["credential_env_override_declared"])
        self.assertTrue(config["environment_files_declared"])
        self.assertEqual(config["credential_check_basis"], "declarations_only_not_runtime")
        container["environment"].append({"name": "AWS_SESSION_TOKEN", "value": self.private})
        result, _ = self.invoke()
        self.assertTrue(result["configuration"]["credential_env_override_declared"])

    def test_service_target_is_not_claimed_as_running_revision(self):
        result, _ = self.invoke()
        config = result["configuration"]
        self.assertEqual(config.get("definition_basis"), "service_target_not_running_tasks")
        self.assertEqual(config["service_running_count"], 2)
        self.assertNotIn("web_running_count", config)

    def test_explicit_dev_target_is_required_before_any_aws_read(self):
        for argv in [(), ("--target", "main"), ("--target", self.private),
                     ("--target", "dev", "--profile", self.private)]:
            self.calls.clear()
            result, code = self.invoke(argv)
            self.assertNotEqual(code, 0)
            self.assertEqual(self.calls, [])
            self.assertEqual(result.get("status"), "unavailable")

    def test_wrong_account_prevents_log_and_metadata_access(self):
        self.documents[("sts", "get-caller-identity")] = {"Account": "999999999999"}
        result, code = self.invoke()
        self.assertNotEqual(code, 0)
        self.assertEqual([argv[1:3] for argv in self.calls], [["sts", "get-caller-identity"]])
        self.assertEqual(result.get("status"), "unavailable")

    def test_cli_mutation_is_rejected_before_process_execution(self):
        self.assertTrue(callable(getattr(diagnostics, "aws_read", None)))
        with patch("subprocess.run", side_effect=AssertionError("Must not execute")):
            for args in [["ecs", "update-service"], ["iam", "put-role-policy"],
                         ["secretsmanager", "get-secret-value"], ["cloudwatch", "put-metric-data"],
                         ["cloudwatch", "put-metric-alarm"]]:
                with self.assertRaises(diagnostics.ReadOnlyViolation):
                    diagnostics.aws_read(args)

    def test_optional_workflow_failure_does_not_weaken_required_gates(self):
        root = Path(__file__).resolve().parents[2]
        workflow = yaml.safe_load((root / ".github/workflows/terraform.yml").read_text())
        steps = workflow["jobs"]["plan"]["steps"]
        diag = next(s for s in steps if s.get("name") == "Read safe development database diagnostics")
        self.assertIs(diag.get("continue-on-error"), True)
        self.assertIn("github.event_name == 'workflow_dispatch'", diag["if"])
        self.assertGreater(steps.index(diag), next(i for i, s in enumerate(steps)
                                                if s.get("name") == "Upload plan artifact (encrypted)"))
        for name in ["terraform plan", "Check planned DNS operations", "Encrypt plan artifact"]:
            step = next(s for s in steps if s.get("name") == name)
            self.assertFalse(step.get("continue-on-error", False))
        # Run the actual shell pipeline with a failing upstream command. The real
        # helper sees empty input, so it must not reach AWS. No scratch files.
        fixture = 'terraform() { printf "%s\\n" "$PRIVATE_TEST_VALUE" >&2; return 1; }\n'
        process = subprocess.run(
            ["bash", "--noprofile", "--norc", "-c", fixture + diag["run"]],
            cwd=root / "terraform/foundation", capture_output=True, text=True, timeout=10,
            env={**os.environ, "PRIVATE_TEST_VALUE": self.private, "TARGET": "dev",
                 "GITHUB_EVENT_NAME": "workflow_dispatch", "CI_DB_DIAGNOSTICS_DEV": "true",
                 "GITHUB_STEP_SUMMARY": "/dev/null", "PYTHONDONTWRITEBYTECODE": "1"})
        self.assertNotIn(self.private, process.stdout + process.stderr)
        self.assertNotIn("Traceback", process.stdout + process.stderr)
        self.assertIn("unavailable", process.stdout + process.stderr)
        self.assertIn('```json\n{"status": "unavailable"}\n```', process.stdout)

    def test_rds_server_tail_uses_latest_discovered_file_without_download_marker(self):
        result, _ = self.invoke()
        self.assertIn("server_logs", result)
        server = result["server_logs"]
        self.assertEqual(server["status"], "available")
        self.assertEqual(server["category_counts"], {"database_hba": 1, "iam_database_auth": 1})
        self.assertEqual(server["matching_lines"], 2)
        self.assertEqual(server["lines_examined"], 3)
        self.assertFalse(server["listing_truncated"])
        self.assertFalse(server["tail_truncated"])
        listing = next(argv for argv in self.calls if argv[2] == "describe-db-log-files")
        self.assertEqual(listing[listing.index("--db-instance-identifier") + 1], "awsops-dev-aurora-1")
        self.assertEqual(listing[listing.index("--filename-contains") + 1], "postgresql")
        download = next(argv for argv in self.calls if argv[2] == "download-db-log-file-portion")
        self.assertEqual(download[download.index("--log-file-name") + 1], "error/postgresql.log.latest")
        self.assertEqual(download[download.index("--number-of-lines") + 1], "500")
        self.assertNotIn("--marker", download)
        self.assertNotIn("postgresql.log", json.dumps(result))
        self.assertNotIn("awsops_web", json.dumps(result))

    def test_rds_server_listing_is_bounded_and_tail_limits_are_disclosed(self):
        listing_calls = []
        def listing(argv):
            listing_calls.append(argv)
            page = len(listing_calls)
            return {"DescribeDBLogFiles": [
                {"LogFileName": f"error/postgresql.log.{page}", "LastWritten": page * 1000, "Size": 900000}],
                "Marker": f"next-{page}"}
        self.documents[("rds", "describe-db-log-files")] = listing
        self.documents[("rds", "download-db-log-file-portion")]["AdditionalDataPending"] = True
        result, _ = self.invoke()
        self.assertIn("server_logs", result)
        self.assertEqual(len(listing_calls), 3)
        self.assertEqual(result["server_logs"]["status"], "partial")
        self.assertTrue(result["server_logs"]["listing_truncated"])
        self.assertTrue(result["server_logs"]["tail_truncated"])
        self.assertEqual(result["server_logs"]["selected_last_written_ms"], 3000)

    def test_server_log_failures_do_not_erase_other_diagnostics(self):
        for op, code in [(("rds", "describe-db-log-files"), "DBInstanceNotFound"),
                         (("rds", "download-db-log-file-portion"), "AccessDenied")]:
            with self.subTest(operation=op):
                saved = self.documents[op]
                self.documents[op] = self.failed_read(op, code)
                result, _ = self.invoke()
                self.documents[op] = saved
                self.assertIn("server_logs", result)
                self.assertEqual(result["server_logs"]["status"],
                                 "partial" if op[1] == "download-db-log-file-portion" else "unavailable")
                self.assertEqual(result["logs"]["events"], 1)
                self.assertTrue(result["configuration"]["endpoint_matches_cluster"])

    def test_empty_server_log_list_is_unavailable_without_guessing_filename(self):
        self.documents[("rds", "describe-db-log-files")] = {"DescribeDBLogFiles": []}
        result, _ = self.invoke()
        self.assertIn("server_logs", result)
        self.assertEqual(result["server_logs"]["status"], "unavailable")
        self.assertFalse(any(argv[2] == "download-db-log-file-portion" for argv in self.calls))

    def test_connection_phases_use_json_or_filter_and_keep_latest_valid_timing(self):
        phases = ["dns_tcp_connect", "tcp_connect", "tls_negotiation", "tls_handshake",
                  "postgres_startup", "iam_token", "postgres_authentication"]
        events = copy.deepcopy(self.documents[("logs", "filter-log-events")]["events"])
        for i, phase in enumerate(phases):
            events.append({"timestamp": 4_999_001 + i, "message": json.dumps({
                "evt": "db_connection_failed", "phase": phase, "elapsed_ms": 1000.5,
                "milestones_ms": {"dns_resolved": 1, "tcp_connected": 2, "ssl_accepted": 3,
                                  "tls_connected": 4, "password_requested": 5, "token_started": 6,
                                  "token_ready": 999, "authenticated": 1000, "private": self.private},
                "err": self.private,
            })})
        events.append({"timestamp": 4_999_999, "message": json.dumps({
            "evt": "db_connection_failed", "phase": self.private, "elapsed_ms": 1001,
            "milestones_ms": {"private": self.private},
        })})
        self.documents[("logs", "filter-log-events")] = {"events": events}
        result, _ = self.invoke()
        logs = result["logs"]
        self.assertIn("phase_counts", logs)
        self.assertEqual(logs["phase_counts"], {
            "dns_tcp_connect": 1, "tcp_connect": 1, "tls_negotiation": 1, "tls_handshake": 1,
            "postgres_startup": 1, "iam_token": 1, "postgres_authentication": 1})
        self.assertEqual(logs["event_counts"], {"db_ping_failed": 1, "db_connection_failed": 7})
        self.assertEqual(logs["category_counts"], {"connection_timeout": 1})
        self.assertEqual(logs["latest_connection"], {
            "phase": "postgres_authentication", "timestamp_ms": 4_999_007, "elapsed_ms": 1000.5,
            "milestones_ms": {"dns_resolved": 1, "tcp_connected": 2, "ssl_accepted": 3,
                              "tls_connected": 4, "password_requested": 5, "token_started": 6,
                              "token_ready": 999, "authenticated": 1000},
        })
        self.assertEqual(logs["ignored"], 1)
        self.assertEqual(logs.get("invalid_timing"), 1)
        log_call = next(argv for argv in self.calls if argv[1] == "logs")
        self.assertEqual(log_call[log_call.index("--filter-pattern") + 1],
                         '{ ($.evt = "db_ping_failed") || ($.evt = "db_connection_failed") }')

    def test_invalid_durations_and_unknown_milestones_never_reach_output(self):
        invalid = [float("nan"), float("inf"), -1, 3_600_001, True, "100", self.private]
        events = [{"timestamp": 4_999_000, "message": json.dumps({
            "evt": "db_connection_failed", "phase": "iam_token", "elapsed_ms": duration,
        })} for duration in invalid]
        events.append({"timestamp": 4_999_001, "message": json.dumps({
            "evt": "db_connection_failed", "phase": "iam_token", "elapsed_ms": 1000,
            "milestones_ms": {"dns_resolved": float("nan"), "tcp_connected": -1,
                              "ssl_accepted": 3_600_001, "tls_connected": True,
                              "password_requested": "100", "token_started": 0,
                              "token_ready": 1001, "authenticated": self.private, "private": 1},
        })})
        self.documents[("logs", "filter-log-events")] = {"events": events}
        result, _ = self.invoke()
        logs = result["logs"]
        self.assertIn("phase_counts", logs)
        self.assertEqual(logs["phase_counts"], {"iam_token": 1})
        self.assertEqual(logs["latest_connection"]["milestones_ms"], {"token_started": 0})
        self.assertEqual(logs["events"], 1)
        self.assertEqual(logs["ignored"], len(invalid))
        self.assertEqual(logs.get("discarded_milestones"), 8)

    def test_nonobject_milestones_and_out_of_order_events_keep_safe_latest_phase(self):
        self.documents[("logs", "filter-log-events")] = {"events": [
            {"timestamp": timestamp, "message": json.dumps({
                "evt": "db_connection_failed", "phase": phase, "elapsed_ms": elapsed,
                "milestones_ms": milestones,
            })} for timestamp, phase, elapsed, milestones in [
                (4_999_002, "iam_token", 0, self.private),
                (4_999_001, "tcp_connect", 3_600_000, None),
                (4_999_003, ["iam_token"], 0, {}),
            ]
        ]}
        result, _ = self.invoke()
        logs = result["logs"]
        self.assertIn("latest_connection", logs)
        self.assertEqual(logs["latest_connection"], {
            "phase": "iam_token", "timestamp_ms": 4_999_002, "elapsed_ms": 0, "milestones_ms": {}})
        self.assertEqual(logs["events"], 2)

    def test_wrong_source_or_flag_causes_zero_aws_calls(self):
        for environment in [
            {"GITHUB_EVENT_NAME": "push"}, {"GITHUB_EVENT_NAME": "pull_request"},
            {"GITHUB_EVENT_NAME": ""}, {"GITHUB_EVENT_NAME": self.private},
            {"CI_DB_DIAGNOSTICS_DEV": "false"}, {"CI_DB_DIAGNOSTICS_DEV": ""},
            {"CI_DB_DIAGNOSTICS_DEV": "True"}, {"CI_DB_DIAGNOSTICS_DEV": self.private},
        ]:
            with self.subTest(environment=environment):
                self.calls.clear()
                result, code = self.invoke(environment=environment)
                self.assertNotEqual(code, 0)
                self.assertEqual(self.calls, [])
                self.assertEqual(result, {"status": "unavailable"})

    def test_single_statement_object_can_prove_only_the_exact_allow(self):
        policy = self.documents[("iam", "get-role-policy")]["PolicyDocument"]
        policy["Statement"] = policy["Statement"][0]
        result, _ = self.invoke()
        self.assertTrue(result["configuration"]["identity_policy_has_expected_connect_allow"])
        self.assertFalse(result["configuration"]["derived_unavailable"]["identity_policy_has_expected_connect_allow"])

    def test_server_logs_separate_benign_mentions_from_error_severities(self):
        tail = self.documents[("rds", "download-db-log-file-portion")]
        tail["LogFileData"] = "\n".join([
            "2026-09-13 UTC [1] LOG: connection authorized: user=awsops_web SSL enabled (TLSv1.3)",
            "2026-09-13 UTC [2] LOG: statement: SELECT 'ERROR: awsops_web SSL'",
            "2026-09-13 UTC [3] DETAIL: awsops_web failed earlier",
            "2026-09-13 UTC [4] FATAL: awsops_web PAM authentication failed",
            "2026-09-13 UTC [5] ERROR: awsops_web password authentication failed",
            "2026-09-13 UTC [6] PANIC: awsops_web unknown failure",
            "2026-09-13 UTC [7] LOG: another_role SSL enabled",
            "2026-09-13 UTC [8] FATAL: another_role password authentication failed",
        ])
        result, _ = self.invoke()
        server = result["server_logs"]
        self.assertEqual(server["category_counts"], {
            "iam_database_auth": 1, "database_auth": 1, "unclassified": 1})
        self.assertEqual(server["matching_lines"], 3)
        self.assertEqual(server.get("benign_role_mentions"), 3)

    def test_previous_rotated_file_is_sampled_with_at_most_two_downloads(self):
        self.documents[("rds", "describe-db-log-files")] = {"DescribeDBLogFiles": [
            {"LogFileName": "postgresql.old", "LastWritten": 1, "Size": 30},
            {"LogFileName": "postgresql.previous", "LastWritten": 2, "Size": 30},
            {"LogFileName": "postgresql.current", "LastWritten": 3, "Size": 30},
        ]}
        def tail(argv):
            name = argv[argv.index("--log-file-name") + 1]
            return {"LogFileData": "FATAL: awsops_web PAM authentication failed"
                    if name == "postgresql.previous" else "LOG: awsops_web SSL enabled",
                    "AdditionalDataPending": False, "Marker": "opaque"}
        self.documents[("rds", "download-db-log-file-portion")] = tail
        result, _ = self.invoke()
        server = result["server_logs"]
        self.assertEqual(server["category_counts"], {"iam_database_auth": 1})
        calls = [argv for argv in self.calls if argv[2] == "download-db-log-file-portion"]
        self.assertEqual([argv[argv.index("--log-file-name") + 1] for argv in calls],
                         ["postgresql.current", "postgresql.previous"])
        self.assertEqual(server.get("files_selected"), 2)
        self.assertEqual(server.get("files_downloaded"), 2)
        self.assertNotIn("postgresql.", json.dumps(result))

    def test_postgres_messages_are_individually_classified_without_inventing_timeout(self):
        for message, category in [
            ("timeout exceeded when trying to connect", "connection_timeout"),
            ("Connection terminated unexpectedly", "connection_lost"),
            ("server closed the connection unexpectedly", "connection_lost"),
            ("sorry, too many clients already", "connection_limit"),
            ("remaining connection slots are reserved for roles with privileges", "connection_limit"),
            ("too many connections for role awsops_web", "connection_limit"),
        ]:
            with self.subTest(category=category):
                self.assertEqual(diagnostics.classify(message), {category})

    def test_wrong_workflow_context_stops_before_terraform_or_helper_execution(self):
        root = Path(__file__).resolve().parents[2]
        workflow = yaml.safe_load((root / ".github/workflows/terraform.yml").read_text())
        step = next(s for s in workflow["jobs"]["plan"]["steps"]
                    if s.get("name") == "Read safe development database diagnostics")
        fixture = 'terraform() { echo UNEXPECTED_EXTERNAL_READ >&2; return 1; }\n'
        for override in [{"GITHUB_EVENT_NAME": "push"}, {"GITHUB_EVENT_NAME": "pull_request"},
                         {"CI_DB_DIAGNOSTICS_DEV": "false"}, {"CI_DB_DIAGNOSTICS_DEV": ""},
                         {"TARGET": "main"}]:
            result = subprocess.run(
                ["bash", "--noprofile", "--norc", "-c", fixture + step["run"]],
                cwd=root / "terraform/foundation", capture_output=True, text=True, timeout=10,
                env={**os.environ, "TARGET": "dev", "GITHUB_EVENT_NAME": "workflow_dispatch",
                     "CI_DB_DIAGNOSTICS_DEV": "true", "GITHUB_STEP_SUMMARY": "/dev/null", **override})
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn("UNEXPECTED_EXTERNAL_READ", result.stdout + result.stderr)
            self.assertIn('```json\n{"status": "unavailable"}\n```', result.stdout)

    def test_empty_available_sample_explicitly_prohibits_error_free_inference(self):
        self.documents[("logs", "filter-log-events")] = {"events": []}
        result, _ = self.invoke()
        self.assertEqual(result["logs"]["status"], "available")
        self.assertEqual(result["logs"]["events"], 0)
        self.assertIs(result["logs"].get("no_matching_events"), True)
        self.assertIs(result["logs"].get("no_error_inference"), True)
        op = ("logs", "filter-log-events")
        self.documents[op] = self.failed_read(op)
        result, _ = self.invoke()
        self.assertIsNone(result["logs"]["no_matching_events"])
        self.assertIs(result["logs"]["no_error_inference"], True)

    def test_missing_or_malformed_web_container_is_not_a_source_read_failure(self):
        definition = self.documents[("ecs", "describe-task-definition")]["taskDefinition"]
        for containers, found in [
            ([], False), ([{"name": "sidecar"}], False), ("malformed", None),
            ([{"name": "web", "environment": "malformed"}], True),
        ]:
            with self.subTest(found=found):
                definition["containerDefinitions"] = containers
                result, _ = self.invoke()
                config = result["configuration"]
                self.assertFalse(config["sources_unavailable"]["service_target_definition"])
                self.assertEqual(config.get("web_container_found"), found)
                self.assertTrue(config["derived_unavailable"]["user_matches"])
                self.assertEqual(config["status"], "partial")

    def test_discarded_milestone_alone_degrades_the_sample(self):
        self.documents[("logs", "filter-log-events")] = {"events": [{
            "timestamp": 4_999_000, "message": json.dumps({
                "evt": "db_connection_failed", "phase": "iam_token", "elapsed_ms": 1,
                "milestones_ms": {"token_ready": 2},
            }),
        }]}
        result, _ = self.invoke()
        self.assertEqual(result["logs"]["invalid_timing"], 0)
        self.assertEqual(result["logs"]["discarded_milestones"], 1)
        self.assertEqual(result["logs"]["status"], "partial")

    def test_regex_input_limits_are_visible_as_partial_results(self):
        oversized = "x" * 4096 + " FATAL: awsops_web ETIMEDOUT"
        self.assertEqual(diagnostics.classify(oversized), {"unclassified"})
        self.documents[("logs", "filter-log-events")]["events"][0]["message"] = json.dumps({
            "evt": "db_ping_failed", "err": oversized})
        self.documents[("rds", "download-db-log-file-portion")]["LogFileData"] = oversized
        result, _ = self.invoke()
        self.assertTrue(result["logs"]["classification_truncated"])
        self.assertEqual(result["logs"]["status"], "partial")
        self.assertEqual(result["server_logs"]["category_counts"], {})
        self.assertTrue(result["server_logs"]["tail_truncated"])
        self.assertEqual(result["server_logs"]["status"], "partial")

    def test_readonly_violation_escapes_partial_read_wrappers(self):
        for reader in [
            lambda aws: configuration_snapshot(self.config, aws),
            lambda aws: diagnostics.rds_metric_snapshot(self.config, aws, 5_000_000),
            lambda aws: diagnostics.server_log_snapshot(self.config, aws),
        ]:
            with patch("subprocess.run") as process:
                try:
                    reader(lambda _: diagnostics.aws_read(["cloudwatch", "put-metric-data"]))
                except Exception as error:
                    self.assertEqual(type(error).__name__, "ReadOnlyViolation")
                else:
                    self.fail("Read-only violation was swallowed as unavailable metadata")
                process.assert_not_called()

    def test_rds_metrics_single_bounded_request_preserves_exact_series(self):
        documents = self.documents[("cloudwatch", "get-metric-data")]["MetricDataResults"]
        for item in documents:
            item.update(Timestamps=["1970-01-01T00:23:00Z", 1440], Values=[1, 2],
                        Label=self.private, Messages=[])
        result, _ = self.invoke()
        self.assertIn("rds_metrics", result)
        metrics = result["rds_metrics"]
        self.assertEqual(metrics["status"], "available")
        self.assertEqual((metrics["window_start_ms"], metrics["window_end_ms"]), (1_380_000, 4_980_000))
        self.assertEqual(metrics["probe_outcome"], "unknown")
        self.assertTrue(metrics["no_error_inference"])
        self.assertEqual(metrics["series"]["iam_requests"]["points"],
                         [{"timestamp_ms": 1_380_000, "value": 1}, {"timestamp_ms": 1_440_000, "value": 2}])
        calls = [argv for argv in self.calls if argv[1:3] == ["cloudwatch", "get-metric-data"]]
        self.assertEqual(len(calls), 1)
        argv = calls[0]
        self.assertIn("--no-paginate", argv)
        self.assertNotIn("--next-token", argv)
        self.assertEqual(argv[argv.index("--max-datapoints") + 1], "1000")
        queries = json.loads(argv[argv.index("--metric-data-queries") + 1])
        expected = {
            "iam_requests": ("IamDbAuthConnectionRequests", "Sum"),
            "iam_success": ("IamDbAuthConnectionSuccess", "Sum"),
            "iam_failure": ("IamDbAuthConnectionFailure", "Sum"),
            "iam_invalid_token": ("IamDbAuthConnectionFailureInvalidToken", "Sum"),
            "iam_permissions": ("IamDbAuthConnectionFailureInsufficientPermissions", "Sum"),
            "iam_throttling": ("IamDbAuthConnectionFailureThrottling", "Sum"),
            "iam_server_error": ("IamDbAuthConnectionFailureServerError", "Sum"),
            "cpu": ("CPUUtilization", "Average"), "free_memory": ("FreeableMemory", "Minimum"),
            "capacity": ("ServerlessDatabaseCapacity", "Average"),
        }
        self.assertEqual({q["Id"]: (q["MetricStat"]["Metric"]["MetricName"], q["MetricStat"]["Stat"])
                          for q in queries}, expected)
        for query in queries:
            stat = query["MetricStat"]
            self.assertEqual(stat["Period"], 60)
            self.assertEqual(stat["Metric"]["Namespace"], "AWS/RDS")
            self.assertEqual(stat["Metric"]["Dimensions"],
                             [{"Name": "DBInstanceIdentifier", "Value": "awsops-dev-aurora-1"}])

    def test_missing_empty_and_failed_metrics_never_imply_healthy(self):
        response = self.documents[("cloudwatch", "get-metric-data")]
        response["MetricDataResults"] = [
            {"Id": "iam_requests", "StatusCode": "Complete", "Timestamps": [], "Values": []},
            {"Id": "iam_success", "StatusCode": "Forbidden", "Timestamps": [], "Values": [],
             "Messages": [{"Code": self.private, "Value": self.private}]},
            {"Id": "cpu", "StatusCode": "Complete", "Timestamps": [1440], "Values": [0]},
        ]
        result, _ = self.invoke()
        self.assertIn("rds_metrics", result)
        metrics = result["rds_metrics"]
        self.assertEqual(metrics["status"], "partial")
        self.assertTrue(metrics["series"]["iam_requests"]["missing"])
        self.assertEqual(metrics["series"]["iam_requests"]["status_code"], "Complete")
        self.assertEqual(metrics["series"]["iam_success"]["status_code"], "Forbidden")
        self.assertTrue(metrics["series"]["iam_success"]["messages_present"])
        self.assertIsNone(metrics["series"]["iam_failure"]["status_code"])
        self.assertFalse(metrics["series"]["cpu"]["missing"])
        self.assertEqual(metrics["series"]["cpu"]["points"][0]["value"], 0)
        self.assertEqual(metrics["probe_outcome"], "unknown")
        op = ("cloudwatch", "get-metric-data")
        self.documents[op] = self.failed_read(op)
        result, _ = self.invoke()
        self.assertEqual(result["rds_metrics"]["status"], "unavailable")
        self.assertEqual(result["logs"]["events"], 1)
        self.assertTrue(result["configuration"]["user_matches"])

    def test_metric_pagination_status_and_messages_are_projected_without_raw_data(self):
        self.documents[("cloudwatch", "get-metric-data")] = {
            "NextToken": self.private, "Messages": [{"Value": self.private}],
            "MetricDataResults": [
                {"Id": "iam_failure", "StatusCode": "PartialData", "Timestamps": [1440], "Values": [1],
                 "Label": self.private},
                {"Id": "iam_server_error", "StatusCode": "InternalError", "Timestamps": [], "Values": []},
                {"Id": "iam_success", "StatusCode": self.private, "Timestamps": [], "Values": []},
                {"Id": self.private, "StatusCode": "Complete", "Timestamps": [1440], "Values": [1]},
            ]}
        result, _ = self.invoke()
        self.assertIn("rds_metrics", result)
        metrics = result["rds_metrics"]
        self.assertTrue(metrics["truncated"])
        self.assertTrue(metrics["messages_present"])
        self.assertEqual(metrics["unexpected_results"], 1)
        self.assertEqual(metrics["series"]["iam_failure"]["status_code"], "PartialData")
        self.assertEqual(metrics["series"]["iam_failure"]["status"], "partial")
        self.assertEqual(metrics["series"]["iam_server_error"]["status_code"], "InternalError")
        self.assertEqual(metrics["series"]["iam_success"]["status_code"], "Unknown")
        self.assertEqual(sum(argv[1:3] == ["cloudwatch", "get-metric-data"] for argv in self.calls), 1)

    def test_malformed_metric_points_are_not_guessed_or_published(self):
        self.documents[("cloudwatch", "get-metric-data")] = {"MetricDataResults": [
            {"Id": "iam_requests", "StatusCode": "Complete",
             "Timestamps": [1440, 1500, 1560, 1620, 1680, 1740],
             "Values": [1, float("nan"), -1, True, self.private, float("inf")]},
            {"Id": "iam_success", "StatusCode": "Complete", "Timestamps": [1440, 1500], "Values": [1]},
            {"Id": "iam_failure", "StatusCode": "Complete", "Timestamps": [0, 4980, 1440], "Values": [1, 1, 2]},
        ]}
        result, _ = self.invoke()
        self.assertIn("rds_metrics", result)
        series = result["rds_metrics"]["series"]
        self.assertEqual(series["iam_requests"]["points"], [{"timestamp_ms": 1_440_000, "value": 1}])
        self.assertTrue(series["iam_requests"]["invalid_data"])
        self.assertEqual(series["iam_success"]["points"], [])
        self.assertTrue(series["iam_success"]["invalid_data"])
        self.assertEqual(series["iam_failure"]["points"], [{"timestamp_ms": 1_440_000, "value": 2}])
        self.assertEqual(result["rds_metrics"]["status"], "partial")

    def test_metric_point_count_and_duplicate_ids_fail_partial(self):
        points = list(range(1380, 4980, 60))
        self.documents[("cloudwatch", "get-metric-data")] = {"MetricDataResults": [
            {"Id": "iam_requests", "StatusCode": "Complete", "Timestamps": points + points, "Values": [1] * 120},
            {"Id": "iam_requests", "StatusCode": "Complete", "Timestamps": [1440], "Values": [99]},
        ]}
        result, _ = self.invoke()
        self.assertIn("rds_metrics", result)
        item = result["rds_metrics"]["series"]["iam_requests"]
        self.assertLessEqual(len(item["points"]), 60)
        self.assertTrue(item["invalid_data"])
        self.assertEqual(result["rds_metrics"]["status"], "partial")

    def test_serverless_capacity_bounds_are_numeric_or_unknown(self):
        result, _ = self.invoke()
        config = result["configuration"]
        self.assertEqual(config.get("serverless_min_acu"), 0.5)
        self.assertEqual(config.get("serverless_max_acu"), 2)
        scaling = self.documents[("rds", "describe-db-clusters")]["DBClusters"][0]["ServerlessV2ScalingConfiguration"]
        scaling.update(MinCapacity=self.private, MaxCapacity=float("inf"))
        result, _ = self.invoke()
        self.assertIsNone(result["configuration"]["serverless_min_acu"])
        self.assertIsNone(result["configuration"]["serverless_max_acu"])

    def test_server_lifecycle_only_accepts_anchored_messages_with_web_identity(self):
        prefix = "2026-09-13 12:00:00 UTC:client:awsops_web@awsops:[7]:"
        self.documents[("rds", "download-db-log-file-portion")]["LogFileData"] = "\n".join([
            prefix + 'LOG: connection authenticated: identity="awsops_web" method=pam',
            prefix + "LOG: connection authorized: user=awsops_web database=awsops",
            prefix + "FATAL: client disconnected during authentication",
            prefix + "LOG: could not send data to client: Broken pipe",
            prefix + "LOG: could not receive data from client: Connection reset by peer",
        ])
        result, _ = self.invoke()
        server = result["server_logs"]
        self.assertIn("lifecycle_counts", server)
        self.assertEqual(server["lifecycle_counts"], {
            "authenticated": 1, "authorized": 1, "client_disconnected_during_auth": 1,
            "broken_pipe": 1, "connection_reset": 1})
        self.assertEqual(server["matching_lines"], 1)
        self.assertEqual(server["probe_outcome"], "unknown")

    def test_bare_midline_tokens_and_other_users_do_not_match_lifecycle(self):
        prefix = "2026-09-13 12:00:00 UTC:client:awsops_web@awsops:[7]:"
        self.documents[("rds", "download-db-log-file-portion")]["LogFileData"] = "\n".join([
            prefix + "LOG: statement: SELECT 'connection authorized: user=awsops_web'",
            prefix + 'CONTEXT: connection authenticated: identity="awsops_web" method=pam',
            prefix + 'ERROR: syntax error at or near "client disconnected during authentication"',
            prefix + "LOG: statement: SELECT 'could not send data to client: Broken pipe'",
            prefix.replace("awsops_web@", "another_role@") + 'LOG: could not receive data from client: Connection reset by peer',
            prefix + 'LOG: connection authorized: user=another_role database=awsops',
            prefix + 'LOG: connection authenticated: identity="another_role" method=pam',
            "LOG: statement: SELECT 'awsops_web connection authorized'",
            "LOG: connection authorized: user=awsops_web database=awsops",
            'LOG: connection authenticated: identity="awsops_web" method=pam',
            prefix + "LOG: statement: SELECT E'line one\nLOG: connection authorized: user=awsops_web database=awsops'",
        ])
        result, _ = self.invoke()
        self.assertIn("lifecycle_counts", result["server_logs"])
        self.assertEqual(result["server_logs"]["lifecycle_counts"], {})

    def test_complete_empty_metric_reads_are_available_without_outcome_inference(self):
        result, _ = self.invoke()
        metrics = result["rds_metrics"]
        self.assertIs(metrics.get("read_ok"), True)
        self.assertEqual(metrics["status"], "available")
        self.assertEqual(metrics["probe_outcome"], "unknown")
        self.assertTrue(metrics["no_error_inference"])
        for item in metrics["series"].values():
            self.assertEqual(item["status_code"], "Complete")
            self.assertEqual(item["status"], "available")
            self.assertTrue(item["missing"])
            self.assertEqual(item["points"], [])
        op = ("cloudwatch", "get-metric-data")
        self.documents[op] = self.failed_read(op)
        result, _ = self.invoke()
        self.assertFalse(result["rds_metrics"]["read_ok"])
        self.assertEqual(result["rds_metrics"]["status"], "unavailable")

    def test_metric_read_status_does_not_depend_on_datapoint_presence(self):
        rows = self.documents[("cloudwatch", "get-metric-data")]["MetricDataResults"]
        rows[0].update(StatusCode="Forbidden", Timestamps=[1440], Values=[1])
        rows[1].update(StatusCode="InternalError", Timestamps=[1440], Values=[1])
        rows[2].update(StatusCode="PartialData")
        result, _ = self.invoke()
        metrics = result["rds_metrics"]
        self.assertEqual(metrics["series"]["iam_requests"]["status"], "unavailable")
        self.assertEqual(metrics["series"]["iam_success"]["status"], "unavailable")
        self.assertEqual(metrics["series"]["iam_failure"]["status"], "partial")
        self.assertEqual(metrics["series"]["cpu"]["status"], "available")
        self.assertTrue(metrics["series"]["cpu"]["missing"])
        self.assertEqual(metrics["status"], "partial")
        rows[3].update(StatusCode="Complete", Timestamps=[1440, 1500], Values=[1])
        result, _ = self.invoke()
        self.assertEqual(result["rds_metrics"]["series"]["iam_invalid_token"]["status"], "partial")

    def test_forged_full_prefix_and_raise_log_remain_explicitly_unverified(self):
        prefix = "2026-09-13 12:00:00 UTC:client:awsops_web@awsops:[7]:"
        self.documents[("rds", "download-db-log-file-portion")]["LogFileData"] = "\n".join([
            prefix + "LOG: statement: SELECT E'payload",
            prefix + "LOG: connection authorized: user=awsops_web database=awsops",
            # A RAISE LOG can produce the same prefix and message as server code.
            prefix + 'LOG: connection authenticated: identity="awsops_web" method=pam',
        ])
        result, _ = self.invoke()
        server = result["server_logs"]
        self.assertEqual(server["lifecycle_counts"], {"authorized": 1, "authenticated": 1})
        self.assertEqual(server.get("lifecycle_source_integrity"), "unverified_text")
        self.assertIs(server.get("lifecycle_injection_possible"), True)
        self.assertEqual(server["probe_outcome"], "unknown")
        self.assertIn("log_connections_enabled", server)
        self.assertIsNone(server["log_connections_enabled"])
