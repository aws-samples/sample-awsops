"""Optional local PostgreSQL contract test; temporary tables only, no AWS calls.

Set AWSOPS_DISCOVERY_PG_PORT to the dedicated localhost fixture's port.
"""
import datetime as dt
import json
import os
import pg8000.native
import pytest
from diagnosis import discovery
from diagnosis.test_discovery import ACCOUNT, REGION, Budget


@pytest.fixture
def pg():
    port = os.environ.get("AWSOPS_DISCOVERY_PG_PORT")
    if not port:
        pytest.skip("Dedicated localhost PostgreSQL fixture was not supplied")
    conn = pg8000.native.Connection(user="postgres", host="127.0.0.1", port=int(port), database="postgres")
    tables = {
        "inventory_resources": "account_id text,region text,resource_type text,resource_id text,data jsonb,captured_at timestamptz",
        "inventory_sync_runs": "account_id text,resource_type text,status text,finished_at timestamptz,last_success_at timestamptz,row_count int,unknown_attribute_count int,started_at timestamptz",
        "inventory_snapshots": "account_id text,resource_type text,resource_count int,captured_at timestamptz",
        "topology_nodes": "account_id text,id text,kind text,label text,meta jsonb,captured_at timestamptz,class text",
        "topology_edges": "account_id text,source text,target text,rel text,confidence text,meta jsonb,captured_at timestamptz,class text",
        "topology_graph_state": "account_id text,class text,status text,attempted_at timestamptz,captured_at timestamptz,details jsonb",
    }
    for name, fields in tables.items():
        conn.run(f"CREATE TEMP TABLE {name}({fields})")
    yield conn
    conn.close()


def bundle():
    return {"resources": [], "relationships": [], "evidence": [], "gaps": [],
            "degraded": [], "incomplete": [], "coverage": {"account": ACCOUNT}}


def insert_resource(conn, kind, rid):
    conn.run("INSERT INTO inventory_resources VALUES('self',:region,:kind,:rid,'{}',now())",
             region=REGION, kind=kind, rid=rid)


def test_dense_database_selection_runs_on_postgresql(pg):
    for i in range(240):
        insert_resource(pg, "ec2", f"i-{i:017x}")
    for kind in ("rds", "lambda", "ecs_task"):
        insert_resource(pg, kind, kind + "-1")
    found = bundle()
    discovery._read_inventory(pg, found, Budget(), "self")
    assert {r["kind"] for r in found["resources"]} == {"ec2", "rds", "lambda", "ecs_task"}
    assert len(found["resources"]) == discovery.MAX_INVENTORY_RESOURCES
    assert found["coverage"]["inventory"]["omitted"] == 63


def test_scoped_neighborhood_wins_over_alphabetical_graph_noise(pg):
    for kind, rid in (("ec2", "i-0123456789abcdef0"), ("rds", "orders")):
        insert_resource(pg, kind, rid)
        pg.run("INSERT INTO topology_nodes VALUES('self',:id,:kind,:id,CAST(:meta AS jsonb),now(),'infra')",
               id="z:" + rid, kind=kind, meta=json.dumps({"resourceId": rid, "inventoryAccount": "self",
                                                        "region": REGION, "invType": kind}))
    pg.run("INSERT INTO topology_nodes SELECT 'self','a:'||n,'unbound','noise','{}'::jsonb,now(),'infra' FROM generate_series(1,650) n")
    pg.run("INSERT INTO topology_edges VALUES('self','z:i-0123456789abcdef0','z:orders','connects','inferred','{}',now(),'infra')")
    pg.run("INSERT INTO topology_edges SELECT 'self','a:'||n,'a:'||(n+1),'noise','inferred','{}'::jsonb,now(),'infra' FROM generate_series(1,450) n")
    found = bundle()
    discovery._read_inventory(pg, found, Budget(), "self")
    discovery._read_graph(pg, found, Budget(), "self")
    assert not found["degraded"]
    assert len(found["relationships"]) == 1
    assert found["relationships"][0]["kind"] == "configured_dependency"
    assert "graph_cap" in found["incomplete"]
