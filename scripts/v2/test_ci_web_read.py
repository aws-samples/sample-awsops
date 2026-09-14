"""Offline AWS CLI transport tests; provider boundaries use real local processes."""
from contextlib import contextmanager
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
from ci_web_image import ImageError
import ci_web_read as subject

AUTH = {"AWS_ACCESS_KEY_ID": "fixture-access", "AWS_SECRET_ACCESS_KEY": "fixture-secret",
        "AWS_SESSION_TOKEN": "fixture-session"}
SENSITIVE = "https://private.invalid/?token=fixture-secret"


class ReadTransportTest(unittest.TestCase):
    def setUp(self):
        self.subject = subject
        self.directory = tempfile.TemporaryDirectory(prefix="web-read-test-")
        self.addCleanup(self.directory.cleanup)
        auth = patch.dict(os.environ, AUTH)
        auth.start()
        self.addCleanup(auth.stop)

    @contextmanager
    def cli(self, programs):
        """Replace only executable selection; run real pipes, signals and timers."""
        original = subprocess.Popen
        calls, children = [], []
        def launch(argv, **kwargs):
            index = len(calls)
            calls.append(argv)
            program = programs[min(index, len(programs) - 1)]
            child = original([sys.executable, "-c", program, *argv], **kwargs)
            children.append(child)
            return child
        with patch.object(self.subject.subprocess, "Popen", side_effect=launch):
            try:
                yield calls, children
            finally:
                for child in children:
                    if child.poll() is None:
                        os.killpg(child.pid, signal.SIGKILL)
                        child.wait(timeout=1)

    def read(self, **kwargs):
        return self.subject.read_request("ecs", "describe-services",
                                         {"cluster": "fixture", "services": ["web"]}, **kwargs)

    def error_program(self, code, operation="DescribeServices", message=SENSITIVE):
        stderr = f"An error occurred ({code}) when calling the {operation} operation: {message}"
        return f"import sys; sys.stderr.write({stderr!r}); sys.exit(254)"

    def assert_fatal(self, function):
        with self.assertRaises(ImageError) as caught:
            function()
        self.assertNotIsInstance(caught.exception, self.subject.TransientReadError)
        self.assertNotIn(SENSITIVE, str(caught.exception))
        return caught.exception

    def test_allowlisted_operations_return_json_and_preserve_pagination_token(self):
        cases = [
            ("ecs", "describe-services", {"cluster": "fixture", "services": ["web"]}),
            ("ecs", "describe-tasks", {"cluster": "fixture", "tasks": ["task-a", "task-b"]}),
            ("ecs", "describe-task-definition", {"task-definition": "web:1"}),
            ("ecs", "list-tasks", {"cluster": "fixture", "service-name": "web",
                                   "next-token": "opaque", "max-results": "100"}),
            ("ecr", "batch-get-image", {"registry-id": "123456789012",
                                       "repository-name": "web", "image-ids": "imageTag=source"}),
            ("ecr", "get-download-url-for-layer", {"registry-id": "123456789012",
                 "repository-name": "web", "layer-digest": "sha256:" + "a" * 64}),
            ("sts", "get-caller-identity", {}),
        ]
        for service, operation, args in cases:
            with self.subTest(operation=operation), self.cli([
                    'print(\'{"items": [], "nextToken": "opaque"}\')']) as (calls, _):
                self.assertEqual(self.subject.read_request(service, operation, args),
                                 {"items": [], "nextToken": "opaque"})
                self.assertEqual(calls[0][:3], ["aws", service, operation])
                self.assertIn("--no-paginate", calls[0])
                self.assertEqual(calls[0][calls[0].index("--output") + 1], "json")
                if "tasks" in args:
                    start = calls[0].index("--tasks")
                    self.assertEqual(calls[0][start + 1:start + 3], ["task-a", "task-b"])

    def test_unknown_operations_and_mutations_are_rejected_before_process_launch(self):
        cases = [("ecs", "update-service"), ("ecs", "run-task"),
                 ("ecs", "register-task-definition"), ("ecr", "put-image"),
                 ("sts", "assume-role"), ("s3api", "get-object"),
                 ("ecs", "wait"), ("ecs", "DescribeServices"),
                 (SENSITIVE, "describe-services")]
        with self.cli(['print("{}")']) as (calls, _):
            for service, operation in cases:
                with self.subTest(operation=operation):
                    self.assert_fatal(lambda: self.subject.read_request(service, operation, {}))
            self.assertEqual(calls, [])

    def test_arguments_cannot_override_auth_endpoints_timeouts_or_expand_files(self):
        bad_args = [
            {"endpoint-url": SENSITIVE}, {"profile": "fixture"},
            {"no-sign-request": ""}, {"debug": ""}, {"cli-read-timeout": "0"},
            {"cli-input-json": "file:///private"}, {"query": "services"},
            {"services": ["web", "--endpoint-url", SENSITIVE]},
            {"services": "--no-sign-request"}, {"services": "file:///private"},
            {"services": SENSITIVE}, {"services": "name@=file:///private"},
            {"services": []}, {"services": 1}, {"services": "web\n--debug"},
        ]
        with self.cli(['print("{}")']) as (calls, _):
            for args in bad_args:
                with self.subTest(args=args):
                    self.assert_fatal(lambda: self.subject.read_request(
                        "ecs", "describe-services", args))
            self.assertEqual(calls, [])

    def test_environment_retains_temporary_credentials_and_drops_overrides(self):
        hostile = {
            "PATH": "/untrusted", "AWS_PROFILE": "fixture",
            "AWS_ENDPOINT_URL": SENSITIVE, "AWS_ENDPOINT_URL_ECS": SENSITIVE,
            "AWS_CA_BUNDLE": "/private", "AWS_DATA_PATH": "/private",
            "AWS_CONFIG_FILE": "/private", "AWS_SHARED_CREDENTIALS_FILE": "/private",
            "AWS_MAX_ATTEMPTS": "100", "AWS_RETRY_MODE": "adaptive",
            "AWS_CONTAINER_CREDENTIALS_FULL_URI": SENSITIVE, "AWS_WEB_IDENTITY_TOKEN_FILE": "/private",
            "HTTP_PROXY": SENSITIVE, "HTTPS_PROXY": SENSITIVE, "http_proxy": SENSITIVE,
            "https_proxy": SENSITIVE, "ALL_PROXY": SENSITIVE, "NO_PROXY": "*",
            "PYTHONPATH": "/private", "LD_PRELOAD": "/private",
            "GH_TOKEN": "fixture-github", "GITHUB_ENV": "/private",
        }
        program = ('import os, sys, json; print(json.dumps('
                   '{"env": dict(os.environ), "stdin": sys.stdin.read(), "argv": sys.argv[1:]}))')
        with patch.dict(os.environ, hostile), self.cli([program]):
            result = self.read()
        env = result["env"]
        for key, value in AUTH.items():
            self.assertEqual(env[key], value)
        self.assertEqual(env["PATH"], "/usr/local/bin:/usr/bin:/bin")
        self.assertEqual(env["AWS_MAX_ATTEMPTS"], "1")
        self.assertEqual(env["AWS_IGNORE_CONFIGURED_ENDPOINT_URLS"], "true")
        self.assertEqual(env["AWS_EC2_METADATA_DISABLED"], "true")
        for key in ("AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE", "BOTO_CONFIG"):
            self.assertEqual(env[key], os.devnull)
        self.assertNotIn("HOME", env)
        for key in hostile.keys() - {"PATH", "AWS_MAX_ATTEMPTS", "AWS_CONFIG_FILE",
                                     "AWS_SHARED_CREDENTIALS_FILE"}:
            self.assertNotIn(key, env)
        self.assertEqual(result["stdin"], "")
        if "TMPDIR" in os.environ:
            self.assertEqual(env["TMPDIR"], os.environ["TMPDIR"])

    def test_missing_credentials_fail_before_process_launch(self):
        with patch.dict(os.environ, {"AWS_SESSION_TOKEN": ""}), \
                self.cli(['print("{}")']) as (calls, _):
            self.assert_fatal(self.read)
            self.assertEqual(calls, [])

    def test_recognized_service_errors_are_transient_without_internal_retries(self):
        codes = ["Throttling", "ThrottlingException", "TooManyRequestsException",
                 "RequestLimitExceeded", "RequestThrottled", "SlowDown",
                 "ServiceUnavailable", "ServiceUnavailableException",
                 "InternalFailure", "InternalError", "ServerException",
                 "RequestTimeout", "RequestTimeoutException", "429", "500", "502", "503", "504"]
        for code in codes:
            with self.subTest(code=code), self.cli([self.error_program(code)]) as (calls, _), \
                    self.assertRaises(self.subject.TransientReadError) as caught:
                self.read()
            self.assertEqual(len(calls), 1)
            self.assertEqual(str(caught.exception), "AWS read temporarily unavailable [ecs:DescribeServices]")
            self.assertIsInstance(caught.exception, ImageError)

    def test_permission_identity_validation_and_unknown_errors_are_fatal(self):
        for code in ("AccessDenied", "AccessDeniedException", "UnrecognizedClientException",
                     "ExpiredToken", "InvalidClientTokenId", "SignatureDoesNotMatch",
                     "ValidationException", "ClientException", "ResourceNotFoundException",
                     "UnrecognizedNewCode"):
            # Retry words in provider-controlled messages must not change the code's meaning.
            with self.subTest(code=code), self.cli([self.error_program(
                    code, message="ThrottlingException Read timeout " + SENSITIVE)]) as (calls, _):
                self.assert_fatal(self.read)
                self.assertEqual(len(calls), 1)

    def test_current_cli_error_prefix_preserves_root_error_classification(self):
        errors = [
            ("aws: [ERROR]: An error occurred (ThrottlingException) when calling the DescribeServices operation: busy", True),
            (f'aws: [ERROR]: Read timeout on endpoint URL: "{SENSITIVE}"', True),
            ("aws: [ERROR]: An error occurred (AccessDeniedException) when calling the DescribeServices operation: ThrottlingException", False),
        ]
        for text, retryable in errors:
            program = f"import sys; sys.stderr.write({text!r}); sys.exit(254)"
            with self.subTest(retryable=retryable), self.cli([program]):
                if retryable:
                    with self.assertRaises(self.subject.TransientReadError):
                        self.read()
                else:
                    self.assert_fatal(self.read)

    def test_network_error_shapes_retry_but_unknown_text_and_wrong_operations_do_not(self):
        retryable = [
            f'Read timeout on endpoint URL: "{SENSITIVE}"',
            f'Connect timeout on endpoint URL: "{SENSITIVE}"',
            f'Could not connect to the endpoint URL: "{SENSITIVE}"',
            f'Connection was closed before we received a valid response from endpoint URL: "{SENSITIVE}".',
            f'Connection reset by peer: "{SENSITIVE}"',
        ]
        fatal = [f"SSL validation failed for {SENSITIVE}",
                 f"Unable to locate credentials {SENSITIVE}",
                 f"some unknown error: Read timeout {SENSITIVE}",
                 self.error_program("Throttling", operation="UpdateService")]
        for error in retryable + fatal:
            program = f"import sys; sys.stderr.write({error!r}); sys.exit(255)"
            if error == fatal[-1]:
                program = error
            with self.subTest(error=error), self.cli([program]):
                if error in retryable:
                    with self.assertRaises(self.subject.TransientReadError):
                        self.read()
                else:
                    self.assert_fatal(self.read)

    def test_deadline_prevents_launch_and_window_is_restored_after_exit(self):
        now = lambda: 10.0
        with self.cli(['print("{}")']) as (calls, _):
            with self.subject.read_window(10.0, now=now):
                with self.assertRaises(self.subject.TransientReadError):
                    self.read()
            self.assertEqual(calls, [])
            self.assertEqual(self.read(), {})
            self.assertEqual(len(calls), 1)

    def test_nested_windows_cannot_extend_outer_budget_and_reset_on_exception(self):
        with self.cli(['print("{}")']) as (calls, _):
            with self.subject.read_window(10.0, now=lambda: 10.0):
                with self.subject.read_window(100.0, now=lambda: 0.0):
                    with self.assertRaises(self.subject.TransientReadError):
                        self.read()
            try:
                with self.subject.read_window(0.0, now=lambda: 10.0):
                    raise RuntimeError("fixture")
            except RuntimeError:
                pass
            self.assertEqual(self.read(), {})
            self.assertEqual(len(calls), 1)

    def test_poll_owns_retry_and_all_nested_reads_consume_same_absolute_deadline(self):
        current = [100.0]
        with self.cli([self.error_program("ThrottlingException"), 'print("{}")']) as (calls, _):
            with self.subject.read_window(101.0, now=lambda: current[0]):
                with self.assertRaises(self.subject.TransientReadError):
                    self.read()
                current[0] = 100.5
                self.assertEqual(self.read(), {})
                current[0] = 101.0
                with self.assertRaises(self.subject.TransientReadError):
                    self.read()
            self.assertEqual(len(calls), 2)

    def test_invalid_window_bounds_fail_closed(self):
        for deadline in (float("inf"), float("nan"), "100", None, True):
            with self.subTest(deadline=deadline), self.cli(['print("{}")']) as (calls, _):
                def invalid():
                    with self.subject.read_window(deadline):
                        self.read()
                self.assert_fatal(invalid)
                self.assertEqual(calls, [])

    def test_contexts_do_not_leak_deadlines_into_other_contexts(self):
        from contextvars import Context
        with self.cli(['print("{}")']) as (calls, _):
            with self.subject.read_window(0.0, now=lambda: 1.0):
                self.assertEqual(Context().run(self.read), {})
                with self.assertRaises(self.subject.TransientReadError):
                    self.read()
            self.assertEqual(len(calls), 1)

    def test_deadline_is_recomputed_after_environment_setup(self):
        current = [1.0]
        original = self.subject.child_environment
        def slow_setup(*args):
            current[0] = 2.0
            return original(*args)
        with self.subject.read_window(2.0, now=lambda: current[0]), \
                patch.object(self.subject, "child_environment", side_effect=slow_setup), \
                self.cli(['print("{}")']) as (calls, _):
            with self.assertRaises(self.subject.TransientReadError):
                self.read()
            self.assertEqual(calls, [])

    def test_timeout_kills_stubborn_process_and_its_descendant_inside_budget(self):
        pid_file = Path(self.directory.name) / "descendant"
        program = (
            "import os, signal, subprocess, sys, time\n"
            "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
            "child = subprocess.Popen([sys.executable, '-c', "
            "'import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(30)'])\n"
            f"open({str(pid_file)!r}, 'w').write(str(child.pid))\n"
            "time.sleep(30)\n")
        start = time.monotonic()
        with self.cli([program]) as (calls, children):
            with self.subject.read_window(start + 0.7):
                with self.assertRaises(self.subject.TransientReadError):
                    self.read()
            self.assertLess(time.monotonic() - start, 0.85)
            self.assertIsNotNone(children[0].returncode)
            self.assertEqual(len(calls), 1)
        self.assertTrue(pid_file.exists(), "Fixture must spawn a descendant before timeout")
        self.assert_not_running(int(pid_file.read_text()))

    def assert_not_running(self, pid):
        # An orphan killed with its group can briefly be a zombie pending init's reap.
        stat = Path(f"/proc/{pid}/stat")
        if stat.exists():
            self.assertEqual(stat.read_text().split(") ", 1)[1][0], "Z")

    def test_default_window_also_bounds_a_stuck_cli(self):
        with patch.object(self.subject, "MAX_REQUEST_SECONDS", 0.3), \
                self.cli(["import time; time.sleep(30)"]) as (_, children):
            start = time.monotonic()
            with self.assertRaises(self.subject.TransientReadError):
                self.read()
            self.assertLess(time.monotonic() - start, 0.45)
            self.assertIsNotNone(children[0].returncode)

    def test_closed_pipes_do_not_allow_process_wait_to_escape_deadline(self):
        program = "import os,time; os.close(1); os.close(2); time.sleep(30)"
        with self.cli([program]) as (_, children):
            start = time.monotonic()
            with self.subject.read_window(start + 0.3):
                with self.assertRaises(self.subject.TransientReadError):
                    self.read()
            self.assertLess(time.monotonic() - start, 0.45)
            self.assertIsNotNone(children[0].returncode)

    def test_stdout_and_stderr_are_drained_concurrently(self):
        program = (
            "import os\n"
            "os.write(1, b'{\"large\": \"')\n"
            "for i in range(8):\n"
            "    os.write(1, b'x' * 16384)\n"
            "    os.write(2, b'y' * 4096)\n"
            "os.write(1, b'\"}')\n")
        with self.cli([program]):
            self.assertEqual(len(self.read()["large"]), 131072)

    def test_oversized_stdout_or_stderr_is_fatal_and_process_is_reaped(self):
        for fd in (1, 2):
            program = f"import os\nwhile True: os.write({fd}, b'x' * 8192)"
            with self.subTest(fd=fd), self.cli([program]) as (_, children):
                start = time.monotonic()
                self.assert_fatal(self.read)
                self.assertLess(time.monotonic() - start, 2)
                self.assertIsNotNone(children[0].returncode)

    def test_invalid_json_and_process_launch_permission_failure_are_fatal_and_safe(self):
        for body in (SENSITIVE, "[]", "null", '{"bad":'):
            with self.subTest(body=body), self.cli([f"print({body!r})"]):
                self.assert_fatal(self.read)
        with patch.object(self.subject.subprocess, "Popen",
                          side_effect=PermissionError(SENSITIVE)) as launch:
            self.assert_fatal(self.read)
            self.assertEqual(launch.call_count, 1)

    def test_failures_do_not_print_raw_provider_data_or_exception_chains(self):
        import traceback
        with self.cli([self.error_program("AccessDenied")]), \
                patch("sys.stdout", new_callable=io.StringIO) as stdout, \
                patch("sys.stderr", new_callable=io.StringIO) as stderr:
            error = self.assert_fatal(self.read)
            rendered = "".join(traceback.format_exception(type(error), error, error.__traceback__))
        self.assertEqual(stdout.getvalue(), "")
        self.assertEqual(stderr.getvalue(), "")
        self.assertNotIn(SENSITIVE, rendered)
        self.assertNotIn(AUTH["AWS_SECRET_ACCESS_KEY"], rendered)


if __name__ == "__main__":
    unittest.main()
