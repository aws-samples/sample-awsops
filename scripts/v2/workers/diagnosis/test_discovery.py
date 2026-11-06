"""Offline discovery contracts: scope, provenance, observed pairs and sizing."""
import copy
import datetime as dt
import json

import pytest

from diagnosis import discovery

NOW = dt.datetime(2026, 11, 4, 12, tzinfo=dt.timezone.utc)
ACCOUNT = "111122223333"
REGION = "ap-northeast-2"
I1, I2 = "i-0123456789abcdef0", "i-0123456789abcdef1"


class Budget:
    def __init__(self, seconds=1000):
        self.seconds = seconds

    def remaining(self, analysis=True):
        assert analysis is True
        return self.seconds


def inventory(kind, rid, facts, *, account="self", region=REGION, captured=NOW):
    return [account, region, kind, rid, facts, captured]


class Database:
    """Only the pg8000 boundary is simulated; all discovery processing remains real."""
    def __init__(self, rows=(), nodes=(), edges=(), states=(), finops=()):
        self.rows, self.nodes, self.edges = list(rows), list(nodes), list(edges)
        self.states, self.finops, self.queries = list(states), list(finops), []

    def run(self, sql, **kwargs):
        self.queries.append((sql, kwargs))
        if sql == "SHOW statement_timeout":
            return [["30s"]]
        if "set_config('statement_timeout'" in sql:
            return [[kwargs["timeout"]]]
        scope = kwargs.get("scope", "self")
        scoped = [r for r in self.rows if r[0] == scope]
        if "GROUP BY resource_type" in sql and "inventory_resources" in sql:
            return [[kind, len([r for r in scoped if r[2] == kind])]
                    for kind in sorted({r[2] for r in scoped})]
        if "count(*)" in sql and "inventory_resources" in sql:
            return [[len(scoped), sorted({r[1] for r in scoped})]]
        if "FROM inventory_resources" in sql:
            return copy.deepcopy(scoped)
        if "FROM inventory_sync_runs" in sql:
            return [[kind, "succeeded", NOW, NOW, len([r for r in self.rows if r[2] == kind]), 0,
                     NOW - dt.timedelta(minutes=1)]
                    for kind in sorted({r[2] for r in scoped})]
        if "FROM inventory_snapshots" in sql:
            return [[kind, len([r for r in scoped if r[2] == kind]), NOW]
                    for kind in sorted({r[2] for r in scoped})]
        if "FROM topology_graph_state" in sql:
            return copy.deepcopy([r for r in self.states if r[0] in kwargs.get("classes", [])])
        if "FROM topology_nodes" in sql:
            return copy.deepcopy([r for r in self.nodes if r[-1] in kwargs.get("classes", [])])
        if "FROM topology_edges" in sql:
            return copy.deepcopy([r for r in self.edges if r[-1] in kwargs.get("classes", [])])
        if "FROM finops_findings" in sql:
            return copy.deepcopy(self.finops)
        raise AssertionError(f"Unexpected SQL boundary: {sql}")


class Pager:
    def __init__(self, pages):
        self.pages = pages

    def paginate(self, **kwargs):
        return iter(copy.deepcopy(self.pages))


class Provider:
    def __init__(self, *, xray=(), metrics=(), ec2=(), rds=()):
        self.xray, self.metrics, self.ec2, self.rds = xray, metrics, list(ec2), list(rds)
        self.calls = []

    def get_paginator(self, operation):
        assert operation in ("get_service_graph", "get_metric_data")
        if operation == "get_metric_data":
            owner = self

            class MetricPager:
                def paginate(self, **kwargs):
                    return iter([owner.get_metric_data(**kwargs)])

            return MetricPager()
        return Pager(self.xray if operation == "get_service_graph" else self.metrics)

    def get_metric_data(self, **kwargs):
        self.calls.append(("metrics", kwargs))
        if callable(self.metrics):
            return self.metrics(kwargs)
        return copy.deepcopy(self.metrics[0] if self.metrics else {"MetricDataResults": []})

    def get_ec2_instance_recommendations(self, **kwargs):
        self.calls.append(("ec2", kwargs))
        return copy.deepcopy(self.ec2.pop(0) if self.ec2 else {"instanceRecommendations": []})

    def get_rds_database_recommendations(self, **kwargs):
        self.calls.append(("rds", kwargs))
        return copy.deepcopy(self.rds.pop(0) if self.rds else {"rdsDBRecommendations": []})


@pytest.fixture
def provider(monkeypatch):
    fake = Provider()
    calls = []
    monkeypatch.setattr(discovery, "_now", lambda: NOW)
    monkeypatch.setenv("AWS_REGION", REGION)
    monkeypatch.setenv("DIAGNOSIS_EVIDENCE_LOOP_ENABLED", "true")
    monkeypatch.setenv("DIAGNOSIS_HOST_ACCOUNT_ID", ACCOUNT)
    monkeypatch.setattr(discovery, "_client", lambda service, region, budget: calls.append((service, region)) or fake)
    fake.client_calls = calls
    return fake


def resource(bundle, rid):
    return next(r for r in bundle["resources"] if r["resource_id"] == rid)


def evidence(bundle, kind):
    return [e for e in bundle["evidence"] if e["kind"] == kind]


def graph_fixture():
    rows = [inventory("ec2", I1, {"instance_type": "m7g.large"}),
            inventory("ec2", I2, {"instance_type": "m7g.large"}),
            inventory("rds", "db1", {"endpoint_address": "db1.example.test", "db_instance_identifier": "db1"}),
            inventory("rds", "db2", {"endpoint_address": "db2.example.test", "db_instance_identifier": "db2"})]
    refs = {rid: f"{kind}:@self:{REGION}:{rid}" for _, _, kind, rid, _, _ in rows}
    nodes = [[refs[rid], kind, rid, {"resourceId": rid, "inventoryAccount": "self", "region": REGION,
              **({"host": f"{rid}.example.test"} if kind == "rds" else {})}, NOW, "infra"]
             for _, _, kind, rid, _, _ in rows]
    nodes.extend([["svc:orders", "service", "orders", {"accountId": ACCOUNT, "region": REGION}, NOW, "trace"],
                  ["db:one", "db", "postgres:db1", {"host": "db1.example.test", "accountId": ACCOUNT, "region": REGION}, NOW, "trace"],
                  ["db:two", "db", "postgres:db2", {"host": "db2.example.test", "accountId": ACCOUNT, "region": REGION}, NOW, "trace"]])
    edges = []
    for instance, db, target in [(I1, "db1", "db:one"), (I2, "db2", "db:two")]:
        pair = {"instance_id": instance, "instance_ref": refs[instance], "database_ref": refs[db],
                "db_host": f"{db}.example.test", "account": ACCOUNT, "region": REGION,
                "correlation_id": f"pair:{instance}:{db}", "provenance": "trace_span",
                "observed_at_ms": NOW.timestamp() * 1000, "source_id": "tempo:1"}
        edges.append(["svc:orders", target, "queries", "observed",
                      {"spanCount": 1, "instance_observations": [pair]}, NOW, "trace"])
    details = {"windowStartMs": (NOW - dt.timedelta(hours=1)).timestamp() * 1000,
               "windowEndMs": NOW.timestamp() * 1000,
               "sources": [{"sourceId": "tempo:1", "status": "ok", "itemCount": 2}]}
    states = [["trace", "ok", NOW, NOW, details], ["infra", "ok", NOW, NOW, {
        "publishedSources": [{"sourceId": k, "status": "ok", "producerStatus": "succeeded",
                             "itemCount": 2, "lastSuccessAtMs": NOW.timestamp() * 1000,
                             "capturedAtMs": NOW.timestamp() * 1000, "reasons": []}
                            for k in ("ec2", "rds")]}]]
    return Database(rows, nodes, edges, states)


def test_member_reads_only_its_inventory_and_configuration_graph(provider):
    db = Database([inventory("ec2", I1, {"instance_type": "m7g.large"}),
                   inventory("ec2", I2, {"instance_type": "m6i.large"}, account="999900001111")])
    bundle = discovery.collect(db, "999900001111", Budget(), scope="999900001111")
    assert [r["resource_id"] for r in bundle["resources"]] == [I2]
    assert not provider.client_calls
    assert not any("finops_findings" in q for q, _ in db.queries)
    assert all("trace" not in args.get("classes", []) for _, args in db.queries)
    assert "member_live_sources_unsupported" in bundle["gaps"]


def test_inventory_facts_are_allowlisted_and_scope_is_preserved(provider):
    db = Database([inventory("ec2", I1, {"instance_type": "m7g.large", "private_ip_address": "10.0.0.7",
                       "user_data": "SECRET", "environment": {"PASSWORD": "SECRET"}, "tags": {"Name": "orders", "token": "SECRET"}})])
    bundle = discovery.collect(db, ACCOUNT, Budget())
    r = resource(bundle, I1)
    assert (r["account"], r["region"], r["kind"]) == (ACCOUNT, REGION, "ec2")
    assert "SECRET" not in json.dumps(bundle)
    assert r["facts"]["instance_type"] == "m7g.large"


def test_observed_pairs_are_same_span_and_never_cartesian(provider):
    bundle = discovery.collect(graph_fixture(), ACCOUNT, Budget())
    reverse = {r["id"]: r["resource_id"] for r in bundle["resources"]}
    pairs = {(reverse[e["source"]], reverse[e["target"]]) for e in bundle["relationships"]
             if e["kind"] == "observed_call" and reverse[e["source"]].startswith("i-")}
    assert pairs == {(I1, "db1"), (I2, "db2")}
    pair_evidence = [e for e in evidence(bundle, "observed_call") if e["facts"].get("correlation_id")]
    assert len(pair_evidence) == 2 and all(e["fresh"] for e in pair_evidence)


@pytest.mark.parametrize("field,value", [("account", "999900001111"), ("region", "us-east-1"),
                                         ("db_host", "db2.example.test"), ("instance_id", I2),
                                         ("provenance", "service_aggregate"),
                                         ("correlation_id", "pair <b>user@example.com</b>")])
def test_independent_pair_validation_rejects_conflicting_claims(provider, field, value):
    db = graph_fixture()
    db.edges[0][4]["instance_observations"][0][field] = value
    bundle = discovery.collect(db, ACCOUNT, Budget())
    iid = resource(bundle, I1)["id"]
    assert not any(e["source"] == iid and e["kind"] == "observed_call" for e in bundle["relationships"])
    assert "unresolved_instance_observation" in bundle["incomplete"]


@pytest.mark.parametrize("state", ["missing", "stale", "retained"])
def test_unqualified_graph_never_certifies_current_connection(provider, state):
    db = graph_fixture()
    if state == "missing":
        db.states = []
    elif state == "stale":
        db.states[0][3] = NOW - dt.timedelta(hours=2)
    else:
        db.states[0][4]["retainedPrevious"] = True
    bundle = discovery.collect(db, ACCOUNT, Budget())
    assert not any(e["fresh"] for e in evidence(bundle, "observed_call"))
    assert bundle["incomplete"]


def test_shared_security_group_is_configuration_not_observed_traffic(provider):
    db = graph_fixture()
    db.edges = [[db.nodes[0][0], db.nodes[2][0], "infra:uses_sg", "observed", {}, NOW, "infra"]]
    bundle = discovery.collect(db, ACCOUNT, Budget())
    assert not evidence(bundle, "observed_call")
    assert evidence(bundle, "configured_dependency")


def test_xray_later_page_targets_keep_reference_and_scope(provider):
    provider.xray = [{"Services": [{"ReferenceId": 1, "Name": "app", "Edges": [
                        {"ReferenceId": 2, "SummaryStatistics": {"TotalCount": 9}}]}], "NextToken": "next"},
                     {"Services": [{"ReferenceId": 2, "Name": "database"}]}]
    bundle = discovery.collect(Database([inventory("ec2", I1, {})]), ACCOUNT, Budget())
    rows = [e for e in evidence(bundle, "observed_call") if e["source"] == "xray"]
    assert len(rows) == 1
    assert rows[0]["facts"]["to_name"] == "database"
    assert rows[0]["facts"]["calls"] == 9
    assert rows[0]["coverage"]["pages"] == 2
    assert rows[0]["region"] == REGION


def test_xray_repeated_tokens_are_bounded_incomplete(provider):
    provider.xray = [{"Services": [], "NextToken": "repeat"}] * 8
    bundle = discovery.collect(Database([inventory("ec2", I1, {})]), ACCOUNT, Budget())
    assert "xray_repeated_token" in bundle["incomplete"]
    assert bundle["coverage"]["xray"][REGION]["pages"] == 2


def test_all_discovery_caps_disclose_omissions_and_bound_bytes(provider):
    rows = [inventory("ec2", f"i-{i:017x}", {"instance_type": "m7g.large", "name": "x" * 10000},
                      region=f"us-test-{i % 10}") for i in range(230)]
    bundle = discovery.collect(Database(rows), ACCOUNT, Budget())
    assert len(bundle["resources"]) <= 200
    assert len(bundle["relationships"]) <= 400
    assert len(json.dumps(bundle, ensure_ascii=False).encode()) <= 192 * 1024
    assert bundle["coverage"]["inventory"]["total"] == 230
    assert bundle["coverage"]["inventory"]["omitted"] >= 30
    assert len(bundle["coverage"]["regions"]["selected"]) == 8
    assert bundle["incomplete"]


def metric_response(kwargs, *, status="Complete", samples=336):
    end = kwargs["EndTime"]
    return {"MetricDataResults": [
        {"Id": q["Id"], "Values": [25.0] * samples,
         "Timestamps": [end - dt.timedelta(hours=i + 1) for i in range(samples)],
         "StatusCode": status, "Label": "fixture"}
        for q in kwargs["MetricDataQueries"]]}


def test_metrics_are_14_day_regional_and_use_actual_rds_dimensions(provider):
    provider.metrics = metric_response
    db = Database([inventory("ec2", I1, {"instance_type": "m7g.large"}),
                   inventory("rds", "orders", {"db_instance_identifier": "orders", "multi_az": True}, region="us-east-1")])
    bundle = discovery.collect(db, ACCOUNT, Budget())
    calls = [args for op, args in provider.calls if op == "metrics"]
    assert calls and all((c["EndTime"] - c["StartTime"]).days == 14 for c in calls)
    specs = [q["MetricStat"] for c in calls for q in c["MetricDataQueries"]]
    assert any(s["Stat"] == "p95" for s in specs)
    assert any(s["Metric"]["Namespace"] == "AWS/RDS" and s["Metric"]["Dimensions"] ==
               [{"Name": "DBInstanceIdentifier", "Value": "orders"}] for s in specs)
    assert ("cloudwatch", "us-east-1") in provider.client_calls
    ec2 = next(e for e in evidence(bundle, "metrics") if resource(bundle, I1)["id"] in e["resource_ids"])
    assert ec2["facts"]["missing_memory"] is True
    assert ec2["coverage"]["sample_ratio"] == 1
    assert ec2["facts"]["metrics"]["CPUUtilization"]["Maximum"]["unit"] == "Percent"
    rds = next(e for e in evidence(bundle, "metrics") if resource(bundle, "orders")["id"] in e["resource_ids"])
    assert rds["facts"]["replica_source"] == "unknown" and "rds_replica_source_unknown" in bundle["gaps"]
    assert rds["facts"]["metrics"]["ReadIOPS"]["Maximum"]["unit"] == "Count/Second"
    assert rds["facts"]["metrics"]["ReadLatency"]["p95"]["unit"] == "Seconds"


def test_synced_replica_source_distinguishes_standalone_from_replica(provider):
    provider.metrics = metric_response
    key = "read_replica_source_db_instance_identifier"
    db = Database([inventory("rds", "solo", {"db_instance_identifier": "solo", key: None}),
                   inventory("rds", "copy", {"db_instance_identifier": "copy", key: "solo"})])
    bundle = discovery.collect(db, ACCOUNT, Budget())
    facts = {e["resource_ids"][0]: e["facts"]["replica_source"] for e in evidence(bundle, "metrics")}
    assert facts[resource(bundle, "solo")["id"]] == "none"
    assert facts[resource(bundle, "copy")["id"]] == "solo"
    assert "rds_replica_source_unknown" not in bundle["gaps"]
    lag = {e["resource_ids"][0]: e["facts"]["metrics"].get("ReplicaLag") for e in evidence(bundle, "metrics")}
    assert lag[resource(bundle, "solo")["id"]] is None
    assert lag[resource(bundle, "copy")["id"]]["Maximum"]["status"] == "Complete"


def test_partial_metric_status_never_becomes_complete_sizing_evidence(provider):
    provider.metrics = lambda args: metric_response(args, status="PartialData", samples=12)
    bundle = discovery.collect(Database([inventory("ec2", I1, {})]), ACCOUNT, Budget())
    item = evidence(bundle, "metrics")[0]
    assert item["coverage"]["complete"] is False
    assert item["coverage"]["sample_ratio"] < 1
    assert "metrics_partial" in bundle["incomplete"]


def test_failed_metric_read_is_never_fresh(provider):
    def fail(args):
        raise TimeoutError("simulated metric read failure")
    provider.metrics = fail
    bundle = discovery.collect(Database([inventory("ec2", I1, {})]), ACCOUNT, Budget())
    assert evidence(bundle, "metrics")[0]["fresh"] is False
    assert "metrics_read_failed" in bundle["degraded"]


def recommendation(rid=I1):
    return {"instanceArn": f"arn:aws:ec2:{REGION}:{ACCOUNT}:instance/{rid}", "accountId": ACCOUNT,
            "currentInstanceType": "m7g.xlarge", "finding": "Overprovisioned", "lookBackPeriodInDays": 14,
            "lastRefreshTimestamp": NOW, "tags": [{"key": "dr", "value": "true"}],
            "utilizationMetrics": [{"name": "Cpu", "statistic": "Maximum", "value": 20}],
            "recommendationOptions": [
                {"instanceType": "m7g.medium", "rank": 2, "performanceRisk": 3},
                {"instanceType": "m7g.large", "rank": 1, "performanceRisk": 1,
                 "projectedUtilizationMetrics": [{"name": "Cpu", "statistic": "Maximum", "value": 40}],
                 "savingsOpportunity": {"estimatedMonthlySavings": {"value": 12, "currency": "USD"}}}]}


def test_provider_preserves_rank_currency_generation_and_sizing_vetoes(provider):
    provider.ec2 = [{"instanceRecommendations": [recommendation()]}]
    bundle = discovery.collect(Database([inventory("ec2", I1, {"instance_type": "m7g.xlarge"})]), ACCOUNT, Budget())
    item = evidence(bundle, "provider_sizing")[0]
    facts = item["facts"]
    assert facts["recommended_type"] == "m7g.large"
    assert (facts["rank"], facts["currency"], facts["monthly_savings"]) == (1, "USD", 12)
    assert facts["generation_time"] == NOW.isoformat()
    assert facts["missing_memory"] is True and facts["missing_io"] is True
    assert "protected_tag:dr" in facts["guard_hits"]
    assert facts["projected_utilization"][0]["value"] == 40


def test_provider_foreign_scope_is_not_admitted(provider):
    row = recommendation()
    row["accountId"] = "999900001111"
    provider.ec2 = [{"instanceRecommendations": [row]}]
    bundle = discovery.collect(Database([inventory("ec2", I1, {})]), ACCOUNT, Budget())
    assert not evidence(bundle, "provider_sizing")
    assert "provider_scope_mismatch" in bundle["incomplete"]


def test_deadline_stops_before_any_provider_operation(provider):
    bundle = discovery.collect(Database([inventory("ec2", I1, {})]), ACCOUNT, Budget(0))
    assert not provider.client_calls
    assert "discovery_deadline" in bundle["incomplete"]


def test_followup_rejects_arbitrary_scope_query_and_unknown_resources(provider):
    bundle = discovery.collect(Database([inventory("ec2", I1, {})]), ACCOUNT, Budget())
    before = len(provider.client_calls)
    merged = discovery.follow_up(Database(), ACCOUNT, bundle, [
        {"capability": "unknown", "resource_ids": [resource(bundle, I1)["id"]]},
        {"capability": "resource_metrics", "resource_ids": ["foreign"]},
        {"capability": "resource_metrics", "resource_ids": [resource(bundle, I1)["id"]], "region": "us-east-1"},
    ], Budget())
    assert len(provider.client_calls) == before
    assert "follow_up_rejected" in merged["gaps"]
    assert merged is not bundle


@pytest.mark.parametrize("trusted", [None, "999900001111", "not-an-account"])
def test_host_scope_requires_applied_exact_host_identity(provider, monkeypatch, trusted):
    if trusted is None:
        monkeypatch.delenv("DIAGNOSIS_HOST_ACCOUNT_ID")
    else:
        monkeypatch.setenv("DIAGNOSIS_HOST_ACCOUNT_ID", trusted)
    db = Database([inventory("ec2", I1, {})])
    bundle = discovery.collect(db, ACCOUNT, Budget())
    assert not db.queries and not provider.client_calls
    assert not bundle["resources"]
    assert "untrusted_host_scope" in bundle["degraded"]
    assert bundle["native_sources"]["cost"] == {"status": "not_collected"}


def test_host_account_is_never_read_through_member_scope(provider):
    db = Database([inventory("ec2", I1, {}, account=ACCOUNT)])
    bundle = discovery.collect(db, ACCOUNT, Budget(), scope=ACCOUNT)
    assert not db.queries and not provider.client_calls
    assert "host_member_scope_rejected" in bundle["degraded"] and "native_sources" in bundle


@pytest.mark.parametrize("reasons", [["invalid_request"], ["future_reason"], "query_failed"])
def test_any_published_source_reason_disqualifies_the_graph(provider, reasons):
    db = graph_fixture()
    assert discovery.collect(db, ACCOUNT, Budget())["coverage"]["graph"]["infra"]["complete"]
    db.states[1][4]["publishedSources"][0]["reasons"] = reasons
    assert not discovery.collect(db, ACCOUNT, Budget())["coverage"]["graph"]["infra"]["complete"]


@pytest.mark.parametrize("minutes,fresh", [(None, True), ("5", False), ("bogus", True), ("0", True)])
def test_inventory_freshness_honors_stale_after_minutes(provider, monkeypatch, minutes, fresh):
    monkeypatch.setattr(discovery, "_now", lambda: NOW + dt.timedelta(minutes=10))
    if minutes is not None:
        monkeypatch.setenv("INVENTORY_STALE_AFTER_MINUTES", minutes)
    bundle = discovery.collect(Database([inventory("ec2", I1, {"architecture": "arm64"})]), ACCOUNT, Budget())
    assert evidence(bundle, "inventory")[0]["fresh"] is fresh
    assert resource(bundle, I1)["facts"]["architecture"] == "arm64"


def test_byte_cap_evicts_trace_edges_before_sizing_evidence():
    bundle = {"resources": [], "relationships": [], "gaps": [], "degraded": [], "incomplete": [],
              "coverage": {"account": ACCOUNT},
              "evidence": [{"id": f"x{i}", "source": "xray", "facts": "x" * 4000} for i in range(60)]
              + [{"id": "m", "source": "cloudwatch", "facts": "m" * 4000}]}
    result = discovery._finish(bundle)
    assert [e["id"] for e in result["evidence"] if e["source"] == "cloudwatch"] == ["m"]
    assert result["coverage"]["byte_cap_evicted"]["xray"] > 0
    assert "context_byte_cap" in result["incomplete"]


def test_byte_cap_evicts_inventory_last():
    bundle = {"resources": [], "relationships": [], "gaps": [], "degraded": [], "incomplete": [],
              "coverage": {"account": ACCOUNT},
              "evidence": [{"id": "inv", "source": "inventory", "facts": "i" * 4000}]
              + [{"id": f"m{i}", "source": src, "facts": "m" * 4000}
                 for i, src in enumerate(["cloudwatch", "finops", "compute_optimizer"] * 20)]}
    result = discovery._finish(bundle)
    assert [e["id"] for e in result["evidence"] if e["source"] == "inventory"] == ["inv"]
    assert result["coverage"]["byte_cap_evicted"]["cloudwatch"] > 0


@pytest.mark.parametrize("fault", ["pre_attempt", "snapshot_count", "ledger_count"])
def test_inventory_requires_same_attempt_and_reconciled_count(provider, fault):
    class InconsistentDatabase(Database):
        def run(self, sql, **kwargs):
            result = super().run(sql, **kwargs)
            if "FROM inventory_snapshots" in sql:
                if fault == "pre_attempt":
                    result[0][2] = NOW - dt.timedelta(minutes=2)
                if fault == "snapshot_count":
                    result[0][1] = 12
            if "FROM inventory_sync_runs" in sql and fault == "ledger_count":
                result[0][4] = None
            return result
    bundle = discovery.collect(InconsistentDatabase([inventory("ec2", I1, {})]), ACCOUNT, Budget())
    assert not evidence(bundle, "inventory")[0]["fresh"]
    assert "inventory_unqualified" in bundle["incomplete"]


def test_duplicate_database_endpoint_is_not_an_exact_identity(provider):
    db = graph_fixture()
    db.rows[3][4]["endpoint_address"] = "db1.example.test"
    bundle = discovery.collect(db, ACCOUNT, Budget())
    iid = resource(bundle, I1)["id"]
    assert not any(e["source"] == iid and e["kind"] == "observed_call" for e in bundle["relationships"])
    assert "unresolved_instance_observation" in bundle["incomplete"]


def test_pair_cannot_use_a_trace_node_with_foreign_scope(provider):
    db = graph_fixture()
    db.nodes[-2][3]["accountId"] = "999900001111"
    bundle = discovery.collect(db, ACCOUNT, Budget())
    iid = resource(bundle, I1)["id"]
    assert not any(e["source"] == iid and e["kind"] == "observed_call" for e in bundle["relationships"])


def test_null_item_count_from_a_payload_capped_source_does_not_wipe_graph_evidence(provider):
    db = graph_fixture()
    db.states[1][4]["publishedSources"][0]["itemCount"] = None  # graph-inventory-read.ts limited type
    bundle = discovery.collect(db, ACCOUNT, Budget())
    assert "graph_read_failed" not in bundle["degraded"]
    assert evidence(bundle, "observed_call")


@pytest.mark.parametrize("change,complete", [
    ({"itemCount": None}, False), ({"itemCount": 1.5}, False), ({"itemCount": True}, False),
    ({"itemCount": "2"}, False), ({"itemCount": -1}, False), ({"itemCount": 2**53}, False),
    ({"itemCount": 0}, False),  # status ok requires a nonzero count
    ({"status": "empty"}, False),  # status empty requires a zero count
    ({"status": "empty", "itemCount": 0, "capturedAtMs": None}, True),
    ({"status": "empty", "itemCount": 0, "capturedAtMs": "bogus"}, False),
    ({"status": "empty", "itemCount": 0, "capturedAtMs": 0}, False),
    ({"lastSuccessAtMs": NOW.isoformat()}, False),
    ({"producerStatus": "running"}, False),
])
def test_inventory_source_qualification_mirrors_web_graph_state(provider, change, complete):
    db = graph_fixture()
    db.states[1][4]["publishedSources"][0].update(change)
    bundle = discovery.collect(db, ACCOUNT, Budget())
    assert bundle["coverage"]["graph"]["infra"]["complete"] is complete


def test_read_side_pair_cap_is_disclosed_by_its_sentinel(provider):
    db = graph_fixture()
    pair = db.edges[0][4]["instance_observations"][0]
    db.edges[0][4]["instance_observations"] = [dict(pair, correlation_id=f"pair:{i:04d}:x") for i in range(201)]
    bundle = discovery.collect(db, ACCOUNT, Budget())
    assert "instance_observation_cap" in bundle["incomplete"]
    edge_sql = next(sql for sql, _ in db.queries if "instance_observations" in sql and "jsonb_array_elements" in sql)
    assert "ORDER BY n LIMIT 201" in edge_sql  # stored order, one sentinel past the 200 kept


@pytest.mark.parametrize("key", ["instance_observations_omitted", "instance_observations_unbound"])
def test_edge_omitted_or_unbound_pairs_mark_that_edge_observations_incomplete(provider, key):
    db = graph_fixture()
    db.edges[0][4][key] = 2
    bundle = discovery.collect(db, ACCOUNT, Budget())
    pairs = {e["resource_ids"][0]: e for e in evidence(bundle, "observed_call") if e["facts"].get("correlation_id")}
    capped, other = pairs[resource(bundle, I1)["id"]], pairs[resource(bundle, I2)["id"]]
    assert capped["coverage"]["complete"] is False and capped["coverage"]["instance_observations_omitted"] == 2
    assert other["coverage"]["complete"] is True
    assert "instance_observation_cap" in bundle["incomplete"]


def test_pair_omission_counts_are_retained_as_partial_coverage(provider):
    db = graph_fixture()
    db.states[0][4]["instanceObservationDrops"] = 7
    db.edges[0][4]["instance_observations_omitted"] = 3
    bundle = discovery.collect(db, ACCOUNT, Budget())
    assert bundle["coverage"]["graph"]["trace"]["instance_observations_omitted"] == 7
    assert not bundle["coverage"]["graph"]["trace"]["complete"]
    assert "instance_observation_cap" in bundle["incomplete"]


def test_followup_is_single_pass_and_revalidates_host_identity(provider, monkeypatch):
    bundle = discovery.collect(Database([inventory("ec2", I1, {})]), ACCOUNT, Budget())
    request = [{"capability": "resource_metrics", "resource_ids": [resource(bundle, I1)["id"]]}]
    once = discovery.follow_up(Database(), ACCOUNT, bundle, request, Budget())
    before = len(provider.client_calls)
    twice = discovery.follow_up(Database(), ACCOUNT, once, request, Budget())
    assert len(provider.client_calls) == before
    assert "follow_up_rejected" in twice["gaps"]
    monkeypatch.setenv("DIAGNOSIS_HOST_ACCOUNT_ID", "999900001111")
    discovery.follow_up(Database(), ACCOUNT, bundle, request, Budget())
    assert len(provider.client_calls) == before


def test_provider_requests_respect_sdk_resource_list_bound(provider):
    count = discovery.MAX_INVENTORY_RESOURCES
    assert count > 100
    rows = [inventory("ec2", f"i-{i:017x}", {}) for i in range(count)]
    discovery.collect(Database(rows), ACCOUNT, Budget())
    calls = [args for op, args in provider.calls if op == "ec2"]
    assert calls and all(len(args["instanceArns"]) <= 100 for args in calls)
    assert {arn for args in calls for arn in args["instanceArns"]} == {
        f"arn:aws:ec2:{REGION}:{ACCOUNT}:instance/i-{i:017x}" for i in range(count)}


def test_database_timeout_restores_existing_policy_after_read_error(provider):
    class Socket:
        def __init__(self):
            self.timeout, self.changes = 30, []
        def gettimeout(self):
            return self.timeout
        def settimeout(self, seconds):
            self.timeout = seconds
            self.changes.append(seconds)

    class BlockedDatabase(Database):
        def __init__(self):
            super().__init__()
            self._usock = Socket()
        def run(self, sql, **kwargs):
            if "FROM inventory_resources" in sql:
                raise RuntimeError("server canceled statement")  # protocol stays in sync
            return super().run(sql, **kwargs)

    db = BlockedDatabase()
    bundle = discovery.collect(db, ACCOUNT, Budget(5))
    changes = [args["timeout"] for sql, args in db.queries if "set_config('statement_timeout'" in sql]
    # The server cancels before the 4s transport timeout closes the connection.
    assert "2000ms" in changes and changes[-1] == "30s"
    assert 4 in db._usock.changes and max(db._usock.changes[:-1]) <= 30
    assert db._usock.timeout == 30
    assert "inventory_read_failed" in bundle["degraded"]


def test_transport_timeout_closes_connection_and_skips_later_database_reads(provider):
    class BrokenDatabase(Database):
        closed = False
        def run(self, sql, **kwargs):
            self.queries.append((sql, kwargs))
            if "count(*)" in sql:
                raise TimeoutError("socket timed out mid-message")
            return super().run(sql, **kwargs)
        def close(self):
            self.closed = True

    db = BrokenDatabase([inventory("ec2", I1, {})])
    bundle = discovery.collect(db, ACCOUNT, Budget())
    # No restore SET or later collector query is sent on the desynced stream.
    assert "count(*)" in db.queries[-1][0] and db.closed
    assert bundle["coverage"]["database_connection_broken"] is True
    assert "database_connection_broken" in bundle["degraded"]
    assert "database_timeout_restore_failed" not in bundle["degraded"]


def test_resource_ids_are_deterministic_and_do_not_encode_the_account():
    one, other = ({"resources": [], "gaps": [], "degraded": [], "incomplete": []} for _ in range(2))
    rid = discovery._resource(one, ACCOUNT, REGION, "ec2", I1, {})["id"]
    assert discovery._resource(one, ACCOUNT, REGION, "ec2", I1, {})["id"] == rid
    assert discovery._resource(other, "999900001111", REGION, "ec2", I1, {})["id"] == rid


def test_followup_rejects_more_than_four_requests(provider):
    bundle = discovery.collect(Database([inventory("ec2", I1, {})]), ACCOUNT, Budget())
    before = len(provider.client_calls)
    requests = [{"capability": "resource_metrics", "resource_ids": [resource(bundle, I1)["id"]]}] * 5
    merged = discovery.follow_up(Database(), ACCOUNT, bundle, requests, Budget())
    assert len(provider.client_calls) == before
    assert "follow_up_rejected" in merged["gaps"]


@pytest.mark.parametrize("kind,values", [
    ("ec2", ["Memory", "EBS_READ_OPS_PER_SECOND", "EBS_WRITE_OPS_PER_SECOND"]),
    ("rds", ["Memory", "EBSVolumeReadIOPS", "EBSVolumeWriteIOPS"]),
])
def test_real_provider_utilization_names_preserve_memory_and_both_io_directions(provider, kind, values):
    row = recommendation()
    row["tags"] = []
    row["utilizationMetrics"] = [{"name": name, "statistic": "Maximum", "value": 20} for name in values]
    if kind == "rds":
        row["resourceArn"] = f"arn:aws:rds:{REGION}:{ACCOUNT}:db:orders"
        row["currentDBInstanceClass"] = row.pop("currentInstanceType")
        row["instanceFinding"] = row.pop("finding")
        row["lookbackPeriodInDays"] = row.pop("lookBackPeriodInDays")
        row["instanceRecommendationOptions"] = row.pop("recommendationOptions")
        for option in row["instanceRecommendationOptions"]:
            option["dbInstanceClass"] = option.pop("instanceType")
        provider.rds = [{"rdsDBRecommendations": [row]}]
        rid = "orders"
    else:
        provider.ec2 = [{"instanceRecommendations": [row]}]
        rid = I1
    bundle = discovery.collect(Database([inventory(kind, rid, {})]), ACCOUNT, Budget())
    facts = evidence(bundle, "provider_sizing")[0]["facts"]
    assert facts["missing_memory"] is False and facts["missing_io"] is False
    assert facts["recommended_type"] == "m7g.large"
    assert ("replica_source_unknown" in facts["guard_hits"]) is (kind == "rds")


def test_inventory_arn_cannot_substitute_a_different_resource(provider):
    bundle = discovery.collect(Database([inventory("ec2", I1, {
        "arn": f"arn:aws:ec2:{REGION}:{ACCOUNT}:instance/{I2}"})]), ACCOUNT, Budget())
    assert not any(op == "ec2" for op, _ in provider.calls)
    assert not evidence(bundle, "provider_sizing")


def test_graph_refresh_cannot_retain_superseded_freshness(provider):
    db = graph_fixture()
    bundle = discovery.collect(db, ACCOUNT, Budget())
    assert any(e["fresh"] for e in evidence(bundle, "observed_call"))
    db.states[0][4]["retainedPrevious"] = True
    merged = discovery.follow_up(db, ACCOUNT, bundle, [
        {"capability": "graph_refresh", "resource_ids": [resource(bundle, I1)["id"]]}], Budget())
    assert not any(e["fresh"] for e in evidence(merged, "observed_call"))


@pytest.mark.parametrize("scope", ["self", "999900001111"])
@pytest.mark.parametrize("failure", ["removed_edge", "partial_state", "read_failed"])
def test_graph_refresh_retires_missing_first_pass_evidence(provider, scope, failure):
    from diagnosis.evidence import EvidenceIndex

    db = graph_fixture()
    account = ACCOUNT if scope == "self" else scope
    if scope != "self":
        for row in db.rows:
            row[0] = scope
        for row in db.nodes:
            if row[-1] == "infra":
                row[3]["inventoryAccount"] = scope
        db.edges = [[db.nodes[0][0], db.nodes[2][0], "uses", "configured", {}, NOW, "infra"]]
    else:
        provider.ec2 = [{"instanceRecommendations": [recommendation()]}]
    bundle = discovery.collect(db, account, Budget(), scope=scope)
    instance_id, database_id = resource(bundle, I1)["id"], resource(bundle, "db1")["id"]
    old = next(e for e in bundle["evidence"] if e["source"] == "stored_graph"
               and set(e["resource_ids"]) == {instance_id, database_id})
    assert old["fresh"] is True
    others = copy.deepcopy([e for e in bundle["evidence"] if e["source"] != "stored_graph"])
    selected = {
        "id": "first-pass", "pillar": "reliability", "severity": "medium",
        "resource_ids": [instance_id, database_id], "evidence_ids": [old["id"]],
        "claim": "observation", "explanation": "The dependency was observed in this sample.",
        "prerequisites": [], "verification": "graph_refresh",
    }
    if scope == "self":
        assert EvidenceIndex(bundle, account).validate_finding(selected)["claim"] == "observation"
    # The prior edge disappears from the new graph. Partial or failed reads must
    # never keep its first-pass qualification, even when no replacement ID exists.
    db.edges = []
    refreshed_class = "trace" if scope == "self" else "infra"
    if failure == "partial_state":
        next(row for row in db.states if row[0] == refreshed_class)[1] = "partial"
    elif failure == "read_failed":
        original_run = db.run

        def failed_read(sql, **kwargs):
            if "FROM topology_graph_state" in sql:
                raise TimeoutError("simulated graph read failure")
            return original_run(sql, **kwargs)

        db.run = failed_read
    merged = discovery.follow_up(db, account, bundle, [
        {"capability": "graph_refresh", "resource_ids": [instance_id]}], Budget())
    retired = next(e for e in merged["evidence"] if e["id"] == old["id"])
    assert retired["fresh"] is False
    assert retired["coverage"]["complete"] is False
    assert EvidenceIndex(merged, account).validate_finding(selected)["claim"] == "hypothesis"
    assert [e for e in merged["evidence"] if e["source"] != "stored_graph"] == others
    assert merged["incomplete"]
    if failure == "read_failed":
        assert "graph_read_failed" in merged["degraded"]
        assert merged["coverage"]["graph"][refreshed_class]["complete"] is False


def test_graph_refresh_requalifies_only_evidence_read_again(provider):
    db = graph_fixture()
    bundle = discovery.collect(db, ACCOUNT, Budget())
    old_ids = {e["id"] for e in bundle["evidence"] if e["source"] == "stored_graph"}
    merged = discovery.follow_up(db, ACCOUNT, bundle, [
        {"capability": "graph_refresh", "resource_ids": [resource(bundle, I1)["id"]]}], Budget())
    assert all(e["fresh"] for e in merged["evidence"] if e["id"] in old_ids)
    assert "graph_retained_history" not in merged["incomplete"]


def test_evidence_index_retains_native_metrics_and_provider_shapes(provider):
    from diagnosis.evidence import EvidenceIndex
    provider.metrics = metric_response
    provider.ec2 = [{"instanceRecommendations": [recommendation()]}]
    bundle = discovery.collect(Database([inventory("ec2", I1, {"instance_type": "m7g.xlarge"})]), ACCOUNT, Budget())
    admitted = EvidenceIndex(bundle, ACCOUNT).admitted_bundle()
    metric = evidence(admitted, "metrics")[0]["facts"]["metrics"]["CPUUtilization"]["Maximum"]
    assert metric == {"min": 25.0, "max": 25.0, "mean": 25.0, "samples": 336, "status": "Complete", "unit": "Percent"}
    provider_fact = evidence(admitted, "provider_sizing")[0]["facts"]
    assert (provider_fact["rank"], provider_fact["currency"], provider_fact["generation_time"]) == (1, "USD", NOW.isoformat())
    assert provider_fact["guard_hits"] == ["protected_tag:dr"]


def test_pair_and_source_without_source_ids_do_not_lose_the_graph(provider):
    db = graph_fixture()
    db.states[0][4]["sources"].append({"status": "ok", "itemCount": 0})
    db.edges[0][4]["instance_observations"][0].pop("source_id")
    bundle = discovery.collect(db, ACCOUNT, Budget())
    assert "graph_read_failed" not in bundle["degraded"]
    assert "unresolved_instance_observation" in bundle["incomplete"]
    reverse = {r["id"]: r["resource_id"] for r in bundle["resources"]}
    pairs = {(reverse[e["source"]], reverse[e["target"]]) for e in bundle["relationships"]
             if e["kind"] == "observed_call" and reverse[e["source"]].startswith("i-")}
    assert pairs == {(I2, "db2")}


def test_xray_facts_survive_admission_and_unresolved_binding_is_not_an_observation(provider):
    from diagnosis.evidence import EvidenceIndex
    provider.xray = [{"Services": [{"ReferenceId": 1, "Name": "app", "Edges": [
                        {"ReferenceId": 2, "SummaryStatistics": {"TotalCount": 10,
                         "ErrorStatistics": {"TotalCount": 1}, "FaultStatistics": {"TotalCount": 2}}}]},
                     {"ReferenceId": 2, "Name": "database"}]}]
    bundle = discovery.collect(Database([inventory("ec2", I1, {})]), ACCOUNT, Budget())
    index = EvidenceIndex(bundle, ACCOUNT)
    row = next(e for e in index.admitted_bundle()["evidence"] if e["source"] == "xray")
    assert row["facts"]["resource_binding"] == "unresolved"
    assert (row["facts"]["from_name"], row["facts"]["to_name"], row["facts"]["calls"]) == ("app", "database", 10)
    assert row["facts"]["error_rate"] == 0.1 and row["coverage"]["complete"] is True
    assert row["facts"]["fault_rate"] == 0.2
    result = index.validate_finding({"id": "finding-xray", "pillar": "reliability", "severity": "medium",
        "resource_ids": row["resource_ids"], "evidence_ids": [row["id"]], "claim": "observation",
        "explanation": "The service edge needs verification.", "prerequisites": [],
        "verification": "graph_refresh"})
    assert result["claim"] == "hypothesis"


def test_late_graph_refresh_keeps_prior_qualification_and_dedupes_on_capability(provider):
    db = graph_fixture()
    bundle = discovery.collect(db, ACCOUNT, Budget())
    fresh_ids = {e["id"] for e in bundle["evidence"] if e["source"] == "stored_graph" and e["fresh"]}
    assert fresh_ids
    i1, i2 = resource(bundle, I1)["id"], resource(bundle, I2)["id"]
    # Past the deadline no graph IO happens, so nothing first-pass is retired.
    late = discovery.follow_up(db, ACCOUNT, bundle, [
        {"capability": "graph_refresh", "resource_ids": [i1]}], Budget(0))
    assert fresh_ids == {e["id"] for e in late["evidence"] if e["source"] == "stored_graph" and e["fresh"]}
    assert "discovery_deadline" in late["incomplete"]
    db.queries.clear()
    discovery.follow_up(db, ACCOUNT, bundle, [
        {"capability": "graph_refresh", "resource_ids": [i1]},
        {"capability": "graph_refresh", "resource_ids": [i2]}], Budget())
    assert sum("FROM topology_graph_state" in sql for sql, _ in db.queries) == 1


def test_memory_collection_failure_degrades_one_source_not_collect(provider, monkeypatch):
    from diagnosis import memory_metrics

    def broken(*args, **kwargs):
        raise KeyError("simulated memory collector defect")
    monkeypatch.setattr(memory_metrics, "collect", broken)
    provider.metrics = metric_response
    bundle = discovery.collect(Database([inventory("ec2", I1, {})]), ACCOUNT, Budget())
    item = evidence(bundle, "metrics")[0]
    assert item["facts"]["missing_memory"] is True
    assert "memory_metrics_read_failed" in bundle["degraded"]
    assert "metrics_read_failed" not in bundle["degraded"]


def test_collect_refuses_when_evidence_loop_is_disabled(provider, monkeypatch):
    monkeypatch.setenv("DIAGNOSIS_EVIDENCE_LOOP_ENABLED", "false")
    db = graph_fixture()
    bundle = discovery.collect(db, ACCOUNT, Budget())
    assert "evidence_loop_disabled" in bundle["gaps"]
    assert not db.queries and not provider.client_calls and not bundle["evidence"]


@pytest.mark.parametrize("detail", [
    {"nodeDrops": 1}, {"edgeDrops": 2}, {"orphanSpans": 1}, {"invalidSpans": 1},
    {"unresolvedMessaging": 3}, {"infraUnavailable": True}, {"failureReason": "source_read_failed"},
    {"nodeDrops": "many"},
])
def test_trace_loss_counters_and_failure_reason_disqualify_the_graph(provider, detail):
    db = graph_fixture()
    db.states[0][4].update({"nodeDrops": 0, "edgeDrops": 0, "instanceObservationDrops": 0})
    assert discovery.collect(db, ACCOUNT, Budget())["coverage"]["graph"]["trace"]["complete"]
    db.states[0][4].update(detail)
    assert not discovery.collect(db, ACCOUNT, Budget())["coverage"]["graph"]["trace"]["complete"]


def test_provider_guards_separate_inventory_row_and_provider_staleness(provider):
    provider.ec2 = [{"instanceRecommendations": [{**recommendation(), "tags": []}]}]
    bundle = discovery.collect(Database([inventory("ec2", I1, {}, captured=NOW - dt.timedelta(days=2))]),
                               ACCOUNT, Budget())
    guards = evidence(bundle, "provider_sizing")[0]["facts"]["guard_hits"]
    assert "stale_inventory_data" in guards and "stale_provider_recommendation" not in guards
    provider.ec2 = [{"instanceRecommendations": [{**recommendation(), "tags": [],
                                                  "lastRefreshTimestamp": NOW - dt.timedelta(days=3)}]}]
    bundle = discovery.collect(Database([inventory("ec2", I1, {})]), ACCOUNT, Budget())
    guards = evidence(bundle, "provider_sizing")[0]["facts"]["guard_hits"]
    assert "stale_provider_recommendation" in guards and "stale_inventory_data" not in guards


def test_zero_sample_metrics_are_never_fresh_and_unqueried_identity_emits_nothing(provider):
    # Pages were read (complete) but no datapoint came back: measured nothing.
    bundle = discovery.collect(Database([inventory("ec2", I1, {})]), ACCOUNT, Budget())
    item = evidence(bundle, "metrics")[0]
    assert item["coverage"]["sample_ratio"] == 0 and item["fresh"] is False
    unresolved = discovery.collect(Database([inventory("ec2", "not-an-instance", {})]), ACCOUNT, Budget())
    assert not evidence(unresolved, "metrics")
    assert "metric_identity_unresolved" in unresolved["incomplete"]


def test_followup_supersedes_prior_metrics_and_eviction_keeps_current_row(provider, monkeypatch):
    provider.metrics = metric_response
    bundle = discovery.collect(Database([inventory("ec2", I1, {})]), ACCOUNT, Budget())
    first = evidence(bundle, "metrics")[0]
    assert first["fresh"] is True
    monkeypatch.setattr(discovery, "_now", lambda: NOW + dt.timedelta(minutes=1))
    merged = discovery.follow_up(Database(), ACCOUNT, bundle, [
        {"capability": "resource_metrics", "resource_ids": first["resource_ids"]}], Budget())
    rows = {e["id"]: e for e in evidence(merged, "metrics")}
    assert rows[first["id"]]["fresh"] is False
    assert rows[first["id"]]["coverage"]["retained_previous"] is True
    assert [e["fresh"] for e in rows.values() if e["id"] != first["id"]] == [True]
    capped = {"resources": [], "relationships": [], "gaps": [], "degraded": [], "incomplete": [],
              "coverage": {"account": ACCOUNT},
              "evidence": [{"id": "old", "source": "cloudwatch", "fresh": False, "facts": "m" * 120000},
                           {"id": "new", "source": "cloudwatch", "fresh": True, "facts": "m" * 120000}]}
    assert [e["id"] for e in discovery._finish(capped)["evidence"]] == ["new"]


def metric_series(kwargs, empty=()):
    """Complete series; metric names in ``empty`` return Complete with no datapoints."""
    end = kwargs["EndTime"]
    return {"MetricDataResults": [
        {"Id": q["Id"], "StatusCode": "Complete",
         **({"Values": [], "Timestamps": []} if q["MetricStat"]["Metric"]["MetricName"] in empty else
            {"Values": [25.0] * 336, "Timestamps": [end - dt.timedelta(hours=i + 1) for i in range(336)]})}
        for q in kwargs["MetricDataQueries"]]}


def test_unpublished_metrics_are_disclosed_not_coverage_loss(provider):
    provider.metrics = lambda args: metric_series(args, empty={"EBSReadBytes", "EBSWriteBytes"})
    bundle = discovery.collect(Database([inventory("ec2", I1, {})]), ACCOUNT, Budget())
    item = evidence(bundle, "metrics")[0]
    assert item["facts"]["metrics_not_published"] == ["EBSReadBytes", "EBSWriteBytes"]
    assert item["coverage"]["sample_ratio"] == 1 and item["fresh"] is True
    assert item["facts"]["missing_io"] is True  # unpublished I/O still never proves I/O headroom
    # Required pressure metrics with no samples stay coverage loss.
    provider.metrics = lambda args: metric_series(args, empty={"CPUUtilization"})
    item = evidence(discovery.collect(Database([inventory("ec2", I1, {})]), ACCOUNT, Budget()), "metrics")[0]
    assert item["coverage"]["sample_ratio"] == 0 and "CPUUtilization" not in item["facts"]["metrics_not_published"]


def test_oversized_graph_coverage_is_bounded_with_omitted_counts():
    source = {"sourceId": "s" * 128, "status": "o" * 128, "producerStatus": "p" * 128, "scope": "x" * 128,
              "reasons": ["query_failed"] * 16}
    bundle = {"resources": [], "evidence": [], "relationships": [], "gaps": [], "degraded": [], "incomplete": [],
              "coverage": {"account": ACCOUNT, "graph": {cls: {"status": "ok", "complete": False,
                           "sources": [dict(source) for _ in range(128)]} for cls in ("flow", "infra", "trace")}}}
    result = discovery._finish(bundle)
    assert len(json.dumps(result, ensure_ascii=False).encode()) <= discovery.MAX_BYTES
    assert all(c["sources_omitted"] + len(c["sources"]) == 128 for c in result["coverage"]["graph"].values())
    assert "coverage_byte_cap" in result["incomplete"]


def test_task_projection_failure_keeps_inventory_disclosure(provider, monkeypatch):
    from diagnosis import workload_identities

    def broken(bundle):
        raise KeyError("simulated projection defect")
    monkeypatch.setattr(workload_identities, "project_tasks", broken)
    bundle = discovery.collect(Database([inventory("ec2", I1, {})]), ACCOUNT, Budget())
    assert bundle["coverage"]["inventory"]["total"] == 1
    assert "task_projection_failed" in bundle["degraded"]
    assert "inventory_read_failed" not in bundle["degraded"]


@pytest.mark.parametrize("pages", [
    [{"Services": [{"ReferenceId": 1, "Name": "app", "Edges": [{"ReferenceId": 2}]},
                   {"ReferenceId": 2, "Name": "db"}], "NextToken": "repeat"}] * 3,
    [{"Services": [{"ReferenceId": 1, "Name": "app", "Edges": [{"ReferenceId": 2}]},
                   {"ReferenceId": 2, "Name": "db"}, {"ReferenceId": "bad"}]}],
])
def test_incomplete_xray_reads_are_never_fresh(provider, pages):
    provider.xray = pages
    bundle = discovery.collect(Database([inventory("ec2", I1, {})]), ACCOUNT, Budget())
    rows = [e for e in bundle["evidence"] if e["source"] == "xray"]
    assert rows and all(e["fresh"] is False and e["coverage"]["complete"] is False for e in rows)


def test_aurora_members_never_imply_standalone(provider):
    provider.metrics = metric_response
    key = "read_replica_source_db_instance_identifier"
    db = Database([inventory("rds", "reader", {"db_instance_identifier": "reader", "engine": "aurora-postgresql",
                                               key: None})])
    bundle = discovery.collect(db, ACCOUNT, Budget())
    item = evidence(bundle, "metrics")[0]
    assert item["facts"]["replica_source"] == "unknown"
    assert "rds_aurora_role_unknown" in bundle["gaps"]


def test_inventory_cannot_starve_xray_service_nodes():
    bundle = {"resources": [], "gaps": [], "degraded": [], "incomplete": []}
    shared = discovery.MAX_RESOURCES - discovery.MAX_XRAY_RESOURCES
    for i in range(shared + 5):  # inventory, trace identities and proxies share one pool
        discovery._resource(bundle, ACCOUNT, REGION, "ec2", f"i-{i:017x}", {})
    assert len(bundle["resources"]) == shared and "resource_cap" in bundle["incomplete"]
    for ref in range(discovery.MAX_XRAY_RESOURCES + 5):
        discovery._resource(bundle, ACCOUNT, REGION, "service", f"xray:{ref}", {})
    assert len(bundle["resources"]) == discovery.MAX_RESOURCES
    assert "xray_resource_cap" in bundle["incomplete"]


def test_follow_up_can_use_a_reconnected_database_after_transport_failure(provider):
    class BrokenDatabase(Database):
        def run(self, sql, **kwargs):
            if "FROM finops_findings" in sql:
                raise TimeoutError("socket timed out mid-message")
            return super().run(sql, **kwargs)
        def close(self):
            pass

    first = discovery.collect(BrokenDatabase(graph_fixture().rows), ACCOUNT, Budget())
    assert discovery.connection_broken(first)
    assert discovery.DATABASE_CONNECTION_BROKEN in first["degraded"]
    reconnected = graph_fixture()
    merged = discovery.follow_up(reconnected, ACCOUNT, first, [
        {"capability": "graph_refresh", "resource_ids": [resource(first, I1)["id"]]}], Budget())
    assert any("FROM topology_graph_state" in sql for sql, _ in reconnected.queries)
    assert "graph_read_failed" not in merged["degraded"] and not discovery.connection_broken(merged)


def test_empty_inventory_is_disclosed_as_unconfirmed_not_verified(provider):
    bundle = discovery.collect(Database([]), ACCOUNT, Budget())
    assert bundle["coverage"]["inventory"]["confirmed"] is False
    assert bundle["coverage"]["inventory"]["total"] == 0
    assert "inventory_empty_not_confirmed" in bundle["gaps"]
    assert bundle["coverage"]["regions"]["selected"] == []


def test_member_scope_requires_applied_host_identity(provider, monkeypatch):
    monkeypatch.delenv("DIAGNOSIS_HOST_ACCOUNT_ID")
    db = Database([inventory("ec2", I1, {}, account=ACCOUNT)])
    bundle = discovery.collect(db, ACCOUNT, Budget(), scope=ACCOUNT)
    assert not db.queries and not provider.client_calls
    assert "untrusted_host_scope" in bundle["degraded"]


def test_followup_makes_no_live_reads_once_the_flag_is_off(provider, monkeypatch):
    bundle = discovery.collect(Database([inventory("ec2", I1, {})]), ACCOUNT, Budget())
    before = len(provider.client_calls)
    monkeypatch.setenv("DIAGNOSIS_EVIDENCE_LOOP_ENABLED", "false")
    merged = discovery.follow_up(Database(), ACCOUNT, bundle, [
        {"capability": "resource_metrics", "resource_ids": [resource(bundle, I1)["id"]]}], Budget())
    assert len(provider.client_calls) == before
    assert "follow_up_rejected" in merged["gaps"]
