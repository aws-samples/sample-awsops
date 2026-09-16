#!/usr/bin/env python3
"""Explicitly marked test telemetry: verify 24 paths without changing existing collectors."""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import shlex
import subprocess
import sys
import time
import urllib.error
import urllib.request

from build import ROUTES
from verify import forward, get, query

ROOT = Path(__file__).resolve().parent
KUBE = "/tmp/awsops-central-telemetry.bOV102/kubeconfig"
NS = "telemetry-check-20260916"


def k(cluster, *args, body=None):
    result = subprocess.run(
        ["kubectl", "--kubeconfig", KUBE, "--context", cluster, "--request-timeout=20s", *args],
        input=body, capture_output=True, text=True, timeout=35)
    if result.returncode:
        raise RuntimeError(result.stderr[-2000:])
    return result.stdout


def deploy_one(cluster, state):
    stamp = state["timestamp_ns"]
    trace = state["traces"][cluster]
    resource = {"attributes": [
        {"key": "service.name", "value": {"stringValue": "telemetry-validation"}},
        {"key": "telemetry.validation", "value": {"boolValue": True}},
        {"key": "validation_id", "value": {"stringValue": state["id"]}},
    ]}
    metrics = {"resourceMetrics": [{
        "resource": resource, "scopeMetrics": [{"scope": {"name": "telemetry-validation"},
        "metrics": [{"name": "central_telemetry_validation", "gauge": {"dataPoints": [{
            "attributes": [{"key": "validation_id", "value": {"stringValue": state["id"]}}],
            "timeUnixNano": str(stamp), "asDouble": 1,
        }]}}]}],
    }]}
    spans = {"resourceSpans": [{
        "resource": resource, "scopeSpans": [{"scope": {"name": "telemetry-validation"},
        "spans": [{"traceId": trace, "spanId": trace[:16], "name": "central-route-validation",
                   "kind": 2, "startTimeUnixNano": str(stamp), "endTimeUnixNano": str(stamp + 1000000)}]}],
    }]}
    commands = [
        "sleep 5",
        "printf '%s\\n' " + shlex.quote(f"telemetry-validation {state['id']} cluster={cluster} begin"),
    ]
    endpoint = "http://telemetry-cluster.telemetry-system.svc:4318"
    for signal, body in [("metrics", metrics), ("traces", spans)]:
        commands.append("wget -q -T 20 -O- --header='Content-Type: application/json' --post-data="
                        + shlex.quote(json.dumps(body)) + " " + endpoint + "/v1/" + signal)
    for i in range(3):
        commands += ["sleep 3", "printf '%s\\n' " + shlex.quote(
            f"telemetry-validation {state['id']} cluster={cluster} sample={i}")]
    spec = {
        "restartPolicy": "Never", "automountServiceAccountToken": False,
        "nodeSelector": {"kubernetes.io/os": "linux"},
        "securityContext": {"runAsUser": 101, "runAsGroup": 101, "runAsNonRoot": True},
        "containers": [{
            "name": "probe", "image": "public.ecr.aws/nginx/nginx:1.27-alpine",
            "command": ["/bin/sh", "-ec"], "args": ["\n".join(commands)],
            "resources": {"requests": {"cpu": "25m", "memory": "32Mi"}, "limits": {"memory": "64Mi"}},
            "securityContext": {"readOnlyRootFilesystem": True, "allowPrivilegeEscalation": False,
                                "capabilities": {"drop": ["ALL"]}},
        }],
    }
    # Reserve the freed slots on existing benchmark nodes for the collectors.
    if cluster.startswith("ekscluster01-"):
        nodes = json.loads(k(cluster, "get", "nodes", "-o", "json"))["items"]
        newest = max(nodes, key=lambda n: n["metadata"]["creationTimestamp"])
        spec["nodeSelector"]["kubernetes.io/hostname"] = newest["metadata"]["labels"]["kubernetes.io/hostname"]
    objects = [
        {"apiVersion": "v1", "kind": "Namespace",
         "metadata": {"name": NS, "labels": {"purpose": "central-telemetry-validation"}}},
        {"apiVersion": "batch/v1", "kind": "Job", "metadata": {"name": state["job"], "namespace": NS},
         "spec": {"backoffLimit": 0, "activeDeadlineSeconds": 120, "ttlSecondsAfterFinished": 600,
                  "template": {"metadata": {"labels": {"app": "telemetry-validation"},
                    "annotations": {f"instrumentation.opentelemetry.io/inject-{language}": "false"
                                    for language in ("java", "nodejs", "python", "dotnet")}},
                               "spec": spec}}},
    ]
    k(cluster, "apply", "-f", "-", body=json.dumps({"apiVersion": "v1", "kind": "List", "items": objects}))
    print(cluster + ": validation Job submitted", flush=True)


def deploy():
    ident = "v" + time.strftime("%H%M%S", time.gmtime())
    state = {"id": ident, "job": "telemetry-" + ident, "timestamp_ns": time.time_ns(),
             "namespace": NS, "traces": {
                 cluster: hashlib.sha256((ident + cluster).encode()).hexdigest()[:32] for cluster in ROUTES}}
    (ROOT / "smoke-run.json").write_text(json.dumps(state, indent=2) + "\n")
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(lambda c: deploy_one(c, state), ROUTES))


def clickhouse(url, sql):
    password = Path("/tmp/awsops-central-telemetry.bOV102/pki/clickhouse-password").read_text()
    req = urllib.request.Request(url, data=(sql + " FORMAT JSON").encode(),
                                 headers={"X-ClickHouse-User": "telemetry", "X-ClickHouse-Key": password})
    with urllib.request.urlopen(req, timeout=20) as response:
        return json.load(response)["data"]


def present(url, path):
    try:
        with urllib.request.urlopen(urllib.request.Request(url + path, headers={"Accept": "application/json"}),
                                    timeout=15) as response:
            data = response.read()
        return bool(data) and (b"resourceSpans" in data or b"resource_spans" in data or b"batches" in data)
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return False
        raise


def verify():
    state = json.loads((ROOT / "smoke-run.json").read_text())
    ident = state["id"]
    observed = {}
    for name, port, prefix in [("prometheus", 9090, ""), ("mimir", 9009, "/prometheus")]:
        with forward(name, port) as url:
            data = query(url, prefix + "/api/v1/query",
                         query=f'central_telemetry_validation{{validation_id="{ident}"}}',
                         time=state["timestamp_ns"] / 1e9 + 60)
            observed["metrics/" + name] = sorted({r["metric"]["cluster"] for r in data["data"]["result"]})
    with forward("loki", 3100) as url:
        data = query(url, "/loki/api/v1/query",
                     query=f'count_over_time({{k8s_namespace_name="{NS}"}} |= "{ident}" [30m])')
        observed["logs/loki"] = sorted({r["metric"]["k8s_cluster_name"] for r in data["data"]["result"]})
    for name, port, prefix in [("tempo", 3200, "/api/v2/traces/"), ("jaeger", 16686, "/api/v3/traces/")]:
        with forward(name, port) as url:
            observed["traces/" + name] = sorted(
                cluster for cluster, trace in state["traces"].items() if present(url, prefix + trace))
    with forward("clickhouse", 8123) as url:
        for signal, table, condition in [
            ("logs", "otel_logs", f"Body LIKE '%telemetry-validation {ident}%'"),
            ("traces", "otel_traces", "TraceId IN (" + ",".join("'" + t + "'" for t in state["traces"].values()) + ")"),
        ]:
            rows = clickhouse(url, f"SELECT ResourceAttributes['k8s.cluster.name'] AS cluster, count() AS records "
                                  f"FROM otel.{table} WHERE {condition} GROUP BY cluster")
            observed[signal + "/clickhouse"] = sorted(r["cluster"] for r in rows)
    expected = {}
    for cluster, signals in ROUTES.items():
        for signal, sink in signals.items():
            expected.setdefault(signal + "/" + sink, []).append(cluster)
    expected = {key: sorted(value) for key, value in expected.items()}
    results = {key: {"expected": expected[key], "observed": observed.get(key, []),
                     "passed": expected[key] == observed.get(key, [])} for key in expected}
    report = {"test_id": ident, "explicit_test_data": True,
              "passed": all(r["passed"] for r in results.values()), "results": results,
              "checked_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    (ROOT / "smoke-verification.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report), flush=True)


if __name__ == "__main__":
    {"deploy": deploy, "verify": verify}[sys.argv[1]]()
