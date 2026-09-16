#!/usr/bin/env python3
"""Render the scoped samples telemetry installation; never mutates AWS/Kubernetes."""
import copy
import hashlib
import json
from pathlib import Path
import yaml

ROOT = Path(__file__).resolve().parent
CENTRAL = "central-observability"
AGENTS = "telemetry-system"
OTEL = "otel/opentelemetry-collector-contrib:0.161.0"
ROUTES = {
    "GPU01": {"metrics": "prometheus", "logs": "clickhouse", "traces": "tempo"},
    "appmesh-lattice-mig": {"metrics": "prometheus", "logs": "loki", "traces": "jaeger"},
    "ekscluster01-iptables": {"metrics": "prometheus", "logs": "loki", "traces": "tempo"},
    "ekscluster01-ipvs": {"metrics": "mimir", "logs": "loki", "traces": "jaeger"},
    "ekscluster01-nftables": {"metrics": "mimir", "logs": "clickhouse", "traces": "clickhouse"},
    "eksworkshop": {"metrics": "mimir", "logs": "clickhouse", "traces": "tempo"},
    "gpu-cluster-01": {"metrics": "mimir", "logs": "clickhouse", "traces": "jaeger"},
    "platform-cluster": {"metrics": "prometheus", "logs": "loki", "traces": "clickhouse"},
}


def obj(kind, name, spec=None, namespace=CENTRAL, api="v1"):
    result = {"apiVersion": api, "kind": kind, "metadata": {"name": name}}
    if namespace:
        result["metadata"]["namespace"] = namespace
    if spec is not None:
        result["spec"] = spec
    return result


def cm(name, config, namespace=CENTRAL, key="config.yaml"):
    result = obj("ConfigMap", name, namespace=namespace)
    result["data"] = {key: yaml.safe_dump(config, sort_keys=False) if not isinstance(config, str) else config}
    return result


def service(name, ports, namespace=CENTRAL):
    return obj("Service", name, {
        "selector": {"app": name},
        "ports": [{"name": n, "port": p, "targetPort": p} for n, p in ports],
    }, namespace)


def workload(name, image, args, ports, memory, cpu="100m", disk=None, config=True,
             uid=10001, namespace=CENTRAL, kind="Deployment", extra=None):
    container = {
        "name": name, "image": image, "args": args,
        "ports": [{"name": n, "containerPort": p} for n, p in ports],
        "resources": {"requests": {"cpu": cpu, "memory": memory},
                      "limits": {"memory": memory}},
        "securityContext": {"allowPrivilegeEscalation": False,
                            "capabilities": {"drop": ["ALL"]}},
        "volumeMounts": [],
    }
    pod = {
        "nodeSelector": {"kubernetes.io/os": "linux", "kubernetes.io/arch": "arm64"},
        "automountServiceAccountToken": False,
        "securityContext": {"runAsUser": uid, "runAsGroup": uid, "fsGroup": uid},
        "containers": [container], "volumes": [],
    }
    if config:
        pod["volumes"].append({"name": "config", "configMap": {"name": name}})
        container["volumeMounts"].append({"name": "config", "mountPath": "/conf", "readOnly": True})
    spec = {"replicas": 1, "selector": {"matchLabels": {"app": name}},
            "template": {"metadata": {"labels": {"app": name}}, "spec": pod}}
    if disk:
        kind = "StatefulSet"
        spec["serviceName"] = name
        spec["volumeClaimTemplates"] = [{
            "metadata": {"name": "data"},
            "spec": {"accessModes": ["ReadWriteOnce"], "storageClassName": "telemetry-gp3",
                     "resources": {"requests": {"storage": disk}}},
        }]
        container["volumeMounts"].append({"name": "data", "mountPath": "/data"})
        container["workingDir"] = "/data"
    else:
        spec["strategy"] = {"type": "Recreate"}
    if extra:
        extra(pod, container)
    return obj(kind, name, spec, namespace, "apps/v1")


def probe(work, port, path):
    container = work["spec"]["template"]["spec"]["containers"][0]
    container["readinessProbe"] = {"httpGet": {"path": path, "port": port},
                                   "initialDelaySeconds": 5, "periodSeconds": 10}
    container["startupProbe"] = {"httpGet": {"path": path, "port": port},
                                 "failureThreshold": 60, "periodSeconds": 5}
    return work


def write(name, objects):
    (ROOT / name).write_text(yaml.safe_dump_all(objects, sort_keys=False))


def central():
    objects = [obj("Namespace", CENTRAL, namespace=None)]
    storage = obj("StorageClass", "telemetry-gp3", namespace=None, api="storage.k8s.io/v1")
    storage.update({
        "provisioner": "ebs.csi.eks.amazonaws.com", "parameters": {"type": "gp3", "encrypted": "true"},
        "reclaimPolicy": "Retain", "allowVolumeExpansion": True,
        "volumeBindingMode": "WaitForFirstConsumer",
    })
    objects.append(storage)
    configs = {
        "prometheus": {"global": {"scrape_interval": "60s"}, "scrape_configs": []},
        "mimir": {
            "target": "all", "multitenancy_enabled": False,
            "server": {"http_listen_port": 9009, "grpc_listen_port": 9095},
            "ingest_storage": {"enabled": False},
            "common": {"storage": {"backend": "filesystem", "filesystem": {"dir": "/data/storage"}}},
            "blocks_storage": {"backend": "filesystem", "filesystem": {"dir": "/data/blocks"},
                               "tsdb": {"dir": "/data/tsdb"},
                               "bucket_store": {"sync_dir": "/data/tsdb-sync"}},
            "ingester": {"ring": {"replication_factor": 1, "kvstore": {"store": "inmemory"}}},
            "compactor": {"data_dir": "/data/compactor", "sharding_ring": {"kvstore": {"store": "inmemory"}}},
            "store_gateway": {"sharding_ring": {"replication_factor": 1, "kvstore": {"store": "inmemory"}}},
            "ruler": {"rule_path": "/data/rules", "ring": {"kvstore": {"store": "inmemory"}}},
            "ruler_storage": {"backend": "filesystem", "filesystem": {"dir": "/data/ruler-storage"}},
            "limits": {"compactor_blocks_retention_period": "168h", "max_global_series_per_user": 500000},
            "usage_stats": {"enabled": False},
        },
        "loki": {
            "auth_enabled": False, "server": {"http_listen_port": 3100},
            "common": {"path_prefix": "/data", "replication_factor": 1,
                       "ring": {"kvstore": {"store": "inmemory"}},
                       "storage": {"filesystem": {"chunks_directory": "/data/chunks", "rules_directory": "/data/rules"}}},
            "schema_config": {"configs": [{"from": "2026-01-01", "store": "tsdb", "object_store": "filesystem",
                                          "schema": "v13", "index": {"prefix": "index_", "period": "24h"}}]},
            "compactor": {"working_directory": "/data/compactor", "retention_enabled": True,
                          "delete_request_store": "filesystem"},
            "limits_config": {"retention_period": "168h", "allow_structured_metadata": True,
                              "ingestion_rate_mb": 16, "ingestion_burst_size_mb": 32},
            "analytics": {"reporting_enabled": False},
        },
        "tempo": {
            "server": {"http_listen_port": 3200},
            "distributor": {"receivers": {"otlp": {"protocols": {
                "grpc": {"endpoint": "0.0.0.0:4317"}, "http": {"endpoint": "0.0.0.0:4318"}}}}},
            "ingester": {"max_block_duration": "5m"},
            "compactor": {"compaction": {"block_retention": "168h"}},
            "storage": {"trace": {"backend": "local", "wal": {"path": "/data/wal"},
                                  "local": {"path": "/data/blocks"}}},
            "usage_report": {"reporting_enabled": False},
        },
        "jaeger": {
            "extensions": {
                "healthcheckv2": {"use_v2": True, "http": {"endpoint": "0.0.0.0:13133"}},
                "jaeger_query": {"storage": {"traces": "persistent"},
                                 "http": {"endpoint": "0.0.0.0:16686"}},
                "jaeger_storage": {"backends": {"persistent": {"badger": {
                    "directories": {"keys": "/data/keys", "values": "/data/values"},
                    "ephemeral": False, "ttl": {"spans": "168h"}}}}},
            },
            "receivers": {"otlp": {"protocols": {"grpc": {"endpoint": "0.0.0.0:4317"}}}},
            "processors": {"batch": {}},
            "exporters": {"jaeger_storage_exporter": {"trace_storage": "persistent"}},
            "service": {"extensions": ["healthcheckv2", "jaeger_storage", "jaeger_query"],
                        "pipelines": {"traces": {"receivers": ["otlp"], "processors": ["batch"],
                                                 "exporters": ["jaeger_storage_exporter"]}}},
        },
    }
    objects.extend(cm(k, v) for k, v in configs.items())
    servers = [
        ("prometheus", "prom/prometheus:v3.14.0",
         ["--config.file=/conf/config.yaml", "--storage.tsdb.path=/data", "--storage.tsdb.retention.time=7d",
          "--storage.tsdb.retention.size=35GB", "--web.enable-remote-write-receiver"],
         [("http", 9090)], "2Gi", "250m", "40Gi", "/-/ready"),
        ("mimir", "grafana/mimir:3.2.1", ["-config.file=/conf/config.yaml"],
         [("http", 9009)], "2Gi", "250m", "40Gi", "/ready"),
        ("loki", "grafana/loki:3.7.7", ["-config.file=/conf/config.yaml"],
         [("http", 3100)], "1Gi", "200m", "50Gi", "/ready"),
        ("tempo", "grafana/tempo:2.10.8", ["-config.file=/conf/config.yaml"],
         [("http", 3200), ("otlp", 4317)], "1Gi", "200m", "30Gi", "/ready"),
        ("jaeger", "jaegertracing/jaeger:2.21.0", ["--config=/conf/config.yaml"],
         [("http", 16686), ("otlp", 4317), ("health", 13133)], "1Gi", "200m", "30Gi", "/"),
    ]
    for name, image, args, ports, memory, cpu, disk, path in servers:
        objects.append(service(name, ports))
        work = workload(name, image, args, ports, memory, cpu, disk)
        if name == "jaeger":
            # Observed Badger heap/cache pressure exceeded the initial 1Gi cap.
            # Keep the reservation and storage unchanged; allow a 2Gi peak.
            work["spec"]["template"]["spec"]["containers"][0]["resources"]["limits"]["memory"] = "2Gi"
        objects.append(probe(work, ports[0][1], path))
    # ClickHouse authentication comes only from a mounted Kubernetes Secret.
    ch_config = """<clickhouse>
  <listen_host>0.0.0.0</listen_host>
  <path>/data/clickhouse/</path>
  <tmp_path>/data/tmp/</tmp_path>
  <user_files_path>/data/user_files/</user_files_path>
  <format_schema_path>/data/format_schemas/</format_schema_path>
  <max_server_memory_usage>2684354560</max_server_memory_usage>
  <logger><level>warning</level><console>true</console></logger>
</clickhouse>
"""
    objects.append(cm("clickhouse", ch_config, key="telemetry.xml"))
    def ch_extra(pod, container):
        container["volumeMounts"] = [
            {"name": "config", "mountPath": "/etc/clickhouse-server/config.d/telemetry.xml", "subPath": "telemetry.xml"},
            {"name": "users", "mountPath": "/etc/clickhouse-server/users.d/telemetry.xml", "subPath": "users.xml"},
            {"name": "data", "mountPath": "/data"},
        ]
        pod["volumes"].append({"name": "users", "secret": {"secretName": "clickhouse-auth"}})
    ch = workload("clickhouse", "clickhouse/clickhouse-server:26.8.5.13",
                  ["--config-file=/etc/clickhouse-server/config.xml"],
                  [("http", 8123), ("native", 9000)], "3Gi", "500m", "60Gi", uid=101, extra=ch_extra)
    ch["spec"]["template"]["spec"]["containers"][0]["command"] = ["clickhouse-server"]
    objects += [service("clickhouse", [("http", 8123), ("native", 9000)]), probe(ch, 8123, "/ping")]

    exporters = {
        "prometheus_remote_write/prometheus": {
            "endpoint": "http://prometheus:9090/api/v1/write",
            "resource_to_telemetry_conversion": {"enabled": True}},
        "prometheus_remote_write/mimir": {
            "endpoint": "http://mimir:9009/api/v1/push",
            "resource_to_telemetry_conversion": {"enabled": True}},
        "otlp_http/loki": {"endpoint": "http://loki:3100/otlp"},
        "otlp/tempo": {"endpoint": "tempo:4317", "tls": {"insecure": True}},
        "otlp/jaeger": {"endpoint": "jaeger:4317", "tls": {"insecure": True}},
        "clickhouse": {
            "endpoint": "tcp://clickhouse:9000", "username": "telemetry",
            "password": "${file:/auth/password}", "database": "otel",
            "create_schema": True, "ttl": "168h", "async_insert": True,
            "timeout": "15s",
        },
    }
    # OTel's component IDs retain the established unseparated names in v0.161.
    exporters["prometheusremotewrite/prometheus"] = exporters.pop("prometheus_remote_write/prometheus")
    exporters["prometheusremotewrite/mimir"] = exporters.pop("prometheus_remote_write/mimir")
    exporters["otlphttp/loki"] = exporters.pop("otlp_http/loki")
    for name, export in exporters.items():
        if not name.startswith("prometheusremotewrite"):
            export["sending_queue"] = {"enabled": True, "queue_size": 2000,
                                        "storage": "file_storage", "num_consumers": 2}
        export["retry_on_failure"] = {"enabled": True, "max_elapsed_time": "0s"}
    config = {
        "extensions": {"health_check": {"endpoint": "0.0.0.0:13133"},
                       "file_storage": {"directory": "/data/queue", "create_directory": True}},
        "receivers": {"otlp": {"protocols": {"grpc": {
            "endpoint": "0.0.0.0:4317",
            "tls": {"cert_file": "/tls/tls.crt", "key_file": "/tls/tls.key", "client_ca_file": "/tls/ca.crt"},
        }}}},
        "processors": {"memory_limiter": {"check_interval": "1s", "limit_mib": 1500, "spike_limit_mib": 256},
                       "batch": {"timeout": "5s", "send_batch_size": 2048, "send_batch_max_size": 4096}},
        "exporters": exporters, "connectors": {},
        "service": {"extensions": ["health_check", "file_storage"], "pipelines": {}},
    }
    for signal in ("metrics", "logs", "traces"):
        connector = "routing/" + signal
        config["connectors"][connector] = {
            "error_mode": "propagate",
            "table": [
                {"condition": f'resource.attributes["k8s.cluster.name"] == "{cluster}"',
                 "action": "move", "pipelines": [f"{signal}/{route[signal]}"]}
                for cluster, route in ROUTES.items()
            ],
        }
        config["service"]["pipelines"][signal + "/input"] = {
            "receivers": ["otlp"], "processors": ["memory_limiter"], "exporters": [connector],
        }
        for sink in sorted({v[signal] for v in ROUTES.values()}):
            exporter = {"prometheus": "prometheusremotewrite/prometheus", "mimir": "prometheusremotewrite/mimir",
                        "loki": "otlphttp/loki", "tempo": "otlp/tempo",
                        "jaeger": "otlp/jaeger", "clickhouse": "clickhouse"}[sink]
            config["service"]["pipelines"][f"{signal}/{sink}"] = {
                "receivers": [connector], "processors": ["batch"], "exporters": [exporter],
            }
    objects.append(cm("telemetry-gateway", config))
    def gateway_extra(pod, container):
        pod["volumes"] += [{"name": "tls", "secret": {"secretName": "telemetry-server-tls"}},
                           {"name": "auth", "secret": {"secretName": "clickhouse-auth"}}]
        container["volumeMounts"] += [{"name": "tls", "mountPath": "/tls", "readOnly": True},
                                     {"name": "auth", "mountPath": "/auth", "readOnly": True}]
    gateway = workload("telemetry-gateway", OTEL, ["--config=/conf/config.yaml"],
                       [("otlp", 4317), ("health", 13133)], "2Gi", "500m", "10Gi", extra=gateway_extra)
    objects.append(probe(gateway, 13133, "/"))
    svc = service("telemetry-gateway", [("otlp", 4317)])
    svc["spec"].update({"type": "LoadBalancer", "loadBalancerClass": "eks.amazonaws.com/nlb",
                        "loadBalancerSourceRanges": ["10.90.0.0/16", "10.11.0.0/16", "10.100.0.0/16"]})
    svc["metadata"]["annotations"] = {
        "service.beta.kubernetes.io/aws-load-balancer-scheme": "internal",
        "service.beta.kubernetes.io/aws-load-balancer-nlb-target-type": "ip",
        "service.beta.kubernetes.io/aws-load-balancer-subnets": "subnet-04df3a4a31dc47d03,subnet-0be14f7c31f22bd51",
        "service.beta.kubernetes.io/aws-load-balancer-attributes": "load_balancing.cross_zone.enabled=true",
        "service.beta.kubernetes.io/aws-load-balancer-additional-resource-tags": "Project=central-observability,ManagedBy=Codex,Account=samples",
    }
    objects.append(svc)
    # Backends accept only the central namespace; none has a public endpoint.
    objects.append(obj("NetworkPolicy", "backend-ingress", {
        "podSelector": {"matchExpressions": [{"key": "app", "operator": "In",
                                             "values": list(configs) + ["clickhouse"]}]},
        "policyTypes": ["Ingress"], "ingress": [{"from": [{"podSelector": {}}]}],
    }, api="networking.k8s.io/v1"))
    # A single-replica stateful backend must not be voluntarily evicted during
    # Auto Mode consolidation; volume reattachment otherwise interrupts ingest.
    budgets = [obj("PodDisruptionBudget", name, {
        "minAvailable": 1, "selector": {"matchLabels": {"app": name}},
    }, api="policy/v1") for name in list(configs) + ["clickhouse", "telemetry-gateway"]]
    objects.extend(budgets)
    write("central-disruption-budgets.yaml", budgets)
    checksums = {o["metadata"]["name"]: hashlib.sha256(json.dumps(o["data"], sort_keys=True).encode()).hexdigest()
                 for o in objects if o["kind"] == "ConfigMap"}
    for o in objects:
        if o["kind"] in ("Deployment", "StatefulSet"):
            o["spec"]["template"]["metadata"]["annotations"] = {
                "checksum/config": checksums[o["metadata"]["name"]]}
    write("central.yaml", objects)
    (ROOT / "routes.json").write_text(json.dumps(ROUTES, indent=2) + "\n")


if __name__ == "__main__":
    central()
