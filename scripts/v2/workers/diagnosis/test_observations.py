"""DNS resolution and aggregate traffic retain scope, source clocks and uncertainty."""
import copy
import datetime as dt
import json

import pytest

from diagnosis import discovery, observations
from diagnosis.evidence import EvidenceIndex
from diagnosis.test_evidence import oid
from diagnosis.test_discovery import ACCOUNT, REGION, NOW, I1, Budget

START = NOW - dt.timedelta(minutes=5)
VPC = "vpc-0123456789abcdef0"
GROUP = f"arn:aws:logs:{REGION}:{ACCOUNT}:log-group:/resolver/test"


def bundle():
    resources = [
        {"id": oid("r-instance"), "account": ACCOUNT, "region": REGION, "kind": "ec2", "resource_id": I1,
         "facts": {"private_ip_address": "10.0.1.5", "vpc_id": VPC}},
        {"id": oid("r-db"), "account": ACCOUNT, "region": REGION, "kind": "rds", "resource_id": "orders",
         "facts": {"endpoint_address": "orders.example.test", "endpoint_port": 5432, "vpc_id": VPC}}]
    evidence = [{"id": oid("e-inventory-" + r["id"]), "source": "inventory", "kind": "inventory",
        "account": ACCOUNT, "region": REGION, "resource_ids": [r["id"]], "facts": r["facts"],
        "captured_at": (NOW - dt.timedelta(minutes=1)).isoformat(), "fresh": True,
        "coverage": {"complete": True}} for r in resources]
    return {"resources": resources, "evidence": evidence, "relationships": [],
        "coverage": {"account": ACCOUNT, "storage_scope": "self", "regions": {"selected": [REGION]}},
        "gaps": [], "degraded": [], "incomplete": []}


def dns(**changes):
    row = {"account_id": ACCOUNT, "region": REGION, "vpc_id": VPC,
        "query_timestamp": (NOW - dt.timedelta(seconds=20)).isoformat(),
        "query_name": "orders.example.test.", "rcode": "NOERROR", "srcaddr": "10.0.1.5",
        "instance": I1, "answers": [{"Rdata": "10.0.2.7", "Type": "A", "Class": "IN"}],
        "srcport": 60000, "raw_sql": "secret"}
    return {**row, **changes}


def flow(**changes):
    return {"localIp": "10.0.1.5", "localInstanceId": I1, "localVpcId": VPC,
        "localRegion": REGION, "remoteIp": "10.0.2.7", "remoteVpcId": VPC,
        "remoteRegion": REGION, "targetPort": 5432, "value": 321, **changes}


def test_dns_projection_preserves_later_region_rows(monkeypatch):
    monkeypatch.setattr(discovery, "_now", lambda: NOW)
    data, later = bundle(), bundle()
    other_region = "eu-west-1"
    data["coverage"]["regions"]["selected"].append(other_region)
    ids = {r["id"]: oid("later-" + r["id"]) for r in later["resources"]}
    for resource in later["resources"]:
        resource.update(id=ids[resource["id"]], region=other_region)
    for evidence in later["evidence"]:
        evidence.update(id=oid("later-" + evidence["id"]), region=other_region,
                        resource_ids=[ids[r] for r in evidence["resource_ids"]])
    data["resources"].extend(later["resources"])
    data["evidence"].extend(later["evidence"])
    rows = [dns()] * (observations.MAX_ROWS * observations.MAX_GROUPS)
    observations.project(data, rows + [dns(region=other_region)], [],
                         start=START, end=NOW, source_id="resolver")
    admitted = [e for e in data["evidence"] if e["kind"] == "observed_dns_resolution"]
    assert {e["region"] for e in admitted} == {REGION, other_region}


def test_dns_projection_discloses_excess_over_all_region_bound(monkeypatch):
    monkeypatch.setattr(discovery, "_now", lambda: NOW)
    data = bundle()
    cap = observations.MAX_ROWS * observations.MAX_GROUPS * observations.MAX_REGIONS
    observations.project(data, [dns()] * (cap + 1), [], start=START, end=NOW, source_id="resolver")
    assert "dns_projection_cap" in data["incomplete"]


@pytest.fixture(autouse=True)
def scope(monkeypatch):
    monkeypatch.setenv("DIAGNOSIS_EVIDENCE_LOOP_ENABLED", "true")
    monkeypatch.setenv("DIAGNOSIS_NETWORK_EVIDENCE_ENABLED", "true")
    monkeypatch.setenv("DIAGNOSIS_HOST_ACCOUNT_ID", ACCOUNT)
    monkeypatch.setenv("DIAGNOSIS_DNS_LOG_GROUP_ARNS", json.dumps([GROUP]))
    monkeypatch.setattr(discovery, "_now", lambda: NOW)
    monkeypatch.setattr(observations, "_sleep", lambda _: None)


def test_out_of_region_dns_group_is_skipped_but_malformed_or_foreign_invalidates(monkeypatch):
    other = GROUP.replace(REGION, "eu-west-1")
    monkeypatch.setenv("DIAGNOSIS_DNS_LOG_GROUP_ARNS", json.dumps([GROUP, other]))
    assert observations._groups(ACCOUNT, [REGION]) == ({REGION: {GROUP: "/resolver/test"}}, False)
    for bad in (GROUP.replace(ACCOUNT, "999900001111"), "arn:aws:logs:bad"):
        monkeypatch.setenv("DIAGNOSIS_DNS_LOG_GROUP_ARNS", json.dumps([GROUP, bad]))
        assert observations._groups(ACCOUNT, [REGION]) == ({}, True)


def project(data=None, rows=None, flows=None):
    data = copy.deepcopy(data if data is not None else bundle())
    observations.project(data, rows if rows is not None else [dns()],
        flows if flows is not None else [flow()], start=START, end=NOW, source_id="monitor:test")
    return data


def test_dns_plus_flow_preserves_original_windows_and_never_becomes_sql_call():
    data = project()
    kinds = {e["kind"] for e in data["evidence"]}
    assert {"observed_dns_resolution", "observed_network_flow"} <= kinds
    assert "observed_call" not in kinds
    edge = next(e for e in data["evidence"] if e["kind"] == "observed_network_flow")
    assert edge["facts"]["direction"] == "undirected"
    assert edge["facts"]["ttl_known"] is False
    assert edge["facts"]["binding"] == "dns_window_correlation"
    assert edge["window"] == {"start": START.isoformat(), "end": NOW.isoformat()}
    assert edge["coverage"]["complete"] is False and edge["coverage"]["sampled"] is True
    assert "srcport" not in json.dumps(edge) and "raw_sql" not in json.dumps(edge)


@pytest.mark.parametrize("change", [
    {"account_id": "999900001111"}, {"region": "us-east-1"}, {"vpc_id": "vpc-foreign"},
    {"query_timestamp": (START - dt.timedelta(seconds=1)).isoformat()},
    {"query_timestamp": (NOW + dt.timedelta(seconds=1)).isoformat()},
    {"query_timestamp": "malformed"}, {"srcaddr": "10.0.1.6"}, {"instance": "i-foreign"},
    {"rcode": "NXDOMAIN"}, {"answers": []}, {"answers": [{"Rdata": "invalid", "Type": "A", "Class": "IN"}]},
    {"answers": [{"Rdata": "10.0.2.7", "Type": "A", "Class": "CH"}]},
])
def test_bad_dns_cannot_establish_resource_dependencies(change):
    data = project(rows=[dns(**change)])
    assert not data["relationships"]
    assert data["gaps"]


@pytest.mark.parametrize("change", [
    {"localVpcId": "vpc-foreign"}, {"remoteVpcId": "vpc-foreign"},
    {"localRegion": "us-east-1"}, {"remoteRegion": "us-east-1"},
    {"localInstanceId": "i-foreign"}, {"snatIp": "10.0.9.8"}, {"dnatIp": "10.0.9.8"},
    {"targetPort": 3306}, {"value": 0}, {"value": float("nan")},
    {"localInstanceArn": "arn:aws:ec2:ap-northeast-2:999900001111:instance/i-foreign"},
])
def test_bad_flow_keeps_dns_but_does_not_bind_network_dependency(change):
    data = project(flows=[flow(**change)])
    assert any(e["kind"] == "observed_dns_resolution" for e in data["evidence"])
    assert not any(e["kind"] == "observed_network_flow" for e in data["evidence"])


def test_duplicate_endpoint_and_ip_reuse_are_not_guessed():
    data = bundle()
    duplicate = copy.deepcopy(data["resources"][1]); duplicate["id"] = oid("r-other"); duplicate["resource_id"] = "other"
    data["resources"].append(duplicate)
    item = copy.deepcopy(data["evidence"][1]); item["id"] = oid("e-other"); item["resource_ids"] = [oid("r-other")]
    data["evidence"].append(item)
    assert not project(data)["relationships"]
    duplicate["facts"]["endpoint_address"] = "other.example.test"
    data["resources"][-1] = duplicate
    data["evidence"][-1]["facts"] = copy.deepcopy(duplicate["facts"])
    reused = project(data, rows=[dns(), dns(query_name="other.example.test")])
    assert not any(e["kind"] == "observed_network_flow" for e in reused["evidence"])
    assert "dns_ip_conflict" in reused["gaps"]


def test_stale_or_unqualified_inventory_cannot_establish_identity():
    for change in ({"fresh": False}, {"coverage": {"complete": False}},
                   {"captured_at": (NOW - dt.timedelta(hours=2)).isoformat()}):
        data = bundle(); data["evidence"][0].update(change)
        assert not project(data)["relationships"]


def test_context_and_admission_keep_weak_binding_as_hypothesis():
    data = project()
    row = next(e for e in data["evidence"] if e["kind"] == "observed_network_flow")
    index = EvidenceIndex(data, ACCOUNT)
    finding = {"id": "finding-peer", "pillar": "reliability", "severity": "medium",
        "resource_ids": [oid("r-instance"), oid("r-db")], "evidence_ids": [row["id"]],
        "claim": "observation", "explanation": "The scoped peer is a dependency candidate.",
        "prerequisites": [], "verification": "graph_refresh"}
    assert index.validate_finding(finding)["claim"] == "hypothesis"
    admitted = next(e for e in index.model_context()["evidence"] if e["id"] == row["id"])
    assert admitted["facts"]["ttl_known"] is False
    assert admitted["facts"]["direction"] == "undirected"
    assert admitted["facts"]["query_name"] == "orders.example.test"


# The argname must not shadow the autouse `scope` fixture: its loop gate, allowlist
# and frozen clock must be active so only the parametrized refusal stops the calls.
@pytest.mark.parametrize("gate,report_scope,host,gap", [
    ("false", "self", ACCOUNT, None), ("true", ACCOUNT, ACCOUNT, "network_scope_unsupported"),
    ("true", "self", "999900001111", "network_scope_unsupported")])
def test_gate_or_scope_refusal_makes_no_calls(monkeypatch, gate, report_scope, host, gap):
    from diagnosis import workload_identities
    assert observations.os.environ["DIAGNOSIS_EVIDENCE_LOOP_ENABLED"] == "true"
    monkeypatch.setenv("DIAGNOSIS_NETWORK_EVIDENCE_ENABLED", gate)
    monkeypatch.setenv("DIAGNOSIS_HOST_ACCOUNT_ID", host)
    monkeypatch.setattr(workload_identities, "collect_proxies", lambda *a: pytest.fail("refusal bypass"))
    data = observations.collect(bundle(), Budget(), scope=report_scope,
        client_factory=lambda *a: pytest.fail("No SDK call permitted"))
    assert not data["relationships"]
    assert (gap in data["gaps"]) if gap else not data["gaps"]


class Provider:
    def __init__(self, *, configs=True, pending=False, next_token=False):
        self.calls = []; self.configs = configs; self.pending = pending; self.next_token = next_token

    def list_resolver_query_log_configs(self, **params):
        self.calls.append(("configs", params))
        return {"ResolverQueryLogConfigs": [{"Id": "rqlc-test", "OwnerId": ACCOUNT, "Status": "CREATED",
             "DestinationArn": GROUP}] if self.configs else []}

    def list_resolver_query_log_config_associations(self, **params):
        self.calls.append(("associations", params))
        return {"ResolverQueryLogConfigAssociations": [{"ResolverQueryLogConfigId": "rqlc-test",
            "ResourceId": VPC, "Status": "ACTIVE"}]}

    def start_query(self, **params):
        self.calls.append(("dns_start", params)); return {"queryId": "dns-test"}

    def get_query_results(self, **params):
        self.calls.append(("dns_results", params))
        if self.pending: return {"status": "Running"}
        # Logs Insights flattens the JSON answers array into indexed fields.
        row = dns()
        for i, answer in enumerate(row.pop("answers")):
            row[f"answers.{i}.Rdata"], row[f"answers.{i}.Type"] = answer["Rdata"], answer["Type"]
        return {"status": "Complete", "results": [[{"field": k, "value": v} for k,v in row.items()]
                                                  + [{"field": "@ptr", "value": "opaque"}]]}

    def stop_query(self, **params):
        self.calls.append(("dns_stop", params)); return {}

    def list_monitors(self, **params):
        self.calls.append(("monitors", params))
        return {"monitors": [{"monitorName": "test", "monitorStatus": "ACTIVE",
            "monitorArn": f"arn:aws:networkflowmonitor:{REGION}:{ACCOUNT}:monitor/test"}]}

    def start_query_monitor_top_contributors(self, **params):
        self.calls.append(("nfm_start", params)); return {"queryId": "nfm-test"}

    def get_query_status_monitor_top_contributors(self, **params):
        self.calls.append(("nfm_status", params)); return {"status": "RUNNING" if self.pending else "SUCCEEDED"}

    def get_query_results_monitor_top_contributors(self, **params):
        self.calls.append(("nfm_results", params))
        return {"topContributors": [flow()], "unit": "Bytes", "nextToken": "more" if self.next_token else None}

    def stop_query_monitor_top_contributors(self, **params):
        self.calls.append(("nfm_stop", params)); return {}


def test_collection_uses_scoped_allowlisted_sources_and_preserves_partial_coverage(monkeypatch):
    monkeypatch.setattr(observations, "_sleep", lambda _: None)
    fake = Provider(next_token=True)
    data = observations.collect(bundle(), Budget(), scope="self", client_factory=lambda *a: fake)
    assert any(e["kind"] == "observed_network_flow" for e in data["evidence"])
    assert len([c for c,_ in fake.calls if c == "nfm_start"]) <= 6
    query = next(p for c,p in fake.calls if c == "dns_start")
    assert query["logGroupName"] == "/resolver/test" and "@message" not in query["queryString"]
    assert "srcport" not in query["queryString"]
    assert "nfm_top_contributors_partial" in data["incomplete"]


def test_unapproved_or_unassociated_logs_are_never_queried(monkeypatch):
    monkeypatch.setenv("DIAGNOSIS_DNS_LOG_GROUP_ARNS", "[]")
    fake = Provider()
    observations.collect(bundle(), Budget(), scope="self", client_factory=lambda *a: fake)
    assert not any(c == "dns_start" for c,_ in fake.calls)


def test_absent_instrumentation_is_an_explicit_gap(monkeypatch):
    fake = Provider(configs=False)
    data = observations.collect(bundle(), Budget(), scope="self", client_factory=lambda *a: fake)
    assert "dns_logs_unavailable" in data["gaps"]
    assert not data["relationships"]


def test_deadline_starts_no_new_query():
    data = observations.collect(bundle(), Budget(1), scope="self",
        client_factory=lambda *a: pytest.fail("No SDK call after deadline"))
    assert "network_evidence_deadline" in data["incomplete"]


def test_pending_queries_are_stopped_at_poll_cap(monkeypatch):
    sleeps = []
    monkeypatch.setattr(observations, "_sleep", sleeps.append)
    fake = Provider(pending=True)
    data = observations.collect(bundle(), Budget(), scope="self", client_factory=lambda *a: fake)
    # Logs Insights / NFM need seconds: one query waits ~7.75s, never one long sleep.
    assert sum(sleeps[:observations.MAX_POLLS - 1]) >= 5 and max(sleeps) <= 1.5
    assert any(c == "dns_stop" for c,_ in fake.calls)
    assert any(c == "nfm_stop" for c,_ in fake.calls)
    assert not data["relationships"] and data["incomplete"]


def test_emitted_requests_validate_against_offline_botocore_schemas(monkeypatch):
    from botocore import xform_name
    from botocore.session import Session
    from botocore.validate import validate_parameters
    session, fake = Session(), Provider()
    errors = []
    monkeypatch.setattr(observations, "_sleep", lambda _: None)

    class Client:
        def __init__(self, service):
            self.model = session.get_service_model(service)

        def __getattr__(self, name):
            implementation = getattr(fake, name)
            operation = next(op for op in self.model.operation_names
                             if xform_name(op) == name)

            def call(**params):
                try:
                    shape = self.model.operation_model(operation).input_shape
                    validate_parameters(params, shape)
                    # botocore's validator does not enforce every modeled maximum.
                    for key, value in params.items():
                        maximum = shape.members[key].metadata.get("max")
                        if maximum is not None and isinstance(value, (int, float)):
                            assert value <= maximum, (operation, key, value, maximum)
                except Exception as exc:
                    errors.append(str(exc))
                    raise
                return implementation(**params)
            return call

    data = observations.collect(bundle(), Budget(), scope="self",
        client_factory=lambda service, *a: Client(service))
    assert not errors
    assert any(e["kind"] == "observed_network_flow" for e in data["evidence"])


@pytest.mark.parametrize("change", [
    {"localInstanceArn": f"arn:aws:ec2:{REGION}:{ACCOUNT}:instance/i-other"},
    {"localVpcArn": f"arn:aws:ec2:{REGION}:{ACCOUNT}:vpc/vpc-other"},
    {"remoteVpcArn": f"arn:aws:ec2:{REGION}:{ACCOUNT}:vpc/vpc-other"},
])
def test_same_account_arn_identifier_conflicts_refuse_binding(change):
    data = project(flows=[flow(**change)])
    assert not any(e["kind"] == "observed_network_flow" for e in data["evidence"])


def test_dns_rows_are_checked_against_their_own_group_association(monkeypatch):
    data = bundle()
    for r in data["resources"]:
        r["facts"]["vpc_id"] = "vpc-fedcba9876543210"
    subnet = {"id": oid("r-subnet"), "account": ACCOUNT, "region": REGION,
              "kind": "subnet", "resource_id": "subnet-test", "facts": {"vpc_id": VPC}}
    data["resources"].append(subnet)
    data["evidence"].append({**data["evidence"][0], "id": oid("e-subnet"), "resource_ids": [subnet["id"]],
                             "facts": subnet["facts"]})

    class WrongVpc(Provider):
        def get_query_results(self, **params):
            result = super().get_query_results(**params)
            for field in result["results"][0]:
                if field["field"] == "vpc_id": field["value"] = "vpc-fedcba9876543210"
            return result

    fake = WrongVpc()
    observed = observations.collect(data, Budget(), scope="self", client_factory=lambda *a: fake)
    assert not any(e["kind"] == "observed_dns_resolution" for e in observed["evidence"])


def test_inventory_binding_requires_recorded_address_not_only_a_fresh_flag():
    data = bundle()
    data["evidence"][0]["facts"] = {"private_ip_address": "10.0.1.6", "vpc_id": VPC}
    assert not project(data)["relationships"]


def test_cached_sdk_timeout_cannot_exceed_remaining_query_budget(monkeypatch):
    from botocore.config import Config
    fake = Provider()
    fake._client_config = Config(connect_timeout=1, read_timeout=10)
    monkeypatch.setattr(observations, "_sleep", lambda _: None)
    observations.collect(bundle(), Budget(5), scope="self", client_factory=lambda *a: fake)
    assert not any(c in {"dns_start", "nfm_start"} for c,_ in fake.calls)


def test_resolution_and_window_uncertainty_survive_deterministic_presentation():
    import html
    from diagnosis import presentation
    from diagnosis.sections import SECTIONS
    data = project()
    index = EvidenceIndex(data, ACCOUNT)
    row = next(e for e in data["evidence"] if e["kind"] == "observed_network_flow")
    finding = index.validate_finding({"id": "finding-network", "pillar": "reliability",
        "severity": "medium", "resource_ids": [oid("r-instance"), oid("r-db")], "evidence_ids": [row["id"]],
        "claim": "observation", "explanation": "The peer needs trace verification.",
        "prerequisites": [], "verification": "graph_refresh"})
    text = html.unescape("\n".join(value for _, value in presentation.render(SECTIONS,
        index.admitted_bundle(), {"findings": [finding]}, lang="en")))
    assert "ttl&#95;known" in text or "ttl_known" in text
    assert "dns&#95;window&#95;correlation" in text or "dns_window_correlation" in text
    assert "undirected" in text and "orders.example.test" in text
    assert START.isoformat() in text and "Hypothesis" in text
    assert "raw_sql" not in text and "srcport" not in text


@pytest.mark.parametrize("stage", ["specialist", "review"])
def test_provider_prompts_distinguish_dns_and_aggregate_traffic_from_calls(monkeypatch, stage):
    from diagnosis import pillar_agents as agents
    from diagnosis.budget import ReportBudget
    from diagnosis.test_pillar_agents import FakeClient, response
    payload = ({"findings": []} if stage == "specialist" else
        {"finding_ids": [], "reject_ids": [], "follow_up": [], "rerun_pillars": [], "issues": []})
    fake = FakeClient([response(payload)])
    monkeypatch.setattr(agents, "_client", lambda *a: fake)
    options = {"model_id": "global.anthropic.claude-sonnet-5-5", "budget": ReportBudget("mid")}
    index = EvidenceIndex(project(), ACCOUNT)
    if stage == "specialist":
        agents.analyze("reliability", index, **options)
    else:
        agents.review([], index, **options)
    prompt = json.loads(fake.calls[0]["body"])["system"].lower()
    assert "dns" in prompt and "ttl" in prompt and "undirected" in prompt
    assert "same-span trace" in prompt and "sql" in prompt


def test_evidence_loop_gate_off_invokes_neither_sdk_nor_proxy_helper(monkeypatch):
    from diagnosis import workload_identities
    monkeypatch.setenv("DIAGNOSIS_EVIDENCE_LOOP_ENABLED", "false")
    monkeypatch.setattr(workload_identities, "collect_proxies", lambda *a: pytest.fail("gate bypass"))
    observations.collect(bundle(), Budget(), scope="self",
        client_factory=lambda *a: pytest.fail("gate bypass"))


def test_sources_share_exact_window_derived_from_one_end_clock(monkeypatch):
    from diagnosis import workload_identities
    calls = []

    def advancing():
        calls.append(True)
        return NOW + dt.timedelta(seconds=len(calls))

    monkeypatch.setattr(discovery, "_now", advancing)
    monkeypatch.setattr(workload_identities, "collect_proxies", lambda *a: None)
    fake = Provider()
    observations.collect(bundle(), Budget(), scope="self", client_factory=lambda *a: fake)
    dns_query = next(p for c,p in fake.calls if c == "dns_start")
    assert dns_query["endTime"] - dns_query["startTime"] == 300
    for kind, params in fake.calls:
        if kind == "nfm_start":
            assert (params["endTime"] - params["startTime"]).total_seconds() == 300
            assert int(params["startTime"].timestamp()) == dns_query["startTime"]


def test_nfm_global_monitor_and_query_caps_are_visible(monkeypatch):
    class ManyMonitors(Provider):
        def list_monitors(self, **params):
            self.calls.append(("monitors", params))
            return {"monitors": [{"monitorName": f"m{i}", "monitorStatus": "ACTIVE",
                "monitorArn": f"arn:aws:networkflowmonitor:{REGION}:{ACCOUNT}:monitor/m{i}"}
                for i in range(3)]}

    fake = ManyMonitors()
    monkeypatch.setattr(observations, "_sleep", lambda _: None)
    data = observations.collect(bundle(), Budget(), scope="self", client_factory=lambda *a: fake)
    assert len([c for c,_ in fake.calls if c == "nfm_start"]) == 2 * len(observations.CATEGORIES)
    assert "nfm_monitor_cap" in data["incomplete"]


def test_reversed_peer_flow_is_undirected_and_cname_is_not_call_evidence():
    data = project(rows=[dns(query_name="alias.example.test", answers=[
        {"Rdata": "orders.example.test", "Type": "CNAME", "Class": "IN"},
        {"Rdata": "10.0.2.7", "Type": "A", "Class": "IN"}])], flows=[flow(localIp="10.0.2.7",
        remoteIp="10.0.1.5", localInstanceId=None, remoteInstanceId=I1)])
    assert any(e["kind"] == "observed_network_flow" for e in data["evidence"])
    assert not any(e["kind"] == "observed_call" for e in data["evidence"])


def test_malformed_admitted_fact_shape_cannot_raise_or_confirm_a_call():
    data = project()
    row = next(e for e in data["evidence"] if e["kind"] == "observed_network_flow")
    row["facts"] = ["untrusted"]
    index = EvidenceIndex(data, ACCOUNT)
    finding = index.validate_finding({"id": "finding-shape", "pillar": "reliability",
        "severity": "medium", "resource_ids": [oid("r-instance"), oid("r-db")], "evidence_ids": [row["id"]],
        "claim": "observation", "explanation": "The peer needs verification.",
        "prerequisites": [], "verification": "graph_refresh"})
    assert finding["claim"] == "hypothesis"


def test_inventory_scope_and_source_provenance_survive_without_raw_metadata():
    data = bundle()
    data["evidence"][0]["region"] = "us-east-1"
    assert not project(data)["relationships"]
    fake = Provider()
    collected = observations.collect(bundle(), Budget(), scope="self", client_factory=lambda *a: fake)
    admitted = EvidenceIndex(collected, ACCOUNT).model_context()
    dns_row = next(e for e in admitted["evidence"] if e["kind"] == "observed_dns_resolution")
    network_row = next(e for e in admitted["evidence"] if e["kind"] == "observed_network_flow")
    assert dns_row["facts"]["source_id"].startswith("source:")
    assert network_row["facts"]["dns_source_id"] == dns_row["facts"]["source_id"]
    assert network_row["facts"]["source_id"] != dns_row["facts"]["source_id"]
    assert GROUP not in json.dumps(admitted) and "raw_sql" not in json.dumps(admitted)


def test_node_metadata_and_shared_lambda_addresses_keep_explicit_identity_gaps():
    data = bundle()
    data["resources"][0]["kind"] = "lambda_function"
    result = project(data, rows=[dns(instance=None)], flows=[flow(kubernetesMetadata={"localPodName": "p"})])
    assert not result["relationships"]
    assert "lambda_eni_identity_unresolved" in result["gaps"]
    assert "pod_identity_unresolved" in result["gaps"]


def test_resolver_answers_parse_real_shape_from_list_json_and_flattened_fields():
    real = [{"Rdata": "10.0.2.7", "Type": "A", "Class": "IN"}]
    flattened = dns(); flattened.pop("answers")
    flattened.update({"answers.0.Rdata": "10.0.2.7", "answers.0.Type": "A"})
    for row in (dns(answers=real), dns(answers=json.dumps(real)), flattened):
        assert observations._answers(row) == ({"10.0.2.7"}, set())
    # The legacy guessed keys are not the Resolver log shape.
    assert observations._answers(dns(answers=[{"answer_type": "A", "rdata": "10.0.2.7"}])) is None


def test_flattened_answers_beyond_projection_or_with_gaps_are_refused():
    overflow = dns(); overflow.pop("answers")
    for i in range(observations.MAX_ANSWERS + 1):
        overflow[f"answers.{i}.Rdata"], overflow[f"answers.{i}.Type"] = "10.0.2.7", "A"
    gap = dns(); gap.pop("answers")
    gap.update({"answers.0.Rdata": "10.0.2.7", "answers.0.Type": "A",
                "answers.2.Rdata": "10.0.2.8", "answers.2.Type": "A"})
    assert observations._answers(overflow) is None
    assert observations._answers(gap) is None
    query = observations.dns_query([VPC])
    assert "answers.0.Rdata" in query and f"answers.{observations.MAX_ANSWERS}.Type" in query


def test_dns_query_is_selective_and_validates_vpc_ids():
    query = observations.dns_query({VPC})
    assert f'vpc_id in ["{VPC}"]' in query and 'rcode = "NOERROR"' in query
    assert "ispresent(answers.0.Rdata)" in query and query.index("filter") < query.index("limit")
    for bad in ([], ['vpc-0"] or rcode = "x'], ["vpc-XYZ"]):
        with pytest.raises(ValueError):
            observations.dns_query(bad)
    fake = Provider()
    observations.collect(bundle(), Budget(), scope="self", client_factory=lambda *a: fake)
    sent = next(p for c, p in fake.calls if c == "dns_start")["queryString"]
    assert sent == observations.dns_query({VPC})


def test_inter_vpc_is_not_queried_and_unmatched_rows_are_disclosed():
    assert "INTER_VPC" not in observations.CATEGORIES
    data = project(flows=[flow(remoteVpcId="vpc-0fedcba9876543210")])
    assert not any(e["kind"] == "observed_network_flow" for e in data["evidence"])
    assert "nfm_rows_unmatched" in data["gaps"]
    assert "nfm_rows_unmatched" not in project()["gaps"]


def test_duplicate_dns_rows_dedupe_and_correlation_output_is_capped(monkeypatch):
    repeated = [dns(query_timestamp=(NOW - dt.timedelta(seconds=s)).isoformat()) for s in range(10, 60)]
    data = project(rows=repeated, flows=[flow(value=v) for v in range(1, 40)])
    dns_rows = [e for e in data["evidence"] if e["kind"] == "observed_dns_resolution"]
    assert len(dns_rows) == 1 and dns_rows[0]["facts"]["dns_timestamp"] == (NOW - dt.timedelta(seconds=10)).isoformat()
    monkeypatch.setattr(observations, "MAX_OBSERVATION_RECORDS", 5)
    capped = project(flows=[flow(value=v) for v in range(1, 40)])
    assert len([e for e in capped["evidence"] if e["kind"].startswith("observed_")]) == 5
    assert "observation_cap" in capped["incomplete"]


def test_facts_less_inventory_rows_do_not_crash_dns_binding():
    data = bundle()
    bare = {"id": oid("r-bare"), "account": ACCOUNT, "region": REGION, "kind": "ec2", "resource_id": "i-bare"}
    data["resources"].append(bare)
    data["evidence"].append({**data["evidence"][0], "id": oid("e-bare"), "resource_ids": [bare["id"]], "facts": {}})
    assert not project(data, rows=[dns(vpc_id=None)])["relationships"]


def test_stage_deadline_is_incomplete_only_and_still_stops_started_queries(monkeypatch):
    monkeypatch.setattr(observations, "_sleep", lambda _: None)
    clock = [0.0]
    monkeypatch.setattr(observations.time, "monotonic", lambda: clock[0])
    fake = Provider(pending=True)
    original = fake.get_query_results

    def slow(**params):
        clock[0] += 100  # the 35 s stage deadline passes while the DNS query is polled
        return original(**params)
    fake.get_query_results = slow
    data = observations.collect(bundle(), Budget(), scope="self", client_factory=lambda *a: fake)
    assert "network_evidence_deadline" in data["incomplete"]
    assert "dns_logs_unavailable" not in data["gaps"] and "nfm_unavailable" not in data["gaps"]
    assert any(c == "dns_stop" for c, _ in fake.calls)


def test_provider_error_is_a_gap_and_projection_defect_is_degraded(monkeypatch):
    from botocore.exceptions import ClientError
    monkeypatch.setattr(observations, "_sleep", lambda _: None)
    fake = Provider()

    def denied(**params):
        raise ClientError({"Error": {"Code": "AccessDeniedException", "Message": "no"}}, "ListMonitors")
    fake.list_monitors = denied
    data = observations.collect(bundle(), Budget(), scope="self", client_factory=lambda *a: fake)
    assert "nfm_unavailable" in data["gaps"] and "nfm_projection_failed" not in data["degraded"]

    fake = Provider()
    fake.list_monitors = lambda **params: {"monitors": [{"monitorName": "test", "monitorStatus": "ACTIVE",
        "monitorArn": f"arn:aws:networkflowmonitor:{REGION}:{ACCOUNT}:monitor/test"}]}
    fake.start_query_monitor_top_contributors = lambda **params: (_ for _ in ()).throw(KeyError("defect"))
    data = observations.collect(bundle(), Budget(), scope="self", client_factory=lambda *a: fake)
    assert "nfm_projection_failed" in data["degraded"]
