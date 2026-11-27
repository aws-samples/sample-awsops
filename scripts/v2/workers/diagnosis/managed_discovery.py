"""Bounded, read-only managed discovery. Configuration is never installed here.

Inventory/DNS identity and telemetry are different claims. Provider display names
are never EC2/DB identities; unresolved endpoints remain logical service nodes.
Omni is an inactive private adapter: production cannot vend space credentials
until a read-only, per-space IAM boundary has been independently verified.
"""
import datetime as dt
import json
import os
import re

import boto3
from botocore.config import Config

MAX_CALLS = 16
MAX_NODES = 40
MAX_NEW_RESOURCES = 20
MAX_EDGES_PER_NODE = 50
_SPACE = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}")
_IDENTITY_ATTRIBUTES = {
    "cloud.resource_id": None, "aws.ec2.instance.id": "ec2", "aws.ecs.task.arn": "ecs_task",
    "aws.rds.db_instance.arn": "rds", "aws.rds.db_instance.id": "rds",
}
_KINDS = {"AWS::EC2::Instance": "ec2", "AWS::RDS::DBInstance": "rds",
          "AWS::ECS::Task": "ecs_task", "AWS::Lambda::Function": "lambda"}
_KEYS = {"Type", "Name", "Environment", "ResourceType", "Identifier"}
_SOURCES = {"VPC_FLOW_LOG", "CLOUDTRAIL", "IAM_POLICY", "CODE_SEMANTICS", "TELEMETRY",
            "ELB_ACCESS_LOG", "CLOUDFRONT_ACCESS_LOG", "S3_ACCESS_LOG", "WAF_ACCESS_LOG",
            "AWS_INTEGRATION", "CONFIG"}
_SIGNALS = {"LOGS", "METRICS", "TRACES", "CONFIG", "UNKNOWN"}


def _d():
    from . import discovery
    return discovery


def _fail(bundle, coverage, reason, *, category="incomplete"):
    coverage["complete"] = False
    _d()._mark(bundle, category, reason)


def _time(value):
    # These APIs use seconds; discovery._stamp also accepts inventory milliseconds.
    if isinstance(value, (float, int)) and not isinstance(value, bool):
        try:
            return dt.datetime.fromtimestamp(value, dt.timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
    return _d()._stamp(value)


def _window(page, start, end):
    left, right = _time(page.get("StartTime")), _time(page.get("EndTime"))
    if left is None or right is None or not start <= left < right <= end:
        return None
    return {"start": left.isoformat(), "end": right.isoformat()}


def _pages(client, operation, arguments, bundle, budget, coverage, state, *, token="NextToken"):
    iterator = iter(client.get_paginator(operation).paginate(**arguments))
    seen = set()
    for _ in range(_d().MAX_PAGES):
        if not _d()._available(bundle, budget):
            _fail(bundle, coverage, "managed_discovery_deadline")
            return
        config = getattr(client, "_client_config", None)
        if (config is not None and
                budget.remaining(analysis=True) <= config.connect_timeout + config.read_timeout):
            _d()._mark(bundle, "incomplete", "discovery_deadline")
            _fail(bundle, coverage, "managed_discovery_deadline")
            return
        if state["calls"] >= MAX_CALLS:
            _fail(bundle, coverage, "managed_discovery_request_cap")
            return
        try:
            page = next(iterator)
        except StopIteration:
            return
        except Exception:
            state["calls"] += 1  # A failed HTTP attempt still consumed the request bound.
            raise
        state["calls"] += 1
        if not isinstance(page, dict):
            raise ValueError("managed_page_malformed")
        coverage["pages"] += 1
        yield page
        continuation = page.get(token)
        coverage["continuation"] = bool(continuation)
        if not continuation:
            return
        if not isinstance(continuation, str) or len(continuation) > 2048 or continuation in seen:
            _fail(bundle, coverage, "managed_discovery_repeated_token")
            return
        seen.add(continuation)
    if coverage.get("continuation"):
        _fail(bundle, coverage, "managed_discovery_page_cap")


def _rows(page, key, bundle, coverage, *, limit=MAX_NODES):
    rows = page.get(key, [])
    if not isinstance(rows, list):
        raise ValueError("managed_rows_malformed")
    if len(rows) > limit:
        _fail(bundle, coverage, "managed_discovery_row_cap")
    return rows[:limit]


def _keys(value):
    if not isinstance(value, dict) or not 1 <= len(value) <= 5:
        return None
    if any(k not in _KEYS or not isinstance(v, str) or not 1 <= len(v) <= 1024
           for k, v in value.items()):
        return None
    kind = value.get("Type")
    if kind in ("Service", "RemoteService", "AWS::Service"):
        return value if value.get("Name") and value.get("Environment") else None
    if kind in ("Resource", "AWS::Resource"):
        return value if value.get("Identifier") and value.get("ResourceType") else None
    return None


def _references(value, account):
    # AccountId is optional in the API. Its absence uses the verified session
    # and explicitly account-filtered service catalog; a foreign value fails.
    if not isinstance(value, list) or not 1 <= len(value) <= 10:
        return False
    return all(isinstance(row, dict) and row.get("AccountId", account) == account for row in value)


def _native(bundle, region, identities, *, kind=None):
    account = bundle["coverage"]["account"]
    qualified = {rid for e in bundle["evidence"] if e["kind"] == "inventory"
                 and e["fresh"] and e["coverage"].get("complete") for rid in e["resource_ids"]}
    matches = {}
    for identity in identities:
        if not isinstance(identity, str) or not 1 <= len(identity) <= 512:
            continue
        if identity.startswith("arn:"):
            parts = identity.split(":", 5)
            if len(parts) != 6 or parts[4] != account or (parts[3] and parts[3] != region):
                return None
        for r in bundle["resources"]:
            if (r["account"] != account or r["region"] != region or r["id"] not in qualified
                    or (kind and r["kind"] != kind)):
                continue
            facts = r["facts"]
            aliases = {r["resource_id"], facts.get("arn"), facts.get("task_arn")}
            if identity in aliases:
                matches[r["id"]] = r
    return next(iter(matches.values())) if len(matches) == 1 else None


def _logical(bundle, region, source, identity, name, coverage):
    d = _d()
    native = "managed:" + d._id(source, identity)
    if sum(str(r["resource_id"]).startswith("managed:") for r in bundle["resources"]) >= MAX_NEW_RESOURCES:
        existing = next((r for r in bundle["resources"] if r["resource_id"] == native
                         and r["region"] == region), None)
        if existing:
            return existing
        _fail(bundle, coverage, "managed_discovery_resource_cap")
        return None
    resource = d._resource(bundle, bundle["coverage"]["account"], region, "service", native,
                           {"name": d._text(name), "resource_binding": "unresolved"})
    if resource is None:
        _fail(bundle, coverage, "managed_discovery_resource_cap")
    return resource


def _typed_binding(bundle, region, identity, attributes, *, kind=None):
    """Every explicit identity must agree, including its declared resource kind."""
    candidates = [] if identity is None else [(identity, kind)]
    if not isinstance(attributes, list) or len(attributes) > 10:
        return None
    for attrs in attributes:
        if not isinstance(attrs, dict) or len(attrs) > 100:
            return None
        for name, typed_kind in _IDENTITY_ATTRIBUTES.items():
            if name in attrs:
                if kind and typed_kind and kind != typed_kind:
                    return None
                candidates.append((attrs[name], typed_kind or kind))
    if not candidates:
        return None
    bound = None
    for value, expected_kind in candidates:
        if not isinstance(value, str) or not 1 <= len(value) <= 512:
            return None
        current = _native(bundle, region, [value], kind=expected_kind)
        if current is None or (bound and current["id"] != bound["id"]):
            return None
        bound = current
    return bound


def _signals_binding(bundle, region, key, attributes=None):
    kind = _KINDS.get(key.get("ResourceType"))
    if key.get("ResourceType") and kind is None:
        return None
    return _typed_binding(bundle, region, key.get("Identifier"),
                          [] if attributes is None else attributes, kind=kind)


def _endpoint_alias(bundle, region, source, logical, hostname, captured, coverage):
    """An inventory hostname joins a logical endpoint to a DB as configuration.

    This is not a DNS answer, live connection, TTL assertion or application call.
    Resolver observations and same-span tracing remain separate evidence.
    """
    if not isinstance(hostname, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.-]{1,252}", hostname):
        return
    d = _d()
    matches = [r for r in bundle["resources"] if r["kind"] in {"rds", "rds_cluster", "rds_proxy"}
               and r["region"] == region and r["account"] == bundle["coverage"]["account"]
               and str(r["facts"].get("endpoint_address", "")).lower().rstrip(".") == hostname.lower().rstrip(".")]
    if len(matches) != 1 or not _native(bundle, region, [matches[0]["resource_id"]]):
        return
    _emit(bundle, region, source, logical, matches[0], "configured_dependency",
          {"relation": "endpoint_alias", "binding": "dns_endpoint_configuration",
           "resource_binding": "endpoint_configuration", "db_host": hostname,
           "provenance_family": "configuration"}, captured, {}, coverage)


def _emit(bundle, region, source, left, right, kind, facts, captured, window, coverage, *, fresh=True):
    if not left or not right:
        _fail(bundle, coverage, "managed_discovery_resource_cap")
        return
    d = _d()
    item = d._evidence(bundle, source, kind, [left["id"], right["id"]], facts, captured,
                       region=region, fresh=fresh, window=window, coverage=coverage.copy())
    if item is None:
        _fail(bundle, coverage, "managed_discovery_evidence_cap")
        return
    d._relationship(bundle, left["id"], right["id"], kind, item)
    if not any(r["source"] == left["id"] and r["target"] == right["id"]
               and r["kind"] == kind and item["id"] in r["evidence_ids"] for r in bundle["relationships"]):
        _fail(bundle, coverage, "managed_discovery_relationship_cap")


def _qualify(bundle, source, region, coverage):
    # A late page/cap/error must also disqualify earlier rows from the same batch.
    for item in bundle["evidence"]:
        if item["source"] == source and item["region"] == region:
            item["coverage"].update(coverage)
            if not coverage["complete"]:
                item["fresh"] = False


def _signals(bundle, budget, region, client_factory):
    d = _d()
    coverage = {"pages": 0, "complete": True, "continuation": False, "sampled": True,
                "topology_complete": False}
    bundle["coverage"].setdefault("application_signals", {})[region] = coverage
    state, services = {"calls": 0}, {}
    end = d._now().replace(minute=0, second=0, microsecond=0)
    start = end - dt.timedelta(hours=3)
    try:
        # IAM application-signals:ListServices/ListServiceDependencies: worker_diagnosis_managed.
        # Member clients require the same read actions in the registered member role.
        client = client_factory("application-signals", region, budget)
        for page in _pages(client, "list_services", {"StartTime": start, "EndTime": end,
                           "MaxResults": MAX_NODES, "IncludeLinkedAccounts": False,
                           "AwsAccountId": bundle["coverage"]["account"]},
                           bundle, budget, coverage, state):
            window = _window(page, start, end)
            if not window:
                _fail(bundle, coverage, "application_signals_window_unconfirmed")
            for row in _rows(page, "ServiceSummaries", bundle, coverage):
                key = _keys(row.get("KeyAttributes")) if isinstance(row, dict) else None
                if (not key or not _references(row.get("MetricReferences"), bundle["coverage"]["account"])
                        or not window):
                    d._mark(bundle, "gaps", "application_signals_identity_unconfirmed")
                    continue
                identity = d._json(key)
                if identity in services and services[identity] != row:
                    d._mark(bundle, "gaps", "application_signals_ambiguous_service")
                    services[identity] = None
                elif len(services) >= MAX_NODES and identity not in services:
                    _fail(bundle, coverage, "managed_discovery_node_cap")
                else:
                    services[identity] = row
        for identity, row in services.items():
            if not d._available(bundle, budget):
                _fail(bundle, coverage, "managed_discovery_deadline")
                break
            if row is None:
                continue
            key = row["KeyAttributes"]
            bound_source = _signals_binding(bundle, region, key, row.get("AttributeMaps", []))
            # The service catalog is not a same-span instance-call binding.
            source = _logical(bundle, region, "application_signals", identity, key.get("Name"), coverage)
            if source is None:
                break
            if bound_source:
                _emit(bundle, region, "application_signals", source, bound_source, "configured_dependency",
                      {"relation": "RUNS_ON", "resource_binding": "service_membership",
                       "provenance_family": "configuration"}, d._now(),
                      {"start": start.isoformat(), "end": end.isoformat()}, coverage)
            for page in _pages(client, "list_service_dependencies",
                               {"KeyAttributes": key, "StartTime": start, "EndTime": end,
                                "MaxResults": MAX_NODES}, bundle, budget, coverage, state):
                window = _window(page, start, end)
                if not window:
                    _fail(bundle, coverage, "application_signals_window_unconfirmed")
                for dep in _rows(page, "ServiceDependencies", bundle, coverage):
                    target_key = _keys(dep.get("DependencyKeyAttributes")) if isinstance(dep, dict) else None
                    if (not target_key or not window or
                            not _references(dep.get("MetricReferences"), bundle["coverage"]["account"])):
                        d._mark(bundle, "gaps", "application_signals_identity_unconfirmed")
                        continue
                    bound_target = _signals_binding(bundle, region, target_key)
                    target = bound_target or _logical(bundle, region, "application_signals",
                                                      d._json(target_key), target_key.get("Name"), coverage)
                    if not bound_target and target_key.get("Type") == "RemoteService":
                        _endpoint_alias(bundle, region, "application_signals", target, target_key.get("Name"),
                                        d._now(), coverage)
                    exact = bool(bound_target)
                    if not exact:
                        d._mark(bundle, "gaps", "managed_discovery_binding_unresolved")
                    _emit(bundle, region, "application_signals", source, target, "observed_call",
                          {"resource_binding": "exact" if exact else "unresolved",
                           "provenance_family": "application_telemetry",
                           "operations": [v for v in (d._text(dep.get("OperationName")),
                                                      d._text(dep.get("DependencyOperationName"))) if v]},
                          d._now(), window, coverage)
        if not services and coverage["complete"]:
            d._mark(bundle, "gaps", "application_signals_no_observations")
    except Exception:
        # Fixed diagnostics: never include provider payloads or credential material.
        _fail(bundle, coverage, "application_signals_read_failed", category="degraded")
    finally:
        coverage["requests"] = state["calls"]
        _qualify(bundle, "application_signals", region, coverage)


def _space(account, region):
    raw = os.environ.get("DIAGNOSIS_OMNI_SPACES", "{}")
    if len(raw) > 8192:
        raise ValueError("omni_config_malformed")
    spaces = json.loads(raw)
    if not isinstance(spaces, dict) or len(spaces) > 32:
        raise ValueError("omni_config_malformed")
    for key, value in spaces.items():
        if (not isinstance(key, str) or not re.fullmatch(r"\d{12}/[a-z]{2}(?:-gov)?-[a-z]+-\d", key)
                or not isinstance(value, str) or not _SPACE.fullmatch(value)):
            raise ValueError("omni_config_malformed")
    return spaces.get(f"{account}/{region}")


def _space_client(account, region, space, budget, control_factory):
    d = _d()
    if budget.remaining(analysis=True) <= 2:
        raise TimeoutError("omni_deadline")
    # IAM cloudwatch:GetSpaceCredentialsForOrganization; pre-existing organization
    # membership/delegated admin and space grants are separately required.
    result = control_factory("cloudwatchomni", region, budget).get_space_credentials_for_organization(
        context={"spaceId": space}, credentialType="SPACE_OPERATION")
    credentials = result.get("credentials", {})
    expiration = _time(credentials.get("expiration"))
    if (not expiration or (expiration - d._now()).total_seconds() < 60
            or not all(isinstance(credentials.get(k), str) and 1 <= len(credentials[k]) <= 8192
                       for k in ("accessKeyId", "secretAccessKey", "sessionToken"))):
        raise ValueError("omni_credentials_unconfirmed")
    session = boto3.Session(aws_access_key_id=credentials["accessKeyId"],
                            aws_secret_access_key=credentials["secretAccessKey"],
                            aws_session_token=credentials["sessionToken"])
    remaining = budget.remaining(analysis=True)
    if remaining <= 2:
        raise TimeoutError("omni_deadline")
    config = Config(connect_timeout=1, read_timeout=min(10, max(1, int(remaining - 1))),
                    retries={"total_max_attempts": 1, "mode": "standard"})
    if session.client("sts", region_name=region, config=config).get_caller_identity().get("Account") != account:
        raise ValueError("omni_credentials_scope_mismatch")
    remaining = budget.remaining(analysis=True)
    if remaining <= 2:
        raise TimeoutError("omni_deadline")
    # Never cache or export space credentials; fresh timeout after identity verification.
    return session.client("cloudwatchomni", region_name=region, config=Config(
        connect_timeout=1, read_timeout=min(10, max(1, int(remaining - 1))),
        retries={"total_max_attempts": 1, "mode": "standard"}))


def _omni(bundle, budget, region, control_factory):
    """Inactive adapter, exercised directly by tests; never called by collect."""
    d = _d()
    coverage = {"pages": 0, "complete": True, "continuation": False, "sampled": True,
                "topology_complete": False}
    bundle["coverage"].setdefault("cloudwatch_omni", {})[region] = coverage
    state, nodes, ambiguous = {"calls": 0}, {}, set()
    end = d._now()
    start = end - dt.timedelta(hours=3)
    try:
        space = _space(bundle["coverage"]["account"], region)
        if not space:
            _fail(bundle, coverage, "omni_space_not_configured", category="gaps")
            return
        client = _space_client(bundle["coverage"]["account"], region, space, budget, control_factory)
        state["calls"] += 2  # Credential resolution and identity verification share the bound.
        # IAM cloudwatch:GetContextGraph is in the pre-existing space's read grant.
        for page in _pages(client, "get_context_graph",
                           {"startTime": start, "endTime": end, "depth": 0, "includeMetadata": False,
                            "maxResults": MAX_NODES, "maxEdgesPerNode": MAX_EDGES_PER_NODE,
                            "nodeFilters": {"sourceAccountId": [bundle["coverage"]["account"]],
                                            "region": [region]}},
                           bundle, budget, coverage, state, token="nextToken"):
            for node in _rows(page, "nodes", bundle, coverage):
                props = node.get("nodeProperties", {}) if isinstance(node, dict) else {}
                identity = node.get("nodeId") if isinstance(node, dict) else None
                if (not isinstance(identity, str) or not 1 <= len(identity) <= 256
                        or not isinstance(props, dict) or props.get("sourceAccountId") != bundle["coverage"]["account"]
                        or props.get("region") != region or props.get("cloudProvider", "aws") != "aws"
                        or node.get("nodeType") not in {"SERVICE", "RESOURCE", "REMOTE_SERVICE"}):
                    d._mark(bundle, "gaps", "omni_node_scope_unconfirmed")
                    continue
                if identity in nodes and nodes[identity] != node:
                    ambiguous.add(identity)
                    d._mark(bundle, "gaps", "omni_ambiguous_node")
                elif identity not in nodes and len(nodes) >= MAX_NODES:
                    _fail(bundle, coverage, "managed_discovery_node_cap")
                else:
                    nodes[identity] = node
        bound, resources = {}, {}
        for identity, node in nodes.items():
            if identity in ambiguous:
                continue
            attrs = node.get("telemetryAttributes", {})
            if not isinstance(attrs, dict) or len(attrs) > 100:
                d._mark(bundle, "gaps", "omni_identity_unconfirmed")
                continue
            # Merged SERVICE attributes describe membership, not the instance
            # responsible for an aggregate service edge.
            native = (_typed_binding(bundle, region, identity, [attrs])
                      if node["nodeType"] == "RESOURCE" else None)
            bound[identity] = native
            resources[identity] = native or _logical(
                bundle, region, "cloudwatch_omni", identity, node.get("name"), coverage)
            if not native and node["nodeType"] == "REMOTE_SERVICE":
                _endpoint_alias(bundle, region, "cloudwatch_omni", resources[identity],
                                attrs.get("server.address") or node.get("name"), end, coverage)
        edges = 0
        for identity, node in nodes.items():
            if edges > d.MAX_RELATIONSHIPS or not d._available(bundle, budget):
                coverage["complete"] = False
                break
            rows = _rows(node, "edges", bundle, coverage, limit=MAX_EDGES_PER_NODE)
            if len(rows) >= MAX_EDGES_PER_NODE:
                _fail(bundle, coverage, "omni_edge_fanout_unconfirmed")
            for edge in rows:
                if not d._available(bundle, budget):
                    coverage["complete"] = False
                    break
                edges += 1
                if edges > d.MAX_RELATIONSHIPS:
                    _fail(bundle, coverage, "managed_discovery_edge_cap")
                    break
                if not isinstance(edge, dict) or edge.get("from") != identity:
                    d._mark(bundle, "gaps", "omni_edge_identity_unconfirmed")
                    continue
                left, right = resources.get(identity), resources.get(edge.get("to"))
                if not left or not right or edge.get("to") in ambiguous:
                    d._mark(bundle, "gaps", "omni_edge_target_unresolved")
                    continue
                if left["id"] == right["id"]:
                    d._mark(bundle, "gaps", "omni_self_edge_unconfirmed")
                    continue
                first, last = _time(edge.get("firstObservedAt")), _time(edge.get("lastObservedAt"))
                sources, signals = edge.get("sources"), edge.get("signalTypes")
                if (not isinstance(sources, list) or not sources or len(sources) > 20
                        or any(s not in _SOURCES for s in sources)
                        or not isinstance(signals, list) or len(signals) > 5
                        or any(s not in _SIGNALS for s in signals)):
                    d._mark(bundle, "gaps", "omni_edge_provenance_unconfirmed")
                    continue
                if edge.get("edgeType") not in {"CALLS", "ACCESSES", "RUNS_ON"}:
                    d._mark(bundle, "gaps", "omni_edge_type_unconfirmed")
                    continue
                observed = (edge.get("edgeType") == "CALLS" and "TELEMETRY" in sources and "TRACES" in signals)
                fresh = first is not None and last is not None and first <= last and start <= last <= end
                if observed and not fresh:
                    d._mark(bundle, "gaps", "omni_call_window_unconfirmed")
                kind = "observed_call" if observed else "configured_dependency"
                exact = bool(bound.get(identity) and bound.get(edge.get("to")))
                if not exact:
                    d._mark(bundle, "gaps", "managed_discovery_binding_unresolved")
                _emit(bundle, region, "cloudwatch_omni", left, right, kind,
                      {"resource_binding": "exact" if exact else "unresolved",
                       "relation": edge["edgeType"], "discovery_sources": sources, "signal_types": signals,
                       "provenance_family": "application_telemetry" if "TELEMETRY" in sources else "configuration"},
                      (last or end) if observed else end,
                      {"start": start.isoformat(), "end": end.isoformat()}, coverage,
                      fresh=fresh if observed else True)
        if not nodes and coverage["complete"]:
            d._mark(bundle, "gaps", "omni_no_observations")
    except Exception:
        _fail(bundle, coverage, "omni_read_failed", category="degraded")
    finally:
        coverage["requests"] = state["calls"]
        _qualify(bundle, "cloudwatch_omni", region, coverage)


def collect(bundle, budget, regions, *, client_factory):
    if os.environ.get("DIAGNOSIS_MANAGED_DISCOVERY_ENABLED") != "true":
        return
    d = _d()
    d._mark(bundle, "gaps", "managed_discovery_not_exhaustive")
    d._mark(bundle, "gaps", "omni_disabled_pending_iam_scope")
    for region in regions[:d.MAX_REGIONS]:
        # Even manually injected space configuration cannot activate credential
        # vending. Only Signals uses the verified host/member client factory.
        bundle["coverage"].setdefault("cloudwatch_omni", {})[region] = {
            "status": "disabled_pending_iam_scope", "complete": False,
            "topology_complete": False, "requests": 0, "pages": 0}
        if not d._available(bundle, budget):
            return
        _signals(bundle, budget, region, client_factory)
