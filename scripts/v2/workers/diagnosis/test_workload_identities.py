"""ENI ownership and DB proxy configuration need exact scoped corroboration."""
from diagnosis import workload_identities as identities
from diagnosis.test_discovery import ACCOUNT, REGION, NOW, Budget


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
