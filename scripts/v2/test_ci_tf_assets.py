"""Saved plans and their local Lambda files must remain inseparable."""
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest


COMMIT = "a" * 40


class TerraformAssetTests(unittest.TestCase):
    def setUp(self):
        script = Path(__file__).with_name("ci_tf_assets.py")
        self.assertTrue(script.is_file(), "Saved-plan asset transport is not implemented")
        spec = importlib.util.spec_from_file_location("ci_tf_assets", script)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
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

    def test_restores_exact_plan_time_files_in_a_clean_apply_directory(self):
        self.pack()
        result = self.module.restore_assets(self.apply, self.archive, COMMIT, "full")
        self.assertEqual(result["files"], 2)
        self.assertEqual((self.apply / ".build/function.zip").read_bytes(), b"exact Lambda archive")
        self.assertEqual((self.apply / ".build/layer/python/module.py").read_text(), "VALUE = 1\n")

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

    def test_prepared_layer_marker_must_match_the_locked_dependency_closure(self):
        self.assertTrue(hasattr(self.module, "validate_layer"), "Prepared layer validation is missing")
        layer = self.plan / ".build/inv_layer/python/pg8000"
        layer.mkdir(parents=True)
        (layer / "__init__.py").write_text("# fixture")
        marker = self.plan / ".build/.ci-prepared.json"
        marker.write_text(json.dumps({"schema_version": 1, "layers": ["inv_layer"], "lock_sha256": "wrong"}))
        with self.assertRaises(ValueError):
            self.module.validate_layer(self.plan, "inv_layer")
        marker.write_text(json.dumps({
            "schema_version": 1, "layers": ["inv_layer"], "lock_sha256": self.module.digest(self.module.LOCK),
        }))
        self.module.validate_layer(self.plan, "inv_layer")
        with self.assertRaises(ValueError):
            self.module.validate_layer(self.plan, "pg8000_layer")
