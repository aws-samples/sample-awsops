#!/usr/bin/env python3
"""Confirm Jaeger resource cluster labels without printing trace payloads."""
import datetime
import json
from pathlib import Path
import urllib.parse
import urllib.request
from verify import forward

end = datetime.datetime.now(datetime.timezone.utc)
start = end - datetime.timedelta(minutes=30)
checks = {
    "appmesh-lattice-mig": "backend",
    "ekscluster01-ipvs": "amazon-cloudwatch.cloudwatch-agent",
    "gpu-cluster-01": "isaac-controller",
}
evidence = {}
with forward("jaeger", 16686) as url:
    for cluster, service in checks.items():
        params = {
            "query.service_name": service,
            "query.attributes": json.dumps({"k8s.cluster.name": cluster}),
            "query.start_time_min": start.isoformat(),
            "query.start_time_max": end.isoformat(),
            "query.search_depth": "2",
        }
        request_url = url + "/api/v3/traces?" + urllib.parse.urlencode(params)
        try:
            with urllib.request.urlopen(request_url, timeout=15) as response:
                lines = response.read().decode().splitlines()
            clusters = set()
            count = 0
            for line in lines:
                result = json.loads(line).get("result", {})
                for resource in result.get("resourceSpans", []):
                    attrs = {a["key"]: a["value"].get("stringValue")
                             for a in resource.get("resource", {}).get("attributes", [])}
                    if attrs.get("k8s.cluster.name"):
                        clusters.add(attrs["k8s.cluster.name"])
                    for scope in resource.get("scopeSpans", []):
                        count += len(scope.get("spans", []))
            evidence[cluster] = {"service": service, "spans": count, "observed_cluster_labels": sorted(clusters)}
        except Exception as exc:
            evidence[cluster] = {"error": str(exc)}
Path(__file__).with_name("jaeger-verification.json").write_text(json.dumps(evidence, indent=2) + "\n")
print(json.dumps(evidence))
