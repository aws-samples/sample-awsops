"""Offline provenance tests; no GitHub or AWS calls."""
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
import zipfile
import yaml

sys.path.insert(0, str(Path(__file__).parent))
from ci_web_image import (ImageError, build_receipt, resolve_digest, pin_image,
                          role_context, verify_caller, verify_source_and_migration)

SHA = "a" * 40
DIGEST = "sha256:" + "b" * 64
REPO = "aws-samples/sample-awsops"


def context(**overrides):
    value = dict(repository=REPO, branch="dev", sha=SHA, event="workflow_dispatch",
                 run_id="123", attempt="1", project="sample-dev",
                 account="123456789012", job_id="789")
    return value | overrides


class ProvenanceTest(unittest.TestCase):
    def test_public_receipt_binds_account_without_publishing_configured_identifier(self):
        receipt = build_receipt(context(), DIGEST)
        self.assertNotIn(context()["account"], json.dumps(receipt))
        self.assertEqual(receipt["account_sha256"], hashlib.sha256(context()["account"].encode()).hexdigest())

    def producer(self, *, receipt=None, run_changes=None, artifact_changes=None, job_changes=None):
        body = receipt or build_receipt(context(), DIGEST)
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w") as z:
            z.writestr("web-build.json", json.dumps(body))
        data = archive.getvalue()
        run = dict(id=123, run_attempt=1, status="completed", conclusion="success",
                   event="push", path=".github/workflows/deploy-web.yml",
                   head_sha=SHA, head_branch="dev",
                   repository={"full_name": REPO, "id": 11}, head_repository={"full_name": REPO, "id": 11})
        attempt = dict(run)
        run.update(run_changes or {})
        artifact = dict(id=456, name="web-build-123-1", expired=False,
                        size_in_bytes=len(data), digest="sha256:" + hashlib.sha256(data).hexdigest(),
                        created_at="2026-09-14T00:01:00Z",
                        workflow_run={"id": 123, "repository_id": 11, "head_repository_id": 11,
                                      "head_sha": SHA, "head_branch": "dev"})
        artifact.update(artifact_changes or {})
        job = dict(id=789, run_id=123, run_attempt=1, head_sha=SHA, name="Build & push (arm64)",
                   status="completed", conclusion="success",
                   started_at="2026-09-14T00:00:00Z", completed_at="2026-09-14T00:02:00Z",
                   steps=[{"name": name, "status": "completed", "conclusion": "success"}
                          for name in ["Build and push (arm64)", "Record the image producer",
                                       "Retain the build receipt for explicit reuse"]])
        job.update(job_changes or {})
        calls = []

        def api(path, binary=False):
            calls.append(path)
            if path.endswith("/artifacts/456/zip"):
                return data
            if path.endswith("/artifacts?per_page=100"):
                return {"total_count": 1, "artifacts": [artifact]}
            if path.endswith("/jobs/789"):
                return job
            if path.endswith("/attempts/1"):
                return attempt
            return run
        return api, calls

    def test_fresh_build_uses_job_digest_without_tag_or_api(self):
        def forbidden(*args, **kwargs):
            self.fail("fresh job outputs must not perform a producer lookup")
        self.assertEqual(resolve_digest(context(), pin_sha=SHA, fresh_digest=DIGEST,
                                       fresh_project="sample-dev", api=forbidden), DIGEST)

    def test_fresh_build_rejects_reuse_inputs_and_different_stack(self):
        for changes in ({"pin_sha": "c" * 40}, {"producer_run": "123"},
                        {"fresh_project": "other"}, {"fresh_digest": "web-latest"}):
            with self.subTest(changes=changes), self.assertRaises(ImageError):
                resolve_digest(context(), **(dict(pin_sha=SHA, fresh_digest=DIGEST,
                    fresh_project="sample-dev") | changes))

    def test_reuse_is_bound_to_successful_workflow_source_stack_and_artifact(self):
        api, calls = self.producer()
        self.assertEqual(resolve_digest(context(run_id="900"), pin_sha=SHA,
                                       producer_run="123", api=api), DIGEST)
        self.assertEqual(sum(p.endswith("/runs/123") for p in calls), 2)

    def test_reuse_rejects_untrusted_or_incomplete_producers(self):
        for changes in ({"status": "in_progress"},
                        {"event": "pull_request"}, {"head_sha": "c" * 40},
                        {"head_branch": "main"},
                        {"path": ".github/workflows/other.yml"},
                        {"head_repository": {"full_name": "other/repo"}},
                        {"repository": {"full_name": "other/repo"}}):
            with self.subTest(changes=changes), self.assertRaises(ImageError):
                api, _ = self.producer(run_changes=changes)
                resolve_digest(context(run_id="900"), pin_sha=SHA,
                               producer_run="123", api=api)

    def test_successful_build_receipt_survives_deploy_only_retry(self):
        api, calls = self.producer(run_changes={"run_attempt": 2, "conclusion": "failure"})
        self.assertEqual(resolve_digest(context(run_id="900"), pin_sha=SHA,
                                       producer_run="123", api=api), DIGEST)
        self.assertTrue(any(p.endswith("/attempts/1") for p in calls))
        self.assertTrue(any(p.endswith("/jobs/789") for p in calls))

    def test_later_failed_build_receipt_does_not_poison_a_successful_attempt(self):
        original, _ = self.producer(run_changes={"run_attempt": 2, "conclusion": "failure"})
        receipt = build_receipt(context(attempt="2", job_id="790"), "sha256:" + "c" * 64)
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w") as z:
            z.writestr("web-build.json", json.dumps(receipt))
        data = archive.getvalue()
        def api(path, binary=False):
            if path.endswith("/artifacts/457/zip"):
                return data
            if path.endswith("/artifacts?per_page=100"):
                result = original(path)
                second = result["artifacts"][0] | {
                    "id": 457, "name": "web-build-123-2", "size_in_bytes": len(data),
                    "digest": "sha256:" + hashlib.sha256(data).hexdigest(),
                }
                return {"total_count": 2, "artifacts": [*result["artifacts"], second]}
            if path.endswith("/attempts/2"):
                return original(path) | {"run_attempt": 2}
            if path.endswith("/jobs/790"):
                return original(f"repos/{REPO}/actions/jobs/789") | {
                    "id": 790, "run_attempt": 2, "conclusion": "failure",
                }
            return original(path, binary)
        self.assertEqual(resolve_digest(context(run_id="900"), pin_sha=SHA,
                                       producer_run="123", api=api), DIGEST)

    def test_actual_build_job_not_artifact_name_establishes_provenance(self):
        for changes in [{"run_attempt": 2}, {"run_id": 999}, {"head_sha": "c" * 40},
                        {"name": "Roll ECS service"}, {"status": "in_progress"},
                        {"conclusion": "failure"}, {"steps": []},
                        {"completed_at": "2026-09-14T00:00:30Z"}]:
            with self.subTest(changes=changes), self.assertRaises(ImageError):
                api, _ = self.producer(job_changes=changes)
                resolve_digest(context(run_id="900"), pin_sha=SHA, producer_run="123", api=api)

    def test_reuse_rejects_missing_tampered_or_wrong_stack_receipt(self):
        for receipt in (build_receipt(context(project="other"), DIGEST),
                        build_receipt(context(sha="c" * 40), DIGEST),
                        build_receipt(context(attempt="2"), DIGEST)):
            with self.subTest(receipt=receipt), self.assertRaises(ImageError):
                api, _ = self.producer(receipt=receipt)
                resolve_digest(context(run_id="900"), pin_sha=SHA, producer_run="123", api=api)
        for changes in ({"expired": True}, {"digest": "sha256:" + "0" * 64},
                        {"size_in_bytes": 2_000_000}, {"name": "other"}):
            with self.subTest(changes=changes), self.assertRaises(ImageError):
                api, _ = self.producer(artifact_changes=changes)
                resolve_digest(context(run_id="900"), pin_sha=SHA, producer_run="123", api=api)

    def test_reuse_rejects_run_that_changes_during_download(self):
        original, _ = self.producer()
        reads = 0
        def api(path, binary=False):
            nonlocal reads
            value = original(path, binary)
            if path.endswith("/runs/123"):
                reads += 1
                if reads == 2:
                    return value | {"run_attempt": 2}
            return value
        with self.assertRaises(ImageError):
            resolve_digest(context(run_id="900"), pin_sha=SHA, producer_run="123", api=api)

    def test_push_cannot_reuse_an_old_build_or_accept_foreign_repository(self):
        for c in (context(event="push"), context(repository="other/repo")):
            with self.subTest(context=c), self.assertRaises(ImageError):
                api, _ = self.producer()
                resolve_digest(c, pin_sha=SHA, producer_run="123", api=api)

    def test_pin_reads_by_digest_and_rejects_changed_manifest_before_write(self):
        manifest = '{"schemaVersion":2,"config":{}}'
        digest = "sha256:" + hashlib.sha256(manifest.encode()).hexdigest()
        calls = []
        def aws(operation, args):
            calls.append((operation, args))
            if operation == "batch-get-image":
                return {"images": [{"imageId": {"imageDigest": digest},
                                    "imageManifest": manifest}]}
            return {"image": {"imageId": {"imageDigest": digest}}}
        pin_image("sample-dev-web", digest, aws)
        self.assertEqual(calls[0][1]["image-ids"], f"imageDigest={digest}")
        self.assertEqual(calls[1][1]["image-manifest"], manifest)
        calls.clear()
        with self.assertRaises(ImageError):
            pin_image("sample-dev-web", DIGEST, aws)
        self.assertEqual(len(calls), 1)

    def test_archive_never_extracts_paths_or_accepts_extra_entries(self):
        for names in (["../web-build.json"], ["web-build.json", "other"],
                      ["web-build.json", "web-build.json"]):
            archive = io.BytesIO()
            with zipfile.ZipFile(archive, "w") as z:
                for name in names:
                    z.writestr(name, json.dumps(build_receipt(context(), DIGEST)))
            data = archive.getvalue()
            api, _ = self.producer(artifact_changes={
                "digest": "sha256:" + hashlib.sha256(data).hexdigest(),
                "size_in_bytes": len(data)})
            def substitute(path, binary=False):
                return data if binary else api(path)
            with self.subTest(names=names), self.assertRaises(ImageError):
                resolve_digest(context(run_id="900"), pin_sha=SHA,
                               producer_run="123", api=substitute)


class WorkflowTest(unittest.TestCase):
    root = Path(__file__).resolve().parents[2]

    def workflow(self, name):
        return yaml.safe_load((self.root / ".github/workflows" / name).read_text())

    def test_dev_roll_requires_migration_and_build_proof_with_explicit_secrets(self):
        web = self.workflow("deploy-web.yml")
        migrate = web["jobs"]["migrate-dev"]
        self.assertEqual(migrate["needs"], ["guard", "build"])
        self.assertEqual(migrate["uses"], "./.github/workflows/deploy-migrations.yml")
        self.assertEqual(migrate["with"], {"from_deploy_web": True})
        expected = ["TF_TFVARS_DEV", "TF_BACKEND_HCL_DEV", "AWS_ACCOUNT_ID_DEV",
                    "AWS_CI_BUILD_DEV_ROLE_ARN", "AWS_CI_DEPLOYER_DEV_ROLE_ARN"]
        self.assertEqual(migrate["secrets"], {k: "${{ secrets." + k + " }}" for k in expected})
        deploy = web["jobs"]["deploy"]
        self.assertEqual(deploy["needs"], ["guard", "build", "migrate-dev"])
        self.assertIn("needs.guard.result == 'success'", deploy["if"])
        self.assertIn("needs.migrate-dev.result == 'success'", deploy["if"])
        self.assertIn("github.event_name == 'workflow_dispatch' || github.ref_name != 'main'", deploy["if"])
        steps = deploy["steps"]
        pin = next(s for s in steps if s.get("id") == "pin")
        self.assertEqual(pin["env"]["FRESH_DIGEST"], "${{ needs.build.outputs.digest }}")
        self.assertEqual(pin["env"]["IMAGE_BUILD_RUN_ID"], "${{ inputs.image_build_run_id }}")
        self.assertNotIn('imageTag="web-', pin["run"])
        self.assertIn("ci_web_deploy.py deploy", pin["run"])
        self.assertEqual(pin["env"]["MIGRATED_SHA"], "${{ needs.migrate-dev.outputs.source_sha }}")
        self.assertEqual(pin["env"]["MIGRATED_PROJECT"], "${{ needs.migrate-dev.outputs.project }}")
        self.assertLess(steps.index(pin), next(i for i, s in enumerate(steps)
                                             if s.get("name") == "Verify exact deployment and healthy running web image"))
        self.assertEqual(deploy["outputs"]["expected_image_digest"], "${{ steps.pin.outputs.digest }}")
        self.assertEqual(deploy["outputs"]["expected_runtime_digest"], "${{ steps.pin.outputs.runtime_digest }}")
        self.assertFalse(deploy["concurrency"]["cancel-in-progress"])

    def test_migration_guard_accepts_only_explicit_dev_web_push_or_dev_dispatch(self):
        workflow = self.workflow("deploy-migrations.yml")
        self.assertFalse(workflow[True]["workflow_call"]["inputs"]["from_deploy_web"]["default"])
        script = workflow["jobs"]["guard"]["steps"][0]["run"]
        env = dict(os.environ, GITHUB_REPOSITORY=REPO, GITHUB_REF="refs/heads/dev",
                   GITHUB_EVENT_NAME="push", MIGRATION_FROM_DEPLOY_WEB="true",
                   GITHUB_WORKFLOW_REF=REPO + "/.github/workflows/deploy-web.yml@refs/heads/dev")
        cases = [({}, True), ({"GITHUB_EVENT_NAME": "workflow_dispatch"}, True),
                 ({"MIGRATION_FROM_DEPLOY_WEB": ""}, False),
                 ({"GITHUB_EVENT_NAME": "pull_request"}, False),
                 ({"GITHUB_REPOSITORY": "other/repo"}, False),
                 ({"GITHUB_REF": "refs/heads/main"}, False),
                 ({"GITHUB_WORKFLOW_REF": REPO + "/.github/workflows/other.yml@refs/heads/dev"}, False)]
        for changes, allowed in cases:
            with self.subTest(changes=changes):
                result = subprocess.run(["bash", "-euo", "pipefail", "-c", script],
                                        env=env | changes, capture_output=True, timeout=5)
                self.assertEqual(result.returncode == 0, allowed)

    def test_invalid_image_inputs_fail_before_migration_or_build(self):
        web = self.workflow("deploy-web.yml")
        script = web["jobs"]["guard"]["steps"][0]["run"]
        env = dict(os.environ, GITHUB_EVENT_NAME="workflow_dispatch", GITHUB_SHA=SHA,
                   GITHUB_REPOSITORY=REPO, GITHUB_REF="refs/heads/dev", GITHUB_OUTPUT="/dev/null",
                   BUILD="false", IMAGE_SHA="", PRODUCER_RUN="123", SCHEMA_ACK="false", VERIFY_DATABASE="false")
        for changes, allowed in [({}, True), ({"PRODUCER_RUN": ""}, False),
                                 ({"IMAGE_SHA": "short"}, False),
                                 ({"BUILD": "true"}, False),
                                 ({"BUILD": "true", "PRODUCER_RUN": ""}, True),
                                 ({"GITHUB_EVENT_NAME": "pull_request"}, False)]:
            with self.subTest(changes=changes):
                result = subprocess.run(["bash", "-euo", "pipefail", "-c", script],
                                        env=env | changes, capture_output=True, timeout=5)
                self.assertEqual(result.returncode == 0, allowed)
        self.assertEqual(web["jobs"]["build"]["needs"], ["guard"])

    def test_current_dev_promotion_requires_exact_source_and_project(self):
        c = context()
        def api(path):
            self.assertTrue(path.endswith("/git/ref/heads/dev"))
            return {"object": {"sha": SHA}}
        valid = {"MIGRATED_SHA": SHA, "MIGRATED_PROJECT": "sample-dev"}
        self.assertFalse(verify_source_and_migration(c, SHA, valid, api))
        for change in [{"MIGRATED_SHA": ""}, {"MIGRATED_SHA": "c" * 40}, {"MIGRATED_PROJECT": "other"}]:
            with self.subTest(change=change), self.assertRaises(ImageError):
                verify_source_and_migration(c, SHA, valid | change, api)

    def test_older_image_rollback_never_accepts_current_migration_receipt(self):
        older = "c" * 40
        def api(path):
            if "/compare/" in path:
                return {"status": "ahead", "merge_base_commit": {"sha": older}}
            return {"object": {"sha": SHA}}
        ack = {"ROLLBACK_SCHEMA_COMPATIBLE": "true"}
        self.assertTrue(verify_source_and_migration(context(), older, ack, api))
        for value in [{}, ack | {"MIGRATED_SHA": SHA}, ack | {"MIGRATED_PROJECT": "sample-dev"}]:
            with self.subTest(value=value), self.assertRaises(ImageError):
                verify_source_and_migration(context(), older, value, api)

    def test_role_binding_cannot_fall_back_to_a_foreign_account(self):
        env = {
            "GITHUB_REPOSITORY": REPO, "GITHUB_REF_NAME": "dev", "GITHUB_REF": "refs/heads/dev",
            "GITHUB_EVENT_NAME": "push",
            "GITHUB_WORKFLOW_REF": REPO + "/.github/workflows/deploy-web.yml@refs/heads/dev",
            "CI_ROLE_ARN": "arn:aws:iam::123456789012:role/CI", "AWS_ACCOUNT_ID_DEV": "123456789012",
        }
        self.assertEqual(role_context(env), ("123456789012", "CI"))
        for change in [{"CI_ROLE_ARN": ""}, {"AWS_ACCOUNT_ID_DEV": "999999999999"},
                       {"GITHUB_REF": "refs/heads/main"}, {"GITHUB_REPOSITORY": "Atom-oh/awsops"}]:
            with self.subTest(change=change), self.assertRaises(ImageError):
                role_context(env | change)
        with self.assertRaises(ImageError):
            verify_caller(env, lambda: {"Account": "123456789012",
                "Arn": "arn:aws:sts::123456789012:assumed-role/Other/GitHub"})

    def test_rollback_is_explicit_and_never_runs_current_migrations(self):
        script = self.workflow("deploy-web.yml")["jobs"]["guard"]["steps"][0]["run"]
        import tempfile
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / "output"
            env = dict(os.environ, GITHUB_EVENT_NAME="workflow_dispatch", GITHUB_SHA=SHA,
                       GITHUB_REPOSITORY=REPO, GITHUB_REF="refs/heads/dev", GITHUB_OUTPUT=str(output),
                       BUILD="false", IMAGE_SHA="c" * 40, PRODUCER_RUN="123",
                       SCHEMA_ACK="false", VERIFY_DATABASE="false")
            denied = subprocess.run(["bash", "-euo", "pipefail", "-c", script], env=env, capture_output=True)
            self.assertNotEqual(denied.returncode, 0)
            allowed = subprocess.run(["bash", "-euo", "pipefail", "-c", script],
                                     env=env | {"SCHEMA_ACK": "true"}, capture_output=True)
            self.assertEqual(allowed.returncode, 0, allowed.stderr)
            self.assertIn("migration_required=false", output.read_text())
            self.assertIn("rollback=true", output.read_text())


if __name__ == "__main__":
    unittest.main()
