"""Exercise real manifest/deployment checks with only the AWS boundary substituted."""
import copy
import hashlib
import json
import os
import sys
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
import ci_web_deploy as deploy
from ci_web_image import ImageError

ACCOUNT = "123456789012"
PROJECT = "sample-dev"
C = dict(repository="aws-samples/sample-awsops", branch="dev", sha="a" * 40,
         event="push", run_id="123", attempt="1", project=PROJECT, account=ACCOUNT)
PREFIX = f"arn:aws:ecs:ap-northeast-2:{ACCOUNT}:"
REPO = f"{ACCOUNT}.dkr.ecr.ap-northeast-2.amazonaws.com/{PROJECT}-web"
OLD, NEW = "ecs-svc/100", "ecs-svc/200"
RAW = json.dumps({"schemaVersion": 2, "mediaType": "application/vnd.oci.image.manifest.v1+json",
                  "config": {"digest": "sha256:" + "c" * 64}, "layers": []})
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
        self.image = {"registryId": ACCOUNT, "repositoryName": PROJECT + "-web",
                      "imageId": {"imageDigest": DIGEST}, "imageManifest": RAW}

    def __call__(self, service, operation, args):
        self.calls.append((service, operation, args))
        if operation in self.denied:
            raise ImageError("Image provenance provider request failed")
        if self.responses.get(operation):
            return copy.deepcopy(self.responses[operation].pop(0))
        if operation == "batch-get-image":
            return {"images": [copy.deepcopy(self.image)], "failures": []}
        if operation == "describe-services":
            return {"services": [copy.deepcopy(self.service)], "failures": []}
        if operation == "describe-task-definition":
            return {"taskDefinition": copy.deepcopy(self.definition)}
        if operation == "update-service":
            self.service["deployments"][0]["id"] = NEW
            self.task["startedBy"] = NEW
            return {"service": copy.deepcopy(self.service)}
        if operation == "list-tasks":
            return {"taskArns": [self.task["taskArn"]]}
        if operation == "describe-tasks":
            return {"tasks": [copy.deepcopy(self.task)], "failures": []}
        raise AssertionError("unexpected operation: " + operation)


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.aws = AWS()
        self.tick = 0

    def sleep(self, seconds):
        self.tick += seconds

    def verify(self, proof, timeout=30):
        return deploy.verify(C, proof, self.aws, timeout=timeout,
                             now=lambda: self.tick, sleep=self.sleep)

    def proof(self):
        return deploy.start(C, DIGEST, DIGEST, self.aws)

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

    def test_rollback_cannot_pass_just_because_service_is_stable(self):
        proof = self.proof()
        self.aws.service["deployments"][0]["id"] = OLD
        with self.assertRaisesRegex(ImageError, "rolled back"):
            self.verify(proof)
        self.assertEqual(self.tick, 30)

    def test_wrong_running_image_or_unhealthy_task_fails(self):
        for field, value in [("imageDigest", "sha256:" + "f" * 64), ("healthStatus", "UNKNOWN")]:
            self.setUp()
            proof = self.proof()
            self.aws.task["containers"][0][field] = value
            with self.subTest(field=field), self.assertRaises(ImageError):
                self.verify(proof)
            self.assertEqual(self.tick, 30)

    def test_old_deployment_task_cannot_satisfy_new_deployment(self):
        proof = self.proof()
        self.aws.task["startedBy"] = OLD
        with self.assertRaises(ImageError):
            self.verify(proof)

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

    def test_pending_deployment_has_a_bounded_wait(self):
        proof = self.proof()
        self.aws.service["deployments"][0]["rolloutState"] = "IN_PROGRESS"
        tick = [0]
        def sleep(seconds):
            tick[0] += seconds
        with self.assertRaisesRegex(ImageError, "timeout"):
            deploy.verify(C, proof, self.aws, timeout=2, now=lambda: tick[0], sleep=sleep)

    def test_snapshot_retries_transient_task_replacement_before_any_update(self):
        changing = copy.deepcopy(self.aws.service)
        changing.update(runningCount=0, pendingCount=1)
        self.aws.responses["describe-services"] = [{"services": [changing], "failures": []}]
        before = deploy.snapshot(C, self.aws, timeout=30, now=lambda: self.tick, sleep=self.sleep)
        self.assertEqual(before["old_deployment_id"], OLD)
        self.assertGreater(self.tick, 0)
        self.assertFalse(any(op == "update-service" for _, op, _ in self.aws.calls))

    def test_permanently_unstable_snapshot_times_out_without_mutation(self):
        self.aws.service["pendingCount"] = 1
        with self.assertRaisesRegex(ImageError, "stable.*timeout"):
            deploy.snapshot(C, self.aws, timeout=12, now=lambda: self.tick, sleep=self.sleep)
        self.assertEqual(self.tick, 12)
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

    def test_persistent_old_primary_after_update_never_produces_receipt(self):
        old = copy.deepcopy(self.aws.service)
        def aws(service, operation, args):
            result = self.aws(service, operation, args)
            if operation == "update-service":
                self.aws.service = copy.deepcopy(old)
                self.aws.task["startedBy"] = OLD
                return {"service": old}
            return result
        with self.assertRaisesRegex(ImageError, "deployment.*timeout"):
            deploy.start(C, DIGEST, DIGEST, aws, timeout=12,
                         now=lambda: self.tick, sleep=self.sleep)
        self.assertEqual(self.tick, 12)
        self.assertEqual(sum(op == "update-service" for _, op, _ in self.aws.calls), 1)

    def test_verify_retries_old_primary_observation_after_update(self):
        old = copy.deepcopy(self.aws.service)
        proof = self.proof()
        self.aws.responses["describe-services"] = [{"services": [old], "failures": []}]
        self.verify(proof)
        self.assertGreater(self.tick, 0)

    def test_completed_service_can_have_temporarily_unsettled_counts(self):
        proof = self.proof()
        changing = copy.deepcopy(self.aws.service)
        changing["pendingCount"] = 1
        self.aws.responses["describe-services"] = [{"services": [changing], "failures": []}]
        self.verify(proof)
        self.assertGreater(self.tick, 0)

    def test_post_completed_task_listing_can_be_initially_empty(self):
        proof = self.proof()
        self.aws.responses["list-tasks"] = [{"taskArns": []}]
        self.verify(proof)
        self.assertGreater(self.tick, 0)

    def test_post_completed_describe_tasks_can_initially_report_missing(self):
        proof = self.proof()
        self.aws.responses["describe-tasks"] = [
            {"tasks": [], "failures": [{"arn": self.aws.task["taskArn"], "reason": "MISSING"}]},
        ]
        self.verify(proof)
        self.assertGreater(self.tick, 0)

    def test_post_completed_old_task_digest_and_health_can_converge(self):
        for change in ("deployment", "digest", "health"):
            self.setUp()
            proof = self.proof()
            stale = copy.deepcopy(self.aws.task)
            if change == "deployment":
                stale["startedBy"] = OLD
            elif change == "digest":
                stale["containers"][0]["imageDigest"] = "sha256:" + "f" * 64
            else:
                stale["containers"][0]["healthStatus"] = "UNKNOWN"
            self.aws.responses["describe-tasks"] = [{"tasks": [stale], "failures": []}]
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
            "ECS_SERVICE": PROJECT + "-web",
        }
        reads = {"batch-get-image", "describe-task-definition", "list-tasks", "describe-tasks"}
        for denied in [None, *sorted(reads)]:
            self.setUp()
            if denied:
                self.aws.denied.add(denied)
            def pin(*args):
                observed = {op for _, op, _ in self.aws.calls}
                self.assertTrue(reads <= observed)
                self.aws.calls.append(("ecr", "put-image", []))
            with self.subTest(denied=denied), tempfile.TemporaryDirectory() as folder, \
                    patch.dict(os.environ, env | {"GITHUB_OUTPUT": str(Path(folder) / "output")}, clear=True), \
                    patch.object(sys, "argv", ["ci_web_deploy.py", "deploy"]), \
                    patch.object(deploy, "aws_request", self.aws), \
                    patch.object(deploy, "command", side_effect=AssertionError("Unexpected real AWS boundary")), \
                    patch.object(deploy, "verify_caller", return_value=ACCOUNT), \
                    patch.object(deploy, "verify_source_and_migration", return_value=False), \
                    patch.object(deploy, "resolve_digest", return_value=DIGEST), \
                    patch.object(deploy, "pin_image", side_effect=pin):
                if denied:
                    with self.assertRaises(ImageError):
                        deploy.main()
                    self.assertFalse(any(op in {"put-image", "update-service"} for _, op, _ in self.aws.calls))
                else:
                    deploy.main()
                    operations = [op for _, op, _ in self.aws.calls]
                    self.assertLess(operations.index("put-image"), operations.index("update-service"))


if __name__ == "__main__":
    unittest.main()
