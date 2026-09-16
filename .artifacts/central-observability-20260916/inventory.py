#!/usr/bin/env python3
"""Read-only, bounded inventory of the explicitly scoped samples EKS clusters."""
import concurrent.futures
import json
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parent
KUBECONFIG = "/tmp/awsops-central-telemetry.bOV102/kubeconfig"
CLUSTERS = [
    "GPU01", "appmesh-lattice-mig", "ekscluster01-iptables",
    "ekscluster01-ipvs", "ekscluster01-nftables", "eksworkshop",
    "gpu-cluster-01", "platform-cluster",
]


def inspect(cluster):
    command = [
        "kubectl", "--kubeconfig", KUBECONFIG, "--context", cluster,
        "--request-timeout=8s", "get",
        "nodes,pods,svc,deploy,ds,sts", "-A", "-o", "json",
    ]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=35)
        if result.returncode:
            return {"cluster": cluster, "error": result.stderr[-700:]}
        objects = json.loads(result.stdout)["items"]
        nodes = [
            {"name": r["metadata"]["name"], "addresses": r["status"]["addresses"],
             "arch": r["status"]["nodeInfo"]["architecture"],
             "kernel": r["status"]["nodeInfo"]["kernelVersion"],
             "taints": r["spec"].get("taints", [])}
            for r in objects if r["kind"] == "Node"
        ]
        workloads = []
        for r in objects:
            if r["kind"] not in ("Deployment", "DaemonSet", "StatefulSet"):
                continue
            pod = r["spec"]["template"]
            workloads.append({
                "kind": r["kind"], "namespace": r["metadata"]["namespace"],
                "name": r["metadata"]["name"],
                "replicas": r["spec"].get("replicas"),
                "ready": r["status"].get("readyReplicas", r["status"].get("numberReady", 0)),
                "annotations": {k: v for k, v in pod["metadata"].get("annotations", {}).items()
                                if any(s in k for s in ("prometheus", "instrumentation", "otel"))},
                "containers": [
                    {"name": c["name"], "image": c["image"],
                     "ports": c.get("ports", []),
                     "telemetryEnv": [e for e in c.get("env", [])
                                      if e["name"].startswith(("OTEL_", "BEYLA_", "JAEGER_", "AWS_XRAY"))]}
                    for c in pod["spec"]["containers"]
                ],
            })
        services = [
            {"namespace": r["metadata"]["namespace"], "name": r["metadata"]["name"],
             "ports": r["spec"].get("ports", []), "selector": r["spec"].get("selector", {})}
            for r in objects if r["kind"] == "Service"
        ]
        pods = [r for r in objects if r["kind"] == "Pod"]
        inventory = {
            "cluster": cluster, "nodes": nodes, "workloads": workloads, "services": services,
            "pods": len(pods),
            "running": sum(r["status"].get("phase") == "Running" for r in pods),
        }
        (ROOT / f"inventory-{cluster}.json").write_text(json.dumps(inventory, indent=2) + "\n")
        telemetry = [f'{r["namespace"]}/{r["name"]}' for r in workloads
                     if any(s in (r["namespace"] + r["name"]).lower()
                            for s in ("prometheus", "cloudwatch", "otel", "opentelemetry", "jaeger", "tempo", "fluent"))]
        return {"cluster": cluster, "nodes": len(nodes), "pods": len(pods),
                "running": inventory["running"], "existingTelemetry": telemetry,
                "instrumented": [
                    f'{r["namespace"]}/{r["name"]}' for r in workloads
                    if r["annotations"] or any(c["telemetryEnv"] for c in r["containers"])
                ]}
    except subprocess.TimeoutExpired:
        return {"cluster": cluster, "error": "Kubernetes API timed out after 35 seconds"}


if __name__ == "__main__":
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        for item in pool.map(inspect, CLUSTERS):
            print(json.dumps(item), flush=True)
