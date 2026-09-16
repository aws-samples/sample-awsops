#!/usr/bin/env python3
"""Persist only non-secret deployed manifests and baseline collector preservation checks."""
import concurrent.futures
import json
from pathlib import Path
import subprocess
import time
import yaml
from build import ROUTES

ROOT = Path(__file__).resolve().parent
KUBE = "/tmp/awsops-central-telemetry.bOV102/kubeconfig"
DEST = ROOT / "deployed"


def get(cluster, *args):
    return json.loads(subprocess.run(
        ["kubectl", "--kubeconfig", KUBE, "--context", cluster, "--request-timeout=15s",
         "get", *args, "-o", "json"], check=True, capture_output=True, timeout=30).stdout)


def clean(r):
    r.pop("status", None)
    for key in ("resourceVersion", "uid", "managedFields", "creationTimestamp", "generation"):
        r["metadata"].pop(key, None)
    r["metadata"].get("annotations", {}).pop("kubectl.kubernetes.io/last-applied-configuration", None)
    return r


def snapshot(cluster):
    objects = get(cluster, "configmaps,deployments,daemonsets,services,serviceaccounts",
                  "-n", "telemetry-system")["items"]
    objects = [clean(r) for r in objects
               if r["metadata"]["name"].startswith(("telemetry-", "central-telemetry"))]
    (DEST / (cluster + ".yaml")).write_text(yaml.safe_dump_all(objects, sort_keys=False))
    baseline = json.loads((ROOT / f"inventory-{cluster}.json").read_text())["workloads"]
    before = {
        (w["kind"], w["namespace"], w["name"]): w for w in baseline
        if "cloudwatch" in w["namespace"] or "prometheus" in w["name"]
    }
    live = get(cluster, "deployments,daemonsets,statefulsets", "-A")["items"]
    lookup = {(r["kind"], r["metadata"]["namespace"], r["metadata"]["name"]): r for r in live}
    changes = []
    for key, w in before.items():
        r = lookup.get(key)
        if not r:
            changes.append({"resource": key, "change": "missing"})
            continue
        images = [(c["name"], c["image"]) for c in r["spec"]["template"]["spec"]["containers"]]
        if images != [(c["name"], c["image"]) for c in w["containers"]]:
            changes.append({"resource": key, "change": "container images differ"})
        if r["spec"].get("replicas") != w["replicas"]:
            changes.append({"resource": key, "change": "replica count differs"})
    return {"cluster": cluster, "existing_collectors_checked": len(before), "changes": changes}


if __name__ == "__main__":
    DEST.mkdir(exist_ok=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        result = list(pool.map(snapshot, ROUTES))
    central = get("platform-cluster", "configmaps,statefulsets,services,networkpolicies,poddisruptionbudgets",
                  "-n", "central-observability")["items"]
    central = [clean(r) for r in central if r["metadata"]["name"] != "kube-root-ca.crt"]
    (DEST / "central.yaml").write_text(yaml.safe_dump_all(central, sort_keys=False))
    proof = {"checked_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "clusters": result}
    (ROOT / "preservation.json").write_text(json.dumps(proof, indent=2) + "\n")
    print(json.dumps(proof))
