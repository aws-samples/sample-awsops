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
        self.candidate = copy.deepcopy(self.task)
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

    def sleep(self, seconds):
        self.tick += seconds

    def verify(self, proof, timeout=30):
        return deploy.verify(C, proof, self.aws, timeout=timeout,
                             now=lambda: self.tick, sleep=self.sleep)

    def proof(self):
        return deploy.start(C, DIGEST, DIGEST, self.aws)

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
            self.assertEqual(self.tick, 30)

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
            "ECS_SERVICE": PROJECT + "-web",
        }
        reads = {"batch-get-image", "describe-task-definition", "list-tasks", "describe-tasks"}
        for denied in [None, *sorted(reads), "output"]:
            self.setUp()
            if denied:
                self.aws.denied.add(denied)
            if denied == "describe-tasks":
                self.aws.task = None
                self.aws.service["deployments"][0]["rolloutState"] = "FAILED"
            def pin(*args):
                observed = {op for _, op, _ in self.aws.calls}
                self.assertTrue(reads <= observed)
                self.aws.calls.append(("ecr", "put-image", []))
            with self.subTest(denied=denied), tempfile.TemporaryDirectory() as folder, \
                    patch.dict(os.environ, env | {
                        "GITHUB_OUTPUT": folder if denied == "output" else str(Path(folder) / "output"),
                    }, clear=True), \
                    patch.object(sys, "argv", ["ci_web_deploy.py", "deploy"]), \
                    patch.object(deploy, "aws_request", self.aws), \
                    patch.object(deploy, "command", side_effect=AssertionError("Unexpected real AWS boundary")), \
                    patch.object(deploy, "verify_caller", return_value=ACCOUNT), \
                    patch.object(deploy, "verify_source_and_migration", return_value=False), \
                    patch.object(deploy, "resolve_digest", return_value=DIGEST), \
                    patch.object(deploy, "pin_image", side_effect=pin):
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
                    "ECS_SERVICE": PROJECT + "-web", "PIN_SHA": pin_sha,
                    "ROLLBACK_SCHEMA_COMPATIBLE": "true" if rollback else "",
                    "MIGRATED_SHA": "" if rollback else C["sha"],
                    "MIGRATED_PROJECT": "" if rollback else PROJECT,
                }
                def api(path):
                    if "/compare/" in path:
                        self.assertTrue(rollback)
                        return {"status": "ahead", "merge_base_commit": {"sha": pin_sha}}
                    return {"object": {"sha": C["sha"]}}
                def pin(*args):
                    self.assertEqual(args, (PROJECT + "-web", DIGEST))
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
                        patch.object(deploy, "pin_image", side_effect=pin), \
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


if __name__ == "__main__":
    unittest.main()
