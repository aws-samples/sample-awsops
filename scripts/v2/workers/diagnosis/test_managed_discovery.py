"""Provider boundaries are simulated; scope, correlation and admission stay real."""
import copy
import datetime as dt
import json

import pytest

from diagnosis import discovery
from diagnosis import managed_discovery as managed
from diagnosis.evidence import EvidenceIndex
from diagnosis.test_discovery import ACCOUNT, REGION, NOW, I1, Budget, Database, inventory, Provider

SPACE = "12345678-1234-1234-1234-123456789abc"
DB_ARN = f"arn:aws:rds:{REGION}:{ACCOUNT}:db:orders"
INSTANCE_ARN = f"arn:aws:ec2:{REGION}:{ACCOUNT}:instance/{I1}"
SERVICE = {"Type": "Service", "Name": "checkout", "Environment": "ec2:production"}


class ManagedProvider(Provider):
    def __init__(self):
        super().__init__()
        self.pages = {}

    def get_paginator(self, operation):
        if operation in ("get_service_graph", "get_metric_data"):
            return super().get_paginator(operation)
        owner = self

        class Pager:
            def paginate(self, **parameters):
                owner.calls.append((operation, parameters))
                for page in copy.deepcopy(owner.pages.get(operation, [])):
                    yield page
        return Pager()


@pytest.fixture
def managed_provider(monkeypatch):
    provider = ManagedProvider()
    monkeypatch.setenv("DIAGNOSIS_EVIDENCE_LOOP_ENABLED", "true")
    monkeypatch.setenv("DIAGNOSIS_MANAGED_DISCOVERY_ENABLED", "true")
    monkeypatch.setenv("DIAGNOSIS_HOST_ACCOUNT_ID", ACCOUNT)
    monkeypatch.setenv("AWS_REGION", REGION)
    monkeypatch.setattr(discovery, "_now", lambda: NOW)
    monkeypatch.setattr(discovery, "_client", lambda service, region, budget: provider)
    return provider


def database():
    return Database([
        inventory("ec2", I1, {"arn": INSTANCE_ARN, "private_ip_address": "10.0.1.4"}),
        inventory("rds", "orders", {"arn": DB_ARN, "endpoint_address": "orders.example.test"}),
    ])


def summary(**updates):
    return {
        "KeyAttributes": SERVICE,
        "AttributeMaps": [{"aws.ec2.instance.id": I1}],
        "MetricReferences": [{"AccountId": ACCOUNT, "Namespace": "ApplicationSignals",
                              "MetricName": "Latency", "MetricType": "Latency", "Dimensions": []}],
        **updates,
    }


def dependency(**updates):
    return {
        "DependencyKeyAttributes": {"Type": "AWS::Resource", "ResourceType": "AWS::RDS::DBInstance",
                                    "Identifier": DB_ARN},
        "OperationName": "GET /orders",
        "DependencyOperationName": "SELECT",
        "MetricReferences": [{"AccountId": ACCOUNT, "Namespace": "ApplicationSignals",
                              "MetricName": "Latency", "MetricType": "Latency", "Dimensions": []}],
        **updates,
    }


def calls(bundle, source="application_signals"):
    return [e for e in bundle["evidence"] if e["source"] == source and e["kind"] == "observed_call"]


@pytest.mark.parametrize("member", [False, True])
def test_optional_managed_failure_preserves_inventory(managed_provider, monkeypatch, member):
    if member:
        from diagnosis import scoped_clients
        monkeypatch.setenv("DIAGNOSIS_HOST_ACCOUNT_ID", "999900001111")
        monkeypatch.setattr(scoped_clients, "member_factory",
                            lambda *args: lambda *args: managed_provider)

    def broken(*args, **kwargs):
        raise RuntimeError("provider-secret-must-not-appear")

    monkeypatch.setattr(managed, "collect", broken)
    conn = database()
    if member:
        for row in conn.rows:
            row[0] = ACCOUNT
    bundle = discovery.collect(conn, ACCOUNT, Budget(), scope=ACCOUNT if member else "self")
    assert {I1, "orders"} <= {r["resource_id"] for r in bundle["resources"]}
    assert any(e["kind"] == "inventory" for e in bundle["evidence"])
    assert "managed_discovery_failed" in bundle["degraded"]
    assert "provider-secret" not in json.dumps(bundle)


def test_optional_failure_disqualifies_already_emitted_managed_batch(managed_provider, monkeypatch):
    signals_pages(managed_provider)
    original = managed.collect
    emitted = []
    def broken(*args, **kwargs):
        original(*args, **kwargs)
        ids = {e["id"] for e in args[0]["evidence"] if e["source"] == "application_signals"}
        emitted.extend(r for r in args[0]["relationships"] if ids.intersection(r["evidence_ids"]))
        raise RuntimeError("late qualification failure")
    monkeypatch.setattr(managed, "collect", broken)
    bundle = discovery.collect(database(), ACCOUNT, Budget())
    assert calls(bundle)
    assert all(not e["fresh"] and not e["coverage"]["complete"] for e in calls(bundle))
    assert emitted, "The failure must follow actual relationship emission."
    ids = {e["id"] for e in calls(bundle)}
    assert not any(ids.intersection(r["evidence_ids"]) for r in bundle["relationships"])
    assert all(e["fresh"] for e in bundle["evidence"] if e["kind"] == "inventory")


def test_xray_telemetry_family_survives_admission(managed_provider):
    managed_provider.xray = [{"Services": [
        {"ReferenceId": 1, "Name": "checkout", "Edges": [
            {"ReferenceId": 2, "SummaryStatistics": {"TotalCount": 1}}]},
        {"ReferenceId": 2, "Name": "db"}]}]
    index = EvidenceIndex(discovery.collect(database(), ACCOUNT, Budget()), ACCOUNT)
    rows = [e for e in index.admitted_bundle()["evidence"] if e["source"] == "xray"]
    assert rows and all(e["facts"]["provenance_family"] == "application_telemetry" for e in rows)


@pytest.mark.parametrize("attrs", [
    [{"aws.rds.db_instance.id": I1}],
    [{"cloud.resource_id": I1, "aws.rds.db_instance.id": I1}],
    [{"aws.ec2.instance.id": I1, "aws.rds.db_instance.id": "missing-db"}],
])
def test_typed_host_attributes_never_bind_the_wrong_kind(managed_provider, attrs):
    signals_pages(managed_provider, service=summary(AttributeMaps=attrs))
    bundle = discovery.collect(database(), ACCOUNT, Budget())
    assert not any(e["source"] == "application_signals"
                   and e["facts"].get("relation") == "RUNS_ON" for e in bundle["evidence"])


def test_late_orphan_logical_cap_disqualifies_prior_calls(managed_provider):
    signals_pages(managed_provider)
    services = [summary(KeyAttributes={**SERVICE, "Name": f"service-{i}"}, AttributeMaps=[])
                for i in range(3)]
    managed_provider.pages["list_services"][0]["ServiceSummaries"] = services
    original = managed_provider.get_paginator

    def paginator(operation):
        if operation != "list_service_dependencies":
            return original(operation)
        class Pager:
            def paginate(self, **params):
                deps = [dependency()] if params["KeyAttributes"]["Name"] == "service-0" else []
                yield {"StartTime": NOW - dt.timedelta(hours=3), "EndTime": NOW,
                       "ServiceDependencies": deps}
        return Pager()
    managed_provider.get_paginator = paginator
    # Reach the late orphan resource cap before the independent request cap.
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(managed, "MAX_NEW_RESOURCES", 2)
        bundle = discovery.collect(database(), ACCOUNT, Budget())
    assert "managed_discovery_resource_cap" in bundle["incomplete"]
    assert calls(bundle)
    assert bundle["coverage"]["application_signals"][REGION]["complete"] is False
    assert all(not e["fresh"] and not e["coverage"]["complete"] for e in calls(bundle))


def test_deadline_between_service_iterations_disqualifies_prior_calls(managed_provider, monkeypatch):
    signals_pages(managed_provider)
    managed_provider.pages["list_services"][0]["ServiceSummaries"].append(
        summary(KeyAttributes={**SERVICE, "Name": "later"}))
    # Inventory is collected first; inject exhaustion only into managed processing.
    bundle = discovery.collect(database(), ACCOUNT, Budget())
    ids = {e["id"] for e in bundle["evidence"] if e["source"] == "application_signals"}
    bundle["evidence"] = [e for e in bundle["evidence"] if e["source"] != "application_signals"]
    bundle["relationships"] = [r for r in bundle["relationships"] if not ids.intersection(r["evidence_ids"])]
    monkeypatch.setattr(discovery, "_available",
                        lambda b, budget: not bool(calls(b)))
    managed._signals(bundle, Budget(), REGION, discovery._client)
    assert calls(bundle)
    assert bundle["coverage"]["application_signals"][REGION]["complete"] is False
    assert all(not e["fresh"] for e in calls(bundle))


def test_managed_regional_coverage_survives_model_and_report_projection(managed_provider):
    signals_pages(managed_provider)
    index = EvidenceIndex(discovery.collect(database(), ACCOUNT, Budget()), ACCOUNT)
    for projected in (index.admitted_bundle(), index.model_context()):
        signals = projected["coverage"]["application_signals"][REGION]
        assert signals["complete"] is True
        assert signals["requests"] == 2 and signals["pages"] == 2
        assert signals["sampled"] is True and signals["topology_complete"] is False
        assert projected["coverage"]["cloudwatch_omni"][REGION]["complete"] is False


def test_signals_connects_service_compute_and_db_without_fanning_out_calls(managed_provider):
    managed_provider.pages = {"list_services": [{"StartTime": NOW - dt.timedelta(hours=3),
                                                "EndTime": NOW, "ServiceSummaries": [summary()]}],
                              "list_service_dependencies": [{"StartTime": NOW - dt.timedelta(hours=3),
                                                             "EndTime": NOW,
                                                             "ServiceDependencies": [dependency()]}]}
    bundle = discovery.collect(database(), ACCOUNT, Budget())
    observed = calls(bundle)
    assert len(observed) == 1
    by_id = {r["id"]: r for r in bundle["resources"]}
    assert {by_id[r]["kind"] for r in observed[0]["resource_ids"]} == {"service", "rds"}
    assert I1 not in {by_id[r]["resource_id"] for r in observed[0]["resource_ids"]}
    hosting = [e for e in bundle["evidence"] if e["source"] == "application_signals"
               and e["kind"] == "configured_dependency"]
    assert len(hosting) == 1 and I1 in {by_id[r]["resource_id"] for r in hosting[0]["resource_ids"]}
    assert observed[0]["facts"]["resource_binding"] == "exact"
    assert observed[0]["fresh"] is True
    request = next(p for operation, p in managed_provider.calls if operation == "list_services")
    assert request["IncludeLinkedAccounts"] is False
    assert request["AwsAccountId"] == ACCOUNT
    assert "omni_disabled_pending_iam_scope" in bundle["gaps"]


def signals_pages(provider, *, service=None, dep=None):
    provider.pages = {"list_services": [{"StartTime": NOW - dt.timedelta(hours=3), "EndTime": NOW,
                                         "ServiceSummaries": [summary() if service is None else service]}],
                      "list_service_dependencies": [{"StartTime": NOW - dt.timedelta(hours=3), "EndTime": NOW,
                                                     "ServiceDependencies": [dependency() if dep is None else dep]}]}


@pytest.mark.parametrize("config", [
    "{}", "invalid json", "[]", json.dumps({f"{ACCOUNT}/{REGION}": SPACE}),
    json.dumps({f"999900001111/{REGION}": SPACE}),
])
def test_production_omni_hold_ignores_every_space_configuration(managed_provider, monkeypatch, config):
    monkeypatch.setenv("DIAGNOSIS_OMNI_SPACES", config)
    signals_pages(managed_provider)
    def forbidden(*args, **kwargs):
        pytest.fail("Production must not invoke the inactive Omni adapter.")
    monkeypatch.setattr(managed, "_omni", forbidden)
    bundle = discovery.collect(database(), ACCOUNT, Budget())
    assert calls(bundle) and all(e["fresh"] for e in calls(bundle))
    assert bundle["coverage"]["cloudwatch_omni"][REGION]["status"] == "disabled_pending_iam_scope"
    assert "omni_disabled_pending_iam_scope" in bundle["gaps"]
    assert not any(op in ("get_context_graph", "get_space_credentials_for_organization")
                   for op, _ in managed_provider.calls)


def test_signals_bad_row_does_not_void_valid_dependency(managed_provider):
    signals_pages(managed_provider)
    managed_provider.pages["list_service_dependencies"][0]["ServiceDependencies"].append(
        dependency(MetricReferences=[{"AccountId": "999900001111"}]))
    bundle = discovery.collect(database(), ACCOUNT, Budget())
    assert calls(bundle) and all(e["fresh"] and e["coverage"]["complete"] for e in calls(bundle))
    assert "application_signals_identity_unconfirmed" in bundle["gaps"]
    assert EvidenceIndex(bundle, ACCOUNT).relationships


@pytest.mark.parametrize("member", [False, True])
def test_late_page_timeout_stops_host_and_member_reads_and_disqualifies_prior_rows(
        managed_provider, monkeypatch, member):
    from botocore.config import Config
    signals_pages(managed_provider)
    managed_provider._client_config = Config(connect_timeout=1, read_timeout=10)
    budget = Budget()
    conn = database()
    if member:
        from diagnosis import scoped_clients
        monkeypatch.setenv("DIAGNOSIS_HOST_ACCOUNT_ID", "999900001111")
        monkeypatch.setattr(scoped_clients, "member_factory",
                            lambda *args: lambda *args: managed_provider)
        monkeypatch.setattr(discovery, "_client",
                            lambda *args: pytest.fail("host client used for member"))
        for row in conn.rows:
            row[0] = ACCOUNT
    original = managed_provider.get_paginator
    def paginator(operation):
        if operation != "list_service_dependencies":
            return original(operation)
        class Pager:
            def paginate(self, **params):
                managed_provider.calls.append((operation, params))
                # The first response used most of the remaining budget.
                budget.seconds = 3
                yield {**managed_provider.pages[operation][0], "NextToken": "later"}
                pytest.fail("A second HTTP request exceeded the remaining timeout budget.")
        return Pager()
    managed_provider.get_paginator = paginator
    bundle = discovery.collect(conn, ACCOUNT, budget, scope=ACCOUNT if member else "self")
    assert calls(bundle), "At least one earlier observation must be disqualified."
    assert all(not e["fresh"] and not e["coverage"]["complete"] for e in calls(bundle))
    assert bundle["coverage"]["application_signals"][REGION]["requests"] == 2
    assert "managed_discovery_deadline" in bundle["incomplete"]


@pytest.mark.parametrize("seconds", [3, 11])
def test_initial_client_timeout_is_deadline_not_empty_catalog(managed_provider, monkeypatch, seconds):
    from botocore.config import Config
    monkeypatch.setenv("DIAGNOSIS_MANAGED_DISCOVERY_ENABLED", "false")
    bundle = discovery.collect(database(), ACCOUNT, Budget())
    signals_pages(managed_provider)
    managed_provider.calls.clear()
    managed_provider._client_config = Config(connect_timeout=1, read_timeout=10)
    managed._signals(bundle, Budget(seconds=seconds), REGION, discovery._client)
    assert managed_provider.calls == []
    assert bundle["coverage"]["application_signals"][REGION]["requests"] == 0
    assert "managed_discovery_deadline" in bundle["incomplete"]
    assert "application_signals_no_observations" not in bundle["gaps"]


def test_empty_paginator_does_not_count_an_unissued_request(managed_provider):
    bundle = discovery.collect(database(), ACCOUNT, Budget())
    assert bundle["coverage"]["application_signals"][REGION]["requests"] == 0


def test_failed_page_attempt_is_counted_without_error_payload(managed_provider, monkeypatch):
    monkeypatch.setenv("DIAGNOSIS_MANAGED_DISCOVERY_ENABLED", "false")
    bundle = discovery.collect(database(), ACCOUNT, Budget())
    class Pager:
        def paginate(self, **params):
            raise RuntimeError("provider-secret")
            yield  # paginator remains lazy; failure is at the request boundary.
    managed_provider.get_paginator = lambda operation: Pager()
    managed._signals(bundle, Budget(), REGION, discovery._client)
    assert bundle["coverage"]["application_signals"][REGION]["requests"] == 1
    assert "application_signals_read_failed" in bundle["degraded"]
    assert "provider-secret" not in json.dumps(bundle)


def test_managed_share_preserves_native_proxy_and_trace_reserve(managed_provider):
    conn = Database([inventory("ec2", f"i-{i:017x}", {}) for i in range(160)])
    bundle = discovery.collect(conn, ACCOUNT, Budget())
    assert len([r for r in bundle["resources"] if r["kind"] != "service"]) == 120
    for i in range(20):
        assert discovery._resource(bundle, ACCOUNT, REGION, "service", f"managed:{i}", {})
    assert discovery._resource(bundle, ACCOUNT, REGION, "service", "managed:overflow", {}) is None
    for i in range(20):
        assert discovery._resource(bundle, ACCOUNT, REGION, "rds_proxy", f"proxy-{i}", {})
    for i in range(40):
        assert discovery._resource(bundle, ACCOUNT, REGION, "service", f"xray:{i}", {})
    assert len(bundle["resources"]) == discovery.MAX_RESOURCES


def test_disabled_managed_gate_preserves_original_inventory_share(managed_provider, monkeypatch):
    monkeypatch.delenv("DIAGNOSIS_MANAGED_DISCOVERY_ENABLED")
    conn = Database([inventory("ec2", f"i-{i:017x}", {}) for i in range(160)])
    bundle = discovery.collect(conn, ACCOUNT, Budget())
    assert len([r for r in bundle["resources"] if r["kind"] != "service"]) == 140


def test_byte_cap_evicts_managed_evidence_before_native_trace(managed_provider, monkeypatch):
    bundle = discovery.collect(database(), ACCOUNT, Budget())
    resources = [r["id"] for r in bundle["resources"]][:2]
    for source in ("xray", "application_signals", "cloudwatch_omni"):
        discovery._evidence(bundle, source, "observed_call", resources,
                            {"padding": "x" * 1000}, NOW, region=REGION,
                            fresh=True, coverage={"complete": True})
    size = len(json.dumps(bundle, ensure_ascii=False, default=str).encode())
    monkeypatch.setattr(discovery, "MAX_BYTES", size - 2000 + 512)
    discovery._finish(bundle)
    assert any(e["source"] == "xray" for e in bundle["evidence"])
    assert not any(e["source"] in {"application_signals", "cloudwatch_omni"} for e in bundle["evidence"])


@pytest.mark.parametrize("change", ["foreign_metric", "foreign_arn", "wrong_region", "missing_window"])
def test_signals_never_confirms_ambiguous_or_unscoped_native_pairs(managed_provider, change):
    service, dep = summary(), dependency()
    if change == "foreign_metric":
        service["MetricReferences"][0]["AccountId"] = "999900001111"
    elif change == "foreign_arn":
        dep["DependencyKeyAttributes"]["Identifier"] = DB_ARN.replace(ACCOUNT, "999900001111")
    elif change == "wrong_region":
        dep["DependencyKeyAttributes"]["Identifier"] = DB_ARN.replace(REGION, "us-east-1")
    signals_pages(managed_provider, service=service, dep=dep)
    if change == "missing_window":
        del managed_provider.pages["list_services"][0]["EndTime"]
    bundle = discovery.collect(database(), ACCOUNT, Budget())
    assert not any(e["fresh"] and e["coverage"]["complete"] and
                   e["facts"].get("resource_binding") == "exact" for e in calls(bundle))


@pytest.mark.parametrize("attrs", [[], [{"service.name": I1}],
                                   [{"aws.ec2.instance.id": I1}, {"cloud.resource_id": DB_ARN}]])
def test_signals_missing_or_conflicting_host_identity_does_not_create_compute_binding(managed_provider, attrs):
    signals_pages(managed_provider, service=summary(AttributeMaps=attrs))
    bundle = discovery.collect(database(), ACCOUNT, Budget())
    assert not any(e["kind"] == "configured_dependency" and e["source"] == "application_signals"
                   for e in bundle["evidence"])


@pytest.mark.parametrize("flag", ["false", "", "TRUE"])
def test_disabled_gate_makes_no_managed_provider_calls(managed_provider, monkeypatch, flag):
    monkeypatch.setenv("DIAGNOSIS_MANAGED_DISCOVERY_ENABLED", flag)
    discovery.collect(database(), ACCOUNT, Budget())
    assert not any(op.startswith("list_service") for op, _ in managed_provider.calls)


@pytest.mark.parametrize("mode", ["cap", "repeat", "late_failure"])
def test_signals_late_pagination_problem_disqualifies_earlier_rows(managed_provider, mode):
    signals_pages(managed_provider)
    page = managed_provider.pages["list_service_dependencies"][0]
    page["NextToken"] = "first"
    if mode == "repeat":
        managed_provider.pages["list_service_dependencies"] = [page, copy.deepcopy(page)]
    elif mode == "late_failure":
        managed_provider.pages["list_service_dependencies"] = [page, "malformed"]
    else:
        managed_provider.pages["list_service_dependencies"] = [
            {**page, "NextToken": str(i)} for i in range(discovery.MAX_PAGES + 1)]
    bundle = discovery.collect(database(), ACCOUNT, Budget())
    assert calls(bundle) and all(not e["fresh"] and not e["coverage"]["complete"] for e in calls(bundle))


def test_signals_request_budget_is_shared_between_services_and_dependencies(managed_provider):
    signals_pages(managed_provider)
    managed_provider.pages["list_services"][0]["ServiceSummaries"] = [
        summary(KeyAttributes={**SERVICE, "Name": f"service-{i}"}) for i in range(30)]
    bundle = discovery.collect(database(), ACCOUNT, Budget())
    assert bundle["coverage"]["application_signals"][REGION]["requests"] == managed.MAX_CALLS
    assert "managed_discovery_request_cap" in bundle["incomplete"]
    assert all(not e["fresh"] for e in calls(bundle))


def node(identity, *, edges=None, **updates):
    return {"nodeId": identity, "nodeType": "RESOURCE", "name": "provider display",
            "nodeProperties": {"sourceAccountId": ACCOUNT, "region": REGION, "cloudProvider": "aws"},
            "edges": edges or [], **updates}


def edge(**updates):
    return {"edgeId": "compute-to-db", "from": INSTANCE_ARN, "to": DB_ARN, "edgeType": "CALLS",
            "sources": ["TELEMETRY"], "signalTypes": ["TRACES"],
            "firstObservedAt": NOW - dt.timedelta(hours=1),
            "lastObservedAt": NOW - dt.timedelta(minutes=1), **updates}


@pytest.fixture
def omni_provider(managed_provider, monkeypatch):
    monkeypatch.setenv("DIAGNOSIS_OMNI_SPACES", json.dumps({f"{ACCOUNT}/{REGION}": SPACE}))
    managed_provider.pages["get_context_graph"] = [
        {"nodes": [node(INSTANCE_ARN, edges=[edge()]), node(DB_ARN)]}]

    def credential_read(**params):
        managed_provider.calls.append(("get_space_credentials_for_organization", params))
        return {"credentials": {"accessKeyId": "fixture-key", "secretAccessKey": "fixture-secret",
                                "sessionToken": "fixture-token", "expiration": NOW + dt.timedelta(hours=1)}}
    managed_provider.get_space_credentials_for_organization = credential_read

    class Session:
        def __init__(self, **params):
            self.credentials = params

        def client(self, service, **params):
            if service == "sts":
                class Identity:
                    def get_caller_identity(self):
                        return {"Account": ACCOUNT}
                return Identity()
            assert service == "cloudwatchomni"
            return managed_provider
    monkeypatch.setattr(managed.boto3, "Session", Session)
    return managed_provider


def private_omni_bundle():
    """Exercise the inactive adapter directly, separately from production wiring."""
    bundle = discovery.collect(database(), ACCOUNT, Budget())
    managed._omni(bundle, Budget(), REGION, discovery._client)
    return discovery._finish(bundle)


def test_omni_uses_space_credentials_and_matches_native_pair(omni_provider):
    bundle = private_omni_bundle()
    observed = calls(bundle, "cloudwatch_omni")
    assert len(observed) == 1 and observed[0]["fresh"]
    assert observed[0]["facts"]["resource_binding"] == "exact"
    assert observed[0]["facts"]["provenance_family"] == "application_telemetry"
    assert EvidenceIndex(bundle, ACCOUNT).relationships
    request = next(p for op, p in omni_provider.calls if op == "get_context_graph")
    assert request["nodeFilters"] == {"sourceAccountId": [ACCOUNT], "region": [REGION]}
    assert request["includeMetadata"] is False and request["depth"] == 0
    serialized = json.dumps(bundle)
    assert "fixture-secret" not in serialized and "fixture-token" not in serialized


@pytest.mark.parametrize("attrs", [
    {"aws.rds.db_instance.id": I1},
    {"cloud.resource_id": INSTANCE_ARN, "aws.rds.db_instance.id": I1},
])
def test_omni_typed_identity_conflict_cannot_confirm_native_call(omni_provider, attrs):
    omni_provider.pages["get_context_graph"][0]["nodes"][0]["telemetryAttributes"] = attrs
    bundle = private_omni_bundle()
    assert calls(bundle, "cloudwatch_omni")
    assert all(e["facts"]["resource_binding"] == "unresolved"
               for e in calls(bundle, "cloudwatch_omni"))


def test_omni_self_edge_is_disclosed_without_duplicate_resource_evidence(omni_provider):
    source = omni_provider.pages["get_context_graph"][0]["nodes"][0]
    source["edges"][0]["to"] = INSTANCE_ARN
    bundle = private_omni_bundle()
    assert not calls(bundle, "cloudwatch_omni")
    assert "omni_self_edge_unconfirmed" in bundle["gaps"]
    assert bundle["coverage"]["cloudwatch_omni"][REGION]["complete"] is True


@pytest.mark.parametrize("mode", ["configuration", "iam_policy", "stale", "missing_time", "metrics_only"])
def test_omni_configuration_or_stale_signals_never_become_fresh_calls(omni_provider, mode):
    graph_edge = omni_provider.pages["get_context_graph"][0]["nodes"][0]["edges"][0]
    if mode == "configuration":
        graph_edge.update(edgeType="RUNS_ON", sources=["CONFIG"], signalTypes=["CONFIG"])
    elif mode == "iam_policy":
        graph_edge.update(sources=["IAM_POLICY"], signalTypes=[])
    elif mode == "stale":
        graph_edge.update(firstObservedAt=NOW - dt.timedelta(hours=5), lastObservedAt=NOW - dt.timedelta(hours=4))
    elif mode == "missing_time":
        del graph_edge["lastObservedAt"]
    else:
        graph_edge["signalTypes"] = ["METRICS"]
    bundle = private_omni_bundle()
    assert not any(e["fresh"] for e in calls(bundle, "cloudwatch_omni"))
    if mode not in ("stale", "missing_time"):
        configured = [e for e in bundle["evidence"] if e["source"] == "cloudwatch_omni"
                      and e["kind"] == "configured_dependency"]
        assert configured and not calls(bundle, "cloudwatch_omni")
    if mode in ("stale", "missing_time"):
        assert calls(bundle, "cloudwatch_omni")
        assert not any(e["source"] == "cloudwatch_omni" and e["kind"] == "configured_dependency"
                       for e in bundle["evidence"])


def test_omni_service_attribute_does_not_promote_aggregate_to_instance_call(omni_provider):
    source = omni_provider.pages["get_context_graph"][0]["nodes"][0]
    source.update(nodeType="SERVICE", nodeId="service:checkout",
                  telemetryAttributes={"aws.ec2.instance.id": I1})
    source["edges"][0]["from"] = "service:checkout"
    bundle = private_omni_bundle()
    observed = calls(bundle, "cloudwatch_omni")
    assert observed and observed[0]["facts"]["resource_binding"] == "unresolved"


def test_omni_resolves_edges_to_nodes_on_later_pages(omni_provider):
    nodes = omni_provider.pages["get_context_graph"][0]["nodes"]
    omni_provider.pages["get_context_graph"] = [
        {"nodes": [nodes[0]], "nextToken": "later"}, {"nodes": [nodes[1]]}]
    bundle = private_omni_bundle()
    assert calls(bundle, "cloudwatch_omni")[0]["facts"]["resource_binding"] == "exact"


@pytest.mark.parametrize("extra", [
    edge(to="external:uncollected"),
    edge(to=INSTANCE_ARN),
    edge(sources=["unsupported"]),
    edge(edgeType="UNKNOWN"),
    {"from": "wrong-source"},
])
def test_private_omni_partial_row_keeps_valid_scoped_edge(omni_provider, extra):
    omni_provider.pages["get_context_graph"][0]["nodes"][0]["edges"].append(extra)
    bundle = private_omni_bundle()
    observed = calls(bundle, "cloudwatch_omni")
    assert len(observed) == 1 and observed[0]["fresh"] and observed[0]["coverage"]["complete"]
    assert observed[0]["facts"]["resource_binding"] == "exact"
    assert any(g.startswith("omni_") for g in bundle["gaps"])
    assert EvidenceIndex(bundle, ACCOUNT).relationships


@pytest.mark.parametrize("mode", ["foreign_account", "foreign_region", "duplicate", "target_missing",
                                 "fanout", "page_cap", "row_cap"])
def test_private_omni_cap_disqualifies_batch_but_unscoped_rows_are_skipped(omni_provider, mode):
    nodes = omni_provider.pages["get_context_graph"][0]["nodes"]
    if mode == "foreign_account":
        nodes[1]["nodeProperties"]["sourceAccountId"] = "999900001111"
    elif mode == "foreign_region":
        nodes[1]["nodeProperties"]["region"] = "us-east-1"
    elif mode == "duplicate":
        nodes.append(node(DB_ARN, name="conflicting version"))
    elif mode == "target_missing":
        nodes.pop()
    elif mode == "fanout":
        nodes[0]["edges"] = [edge(edgeId=str(i)) for i in range(managed.MAX_EDGES_PER_NODE)]
    elif mode == "page_cap":
        omni_provider.pages["get_context_graph"] = [
            {"nodes": copy.deepcopy(nodes), "nextToken": str(i)} for i in range(discovery.MAX_PAGES + 1)]
    else:
        nodes.extend(node(f"service-{i}") for i in range(managed.MAX_NODES))
    bundle = private_omni_bundle()
    assert bundle["coverage"]["cloudwatch_omni"][REGION]["complete"] is (mode not in {"fanout", "page_cap", "row_cap"})
    assert not any(e["fresh"] for e in calls(bundle, "cloudwatch_omni"))


@pytest.mark.parametrize("config", ["{}", "invalid json", "[]", '{"wrong":"bad"}'])
def test_missing_or_bad_space_configuration_never_uses_host_graph(omni_provider, monkeypatch, config):
    monkeypatch.setenv("DIAGNOSIS_OMNI_SPACES", config)
    bundle = private_omni_bundle()
    assert not any(op in ("get_context_graph", "get_space_credentials_for_organization")
                   for op, _ in omni_provider.calls)
    assert not calls(bundle, "cloudwatch_omni")


def test_space_identity_failure_never_falls_back_or_leaks_credentials(omni_provider, monkeypatch):
    class Session:
        def __init__(self, **params):
            pass

        def client(self, service, **params):
            assert service == "sts"
            class Identity:
                def get_caller_identity(self):
                    return {"Account": "999900001111"}
            return Identity()
    monkeypatch.setattr(managed.boto3, "Session", Session)
    bundle = private_omni_bundle()
    assert "omni_read_failed" in bundle["degraded"]
    assert not any(op == "get_context_graph" for op, _ in omni_provider.calls)
    assert "fixture-secret" not in json.dumps(bundle)


def test_deadline_prevents_managed_calls(managed_provider):
    discovery.collect(database(), ACCOUNT, Budget(seconds=1))
    assert not any(op.startswith("list_service") for op, _ in managed_provider.calls)


def test_unregistered_member_never_uses_host_managed_session(managed_provider, monkeypatch):
    monkeypatch.setenv("DIAGNOSIS_HOST_ACCOUNT_ID", "999900001111")
    conn = database()
    for row in conn.rows:
        row[0] = ACCOUNT
    bundle = discovery.collect(conn, ACCOUNT, Budget(), scope=ACCOUNT)
    assert "member_live_sources_unsupported" in bundle["gaps"]
    assert not any(op in ("list_services", "get_context_graph", "get_space_credentials_for_organization")
                   for op, _ in managed_provider.calls)


def test_dns_endpoint_alias_connects_remote_service_to_db_as_configuration(managed_provider):
    signals_pages(managed_provider, dep=dependency(DependencyKeyAttributes={
        "Type": "RemoteService", "Name": "orders.example.test", "Environment": "remote"}))
    bundle = discovery.collect(database(), ACCOUNT, Budget())
    aliases = [e for e in bundle["evidence"] if e["facts"].get("relation") == "endpoint_alias"]
    assert len(aliases) == 1
    assert aliases[0]["kind"] == "configured_dependency"
    assert aliases[0]["facts"]["binding"] == "dns_endpoint_configuration"
    assert calls(bundle)[0]["facts"]["resource_binding"] == "unresolved"


def test_prompt_disallows_double_counting_managed_telemetry():
    from diagnosis.pillar_agents import _TRUSTED_RULES
    assert "Application Signals" in _TRUSTED_RULES and "Omni" in _TRUSTED_RULES
    assert "independent" in _TRUSTED_RULES and "provenance_family" in _TRUSTED_RULES


@pytest.mark.parametrize("cap", ["evidence", "relationships"])
def test_shared_bundle_cap_disqualifies_earlier_managed_rows(managed_provider, monkeypatch, cap):
    monkeypatch.setenv("DIAGNOSIS_MANAGED_DISCOVERY_ENABLED", "false")
    bundle = discovery.collect(database(), ACCOUNT, Budget())
    signals_pages(managed_provider)
    if cap == "evidence":
        monkeypatch.setattr(discovery, "MAX_EVIDENCE", len(bundle["evidence"]) + 1)
    else:
        monkeypatch.setattr(discovery, "MAX_RELATIONSHIPS", len(bundle["relationships"]) + 1)
    managed._signals(bundle, Budget(), REGION, discovery._client)
    emitted = [e for e in bundle["evidence"] if e["source"] == "application_signals"]
    assert emitted and all(not e["fresh"] and not e["coverage"]["complete"] for e in emitted)
    assert bundle["coverage"]["application_signals"][REGION]["complete"] is False


@pytest.mark.parametrize("mode", ["expired", "missing_token", "read_failure"])
def test_unusable_space_credentials_never_create_a_graph_session(omni_provider, monkeypatch, mode):
    def invalid_credentials(**kwargs):
        if mode == "read_failure":
            raise ValueError("fixture-secret-provider-error")
        credentials = {"accessKeyId": "fixture-key", "secretAccessKey": "fixture-secret",
                       "sessionToken": "fixture-token", "expiration": NOW + dt.timedelta(hours=1)}
        if mode == "expired":
            credentials["expiration"] = NOW - dt.timedelta(seconds=1)
        else:
            del credentials["sessionToken"]
        return {"credentials": credentials}

    omni_provider.get_space_credentials_for_organization = invalid_credentials
    monkeypatch.setattr(managed.boto3, "Session",
                        lambda **kwargs: pytest.fail("unverified credentials reached the graph session"))
    bundle = private_omni_bundle()
    assert "omni_read_failed" in bundle["degraded"]
    assert not calls(bundle, "cloudwatch_omni")
    assert "fixture-secret" not in json.dumps(bundle)


def test_signals_requests_use_the_locked_sdk_contract(managed_provider, monkeypatch):
    import boto3
    from botocore.stub import Stubber

    monkeypatch.setenv("DIAGNOSIS_MANAGED_DISCOVERY_ENABLED", "false")
    bundle = discovery.collect(database(), ACCOUNT, Budget())
    client = boto3.client("application-signals", region_name=REGION,
                          aws_access_key_id="fixture-key", aws_secret_access_key="fixture-secret")
    start = NOW - dt.timedelta(hours=3)
    with Stubber(client) as stub:
        stub.add_response("list_services", {"StartTime": start, "EndTime": NOW,
                                            "ServiceSummaries": [summary()]},
                          {"StartTime": start, "EndTime": NOW, "MaxResults": 40,
                           "IncludeLinkedAccounts": False, "AwsAccountId": ACCOUNT})
        stub.add_response("list_service_dependencies",
                          {"StartTime": start, "EndTime": NOW, "ServiceDependencies": [dependency()]},
                          {"StartTime": start, "EndTime": NOW, "MaxResults": 40, "KeyAttributes": SERVICE})
        managed._signals(bundle, Budget(), REGION, lambda *args: client)
        stub.assert_no_pending_responses()
    assert calls(bundle)[0]["fresh"] and calls(bundle)[0]["facts"]["resource_binding"] == "exact"


def test_signals_optional_metric_account_uses_the_verified_selected_account(managed_provider):
    service, dep = summary(), dependency()
    del service["MetricReferences"][0]["AccountId"]
    del dep["MetricReferences"][0]["AccountId"]
    signals_pages(managed_provider, service=service, dep=dep)
    bundle = discovery.collect(database(), ACCOUNT, Budget())
    assert len(calls(bundle)) == 1 and calls(bundle)[0]["fresh"]
    assert calls(bundle)[0]["account"] == ACCOUNT


def test_evidence_admission_confirms_service_call_but_rejects_instance_fanout(managed_provider):
    from diagnosis.test_evidence import finding

    signals_pages(managed_provider)
    bundle = discovery.collect(database(), ACCOUNT, Budget())
    index = EvidenceIndex(bundle, ACCOUNT)
    observed = calls(bundle)[0]
    hosting = next(e for e in bundle["evidence"] if e["source"] == "application_signals"
                   and e["kind"] == "configured_dependency")
    assert index.validate_finding(finding(id="service-call", resource_ids=observed["resource_ids"],
                                         evidence_ids=[observed["id"]]))["claim"] == "observation"
    native_ids = [r["id"] for r in bundle["resources"] if r["kind"] in {"ec2", "rds"}]
    assert index.validate_finding(finding(id="instance-fanout", resource_ids=native_ids,
                                         evidence_ids=[observed["id"], hosting["id"]]))["claim"] == "hypothesis"


def test_member_signals_uses_verified_member_factory_without_host_data_reads(managed_provider, monkeypatch):
    from diagnosis import scoped_clients

    monkeypatch.setenv("DIAGNOSIS_HOST_ACCOUNT_ID", "999900001111")
    conn = database()
    for row in conn.rows:
        row[0] = ACCOUNT
    signals_pages(managed_provider)

    def verified_factory(connection, account, budget):
        assert connection is conn and account == ACCOUNT
        return lambda service, region, budget: managed_provider

    monkeypatch.setattr(scoped_clients, "member_factory", verified_factory)
    monkeypatch.setattr(discovery, "_client",
                        lambda *args: pytest.fail("host data credentials were used for a member report"))
    bundle = discovery.collect(conn, ACCOUNT, Budget(), scope=ACCOUNT)
    assert calls(bundle)[0]["fresh"] and calls(bundle)[0]["account"] == ACCOUNT


def test_omni_requests_use_the_locked_sdk_contract(managed_provider, monkeypatch):
    import boto3
    from botocore.stub import Stubber

    monkeypatch.setenv("DIAGNOSIS_MANAGED_DISCOVERY_ENABLED", "false")
    monkeypatch.setenv("DIAGNOSIS_OMNI_SPACES", json.dumps({f"{ACCOUNT}/{REGION}": SPACE}))
    bundle = discovery.collect(database(), ACCOUNT, Budget())
    session = boto3.Session(aws_access_key_id="fixture-key", aws_secret_access_key="fixture-secret")
    control = session.client("cloudwatchomni", region_name=REGION)
    graph = session.client("cloudwatchomni", region_name=REGION)
    identity = session.client("sts", region_name=REGION)

    class SpaceSession:
        def __init__(self, **kwargs):
            assert kwargs == {"aws_access_key_id": "fixture-key", "aws_secret_access_key": "fixture-secret",
                              "aws_session_token": "fixture-token"}

        def client(self, service, **kwargs):
            return identity if service == "sts" else graph

    monkeypatch.setattr(managed.boto3, "Session", SpaceSession)
    with Stubber(control) as cs, Stubber(graph) as gs, Stubber(identity) as sts:
        cs.add_response("get_space_credentials_for_organization",
                        {"credentials": {"accessKeyId": "fixture-key", "secretAccessKey": "fixture-secret",
                                         "sessionToken": "fixture-token",
                                         "expiration": NOW + dt.timedelta(hours=1)}},
                        {"context": {"spaceId": SPACE}, "credentialType": "SPACE_OPERATION"})
        sts.add_response("get_caller_identity", {"Account": ACCOUNT}, {})
        gs.add_response("get_context_graph", {"nodes": [node(INSTANCE_ARN, edges=[edge()]), node(DB_ARN)]},
                        {"startTime": NOW - dt.timedelta(hours=3), "endTime": NOW, "depth": 0,
                         "includeMetadata": False, "maxResults": 40, "maxEdgesPerNode": 50,
                         "nodeFilters": {"sourceAccountId": [ACCOUNT], "region": [REGION]}})
        managed._omni(bundle, Budget(), REGION, lambda *args: control)
        for stub in (cs, gs, sts):
            stub.assert_no_pending_responses()
    assert calls(bundle, "cloudwatch_omni")[0]["fresh"]
