#!/usr/bin/env python3
"""Read central backend ingestion through short-lived authenticated API tunnels."""
import contextlib
import json
from pathlib import Path
import socket
import subprocess
import time
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parent
KUBE = "/tmp/awsops-central-telemetry.bOV102/kubeconfig"


@contextlib.contextmanager
def forward(name, remote):
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    proc = subprocess.Popen(
        ["kubectl", "--kubeconfig", KUBE, "--context", "platform-cluster",
         "-n", "central-observability", "port-forward", "svc/" + name, f"{port}:{remote}"],
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
    )
    try:
        for _ in range(30):
            if proc.poll() is not None:
                raise RuntimeError(proc.stderr.read().decode())
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.3):
                    break
            except OSError:
                time.sleep(0.2)
        yield f"http://127.0.0.1:{port}"
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()


def get(base, path):
    with urllib.request.urlopen(base + path, timeout=15) as response:
        return json.load(response)


def query(base, path, **params):
    return get(base, path + "?" + urllib.parse.urlencode(params))


def main():
    evidence = {"checked_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    for name, port, prefix in [("prometheus", 9090, ""), ("mimir", 9009, "/prometheus")]:
        with forward(name, port) as url:
            evidence[name] = query(url, prefix + "/api/v1/query", query="count by (cluster,k8s_cluster_name) ({__name__=~\"k8s_.*|container_.*\"})")
        print(name, json.dumps(evidence[name]), flush=True)
    with forward("loki", 3100) as url:
        evidence["loki"] = get(url, "/loki/api/v1/label/k8s_cluster_name/values")
        print("loki", json.dumps(evidence["loki"]), flush=True)
    with forward("tempo", 3200) as url:
        evidence["tempo"] = get(url, "/api/v2/search/tag/resource.k8s.cluster.name/values")
        print("tempo", json.dumps(evidence["tempo"]), flush=True)
    with forward("jaeger", 16686) as url:
        evidence["jaeger"] = get(url, "/api/v3/services")
        print("jaeger", json.dumps(evidence["jaeger"]), flush=True)
    with forward("clickhouse", 8123) as url:
        password = Path("/tmp/awsops-central-telemetry.bOV102/pki/clickhouse-password").read_text()
        sql = ("SELECT 'logs' AS signal, ResourceAttributes['k8s.cluster.name'] AS cluster, count() AS records "
               "FROM otel.otel_logs WHERE Timestamp > now()-INTERVAL 15 MINUTE GROUP BY cluster "
               "UNION ALL SELECT 'traces', ResourceAttributes['k8s.cluster.name'], count() "
               "FROM otel.otel_traces WHERE Timestamp > now()-INTERVAL 15 MINUTE GROUP BY 2 FORMAT JSON")
        req = urllib.request.Request(url, data=sql.encode(),
                                     headers={"X-ClickHouse-User": "telemetry", "X-ClickHouse-Key": password})
        with urllib.request.urlopen(req, timeout=15) as response:
            evidence["clickhouse"] = json.load(response)
        print("clickhouse", json.dumps(evidence["clickhouse"].get("data")), flush=True)
    (ROOT / "verification.json").write_text(json.dumps(evidence, indent=2) + "\n")


if __name__ == "__main__":
    main()
