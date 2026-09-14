"""Regression cases from the native review: no cloud commands are executed."""
import errno
import fnmatch
import hashlib
import hmac
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import unittest
from unittest import mock

import test_ci_failure_diagnostics as fixtures
from test_ci_plan_inspect import KEY, SHA


class FailureReviewTests(unittest.TestCase):
    def setUp(self):
        fixture = fixtures.FailureDiagnosticsTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        self.fixture = fixture
        self.module, self.root, self.env = fixture.module, fixture.root, fixture.env

    def program(self, body):
        (self.root / "bin/terraform").write_text(f"#!{sys.executable}\n" + body)

    def cli(self, *, phase="plan", **env):
        output, error = io.StringIO(), io.StringIO()
        args = ["terraform", "plan", "-out=tfplan"] if phase == "plan" else [
            "terraform", "apply", "-input=false", "tfplan"]
        with mock.patch.dict(os.environ, {
                **self.env, "GITHUB_JOB": phase, "GITHUB_OUTPUT": str(self.root / "outputs"),
                "GITHUB_STEP_SUMMARY": str(self.root / "summary"), **env}), \
                mock.patch.object(sys, "argv", ["diagnostics", "capture", "--phase", phase, "--", *args]), \
                mock.patch("sys.stdout", output), mock.patch("sys.stderr", error):
            code = self.module.main()
        text = output.getvalue()
        self.assertIn('"capture_status"', text, "Public status must describe capture without raw output")
        return code, json.loads(text), text + error.getvalue()

    def test_retention_path_has_no_hidden_generated_directory(self):
        code, file = self.fixture.capture()
        self.assertEqual(code, 17)
        self.assertFalse(Path(file).parent.name.startswith("."))
        self.assertEqual({p.name for p in Path(file).parent.iterdir()}, {"diagnostics.enc"})

    def test_tail_retains_the_actual_error_after_more_than_the_limit(self):
        self.program("import sys\nsys.stdout.write('H' * 1200000)\nsys.stdout.flush()\n"
                     "sys.stderr.write('TERMINAL_PRIVATE_ERROR')\nsys.exit(17)\n")
        code, file = self.fixture.capture()
        self.assertEqual(code, 17)
        metadata = self.fixture.recover(file)
        raw = (self.root / "recovered/diagnostics.log").read_bytes()
        self.assertTrue(raw.endswith(b"TERMINAL_PRIVATE_ERROR"))
        self.assertEqual(len(raw), 1024 * 1024)
        self.assertEqual(metadata["total_output_bytes"], 1200022)
        self.assertEqual(metadata["capture_status"], "truncated")

    def test_scratch_write_failure_cannot_kill_apply_or_replace_its_exit(self):
        import ci_plan_inspect
        marker = self.root / "command-finished"
        self.program("import pathlib,sys,time\nprint('progress',flush=True)\ntime.sleep(.1)\n"
                     f"pathlib.Path({str(marker)!r}).write_text('finished')\nsys.exit(17)\n")
        real = os.fdopen

        class FullDisk:
            def __init__(self, stream):
                self.stream = stream
            def __enter__(self):
                return self
            def __exit__(self, *args):
                self.stream.close()
            def __getattr__(self, name):
                return getattr(self.stream, name)
            def write(self, value):
                raise OSError(errno.ENOSPC, "PRIVATE_DISK_DETAIL")

        def fdopen(fd, mode, *args, **kwargs):
            stream = real(fd, mode, *args, **kwargs)
            return FullDisk(stream) if mode == "wb" else stream

        with mock.patch.object(ci_plan_inspect.os, "fdopen", side_effect=fdopen):
            code, _ = self.module.capture(["terraform", "apply", "-input=false", "tfplan"],
                                         "apply", env={**self.env, "GITHUB_JOB": "apply"})
        self.assertTrue(marker.exists(), "Capture storage must not interrupt the child")
        self.assertEqual(code, 17)

    def test_child_cannot_write_github_channels_and_keeps_sts_credentials(self):
        names = ["GITHUB_OUTPUT", "GITHUB_ENV", "GITHUB_PATH", "GITHUB_STATE", "GITHUB_STEP_SUMMARY"]
        command_files = {name: self.root / name for name in names}
        for path in command_files.values():
            path.write_text("ORIGINAL\n")
        self.program("import os,sys\n"
                     f"names={names!r}\n"
                     "for name in names:\n"
                     " if name in os.environ:\n"
                     "  with open(os.environ[name],'a') as f: f.write('diagnostics_file=/private/leak\\n')\n"
                     "assert not any(name in os.environ for name in names)\n"
                     "assert not any(name.endswith('_ENC_KEY') for name in os.environ)\n"
                     "assert 'ACTIONS_RUNTIME_TOKEN' not in os.environ\n"
                     "assert 'ACTIONS_ID_TOKEN_REQUEST_TOKEN' not in os.environ\n"
                     "assert not any(name.startswith(('TF_LOG','TF_CLI_ARGS')) for name in os.environ)\n"
                     "assert os.environ['AWS_SESSION_TOKEN']=='KEEP_STS'\nsys.exit(17)\n")
        code, _ = self.fixture.capture(**{k: str(v) for k, v in command_files.items()},
            AWS_SESSION_TOKEN="KEEP_STS", EXTRA_ENC_KEY="PRIVATE",
            TF_LOG="TRACE", TF_LOG_PATH=str(self.root / "bypass.log"),
            TF_LOG_PROVIDER="TRACE", TF_CLI_ARGS="-unsafe", TF_CLI_ARGS_apply="-unsafe",
            ACTIONS_RUNTIME_TOKEN="PRIVATE", ACTIONS_ID_TOKEN_REQUEST_TOKEN="PRIVATE")
        self.assertEqual(code, 17)
        for path in command_files.values():
            self.assertEqual(path.read_text(), "ORIGINAL\n")

    def test_success_has_numeric_audit_and_never_exposes_output_values(self):
        self.program("print('Apply complete! Resources: 3 added, 2 changed, 1 destroyed.')\n"
                     "print('output = PRIVATE_VALUE')\n")
        code, status, public = self.cli(phase="apply")
        self.assertEqual(code, 0)
        self.assertEqual(status["action_counts"], {"add": 3, "change": 2, "destroy": 1})
        self.assertEqual(status["retention_status"], "not_needed")
        self.assertNotIn("PRIVATE", public + (self.root / "summary").read_text())

    def test_no_change_summary_is_observed_zero_not_an_unavailable_count(self):
        self.program("print('No changes. Your infrastructure matches the configuration.')\n")
        code, status, _ = self.cli()
        self.assertEqual(code, 0)
        self.assertEqual(status["action_counts"], {"add": 0, "change": 0, "destroy": 0})

    def test_advisory_failure_has_fixed_classification_but_no_raw_retention(self):
        self.program("import sys\nprint('Error: AccessDeniedException PRIVATE_ACCOUNT_DETAIL')\nsys.exit(9)\n")
        code, status, public = self.cli(GITHUB_EVENT_NAME="push")
        self.assertEqual(code, 9)
        self.assertEqual(status["failure_category"], "access_denied")
        self.assertEqual(status["retention_status"], "policy_not_retained")
        self.assertNotIn("PRIVATE", public + (self.root / "summary").read_text())
        self.assertEqual((self.root / "outputs").read_text().strip(), "diagnostics_file=")

    def test_sealing_and_storage_failures_have_distinct_status_without_losing_exit(self):
        with mock.patch.object(self.module, "crypt", side_effect=self.module.ArtifactError("command_failed")):
            code, status, public = self.cli()
        self.assertEqual(code, 17)
        self.assertEqual(status["retention_status"], "seal_failed")
        self.assertNotIn("PRIVATE", public)
        with mock.patch.object(self.module.tempfile, "mkdtemp", side_effect=OSError(errno.ENOSPC, "PRIVATE")):
            code, status, public = self.cli()
        self.assertEqual(code, 17)
        self.assertEqual(status["retention_status"], "storage_failed")

    def test_failure_manifest_has_its_own_domain_and_capture_metadata(self):
        code, file = self.fixture.capture()
        self.assertEqual(code, 17)
        with mock.patch.dict(os.environ, {"TF_PLAN_ENC_KEY": KEY}):
            self.module.crypt(file, self.root / "plain", decrypt=True)
        payload = json.loads((self.root / "plain").read_bytes())
        manifest = payload["manifest"]
        canonical = json.dumps(manifest, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
        expected = hmac.new(KEY.encode(), b"awsops:terraform-failure:manifest:v2\0" + canonical,
                            hashlib.sha256).hexdigest()
        self.assertEqual(payload["hmac_sha256"], expected)
        self.assertEqual(manifest["schema_version"], 2)
        self.assertIn("total_output_bytes", manifest)
        self.assertIn("capture_status", manifest)

    def test_recovery_timeout_is_fixed_and_never_prints_command_details(self):
        output, error = io.StringIO(), io.StringIO()
        with mock.patch.object(self.module, "fetch_run", side_effect=subprocess.TimeoutExpired(
                ["gh", "api", "PRIVATE_TOKEN"], 1)) as fetch, \
                mock.patch.dict(os.environ, {"GITHUB_ACTIONS": "false"}), \
                mock.patch.object(sys, "argv", ["diagnostics", "recover",
                    "--repository", "example/awsops", "--branch", "dev", "--commit", SHA,
                    "--run-id", "23", "--attempt", "1", "--phase", "plan",
                    "--file", str(self.root / "input"), "--destination", str(self.root / "result")]), \
                mock.patch("sys.stdout", output), mock.patch("sys.stderr", error):
            self.assertEqual(self.module.main(), 1)
        fetch.assert_called_once()
        self.assertNotIn("PRIVATE", output.getvalue() + error.getvalue())
        self.assertNotIn("Traceback", error.getvalue())

    def test_changed_or_forged_cipher_path_is_never_published(self):
        audit = {}
        _, file = self.module.capture(["terraform", "plan"], "plan", env=self.env, audit=audit)
        Path(file).write_text("PRIVATE_PLAINTEXT_REPLACEMENT")
        output = self.root / "outputs"
        public = io.StringIO()
        with mock.patch("sys.stdout", public):
            self.module.publish_audit(audit, file, {**self.env, "GITHUB_OUTPUT": str(output)})
        self.assertEqual(output.read_text().strip(), "diagnostics_file=")
        self.assertEqual(json.loads(public.getvalue())["retention_status"], "publication_failed")
        self.assertNotIn("PRIVATE", public.getvalue())

    def test_workflow_uploads_one_file_only_for_dispatch_failure_or_cancellation(self):
        import yaml
        from test_ci_deployment_workflows import expression
        path = Path(__file__).resolve().parents[2] / ".github/workflows/terraform.yml"
        workflow = yaml.safe_load(path.read_text())
        for phase in ("plan", "apply"):
            upload = next(s for s in workflow["jobs"][phase]["steps"]
                          if s.get("name") == f"Upload encrypted {phase} failure diagnostics")
            for event, failed, cancelled, pointer, expected in [
                ("workflow_dispatch", True, False, "/owned/diagnostics.enc", True),
                ("workflow_dispatch", False, True, "/owned/diagnostics.enc", True),
                ("workflow_dispatch", False, False, "/owned/diagnostics.enc", False),
                ("workflow_dispatch", True, False, "", False),
                ("pull_request", True, False, "/private/raw", False),
                ("push", True, False, "/private/raw", False),
            ]:
                condition = upload["if"].replace("failure()", str(failed)).replace("cancelled()", str(cancelled))
                context = {"github": {"event_name": event},
                           "steps": {f"private_{phase}": {"outputs": {"diagnostics_file": pointer}}}}
                self.assertEqual(bool(expression("${{ " + condition + " }}", context)), expected)
            self.assertEqual(upload["with"]["name"], f"terraform-failure-{phase}-${{{{ github.run_attempt }}}}")
            self.assertEqual(upload["with"]["path"], f"${{{{ steps.private_{phase}.outputs.diagnostics_file }}}}")
            self.assertEqual(upload["with"]["include-hidden-files"], True)
            self.assertEqual(upload["with"]["retention-days"], 5)

    def test_critical_capture_helpers_trigger_both_plan_self_test_events(self):
        import yaml
        path = Path(__file__).resolve().parents[2] / ".github/workflows/terraform.yml"
        workflow = yaml.safe_load(path.read_text())
        triggers = workflow.get("on", workflow.get(True))
        for event in ("pull_request", "push"):
            for helper in ("scripts/v2/ci_plan_inspect.py", "scripts/v2/ci_failure_diagnostics.py"):
                self.assertTrue(any(fnmatch.fnmatchcase(helper, pattern)
                                    for pattern in triggers[event]["paths"]), (event, helper))

    def test_pre_apply_policy_commands_also_lose_github_channels_but_keep_sts(self):
        from test_ci_deployment_workflows import DeploymentWorkflowTests, step
        fixture = DeploymentWorkflowTests()
        script = step("terraform.yml", "apply", "terraform apply (exact saved plan — never re-planned)")
        result, commands = fixture.run_step(script, ASSERT_NO_GITHUB_CHANNELS="true",
            AWS_SESSION_TOKEN="KEEP_STS", TF_PLAN_ENC_KEY=KEY,
            TF_LOG="TRACE", TF_LOG_PATH=str(self.root / "bypass.log"),
            TF_CLI_ARGS="-unsafe", TF_CLI_ARGS_show="-unsafe")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(["terraform", "apply", "-input=false", "tfplan"], commands)

    def test_public_audit_write_failure_does_not_replace_the_command_exit(self):
        error = io.StringIO()
        with mock.patch.dict(os.environ, {**self.env, "GITHUB_OUTPUT": str(self.root / "outputs")}), \
                mock.patch.object(sys, "argv", ["diagnostics", "capture", "--phase", "plan",
                                               "--", "terraform", "plan"]), \
                mock.patch("sys.stdout.write", side_effect=OSError("PRIVATE_WRITE_FAILURE")), \
                mock.patch("sys.stderr", error):
            self.assertEqual(self.module.main(), 17)
        self.assertNotIn("PRIVATE", error.getvalue())

    def test_sealing_passes_bytes_to_openssl_without_a_plaintext_file(self):
        crypt = self.module.crypt
        observed = []

        def inspect(source, destination, **kwargs):
            observed.append(source)
            self.assertEqual(list(Path(destination).parent.iterdir()), [],
                             "Sealing must never stage a plaintext capsule on disk")
            self.assertIsInstance(source, bytes)
            self.assertLessEqual(len(source), self.module.CAPSULE_LIMIT)
            return crypt(source, destination, **kwargs)

        with mock.patch.object(self.module, "crypt", side_effect=inspect):
            code, file = self.fixture.capture()
        self.assertEqual(code, 17)
        self.assertEqual(len(observed), 1)
        self.assertEqual({p.name for p in Path(file).parent.iterdir()}, {"diagnostics.enc"})
        self.fixture.recover(file)
        self.assertIn(b"PRIVATE_FAILURE_MARKER", (self.root / "recovered/diagnostics.log").read_bytes())

    def test_stdin_seal_timeout_preserves_exit_without_plaintext_or_raw_errors(self):
        import ci_plan_inspect

        def timeout(args, **kwargs):
            self.assertEqual(args[:2], ["openssl", "enc"])
            self.assertNotIn("-in", args)
            self.assertIsInstance(kwargs["input"], bytes)
            self.assertLessEqual(len(kwargs["input"]), self.module.CAPSULE_LIMIT)
            self.assertEqual(kwargs["timeout"], 120)
            self.assertEqual(kwargs["stdout"], subprocess.DEVNULL)
            self.assertEqual(kwargs["stderr"], subprocess.DEVNULL)
            self.assertFalse(any(k.startswith(("AWS_", "TF_LOG", "TF_CLI_ARGS", "GITHUB_"))
                                 for k in kwargs["env"]))
            target = Path(args[args.index("-out") + 1])
            self.assertEqual({p.name for p in target.parent.iterdir()}, {"diagnostics.enc"})
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            raise subprocess.TimeoutExpired(args, 120, output=b"PRIVATE_CRYPTO_ERROR")

        with mock.patch.object(ci_plan_inspect.subprocess, "run", side_effect=timeout) as command:
            code, audit, public = self.cli(AWS_SESSION_TOKEN="KEEP_STS", TF_LOG="TRACE")
        command.assert_called_once()
        self.assertEqual(code, 17)
        self.assertEqual(audit["retention_status"], "seal_failed")
        self.assertEqual(audit["cleanup_status"], "complete")
        self.assertNotIn("PRIVATE", public)
        self.assertFalse(list(self.root.glob("tf-diagnostics-*")))

    def test_sealed_audit_waits_for_upload_and_missing_outcome_cannot_delete(self):
        code, audit, _ = self.cli()
        self.assertEqual(code, 17)
        self.assertEqual(audit["cleanup_status"], "pending_upload")
        pointer = dict(line.split("=", 1) for line in (self.root / "outputs").read_text().splitlines())
        file = Path(pointer["diagnostics_file"])
        before = file.read_bytes()
        status = self.module.cleanup(file, self.env)
        self.assertEqual(status, {"upload_status": "unavailable", "cleanup_status": "retained_unpublished"})
        self.assertEqual(file.read_bytes(), before)

    def test_workflow_cleanup_retains_ciphertext_until_upload_is_confirmed(self):
        import yaml
        from test_ci_deployment_workflows import expression
        repository = Path(__file__).resolve().parents[2]
        workflow = yaml.safe_load((repository / ".github/workflows/terraform.yml").read_text())
        working = self.root / "terraform/foundation"
        working.mkdir(parents=True)
        scripts = self.root / "scripts/v2"
        scripts.mkdir(parents=True)
        for name in ("ci_failure_diagnostics.py", "ci_plan_inspect.py", "ci_tf_assets.py", "ci_plan_context.py"):
            (scripts / name).write_bytes((repository / "scripts/v2" / name).read_bytes())
        for phase in ("plan", "apply"):
            steps = workflow["jobs"][phase]["steps"]
            upload = next(s for s in steps if s.get("name") == f"Upload encrypted {phase} failure diagnostics")
            clean = next(s for s in steps if s.get("name") == f"Clean owned {phase} diagnostics")
            self.assertTrue(upload.get("id"), "Cleanup must reference the real upload outcome")
            for outcome in ("failure", "cancelled", "skipped", "", "success"):
                with self.subTest(phase=phase, outcome=outcome):
                    env = {**self.env, "GITHUB_JOB": phase}
                    argv = ["terraform", "plan"] if phase == "plan" else [
                        "terraform", "apply", "-input=false", "tfplan"]
                    _, file = self.module.capture(argv, phase, env=env)
                    before = Path(file).read_bytes()
                    context = {"steps": {
                        f"private_{phase}": {"outputs": {"diagnostics_file": file}},
                        upload["id"]: {"outcome": outcome}}}
                    condition = clean["if"].replace("always()", "True")
                    self.assertTrue(expression("${{ " + condition + " }}", context),
                                    "Even skipped/cancelled uploads need a fixed retention audit")
                    env.update({k: str(expression(v, context)) for k, v in clean["env"].items()})
                    result = subprocess.run(["bash", "-euo", "pipefail", "-c", clean["run"]],
                        cwd=working, env=env, capture_output=True, text=True, timeout=5)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    status = json.loads(result.stdout)
                    self.assertNotIn(str(self.root), result.stdout + result.stderr)
                    if outcome == "success":
                        self.assertEqual(status["cleanup_status"], "complete")
                        self.assertFalse(Path(file).parent.exists())
                    else:
                        self.assertEqual(status["cleanup_status"], "retained_unpublished")
                        self.assertEqual(Path(file).read_bytes(), before)

    def test_group_cancellation_delivers_only_one_interrupt_to_apply(self):
        started, stopped = self.root / "group-started", self.root / "group-stopped"
        self.program(
            "import pathlib,signal,sys,time\ncount=0\nend=time.monotonic()+4\n"
            "def stop(number,frame):\n"
            " global count,end\n count+=1\n"
            f" pathlib.Path({str(stopped)!r}).write_text(str(count))\n"
            " if count>1: sys.exit(99)\n"
            " end=time.monotonic()+.3\n"
            "signal.signal(signal.SIGTERM,stop)\nsignal.signal(signal.SIGINT,stop)\n"
            f"pathlib.Path({str(started)!r}).write_text('ready')\n"
            "while time.monotonic()<end: time.sleep(.01)\nsys.exit(1)\n")
        process = subprocess.Popen([sys.executable, self.module.__file__, "capture", "--phase", "apply",
            "--", "terraform", "apply", "-input=false", "tfplan"], start_new_session=True,
            env={**self.env, "GITHUB_JOB": "apply", "GITHUB_OUTPUT": str(self.root / "outputs")},
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            deadline = time.monotonic() + 3
            while not started.exists() and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertTrue(started.exists())
            os.killpg(process.pid, signal.SIGINT)
            while not stopped.exists() and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertTrue(stopped.exists())
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
            stdout, stderr = process.communicate(timeout=5)
            self.assertEqual(process.returncode, 1, "A second interrupt must not force an immediate exit")
            self.assertEqual(stopped.read_text(), "1")
            self.assertEqual(json.loads(stdout)["exit_code"], 1)
            self.assertNotIn("Traceback", stderr)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()

    def test_graceful_cancellation_preserves_exit_and_produces_only_ciphertext(self):
        started = self.root / "started"
        self.program(
            "import pathlib,signal,sys,time\n"
            "def stop(number,frame):\n print('PRIVATE_CANCELLED',flush=True)\n sys.exit(143)\n"
            "signal.signal(signal.SIGTERM,stop)\n"
            f"pathlib.Path({str(started)!r}).write_text('started')\ntime.sleep(10)\n")
        script = Path(self.module.__file__)
        process = subprocess.Popen([sys.executable, str(script), "capture", "--phase", "apply",
            "--", "terraform", "apply", "-input=false", "tfplan"], env={
                **self.env, "GITHUB_JOB": "apply", "GITHUB_OUTPUT": str(self.root / "outputs"),
            }, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            deadline = time.monotonic() + 3
            while not started.exists() and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertTrue(started.exists())
            process.send_signal(signal.SIGTERM)
            stdout, stderr = process.communicate(timeout=5)
            self.assertEqual(process.returncode, 143)
            self.assertEqual(json.loads(stdout)["failure_category"], "interrupted")
            self.assertNotIn("PRIVATE", stdout + stderr)
            pointer = dict(line.split("=", 1) for line in (self.root / "outputs").read_text().splitlines())
            self.assertTrue(Path(pointer["diagnostics_file"]).is_file())
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()


if __name__ == "__main__":
    unittest.main()
