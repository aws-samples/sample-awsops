"""Exercise real manifest/deployment checks with only the AWS boundary substituted."""
import copy
import hashlib
import io
import json
import os
import sys
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
import ci_web_deploy as deploy
import ci_web_image as image
from ci_web_image import ImageError

ACCOUNT = "123456789012"
PROJECT = "sample-dev"
C = dict(repository="aws-samples/sample-awsops", branch="dev", sha="a" * 40,
         event="push", run_id="123", attempt="1", project=PROJECT, account=ACCOUNT)
PREFIX = f"arn:aws:ecs:ap-northeast-2:{ACCOUNT}:"
REPO = f"{ACCOUNT}.dkr.ecr.ap-northeast-2.amazonaws.com/{PROJECT}-web"
OLD, NEW = "ecs-svc/100", "ecs-svc/200"
CONFIG = b'{"architecture":"arm64","os":"linux","rootfs":{"type":"layers","diff_ids":[]}}'
RAW = json.dumps({"schemaVersion": 2, "mediaType": "application/vnd.oci.image.manifest.v1+json",
                  "config": {"mediaType": "application/vnd.oci.image.config.v1+json",
                             "digest": "sha256:" + hashlib.sha256(CONFIG).hexdigest(),
                             "size": len(CONFIG)}, "layers": []})
DIGEST = "sha256:" + hashlib.sha256(RAW.encode()).hexdigest()


class AWS:
    def __init__(self):
        self.calls = []
        self.responses = {}
        self.denied = set()
        self.service = {
            "serviceArn": PREFIX + f"service/{PROJECT}/{PROJECT}-web", "serviceName": PROJECT + "-web",
            "clusterArn": PREFIX + "cluster/" + PROJECT, "status": "ACTIVE",
            "taskDefinition": PREFIX + f"task-definition/{PROJECT}-web:7",
            "desiredCount": 1, "runningCount": 1, "pendingCount": 0,
            "deploymentController": {"type": "ECS"},
            "deployments": [{"id": OLD, "status": "PRIMARY", "rolloutState": "COMPLETED",
                             "taskDefinition": PREFIX + f"task-definition/{PROJECT}-web:7",
                             "desiredCount": 1, "runningCount": 1, "pendingCount": 0}],
        }
        self.definition = {
            "taskDefinitionArn": self.service["taskDefinition"], "status": "ACTIVE",
            "runtimePlatform": {"cpuArchitecture": "ARM64", "operatingSystemFamily": "LINUX"},
            "containerDefinitions": [{"name": "web", "essential": True, "image": REPO + ":web-latest"}],
        }
        self.task = {
            "taskArn": PREFIX + f"task/{PROJECT}/" + "1" * 32,
            "clusterArn": self.service["clusterArn"], "group": "service:" + PROJECT + "-web",
            "taskDefinitionArn": self.service["taskDefinition"], "startedBy": OLD,
            "lastStatus": "RUNNING", "desiredStatus": "RUNNING", "healthStatus": "HEALTHY",
            "containers": [{"name": "web", "image": REPO + ":web-latest", "imageDigest": DIGEST,
                            "lastStatus": "RUNNING", "healthStatus": "HEALTHY"}],
        }
        self.candidate = copy.deepcopy(self.task)
        self.config = CONFIG
        self.image = {"registryId": ACCOUNT, "repositoryName": PROJECT + "-web",
                      "imageId": {"imageDigest": DIGEST}, "imageManifest": RAW,
                      "imageManifestMediaType": "application/vnd.oci.image.manifest.v1+json"}

    def __call__(self, service, operation, args):
        self.calls.append((service, operation, args))
        if operation in self.denied:
            raise ImageError("Image provenance provider request failed")
        if self.responses.get(operation):
            return copy.deepcopy(self.responses[operation].pop(0))
        if operation == "batch-get-image":
            image = copy.deepcopy(self.image)
            selection = args[args.index("--image-ids") + 1]
            if selection.startswith("imageTag="):
                image["imageId"]["imageTag"] = selection.removeprefix("imageTag=")
            return {"images": [image], "failures": []}
        if operation == "get-download-url-for-layer":
            return {"layerDigest": "sha256:" + hashlib.sha256(self.config).hexdigest(),
                    "downloadUrl": "https://fixture.s3.ap-northeast-2.amazonaws.com/config"}
        if operation == "put-image":
            manifest = args[args.index("--image-manifest") + 1]
            self.published_manifest = Path(manifest.removeprefix("file://")).read_text()
            image = copy.deepcopy(self.image)
            image["imageId"]["imageTag"] = "web-latest"
            return {"image": image}
        if operation == "describe-services":
            return {"services": [copy.deepcopy(self.service)], "failures": []}
        if operation == "describe-task-definition":
            return {"taskDefinition": copy.deepcopy(self.definition)}
        if operation == "update-service":
            self.service.update(runningCount=1, pendingCount=0)
            self.service["deployments"][0].update(id=NEW, rolloutState="COMPLETED",
                                                   runningCount=1, pendingCount=0)
            self.task = copy.deepcopy(self.candidate)
            self.task["startedBy"] = NEW
            return {"service": copy.deepcopy(self.service)}
        if operation == "list-tasks":
            return {"taskArns": [self.task["taskArn"]] if self.task else []}
        if operation == "describe-tasks":
            requested = args[args.index("--tasks") + 1:]
            if self.task is None:
                return {"tasks": [], "failures": [{"arn": arn, "reason": "MISSING"} for arn in requested]}
            return {"tasks": [copy.deepcopy(self.task)], "failures": []}
        raise AssertionError("unexpected operation: " + operation)


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.aws = AWS()
        self.tick = 0
        def download(argv, **kwargs):
            self.assertEqual(argv[0], "curl", "Unexpected provider boundary")
            return self.aws.config
        boundary = patch.object(image, "command", side_effect=download)
        boundary.start()
        self.addCleanup(boundary.stop)

    def sleep(self, seconds):
        self.tick += seconds

    def verify(self, proof, timeout=30):
        return deploy.verify(C, proof, self.aws, timeout=timeout,
                             now=lambda: self.tick, sleep=self.sleep)

    def proof(self):
        return deploy.start(C, DIGEST, DIGEST, self.aws)

    def release_env(self):
        return {
            "GITHUB_REPOSITORY": C["repository"], "GITHUB_REF_NAME": "dev",
            "GITHUB_REF": "refs/heads/dev", "GITHUB_EVENT_NAME": "push",
            "GITHUB_WORKFLOW_REF": C["repository"] + "/.github/workflows/deploy-web.yml@refs/heads/dev",
            "GITHUB_SHA": C["sha"], "GITHUB_RUN_ID": C["run_id"], "GITHUB_RUN_ATTEMPT": "1",
            "CI_ROLE_ARN": f"arn:aws:iam::{ACCOUNT}:role/CI", "AWS_ACCOUNT_ID_DEV": ACCOUNT,
            "IMAGE_PROJECT": PROJECT, "ECR_URI": REPO, "ECS_CLUSTER": PROJECT,
            "ECS_SERVICE": PROJECT + "-web", "PREFLIGHT_DIGEST": DIGEST,
            "FRESH_DIGEST": DIGEST, "FRESH_PROJECT": PROJECT,
            "MIGRATED_SHA": C["sha"], "MIGRATED_PROJECT": PROJECT,
        }

    def run_main_with_providers(self, mode="deploy", changes=None, identity_accounts=None):
        identities = iter(identity_accounts or [ACCOUNT, ACCOUNT])
        def provider(argv, **kwargs):
            if argv[0] == "curl":
                return self.aws.config
            if argv[:3] == ["aws", "sts", "get-caller-identity"]:
                account = next(identities)
                return {"Account": account, "Arn": f"arn:aws:sts::{account}:assumed-role/CI/session"}
            if argv[:4] == ["gh", "api", "--hostname", "github.com"]:
                self.assertEqual(argv[4], f"repos/{C['repository']}/git/ref/heads/dev")
                return {"object": {"sha": C["sha"]}}
            self.assertEqual(argv[0], "aws")
            return self.aws(argv[1], argv[2], argv[3:])
        def reader(service, operation, options):
            args = [part for key, value in options.items()
                    for part in ["--" + key, *(value if isinstance(value, list) else [value])]]
            return provider(["aws", service, operation, *args])
        with tempfile.TemporaryDirectory() as folder, \
                patch.dict(os.environ, self.release_env() | (changes or {}) |
                           {"GITHUB_OUTPUT": str(Path(folder) / "output")}, clear=True), \
                patch.object(sys, "argv", ["ci_web_deploy.py", mode]), \
                patch.object(sys, "stdout", new_callable=io.StringIO) as stdout, \
                patch.object(image, "command", side_effect=provider), \
                patch.object(deploy, "command", side_effect=provider), \
                patch.object(deploy, "read_request", side_effect=reader):
            deploy.main()
            proof = dict(line.split("=", 1) for line in (Path(folder) / "output").read_text().splitlines())
            return proof, stdout.getvalue()

    def test_deploy_revalidates_caller_after_snapshot_before_publication(self):
        with self.assertRaisesRegex(ImageError, "Actual branch account/role mismatch"):
            self.run_main_with_providers(identity_accounts=[ACCOUNT, "999999999999"])
        reads = {op for _, op, _ in self.aws.calls}
        self.assertTrue({"describe-task-definition", "list-tasks", "describe-tasks"} <= reads)
        self.assertFalse(reads & {"put-image", "update-service"})

    def test_promotion_cannot_reselect_digest_after_controller_validation(self):
        # The controller keeps its imported resolver; only promotion's later
        # producer lookup selects another digest, as a changed receipt could.
        with patch.object(image, "resolve_digest", return_value="sha256:" + "f" * 64), \
                self.assertRaisesRegex(ImageError, "Validated image digest changed"):
            self.run_main_with_providers()
        reads = {op for _, op, _ in self.aws.calls}
        self.assertIn("describe-tasks", reads)
        self.assertFalse(reads & {"put-image", "update-service"})

    def test_guarded_deploy_publishes_validated_project_digest_and_exact_rollout(self):
        proof, summary = self.run_main_with_providers()
        self.assertEqual(json.loads(summary)["digest"], DIGEST)
        self.assertEqual(proof["deployment_id"], NEW)
        self.assertEqual(proof["digest"], DIGEST)
        self.verify(proof)
        writes = [(op, args) for _, op, args in self.aws.calls if op in {"put-image", "update-service"}]
        self.assertEqual([op for op, _ in writes], ["put-image", "update-service"])
        args = writes[0][1]
        self.assertEqual(args[args.index("--repository-name") + 1], PROJECT + "-web")
        self.assertTrue(args[args.index("--image-manifest") + 1].startswith("file://"))
        self.assertEqual(self.aws.published_manifest, RAW)

    def test_preflight_still_validates_image_without_migration_or_publication(self):
        proof, _ = self.run_main_with_providers("preflight-image",
            {"MIGRATED_SHA": "", "MIGRATED_PROJECT": "", "PREFLIGHT_DIGEST": ""})
        self.assertEqual(proof, {"digest": DIGEST, "runtime_digest": DIGEST})
        self.assertEqual([op for _, op, _ in self.aws.calls],
                         ["batch-get-image", "get-download-url-for-layer", "batch-get-image"])

    def test_preflight_rejects_wrong_actual_platform_before_ddl_or_publication(self):
        self.aws.config = CONFIG.replace(b"arm64", b"amd64")
        body = json.loads(RAW)
        body["config"]["digest"] = "sha256:" + hashlib.sha256(self.aws.config).hexdigest()
        raw = json.dumps(body)
        digest = "sha256:" + hashlib.sha256(raw.encode()).hexdigest()
        self.aws.image.update(imageManifest=raw, imageId={"imageDigest": digest})
        with self.assertRaisesRegex(ImageError, "must run linux/arm64"):
            self.run_main_with_providers("preflight-image",
                {"FRESH_DIGEST": digest, "PREFLIGHT_DIGEST": "", "MIGRATED_SHA": "", "MIGRATED_PROJECT": ""})
        self.assertFalse(any(op in {"put-image", "update-service"} for _, op, _ in self.aws.calls))

    def test_preflight_requires_fresh_source_tag_identity_before_ddl(self):
        wrong = copy.deepcopy(self.aws.image)
        wrong["imageId"] = {"imageDigest": "sha256:" + "f" * 64, "imageTag": "web-" + C["sha"]}
        self.aws.responses["batch-get-image"] = [{"images": [self.aws.image]}, {"images": [wrong]}]
        with self.assertRaisesRegex(ImageError, "registry, repository or digest mismatch"):
            self.run_main_with_providers("preflight-image")
        self.assertFalse(any(op in {"put-image", "update-service"} for _, op, _ in self.aws.calls))

    def test_index_preflight_retains_root_and_arm64_digest_for_exact_verification(self):
        child = copy.deepcopy(self.aws.image)
        raw = json.dumps({"schemaVersion": 2, "mediaType": "application/vnd.oci.image.index.v1+json",
            "manifests": [{"mediaType": child["imageManifestMediaType"], "digest": DIGEST,
                          "size": len(RAW.encode()), "platform": {"os": "linux", "architecture": "arm64"}}]})
        root = "sha256:" + hashlib.sha256(raw.encode()).hexdigest()
        self.aws.image.update(imageManifest=raw, imageId={"imageDigest": root},
                              imageManifestMediaType="application/vnd.oci.image.index.v1+json")
        self.aws.responses["batch-get-image"] = [{"images": [self.aws.image]}, {"images": [child]}]
        actual = deploy.runtime_digest(C, root, self.aws)
        self.assertEqual(actual, DIGEST)
        proof = deploy.start(C, root, actual, self.aws)
        self.verify(proof)
        self.assertEqual((proof["digest"], proof["runtime_digest"]), (root, DIGEST))

    def test_preflight_migration_and_project_mismatches_never_publish(self):
        for changes in ({"PREFLIGHT_DIGEST": "sha256:" + "f" * 64},
                        {"MIGRATED_SHA": "b" * 40}, {"MIGRATED_PROJECT": "other"},
                        {"IMAGE_PROJECT": "other"}, {"FRESH_PROJECT": "other"}):
            self.setUp()
            with self.subTest(changes=changes), self.assertRaises(ImageError):
                self.run_main_with_providers(changes=changes)
            self.assertFalse(any(op in {"put-image", "update-service"} for _, op, _ in self.aws.calls))

    def test_valid_inflight_read_result_is_retained_after_poll_deadline(self):
        def read():
            self.tick += 2
            return NEW
        self.assertEqual(deploy.wait_for(read, 1, lambda: self.tick, self.sleep), NEW)

    def test_terraform_metadata_must_match_the_selected_account_and_project(self):
        values = {"ECR_URI": REPO, "ECS_CLUSTER": PROJECT, "ECS_SERVICE": PROJECT + "-web"}
        deploy.validate_target(C, values)
        for changes in [{"ECR_URI": REPO.replace(ACCOUNT, "999999999999")},
                        {"ECS_CLUSTER": "other"}, {"ECS_SERVICE": "other-web"}, {"ECR_URI": ""}]:
            with self.subTest(changes=changes), self.assertRaises(ImageError):
                deploy.validate_target(C, values | changes)

    def test_exact_deployment_and_healthy_digest_pass(self):
        proof = self.proof()
        self.assertEqual(proof["deployment_id"], NEW)
        self.verify(proof)
        self.assertTrue(any(op == "describe-tasks" for _, op, _ in self.aws.calls))
        listed = next(args for _, op, args in self.aws.calls if op == "list-tasks")
        self.assertIn("--cli-input-json", listed)
        self.assertIn("--no-paginate", listed)
        self.assertNotIn("--max-results", listed)

    def test_persistent_rollback_wrong_image_old_task_or_unhealthy_candidate_fails(self):
        for target, field, value in [
            ("primary", "id", OLD), ("primary", "rolloutState", "IN_PROGRESS"),
            ("web", "imageDigest", "sha256:" + "f" * 64),
            ("web", "healthStatus", "UNKNOWN"), ("task", "startedBy", OLD),
        ]:
            self.setUp()
            proof = self.proof()
            targets = {"primary": self.aws.service["deployments"][0],
                       "web": self.aws.task["containers"][0], "task": self.aws.task}
            targets[target][field] = value
            with self.subTest(target=target, field=field), self.assertRaises(ImageError):
                self.verify(proof)
            self.assertEqual(self.tick, 15 if target == "primary" and field == "id" else 30)

    def test_terminal_deployment_failure_or_replacement_fails_without_polling(self):
        for reason in ("failed", "replacement", "rollback"):
            self.setUp()
            proof = self.proof()
            primary = self.aws.service["deployments"][0]
            if reason == "failed":
                primary["rolloutState"] = "FAILED"
            elif reason == "replacement":
                primary["id"] = "ecs-svc/999"
            else:
                failed = copy.deepcopy(primary)
                failed.update(status="ACTIVE", rolloutState="FAILED")
                primary["id"] = OLD
                self.aws.service["deployments"].append(failed)
            with self.subTest(reason=reason), self.assertRaisesRegex(ImageError, "(?i)failed|replaced|rolled back"):
                self.verify(proof)
            self.assertEqual(self.tick, 0)

    def test_prior_deployment_grace_requires_a_distinct_valid_identity(self):
        proof = self.proof()
        for old_id in (NEW, "other", 1, [], {}):
            with self.subTest(old_id=old_id), self.assertRaisesRegex(ImageError, "prior deployment"):
                self.verify(proof | {"old_deployment_id": old_id})
            self.assertEqual(self.tick, 0)

    def test_missing_rollout_state_can_converge_but_missing_identity_is_fatal(self):
        proof = self.proof()
        stale = copy.deepcopy(self.aws.service)
        stale["deployments"][0].pop("rolloutState")
        self.aws.responses["describe-services"] = [{"services": [stale], "failures": []}]
        self.verify(proof)
        self.assertEqual(self.tick, 5)
        self.aws.service["deployments"].append({"status": "ACTIVE"})
        with self.assertRaisesRegex(ImageError, "deployment identity"):
            self.verify(proof)
        self.assertEqual(self.tick, 5)

    def test_transient_post_update_and_final_tag_reads_retry_without_another_write(self):
        proof = self.proof()
        failures = {"describe-services": 1, "batch-get-image": 1}
        def aws(service, operation, args):
            if failures.get(operation):
                failures[operation] -= 1
                raise deploy.TransientReadError("Transient AWS read failure")
            return self.aws(service, operation, args)
        deploy.verify(C, proof, aws, timeout=30, now=lambda: self.tick, sleep=self.sleep)
        self.assertEqual(self.tick, 10)
        self.assertEqual(sum(op == "update-service" for _, op, _ in self.aws.calls), 1)

    def test_permission_failure_in_poll_is_not_retried(self):
        proof = self.proof()
        def aws(service, operation, args):
            raise ImageError("AWS read permission denied")
        with self.assertRaisesRegex(ImageError, "permission denied"):
            deploy.verify(C, proof, aws, timeout=30, now=lambda: self.tick, sleep=self.sleep)
        self.assertEqual(self.tick, 0)

    def test_read_adapter_and_write_route_are_separate(self):
        request = {"cluster": PROJECT, "serviceName": PROJECT + "-web",
                   "desiredStatus": "RUNNING", "maxResults": 100}
        with patch.object(deploy, "read_request", return_value={}) as read, \
                patch.object(deploy, "command", return_value={}) as write:
            deploy.aws_request("ecs", "list-tasks",
                               ["--cli-input-json", json.dumps(request), "--no-paginate"])
            read.assert_called_once_with("ecs", "list-tasks", {
                "cluster": PROJECT, "service-name": PROJECT + "-web",
                "desired-status": "RUNNING", "max-results": "100"})
            write.assert_not_called()
            read.reset_mock()
            deploy.aws_request("ecs", "update-service", ["--cluster", PROJECT])
            read.assert_not_called()
            write.assert_called_once()

    def test_changed_latest_tag_cannot_bless_future_task_churn(self):
        proof = self.proof()
        self.aws.image["imageId"]["imageDigest"] = "sha256:" + "f" * 64
        with self.assertRaisesRegex(ImageError, "promoted image"):
            self.verify(proof)

    def test_foreign_service_or_task_definition_rejected_before_update(self):
        for change in ["service", "architecture"]:
            self.setUp()
            if change == "service":
                self.aws.service["serviceArn"] = PREFIX + "service/other/other-web"
            else:
                self.aws.definition["runtimePlatform"]["cpuArchitecture"] = "X86_64"
            with self.subTest(change=change), self.assertRaises(ImageError):
                self.proof()
            self.assertFalse(any(op == "update-service" for _, op, _ in self.aws.calls))

    def test_wrong_ecr_account_or_changed_content_rejected(self):
        for key, value in [("registryId", "999999999999"), ("imageManifest", "{}")]:
            self.setUp()
            self.aws.image[key] = value
            with self.subTest(key=key), self.assertRaises(ImageError):
                deploy.runtime_digest(C, DIGEST, self.aws)

    def test_paused_service_is_never_reactivated(self):
        self.aws.service.update(desiredCount=0, runningCount=0, pendingCount=0)
        self.aws.service["deployments"][0].update(desiredCount=0, runningCount=0, pendingCount=0)
        self.aws.task = None
        with self.assertRaises(ImageError):
            self.proof()
        self.assertFalse(any(op == "update-service" for _, op, _ in self.aws.calls))

    def test_update_response_old_primary_is_retried_without_another_update(self):
        old = copy.deepcopy(self.aws.service)
        def aws(service, operation, args):
            result = self.aws(service, operation, args)
            return {"service": old} if operation == "update-service" else result
        proof = deploy.start(C, DIGEST, DIGEST, aws, timeout=30,
                             now=lambda: self.tick, sleep=self.sleep)
        self.assertEqual(proof["deployment_id"], NEW)
        self.assertEqual(sum(op == "update-service" for _, op, _ in self.aws.calls), 1)

    def test_missing_update_projection_is_confirmed_by_reads(self):
        def aws(service, operation, args):
            result = self.aws(service, operation, args)
            return {} if operation == "update-service" else result
        proof = deploy.start(C, DIGEST, DIGEST, aws, timeout=30,
                             now=lambda: self.tick, sleep=self.sleep)
        self.assertEqual(proof["deployment_id"], NEW)
        self.assertEqual(sum(op == "update-service" for _, op, _ in self.aws.calls), 1)

    def test_persistent_old_primary_after_update_never_produces_receipt(self):
        old = copy.deepcopy(self.aws.service)
        def aws(service, operation, args):
            result = self.aws(service, operation, args)
            if operation == "update-service":
                self.aws.service = copy.deepcopy(old)
                self.aws.task["startedBy"] = OLD
                return {"service": old}
            return result
        with self.assertRaisesRegex(ImageError, "(?i)deployment.*timeout"):
            deploy.start(C, DIGEST, DIGEST, aws, timeout=12,
                         now=lambda: self.tick, sleep=self.sleep)
        self.assertEqual(self.tick, 12)
        self.assertEqual(sum(op == "update-service" for _, op, _ in self.aws.calls), 1)

    def test_stale_primary_counts_task_set_digest_and_health_can_converge(self):
        for change in ("primary", "counts", "empty", "missing", "deployment", "digest", "health"):
            self.setUp()
            proof = self.proof()
            operation = "describe-tasks"
            result = {"tasks": [copy.deepcopy(self.aws.task)], "failures": []}
            if change in ("primary", "counts"):
                operation = "describe-services"
                result = {"services": [copy.deepcopy(self.aws.service)], "failures": []}
                if change == "primary":
                    result["services"][0]["deployments"][0]["id"] = OLD
                else:
                    result["services"][0]["pendingCount"] = 1
            elif change == "empty":
                operation, result = "list-tasks", {"taskArns": []}
            elif change == "missing":
                result = {"tasks": [], "failures": [{"arn": self.aws.task["taskArn"], "reason": "MISSING"}]}
            else:
                task = result["tasks"][0]
                if change == "deployment":
                    task["startedBy"] = OLD
                else:
                    task["containers"][0]["imageDigest" if change == "digest" else "healthStatus"] = (
                        "sha256:" + "f" * 64 if change == "digest" else "UNKNOWN")
            self.aws.responses[operation] = [result]
            with self.subTest(change=change):
                self.verify(proof)
                self.assertGreater(self.tick, 0)

    def test_read_permission_denial_is_fatal_without_waiting(self):
        proof = self.proof()
        self.aws.denied.add("describe-tasks")
        with self.assertRaises(ImageError):
            self.verify(proof)
        self.assertEqual(self.tick, 0)

    def test_foreign_task_identity_is_fatal_without_waiting(self):
        proof = self.proof()
        self.aws.task["clusterArn"] = PREFIX + "cluster/other"
        with self.assertRaises(ImageError):
            self.verify(proof)
        self.assertEqual(self.tick, 0)

    def test_main_probes_all_verification_reads_before_any_pin_or_update(self):
        env = {
            "GITHUB_REPOSITORY": C["repository"], "GITHUB_REF_NAME": "dev",
            "GITHUB_REF": "refs/heads/dev", "GITHUB_EVENT_NAME": "push",
            "GITHUB_WORKFLOW_REF": C["repository"] + "/.github/workflows/deploy-web.yml@refs/heads/dev",
            "GITHUB_SHA": C["sha"], "GITHUB_RUN_ID": C["run_id"], "GITHUB_RUN_ATTEMPT": "1",
            "CI_ROLE_ARN": f"arn:aws:iam::{ACCOUNT}:role/CI", "AWS_ACCOUNT_ID_DEV": ACCOUNT,
            "IMAGE_PROJECT": PROJECT, "ECR_URI": REPO, "ECS_CLUSTER": PROJECT,
            "ECS_SERVICE": PROJECT + "-web", "PREFLIGHT_DIGEST": DIGEST,
        }
        reads = {"batch-get-image", "get-download-url-for-layer", "describe-task-definition", "list-tasks", "describe-tasks"}
        for denied in [None, *sorted(reads), "output", "changed-proof"]:
            self.setUp()
            if denied:
                self.aws.denied.add(denied)
            if denied == "describe-tasks":
                self.aws.task = None
                self.aws.service["deployments"][0]["rolloutState"] = "FAILED"
            def promotion(env, *, expected_digest):
                self.assertEqual(expected_digest, DIGEST)
                self.assertEqual(env["IMAGE_PROJECT"], PROJECT)
                observed = {op for _, op, _ in self.aws.calls}
                self.assertTrue(reads <= observed)
                self.aws.calls.append(("ecr", "put-image", []))
            with self.subTest(denied=denied), tempfile.TemporaryDirectory() as folder, \
                    patch.dict(os.environ, env | {
                        "GITHUB_OUTPUT": folder if denied == "output" else str(Path(folder) / "output"),
                        "PREFLIGHT_DIGEST": "sha256:" + "f" * 64 if denied == "changed-proof" else DIGEST,
                    }, clear=True), \
                    patch.object(sys, "argv", ["ci_web_deploy.py", "deploy"]), \
                    patch.object(deploy, "aws_request", self.aws), \
                    patch.object(deploy, "command", side_effect=AssertionError("Unexpected real AWS boundary")), \
                    patch.object(deploy, "verify_caller", return_value=ACCOUNT), \
                    patch.object(deploy, "verify_source_and_migration", return_value=False), \
                    patch.object(deploy, "resolve_digest", return_value=DIGEST), \
                    patch.object(deploy, "promote", side_effect=promotion):
                if denied:
                    with self.assertRaises((ImageError, OSError)):
                        deploy.main()
                    self.assertFalse(any(op in {"put-image", "update-service"} for _, op, _ in self.aws.calls))
                    self.assertEqual(self.tick, 0)
                    if denied == "describe-tasks":
                        self.assertTrue(any(op == denied for _, op, _ in self.aws.calls))
                else:
                    deploy.main()
                    operations = [op for _, op, _ in self.aws.calls]
                    self.assertLess(operations.index("put-image"), operations.index("update-service"))

    def test_output_is_opened_and_validated_before_mutation(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "output"
            link = Path(folder) / "link"
            target.touch()
            link.symlink_to(target)
            for path in ("", "relative", folder, str(link), str(Path(folder) / "absent" / "output")):
                with self.subTest(path=path), self.assertRaises((ImageError, OSError)):
                    with deploy.open_workflow_output({"GITHUB_OUTPUT": path}):
                        self.fail("Invalid output must be rejected before deployment")
            with deploy.open_workflow_output({"GITHUB_OUTPUT": str(target)}) as output:
                output.write("digest=verified\n")
            self.assertEqual(target.read_text(), "digest=verified\n")

    def test_rollforward_and_explicit_rollback_recover_without_repeating_mutations(self):
        source_check = deploy.verify_source_and_migration
        wait = deploy.wait_for
        for rollback, no_tasks in ((False, False), (False, True), (True, False), (True, True)):
            with self.subTest(rollback=rollback, no_tasks=no_tasks):
                self.setUp()
                self.aws.service.update(runningCount=0 if no_tasks else 1, pendingCount=1)
                self.aws.service["deployments"][0].update(
                    rolloutState="FAILED", runningCount=0 if no_tasks else 1, pendingCount=0)
                self.aws.task["healthStatus"] = "UNHEALTHY"
                self.aws.task["containers"][0]["imageDigest"] = "sha256:" + "f" * 64
                if no_tasks:
                    self.aws.task = None
                pin_sha = "b" * 40 if rollback else C["sha"]
                env = {
                    "GITHUB_REPOSITORY": C["repository"], "GITHUB_REF_NAME": "dev",
                    "GITHUB_REF": "refs/heads/dev", "GITHUB_EVENT_NAME": "workflow_dispatch",
                    "GITHUB_WORKFLOW_REF": C["repository"] + "/.github/workflows/deploy-web.yml@refs/heads/dev",
                    "GITHUB_SHA": C["sha"], "GITHUB_RUN_ID": C["run_id"], "GITHUB_RUN_ATTEMPT": "1",
                    "CI_ROLE_ARN": f"arn:aws:iam::{ACCOUNT}:role/CI", "AWS_ACCOUNT_ID_DEV": ACCOUNT,
                    "IMAGE_PROJECT": PROJECT, "ECR_URI": REPO, "ECS_CLUSTER": PROJECT,
                    "ECS_SERVICE": PROJECT + "-web", "PIN_SHA": pin_sha, "PREFLIGHT_DIGEST": DIGEST,
                    "ROLLBACK_SCHEMA_COMPATIBLE": "true" if rollback else "",
                    "MIGRATED_SHA": "" if rollback else C["sha"],
                    "MIGRATED_PROJECT": "" if rollback else PROJECT,
                }
                def api(path):
                    if "/compare/" in path:
                        self.assertTrue(rollback)
                        return {"status": "ahead", "merge_base_commit": {"sha": pin_sha}}
                    return {"object": {"sha": C["sha"]}}
                def promotion(env, *, expected_digest):
                    self.assertEqual(expected_digest, DIGEST)
                    self.assertEqual(env["IMAGE_PROJECT"], PROJECT)
                    self.aws.calls.append(("ecr", "put-image", []))
                with tempfile.TemporaryDirectory() as folder, \
                        patch.dict(os.environ, env | {"GITHUB_OUTPUT": str(Path(folder) / "output")}, clear=True), \
                        patch.object(sys, "argv", ["ci_web_deploy.py", "deploy"]), \
                        patch.object(sys, "stdout", new_callable=io.StringIO) as stdout, \
                        patch.object(deploy, "aws_request", self.aws), \
                        patch.object(deploy, "command", side_effect=AssertionError("Unexpected live AWS")), \
                        patch.object(deploy, "verify_caller", return_value=ACCOUNT), \
                        patch.object(deploy, "verify_source_and_migration",
                                     side_effect=lambda c, sha, e: source_check(c, sha, e, api)), \
                        patch.object(deploy, "resolve_digest", return_value=DIGEST), \
                        patch.object(deploy, "promote", side_effect=promotion), \
                        patch.object(deploy, "wait_for",
                                     side_effect=lambda check, timeout, now, sleep: wait(check, timeout, lambda: self.tick, self.sleep)):
                    deploy.main()
                    summary = json.loads(stdout.getvalue())
                    self.assertEqual(summary["rollback"], rollback)
                    self.assertEqual(summary["migration"], "not_run_for_rollback" if rollback else "source_verified")
                    proof = dict(line.split("=", 1) for line in (Path(folder) / "output").read_text().splitlines())
                self.verify(proof)
                self.assertEqual(self.tick, 0, "Old pending/failed health is advisory")
                if no_tasks:
                    probe = next(args for _, op, args in self.aws.calls if op == "describe-tasks")
                    self.assertRegex(probe[probe.index("--tasks") + 1],
                                     "^" + PREFIX + "task/" + PROJECT + "/[a-f0-9]{32}$")
                writes = [op for _, op, _ in self.aws.calls if op in ("put-image", "update-service")]
                self.assertEqual(writes, ["put-image", "update-service"])
                self.aws.task["containers"][0]["imageDigest"] = "sha256:" + "f" * 64
                with self.assertRaises(ImageError):
                    self.verify(proof, timeout=5)
                self.assertEqual([op for _, op, _ in self.aws.calls if op in writes], writes)

    def test_image_preflight_needs_no_migration_receipt_and_cannot_mutate(self):
        env = {"GITHUB_REPOSITORY": C["repository"], "GITHUB_REF_NAME": "dev",
               "GITHUB_REF": "refs/heads/dev", "GITHUB_EVENT_NAME": "workflow_dispatch",
               "GITHUB_WORKFLOW_REF": C["repository"] + "/.github/workflows/deploy-web.yml@refs/heads/dev",
               "GITHUB_SHA": C["sha"], "GITHUB_RUN_ID": C["run_id"], "GITHUB_RUN_ATTEMPT": "1",
               "CI_ROLE_ARN": f"arn:aws:iam::{ACCOUNT}:role/CI", "AWS_ACCOUNT_ID_DEV": ACCOUNT,
               "IMAGE_PROJECT": PROJECT, "IMAGE_BUILD_RUN_ID": "111"}
        for invalid in (False, "receipt", "ecr"):
            self.setUp()
            if invalid == "ecr":
                self.aws.denied.add("batch-get-image")
            with self.subTest(invalid=invalid), tempfile.TemporaryDirectory() as folder, \
                    patch.dict(os.environ, env | {"GITHUB_OUTPUT": str(Path(folder) / "output")}, clear=True), \
                    patch.object(sys, "argv", ["ci_web_deploy.py", "preflight-image"]), \
                    patch.object(deploy, "command", side_effect=AssertionError("Unexpected live AWS")), \
                    patch.object(deploy, "aws_request", self.aws), \
                    patch.object(deploy, "verify_caller", return_value=ACCOUNT), \
                    patch.object(deploy, "resolve_digest", side_effect=ImageError("expired") if invalid == "receipt" else None,
                                 return_value=DIGEST), \
                    patch.object(deploy, "promote", side_effect=AssertionError("Preflight mutation")):
                if invalid:
                    with self.assertRaises(ImageError):
                        deploy.main()
                else:
                    deploy.main()
                    self.assertIn("digest=" + DIGEST, (Path(folder) / "output").read_text())
                self.assertFalse(any(op == "update-service" for _, op, _ in self.aws.calls))


if __name__ == "__main__":
    unittest.main()
