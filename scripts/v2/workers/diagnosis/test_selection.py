"""Selection keeps minority dependency types visible without exceeding IO bounds."""
from diagnosis import discovery
from diagnosis.test_discovery import ACCOUNT, REGION, Budget, Database, inventory, provider


def test_dense_fleet_preserves_database_and_workload_seeds(provider):
    rows = [inventory("ec2", f"i-{n:017x}", {}) for n in range(240)]
    rows += [inventory(kind, kind + "-1", {}) for kind in ("rds", "ecs_task", "lambda", "rds_proxy")]
    bundle = discovery.collect(Database(rows), ACCOUNT, Budget())
    assert {r["kind"] for r in bundle["resources"]} >= {"ec2", "rds", "ecs_task", "lambda", "rds_proxy"}
    assert len(bundle["resources"]) <= discovery.MAX_RESOURCES
    assert bundle["coverage"]["inventory"]["omitted"] > 0


def test_database_selection_is_fair_before_the_sql_limit(provider):
    db = Database([inventory("ec2", "i-0123456789abcdef0", {})])
    discovery.collect(db, ACCOUNT, Budget())
    sql = next(sql for sql, _ in db.queries if "jsonb_each(data)" in sql)
    assert "PARTITION BY resource_type" in sql
    assert "seed_rank" in sql


def test_graph_query_prioritizes_scoped_inventory_neighborhood(provider):
    db = Database([inventory("ec2", "i-0123456789abcdef0", {})])
    discovery.collect(db, ACCOUNT, Budget())
    sql, params = next((sql, args) for sql, args in db.queries if "FROM topology_nodes" in sql)
    assert "focus_ids" in params
    assert params["focus_ids"] == ["i-0123456789abcdef0"]
    assert "inventoryAccount" in sql and ":scope" in sql
    assert "PARTITION BY class" in sql


def test_graph_inventory_binding_uses_inventory_type_to_disambiguate():
    rows = [{"id": kind, "resource_id": "shared", "region": REGION,
             "account": ACCOUNT, "kind": kind} for kind in ("lambda", "ecs_task")]
    meta = {"inventoryAccount": "self", "resourceId": "shared", "region": REGION,
            "invType": "ecs_task"}
    assert discovery._node_inventory(meta, rows, ACCOUNT)["id"] == "ecs_task"
    assert discovery._node_inventory({**meta, "invType": "rds"}, rows, ACCOUNT) is None
