#!/usr/bin/env python3
"""Bounded read-only readiness and recent collector-error audit across all 8 clusters."""
import concurrent.futures
import json
from pathlib import Path
import subprocess
import time

from build import ROUTES
ROOT = Path(__file__).resolve().parent
KUBE = "/tmp/awsops-central-telemetry.bOV102/kubeconfig"


def inspect(cluster):
    prefix = ["kubectl", "--kubeconfig", KUBE, "--context", cluster,
              "--request-timeout=15s", "-n", "telemetry-system"]
    raw = subprocess.run(prefix + ["get", "deploy,ds,pods", "-o", "json"],
                         check=True, capture_output=True, text=True, timeout=30)
    resources = json.loads(raw.stdout)["items"]
    summary = {"cluster": cluster, "ready": [], "errors": []}
    for r in resources:
        if r["kind"] == "DaemonSet":
            summary["ready"].append({"name": r["metadata"]["name"],
                                     "desired": r["status"]["desiredNumberScheduled"],
                                     "ready": r["status"].get("numberReady", 0)})
        if r["kind"] == "Deployment":
            summary["ready"].append({"name": r["metadata"]["name"], "desired": r["spec"]["replicas"],
                                     "ready": r["status"].get("readyReplicas", 0)})
    for r in resources:
        if r["kind"] != "Pod":
            continue
        if r["status"].get("phase") != "Running":
            summary["errors"].append({"pod": r["metadata"]["name"], "phase": r["status"].get("phase")})
            continue
        raw = subprocess.run(prefix + ["logs", r["metadata"]["name"], "--all-containers=true",
                                      "--prefix=true", "--since=120s", "--tail=100"],
                             capture_output=True, text=True, timeout=20)
        lines = []
        for line in raw.stdout.splitlines():
            if any(s in line for s in (
                "\terror\t", "level=ERROR", "Permanent error", "Exporting failed",
                "unable to instrument", "Failed to scrape", "x509:",
            )):
                # Standard collector logs contain configuration errors, not payload bodies.
                lines.append(line[:1800])
        if lines:
            summary["errors"].append({"pod": r["metadata"]["name"], "lines": lines[-4:]})
    return summary


if __name__ == "__main__":
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(inspect, ROUTES))
    evidence = {"checked_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "clusters": results}
    (ROOT / "collector-status.json").write_text(json.dumps(evidence, indent=2) + "\n")
    for item in results:
        print(json.dumps(item), flush=True)
