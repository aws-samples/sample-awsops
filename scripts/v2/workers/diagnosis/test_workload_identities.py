"""ENI ownership and DB proxy configuration need exact scoped corroboration."""
from diagnosis import workload_identities as identities
from diagnosis.test_discovery import ACCOUNT, REGION, NOW, Budget
import pytest


@pytest.mark.parametrize("change,marker", [
    ({"Status": "modifying"}, "proxy_not_available"),
    ({"DBProxyName": "invalid:name"}, "proxy_identity_unresolved"),
    ({"DBProxyArn": None}, "proxy_identity_unresolved"),
])
def test_unqualified_in_scope_proxy_is_disclosed_and_later_proxy_survives(monkeypatch, change, marker):
    from diagnosis import discovery as d
    monkeypatch.setattr(d, "_now", lambda: NOW)
    db = {"id": "r:db", "resource_id": "orders", "kind": "rds", "region": REGION,
          "account": ACCOUNT, "facts": {"vpc_id": "vpc-a"}}
    bundle = {"resources": [db], "relationships": [], "coverage": {"account": ACCOUNT},
              "gaps": [], "incomplete": [], "degraded": [], "evidence": [
        {"id": "e:db", "kind": "inventory", "source": "inventory", "resource_ids": [db["id"]],
         "fresh": True, "coverage": {"complete": True}}]}
    base = {"DBProxyName": "orders-proxy", "Status": "available", "VpcId": "vpc-a",
            "DBProxyArn": f"arn:aws:rds:{REGION}:{ACCOUNT}:db-proxy:prx-1"}
    class Rds:
        def describe_db_proxies(self, **kwargs):
            return {"DBProxies": [{**base, **change},
                    {**base, **change, "VpcId": "vpc-other"},
                    {**base, "DBProxyArn": base["DBProxyArn"] + "-later"}]}
        def describe_db_proxy_targets(self, **kwargs):
            return {"Targets": []}
    identities.collect_proxies(bundle, Budget(), lambda *args: Rds())
    assert bundle["gaps"] == [marker]
    assert any(row["resource_id"].endswith("-later") for row in bundle["resources"])
    assert len(bundle["resources"]) == 2


def test_cluster_deadline_is_a_bound_and_never_an_unresolved_target():
    from diagnosis import discovery as d
    bundle = {"coverage": {}, "incomplete": [], "gaps": []}
    def forbidden(*args, **kwargs):
        raise AssertionError("No provider call after deadline")
    with pytest.raises(identities._ProxyBound):
        identities._cluster_target(bundle, Budget(seconds=0), forbidden,
            {"TargetArn": f"arn:aws:rds:{REGION}:{ACCOUNT}:cluster:orders"},
            [], ACCOUNT, REGION, "vpc-a")
    assert bundle["incomplete"] == ["discovery_deadline"] and bundle["gaps"] == []


def test_proxy_aurora_cluster_links_only_exact_qualified_members(monkeypatch):
    from diagnosis import discovery as d
    monkeypatch.setattr(d, "_now", lambda: NOW)
    arn = f"arn:aws:rds:{REGION}:{ACCOUNT}:cluster:orders"
    db = {"id": "r:db", "resource_id": "orders-1", "kind": "rds", "region": REGION,
          "account": ACCOUNT, "facts": {"vpc_id": "vpc-a", "arn": arn.replace("cluster:orders", "db:orders-1")}}
    bundle = {"resources": [db], "relationships": [], "coverage": {"account": ACCOUNT},
              "gaps": [], "incomplete": [], "degraded": [], "evidence": [
        {"id": "e:db", "kind": "inventory", "source": "inventory", "resource_ids": [db["id"]],
         "fresh": True, "coverage": {"complete": True}}]}

    class Rds:
        def describe_db_proxies(self, **kwargs):
            return {"DBProxies": [{"DBProxyName": "orders-proxy", "Status": "available", "VpcId": "vpc-a",
                    "DBProxyArn": f"arn:aws:rds:{REGION}:{ACCOUNT}:db-proxy:prx-1", "Endpoint": "proxy.example.test"}]}

        def describe_db_proxy_targets(self, **kwargs):
            return {"Targets": [{"TargetArn": arn, "Type": "TRACKED_CLUSTER", "Port": 5432}]}

        def describe_db_clusters(self, **kwargs):
            assert kwargs["DBClusterIdentifier"] == arn
            return {"DBClusters": [{"DBClusterArn": arn, "DBClusterIdentifier": "orders", "Status": "available",
                "Endpoint": "cluster.example.test", "DBClusterMembers": [
                    {"DBInstanceIdentifier": "orders-1", "IsClusterWriter": True},
                    {"DBInstanceIdentifier": "foreign", "IsClusterWriter": False}]}]}

    identities.collect_proxies(bundle, Budget(), lambda *args: Rds())
    kinds = {r["kind"] for r in bundle["resources"]}
    assert kinds == {"rds", "rds_proxy", "rds_cluster"}
    assert len(bundle["relationships"]) == 2
    assert all(r["kind"] == "configured_dependency" for r in bundle["relationships"])
    assert "proxy_cluster_member_unresolved" in bundle["gaps"]


def test_task_requires_running_and_subnet_vpc_corroboration():
    task = {"last_status": "RUNNING", "attachments": [{"Type": "ElasticNetworkInterface", "Details": [
        {"Name": "subnetId", "Value": "subnet-a"},
        {"Name": "privateIPv4Address", "Value": "10.0.1.5"}]}]}
    assert identities.task_address(task, {"subnet-a": {"vpc-a"}}) == {
        "private_ip_address": "10.0.1.5", "subnet_id": "subnet-a", "vpc_id": "vpc-a"}
    assert identities.task_address(task, {}) == {}
    assert identities.task_address(task, {"subnet-a": {"vpc-a", "vpc-b"}}) == {}
    assert identities.task_address({**task, "last_status": "STOPPED"}, {"subnet-a": {"vpc-a"}}) == {}


def test_multiple_addresses_cannot_collapse_to_one_workload():
    task = {"last_status": "RUNNING", "attachments": [{"Type": "ElasticNetworkInterface", "Details": [
        {"Name": "subnetId", "Value": "subnet-a"},
        {"Name": "privateIPv4Address", "Value": "10.0.1.5"},
        {"Name": "privateIPv4Address", "Value": "10.0.1.6"}]}]}
    assert identities.task_address(task, {"subnet-a": {"vpc-a"}}) == {}


def test_proxy_target_uses_exact_database_arn_and_vpc():
    arn = "arn:aws:rds:ap-northeast-2:111122223333:db:orders"
    db = {"id": "r:orders", "kind": "rds", "account": "111122223333", "region": "ap-northeast-2",
          "resource_id": "orders", "facts": {"arn": arn, "vpc_id": "vpc-a"}}
    assert identities.proxy_target({"TargetArn": arn}, [db], db["account"], db["region"], "vpc-a") == db
    assert identities.proxy_target({"TargetArn": arn}, [db, db], db["account"], db["region"], "vpc-a") is None
    assert identities.proxy_target({"TargetArn": arn}, [db], db["account"], db["region"], "vpc-b") is None
    assert identities.proxy_target({"Endpoint": "orders"}, [db], db["account"], db["region"], "vpc-a") is None


def test_incomplete_attachment_list_refuses_task_binding(monkeypatch):
    from diagnosis import discovery as d
    monkeypatch.setattr(d, "_now", lambda: NOW)
    captured = NOW.isoformat()
    attachments = [{"Type": "ElasticNetworkInterface", "Details": [
        {"Name": "subnetId", "Value": "subnet-a"}, {"Name": "privateIPv4Address", "Value": "10.0.1.5"}]}]

    def bundle(complete):
        task = {"id": "r:task", "account": ACCOUNT, "region": REGION, "kind": "ecs_task",
                "resource_id": "task-1", "facts": {"last_status": "RUNNING", "attachments": attachments,
                                                   **({} if complete else {"attachments_complete": False})}}
        subnet = {"id": "r:subnet", "account": ACCOUNT, "region": REGION, "kind": "subnet",
                  "resource_id": "subnet-a", "facts": {"vpc_id": "vpc-a"}}
        return {"resources": [task, subnet], "relationships": [], "coverage": {"account": ACCOUNT},
                "gaps": [], "incomplete": [], "degraded": [], "evidence": [
            {"id": "e:" + r["id"], "kind": "inventory", "source": "inventory", "resource_ids": [r["id"]],
             "fresh": True, "captured_at": captured, "coverage": {"complete": True}} for r in (task, subnet)]}

    bound = bundle(True)
    identities.project_tasks(bound)
    assert any(e["source"] == "inventory_workload_binding" for e in bound["evidence"])
    capped = bundle(False)
    identities.project_tasks(capped)
    assert not any(e["source"] == "inventory_workload_binding" for e in capped["evidence"])
    assert "private_ip_address" not in capped["resources"][0]["facts"]
    assert "workload_attachment_cap" in capped["incomplete"]


def test_missing_vpc_never_matches_inventory_rows_without_vpc(monkeypatch):
    from diagnosis import discovery as d
    monkeypatch.setattr(d, "_now", lambda: NOW)
    arn = f"arn:aws:rds:{REGION}:{ACCOUNT}:db:orders"
    cluster = f"arn:aws:rds:{REGION}:{ACCOUNT}:cluster:orders"
    db = {"id": "r:orders", "kind": "rds", "account": ACCOUNT, "region": REGION,
          "resource_id": "orders", "facts": {"arn": arn}}
    assert identities.proxy_target({"TargetArn": arn}, [db], ACCOUNT, REGION, None) is None
    assert identities._cluster_target({}, Budget(), None, {"TargetArn": cluster}, [db], ACCOUNT, REGION, None) is None
    bundle = {"resources": [db], "relationships": [], "coverage": {"account": ACCOUNT},
              "gaps": [], "incomplete": [], "degraded": [], "evidence": [
        {"id": "e:db", "kind": "inventory", "source": "inventory", "resource_ids": [db["id"]],
         "fresh": True, "coverage": {"complete": True}}]}

    class Rds:
        def describe_db_proxies(self, **kwargs):
            return {"DBProxies": [{"DBProxyName": "orders-proxy", "Status": "available",
                    "DBProxyArn": f"arn:aws:rds:{REGION}:{ACCOUNT}:db-proxy:prx-1"}]}

        def describe_db_proxy_targets(self, **kwargs):
            return {"Targets": [{"TargetArn": arn, "Type": "RDS_INSTANCE", "Port": 5432}]}

    identities.collect_proxies(bundle, Budget(), lambda *args: Rds())
    assert [r["kind"] for r in bundle["resources"]] == ["rds"] and not bundle["relationships"]
    assert "proxy_target_unresolved" in bundle["gaps"]


def _proxy_bundle():
    arn = f"arn:aws:rds:{REGION}:{ACCOUNT}:db:orders"
    dbs = [{"id": f"r:{region}", "kind": "rds", "account": ACCOUNT, "region": region,
            "resource_id": "orders", "facts": {"arn": arn, "vpc_id": "vpc-a"}}
           for region in (REGION, "us-east-1")]
    return {"resources": dbs, "relationships": [], "coverage": {"account": ACCOUNT},
            "gaps": [], "incomplete": [], "degraded": [], "evidence": [
        {"id": f"e:{d['id']}", "kind": "inventory", "source": "inventory", "resource_ids": [d["id"]],
         "fresh": True, "coverage": {"complete": True}} for d in dbs]}

def test_deleted_proxy_cluster_does_not_drop_following_targets(monkeypatch):
    from botocore.exceptions import ClientError
    from diagnosis import discovery as d
    monkeypatch.setattr(d, "_now", lambda: NOW)
    bundle = _proxy_bundle()
    bundle["resources"] = [bundle["resources"][0]]
    deleted = f"arn:aws:rds:{REGION}:{ACCOUNT}:cluster:deleted"
    database = f"arn:aws:rds:{REGION}:{ACCOUNT}:db:orders"

    class Rds:
        def describe_db_proxies(self, **kwargs):
            return {"DBProxies": [{"DBProxyName": "orders-proxy", "Status": "available", "VpcId": "vpc-a",
                    "DBProxyArn": f"arn:aws:rds:{REGION}:{ACCOUNT}:db-proxy:prx-1"}]}

        def describe_db_proxy_targets(self, **kwargs):
            return {"Targets": [{"TargetArn": deleted, "Type": "TRACKED_CLUSTER", "Port": 5432},
                                {"TargetArn": database, "Type": "RDS_INSTANCE", "Port": 5432}]}

        def describe_db_clusters(self, **kwargs):
            raise ClientError({"Error": {"Code": "DBClusterNotFoundFault", "Message": "deleted"}},
                              "DescribeDBClusters")

    identities.collect_proxies(bundle, Budget(), lambda *args: Rds())
    assert len(bundle["relationships"]) == 1
    assert "proxy_target_unresolved" in bundle["gaps"]
    assert "proxy_configuration_unavailable" not in bundle["gaps"]


def test_denied_proxy_targets_does_not_drop_following_proxy(monkeypatch):
    from botocore.exceptions import ClientError
    from diagnosis import discovery as d
    monkeypatch.setattr(d, "_now", lambda: NOW)
    bundle = _proxy_bundle()
    bundle["resources"] = [bundle["resources"][0]]
    database = f"arn:aws:rds:{REGION}:{ACCOUNT}:db:orders"

    class Rds:
        def describe_db_proxies(self, **kwargs):
            return {"DBProxies": [{"DBProxyName": name, "Status": "available", "VpcId": "vpc-a",
                    "DBProxyArn": f"arn:aws:rds:{REGION}:{ACCOUNT}:db-proxy:{name}"}
                    for name in ("denied", "readable")]}

        def describe_db_proxy_targets(self, **kwargs):
            if kwargs["DBProxyName"] == "denied":
                raise ClientError({"Error": {"Code": "AccessDenied", "Message": "denied"}},
                                  "DescribeDBProxyTargets")
            return {"Targets": [{"TargetArn": database, "Type": "RDS_INSTANCE", "Port": 5432}]}

    identities.collect_proxies(bundle, Budget(), lambda *args: Rds())
    assert len(bundle["relationships"]) == 1
    assert "proxy_target_unresolved" in bundle["gaps"]
    assert "proxy_configuration_unavailable" not in bundle["gaps"]


def test_proxy_call_cap_is_incomplete_only_and_stops_every_region():
    bundle, regions = _proxy_bundle(), []

    class Rds:
        def __init__(self, region):
            self.region = region

        def describe_db_proxies(self, **kwargs):
            regions.append(self.region)
            return {"DBProxies": [{"DBProxyName": "p", "Status": "available", "VpcId": "vpc-a",
                    "DBProxyArn": f"arn:aws:rds:{self.region}:{ACCOUNT}:db-proxy:prx-1"}]}

        def describe_db_proxy_targets(self, **kwargs):
            return {"Targets": [{"TargetArn": f"arn:aws:rds:{self.region}:{ACCOUNT}:cluster:c{i}",
                                 "Type": "TRACKED_CLUSTER"} for i in range(20)]}

        def describe_db_clusters(self, **kwargs):
            return {"DBClusters": []}
    identities.collect_proxies(bundle, Budget(), lambda service, region, budget: Rds(region))
    assert "proxy_query_cap" in bundle["incomplete"]
    assert "proxy_configuration_unavailable" not in bundle["gaps"]
    assert len(regions) == 1  # the shared cap stops the remaining region instead of re-failing it


def test_proxy_provider_error_is_a_gap_and_defect_is_degraded():
    from botocore.exceptions import ClientError

    class Denied:
        def describe_db_proxies(self, **kwargs):
            raise ClientError({"Error": {"Code": "AccessDenied", "Message": "no"}}, "DescribeDBProxies")
    bundle = _proxy_bundle()
    identities.collect_proxies(bundle, Budget(), lambda *args: Denied())
    assert "proxy_configuration_unavailable" in bundle["gaps"] and not bundle["degraded"]

    class Broken:
        def describe_db_proxies(self, **kwargs):
            return {"DBProxies": ["not-a-proxy-row"]}
    bundle = _proxy_bundle()
    identities.collect_proxies(bundle, Budget(), lambda *args: Broken())
    assert "proxy_projection_failed" in bundle["degraded"]
    assert "proxy_configuration_unavailable" not in bundle["gaps"]
