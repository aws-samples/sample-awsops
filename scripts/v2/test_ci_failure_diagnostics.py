"""Failure capture preserves exit status without publishing private command output."""
import copy
import importlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))
from test_ci_plan_inspect import RUN, SHA, KEY


class FailureDiagnosticsTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(Path(__file__).with_name("ci_failure_diagnostics.py").is_file(),
                        "Bounded private failure retention is not implemented")
        self.module = importlib.import_module("ci_failure_diagnostics")
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        (self.root / "bin").mkdir()
        executable = self.root / "bin/terraform"
        executable.write_text(
            f"#!{sys.executable}\n"
            "import os,sys\n"
            "assert 'TF_PLAN_ENC_KEY' not in os.environ\n"
            "sys.stdout.write('PRIVATE_FAILURE_MARKER' * int(os.environ.get('TEST_SIZE','1')))\n"
            "sys.stderr.write('PRIVATE_STDERR_MARKER')\n"
            "sys.exit(int(os.environ.get('TEST_EXIT','17')))\n")
        executable.chmod(0o700)
        self.env = {
            **os.environ, "PATH": str(self.root / "bin") + os.pathsep + os.environ["PATH"],
            "RUNNER_TEMP": str(self.root), "TF_PLAN_ENC_KEY": KEY,
            "GITHUB_REPOSITORY": "example/awsops", "GITHUB_REF_NAME": "dev",
            "GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_SHA": SHA,
            "GITHUB_RUN_ID": "23", "GITHUB_RUN_ATTEMPT": "1", "GITHUB_JOB": "plan",
            "GITHUB_OUTPUT": str(self.root / "outputs"),
            "GITHUB_STEP_SUMMARY": str(self.root / "summary"),
        }
        self.failed_run = {**copy.deepcopy(RUN), "conclusion": "failure"}

    def capture(self, **env):
        return self.module.capture(
            ["terraform", "plan", "-out=tfplan", "-input=false", "-lock=false"],
            "plan", env={**self.env, **env})

    def recover(self, file, **expected):
        with mock.patch.object(self.module, "fetch_run", return_value=self.failed_run), \
                mock.patch.dict(os.environ, {"TF_PLAN_ENC_KEY": KEY, "GITHUB_ACTIONS": "false"}):
            return self.module.recover(
                file, self.root / "recovered", repository="example/awsops", branch="dev",
                commit=expected.get("commit", SHA), run_id="23", attempt="1", phase="plan")

    def test_failed_command_retains_only_ciphertext_and_private_authenticated_recovery(self):
        code, file = self.capture()
        self.assertEqual(code, 17)
        self.assertIsNotNone(file)
        file = Path(file)
        self.assertNotIn(b"PRIVATE_FAILURE_MARKER", file.read_bytes())
        self.assertEqual([p.name for p in file.parent.iterdir()], ["diagnostics.enc"])
        self.assertEqual(file.parent.stat().st_mode & 0o777, 0o700)
        self.assertEqual(file.stat().st_mode & 0o777, 0o600)
        self.recover(file)
        output = self.root / "recovered"
        self.assertEqual(output.stat().st_mode & 0o777, 0o700)
        self.assertIn(b"PRIVATE_FAILURE_MARKER", (output / "diagnostics.log").read_bytes())
        self.assertIn(b"PRIVATE_STDERR_MARKER", (output / "diagnostics.log").read_bytes())
        self.assertEqual((output / "diagnostics.log").stat().st_mode & 0o777, 0o600)

    def test_success_missing_key_and_advisory_context_leave_no_private_log(self):
        self.assertEqual(self.capture(TEST_EXIT="0"), (0, None))
        for values in [{"TF_PLAN_ENC_KEY": ""}, {"GITHUB_EVENT_NAME": "pull_request"}]:
            self.assertEqual(self.capture(**values), (17, None))
        self.assertFalse(list(self.root.glob("tf-diagnostics-*")))

    def test_output_is_truncated_without_interrupting_the_original_command(self):
        code, file = self.capture(TEST_SIZE="100000")
        self.assertEqual(code, 17)
        result = self.recover(file)
        self.assertTrue(result["truncated"])
        self.assertEqual((self.root / "recovered/diagnostics.log").stat().st_size,
                         1024 * 1024)

    def test_wrong_key_tamper_and_foreign_context_cannot_publish_recovered_output(self):
        _, file = self.capture()
        original = Path(file).read_bytes()
        for mode in ("tamper", "key", "commit", "run"):
            with self.subTest(mode=mode):
                Path(file).write_bytes(original)
                self.failed_run = {**copy.deepcopy(RUN), "conclusion": "failure"}
                if mode == "tamper":
                    value = bytearray(original)
                    value[len(value) // 2] ^= 1
                    Path(file).write_bytes(value)
                if mode == "run":
                    self.failed_run["head_branch"] = "main"
                with mock.patch.object(self.module, "fetch_run", return_value=self.failed_run), \
                        mock.patch.object(self.module, "crypt", wraps=self.module.crypt) as decrypt, \
                        mock.patch.dict(os.environ, {
                            "TF_PLAN_ENC_KEY": "wrong-key" if mode == "key" else KEY,
                            "GITHUB_ACTIONS": "false"}):
                    with self.assertRaises(self.module.ArtifactError) as rejected:
                        self.module.recover(file, self.root / "recovered",
                            repository="example/awsops", branch="dev",
                            commit="b" * 40 if mode == "commit" else SHA,
                            run_id="23", attempt="1", phase="plan")
                    self.assertNotEqual(str(rejected.exception), "local_recovery_only")
                    if mode in ("tamper", "key"):
                        decrypt.assert_called_once()
                self.assertFalse((self.root / "recovered").exists())

    def test_failed_attempt_remains_recoverable_after_a_later_successful_rerun(self):
        import ci_plan_inspect
        _, file = self.capture()
        command = ci_plan_inspect.private_command

        def api(args, output, **kwargs):
            if args[:2] == ["gh", "api"]:
                selected = self.failed_run if args[-1].endswith("/attempts/1") else {
                    **RUN, "run_attempt": 2, "conclusion": "success"}
                Path(output).write_text(json.dumps(selected))
                return 0, False
            return command(args, output, **kwargs)

        with mock.patch.object(ci_plan_inspect, "private_command", side_effect=api), \
                mock.patch.dict(os.environ, {"TF_PLAN_ENC_KEY": KEY, "GITHUB_ACTIONS": "false"}):
            result = self.module.recover(file, self.root / "recovered",
                repository="example/awsops", branch="dev", commit=SHA,
                run_id="23", attempt="1", phase="plan")
        self.assertEqual(result["context"]["attempt"], "1")
        self.assertIn(b"PRIVATE_FAILURE_MARKER",
                      (self.root / "recovered/diagnostics.log").read_bytes())

    def test_actions_recovery_is_refused_before_authentication_or_decryption(self):
        with mock.patch.dict(os.environ, {"GITHUB_ACTIONS": "true"}), \
                mock.patch.object(self.module, "fetch_run") as fetch, \
                mock.patch.object(self.module, "crypt") as decrypt:
            with self.assertRaisesRegex(self.module.ArtifactError, "^local_recovery_only$"):
                self.module.recover(self.root / "unused", self.root / "recovered",
                    repository="example/awsops", branch="dev", commit=SHA,
                    run_id="23", attempt="1", phase="plan")
        fetch.assert_not_called()
        decrypt.assert_not_called()
        self.assertFalse((self.root / "recovered").exists())

    def test_local_recovery_rejects_valid_ciphertext_with_a_forged_hmac(self):
        _, file = self.capture()
        with mock.patch.dict(os.environ, {"TF_PLAN_ENC_KEY": KEY, "GITHUB_ACTIONS": "false"}):
            plain = self.root / "local-fixture.json"
            self.module.crypt(file, plain, decrypt=True)
            payload = json.loads(plain.read_bytes())
            payload["hmac_sha256"] = "0" * 64
            plain.write_text(json.dumps(payload))
            forged = self.root / "forged.enc"
            self.module.crypt(plain, forged)
            with mock.patch.object(self.module, "fetch_run", return_value=self.failed_run):
                with self.assertRaisesRegex(self.module.ArtifactError, "^capsule_authentication_failed$"):
                    self.module.recover(forged, self.root / "recovered",
                        repository="example/awsops", branch="dev", commit=SHA,
                        run_id="23", attempt="1", phase="plan")
        self.assertFalse((self.root / "recovered").exists())

    def test_seal_failure_preserves_original_exit_and_removes_plaintext(self):
        with mock.patch.object(self.module, "crypt", side_effect=OSError("PRIVATE_ERROR")):
            self.assertEqual(self.capture(), (17, None))
        self.assertFalse(list(self.root.glob("tf-diagnostics-*")))

    def test_unretained_failures_do_not_depend_on_runner_storage(self):
        with mock.patch.object(self.module.tempfile, "mkdtemp", side_effect=OSError("PRIVATE_PATH")):
            self.assertEqual(self.capture(TF_PLAN_ENC_KEY=""), (17, None))
        self.assertFalse(list(self.root.glob("tf-diagnostics-*")))

    def test_success_creates_no_plaintext_scratch_that_could_fail_cleanup(self):
        with mock.patch.object(self.module.tempfile, "mkdtemp", side_effect=OSError("PRIVATE_PATH")), \
                mock.patch.object(self.module.shutil, "rmtree", side_effect=OSError("PRIVATE_PATH")):
            self.assertEqual(self.capture(TEST_EXIT="0"), (0, None))
        self.assertFalse(list(self.root.glob("tf-diagnostics-*")))

    def test_failed_seal_and_failed_cleanup_still_preserve_the_command_exit(self):
        audit = {}
        with mock.patch.object(self.module, "crypt", side_effect=self.module.ArtifactError("command_failed")), \
                mock.patch.object(self.module.shutil, "rmtree", side_effect=OSError("PRIVATE_PATH")):
            self.assertEqual(self.module.capture(["terraform", "plan"], "plan",
                                                env=self.env, audit=audit), (17, None))
        self.assertEqual(audit["retention_status"], "seal_failed")
        self.assertEqual(audit["cleanup_status"], "failed")
        self.assertNotIn("PRIVATE", json.dumps(audit))

    def test_cleanup_accepts_only_this_run_owned_encrypted_directory(self):
        _, file = self.capture()
        self.module.cleanup(file, self.env, upload_outcome="success")
        self.assertFalse(Path(file).parent.exists())
        unrelated = self.root / "unrelated"
        unrelated.mkdir()
        (unrelated / "diagnostics.enc").write_bytes(b"keep")
        with self.assertRaises(self.module.ArtifactError):
            self.module.cleanup(unrelated / "diagnostics.enc", self.env, upload_outcome="success")
        self.assertEqual((unrelated / "diagnostics.enc").read_bytes(), b"keep")

    def test_apply_capture_cannot_change_the_saved_plan_command(self):
        with self.assertRaises(self.module.ArtifactError):
            self.module.capture(["terraform", "apply", "-auto-approve"], "apply", env=self.env)
        with self.assertRaises(self.module.ArtifactError):
            self.module.capture(["sh", "-c", "echo private"], "plan", env=self.env)
        self.assertFalse(list(self.root.glob("tf-diagnostics-*")))

    def test_output_publication_failure_does_not_replace_command_failure(self):
        output, error = io.StringIO(), io.StringIO()
        with mock.patch.dict(os.environ, {**self.env, "GITHUB_OUTPUT": str(self.root)}), \
                mock.patch.object(sys, "argv", ["diagnostics", "capture", "--phase", "plan",
                                               "--", "terraform", "plan"]), \
                mock.patch("sys.stdout", output), mock.patch("sys.stderr", error):
            self.assertEqual(self.module.main(), 17)
        self.assertNotIn("PRIVATE_", output.getvalue() + error.getvalue())
        retained = list(self.root.glob("tf-diagnostics-*/diagnostics.enc"))
        self.assertEqual(len(retained), 1)
        self.assertEqual(json.loads(output.getvalue())["retention_status"], "publication_failed")
        self.assertEqual({p.name for p in retained[0].parent.iterdir()}, {"diagnostics.enc"})
    def test_actual_plan_step_retains_failed_output_without_exposing_it(self):
        import yaml
        repository = Path(__file__).resolve().parents[2]
        workflow = yaml.safe_load((repository / ".github/workflows/terraform.yml").read_text())
        step = next(s for s in workflow["jobs"]["plan"]["steps"] if s.get("name") == "terraform plan")
        working = self.root / "terraform/foundation"
        working.mkdir(parents=True)
        scripts = self.root / "scripts/v2"
        scripts.mkdir(parents=True)
        for name in ("ci_failure_diagnostics.py", "ci_plan_inspect.py",
                     "ci_tf_assets.py", "ci_plan_context.py"):
            shutil.copyfile(repository / "scripts/v2" / name, scripts / name)
        (working / "ci-deployment.tfvars.json").write_text("{}")
        outputs = self.root / "outputs"
        result = subprocess.run(["bash", "-c", step["run"]], cwd=working, env={
            **self.env, "TARGET": "dev", "DISPATCH": "true", "PLAN_SCOPE": "full",
            "GITHUB_OUTPUT": str(outputs), "TF_VAR_ci_migrations_enabled": "false",
        }, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 17)
        self.assertNotIn("PRIVATE_", result.stdout + result.stderr)
        file = dict(line.split("=", 1) for line in outputs.read_text().splitlines())["diagnostics_file"]
        self.assertEqual(Path(file).suffix, ".enc")
        self.assertNotIn(b"PRIVATE_FAILURE_MARKER", Path(file).read_bytes())


if __name__ == "__main__":
    unittest.main()
