"""Exercise real manifest/deployment checks with only the AWS boundary substituted."""
import copy
import hashlib
import json
import sys
from pathlib import Path
import unittest

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
            "taskDefinitionArn": self.service["taskDefinition"], "startedBy": NEW,
            "lastStatus": "RUNNING", "desiredStatus": "RUNNING", "healthStatus": "HEALTHY",
            "containers": [{"name": "web", "image": REPO + ":web-latest", "imageDigest": DIGEST,
                            "lastStatus": "RUNNING", "healthStatus": "HEALTHY"}],
        }
        self.image = {"registryId": ACCOUNT, "repositoryName": PROJECT + "-web",
                      "imageId": {"imageDigest": DIGEST}, "imageManifest": RAW}

    def __call__(self, service, operation, args):
        self.calls.append((service, operation, args))
        if operation == "batch-get-image":
            return {"images": [copy.deepcopy(self.image)], "failures": []}
        if operation == "describe-services":
            return {"services": [copy.deepcopy(self.service)], "failures": []}
        if operation == "describe-task-definition":
            return {"taskDefinition": copy.deepcopy(self.definition)}
        if operation == "update-service":
            self.service["deployments"][0]["id"] = NEW
            return {"service": copy.deepcopy(self.service)}
        if operation == "list-tasks":
            return {"taskArns": [self.task["taskArn"]]}
        if operation == "describe-tasks":
            return {"tasks": [copy.deepcopy(self.task)], "failures": []}
        self.fail("unexpected operation")


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.aws = AWS()

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
        deploy.verify(C, proof, self.aws)
        self.assertTrue(any(op == "describe-tasks" for _, op, _ in self.aws.calls))
        listed = next(args for _, op, args in self.aws.calls if op == "list-tasks")
        self.assertIn("--cli-input-json", listed)
        self.assertIn("--no-paginate", listed)
        self.assertNotIn("--max-results", listed)

    def test_rollback_cannot_pass_just_because_service_is_stable(self):
        proof = self.proof()
        self.aws.service["deployments"][0]["id"] = OLD
        with self.assertRaisesRegex(ImageError, "rolled back"):
            deploy.verify(C, proof, self.aws)

    def test_wrong_running_image_or_unhealthy_task_fails(self):
        for field, value in [("imageDigest", "sha256:" + "f" * 64), ("healthStatus", "UNKNOWN")]:
            self.setUp()
            proof = self.proof()
            self.aws.task["containers"][0][field] = value
            with self.subTest(field=field), self.assertRaises(ImageError):
                deploy.verify(C, proof, self.aws)

    def test_old_deployment_task_cannot_satisfy_new_deployment(self):
        proof = self.proof()
        self.aws.task["startedBy"] = OLD
        with self.assertRaises(ImageError):
            deploy.verify(C, proof, self.aws)

    def test_changed_latest_tag_cannot_bless_future_task_churn(self):
        proof = self.proof()
        self.aws.image["imageId"]["imageDigest"] = "sha256:" + "f" * 64
        with self.assertRaisesRegex(ImageError, "promoted image"):
            deploy.verify(C, proof, self.aws)

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


if __name__ == "__main__":
    unittest.main()
