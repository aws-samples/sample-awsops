#!/usr/bin/env python3
"""Idempotently connect only the new mTLS telemetry NLB through PrivateLink."""
import json
from pathlib import Path
import subprocess
import time

ROOT = Path(__file__).resolve().parent
AWS = ["aws", "--profile", "samples-atomoh", "--region", "ap-northeast-2"]
NLB = "arn:aws:elasticloadbalancing:ap-northeast-2:061525506239:loadbalancer/net/k8s-centralo-telemetr-d3e79f7c1e/e46a84dbcc854a15"
SOURCES = {
    "workloads": {"vpc": "vpc-0151a6dcd10c1c738", "subnet": "subnet-015d50a97799cda56", "cidr": "10.11.0.0/16"},
    "gpu": {"vpc": "vpc-0dfa5610180dfa628", "subnet": "subnet-07b1e65682847dce9", "cidr": "10.100.0.0/16"},
}


def aws(*args):
    output = subprocess.run(AWS + list(args), check=True, capture_output=True, text=True).stdout
    return json.loads(output) if output.strip() else {}


def tags(kind, name):
    return json.dumps([{"ResourceType": kind, "Tags": [
        {"Key": "Name", "Value": name}, {"Key": "Project", "Value": "central-observability"},
    ]}])


def main():
    identity = aws("sts", "get-caller-identity")
    assert identity["Account"] == "061525506239"
    assert identity["Arn"].startswith("arn:aws:sts::061525506239:assumed-role/atomoh/")
    existing = aws("ec2", "describe-vpc-endpoint-service-configurations")["ServiceConfigurations"]
    service = next((s for s in existing if NLB in s.get("NetworkLoadBalancerArns", [])), None)
    if service is None:
        service = aws("ec2", "create-vpc-endpoint-service-configuration", "--acceptance-required",
                      "--network-load-balancer-arns", NLB,
                      "--tag-specifications", tags("vpc-endpoint-service", "central-observability"))["ServiceConfiguration"]
    aws("ec2", "modify-vpc-endpoint-service-permissions", "--service-id", service["ServiceId"],
        "--add-allowed-principals", "arn:aws:iam::061525506239:role/atomoh")
    evidence = {"service": service, "sources": {}}
    for name, source in SOURCES.items():
        groupname = "central-observability-vpce-" + name
        groups = aws("ec2", "describe-security-groups", "--filters",
                     f"Name=vpc-id,Values={source['vpc']}", f"Name=group-name,Values={groupname}")["SecurityGroups"]
        if groups:
            group = groups[0]["GroupId"]
        else:
            group = aws("ec2", "create-security-group", "--group-name", groupname,
                        "--description", "mTLS telemetry ingestion from this source VPC only",
                        "--vpc-id", source["vpc"],
                        "--tag-specifications", tags("security-group", groupname))["GroupId"]
        current = aws("ec2", "describe-security-groups", "--group-ids", group)["SecurityGroups"][0]
        if not any(p.get("FromPort") == 4317 and
                   any(r.get("CidrIp") == source["cidr"] for r in p.get("IpRanges", []))
                   for p in current["IpPermissions"]):
            aws("ec2", "authorize-security-group-ingress", "--group-id", group,
                "--ip-permissions", json.dumps([{"IpProtocol": "tcp", "FromPort": 4317, "ToPort": 4317,
                    "IpRanges": [{"CidrIp": source["cidr"], "Description": "Only mTLS OTLP ingestion"}]}]))
        endpoints = aws("ec2", "describe-vpc-endpoints", "--filters",
                        f"Name=vpc-id,Values={source['vpc']}",
                        f"Name=service-name,Values={service['ServiceName']}")["VpcEndpoints"]
        endpoint = next((e for e in endpoints if e["State"] not in ("deleted", "deleting", "failed", "rejected")), None)
        if endpoint is None:
            endpoint = aws("ec2", "create-vpc-endpoint", "--vpc-id", source["vpc"],
                           "--vpc-endpoint-type", "Interface", "--service-name", service["ServiceName"],
                           "--subnet-ids", source["subnet"], "--security-group-ids", group,
                           "--no-private-dns-enabled",
                           "--tag-specifications", tags("vpc-endpoint", groupname))["VpcEndpoint"]
        if endpoint["State"] == "pendingAcceptance":
            for attempt in range(10):
                result = aws("ec2", "accept-vpc-endpoint-connections", "--service-id", service["ServiceId"],
                             "--vpc-endpoint-ids", endpoint["VpcEndpointId"])
                if not result.get("Unsuccessful"):
                    break
                assert all(x["Error"]["Code"] == "Unavailable" for x in result["Unsuccessful"]), result
                time.sleep(3)
            assert not result.get("Unsuccessful"), result
        endpoint = aws("ec2", "describe-vpc-endpoints",
                       "--vpc-endpoint-ids", endpoint["VpcEndpointId"])["VpcEndpoints"][0]
        evidence["sources"][name] = {
            **source, "security_group": group, "id": endpoint["VpcEndpointId"],
            "dns": endpoint["DnsEntries"][0]["DnsName"], "state": endpoint["State"],
        }
        print(f"{name}: {endpoint['VpcEndpointId']} {endpoint['State']}", flush=True)
    (ROOT / "network.json").write_text(json.dumps(evidence, indent=2) + "\n")


if __name__ == "__main__":
    main()
