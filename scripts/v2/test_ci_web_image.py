"""Offline provenance tests; no GitHub or AWS calls."""
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch
import zipfile

sys.path.insert(0, str(Path(__file__).parent))
from ci_web_image import (ImageError, build_receipt, resolve_digest, pin_image,
                          role_context, verify_caller, verify_source_and_migration, github)

SHA = "a" * 40
DIGEST = "sha256:" + "b" * 64
REPO = "aws-samples/sample-awsops"


def context(**overrides):
    value = dict(repository=REPO, branch="dev", sha=SHA, event="workflow_dispatch",
                 run_id="123", attempt="1", project="sample-dev",
                 account="123456789012", job_id="789")
    return value | overrides


class ProvenanceTest(unittest.TestCase):
    def test_compare_projects_metadata_before_the_python_output_cap(self):
        payload = {"status": "ahead", "merge_base_commit": {"sha": SHA},
                   "files": [{"patch": "x" * (2 * 1024 * 1024)}]}
        def gh_call(argv, **kwargs):
            self.assertEqual(argv[:4], ["gh", "api", "--hostname", "github.com"])
            # gh applies --jq locally before it writes stdout; use real jq here.
            projection = argv[argv.index("--jq") + 1]
            result = subprocess.run(["jq", projection], input=json.dumps(payload).encode(),
                                    capture_output=True, check=True)
            return subprocess.CompletedProcess(argv, 0, stdout=result.stdout, stderr=b"")
        original = subprocess.run
        def boundary(argv, **kwargs):
            return gh_call(argv, **kwargs) if argv[0] == "gh" else original(argv, **kwargs)
        with patch("ci_web_image.subprocess.run", side_effect=boundary):
            result = github(f"repos/{REPO}/compare/{SHA}...{'b' * 40}")
        self.assertEqual(result, {"status": "ahead", "merge_base_commit": {"sha": SHA}})

    def test_public_receipt_has_no_account_identifier_or_enumerable_hash(self):
        receipt = build_receipt(context(), DIGEST)
        self.assertNotIn(context()["account"], json.dumps(receipt))
        self.assertNotIn(hashlib.sha256(context()["account"].encode()).hexdigest(), json.dumps(receipt))
        self.assertNotIn("account_sha256", receipt)
        self.assertEqual(set(receipt), {"schema", "repository", "workflow", "branch", "sha",
                                        "run_id", "attempt", "job_id", "project", "digest"})
        self.assertEqual(receipt, build_receipt(context(account="999999999999"), DIGEST))

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


class ContextTest(unittest.TestCase):
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

    def test_branch_accounts_configuration_and_actual_role_fail_closed(self):
        for branch in ("dev", "atomoh", "ssminji", "whchoi", "main"):
            account = "999999999999" if branch == "main" else "123456789012"
            env = {
                "GITHUB_REPOSITORY": REPO, "GITHUB_REF_NAME": branch,
                "GITHUB_REF": f"refs/heads/{branch}", "GITHUB_EVENT_NAME": "push",
                "GITHUB_WORKFLOW_REF": f"{REPO}/.github/workflows/deploy-web.yml@refs/heads/{branch}",
                "CI_ROLE_ARN": f"arn:aws:iam::{account}:role/CI", "AWS_ACCOUNT_ID_DEV": "123456789012",
            }
            with self.subTest(branch=branch):
                self.assertEqual(role_context(env), (account, "CI"))
                invalid = [{"CI_ROLE_ARN": ""}, {"GITHUB_REF": "refs/heads/other"},
                           {"GITHUB_REPOSITORY": "Atom-oh/awsops"}]
                invalid += [{"AWS_ACCOUNT_ID_DEV": value} for value in
                            ("", "123", "x" * 12, "123456789012\n", "999999999999")]
                if branch == "main":
                    invalid.append({"CI_ROLE_ARN": "arn:aws:iam::123456789012:role/CI"})
                for change in invalid:
                    with self.subTest(change=change), self.assertRaises(ImageError):
                        role_context(env | change)
                with self.assertRaises(ImageError):
                    verify_caller(env, lambda: {"Account": account,
                        "Arn": f"arn:aws:sts::{account}:assumed-role/Other/GitHub"})


if __name__ == "__main__":
    unittest.main()
