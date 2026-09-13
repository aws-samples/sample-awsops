"""Saved plans and their local Lambda files must remain inseparable."""
import importlib.util
import base64
import hashlib
import hmac
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest import mock


COMMIT = "a" * 40
KEY = "synthetic-asset-authentication-key"
DOMAIN = b"awsops:terraform-assets:manifest:v2\0"


class TerraformAssetTests(unittest.TestCase):
    def setUp(self):
        script = Path(__file__).with_name("ci_tf_assets.py")
        self.assertTrue(script.is_file(), "Saved-plan asset transport is not implemented")
        spec = importlib.util.spec_from_file_location("ci_tf_assets", script)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        env = mock.patch.dict(os.environ, {"TF_PLAN_ENC_KEY": KEY})
        env.start()
        self.addCleanup(env.stop)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.plan = self.root / "plan"
        self.apply = self.root / "apply"
        for directory in (self.plan, self.apply):
            directory.mkdir()
            (directory / "tfplan").write_bytes(b"reviewed opaque terraform plan")
        build = self.plan / ".build"
        (build / "layer/python").mkdir(parents=True)
        (build / "function.zip").write_bytes(b"exact Lambda archive")
        (build / "layer/python/module.py").write_text("VALUE = 1\n")
        self.archive = self.root / "assets.tar.gz"
        self.plan_json = {"format_version": "1.2", "planned_values": {"root_module": {"resources": [
            {"values": {"filename": ".build/function.zip",
                        "source_code_hash": base64.b64encode(hashlib.sha256(b"exact Lambda archive").digest()).decode()}}
        ]}}}
        self.real_load_plan = self.module.load_plan
        plan_reader = mock.patch.object(self.module, "load_plan", return_value=self.plan_json, create=True)
        plan_reader.start()
        self.addCleanup(plan_reader.stop)

    def pack(self):
        return self.module.bundle_assets(self.plan, self.archive, COMMIT, "full")

    def rewrite(self, transform):
        contents = []
        with tarfile.open(self.archive, "r:gz") as archive:
            for member in archive.getmembers():
                contents.append((member, archive.extractfile(member).read()))
        with tarfile.open(self.archive, "w:gz") as archive:
            for member, data in contents:
                member, data = transform(member, data)
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))

    def prepare_fixture_layer(self):
        def install(args, **kwargs):
            target = Path(args[args.index("--target") + 1])
            for name in self.module.LAYER_IMPORTS:
                path = target / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("# synthetic installed module\n")
        with mock.patch.object(self.module.subprocess, "run", side_effect=install):
            self.module.prepare_layers(self.plan, {"steampipe_enabled": True, "workers_enabled": False}, "full")

    def test_restores_exact_plan_time_files_in_a_clean_apply_directory(self):
        (self.plan / ".build/function.zip").chmod(0o600)
        (self.plan / ".build/layer/python/module.py").chmod(0o755)
        self.pack()
        result = self.module.restore_assets(self.apply, self.archive, COMMIT, "full")
        self.assertEqual(result["files"], 2)
        self.assertEqual((self.apply / ".build/function.zip").read_bytes(), b"exact Lambda archive")
        self.assertEqual((self.apply / ".build/layer/python/module.py").read_text(), "VALUE = 1\n")
        self.assertEqual((self.apply / ".build/function.zip").stat().st_mode & 0o777, 0o600)
        self.assertEqual((self.apply / ".build/layer/python/module.py").stat().st_mode & 0o777, 0o755)
        self.assertEqual((self.apply / ".build/function.zip").stat().st_mtime, self.module.EPOCH)

    def test_zip_must_match_hash_inside_the_plan_before_pack(self):
        (self.plan / ".build/function.zip").write_bytes(b"changed after plan")
        with self.assertRaises(ValueError):
            self.pack()
        self.assertFalse(self.archive.exists())
        (self.plan / ".build/function.zip").write_bytes(b"exact Lambda archive")
        self.plan_json["planned_values"]["root_module"]["resources"] = []
        with self.assertRaises(ValueError):
            self.pack()

    def test_missing_known_planned_zip_fails_before_replacing_a_bundle(self):
        self.pack()
        previous = self.archive.read_bytes()
        (self.plan / ".build/function.zip").unlink()
        with self.assertRaises(ValueError):
            self.pack()
        self.assertEqual(self.archive.read_bytes(), previous)

    def test_plan_without_known_zip_hashes_can_pack_non_zip_inputs(self):
        (self.plan / ".build/function.zip").unlink()
        self.plan_json["planned_values"]["root_module"]["resources"] = [
            {"values": {"filename": ".build/deferred.zip"}}
        ]
        self.assertEqual(self.pack()["files"], 1)

    def test_real_targeted_plan_excludes_existing_lambda_and_packs_without_its_zip(self):
        # Local state/schema only. No refresh/apply; fake credentials, disabled account
        # discovery and loopback endpoints prevent accidental AWS service access.
        self.assertIsNotNone(shutil.which("terraform"), "Terraform is required for saved-plan fixtures")
        root = self.apply
        (root / ".build").mkdir()
        (root / ".build/input.txt").write_text("prepared input")
        encoded = base64.b64encode(hashlib.sha256(b"old archive").digest()).decode()
        (root / "main.tf").write_text('''
terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}
provider "aws" {
  region = "ap-northeast-2"
  access_key = "offline-fixture"
  secret_key = "offline-fixture"
  skip_credentials_validation = true
  skip_requesting_account_id = true
  skip_metadata_api_check = true
  skip_region_validation = true
  endpoints {
    lambda = "http://127.0.0.1:9"
    sts = "http://127.0.0.1:9"
  }
}
resource "terraform_data" "repository" { input = "repository fixture" }
resource "aws_lambda_function" "existing" {
  function_name = "offline-fixture"
  role = "arn:aws:iam::123456789012:role/offline-fixture"
  runtime = "python3.12"
  handler = "index.handler"
  filename = "./.build/function.zip"
  source_code_hash = "''' + encoded + '''"
}
''')
        attributes = {
            "id": "offline-fixture", "function_name": "offline-fixture",
            "role": "arn:aws:iam::123456789012:role/offline-fixture",
            "runtime": "python3.12", "handler": "index.handler",
            "filename": "./.build/function.zip", "source_code_hash": encoded,
        }
        (root / "terraform.tfstate").write_text(json.dumps({
            "version": 4, "terraform_version": "1.15.7", "serial": 1,
            "lineage": "11111111-1111-4111-8111-111111111111", "outputs": {},
            "resources": [{
                "mode": "managed", "type": "aws_lambda_function", "name": "existing",
                "provider": 'provider["registry.terraform.io/hashicorp/aws"]',
                "instances": [{"schema_version": 0, "attributes": attributes, "sensitive_attributes": []}],
            }],
        }))
        repository = Path(__file__).resolve().parents[2]
        lock = (repository / "terraform/foundation/.terraform.lock.hcl").read_text()
        (root / ".terraform.lock.hcl").write_text(
            re.search(r'provider "registry.terraform.io/hashicorp/aws" \{.*?\n\}', lock, re.S).group() + "\n")
        env = {
            "PATH": os.environ["PATH"], "CHECKPOINT_DISABLE": "1", "TF_IN_AUTOMATION": "true",
            "AWS_EC2_METADATA_DISABLED": "true", "AWS_CONFIG_FILE": os.devnull,
            "AWS_SHARED_CREDENTIALS_FILE": os.devnull, "TF_PLAN_ENC_KEY": KEY,
            "TF_CLI_CONFIG_FILE": os.environ.get("TF_CLI_CONFIG_FILE", os.devnull),
        }
        init = ["init", "-backend=false", "-input=false", "-lockfile=readonly"]
        cache = Path(os.environ.get("TF_PLUGIN_CACHE_DIR") or Path.home() / ".terraform.d/plugin-cache")
        platform = json.loads(subprocess.check_output(["terraform", "version", "-json"], env=env))["platform"]
        version = re.search(r'version\s*=\s*"([^"]+)"', (root / ".terraform.lock.hcl").read_text())[1]
        if (cache / f"registry.terraform.io/hashicorp/aws/{version}/{platform}").is_dir():
            init.append(f"-plugin-dir={cache}")
        for args in (init, ["plan", "-input=false", "-refresh=false",
                            "-target=terraform_data.repository", "-out=tfplan"]):
            result = subprocess.run(["terraform", *args], cwd=root, env=env,
                                    capture_output=True, text=True, timeout=180)
            self.assertEqual(result.returncode, 0, result.stderr)
        with mock.patch.dict(os.environ, env, clear=True), \
                mock.patch.object(self.module, "load_plan", side_effect=self.real_load_plan):
            projection = self.module.load_plan(root)
            prior = projection["prior_state"]["values"]["root_module"]["resources"]
            planned = projection["planned_values"]["root_module"]["resources"]
            self.assertIn("aws_lambda_function.existing", [r["address"] for r in prior])
            self.assertNotIn("aws_lambda_function.existing", [r["address"] for r in planned])
            self.assertFalse((root / ".build/function.zip").exists())
            self.assertEqual(self.module.bundle_assets(root, self.archive, COMMIT, "ecr-bootstrap")["files"], 1)

    def test_prepare_removes_stale_zips_before_a_deferred_archive_plan(self):
        stale = self.plan / ".build/nested/stale.zip"
        stale.parent.mkdir()
        stale.write_bytes(b"old deferred archive")
        self.module.prepare_layers(self.plan, {"steampipe_enabled": False, "workers_enabled": False}, "full")
        self.assertFalse(list((self.plan / ".build").rglob("*.zip")))
        self.assertTrue((self.plan / ".build/layer/python/module.py").is_file())
        self.plan_json["planned_values"]["root_module"]["resources"] = [
            {"values": {"filename": ".build/function.zip"}}
        ]
        self.pack()

    def test_prepare_rejects_a_zip_symlink_without_touching_its_target(self):
        (self.plan / ".build/bad.zip").symlink_to(self.plan / "tfplan")
        with self.assertRaises(ValueError):
            self.module.prepare_layers(self.plan, {"steampipe_enabled": False, "workers_enabled": False}, "full")
        self.assertEqual((self.plan / "tfplan").read_bytes(), b"reviewed opaque terraform plan")

    def test_failed_prepare_invalidates_previous_marker_before_install(self):
        marker = self.apply / ".build/.ci-prepared.json"
        marker.parent.mkdir()
        marker.write_text('{"schema_version":1}')
        with mock.patch.object(self.module.subprocess, "run", side_effect=subprocess.TimeoutExpired("pip", 180)):
            with self.assertRaisesRegex(ValueError, "pip_timeout"):
                self.module.prepare_layers(self.apply, {"steampipe_enabled": True, "workers_enabled": False}, "full")
        self.assertFalse(marker.exists())

    def test_pg8000_alone_cannot_certify_the_layer_closure(self):
        layer = self.apply / ".build/inv_layer/python/pg8000"
        layer.mkdir(parents=True)
        (layer / "__init__.py").write_text("# incomplete installation")
        (self.apply / ".build/.ci-prepared.json").write_text(json.dumps({
            "schema_version": 1, "layers": ["inv_layer"], "lock_sha256": self.module.digest(self.module.LOCK),
        }))
        with self.assertRaises(ValueError):
            self.module.validate_layer(self.apply, "inv_layer")

    def test_embedded_secret_assets_are_private_scratch_never_public_output(self):
        (self.plan / ".build/cognito_edge.py").write_text("SYNTHETIC_STATE_SIGNING_KEY")
        self.pack()
        self.assertEqual(self.archive.stat().st_mode & 0o777, 0o600)
        self.assertNotIn("SYNTHETIC_STATE_SIGNING_KEY", json.dumps(self.pack()))

    def test_wrong_plan_commit_or_scope_never_extracts(self):
        self.pack()
        for commit, scope, plan in (("b" * 40, "full", b"reviewed opaque terraform plan"),
                                    (COMMIT, "ecr-bootstrap", b"reviewed opaque terraform plan"),
                                    (COMMIT, "full", b"different saved plan")):
            (self.apply / "tfplan").write_bytes(plan)
            with self.assertRaises(ValueError):
                self.module.restore_assets(self.apply, self.archive, commit, scope)
            self.assertFalse((self.apply / ".build").exists())

    def test_tampered_file_is_rejected_before_replacing_existing_assets(self):
        self.pack()
        (self.apply / ".build").mkdir()
        (self.apply / ".build/keep").write_text("untouched")
        self.rewrite(lambda member, data: (member, b"tampered" if member.name.endswith(".zip") else data))
        with self.assertRaises(ValueError):
            self.module.restore_assets(self.apply, self.archive, COMMIT, "full")
        self.assertEqual((self.apply / ".build/keep").read_text(), "untouched")

    def test_path_traversal_and_unexpected_members_are_rejected(self):
        for bad_name in ("../escape", "/absolute", ".build/../../escape", "terraform.tfvars"):
            self.pack()
            def change(member, data):
                if member.name.endswith(".zip"):
                    member.name = bad_name
                return member, data
            self.rewrite(change)
            with self.assertRaises(ValueError):
                self.module.restore_assets(self.apply, self.archive, COMMIT, "full")
            self.assertFalse((self.root / "escape").exists())

    def test_symlinks_are_not_packaged_or_followed(self):
        (self.plan / ".build/link").symlink_to(self.plan / "tfplan")
        with self.assertRaises(ValueError):
            self.pack()
        (self.plan / ".build/link").unlink()
        self.pack()
        (self.apply / ".build").symlink_to(self.plan / ".build", target_is_directory=True)
        with self.assertRaises(ValueError):
            self.module.restore_assets(self.apply, self.archive, COMMIT, "full")
        self.assertEqual((self.plan / ".build/function.zip").read_bytes(), b"exact Lambda archive")

    def test_duplicate_members_and_corrupt_manifest_fail_closed(self):
        self.pack()
        self.rewrite(lambda member, data: (
            member, b"{}" if member.name == "assets-manifest.json" else data))
        with self.assertRaises(ValueError):
            self.module.restore_assets(self.apply, self.archive, COMMIT, "full")
        self.pack()
        with tarfile.open(self.archive, "r:gz") as source:
            entries = [(member, source.extractfile(member).read()) for member in source.getmembers()]
        with tarfile.open(self.archive, "w:gz") as target:
            for member, data in entries + [entries[-1]]:
                target.addfile(member, io.BytesIO(data))
        with self.assertRaises(ValueError):
            self.module.restore_assets(self.apply, self.archive, COMMIT, "full")

    def test_sensitive_root_files_never_enter_the_asset_bundle(self):
        (self.plan / "terraform.tfvars").write_text("PRIVATE_SENTINEL")
        (self.plan / "backend.hcl").write_text("PRIVATE_SENTINEL")
        self.pack()
        with tarfile.open(self.archive, "r:gz") as archive:
            names = archive.getnames()
            data = b"".join(archive.extractfile(member).read() for member in archive.getmembers())
        self.assertEqual(set(names), {"assets-manifest.json", ".build/function.zip", ".build/layer/python/module.py"})
        self.assertNotIn(b"PRIVATE_SENTINEL", data)
        self.assertNotIn(KEY.encode(), data)

    def test_manifest_authenticates_all_fields_with_a_separate_domain(self):
        self.pack()
        with tarfile.open(self.archive, "r:gz") as archive:
            manifest = json.load(archive.extractfile("assets-manifest.json"))
        signature = manifest.pop("hmac_sha256")
        canonical = json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()
        expected = hmac.new(KEY.encode(), DOMAIN + canonical, hashlib.sha256).hexdigest()
        self.assertEqual(signature, expected)
        self.assertNotEqual(signature, hmac.new(KEY.encode(), canonical, hashlib.sha256).hexdigest())

    def test_key_required_for_pack_and_restore_before_mutation(self):
        self.pack()
        original = self.archive.read_bytes()
        for key in ("", "   ", None):
            with self.subTest(key_present=key is not None), mock.patch.dict(os.environ):
                os.environ.pop("TF_PLAN_ENC_KEY", None)
                if key is not None:
                    os.environ["TF_PLAN_ENC_KEY"] = key
                with self.assertRaises(ValueError):
                    self.pack()
                with self.assertRaises(ValueError):
                    self.module.restore_assets(self.apply, self.archive, COMMIT, "full")
                self.assertEqual(self.archive.read_bytes(), original)
                self.assertEqual(list(self.apply.iterdir()), [self.apply / "tfplan"])

    def test_rehashed_replacement_unsigned_manifest_and_wrong_key_are_rejected(self):
        (self.apply / ".build").mkdir()
        keep = self.apply / ".build/keep"
        keep.write_text("last verified assets")
        for attack in ("rehash", "unsigned", "wrong-key"):
            self.pack()
            def change(member, data):
                if attack == "rehash" and member.name == ".build/function.zip":
                    data = b"attacker replacement"
                if member.name == "assets-manifest.json":
                    manifest = json.loads(data)
                    if attack == "rehash":
                        manifest["files"][".build/function.zip"]["sha256"] = hashlib.sha256(
                            b"attacker replacement").hexdigest()
                    if attack == "unsigned":
                        manifest.pop("hmac_sha256", None)
                    data = json.dumps(manifest).encode()
                return member, data
            self.rewrite(change)
            with self.subTest(attack=attack), mock.patch.dict(os.environ, {
                    "TF_PLAN_ENC_KEY": "different-key" if attack == "wrong-key" else KEY}):
                with self.assertRaises(ValueError):
                    self.module.restore_assets(self.apply, self.archive, COMMIT, "full")
                self.assertEqual(keep.read_text(), "last verified assets")
                self.assertFalse(list(self.apply.glob(".ci-assets-*")))

    def test_non_directory_destination_is_rejected_before_any_mutation(self):
        self.pack()
        destination = self.apply / ".build"
        for kind in ("file", "fifo"):
            with self.subTest(kind=kind):
                if kind == "file":
                    destination.write_text("keep")
                else:
                    os.mkfifo(destination)
                before = destination.lstat()
                with self.assertRaises(ValueError):
                    self.module.restore_assets(self.apply, self.archive, COMMIT, "full")
                self.assertEqual(destination.lstat().st_ino, before.st_ino)
                self.assertEqual(destination.lstat().st_mode, before.st_mode)
                self.assertFalse(list(self.apply.glob(".ci-assets-*")))
                destination.unlink()

    def test_handled_interrupt_after_backup_rename_rolls_back(self):
        self.pack()
        destination = self.apply / ".build"
        destination.mkdir()
        (destination / "keep").write_text("previous")
        rename = Path.rename
        def interrupt(path, target):
            result = rename(path, target)
            if path == destination:
                raise KeyboardInterrupt()
            return result
        with mock.patch.object(Path, "rename", interrupt), self.assertRaises(KeyboardInterrupt):
            self.module.restore_assets(self.apply, self.archive, COMMIT, "full")
        self.assertEqual((destination / "keep").read_text(), "previous")
        self.assertFalse(list(self.apply.glob(".ci-assets-*")))

    def test_failed_rollback_retains_private_backup_and_does_not_wedge_retry(self):
        self.pack()
        destination = self.apply / ".build"
        destination.mkdir()
        (destination / "keep").write_text("previous")
        rename = Path.rename
        def fail_install_and_rollback(path, target):
            if Path(target) == destination:
                raise OSError("simulated unavailable destination")
            return rename(path, target)
        with mock.patch.object(Path, "rename", fail_install_and_rollback), self.assertRaises(OSError):
            self.module.restore_assets(self.apply, self.archive, COMMIT, "full")
        backups = list(self.apply.glob(".ci-assets-*/previous-build/keep"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_text(), "previous")
        self.assertEqual(backups[0].parents[1].stat().st_mode & 0o777, 0o700)
        self.module.restore_assets(self.apply, self.archive, COMMIT, "full")
        self.assertTrue((destination / "function.zip").is_file())

    def test_actual_process_death_in_either_swap_window_allows_verified_retry(self):
        self.pack()
        script = """
import importlib.util, os, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location("assets", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
root = Path(sys.argv[2])
rename = Path.rename
count = 0
def interrupted(path, target):
    global count
    result = rename(path, target)
    count += 1
    if count == int(sys.argv[5]):
        os._exit(73)
    return result
Path.rename = interrupted
module.restore_assets(root, Path(sys.argv[3]), sys.argv[4], "full")
"""
        for step in (1, 2):
            with self.subTest(step=step):
                root = self.root / ("interruption-" + str(step))
                (root / ".build").mkdir(parents=True)
                (root / ".build/keep").write_text("previous")
                (root / "tfplan").write_bytes((self.plan / "tfplan").read_bytes())
                result = subprocess.run([
                    sys.executable, "-c", script, self.module.__file__, str(root),
                    str(self.archive), COMMIT, str(step),
                ], capture_output=True, timeout=10)
                self.assertEqual(result.returncode, 73, result.stderr.decode())
                self.assertFalse((root / ".ci-assets-previous").exists())
                backups = list(root.glob(".ci-assets-*/previous-build/keep"))
                self.assertEqual(len(backups), 1)
                self.assertEqual(backups[0].read_text(), "previous")
                self.assertEqual(backups[0].parents[1].stat().st_mode & 0o777, 0o700)
                self.module.restore_assets(root, self.archive, COMMIT, "full")
                self.assertEqual((root / ".build/function.zip").read_bytes(), b"exact Lambda archive")

    def test_legacy_backup_does_not_block_restore_and_is_not_deleted(self):
        self.pack()
        legacy = self.apply / ".ci-assets-previous"
        legacy.mkdir()
        (legacy / "keep").write_text("previous interrupted run")
        self.module.restore_assets(self.apply, self.archive, COMMIT, "full")
        self.assertTrue((self.apply / ".build/function.zip").is_file())
        self.assertEqual((legacy / "keep").read_text(), "previous interrupted run")

    def test_prepared_layer_marker_must_match_the_locked_dependency_closure(self):
        self.assertTrue(hasattr(self.module, "validate_layer"), "Prepared layer validation is missing")
        layer = self.plan / ".build/inv_layer/python/pg8000"
        layer.mkdir(parents=True)
        (layer / "__init__.py").write_text("# fixture")
        marker = self.plan / ".build/.ci-prepared.json"
        marker.write_text(json.dumps({"schema_version": 1, "layers": ["inv_layer"], "lock_sha256": "wrong"}))
        with self.assertRaises(ValueError):
            self.module.validate_layer(self.plan, "inv_layer")
        self.prepare_fixture_layer()
        self.module.validate_layer(self.plan, "inv_layer")
        with self.assertRaises(ValueError):
            self.module.validate_layer(self.plan, "pg8000_layer")
        (self.plan / ".build/inv_layer/python/scramp/core.py").write_text("# changed after preparation")
        with self.assertRaises(ValueError):
            self.module.validate_layer(self.plan, "inv_layer")

    def test_marker_rejects_malformed_types_and_duplicate_layers(self):
        self.prepare_fixture_layer()
        marker = self.plan / ".build/.ci-prepared.json"
        valid = json.loads(marker.read_text())
        for value in ([], None, "marker", 1, {**valid, "schema_version": True},
                      {**valid, "layers": "prefix-inv_layer-suffix"},
                      {**valid, "layers": ["inv_layer", "inv_layer"]},
                      {**valid, "layers": ["inv_layer", 1]},
                      {**valid, "layers": ["inv_layer", "unknown"]},
                      {**valid, "lock_sha256": 123}):
            with self.subTest(marker=value), self.assertRaises(ValueError):
                marker.write_text(json.dumps(value))
                self.module.validate_layer(self.plan, "inv_layer")

    def test_all_five_shared_layer_pg8000_pin_locations_must_agree(self):
        paths = (
            "scripts/v2/ci/pg8000-requirements.txt",
            "scripts/v2/workers/requirements.txt",
            "scripts/v2/steampipe/requirements.txt",
            "scripts/v2/incident/requirements.txt",
            "scripts/v2/remediation/requirements.txt",
        )
        repository = self.root / "repository"
        for path in paths:
            target = repository / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("pg8000==1.31.2\n")
        self.module.validate_dependency_pins(repository)
        for path in paths:
            target = repository / path
            original = target.read_text()
            for value in (original.replace("1.31.2", "1.32.0"), "", original + original):
                with self.subTest(path=path, value=value):
                    target.write_text(value)
                    with self.assertRaises(ValueError):
                        self.module.validate_dependency_pins(repository)
            target.write_text(original)
        self.module.validate_dependency_pins()

    def test_terraform_uses_the_same_builder_and_never_overwrites_verified_assets(self):
        root = Path(__file__).resolve().parents[2]
        for name, layer in (("workers.tf", "pg8000_layer"), ("steampipe.tf", "inv_layer")):
            source = (root / "terraform/foundation" / name).read_text()
            self.assertIn(f"ci_tf_assets.py build-layer --layer {layer}", source)
            self.assertIn(f"ci_tf_assets.py check-layer --layer {layer}", source)
            self.assertIn('filemd5("${path.module}/../../scripts/v2/ci/pg8000-requirements.txt")', source)
            self.assertNotIn("pip install pg8000", source)

    def test_prepare_and_check_layer_fail_before_mutation_on_pin_drift(self):
        with mock.patch.object(self.module, "validate_dependency_pins", side_effect=ValueError("pin drift")):
            with self.assertRaises(ValueError):
                self.module.prepare_layers(self.apply, {
                    "steampipe_enabled": True, "workers_enabled": True}, "full")
            self.assertFalse((self.apply / ".build").exists())
            with self.assertRaisesRegex(ValueError, "pin drift"):
                self.module.validate_layer(self.plan, "inv_layer")

    def test_pip_failure_category_never_exposes_captured_credentials(self):
        for error, category in (
            (subprocess.CalledProcessError(1, ["pip"], stderr=b"SECRET https://user:password@example.test"),
             "pip_install_failed"),
            (subprocess.TimeoutExpired(["pip"], 180, stderr=b"SECRET"),
             "pip_timeout"),
        ):
            with self.subTest(category=category), mock.patch.object(self.module.subprocess, "run", side_effect=error):
                with self.assertRaisesRegex(ValueError, "^" + category + "$") as caught:
                    self.module.prepare_layers(self.apply, {
                        "steampipe_enabled": True, "workers_enabled": False}, "full")
                self.assertNotIn("SECRET", str(caught.exception))

    def test_cli_reports_only_safe_pip_category_and_rejects_invalid_environment_scope(self):
        root = self.root / "terraform/foundation"
        root.mkdir(parents=True)
        stderr, stdout = io.StringIO(), io.StringIO()
        failure = subprocess.CalledProcessError(
            1, ["pip", "SECRET_ARGUMENT"], output=b"SECRET_OUTPUT", stderr=b"SECRET_ERROR")
        with mock.patch.object(Path, "cwd", return_value=root), \
                mock.patch.object(sys, "argv", ["ci_tf_assets.py", "prepare", "--scope", "full"]), \
                mock.patch.object(sys, "stdin", io.StringIO(
                    '{"steampipe_enabled":true,"workers_enabled":false}')), \
                mock.patch.object(sys, "stderr", stderr), mock.patch.object(sys, "stdout", stdout), \
                mock.patch.object(self.module.subprocess, "run", side_effect=failure):
            self.assertEqual(self.module.main(), 1)
        self.assertIn("pip_install_failed", stderr.getvalue())
        self.assertNotIn("SECRET", stderr.getvalue() + stdout.getvalue())
        self.assertNotIn(KEY, stderr.getvalue() + stdout.getvalue())
        with mock.patch.dict(os.environ, {"PLAN_SCOPE": "unknown"}), \
                mock.patch.object(sys, "argv", ["ci_tf_assets.py", "check-layer", "--layer", "inv_layer"]), \
                mock.patch.object(Path, "cwd", return_value=root), \
                mock.patch.object(self.module, "validate_layer") as validate, \
                mock.patch.object(sys, "stderr", io.StringIO()):
            self.assertEqual(self.module.main(), 1)
            validate.assert_not_called()

    def test_bootstrap_scopes_remain_authenticated_binding_values(self):
        for scope in ("ecr-bootstrap", "runtime-ecr-bootstrap"):
            with self.subTest(scope=scope):
                self.module.bundle_assets(self.plan, self.archive, COMMIT, scope)
                with self.assertRaises(ValueError):
                    self.module.restore_assets(self.apply, self.archive, COMMIT, "full")
                self.module.restore_assets(self.apply, self.archive, COMMIT, scope)

    def test_cli_only_accepts_reviewed_source_event_contexts(self):
        root = self.root / "terraform/foundation"
        root.mkdir(parents=True)
        for command, function in (("pack", "bundle_assets"), ("restore", "restore_assets")):
            for event, expected in (
                ("pull_request_target", 1), ("workflow_run", 1), ("repository_dispatch", 1),
                ("issue_comment", 1), ("schedule", 1), ("new_event", 1),
                ("workflow_dispatch", 0), ("push", 0), ("pull_request", 0),
            ):
                with self.subTest(command=command, event=event), \
                        mock.patch.dict(os.environ, {"GITHUB_EVENT_NAME": event, "GITHUB_SHA": COMMIT}), \
                        mock.patch.object(Path, "cwd", return_value=root), \
                        mock.patch.object(sys, "argv", ["ci_tf_assets.py", command, "--scope", "full"]), \
                        mock.patch.object(sys, "stderr", io.StringIO()), \
                        mock.patch.object(sys, "stdout", io.StringIO()), \
                        mock.patch.object(self.module, function, return_value={"files": 0}) as operation:
                    self.assertEqual(self.module.main(), expected)
                    if expected == 1:
                        operation.assert_not_called()
                    else:
                        operation.assert_called_once_with(root, root / "tfassets.tar.gz", COMMIT, "full")

    def test_direct_pack_restore_enforce_the_same_event_allowlist(self):
        self.pack()
        for event in ("pull_request_target", "workflow_run", "repository_dispatch",
                      "issue_comment", "schedule", "new_event"):
            with self.subTest(event=event), mock.patch.dict(os.environ, {"GITHUB_EVENT_NAME": event}):
                with self.assertRaises(ValueError):
                    self.pack()
                with self.assertRaises(ValueError):
                    self.module.restore_assets(self.apply, self.archive, COMMIT, "full")
