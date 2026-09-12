"""PostgreSQL graph-evidence contract; uses the disposable localhost worker fixture."""
import json
import pytest
from pathlib import Path

from test_db import legacy_worker_pg  # noqa: F401 — shared explicit-localhost fixture


MIGRATION = (
    Path(__file__).resolve().parents[3] / "terraform/foundation/migrations/"
    "01M279W0J9HNG1QT0MAS60KV8K_topology_graph_collection_state.sql"
)


@pytest.fixture
def graph_pg(legacy_worker_pg):
    database = legacy_worker_pg
    conn = database.conn
    conn.run("""
        CREATE TABLE public.topology_nodes (
          account_id text, id text, kind text, label text, meta jsonb,
          run_id text, captured_at timestamptz, class text
        );
        CREATE TABLE public.topology_edges (
          id bigserial, account_id text, source text, target text, rel text,
          confidence text, run_id text, captured_at timestamptz, class text
        );
        CREATE VIEW sql_reader.topology_nodes AS
          SELECT account_id,id,kind,label,run_id,captured_at,class,'{}'::jsonb AS meta
          FROM public.topology_nodes;
        CREATE VIEW sql_reader.topology_edges AS
          SELECT id,account_id,source,target,rel,confidence,run_id,captured_at,class
          FROM public.topology_edges;
        GRANT SELECT ON sql_reader.topology_nodes, sql_reader.topology_edges TO awsops_sql_reader;
    """)
    conn.run(MIGRATION.read_text())
    conn.run(MIGRATION.read_text())
    return database


def test_graph_reader_exposes_only_named_evidence_after_idempotent_migration(graph_pg):
    database = graph_pg
    conn = database.conn
    conn.run("""
        INSERT INTO public.topology_graph_state VALUES (
          'self','trace','partial',now(),now(),:details::jsonb
        );
    """, details=json.dumps({
        "retainedPrevious": False, "windowStartMs": 1, "windowEndMs": 2,
        "secret": "MUST_NOT_LEAK", "sources": [{
            "sourceId": "tempo:1", "status": "partial", "itemCount": 1,
            "reasons": ["cap_reached", "MUST_NOT_LEAK"], "credential": "MUST_NOT_LEAK",
        }],
    }))
    conn.run("""
        INSERT INTO public.topology_nodes VALUES (
          'self',:node_id,'service','checkout',:meta::jsonb,'run',now(),'trace'
        );
    """, node_id="svc:one", meta=json.dumps({
        "service": "checkout", "environment": "prod", "sourceId": "tempo:1",
        "namespace": "shop", "row": {"secret": "MUST_NOT_LEAK"},
    }))
    conn.run("""
        INSERT INTO public.topology_edges
          (account_id,source,target,rel,confidence,run_id,captured_at,class,meta)
        VALUES ('self','a','b','calls','observed','run',now(),'trace',:meta::jsonb);
    """, meta=json.dumps({"spanCount": 2, "metricCount": 0, "secret": "MUST_NOT_LEAK"}))
    reader = database.connect()
    reader.run("SET ROLE awsops_sql_reader")
    reader.run("SET search_path TO sql_reader, pg_catalog")
    assert reader.run("SELECT to_regclass('topology_graph_state') IS NOT NULL")[0][0] is True
    assert reader.run("""
        SELECT has_table_privilege('awsops_sql_reader','public.topology_graph_state','SELECT')
    """)[0][0] is False
    state = json.loads(reader.run("SELECT row_to_json(s)::text FROM topology_graph_state s")[0][0])
    assert state["status"] == "partial"
    assert state["details"]["sources"][0]["reasons"] == ["cap_reached"]
    assert "MUST_NOT_LEAK" not in json.dumps(state)
    edge = json.loads(reader.run("SELECT meta::text FROM topology_edges")[0][0])
    assert edge == {"spanCount": 2, "metricCount": 0}
    node = json.loads(reader.run("SELECT meta::text FROM topology_nodes")[0][0])
    assert node["environment"] == "prod" and node["sourceId"] == "tempo:1"
    assert "MUST_NOT_LEAK" not in json.dumps(node)


@pytest.mark.parametrize("legacy", [False, True])
def test_queue_claim_projection_is_constant_and_never_inventory_authority(graph_pg, legacy):
    import pg8000.exceptions

    migration = MIGRATION.with_name("01M27B0000C6QWJ50NRJ8YAH9D_trace_queue_claim_provenance.sql")
    graph_pg.conn.run(migration.read_text())
    graph_pg.conn.run(migration.read_text())
    claim_keys = ("accountId", "region") if legacy else ("claimedAccountId", "claimedRegion")
    meta = {
        claim_keys[0]: "111122223333", claim_keys[1]: "us-east-1",
        "identityProvenance": "aws_verified", "infra_ref": "inventory:queue",
        "destination": "arn:aws:sqs:us-east-1:111122223333:orders", "sourceId": "tempo:1",
        "row": {"secret": "MUST_NOT_LEAK"}, "claimedExtra": "MUST_NOT_LEAK",
    }
    graph_pg.conn.run("""
        INSERT INTO public.topology_nodes VALUES
          ('self','queue:one','queue','orders',:meta::jsonb,'run',now(),'trace'),
          ('self','infra:one','queue','orders',:infra::jsonb,'run',now(),'infra');
    """, meta=json.dumps(meta), infra=json.dumps({"accountId": "111122223333", "region": "us-east-1"}))
    reader = graph_pg.connect()
    reader.run("SET ROLE awsops_sql_reader")
    reader.run("SET search_path TO sql_reader, pg_catalog")
    queue = json.loads(reader.run("SELECT meta::text FROM topology_nodes WHERE class='trace'")[0][0])
    assert queue == {
        "claimedAccountId": "111122223333", "claimedRegion": "us-east-1",
        "identityProvenance": "telemetry_claim", "destination": meta["destination"], "sourceId": "tempo:1",
    }
    infra = json.loads(reader.run("SELECT meta::text FROM topology_nodes WHERE class='infra'")[0][0])
    assert infra == {"accountId": "111122223333", "region": "us-east-1"}
    with pytest.raises(pg8000.exceptions.DatabaseError):
        reader.run("SELECT meta FROM public.topology_nodes")
    with pytest.raises(pg8000.exceptions.DatabaseError):
        reader.run("UPDATE topology_nodes SET label='spoofed'")
