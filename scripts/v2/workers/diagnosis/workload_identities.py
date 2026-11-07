"""Exact workload identity projections; configuration never proves application calls."""
import ipaddress
import re

from botocore.exceptions import BotoCoreError, ClientError

from .scoped_clients import ScopeError


def task_address(task, subnet_vpcs):
    if task.get("last_status") != "RUNNING":
        return {}
    candidates = set()
    attachments = task.get("attachments", [])
    if not isinstance(attachments, list) or len(attachments) > 4:
        return {}
    for attachment in attachments:
        if not isinstance(attachment, dict) or attachment.get("Type") != "ElasticNetworkInterface":
            continue
        details = attachment.get("Details", [])
        if not isinstance(details, list) or len(details) > 8:
            return {}
        subnets = {d.get("Value") for d in details if isinstance(d, dict) and d.get("Name") == "subnetId"}
        addresses = {d.get("Value") for d in details if isinstance(d, dict) and d.get("Name") == "privateIPv4Address"}
        if len(subnets) != 1 or len(addresses) != 1:
            return {}
        subnet, address = next(iter(subnets)), next(iter(addresses))
        vpcs = subnet_vpcs.get(subnet, set())
        if len(vpcs) != 1 or not next(iter(vpcs)):
            return {}
        vpc = next(iter(vpcs))
        if task.get("vpc_id") and task["vpc_id"] != vpc:
            return {}
        try:
            ipaddress.ip_address(address)
        except (ValueError, TypeError):
            return {}
        candidates.add((address, subnet, vpc))
    if len(candidates) != 1:
        return {}
    address, subnet, vpc = next(iter(candidates))
    return {"private_ip_address": address, "subnet_id": subnet, "vpc_id": vpc}


def _vpc(value):
    return isinstance(value, str) and bool(value)


def proxy_target(target, resources, account, region, vpc):
    arn = target.get("TargetArn")
    # A missing VPC never matches rows that also lack one (None == None).
    if (not _vpc(vpc) or not isinstance(arn, str)
            or not arn.startswith(f"arn:aws:rds:{region}:{account}:db:")):
        return None
    matches = [r for r in resources if r["kind"] == "rds" and r["account"] == account
               and r["region"] == region and r["facts"].get("vpc_id") == vpc
               and r["facts"].get("arn", f"arn:aws:rds:{region}:{account}:db:{r['resource_id']}") == arn]
    return matches[0] if len(matches) == 1 else None


def project_tasks(bundle):
    from . import discovery as d
    qualified = {rid: e for e in bundle["evidence"] if e["source"] == "inventory"
                 and e["fresh"] and e["coverage"].get("complete") for rid in e["resource_ids"]}
    by_region = {}
    for resource in bundle["resources"]:
        if resource["kind"] == "subnet" and resource["id"] in qualified:
            by_region.setdefault(resource["region"], {}).setdefault(resource["resource_id"], set()).add(
                resource["facts"].get("vpc_id"))
    for resource in bundle["resources"]:
        if resource["kind"] != "ecs_task" or resource["id"] not in qualified:
            continue
        if resource["facts"].get("attachments_complete") is False:
            # A capped attachment list cannot prove the task's only address.
            d._mark(bundle, "incomplete", "workload_attachment_cap")
            d._mark(bundle, "gaps", "workload_address_unresolved")
            continue
        address = task_address(resource["facts"], by_region.get(resource["region"], {}))
        if not address:
            d._mark(bundle, "gaps", "workload_address_unresolved")
            continue
        resource["facts"] = {**resource["facts"], **address}
        d._evidence(bundle, "inventory_workload_binding", "inventory", [resource["id"]],
                    address, qualified[resource["id"]]["captured_at"], region=resource["region"],
                    fresh=True, coverage={"complete": True})


class _ProxyBound(Exception):
    """A self-imposed call cap or deadline: already disclosed as incomplete, never a source gap."""


def collect_proxies(bundle, budget, client_factory):
    from . import discovery as d
    account = bundle["coverage"]["account"]
    qualified = {rid for e in bundle["evidence"] if e["kind"] == "inventory" and e["fresh"]
                 and e["coverage"].get("complete") for rid in e["resource_ids"]}
    databases = [r for r in bundle["resources"] if r["kind"] == "rds" and r["id"] in qualified]
    calls = 0
    for region in sorted({r["region"] for r in databases}):
        if not d._available(bundle, budget):
            return
        try:
            def read(operation, **parameters):
                nonlocal calls
                if calls >= 16:
                    d._mark(bundle, "incomplete", "proxy_query_cap")
                    raise _ProxyBound()
                if not d._available(bundle, budget):  # marks discovery_deadline
                    raise _ProxyBound()
                calls += 1
                # IAM rds:DescribeDBProxies/DescribeDBProxyTargets/DescribeDBClusters (all read() calls): workers.tf
                # worker_diagnosis_network Sid DiagnosisObservationDiscovery (runtime_read_condition).
                return getattr(client_factory("rds", region, budget), operation)(**parameters)

            response = read("describe_db_proxies", MaxRecords=20)
            if response.get("Marker"):
                d._mark(bundle, "incomplete", "proxy_cap")
            for row in response.get("DBProxies", [])[:4]:
                if not d._available(bundle, budget):
                    return
                name, vpc, arn = row.get("DBProxyName"), row.get("VpcId"), row.get("DBProxyArn", "")
                if not _vpc(vpc):
                    d._mark(bundle, "gaps", "proxy_target_unresolved")
                    continue
                if vpc not in {r["facts"].get("vpc_id") for r in databases if r["region"] == region}:
                    continue
                if row.get("Status") != "available":
                    d._mark(bundle, "gaps", "proxy_not_available")
                    continue
                if (not isinstance(name, str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9-]{0,62}", name)
                        or not isinstance(arn, str)
                        or not arn.startswith(f"arn:aws:rds:{region}:{account}:db-proxy:")):
                    d._mark(bundle, "gaps", "proxy_identity_unresolved")
                    continue
                proxy = d._resource(bundle, account, region, "rds_proxy", arn,
                                    {"arn": arn, "endpoint_address": row.get("Endpoint", ""), "vpc_id": vpc})
                if proxy is None:
                    continue
                captured = d._now()
                d._evidence(bundle, "rds_proxy_configuration", "inventory", [proxy["id"]],
                            proxy["facts"], captured, region=region, fresh=True, coverage={"complete": True})
                try:
                    targets = read("describe_db_proxy_targets", DBProxyName=name, MaxRecords=20)
                except (ClientError, BotoCoreError, ScopeError):
                    d._mark(bundle, "gaps", "proxy_target_unresolved")
                    continue
                if targets.get("Marker"):
                    d._mark(bundle, "incomplete", "proxy_target_cap")
                for target in targets.get("Targets", [])[:20]:
                    database = proxy_target(target, databases, account, region, vpc)
                    if database is None and target.get("Type") == "TRACKED_CLUSTER":
                        try:
                            database = _cluster_target(bundle, budget, read, target, databases, account, region, vpc)
                        except (ClientError, BotoCoreError, ScopeError):
                            d._mark(bundle, "gaps", "proxy_target_unresolved")
                            continue
                    if database is None:
                        d._mark(bundle, "gaps", "proxy_target_unresolved")
                        continue
                    evidence = d._evidence(bundle, "rds_proxy_configuration", "configured_dependency",
                        [proxy["id"], database["id"]], {"relation": "proxy_target", "port": target.get("Port")},
                        captured, region=region, fresh=True, coverage={"complete": not bool(targets.get("Marker"))})
                    d._relationship(bundle, proxy["id"], database["id"], "configured_dependency", evidence)
            if len(response.get("DBProxies", [])) > 4:
                d._mark(bundle, "incomplete", "proxy_cap")
        except _ProxyBound:
            return  # The call budget is shared across regions: stop instead of re-recording per region.
        except (ClientError, BotoCoreError, ScopeError):
            d._mark(bundle, "gaps", "proxy_configuration_unavailable")
        except Exception:
            # A projection defect is not a provider outage: surface it as degraded, distinctly.
            d._mark(bundle, "degraded", "proxy_projection_failed")
            return


def _cluster_target(bundle, budget, read, target, databases, account, region, vpc):
    from . import discovery as d
    arn = target.get("TargetArn", "")
    if not _vpc(vpc) or not isinstance(arn, str) or not re.fullmatch(
            rf"arn:aws:rds:{re.escape(region)}:{re.escape(account)}:cluster:[A-Za-z0-9-]+", arn):
        return None
    if not d._available(bundle, budget):
        raise _ProxyBound()
    response = read("describe_db_clusters", DBClusterIdentifier=arn)
    clusters = response.get("DBClusters", [])
    if len(clusters) != 1 or response.get("Marker"):
        return None
    row = clusters[0]
    if row.get("DBClusterArn") != arn or row.get("Status") != "available":
        return None
    members = row.get("DBClusterMembers", [])
    if not isinstance(members, list) or not members:
        return None
    bound, seen, incomplete = [], set(), len(members) > 20
    for member in members[:20]:
        identity = member.get("DBInstanceIdentifier") if isinstance(member, dict) else None
        matches = [r for r in databases if r["account"] == account and r["region"] == region
                   and r["resource_id"] == identity and r["facts"].get("vpc_id") == vpc]
        if identity in seen or len(matches) != 1:
            d._mark(bundle, "gaps", "proxy_cluster_member_unresolved")
            incomplete = True
            continue
        seen.add(identity)
        bound.append(matches[0])
    if not bound:
        return None
    cluster = d._resource(bundle, account, region, "rds_cluster", arn,
        {"arn": arn, "endpoint_address": row.get("Endpoint", ""), "vpc_id": vpc})
    if cluster is None:
        return None
    captured = d._now()
    d._evidence(bundle, "rds_proxy_configuration", "inventory", [cluster["id"]], cluster["facts"],
                captured, region=region, fresh=True, coverage={"complete": True})
    for member in bound:
        item = d._evidence(bundle, "rds_proxy_configuration", "configured_dependency",
            [cluster["id"], member["id"]], {"relation": "cluster_member"}, captured,
            region=region, fresh=True, coverage={"complete": not incomplete})
        d._relationship(bundle, cluster["id"], member["id"], "configured_dependency", item)
    if incomplete:
        d._mark(bundle, "incomplete", "proxy_cluster_members_partial")
    return cluster
