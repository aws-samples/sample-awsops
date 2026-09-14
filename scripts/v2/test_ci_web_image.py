"""Offline provenance tests; no GitHub or AWS calls."""
import hashlib
import io
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

sys.path.insert(0, str(Path(__file__).parent))
from ci_web_image import (ImageError, build_receipt, resolve_digest, pin_image,
                          role_context, verify_caller, verify_source_and_migration, github)
import ci_web_image as subject

SHA = "a" * 40
DIGEST = "sha256:" + "b" * 64
REPO = "aws-samples/sample-awsops"
ACCOUNT = "123456789012"
IMAGE_MEDIA = "application/vnd.oci.image.manifest.v1+json"
DOCKER_MEDIA = "application/vnd.docker.distribution.manifest.v2+json"
INDEX_MEDIA = "application/vnd.oci.image.index.v1+json"
CONFIG = b'{"architecture":"arm64","os":"linux","rootfs":{"type":"layers","diff_ids":[]}}'


def image_fixture(*, media=IMAGE_MEDIA, config=CONFIG, body_changes=None):
    body = {"schemaVersion": 2, "mediaType": media,
            "config": {"mediaType": "application/vnd.oci.image.config.v1+json"
                       if media == IMAGE_MEDIA else "application/vnd.docker.container.image.v1+json",
                       "digest": "sha256:" + hashlib.sha256(config).hexdigest(), "size": len(config)},
            "layers": []}
    body.update(body_changes or {})
    raw = json.dumps(body)
    return {"registryId": ACCOUNT, "repositoryName": "sample-dev-web",
            "imageId": {"imageDigest": "sha256:" + hashlib.sha256(raw.encode()).hexdigest()},
            "imageManifest": raw, "imageManifestMediaType": media}


def index_fixture(child, *, entries=None, media=INDEX_MEDIA):
    arm = {"mediaType": child["imageManifestMediaType"],
           "digest": child["imageId"]["imageDigest"], "size": len(child["imageManifest"].encode()),
           "platform": {"os": "linux", "architecture": "arm64"}}
    attestation = {"mediaType": IMAGE_MEDIA, "digest": DIGEST, "size": 512,
                   "platform": {"os": "unknown", "architecture": "unknown"},
                   "annotations": {"vnd.docker.reference.type": "attestation-manifest",
                                   "vnd.docker.reference.digest": arm["digest"]}}
    raw = json.dumps({"schemaVersion": 2, "mediaType": media,
                      "manifests": [arm, attestation] if entries is None else entries})
    return child | {"imageManifest": raw, "imageManifestMediaType": media,
                    "imageId": {"imageDigest": "sha256:" + hashlib.sha256(raw.encode()).hexdigest()}}


def context(**overrides):
    value = dict(repository=REPO, branch="dev", sha=SHA, event="workflow_dispatch",
                 run_id="123", attempt="1", project="sample-dev",
                 account="123456789012", job_id="789")
    return value | overrides


class ProvenanceTest(unittest.TestCase):
    def promotion_fixture(self, *, config=CONFIG, media=IMAGE_MEDIA):
        image = image_fixture(config=config, media=media)
        digest = image["imageId"]["imageDigest"]
        env = {"GITHUB_REPOSITORY": REPO, "GITHUB_REF_NAME": "dev",
               "GITHUB_REF": "refs/heads/dev", "GITHUB_EVENT_NAME": "workflow_dispatch",
               "GITHUB_WORKFLOW_REF": REPO + "/.github/workflows/deploy-web.yml@refs/heads/dev",
               "GITHUB_SHA": SHA, "GITHUB_RUN_ID": "900", "GITHUB_RUN_ATTEMPT": "1",
               "CI_ROLE_ARN": "arn:aws:iam::123456789012:role/CI", "AWS_ACCOUNT_ID_DEV": "123456789012",
               "IMAGE_PROJECT": "sample-dev", "MIGRATED_SHA": SHA, "MIGRATED_PROJECT": "sample-dev",
               "FRESH_DIGEST": digest, "FRESH_PROJECT": "sample-dev", "PREFLIGHT_DIGEST": digest}
        trace = []
        download = patch.object(subject, "command", return_value=config)
        download.start()
        self.addCleanup(download.stop)
        def caller():
            trace.append("caller")
            return {"Account": "123456789012", "Arn": "arn:aws:sts::123456789012:assumed-role/CI/session"}
        def api(path, **kwargs):
            trace.append("source")
            return {"object": {"sha": SHA}}
        def aws(operation, args):
            trace.append(operation)
            self.assertEqual(args["repository-name"], "sample-dev-web")
            if operation == "batch-get-image":
                tag = args["image-ids"].removeprefix("imageTag=")
                return {"images": [image | {"imageId": image["imageId"] | {"imageTag": tag}}]}
            if operation == "get-download-url-for-layer":
                return {"layerDigest": json.loads(image["imageManifest"])["config"]["digest"],
                        "downloadUrl": "https://fixture.s3.ap-northeast-2.amazonaws.com/config"}
            self.assertEqual(operation, "put-image")
            return {"image": image | {"imageId": image["imageId"] | {"imageTag": "web-latest"}}}
        return env, digest, trace, caller, api, aws

    def test_promote_enforces_complete_chain_and_derived_repository(self):
        env, digest, trace, caller, api, aws = self.promotion_fixture()
        result = subject.promote(env, caller=caller, api=api, aws=aws, expected_digest=digest)
        self.assertEqual(trace, ["caller", "source", "source", "batch-get-image",
                                 "get-download-url-for-layer", "batch-get-image", "put-image"])
        self.assertEqual(result, {"digest": digest, "image_sha": SHA, "rollback": False})

    def test_promote_guard_failures_never_reach_a_write(self):
        for failure in ("caller", "source", "migration", "project", "producer", "expected", "rollback", "manifest"):
            env, digest, trace, caller, api, aws = self.promotion_fixture()
            expected = digest
            if failure == "caller":
                caller = lambda: {"Account": "999999999999", "Arn": "foreign"}
            elif failure == "source":
                api = lambda *args, **kwargs: {"object": {"sha": "b" * 40}}
            elif failure == "migration":
                env["MIGRATED_SHA"] = ""
            elif failure == "project":
                env["FRESH_PROJECT"] = "other"
            elif failure == "producer":
                env.update(FRESH_DIGEST="", IMAGE_BUILD_RUN_ID="123")
            elif failure == "expected":
                expected = "sha256:" + "f" * 64
            elif failure == "rollback":
                env["PIN_SHA"] = "b" * 40
            else:
                original = aws
                def corrupt(operation, args):
                    result = original(operation, args)
                    if operation == "batch-get-image":
                        result["images"][0]["imageManifest"] = "{}"
                    return result
                aws = corrupt
            with self.subTest(failure=failure), self.assertRaises(ImageError):
                subject.promote(env, caller=caller, api=api, aws=aws, expected_digest=expected)
            self.assertNotIn("put-image", trace)

    def test_promote_cli_runs_the_complete_chain(self):
        env, digest, trace, caller, api, aws = self.promotion_fixture()
        def identity(argv, **kwargs):
            if argv[0] == "curl":
                return CONFIG
            self.assertEqual(argv[:3], ["aws", "sts", "get-caller-identity"])
            return caller()
        with patch.dict(os.environ, env, clear=True), \
                patch.object(sys, "argv", ["ci_web_image.py", "promote"]), \
                patch.object(subject, "command", side_effect=identity), \
                patch.object(subject, "github", side_effect=api), \
                patch.object(subject, "aws_request", side_effect=aws), \
                patch.object(sys, "stdout", new_callable=io.StringIO) as stdout:
            subject.main()
        self.assertEqual(trace, ["caller", "source", "source", "batch-get-image",
                                 "get-download-url-for-layer", "batch-get-image", "put-image"])
        self.assertEqual(json.loads(stdout.getvalue()),
                         {"digest": digest, "image_sha": SHA, "rollback": False})

    def test_promote_reuses_verified_receipt_after_deploy_retry(self):
        env, digest, trace, caller, source, aws = self.promotion_fixture()
        env.update(FRESH_DIGEST="", FRESH_PROJECT="", IMAGE_BUILD_RUN_ID="123",
                   PREFLIGHT_DIGEST=digest)
        producer, calls = self.producer(
            receipt=build_receipt(context(), digest),
            run_changes={"run_attempt": 2, "conclusion": "failure"})
        def api(path, **kwargs):
            return source(path) if "/git/ref/" in path else producer(path, **kwargs)
        result = subject.promote(env, caller=caller, api=api, aws=aws)
        self.assertEqual(result, {"digest": digest, "image_sha": SHA, "rollback": False})
        self.assertIn(f"repos/{REPO}/actions/jobs/789", calls)
        self.assertEqual(trace[-2:], ["get-download-url-for-layer", "put-image"])
        # Changing the pre-migration selection must fail before any registry write.
        env["PREFLIGHT_DIGEST"] = DIGEST
        trace.clear()
        with self.assertRaisesRegex(ImageError, "Validated image digest changed"):
            subject.promote(env, caller=caller, api=api, aws=aws)
        self.assertNotIn("put-image", trace)

    def test_promote_rollback_requires_ancestor_receipt_and_no_migrations(self):
        env, digest, trace, caller, source, aws = self.promotion_fixture()
        # The producer fixture is at SHA; dispatch a newer branch HEAD.
        current = "c" * 40
        env.update(GITHUB_SHA=current, PIN_SHA=SHA, FRESH_DIGEST="", FRESH_PROJECT="",
                   IMAGE_BUILD_RUN_ID="123", ROLLBACK_SCHEMA_COMPATIBLE="true",
                   MIGRATED_SHA="", MIGRATED_PROJECT="")
        producer, _ = self.producer(receipt=build_receipt(context(), digest))
        def api(path, **kwargs):
            if "/git/ref/" in path:
                return {"object": {"sha": current}}
            if "/compare/" in path:
                self.assertTrue(path.endswith(f"/compare/{SHA}...{current}"))
                return {"status": "ahead", "merge_base_commit": {"sha": SHA}}
            return producer(path, **kwargs)
        result = subject.promote(env, caller=caller, api=api, aws=aws)
        self.assertEqual(result, {"digest": digest, "image_sha": SHA, "rollback": True})
        for invalid in ({"ROLLBACK_SCHEMA_COMPATIBLE": "false"},
                        {"MIGRATED_SHA": current}, {"MIGRATED_PROJECT": "sample-dev"}):
            trace.clear()
            with self.subTest(invalid=invalid), self.assertRaises(ImageError):
                subject.promote(env | invalid, caller=caller, api=api, aws=aws)
            self.assertNotIn("put-image", trace)

    def test_promote_rechecks_branch_after_producer_validation(self):
        env, digest, trace, caller, source, aws = self.promotion_fixture()
        env.update(FRESH_DIGEST="", IMAGE_BUILD_RUN_ID="123")
        producer, calls = self.producer(receipt=build_receipt(context(), digest))
        reads = 0
        def api(path, **kwargs):
            nonlocal reads
            if "/git/ref/" in path:
                reads += 1
                return {"object": {"sha": SHA if reads == 1 else "c" * 40}}
            return producer(path, **kwargs)
        with self.assertRaisesRegex(ImageError, "Branch moved"):
            subject.promote(env, caller=caller, api=api, aws=aws)
        self.assertIn(f"repos/{REPO}/actions/jobs/789", calls)
        self.assertEqual(reads, 2)
        self.assertNotIn("put-image", trace)

    def test_receipt_cli_creates_private_file_without_overwriting(self):
        env, digest, _, caller, _, _ = self.promotion_fixture()
        env.update(GITHUB_JOB="build", IMAGE_DIGEST=digest)
        job = {"id": 789, "name": subject.BUILD_JOB, "run_id": 900,
               "run_attempt": 1, "head_sha": SHA, "status": "in_progress"}
        with tempfile.TemporaryDirectory() as directory, \
                patch.dict(os.environ, env, clear=True), \
                patch.object(subject, "command", side_effect=lambda _: caller()), \
                patch.object(subject, "github", return_value={"total_count": 1, "jobs": [job]}):
            output = Path(directory) / "web-build.json"
            with patch.object(sys, "argv", ["ci_web_image.py", "receipt", "--output", str(output)]):
                # Creation must be private even with a permissive process umask.
                old_umask = os.umask(0)
                try:
                    subject.main()
                finally:
                    os.umask(old_umask)
                self.assertEqual(output.stat().st_mode & 0o777, 0o600)
                body = output.read_bytes()
                self.assertEqual(json.loads(body), build_receipt(context(run_id="900"), digest))
                with self.assertRaises(FileExistsError):
                    subject.main()
                self.assertEqual(output.read_bytes(), body)

    def test_ecr_operation_allowlist_rejects_other_operations_before_command(self):
        with patch.object(subject, "command") as command:
            with self.assertRaises(ImageError):
                subject.aws_request("delete-repository", {"repository-name": "sample-dev-web"})
        command.assert_not_called()

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
        _, digest, _, _, _, original = self.promotion_fixture()
        calls = []
        def aws(operation, args):
            calls.append((operation, args))
            return original(operation, args)
        pin_image("sample-dev-web", digest, aws, account=ACCOUNT)
        self.assertEqual(calls[0][1]["image-ids"], f"imageDigest={digest}")
        self.assertEqual(calls[-1][1]["image-manifest"], image_fixture()["imageManifest"])
        calls.clear()
        with self.assertRaises(ImageError):
            pin_image("sample-dev-web", DIGEST, aws, account=ACCOUNT)
        self.assertEqual(len(calls), 1)

    def test_missing_or_empty_preflight_blocks_fresh_and_reused_promotion(self):
        for reuse in (False, True):
            for expected in ({}, {"expected_digest": ""}, {"expected_digest": "not-a-digest"}):
                env, digest, trace, caller, source, aws = self.promotion_fixture()
                if not expected:
                    env.pop("PREFLIGHT_DIGEST")
                if reuse:
                    env.update(FRESH_DIGEST="", IMAGE_BUILD_RUN_ID="123")
                producer, _ = self.producer(receipt=build_receipt(context(), digest))
                def api(path, **kwargs):
                    return source(path) if "/git/ref/" in path else producer(path, **kwargs)
                with self.subTest(reuse=reuse, expected=expected), self.assertRaises(ImageError):
                    subject.promote(env, caller=caller, api=api, aws=aws, **expected)
                self.assertNotIn("put-image", trace)

    def test_fresh_digest_must_match_source_tag_in_same_registry(self):
        for corruption in ("missing", "digest", "account", "repository", "tag"):
            env, digest, trace, caller, api, original = self.promotion_fixture()
            def aws(operation, args):
                result = original(operation, args)
                if args.get("image-ids") == f"imageTag=web-{SHA}":
                    image = result["images"][0]
                    if corruption == "missing":
                        return {"images": [], "failures": [{"failureCode": "ImageNotFound"}]}
                    if corruption == "digest":
                        image["imageId"]["imageDigest"] = DIGEST
                    elif corruption == "account":
                        image["registryId"] = "999999999999"
                    elif corruption == "repository":
                        image["repositoryName"] = "other-web"
                    else:
                        image["imageId"]["imageTag"] = "web-latest"
                return result
            with self.subTest(corruption=corruption), self.assertRaises(ImageError):
                subject.promote(env, caller=caller, api=api, aws=aws, expected_digest=digest)
            self.assertNotIn("put-image", trace)

    def test_ecr_envelope_and_manifest_are_validated_before_publication(self):
        for changes in ({"registryId": "999999999999"}, {"repositoryName": "other-web"},
                        {"imageManifestMediaType": "application/json"},
                        {"imageManifestMediaType": DOCKER_MEDIA}):
            env, digest, trace, caller, api, original = self.promotion_fixture()
            def aws(operation, args):
                result = original(operation, args)
                if operation == "batch-get-image":
                    result["images"][0].update(changes)
                return result
            with self.subTest(changes=changes), self.assertRaises(ImageError):
                subject.promote(env, caller=caller, api=api, aws=aws)
            self.assertNotIn("put-image", trace)

    def test_schema_and_image_shape_fail_closed_even_with_matching_hash(self):
        for changes in ({"schemaVersion": 1}, {"schemaVersion": "2"}, {"config": {}},
                        {"layers": None}, {"manifests": []},
                        {"artifactType": "application/vnd.in-toto+json"}):
            env, _, trace, caller, api, original = self.promotion_fixture()
            image = image_fixture(body_changes=changes)
            env.update(FRESH_DIGEST=image["imageId"]["imageDigest"],
                       PREFLIGHT_DIGEST=image["imageId"]["imageDigest"])
            def aws(operation, args):
                if operation == "batch-get-image":
                    return {"images": [image]}
                return original(operation, args)
            with self.subTest(changes=changes), self.assertRaises(ImageError):
                subject.promote(env, caller=caller, api=api, aws=aws)
            self.assertNotIn("put-image", trace)

    def test_actual_linux_arm64_config_is_required(self):
        for config in (CONFIG.replace(b"arm64", b"amd64"), CONFIG.replace(b"linux", b"windows"),
                       b"{}", b"not json"):
            # The manifest has the correct hash/size of the wrong platform config.
            env, digest, trace, caller, api, aws = self.promotion_fixture(config=config)
            with self.subTest(config=config), self.assertRaises(ImageError):
                subject.promote(env, caller=caller, api=api, aws=aws)
            self.assertNotIn("put-image", trace)

    def test_config_bytes_and_download_reference_must_match(self):
        for failure in ("hash", "size", "digest", "url"):
            env, _, trace, caller, api, original = self.promotion_fixture()
            def aws(operation, args):
                result = original(operation, args)
                if operation == "get-download-url-for-layer":
                    if failure == "digest":
                        result["layerDigest"] = DIGEST
                    elif failure == "url":
                        result["downloadUrl"] = "https://untrusted.invalid/private"
                return result
            data = CONFIG.replace(b"arm64", b"amd64") if failure == "hash" else CONFIG + b" "
            with patch.object(subject, "command", return_value=data), \
                    self.subTest(failure=failure), self.assertRaises(ImageError):
                subject.promote(env, caller=caller, api=api, aws=aws)
            self.assertNotIn("put-image", trace)

    def test_single_platform_docker_and_oci_are_published_with_explicit_identity_and_media(self):
        for media in (DOCKER_MEDIA, IMAGE_MEDIA):
            env, digest, _, caller, api, original = self.promotion_fixture(media=media)
            calls = []
            def aws(operation, args):
                calls.append((operation, args))
                self.assertEqual(args.get("registry-id"), ACCOUNT)
                self.assertNotIn("accepted-media-types", args)
                return original(operation, args)
            with self.subTest(media=media):
                result = subject.promote(env, caller=caller, api=api, aws=aws, expected_digest=digest)
                self.assertEqual(result["digest"], digest)
                self.assertEqual(calls[-1][0], "put-image")
                self.assertEqual(calls[-1][1]["image-digest"], digest)
                self.assertEqual(calls[-1][1]["image-manifest-media-type"], media)
                self.assertEqual(calls[-1][1]["image-manifest"], image_fixture(media=media)["imageManifest"])

    def test_ecr_media_field_supplies_optional_manifest_media_without_rewriting_bytes(self):
        for media in (DOCKER_MEDIA, IMAGE_MEDIA, INDEX_MEDIA):
            env, _, _, caller, api, original = self.promotion_fixture()
            child = image_fixture(media=DOCKER_MEDIA if media == DOCKER_MEDIA else IMAGE_MEDIA)
            image = index_fixture(child) if media == INDEX_MEDIA else dict(child)
            body = json.loads(image["imageManifest"])
            body.pop("mediaType")
            raw = json.dumps(body)
            digest = "sha256:" + hashlib.sha256(raw.encode()).hexdigest()
            image.update(imageManifest=raw, imageId={"imageDigest": digest})
            env.update(FRESH_DIGEST=digest, PREFLIGHT_DIGEST=digest)
            def aws(operation, args):
                if operation == "batch-get-image":
                    if args["image-ids"] == f"imageDigest={child['imageId']['imageDigest']}":
                        return {"images": [child]}
                    tag = args["image-ids"].removeprefix("imageTag=")
                    return {"images": [image | {"imageId": image["imageId"] | {"imageTag": tag}}]}
                if operation == "put-image":
                    self.assertEqual(args["image-manifest"], raw)
                    self.assertEqual(args["image-manifest-media-type"], media)
                    return {"image": image | {"imageId": image["imageId"] | {"imageTag": "web-latest"}}}
                return original(operation, args)
            with self.subTest(media=media):
                self.assertEqual(subject.promote(env, caller=caller, api=api, aws=aws)["digest"], digest)

    def test_index_preserves_provenance_and_binds_one_arm64_child(self):
        for media in (INDEX_MEDIA, "application/vnd.docker.distribution.manifest.list.v2+json"):
            env, _, trace, caller, api, original = self.promotion_fixture()
            child = image_fixture()
            image = index_fixture(child, media=media)
            digest, raw = image["imageId"]["imageDigest"], image["imageManifest"]
            arm = json.loads(raw)["manifests"][0]
            env.update(FRESH_DIGEST=digest, PREFLIGHT_DIGEST=digest)
            calls = []
            def aws(operation, args):
                calls.append((operation, args))
                self.assertEqual(args.get("registry-id"), ACCOUNT)
                self.assertNotIn("accepted-media-types", args)
                if operation == "batch-get-image":
                    if args["image-ids"] == f"imageDigest={arm['digest']}":
                        return {"images": [child]}
                    tag = args["image-ids"].removeprefix("imageTag=")
                    return {"images": [image | {"imageId": image["imageId"] | {"imageTag": tag}}]}
                if operation == "put-image":
                    self.assertEqual(args["image-manifest"], raw)
                    self.assertEqual(args["image-manifest-media-type"], media)
                    self.assertEqual(args["image-digest"], digest)
                    return {"image": image | {"imageId": image["imageId"] | {"imageTag": "web-latest"}}}
                return original(operation, args)
            with self.subTest(media=media):
                result = subject.promote(env, caller=caller, api=api, aws=aws)
                self.assertEqual(result["digest"], digest)
                self.assertTrue(any(args.get("image-ids") == f"imageDigest={arm['digest']}"
                                    for _, args in calls))

    def test_ambiguous_indexes_or_mismatched_children_never_publish(self):
        for failure in ("no-arm", "duplicate-arm", "attestation-only", "nested-index",
                        "missing-platform", "attestation-target", "attestation-shape",
                        "size", "account", "repository", "digest", "media", "schema"):
            env, _, trace, caller, api, original = self.promotion_fixture()
            child = image_fixture(body_changes={"schemaVersion": 1} if failure == "schema" else None)
            entries = json.loads(index_fixture(child)["imageManifest"])["manifests"]
            arm = entries[0]
            if failure == "no-arm":
                arm["platform"]["architecture"] = "amd64"
            elif failure == "duplicate-arm":
                entries.append(dict(arm))
            elif failure == "attestation-only":
                entries = entries[1:]
            elif failure == "nested-index":
                arm["mediaType"] = INDEX_MEDIA
            elif failure == "missing-platform":
                arm.pop("platform")
            elif failure == "attestation-target":
                entries[1]["annotations"]["vnd.docker.reference.digest"] = "sha256:" + "f" * 64
            elif failure == "attestation-shape":
                entries[1]["annotations"]["vnd.docker.reference.type"] = "unrecognized"
            elif failure == "size":
                arm["size"] += 1
            image = index_fixture(child, entries=entries)
            digest = image["imageId"]["imageDigest"]
            env.update(FRESH_DIGEST=digest, PREFLIGHT_DIGEST=digest)
            def aws(operation, args):
                if operation == "batch-get-image":
                    if args["image-ids"] == f"imageDigest={arm['digest']}":
                        corrupted = dict(child)
                        if failure == "account":
                            corrupted["registryId"] = "999999999999"
                        elif failure == "repository":
                            corrupted["repositoryName"] = "other-web"
                        elif failure == "digest":
                            corrupted["imageId"] = {"imageDigest": DIGEST}
                        elif failure == "media":
                            corrupted["imageManifestMediaType"] = DOCKER_MEDIA
                        return {"images": [corrupted]}
                    tag = args["image-ids"].removeprefix("imageTag=")
                    return {"images": [image | {"imageId": image["imageId"] | {"imageTag": tag}}]}
                return original(operation, args)
            with self.subTest(failure=failure), self.assertRaises(ImageError):
                subject.promote(env, caller=caller, api=api, aws=aws)
            self.assertNotIn("put-image", trace)

    def test_promotion_reply_or_idempotent_read_cannot_confirm_another_registry(self):
        for failed_write in (False, True):
            env, _, trace, caller, api, original = self.promotion_fixture()
            def aws(operation, args):
                result = original(operation, args)
                if operation == "put-image":
                    if failed_write:
                        raise ImageError("Image provenance provider request failed")
                    result["image"]["registryId"] = "999999999999"
                elif args.get("image-ids") == "imageTag=web-latest":
                    result["images"][0]["registryId"] = "999999999999"
                return result
            with self.subTest(failed_write=failed_write), self.assertRaises(ImageError):
                subject.promote(env, caller=caller, api=api, aws=aws)

    def test_idempotent_publication_requires_the_same_verified_manifest(self):
        env, digest, trace, caller, api, original = self.promotion_fixture()
        def aws(operation, args):
            if operation == "put-image":
                raise ImageError("Image provenance provider request failed")
            return original(operation, args)
        self.assertEqual(subject.promote(env, caller=caller, api=api, aws=aws)["digest"], digest)
        self.assertEqual(trace[-1], "batch-get-image")

    def test_completed_producer_rerun_cannot_change_the_preflight_selection(self):
        env, old, trace, caller, source, aws = self.promotion_fixture()
        env.update(FRESH_DIGEST="", IMAGE_BUILD_RUN_ID="123")
        original, _ = self.producer(receipt=build_receipt(context(), old),
                                   run_changes={"run_attempt": 2})
        receipt = build_receipt(context(attempt="2", job_id="790"), DIGEST)
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w") as z:
            z.writestr("web-build.json", json.dumps(receipt))
        data = archive.getvalue()
        def api(path, **kwargs):
            if "/git/ref/" in path:
                return source(path)
            if path.endswith("/artifacts/457/zip"):
                return data
            if path.endswith("/artifacts?per_page=100"):
                first = original(path)["artifacts"][0]
                second = first | {"id": 457, "name": "web-build-123-2", "size_in_bytes": len(data),
                                  "digest": "sha256:" + hashlib.sha256(data).hexdigest()}
                return {"total_count": 2, "artifacts": [first, second]}
            if path.endswith("/attempts/2"):
                return original(path) | {"run_attempt": 2}
            if path.endswith("/jobs/790"):
                return original(f"repos/{REPO}/actions/jobs/789") | {"id": 790, "run_attempt": 2}
            return original(path, **kwargs)
        # Both receipts are valid; the later success is now selected.
        self.assertEqual(resolve_digest(context(run_id="900"), pin_sha=SHA,
                                       producer_run="123", api=api), DIGEST)
        with self.assertRaisesRegex(ImageError, "Validated image digest changed"):
            subject.promote(env, caller=caller, api=api, aws=aws, expected_digest=old)
        self.assertNotIn("put-image", trace)

    def test_cli_surfaces_curated_diagnostics_without_provider_data(self):
        env, _, _, _, _, _ = self.promotion_fixture()
        sentinel = "PRIVATE-provider-account-token"
        for mode, changes, message in (
                ("check-role", {"AWS_ACCOUNT_ID_DEV": ""}, "Explicit development account is required"),
                ("check-role", {"CI_ROLE_ARN": ""}, "Explicit branch release role is required"),
                ("promote", {}, "Image provenance provider request failed")):
            failure = subprocess.CalledProcessError(1, ["aws"], output=sentinel, stderr=sentinel)
            with patch.dict(os.environ, env | changes, clear=True), \
                    patch.object(sys, "argv", ["ci_web_image.py", mode]), \
                    patch("subprocess.run", side_effect=failure), \
                    patch.object(sys, "stderr", new_callable=io.StringIO) as stderr, \
                    self.subTest(mode=mode, changes=changes), self.assertRaises(SystemExit) as exit:
                runpy.run_path(str(Path(subject.__file__)), run_name="__main__")
            self.assertEqual(exit.exception.code, 1)
            self.assertIn(message, stderr.getvalue())
            self.assertNotIn(sentinel, stderr.getvalue())

    def test_cli_distinguishes_source_migration_and_unexpected_provider_shapes(self):
        env, _, _, caller, _, _ = self.promotion_fixture()
        for failure, expected in (("source", "Branch moved"),
                                  ("migration", "Matching-source development migration receipt is required"),
                                  ("provider-shape", "Web image provenance or promotion failed")):
            changes = {"MIGRATED_SHA": ""} if failure == "migration" else {}
            def provider(argv, **kwargs):
                if argv[0] == "aws":
                    body = [] if failure == "provider-shape" else caller()
                else:
                    body = {"object": {"sha": "b" * 40 if failure == "source" else SHA},
                            "private": "PRIVATE-provider-content"}
                return subprocess.CompletedProcess(argv, 0, stdout=json.dumps(body).encode(),
                                                   stderr=b"PRIVATE-provider-stderr")
            with patch.dict(os.environ, env | changes, clear=True), \
                    patch.object(sys, "argv", ["ci_web_image.py", "promote"]), \
                    patch("subprocess.run", side_effect=provider), \
                    patch.object(sys, "stderr", new_callable=io.StringIO) as stderr, \
                    self.subTest(failure=failure), self.assertRaises(SystemExit) as exit:
                runpy.run_path(str(Path(subject.__file__)), run_name="__main__")
            self.assertEqual(exit.exception.code, 1)
            self.assertIn(expected, stderr.getvalue())
            self.assertNotIn("PRIVATE-provider", stderr.getvalue())

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
