#!/usr/bin/env python3
"""Samples web-only promotion and exact deployment verification; no runtime/collection gate."""
import argparse
import hashlib
import json
import os
import re
import time

from ci_web_image import (ImageError, command, environment_context, pin_image,
                          require, resolve_digest, validate_context, verify_caller,
                          verify_source_and_migration)

REGION = "ap-northeast-2"
DIGEST = re.compile(r"sha256:[0-9a-f]{64}")
IMAGES = {"application/vnd.oci.image.manifest.v1+json",
          "application/vnd.docker.distribution.manifest.v2+json"}
INDEXES = {"application/vnd.oci.image.index.v1+json",
           "application/vnd.docker.distribution.manifest.list.v2+json"}


class NotReady(ImageError):
    """A scoped ECS observation may converge; identity/API failures may not."""


def ready(condition, message):
    if not condition:
        raise NotReady(message)


def wait_for(check, timeout, now, sleep):
    require(type(timeout) in (int, float) and 0 < timeout <= 600, "Invalid verification timeout")
    deadline = now() + timeout
    while True:
        try:
            result = check()
            require(now() <= deadline, "Deployment verification timeout")
            return result
        except NotReady as error:
            remaining = deadline - now()
            if remaining <= 0:
                raise ImageError(str(error) + "; deployment verification timeout") from None
            sleep(min(5, remaining))


def aws_request(service, operation, args):
    return command(["aws", service, operation, *args, "--region", REGION,
                    "--output", "json", "--no-cli-pager", "--cli-connect-timeout", "5",
                    "--cli-read-timeout", "20"])


def prefix(c):
    return f"arn:aws:ecs:{REGION}:{c['account']}:"


def repository(c):
    return f"{c['account']}.dkr.ecr.{REGION}.amazonaws.com/{c['project']}-web"


def validate_target(c, env):
    require(env.get("ECR_URI") == repository(c) and env.get("ECS_CLUSTER") == c["project"]
            and env.get("ECS_SERVICE") == c["project"] + "-web",
            "Terraform metadata does not match the selected branch account/project")


def runtime_digest(c, expected, aws=aws_request):
    """Bind the root manifest and its one ARM64 descriptor, never a mutable SHA tag."""
    def read(digest):
        require(isinstance(digest, str) and DIGEST.fullmatch(digest), "Invalid expected digest")
        result = aws("ecr", "batch-get-image", ["--registry-id", c["account"],
            "--repository-name", c["project"] + "-web", "--image-ids", "imageDigest=" + digest])
        images = result.get("images")
        require(not result.get("failures") and isinstance(images, list) and len(images) == 1,
                "Expected image is unavailable")
        image = images[0]
        raw = image.get("imageManifest")
        require(image.get("registryId") == c["account"]
                and image.get("repositoryName") == c["project"] + "-web"
                and image.get("imageId", {}).get("imageDigest") == digest
                and isinstance(raw, str) and "sha256:" + hashlib.sha256(raw.encode()).hexdigest() == digest,
                "Image account, repository or content mismatch")
        value = json.loads(raw)
        require(value.get("schemaVersion") == 2, "Invalid image manifest")
        return value, value.get("mediaType") or image.get("imageManifestMediaType")

    manifest, kind = read(expected)
    actual = expected
    if kind in INDEXES:
        descriptors = manifest.get("manifests")
        require(isinstance(descriptors, list) and len(descriptors) <= 32, "Invalid image index")
        arm = [d for d in descriptors if d.get("platform", {}).get("os") == "linux"
               and d["platform"].get("architecture") == "arm64"]
        require(len(arm) == 1, "Expected exactly one ARM64 image")
        actual = arm[0].get("digest")
        manifest, kind = read(actual)
    require(kind in IMAGES and DIGEST.fullmatch(manifest.get("config", {}).get("digest", ""))
            and isinstance(manifest.get("layers"), list), "Invalid runnable image manifest")
    return actual


def service(c, aws, supplied=None):
    if supplied is None:
        result = aws("ecs", "describe-services", ["--cluster", c["project"],
                     "--services", c["project"] + "-web"])
        require(not result.get("failures") and len(result.get("services", [])) == 1,
                "Web service unavailable")
        supplied = result["services"][0]
    p, project = prefix(c), c["project"]
    require(supplied.get("serviceArn") == p + f"service/{project}/{project}-web"
            and supplied.get("clusterArn") == p + "cluster/" + project
            and supplied.get("serviceName") == project + "-web" and supplied.get("status") == "ACTIVE"
            and supplied.get("deploymentController", {}).get("type") == "ECS",
            "Web service identity mismatch")
    require(re.fullmatch(re.escape(p + f"task-definition/{project}-web:") + r"[1-9][0-9]*",
                         supplied.get("taskDefinition", "")), "Task definition identity mismatch")
    primary = [d for d in supplied.get("deployments", []) if d.get("status") == "PRIMARY"]
    require(len(primary) == 1 and re.fullmatch(r"ecs-svc/[0-9]+", primary[0].get("id", ""))
            and primary[0].get("taskDefinition") == supplied["taskDefinition"], "Primary deployment missing")
    require(type(supplied.get("desiredCount")) is int and 0 < supplied["desiredCount"] <= 1000,
            "Invalid desired task count")
    return supplied, primary[0]


def stable(value, primary):
    desired = value["desiredCount"]
    ready(primary.get("rolloutState") == "COMPLETED"
            and value.get("runningCount") == desired and value.get("pendingCount") == 0
            and primary.get("runningCount") == desired and primary.get("pendingCount") == 0
            and all(d.get("runningCount") == 0 and d.get("pendingCount") == 0
                    for d in value["deployments"] if d["id"] != primary["id"]), "Web service is not stable")


def task_set(c, value, primary, aws, digests=None):
    """Read the whole current web task set, both before mutation and after rollout."""
    arns, token = [], None
    for _ in range(10):
        request = dict(cluster=c["project"], serviceName=c["project"] + "-web",
                       desiredStatus="RUNNING", maxResults=100)
        if token:
            request["nextToken"] = token
        page = aws("ecs", "list-tasks", ["--cli-input-json", json.dumps(request), "--no-paginate"])
        require(isinstance(page.get("taskArns"), list), "Invalid task listing")
        arns.extend(page["taskArns"])
        token = page.get("nextToken")
        if not token:
            break
    require(all(isinstance(a, str) and re.fullmatch(
        re.escape(prefix(c) + "task/" + c["project"] + "/") + r"[0-9a-f]{32}", a) for a in arns),
        "Foreign task listing")
    ready(not token and len(arns) == value["desiredCount"] and len(set(arns)) == len(arns),
          "Incomplete task listing")
    seen = set()
    for offset in range(0, len(arns), 100):
        batch = arns[offset:offset + 100]
        result = aws("ecs", "describe-tasks", ["--cluster", c["project"], "--tasks", *batch])
        failures = result.get("failures", [])
        require(isinstance(failures, list) and all(f.get("reason") == "MISSING" for f in failures),
                "Task read failed")
        require(isinstance(result.get("tasks"), list), "Invalid task response")
        ready(not failures and len(result["tasks"]) == len(batch), "Tasks unavailable")
        for task in result["tasks"]:
            web = [v for v in task.get("containers", []) if v.get("name") == "web"]
            require(task.get("taskArn") in batch and task["taskArn"] not in seen
                    and task.get("clusterArn") == prefix(c) + "cluster/" + c["project"]
                    and task.get("group") == "service:" + c["project"] + "-web"
                    and re.fullmatch(re.escape(prefix(c) + f"task-definition/{c['project']}-web:")
                                     + r"[1-9][0-9]*", task.get("taskDefinitionArn", "")),
                    "Foreign or duplicate web task")
            ready(task.get("taskDefinitionArn") == value["taskDefinition"]
                    and task.get("startedBy") == primary["id"]
                    and task.get("lastStatus") == task.get("desiredStatus") == "RUNNING"
                    and task.get("healthStatus") == "HEALTHY" and len(web) == 1
                    and web[0].get("lastStatus") == "RUNNING" and web[0].get("healthStatus") == "HEALTHY"
                    and web[0].get("image") == repository(c) + ":web-latest"
                    and isinstance(web[0].get("imageDigest"), str)
                    and DIGEST.fullmatch(web[0]["imageDigest"])
                    and (digests is None or web[0]["imageDigest"] in digests),
                    "Running web image, health or deployment mismatch")
            seen.add(task["taskArn"])


def snapshot(c, aws, timeout=120, now=time.monotonic, sleep=time.sleep):
    def read():
        value, primary = service(c, aws)
        stable(value, primary)
        definition = aws("ecs", "describe-task-definition",
                         ["--task-definition", value["taskDefinition"]]).get("taskDefinition", {})
        web = [v for v in definition.get("containerDefinitions", []) if v.get("name") == "web"]
        require(definition.get("taskDefinitionArn") == value["taskDefinition"]
                and definition.get("status") == "ACTIVE"
                and definition.get("runtimePlatform") == {"cpuArchitecture": "ARM64", "operatingSystemFamily": "LINUX"}
                and len(web) == 1 and web[0].get("essential") is True
                and web[0].get("image") == repository(c) + ":web-latest", "Web task configuration mismatch")
        # These real calls preflight permissions, not just configured IAM metadata.
        task_set(c, value, primary, aws)
        after, current = service(c, aws)
        stable(after, current)
        ready(current["id"] == primary["id"] and after["taskDefinition"] == value["taskDefinition"]
              and after["desiredCount"] == value["desiredCount"], "Web snapshot changed during reads")
        return {"old_deployment_id": primary["id"], "task_revision": value["taskDefinition"].rsplit(":", 1)[1],
                "desired_count": str(value["desiredCount"])}
    return wait_for(read, timeout, now, sleep)


def start(c, digest, child, aws=aws_request, before=None,
          timeout=120, now=time.monotonic, sleep=time.sleep):
    current = snapshot(c, aws, timeout, now, sleep)
    before = before or current
    require(current == before, "Web service changed before rollout")
    # Mutate exactly once. Eventual-consistency retries below perform reads only.
    result = aws("ecs", "update-service", ["--cluster", c["project"], "--service", c["project"] + "-web",
                                         "--force-new-deployment"])
    initial = [result.get("service", {})]
    def confirmed():
        value, primary = service(c, aws, initial.pop() if initial else None)
        require(value["taskDefinition"].endswith(":" + before["task_revision"])
                and value["desiredCount"] == int(before["desired_count"]), "Deployment configuration changed")
        ready(primary["id"] != before["old_deployment_id"], "New deployment not confirmed")
        require(primary.get("rolloutState") in {"IN_PROGRESS", "COMPLETED"}, "Deployment failed")
        return {**before, "deployment_id": primary["id"], "digest": digest, "runtime_digest": child}
    return wait_for(confirmed, timeout, now, sleep)


def verify(c, proof, aws=aws_request, timeout=600, now=time.monotonic, sleep=time.sleep):
    require(DIGEST.fullmatch(proof.get("digest", "")) and DIGEST.fullmatch(proof.get("runtime_digest", ""))
            and re.fullmatch(r"ecs-svc/[0-9]+", proof.get("deployment_id", ""))
            and re.fullmatch(r"[1-9][0-9]*", proof.get("task_revision", ""))
            and re.fullmatch(r"[1-9][0-9]*", proof.get("desired_count", "")), "Invalid rollout receipt")
    def current():
        value, primary = service(c, aws)
        ready(primary["id"] == proof["deployment_id"], "Deployment was replaced or rolled back")
        require(value["taskDefinition"].endswith(":" + proof["task_revision"])
                and value["desiredCount"] == int(proof["desired_count"]), "Deployment configuration changed")
        require(primary.get("rolloutState") in {"IN_PROGRESS", "COMPLETED"}, "Deployment failed")
        stable(value, primary)
        return value, primary
    def check():
        value, primary = current()
        task_set(c, value, primary, aws, {proof["digest"], proof["runtime_digest"]})
        current()
    # Completion, the task set and health must converge in the same bounded poll.
    wait_for(check, timeout, now, sleep)
    latest = aws("ecr", "batch-get-image", ["--registry-id", c["account"],
                 "--repository-name", c["project"] + "-web", "--image-ids", "imageTag=web-latest"])
    images = latest.get("images", [])
    require(not latest.get("failures") and len(images) == 1
            and images[0].get("registryId") == c["account"]
            and images[0].get("repositoryName") == c["project"] + "-web"
            and images[0].get("imageId", {}).get("imageDigest") == proof["digest"],
            "The promoted image changed during deployment verification")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("deploy", "verify"))
    args = parser.parse_args()
    env = os.environ
    c = environment_context(env)
    validate_context(c)
    verify_caller(env)
    validate_target(c, env)
    if args.mode == "verify":
        proof = {key: env.get("WEB_" + key.upper(), "") for key in
                 ("digest", "runtime_digest", "deployment_id", "task_revision", "desired_count")}
        verify(c, proof)
        print("Exact web deployment and healthy image verified.")
        return
    pin = env.get("PIN_SHA") or c["sha"]
    rollback = verify_source_and_migration(c, pin, env)
    digest = resolve_digest(c, pin_sha=pin, fresh_digest=env.get("FRESH_DIGEST", ""),
                            fresh_project=env.get("FRESH_PROJECT", ""), producer_run=env.get("IMAGE_BUILD_RUN_ID", ""))
    child = runtime_digest(c, digest, aws_request)
    before = snapshot(c, aws_request)
    verify_source_and_migration(c, pin, env)
    pin_image(c["project"] + "-web", digest)
    verify_source_and_migration(c, pin, env)
    proof = start(c, digest, child, aws_request, before=before)
    require(env.get("GITHUB_OUTPUT"), "Workflow output is required")
    with open(env["GITHUB_OUTPUT"], "a") as output:
        for key, value in proof.items():
            output.write(f"{key}={value}\n")
    print(json.dumps({"digest": digest, "image_sha": pin, "rollback": rollback,
                      "migration": "not_run_for_rollback" if rollback else "source_verified" if c["branch"] == "dev" else "operator_managed"}))


if __name__ == "__main__":
    try:
        main()
    except (ImageError, ValueError, KeyError, TypeError, OSError) as error:
        print("::error::" + (str(error) if isinstance(error, ImageError) else "Web deployment verification failed"))
        raise SystemExit(1)
