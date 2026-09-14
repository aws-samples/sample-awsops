#!/usr/bin/env python3
"""Samples web-only promotion and exact deployment verification; no runtime/collection gate."""
import argparse
import json
import os
import re
import stat
import sys
import time

from ci_web_image import (INDEX_MEDIA, ImageError, command, environment_context, get_image,
                          manifest_body, promote, verify_arm_image,
                          require, resolve_digest, validate_context, verify_caller,
                          verify_source_and_migration)
from ci_web_read import TransientReadError, read_request, read_window

REGION = "ap-northeast-2"
DIGEST = re.compile(r"sha256:[0-9a-f]{64}")


class NotReady(ImageError):
    """A scoped ECS observation may converge; identity/API failures may not."""


def ready(condition, message):
    if not condition:
        raise NotReady(message)


def wait_for(check, timeout, now, sleep):
    require(type(timeout) in (int, float) and 0 < timeout <= 600, "Invalid verification timeout")
    deadline = now() + timeout
    last_error = None
    with read_window(deadline, now=now):
        while True:
            if now() >= deadline:
                raise ImageError((str(last_error) + "; " if last_error else "")
                                 + "deployment verification timeout")
            try:
                return check()
            except (NotReady, TransientReadError) as error:
                last_error = error
                remaining = deadline - now()
                if remaining <= 0:
                    raise ImageError(str(error) + "; deployment verification timeout") from None
                sleep(min(5, remaining))


def read_options(service, operation, args):
    """Translate the controller's fixed CLI calls to the read-only transport."""
    if "--cli-input-json" in args:
        require((service, operation) == ("ecs", "list-tasks")
                and len(args) == 3 and args[0] == "--cli-input-json"
                and args[2] == "--no-paginate", "Invalid web read request")
        value = json.loads(args[1])
        names = {"cluster": "cluster", "serviceName": "service-name",
                 "desiredStatus": "desired-status", "maxResults": "max-results",
                 "nextToken": "next-token"}
        require(isinstance(value, dict) and set(value) <= names.keys(), "Invalid web read request")
        return {names[key]: str(item) for key, item in value.items()}
    result, index = {}, 0
    while index < len(args):
        key = args[index]
        require(isinstance(key, str) and key.startswith("--")
                and key[2:] not in result, "Invalid web read request")
        index += 1
        values = []
        while index < len(args) and not args[index].startswith("--"):
            values.append(args[index])
            index += 1
        require(values, "Invalid web read request")
        result[key[2:]] = values[0] if len(values) == 1 else values
    return result


def aws_request(service, operation, args):
    if (service, operation) != ("ecs", "update-service"):
        return read_request(service, operation, read_options(service, operation, args))
    # The only controller write remains single-attempt and is outside read polls.
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


def runtime_digest(c, expected, aws=aws_request, *, source_sha=None):
    """Apply promotion's read-only ECR/config proof before DDL; retain the ARM64 digest."""
    require(isinstance(expected, str) and DIGEST.fullmatch(expected), "Invalid expected digest")
    require(source_sha is None or isinstance(source_sha, str) and re.fullmatch(r"[a-f0-9]{40}", source_sha),
            "Invalid source image SHA")
    def ecr(operation, args):
        return aws("ecr", operation, [value for key, arg in args.items() for value in ("--" + key, arg)])
    name = c["project"] + "-web"
    image = get_image(name, expected, c["account"], ecr)
    verify_arm_image(name, image, c["account"], ecr)
    if source_sha is not None:
        get_image(name, expected, c["account"], ecr, "web-" + source_sha)
    body = manifest_body(image)
    if body["mediaType"] in INDEX_MEDIA:
        return next(d["digest"] for d in body["manifests"]
                    if d["platform"]["os"] == "linux" and d["platform"]["architecture"] == "arm64")
    return expected


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
    deployments = supplied.get("deployments")
    require(isinstance(deployments, list) and all(isinstance(d, dict)
            and isinstance(d.get("id"), str)
            and re.fullmatch(r"ecs-svc/[0-9]+", d["id"]) for d in deployments),
            "Invalid deployment identity")
    primary = [d for d in deployments if d.get("status") == "PRIMARY"]
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


def probe_tasks(c, aws):
    """Exercise scoped reads; prior health/cardinality must not prevent recovery."""
    request = dict(cluster=c["project"], serviceName=c["project"] + "-web",
                   desiredStatus="RUNNING", maxResults=100)
    page = aws("ecs", "list-tasks", ["--cli-input-json", json.dumps(request), "--no-paginate"])
    arns = page.get("taskArns")
    pattern = re.escape(prefix(c) + "task/" + c["project"] + "/") + r"[0-9a-f]{32}"
    require(isinstance(arns, list) and len(arns) <= 100
            and all(isinstance(a, str) and re.fullmatch(pattern, a) for a in arns)
            and len(set(arns)) == len(arns)
            and (page.get("nextToken") is None or isinstance(page["nextToken"], str)),
            "Invalid task permission probe listing")
    # One page suffices to exercise IAM; this is not a complete health inventory.
    # Even an empty service must authorize DescribeTasks on an owned task ARN.
    batch = arns or [prefix(c) + "task/" + c["project"] + "/" + "0" * 32]
    response = aws("ecs", "describe-tasks", ["--cluster", c["project"], "--tasks", *batch])
    tasks, failures = response.get("tasks"), response.get("failures", [])
    require(isinstance(tasks, list) and isinstance(failures, list), "Invalid task permission probe")
    seen = []
    for task in tasks:
        require(isinstance(task, dict) and task.get("taskArn") in batch
                and task.get("clusterArn") == prefix(c) + "cluster/" + c["project"]
                and task.get("group") == "service:" + c["project"] + "-web"
                and re.fullmatch(re.escape(prefix(c) + f"task-definition/{c['project']}-web:")
                                 + r"[1-9][0-9]*", task.get("taskDefinitionArn", "")),
                "Foreign task permission probe result")
        seen.append(task["taskArn"])
    for failure in failures:
        require(isinstance(failure, dict) and failure.get("arn") in batch
                and failure.get("reason") == "MISSING", "Task permission probe failed")
        seen.append(failure["arn"])
    require(len(seen) == len(set(seen)) and set(seen) == set(batch), "Incomplete task permission probe")


def task_set(c, value, primary, aws, digests):
    """The candidate must have a complete, healthy, digest-bound task set."""
    arns, token = [], None
    for _ in range(11):
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
                    and web[0]["imageDigest"] in digests,
                    "Running web image, health or deployment mismatch")
            seen.add(task["taskArn"])


def snapshot(c, aws, timeout=120, now=time.monotonic, sleep=time.sleep):
    def read():
        value, primary = service(c, aws)
        definition = aws("ecs", "describe-task-definition",
                         ["--task-definition", value["taskDefinition"]]).get("taskDefinition", {})
        web = [v for v in definition.get("containerDefinitions", []) if v.get("name") == "web"]
        require(definition.get("taskDefinitionArn") == value["taskDefinition"]
                and definition.get("status") == "ACTIVE"
                and definition.get("runtimePlatform") == {"cpuArchitecture": "ARM64", "operatingSystemFamily": "LINUX"}
                and len(web) == 1 and web[0].get("essential") is True
                and web[0].get("image") == repository(c) + ":web-latest", "Web task configuration mismatch")
        # These real calls preflight permissions, not just configured IAM metadata.
        probe_tasks(c, aws)
        after, current = service(c, aws)
        ready(current["id"] == primary["id"] and after["taskDefinition"] == value["taskDefinition"]
              and after["desiredCount"] == value["desiredCount"], "Web snapshot changed during reads")
        return {"old_deployment_id": primary["id"], "task_revision": value["taskDefinition"].rsplit(":", 1)[1],
                "desired_count": str(value["desiredCount"])}
    return wait_for(read, timeout, now, sleep)


def open_workflow_output(env):
    path = env.get("GITHUB_OUTPUT", "")
    require(path and os.path.isabs(path), "Workflow output is required")
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid(), "Invalid workflow output")
        return os.fdopen(fd, "a")
    except BaseException:
        os.close(fd)
        raise


def start(c, digest, child, aws=aws_request, before=None,
          timeout=120, now=time.monotonic, sleep=time.sleep):
    current = snapshot(c, aws, timeout, now, sleep)
    before = before or current
    require(current == before, "Web service changed before rollout")
    # Mutate exactly once. Eventual-consistency retries below perform reads only.
    result = aws("ecs", "update-service", ["--cluster", c["project"], "--service", c["project"] + "-web",
                                         "--force-new-deployment"])
    # An acknowledged update may omit the service projection; confirm it with
    # reads, never repeat the mutation to obtain a better response.
    initial = [result["service"]] if isinstance(result.get("service"), dict) else []
    def confirmed():
        value, primary = service(c, aws, initial.pop() if initial else None)
        require(value["taskDefinition"].endswith(":" + before["task_revision"])
                and value["desiredCount"] == int(before["desired_count"]), "Deployment configuration changed")
        ready(primary["id"] != before["old_deployment_id"], "New deployment not confirmed")
        ready(primary.get("rolloutState") is not None, "Deployment state is not yet available")
        require(primary.get("rolloutState") in {"IN_PROGRESS", "COMPLETED"}, "Deployment failed")
        return {**before, "deployment_id": primary["id"], "digest": digest, "runtime_digest": child}
    return wait_for(confirmed, timeout, now, sleep)


def verify(c, proof, aws=aws_request, timeout=600, now=time.monotonic, sleep=time.sleep):
    require(DIGEST.fullmatch(proof.get("digest", "")) and DIGEST.fullmatch(proof.get("runtime_digest", ""))
            and re.fullmatch(r"ecs-svc/[0-9]+", proof.get("deployment_id", ""))
            and re.fullmatch(r"[1-9][0-9]*", proof.get("task_revision", ""))
            and re.fullmatch(r"[1-9][0-9]*", proof.get("desired_count", "")), "Invalid rollout receipt")
    old_id = proof.get("old_deployment_id")
    require(old_id in (None, "") or (isinstance(old_id, str)
            and re.fullmatch(r"ecs-svc/[0-9]+", old_id)
            and old_id != proof["deployment_id"]), "Invalid prior deployment identity")
    visibility_deadline = now() + min(timeout, 15)
    def current():
        value, primary = service(c, aws)
        started = [d for d in value["deployments"] if d.get("id") == proof["deployment_id"]]
        require(not any(d.get("rolloutState") == "FAILED" for d in started), "Deployment failed")
        if primary["id"] != proof["deployment_id"]:
            # Only the known pre-update projection may be briefly stale. A new
            # replacement ID or explicit failure is terminal on the first read.
            if primary["id"] == proof.get("old_deployment_id") and now() < visibility_deadline:
                raise NotReady("Waiting for the confirmed deployment to become visible")
            raise ImageError("Deployment was replaced or rolled back")
        require(value["taskDefinition"].endswith(":" + proof["task_revision"])
                and value["desiredCount"] == int(proof["desired_count"]), "Deployment configuration changed")
        ready(primary.get("rolloutState") is not None, "Deployment state is not yet available")
        require(primary.get("rolloutState") in {"IN_PROGRESS", "COMPLETED"}, "Deployment failed")
        stable(value, primary)
        return value, primary
    def check():
        value, primary = current()
        task_set(c, value, primary, aws, {proof["digest"], proof["runtime_digest"]})
        current()
        latest = aws("ecr", "batch-get-image", ["--registry-id", c["account"],
                     "--repository-name", c["project"] + "-web", "--image-ids", "imageTag=web-latest"])
        images = latest.get("images", [])
        require(not latest.get("failures") and len(images) == 1
                and images[0].get("registryId") == c["account"]
                and images[0].get("repositoryName") == c["project"] + "-web"
                and images[0].get("imageId", {}).get("imageDigest") == proof["digest"],
                "The promoted image changed during deployment verification")
    # Completion, the task set and health must converge in the same bounded poll.
    wait_for(check, timeout, now, sleep)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("preflight-image", "deploy", "verify"))
    args = parser.parse_args()
    env = os.environ
    c = environment_context(env)
    validate_context(c)
    verify_caller(env)
    if args.mode != "preflight-image":
        validate_target(c, env)
    if args.mode == "verify":
        proof = {key: env.get("WEB_" + key.upper(), "") for key in
                 ("digest", "runtime_digest", "deployment_id", "old_deployment_id", "task_revision", "desired_count")}
        verify(c, proof)
        print("Exact web deployment and healthy image verified.")
        return
    # Keep the validated descriptor open, so output permission/type errors precede
    # promotion and a later path substitution cannot redirect the release receipt.
    with open_workflow_output(env) as output:
        pin = env.get("PIN_SHA") or c["sha"]
        rollback = verify_source_and_migration(c, pin, env) if args.mode == "deploy" else False
        digest = resolve_digest(c, pin_sha=pin, fresh_digest=env.get("FRESH_DIGEST", ""),
                                fresh_project=env.get("FRESH_PROJECT", ""), producer_run=env.get("IMAGE_BUILD_RUN_ID", ""))
        child = runtime_digest(c, digest, aws_request, source_sha=pin if env.get("FRESH_DIGEST") else None)
        if args.mode == "preflight-image":
            output.write(f"digest={digest}\nruntime_digest={child}\n")
            return
        require(env.get("PREFLIGHT_DIGEST") == digest, "Image changed after pre-migration validation")
        before = snapshot(c, aws_request)
        promote(env, expected_digest=digest)
        verify_source_and_migration(c, pin, env)
        proof = start(c, digest, child, aws_request, before=before)
        for key, value in proof.items():
            output.write(f"{key}={value}\n")
    print(json.dumps({"digest": digest, "image_sha": pin, "rollback": rollback,
                      "migration": "not_run_for_rollback" if rollback else "source_verified" if c["branch"] == "dev" else "operator_managed"}))


if __name__ == "__main__":
    try:
        main()
    except (ImageError, ValueError, KeyError, TypeError, AttributeError, IndexError, OSError) as error:
        print("::error::" + (str(error) if isinstance(error, ImageError) else "Web deployment verification failed"), file=sys.stderr)
        raise SystemExit(1)
