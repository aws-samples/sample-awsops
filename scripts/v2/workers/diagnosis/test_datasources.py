import io
import json

import pytest

from diagnosis import sources as src


@pytest.fixture(autouse=True)
def _enable_ds(monkeypatch):
    # collect_datasources is flag-gated (default OFF); enable it for the behavior tests below.
    monkeypatch.setenv("DIAG_DATASOURCES_ENABLED", "true")


def test_disabled_by_default(monkeypatch):
    # flag OFF → no connector fan-out, explicit "disabled" result (no AccessDenied/silent degrade).
    monkeypatch.delenv("DIAG_DATASOURCES_ENABLED", raising=False)
    fake = _patch_lambda(monkeypatch, FakeLambda())
    out = src.collect_datasources(FakeConn([(5, "p", "prometheus", True)], {5: {"metrics": ["errors_total"]}}))
    assert fake.calls == [] and out["data"]["queried"] == 0 and "disabled" in (out.get("notes") or "")


class FakeConn:
    """Routes by SQL: the integrations discovery query → `instances`; the schema query → schemas[iid]."""
    def __init__(self, instances, schemas=None, raise_on=None):
        self.instances = instances
        self.schemas = schemas or {}
        self.raise_on = raise_on

    def run(self, sql, **kw):
        if self.raise_on and self.raise_on in sql:
            raise RuntimeError("boom")
        if "FROM integrations" in sql:
            return self.instances
        if "FROM datasource_schemas" in sql:
            s = self.schemas.get(kw.get("iid"))
            return [[s]] if s is not None else []
        return []


class FakeLambda:
    """Captures invoke payloads; returns a fixed connector envelope {statusCode, body(JSON str)}."""
    def __init__(self, body=None, status=200):
        self.calls = []
        self.body = body if body is not None else {"result": {"shape": "vector", "series": [{"v": 1}]}}
        self.status = status

    def invoke(self, FunctionName, Payload):
        self.calls.append({"fn": FunctionName, "payload": json.loads(Payload)})
        env = json.dumps({"statusCode": self.status, "body": json.dumps(self.body)}).encode("utf-8")
        return {"Payload": io.BytesIO(env)}


def _patch_lambda(monkeypatch, fake):
    monkeypatch.setattr(src, "_lambda_client", lambda: fake)
    return fake


# A2 — credential-blind: the worker sends ONLY instance_id, NEVER conn_config/credentials.
def test_invoke_is_credential_blind(monkeypatch):
    fake = _patch_lambda(monkeypatch, FakeLambda())
    conn = FakeConn([(5, "prod-prom", "prometheus", True)],
                    {5: {"version": "2.48.0", "metrics": ["http_requests_total", "node_cpu_seconds_total"]}})
    out = src.collect_datasources(conn)
    assert out["key"] == "datasources_obs" and out["ok"]
    assert fake.calls, "connector should have been invoked"
    for c in fake.calls:
        assert c["fn"] == "awsops-v2-agent-prometheus-mcp"
        args = c["payload"]["arguments"]
        assert args["instance_id"] == 5                       # per-instance routing
        assert "conn_config" not in c["payload"]              # credential-blind
        assert not any(k in args for k in ("password", "token", "username", "endpoint"))


# A3 — schema-driven: query NAMES come from the cached schema, signal-matched, aggregated.
def test_plan_is_schema_driven_and_aggregated(monkeypatch):
    fake = _patch_lambda(monkeypatch, FakeLambda())
    conn = FakeConn([(5, "p", "prometheus", True)],
                    {5: {"metrics": ["http_requests_total", "go_gc_duration_seconds", "unrelated_gauge"]}})
    src.collect_datasources(conn)
    queries = [c["payload"]["arguments"]["query"] for c in fake.calls]
    assert any("http_requests_total" in q and "rate(" in q for q in queries)   # counter → rate()
    assert all("unrelated_gauge" not in q for q in queries)                    # non-signal series skipped
    assert all(q.startswith("topk(") for q in queries)                         # bounded/aggregated


# A6 — caps: default takes is_default only (MAX_INSTANCES_PER_KIND=1); ≤MAX_QUERIES_PER_INSTANCE.
def test_caps_default_instance_and_query_budget(monkeypatch):
    fake = _patch_lambda(monkeypatch, FakeLambda())
    conn = FakeConn(
        [(5, "default-prom", "prometheus", True), (6, "stg-prom", "prometheus", False)],  # ORDER BY is_default DESC
        {5: {"metrics": [f"errors_total_{i}" for i in range(10)]}, 6: {"metrics": ["errors_total_x"]}},
    )
    src.collect_datasources(conn)
    invoked_instances = {c["payload"]["arguments"]["instance_id"] for c in fake.calls}
    assert invoked_instances == {5}                                  # only the default instance
    assert len(fake.calls) <= src._DS_MAX_QUERIES_PER_INSTANCE        # query budget per instance


# A6b — an instance with no cached schema is skipped with an explicit note (never invoked).
def test_no_cache_row_skipped_with_note(monkeypatch):
    fake = _patch_lambda(monkeypatch, FakeLambda())
    conn = FakeConn([(9, "fresh-prom", "prometheus", True)], {})  # no schema cached
    out = src.collect_datasources(conn)
    assert fake.calls == []                                          # nothing queried
    assert any("Refresh schema" in n for n in out["data"].get("notes", []))


# PII/DLP (consensus gate CRITICAL): raw log lines / row values / trace payloads must NEVER reach the
# summary — only counts + label NAMES. A Loki `result` of raw log lines must not leak into the report.
def test_summary_never_leaks_raw_samples(monkeypatch):
    secret_line = "2026-06-18 ERROR user=alice@corp.com card=4111111111111111 failed login from 10.1.2.3"
    _patch_lambda(monkeypatch, FakeLambda(body={"resultType": "streams", "result": [
        {"stream": {"app": "auth"}, "values": [["1718000000", secret_line]]}]}))
    conn = FakeConn([(5, "lk", "loki", True)], {5: {"labels": ["app", "namespace"]}})
    out = src.collect_datasources(conn)
    blob = json.dumps(out["data"])
    assert secret_line not in blob and "4111111111111111" not in blob and "alice@corp.com" not in blob
    summ = out["data"]["findings"][0]["results"][0]["summary"]
    assert summ.get("count") == 1 and "sample" not in summ              # count kept, raw sample dropped


# A4/A5 — summarize-before-LLM: compact shape, and the data blob stays under the byte cap.
def test_summarize_and_byte_cap(monkeypatch):
    big = {"result": {"shape": "matrix", "series": [{"v": i} for i in range(1000)]}}
    _patch_lambda(monkeypatch, FakeLambda(body=big))
    conn = FakeConn([(5, "p", "prometheus", True)], {5: {"metrics": ["request_errors_total"]}})
    out = src.collect_datasources(conn)
    assert len(json.dumps(out["data"])) <= src._DS_MAX_BYTES + 200    # bounded (cap + small envelope)


# never-raises: a DB failure degrades, it does not throw.
def test_db_failure_degrades_not_raises(monkeypatch):
    conn = FakeConn([], raise_on="FROM integrations")
    out = src.collect_datasources(conn)
    assert out["key"] == "datasources_obs" and out["degraded"] and not out["ok"]


# empty: no datasources configured → ok, empty, explicit note.
def test_no_datasources(monkeypatch):
    out = src.collect_datasources(FakeConn([]))
    assert out["ok"] and out["data"]["queried"] == 0


# M3: summarize must handle the REAL connector envelopes (prom/loki spread `result` as a top-level LIST),
# not just the synthetic {result:{series}} shape — else summaries are silently empty.
def test_summarize_handles_real_prometheus_envelope(monkeypatch):
    _patch_lambda(monkeypatch, FakeLambda(body={"resultType": "vector", "truncated": False,
                                                "result": [{"metric": {"job": "api"}, "value": [0, "3"]}]}))
    conn = FakeConn([(5, "p", "prometheus", True)], {5: {"metrics": ["http_requests_total"]}})
    out = src.collect_datasources(conn)
    summ = out["data"]["findings"][0]["results"][0]["summary"]
    assert summ.get("count") == 1 and summ.get("resultType") == "vector"  # real envelope summarized, not empty


# M3: Tempo returns `traces` (not `result`) — must still summarize.
def test_summarize_handles_tempo_traces_envelope(monkeypatch):
    _patch_lambda(monkeypatch, FakeLambda(body={"traces": [{"traceID": "abc"}, {"traceID": "def"}]}))
    conn = FakeConn([(5, "t", "tempo", True)], {5: {"labels": ["service.name"]}})
    out = src.collect_datasources(conn)
    summ = out["data"]["findings"][0]["results"][0]["summary"]
    assert summ.get("count") == 2 and summ.get("source") == "traces"


# consensus gate finding: a crafted/poisoned ClickHouse table name must NOT reach the SQL (identifier-validated).
def test_clickhouse_table_name_is_identifier_validated(monkeypatch):
    fake = _patch_lambda(monkeypatch, FakeLambda(body={"result": {"rows": [{"c": 1}]}}))
    conn = FakeConn(
        [(5, "ch", "clickhouse", True)],
        {5: {"tables": [{"name": "events"}, {"name": "x) UNION SELECT password FROM users--"}, {"name": "ok_table"}]}},
    )
    src.collect_datasources(conn)
    sqls = [c["payload"]["arguments"]["sql"] for c in fake.calls]
    assert all("UNION" not in s and "--" not in s for s in sqls)          # injection name dropped
    assert any("events" in s for s in sqls) and any("ok_table" in s for s in sqls)  # bare identifiers kept


# ── Task 5: pre-built signal path (datasource_diag_signals) ──────────────────────────────────────
import json as _json


class SignalConn(FakeConn):
    """FakeConn that also serves datasource_diag_signals rows (the pre-built signal path)."""
    def __init__(self, instances, signal_rows):
        super().__init__(instances, {})
        self._signal_rows = signal_rows
    def run(self, sql, **kw):
        if "FROM datasource_diag_signals" in sql:
            return self._signal_rows
        return super().run(sql, **kw)


def _ready_row(key, exprs):
    q = {"tool": "prometheus_query", "queries": [{"label": f"l{i}", "expr": e} for i, e in enumerate(exprs)]}
    return [key, key, "ready", _json.dumps(q), None, _json.dumps({"pillar": "performance", "threshold": 0.25})]


def _unavail_row(key, missing):
    return [key, key, "unavailable", None, _json.dumps(missing), _json.dumps({"pillar": "reliability"})]


def test_prebuilt_signals_executed_when_present(monkeypatch):
    fake = _patch_lambda(monkeypatch, FakeLambda())
    conn = SignalConn([(5, "prod-prom", "prometheus", True)],
                      [_ready_row("network_pps", ["rate(node_network_receive_packets_total[5m])",
                                                  "rate(node_network_receive_drop_total[5m])"])])
    out = src.collect_datasources(conn)
    assert out["ok"]
    # both stored queries of the multi-query signal were invoked, credential-blind (instance_id only)
    exprs = [c["payload"]["arguments"].get("query") for c in fake.calls]
    assert any("receive_packets_total" in (e or "") for e in exprs)
    assert any("receive_drop_total" in (e or "") for e in exprs)
    for c in fake.calls:
        assert c["payload"]["arguments"]["instance_id"] == 5
        assert "conn_config" not in c["payload"]
    f = out["data"]["findings"][0]
    assert f.get("source") == "signals" and f["signals"][0]["key"] == "network_pps"


def test_unavailable_signal_surfaces_reason_note(monkeypatch):
    _patch_lambda(monkeypatch, FakeLambda())
    conn = SignalConn([(5, "p", "prometheus", True)],
                      [_unavail_row("oom_kills", ["kube_pod_container_status_last_terminated_reason"])])
    out = src.collect_datasources(conn)
    notes = (out.get("notes") or "") + _json.dumps(out["data"].get("notes") or [])
    assert "oom_kills" in notes and "없음" in notes


def test_no_signal_rows_falls_back_to_generic_planner(monkeypatch):
    # rows empty → generic schema-driven planner still runs (decoupled from the index pipeline)
    fake = _patch_lambda(monkeypatch, FakeLambda())
    conn = SignalConn([(5, "p", "prometheus", True)], [])
    conn.schemas = {5: {"metrics": ["http_requests_total"]}}
    src.collect_datasources(conn)
    assert fake.calls, "generic planner should run when no signals are materialized"
