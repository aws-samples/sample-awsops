#!/usr/bin/env python3
"""Assert single-destination routing against the captured live configuration."""
import json
from pathlib import Path
import yaml

ROOT = Path(__file__).resolve().parent
routes = json.loads((ROOT / "routes.json").read_text())
objects = list(yaml.safe_load_all((ROOT / "deployed/central.yaml").read_text()))
cm = next(o for o in objects if o["kind"] == "ConfigMap" and o["metadata"]["name"] == "telemetry-gateway")
gateway = yaml.safe_load(cm["data"]["config.yaml"])
assert len(routes) == 8
verified = 0
for signal in ("metrics", "logs", "traces"):
    connector = gateway["connectors"]["routing/" + signal]
    assert not connector.get("default_pipelines")
    assert len(connector["table"]) == len(routes)
    conditions = set()
    for cluster, selection in routes.items():
        condition = f'resource.attributes["k8s.cluster.name"] == "{cluster}"'
        row = next(r for r in connector["table"] if r["condition"] == condition)
        assert row["action"] == "move"
        assert row["pipelines"] == [f"{signal}/{selection[signal]}"]
        pipeline = gateway["service"]["pipelines"][row["pipelines"][0]]
        assert len(pipeline["exporters"]) == 1
        assert condition not in conditions
        conditions.add(condition)
        verified += 1
for cluster in routes:
    for o in yaml.safe_load_all((ROOT / "deployed" / (cluster + ".yaml")).read_text()):
        if o["kind"] != "ConfigMap" or o["metadata"]["name"] not in ("telemetry-node", "telemetry-cluster"):
            continue
        config = yaml.safe_load(o["data"]["config.yaml"])
        for pipeline in config["service"]["pipelines"].values():
            assert pipeline["exporters"] == ["otlp/central"]
evidence = {"source_clusters": len(routes), "verified_signal_routes": verified,
            "central_fanout_paths": 0,
            "basis": "live ConfigMaps captured in deployed/, not merely the planned generator"}
(ROOT / "routing-verification.json").write_text(json.dumps(evidence, indent=2) + "\n")
print(json.dumps(evidence))
