"""Private inspection must authenticate the exact downloaded plan before rendering."""
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
import ci_tf_assets as assets

SHA = "a" * 40
KEY = "synthetic-private-inspection-key"
RUN = {
    "id": 23, "run_attempt": 1, "path": ".github/workflows/terraform.yml",
    "event": "workflow_dispatch", "status": "completed", "conclusion": "success",
    "head_branch": "dev", "head_sha": SHA,
    "repository": {"full_name": "example/awsops"},
    "head_repository": {"full_name": "example/awsops"},
}


class PlanInspectionTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(Path(__file__).with_name("ci_plan_inspect.py").is_file(),
                        "Private authenticated inspection is not implemented")
        self.module = importlib.import_module("ci_plan_inspect")
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.foundation = self.root / "checkout/terraform/foundation"
        self.foundation.mkdir(parents=True)
        self.output = self.root / "inspection"
        self.download = self.root / "fixtures"
        self.download.mkdir()
        self.plan = self.root / "plan"
        (self.plan / ".build").mkdir(parents=True)
        (self.plan / "tfplan").write_bytes(b"opaque plan with private input")
        (self.plan / ".build/source.py").write_bytes(b"private rendered Lambda")
        patch = mock.patch.dict(os.environ, {
            "TF_PLAN_ENC_KEY": KEY, "GITHUB_ACTIONS": "", "GITHUB_EVENT_NAME": "",
            "TF_LOG": "TRACE", "TF_CLI_ARGS": "-unsafe-fixture",
            "AWS_SECRET_ACCESS_KEY": "synthetic-must-not-reach-renderer",
        })
        patch.start()
        self.addCleanup(patch.stop)
        self.pack()
        self.run = copy.deepcopy(RUN)
        self.checkout_sha = SHA
        self.rendered = []
        self.real_command = self.module.private_command
        self.command_patch = mock.patch.object(self.module, "private_command",
                                               side_effect=self.command)
        self.command_patch.start()
        self.addCleanup(self.command_patch.stop)

    def encrypt(self, source, output):
        subprocess.run([
            "openssl", "enc", "-aes-256-cbc", "-pbkdf2", "-iter", "200000", "-salt",
            "-in", str(source), "-out", str(output), "-pass", "env:TF_PLAN_ENC_KEY",
        ], env={"PATH": os.environ["PATH"], "TF_PLAN_ENC_KEY": KEY},
            check=True, capture_output=True)

    def pack(self, commit=SHA):
        with mock.patch.object(assets, "load_plan", return_value={
                "planned_values": {"root_module": {"resources": []}}}):
            assets.bundle_assets(self.plan, self.plan / "assets.tar.gz", commit, "full")
        self.encrypt(self.plan / "tfplan", self.download / "tfplan.enc")
        self.encrypt(self.plan / "assets.tar.gz", self.download / "tfassets.enc")

    def command(self, args, output, **kwargs):
        if args[:2] == ["gh", "api"]:
            self.assertIn("repos/example/awsops/actions/runs/23", args)
            Path(output).write_text(json.dumps(self.run))
        elif args[:2] == ["gh", "run"]:
            self.assertEqual(args[:9], [
                "gh", "run", "download", "23", "--repo", "example/awsops",
                "--name", "tfplan", "--dir",
            ])
            for source in self.download.iterdir():
                shutil.copyfile(source, Path(args[9]) / source.name)
            Path(output).write_bytes(b"")
        elif args[0] == "git":
            Path(output).write_text(self.checkout_sha)
        elif args[0] == "terraform":
            plan = Path(args[-1])
            self.assertEqual(plan.read_bytes(), b"opaque plan with private input")
            self.assertEqual((plan.parent / ".build/source.py").read_bytes(),
                             b"private rendered Lambda")
            for key in ("TF_PLAN_ENC_KEY", "TF_LOG", "TF_CLI_ARGS", "AWS_SECRET_ACCESS_KEY"):
                self.assertNotIn(key, kwargs["env"])
            self.rendered.append(args)
            Path(output).write_bytes(b"PRIVATE_PLAN_RENDER")
        else:
            return self.real_command(args, output, **kwargs)
        return 0, False

    def inspect(self, **kwargs):
        return self.module.inspect_plan(
            repository="example/awsops", branch="dev", commit=SHA, run_id="23",
            scope="full", foundation=self.foundation, destination=self.output, **kwargs)

    def test_authenticated_pair_renders_only_into_new_private_directory(self):
        self.inspect()
        self.assertEqual(len(self.rendered), 2)
        self.assertEqual({p.name for p in self.output.iterdir()}, {"plan.txt", "plan.json"})
        self.assertEqual(self.output.stat().st_mode & 0o777, 0o700)
        for path in self.output.iterdir():
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(path.read_bytes(), b"PRIVATE_PLAN_RENDER")
        self.assertFalse(list(self.root.glob(".plan-inspection-*")))

    def test_wrong_run_context_or_checkout_never_renders(self):
        for key, value in [
            ("id", 24), ("head_sha", "b" * 40), ("head_branch", "main"),
            ("event", "pull_request"), ("conclusion", "failure"),
            ("path", ".github/workflows/deploy-web.yml"),
            ("head_repository", {"full_name": "foreign/repository"}),
        ]:
            with self.subTest(key=key):
                self.run = {**RUN, key: value}
                with self.assertRaises(self.module.ArtifactError):
                    self.inspect()
                self.assertFalse(self.output.exists())
        self.run = copy.deepcopy(RUN)
        self.checkout_sha = "b" * 40
        with self.assertRaises(self.module.ArtifactError):
            self.inspect()
        self.assertEqual(self.rendered, [])

    def test_signed_wrong_commit_or_changed_plan_is_rejected_before_show(self):
        self.pack("b" * 40)
        with self.assertRaises(self.module.ArtifactError):
            self.inspect()
        self.pack()
        (self.plan / "tfplan").write_bytes(b"different but decryptable plan")
        self.encrypt(self.plan / "tfplan", self.download / "tfplan.enc")
        with self.assertRaises(self.module.ArtifactError):
            self.inspect()
        self.assertEqual(self.rendered, [])
        self.assertFalse(self.output.exists())

    def test_missing_bundle_and_wrong_key_do_not_leave_plaintext(self):
        with mock.patch.dict(os.environ, {"TF_PLAN_ENC_KEY": "wrong-key"}):
            with self.assertRaises(self.module.ArtifactError):
                self.inspect()
        (self.download / "tfassets.enc").unlink()
        with self.assertRaises(self.module.ArtifactError):
            self.inspect()
        self.assertEqual(self.rendered, [])
        self.assertFalse(self.output.exists())
        self.assertFalse(list(self.root.glob(".plan-inspection-*")))

    def test_existing_destination_symlink_and_ci_execution_are_refused(self):
        self.output.mkdir()
        (self.output / "keep").write_text("untouched")
        with self.assertRaises(self.module.ArtifactError):
            self.inspect()
        self.assertEqual((self.output / "keep").read_text(), "untouched")
        shutil.rmtree(self.output)
        self.output.symlink_to(self.foundation, target_is_directory=True)
        with self.assertRaises(self.module.ArtifactError):
            self.inspect()
        self.output.unlink()
        with mock.patch.dict(os.environ, {"GITHUB_ACTIONS": "true"}):
            with self.assertRaises(self.module.ArtifactError):
                self.inspect()
        self.assertEqual(self.rendered, [])

    def test_command_output_limit_is_bounded_and_stderr_is_not_public(self):
        path = self.root / "bounded"
        with self.assertRaises(self.module.ArtifactError):
            self.real_command(
                [sys.executable, "-c", "print('PRIVATE_VALUE' * 10000)"],
                path, limit=100, timeout=5)
        self.assertLessEqual(path.stat().st_size, 100)

    def test_cli_failure_never_echoes_untrusted_arguments_or_error_details(self):
        output, error = io.StringIO(), io.StringIO()
        with mock.patch.object(sys, "argv", ["inspect", "--not-an-option", "PRIVATE_VALUE"]), \
                mock.patch("sys.stdout", output), mock.patch("sys.stderr", error):
            self.assertEqual(self.module.main(), 1)
        self.assertNotIn("PRIVATE_VALUE", output.getvalue() + error.getvalue())


if __name__ == "__main__":
    unittest.main()
