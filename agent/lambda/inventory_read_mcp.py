"""
Inventory-Read MCP Lambda — Aurora-backed, read-only topology & unused-resource tool.

The v2 equivalent of v1's ops `run_steampipe_query`: instead of querying live Steampipe, it reads
the inventory the Steampipe sync already materialized into Aurora (`inventory_resources` +
`topology_nodes/edges`, ADR-043) and answers topology / unused-resource questions over it. This
reconnects "the topology data we built in Aurora" to AgentCore — the bridge that was missing in v2.

Tools (all read-only — SELECT only; no AWS mutation, no arbitrary SQL):
  - find_unused_resources : orphan TGs, empty CloudFront origins, dead/idle LBs, unattached EBS …
  - query_inventory       : list/filter synced resources by type (+ per-type freshness block)
  - get_topology          : topology_nodes/edges graph (nodes+edges, matches /api/graph contract)
  - inventory_summary     : counts by type + per-type freshness (healthy|degraded|stale|unavailable)

Aurora access uses the **RDS Data API** (boto3 `rds-data`, bundled in the Lambda runtime) — no VPC
attachment and no pg8000 packaging needed (the agent Lambdas are zipped from raw .py with no pip
deps). The cluster's HttpEndpoint must be enabled (terraform). DB access is lazy + injectable so the
pure detection logic (detect_unused) is unit-testable with fixtures (no DB, no boto3).

인벤토리-읽기 MCP 람다 — v2의 ops `run_steampipe_query` 등가물. Aurora에 동기화된 토폴로지/인벤토리를
RDS Data API로 읽어 미사용 리소스·토폴로지 질의에 답한다. 전부 읽기 전용(SELECT만).
"""
import json
import math
import os
import re
import time
from datetime import datetime, timezone

from cross_account import resolve_tool_name


DEFAULT_INVENTORY_STALE_AFTER_MINUTES = 30


def _inventory_stale_after_minutes(env=None):
    """Read the non-secret stale threshold without letting malformed env crash the tool."""
    source = os.environ if env is None else env
    try:
        value = int(source.get(
            "INVENTORY_STALE_AFTER_MINUTES",
            str(DEFAULT_INVENTORY_STALE_AFTER_MINUTES),
        ))
    except (TypeError, ValueError):
        return DEFAULT_INVENTORY_STALE_AFTER_MINUTES
    if value < 1 or value > 1440:
        return DEFAULT_INVENTORY_STALE_AFTER_MINUTES
    return value


# ── Resource types the topology/unused detection reads (mirrors graph-store TYPE_TO_KEY) ──────────
TOPOLOGY_TYPES = ["cloudfront", "alb", "nlb", "target_group", "ec2", "ebs", "security_group",
                  "route53", "lambda", "ecs_task", "s3"]

# Coverage note: EIP / ENI / ELB listeners are NOT in the inventory sync yet, so listener-less LBs
# and unattached EIP/ENI are out of scope for the Aurora-backed detector (live-API only).
COVERAGE_NOTE = ("Derived from the synced Aurora inventory (inventory_resources). Elastic IPs, "
                 "detached ENIs, and ELB listeners are not synced yet, so those are out of scope "
                 "here. query_inventory and inventory_summary carry a per-type freshness block "
                 "(healthy | degraded | stale | unavailable) classified from the durable "
                 "last_success_at and the oldest captured_at of current rows; degraded also covers "
                 "succeeded runs with unknown attribute coverage (unknown_attribute_count null or > 0). For this "
                 "tool's data, call inventory_summary().")

TRACE_TOPOLOGY_NOTE = (
    "Host-scoped trace topology from observed spans and service-graph metrics. "
    "Edge confidence is 'observed' with count metadata and 'unknown' without it, not a probability. "
    "Legacy normalized volume values are not evidence counts. meta.spanCount counts observed span "
    "relationships; meta.metricCount is an aggregate metric count. These are separate evidence "
    "counts, not complete traffic volume. collection describes the latest attempt and snapshot "
    "freshness; retained nodes alone do not establish that collection succeeded or is current. "
    "Queue identities are telemetry claims, not verified AWS accounts, regions or queue inventory. "
    "claimedAccountId/claimedRegion are rederived only from parsed destination ARNs, including "
    "retained rows; non-ARN destinations and absent qualifiers have null claims, never caller "
    "account/region fallbacks. identityProvenance is always telemetry_claim, even when an ARN "
    "names the host; queues never bridge into inventory. Shared destination ARNs join across "
    "callers only within datasource/environment; the same ARN can have separate nodes in each scope."
)


# ── Pure detection logic (fixture-testable; no DB) ───────────────────────────────────────────────
def _states(tg):
    """Health states of a target_group's registered targets (PascalCase AWS SDK shape)."""
    return [(d.get("TargetHealth") or {}).get("State") for d in (tg.get("target_health_descriptions") or [])]


def detect_unused(by_type):
    """Detect unused/orphaned resources from synced inventory rows.

    `by_type` maps resource_type -> list of the JSONB `data` dicts of inventory_resources.
    Returns a flat list of findings: {category, resource_type, resource_id, name, reason, severity}.
    """
    findings = []
    tgs = by_type.get("target_group") or []
    albs = by_type.get("alb") or []
    nlbs = by_type.get("nlb") or []

    # LB lookup helpers for the CloudFront origin join.
    lb_by_dns = {}
    for lb in albs + nlbs:
        dns = lb.get("dns_name")
        if dns:
            lb_by_dns[dns] = lb
    # Total healthy targets behind each LB ARN (across all its target groups).
    healthy_by_lb_arn = {}
    for tg in tgs:
        healthy = sum(1 for s in _states(tg) if s == "healthy")
        for arn in (tg.get("load_balancer_arns") or []):
            healthy_by_lb_arn[arn] = healthy_by_lb_arn.get(arn, 0) + healthy

    # ── Target groups ──
    for tg in tgs:
        name = tg.get("target_group_name") or tg.get("target_group_arn") or "?"
        rid = tg.get("target_group_arn") or name
        lb_arns = tg.get("load_balancer_arns") or []
        states = _states(tg)
        registered = len(states)
        healthy = sum(1 for s in states if s == "healthy")
        if not lb_arns:
            reason = "Orphan target group: not attached to any load balancer"
            reason += " and 0 registered targets." if registered == 0 else f"; {registered} target(s) registered but no listener routes to it."
            findings.append({"category": "TargetGroup (orphan, no LB)", "resource_type": "TargetGroup",
                             "resource_id": rid, "name": name, "reason": reason, "severity": "high"})
        elif healthy == 0:
            findings.append({"category": "TargetGroup (attached, 0 healthy)", "resource_type": "TargetGroup",
                             "resource_id": rid, "name": name, "severity": "high",
                             "reason": f"Attached to a load balancer but 0 healthy targets ({registered} registered, all unhealthy/unused) — the listener path is dead."})

    # ── CloudFront distributions ──
    for cf in by_type.get("cloudfront") or []:
        cid = cf.get("id") or cf.get("arn") or "?"
        aliases = cf.get("aliases")
        label = cid
        if isinstance(aliases, dict) and aliases.get("Items"):
            label = aliases["Items"][0]
        if not cf.get("enabled", True):
            findings.append({"category": "CloudFront (disabled)", "resource_type": "CloudFront",
                             "resource_id": cid, "name": label, "severity": "medium",
                             "reason": "Distribution is disabled (Enabled=false) — likely abandoned."})
            continue
        for origin in (cf.get("origins") or []):
            domain = origin.get("DomainName") if isinstance(origin, dict) else None
            if domain and domain in lb_by_dns:
                lb = lb_by_dns[domain]
                if healthy_by_lb_arn.get(lb.get("arn"), 0) == 0:
                    findings.append({"category": "CloudFront (empty origin)", "resource_type": "CloudFront",
                                     "resource_id": cid, "name": label, "severity": "high",
                                     "reason": f"Origin points at {lb.get('name')} which has no healthy backend targets — the origin serves nothing (empty/dead chain)."})
                    break

    # ── EBS volumes ──
    for vol in by_type.get("ebs") or []:
        if vol.get("state") == "available":
            vid = vol.get("volume_id") or "?"
            size = vol.get("size")
            findings.append({"category": "EBS volume (unattached)", "resource_type": "EBS",
                             "resource_id": vid, "name": vid, "severity": "high",
                             "reason": f"Volume is 'available' (unattached){f' — {size} GiB' if size else ''} — pure storage cost."})

    return findings


def build_topology_chain(by_type, root=None):
    """Trace CF→LB→TG→target chains from raw inventory rows (legacy chain-builder; topology_nodes/edges is the canonical path)."""
    albs = {lb.get("dns_name"): lb for lb in (by_type.get("alb") or []) + (by_type.get("nlb") or [])}
    tgs_by_lb = {}
    for tg in by_type.get("target_group") or []:
        for arn in (tg.get("load_balancer_arns") or []):
            tgs_by_lb.setdefault(arn, []).append(tg)
    chains = []
    for cf in by_type.get("cloudfront") or []:
        if root and root not in (cf.get("id"), cf.get("domain_name")):
            continue
        for origin in (cf.get("origins") or []):
            domain = origin.get("DomainName") if isinstance(origin, dict) else None
            lb = albs.get(domain) if domain else None  # null domain must not match a null-dns LB
            node = {"cloudfront": cf.get("id"), "origin": domain, "loadBalancer": lb.get("name") if lb else None,
                    "targetGroups": [{"name": t.get("target_group_name"),
                                      "healthy": sum(1 for s in _states(t) if s == "healthy"),
                                      "registered": len(_states(t))}
                                     for t in (tgs_by_lb.get(lb.get("arn"), []) if lb else [])]}
            chains.append(node)
    return chains


def _fetch_topology_graph(resource_id=None, cls="flow", limit=500):
    """Read the materialized topology graph from topology_nodes/edges (ADR-043).

    Matches the /api/graph contract:
      nodes = [{id, kind, label, meta}]
      edges = [{source, target, rel, confidence, meta?}] (trace meta: spanCount/metricCount)

    Resolve an exact canonical ID first, then an exact raw ID (everything after the first
    colon). The sanitized reader view deliberately omits meta.resourceId. Ambiguous raw IDs
    never select a graph. Select the root and its one-hop neighbours BEFORE limiting nodes.
    Return (nodes, edges, selection/truncation metadata); collection evidence belongs to
    the caller. Limits describe this response, not source collection completeness.
    """
    limit = max(1, min(int(limit), 500))
    edge_limit = 1000
    selection = {"status": "all"}
    truncation = {"nodes": False, "edges": False, "node_limit": limit, "edge_limit": edge_limit}
    metadata = {"selection": selection, "truncation": truncation}
    class_param = {"name": "cls", "value": {"stringValue": cls}}
    root = None
    if resource_id is not None:
        selection.update(status="not_found", requested_id=resource_id, resolved_id=None)
        resolve_params = [class_param, {"name": "rid", "value": {"stringValue": resource_id}}]
        matches = _execute(
            "SELECT id FROM topology_nodes WHERE account_id = 'self' AND class = :cls "
            "AND id = :rid LIMIT :match_limit",
            params=resolve_params + [{"name": "match_limit", "value": {"longValue": 1}}])
        matched_by = "canonical"
        if not matches:
            matches = _execute(
                "SELECT id FROM topology_nodes WHERE account_id = 'self' AND class = :cls "
                "AND strpos(id, ':') > 0 AND substring(id FROM strpos(id, ':') + 1) = :rid "
                "ORDER BY id LIMIT :match_limit",
                params=resolve_params + [{"name": "match_limit", "value": {"longValue": 3}}])
            matched_by = "raw"
            if len(matches) > 1:
                selection.update(status="ambiguous", candidate_ids=[r["id"] for r in matches[:2]],
                                 candidates_truncated=len(matches) > 2)
                return [], [], metadata
        if not matches:
            return [], [], metadata
        root = matches[0]["id"]
        selection.update(status="resolved", resolved_id=root, matched_by=matched_by)

    node_params = [class_param, {"name": "node_limit", "value": {"longValue": limit + 1}}]
    predicate, node_order = "", "id"
    if root is not None:
        node_params.append({"name": "root", "value": {"stringValue": root}})
        predicate = (
            " AND (n.id = :root OR EXISTS (SELECT 1 FROM topology_edges e "
            "WHERE e.account_id = 'self' AND e.class = :cls "
            "AND ((e.source = :root AND e.target = n.id) OR "
            "(e.target = :root AND e.source = n.id))))"
        )
        node_order = "(n.id = :root) DESC, n.id"
    node_rows = _execute(
        "SELECT id, kind, label, meta FROM topology_nodes n "
        "WHERE account_id = 'self' AND class = :cls" + predicate
        + " ORDER BY " + node_order + " LIMIT :node_limit", params=node_params)
    truncation["nodes"] = len(node_rows) > limit
    node_rows = node_rows[:limit]
    node_ids = {r["id"] for r in node_rows if r.get("id")}

    # Row-to-JSON lookup also works against the pre-migration view, which has no meta column.
    edge_columns = "source, target, rel, confidence" + (
        ", to_jsonb(e)->'meta' AS meta" if cls == "trace" else "")
    # A bounded JSON string parameter avoids unsupported Data API array parameters. Restrict
    # BOTH endpoints in SQL, so a large graph never becomes an unbounded full-edge response.
    edge_params = [class_param,
                   {"name": "node_ids", "value": {"stringValue": json.dumps(sorted(node_ids))}},
                   {"name": "edge_limit", "value": {"longValue": edge_limit + 1}}]
    edge_order = "source, target, rel"
    if root is not None:
        edge_params.append({"name": "root", "value": {"stringValue": root}})
        edge_order = "(source = :root OR target = :root) DESC, " + edge_order
    edge_rows = _execute(
        "SELECT " + edge_columns + " FROM topology_edges e "
        "WHERE account_id = 'self' AND class = :cls "
        "AND source IN (SELECT jsonb_array_elements_text(CAST(:node_ids AS jsonb))) "
        "AND target IN (SELECT jsonb_array_elements_text(CAST(:node_ids AS jsonb))) "
        "ORDER BY " + edge_order + " LIMIT :edge_limit", params=edge_params)
    truncation["edges"] = len(edge_rows) > edge_limit
    edge_rows = edge_rows[:edge_limit]

    def _parse_meta(m):
        if isinstance(m, dict):
            return m
        if isinstance(m, str) and m:
            try:
                parsed = json.loads(m)
                return parsed if isinstance(parsed, dict) else {}
            except ValueError:
                return {}
        return {}

    nodes = [{"id": r["id"], "kind": r["kind"], "label": r["label"],
              "meta": _parse_meta(r.get("meta"))} for r in node_rows if r.get("id")]
    if cls == "trace":
        for node in nodes:
            if node["kind"] != "queue":
                continue
            meta = node["meta"].copy()
            # Re-derive before/after migration: stored claim fields may name the reporter.
            destination = meta.get("destination")
            arn = re.fullmatch(
                r"arn:[a-z0-9-]+:[a-z0-9-]+:([a-z0-9-]*):([0-9]{12}):\S+",
                destination.strip(),
            ) if isinstance(destination, str) else None
            for key in ("accountId", "region", "infra_ref"):
                meta.pop(key, None)
            meta["claimedAccountId"] = arn[2] if arn else None
            meta["claimedRegion"] = (arn[1] or None) if arn else None
            meta["identityProvenance"] = "telemetry_claim"
            node["meta"] = meta
    edges = []
    for row in edge_rows:
        if row.get("source") not in node_ids or row.get("target") not in node_ids:
            continue
        edge = {"source": row["source"], "target": row["target"], "rel": row["rel"],
                "confidence": "unknown" if cls == "trace" else row["confidence"]}
        if cls == "trace":
            # Legacy snapshots have no counts. Do not fabricate a count from old confidence values.
            meta = _parse_meta(row.get("meta"))
            edge["meta"] = {
                key: meta[key] for key in ("spanCount", "metricCount")
                if key in meta and type(meta[key]) in (int, float) and meta[key] >= 0
                and (isinstance(meta[key], int) or math.isfinite(meta[key]))
            }
            if edge["meta"]:
                edge["confidence"] = "observed"
        edges.append(edge)

    return nodes, edges, metadata


def _fetch_trace_collection(cls="trace"):
    """Read graph-state evidence through the sanitized view; trace remains the default.

    DB/permission errors deliberately propagate, just like the topology reads. An absent relation
    or state row means unknown; a failed query must never certify a retained graph.
    """
    unknown = {"status": "unknown", "stale": True, "attempted_at": None,
               "captured_at": None, "sources": [],
               **({"evidenceKind": "inventory"} if cls != "trace" else {})}
    # Probe the same search-path relation we actually read (the sql_reader view). Deployment may
    # precede either the state-table migration or its reader-view projection. No public fallback,
    # and no permission/connection error is caught or reclassified as an absent schema.
    relation = _execute("SELECT to_regclass('topology_graph_state')::text AS state_relation")
    if not relation or relation[0].get("state_relation") is None:
        return unknown
    rows = _execute(
        "SELECT status, attempted_at, captured_at, details FROM topology_graph_state "
        "WHERE account_id = 'self' AND class = :cls LIMIT 1",
        params=[{"name": "cls", "value": {"stringValue": cls}}],
    )
    if not rows:
        return unknown
    row = rows[0]
    details = row.get("details")
    if isinstance(details, str):
        try:
            details = json.loads(details)
        except ValueError:
            details = None
    valid_details = isinstance(details, dict) and isinstance(details.get("sources"), list)
    details = details if valid_details else {"sources": []}
    status = row.get("status")
    if status not in ("ok", "empty", "partial", "unavailable", "error"):
        status = "unknown"
    if not valid_details and status not in ("error", "unavailable"):
        status = "unknown"

    # Same cadence policy as web/lib/graph-state.ts: two rebuild intervals, at least 15 minutes.
    try:
        interval = float(os.environ.get("GRAPH_REBUILD_INTERVAL_MINS", "0"))
    except ValueError:
        interval = 0
    max_age_minutes = max(15, interval * 2) if math.isfinite(interval) else 15
    captured = None
    try:
        raw = row.get("captured_at")
        stamp = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        captured = stamp.replace(tzinfo=timezone.utc).timestamp() if stamp.tzinfo is None else stamp.timestamp()
    except (AttributeError, TypeError, ValueError, OverflowError):
        pass  # missing/invalid snapshot time is stale, never replaced with the current clock
    stale = (
        captured is None or captured > time.time() or time.time() - captured > max_age_minutes * 60
        or status in ("unknown", "error", "unavailable") or details.get("retainedPrevious") is True
        or details.get("metadataTruncated") is True
    )
    if cls != "trace":
        details = {**details, "evidenceKind": "inventory"}
        sources = details.get("publishedSources")
        stale = stale or not isinstance(sources, list) or not sources
        for source in sources if isinstance(sources, list) else []:
            if not isinstance(source, dict):
                stale = True
                continue
            if type(source.get("itemCount")) is not int or source["itemCount"] < 0:
                stale = True
                continue
            clocks = [source.get("lastSuccessAtMs")]
            if source["itemCount"] > 0:
                clocks.append(source.get("capturedAtMs"))
            stale = stale or source.get("producerStatus") != "succeeded" or source.get("status") not in ("ok", "empty") or any(
                type(clock) not in (int, float) or not math.isfinite(clock) or clock <= 0
                or clock > time.time() * 1000
                or time.time() * 1000 - clock > _inventory_stale_after_minutes() * 60_000
                for clock in clocks)
    return {**details, "status": status, "stale": bool(stale),
            "attempted_at": row.get("attempted_at"), "captured_at": row.get("captured_at")}


def _inventory_graph_collection(cls):
    try:
        return _fetch_trace_collection(cls)
    except Exception:
        # Preserve readable last-good rows without exposing SQL/provider/credential errors.
        return {"status": "error", "stale": True, "attempted_at": None, "captured_at": None,
                "sources": [], "failureReason": "state_read_failed"}


# ── Aurora access via the RDS Data API (lazy + injectable; boto3 is in the Lambda runtime) ─────────
_execute_override = None  # tests may inject a fake (sql, params) -> [row-dict]


def _execute(sql, params=None):
    """Run read-only SQL through the RDS Data API; return rows as dicts (formatRecordsAs=JSON)."""
    if _execute_override:
        return _execute_override(sql, params)
    import boto3  # lazy: keep pure logic importable without boto3
    client = boto3.client("rds-data", region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))
    kwargs = {
        "resourceArn": os.environ["AURORA_CLUSTER_ARN"],
        "secretArn": os.environ["AURORA_SECRET_ARN"],
        "database": os.environ.get("AURORA_DATABASE", "awsops"),
        "sql": sql,
        "formatRecordsAs": "JSON",
    }
    if params:
        kwargs["parameters"] = params
    resp = client.execute_statement(**kwargs)
    return json.loads(resp.get("formattedRecords") or "[]")


def _coerce(d):
    return d if isinstance(d, dict) else (json.loads(d) if isinstance(d, str) and d else {})


# Per-type field projection: the RDS Data API has a hard 1 MB response cap, and the raw `data`
# JSONB (esp. cloudfront cache_behaviors) is large. So we SELECT only the keys the detector/topology
# logic actually reads — keeping each response well under the cap on large accounts. Keys are
# constants (never user input); the resource_type is always a bound Data API parameter.
PROJECTIONS = {
    "target_group": ["target_group_arn", "target_group_name", "load_balancer_arns", "target_health_descriptions"],
    "alb": ["name", "dns_name", "arn"],
    "nlb": ["name", "dns_name", "arn"],
    # `origins` IS present, but the sql_reader view (migration 01KYVY9J…) projects each element down
    # to `{DomainName}` only — detect_unused()/build_topology_chain() read nothing else off an origin
    # object (grepped). A prior revision dropped the key entirely to keep CustomHeaders[].HeaderValue
    # (an origin secret) out, which silently disabled the "CloudFront (empty origin)" high-severity
    # finding (PR #197 review MAJOR, 3 models). The per-element projection is what actually closes
    # the leak, so the key belongs back on this list.
    "cloudfront": ["id", "domain_name", "enabled", "origins", "aliases"],
    "ebs": ["volume_id", "state", "size", "volume_type"],
}


def _projected_select(rtype):
    """Column expression for a type's inventory payload.

    Reads run as `awsops_sql_reader`, whose sql_reader.inventory_resources view exposes `data` as a
    NAMED-KEY PROJECTION (migration 01KYVY9J…, INVARIANT rule 5) — raw provider payloads are not
    reachable, so any key not on that allowlist comes back absent, not denied. Selecting `data`
    unqualified is therefore safe here AND under the exec role, and asking for a specific key that
    the view drops simply yields null rather than an error.
    """
    keys = PROJECTIONS.get(rtype)
    if not keys:
        return "data"
    pairs = ",".join("'" + k + "', data->'" + k + "'" for k in keys)  # keys are module constants
    return "jsonb_build_object(" + pairs + ")"


def _fetch_by_type(types):
    """Read inventory_resources grouped by resource_type. Returns {type: [data, ...]}.

    `types` are trusted internal constants — restricted to TOPOLOGY_TYPES. One bounded, field-
    projected query per type (1 MB Data API cap), with the type bound as a parameter (never inlined)."""
    out = {}
    for t in [t for t in types if t in set(TOPOLOGY_TYPES)]:
        rows = _execute(
            "SELECT " + _projected_select(t) + " AS data FROM inventory_resources "
            "WHERE account_id = 'self' AND resource_type = :rt",
            params=[{"name": "rt", "value": {"stringValue": t}}])
        out[t] = [_coerce(r.get("data")) for r in rows]
    return out


def _fetch_one_type(rtype, limit, resource_id=None):
    """Backs `query_inventory`, the one tool where the model picks `rtype` — so unlike
    `_fetch_by_type` (called only with the fixed TOPOLOGY_TYPES set), this can be asked about a type
    with no PROJECTIONS entry.

    Selecting bare `data` for such a type used to look like it returned the full row, but reads run
    as `awsops_sql_reader`, whose view already limits `data` to the union of every projected key
    across ALL types (PR #197 review MAJOR, codex-L2) — so an unregistered type came back with
    whatever keys happened to overlap by accident, silently incomplete rather than genuinely absent.
    Being explicit about the same projection (harmless — `_projected_select` falls back to bare
    `data` for an unregistered type too, since that is what the view already limits it to either
    way) does not fix the incompleteness by itself; the honesty fix is the `limited` flag the caller
    surfaces so nothing downstream mistakes a partial object for a complete one.
    """
    params = [{"name": "rt", "value": {"stringValue": rtype}}]
    predicate, projection = "", _projected_select(rtype)
    if resource_id is not None:
        predicate = " AND resource_id = :rid"
        params.append({"name": "rid", "value": {"stringValue": resource_id}})
        projection, limit = "jsonb_build_object('id', resource_id)", 1
    rows = _execute("SELECT " + projection + " AS data FROM inventory_resources "
                    "WHERE account_id = 'self' AND resource_type = :rt" + predicate
                    + " ORDER BY captured_at DESC, account_id, region, resource_id LIMIT " + str(int(limit)),
                    params=params)
    return [_coerce(r.get("data")) for r in rows]


def _sync_freshness(resource_type=None):
    """Return threshold-classified freshness per type using bound Data API parameters.

    Current rows use their oldest captured_at so a partial refresh cannot hide preserved stale
    rows behind newer rows. When no rows exist, the durable last_success_at keeps a genuine
    zero-row success visible across later running/failed/partial attempts.

    A succeeded run with unknown coverage (unknown_attribute_count null or > 0 — unmeasured or
    denied attribute reads) reports 'degraded', not 'healthy': this must not block pruning
    or last_success_at, but the reader must not be told the sweep saw everything either.
    """
    stale_after = _inventory_stale_after_minutes()
    params = [{
        "name": "stale_after_minutes",
        "value": {"longValue": stale_after},
    }]
    type_filter = ""
    if resource_type is not None:
        type_filter = " WHERE classified.resource_type = :rt"
        params.append({"name": "rt", "value": {"stringValue": resource_type}})

    rows = _execute(
        "WITH types AS ("
        "SELECT resource_type FROM inventory_sync_runs WHERE account_id = 'self' "
        "UNION "
        "SELECT resource_type FROM inventory_resources WHERE account_id = 'self'"
        "), resource_counts AS ("
        "SELECT resource_type, COUNT(*)::integer AS current_count, "
        "MIN(captured_at) AS oldest_captured_at FROM inventory_resources "
        "WHERE account_id = 'self' GROUP BY resource_type"
        "), per_type AS ("
        "SELECT types.resource_type, runs.status, runs.finished_at, runs.row_count, "
        "runs.last_success_at, runs.last_success_row_count, "
        "runs.unknown_attribute_count, "
        "COALESCE(resources.current_count, 0) AS current_count, "
        "resources.oldest_captured_at "
        "FROM types "
        "LEFT JOIN inventory_sync_runs runs "
        "ON runs.account_id = 'self' AND runs.resource_type = types.resource_type "
        "LEFT JOIN resource_counts resources "
        "ON resources.resource_type = types.resource_type"
        "), classified AS ("
        "SELECT resource_type, status, finished_at, row_count, last_success_at, "
        "last_success_row_count, unknown_attribute_count, current_count, oldest_captured_at, "
        "CASE WHEN last_success_at IS NULL THEN NULL ELSE "
        "LEAST(last_success_at, COALESCE(oldest_captured_at, last_success_at)) END "
        "AS latest_success_at "
        "FROM per_type"
        ") "
        "SELECT resource_type, status, finished_at, row_count, last_success_at, "
        "last_success_row_count, unknown_attribute_count, current_count, oldest_captured_at, "
        "latest_success_at, "
        "CASE "
        "WHEN latest_success_at IS NULL THEN 'unavailable' "
        "WHEN latest_success_at < CURRENT_TIMESTAMP - "
        "(:stale_after_minutes * INTERVAL '1 minute') THEN 'stale' "
        "WHEN status IN ('partial', 'failed', 'running') THEN 'degraded' "
        "WHEN status = 'succeeded' AND (unknown_attribute_count IS NULL OR unknown_attribute_count > 0) THEN 'degraded' "
        "WHEN status = 'succeeded' THEN 'healthy' "
        "ELSE 'unavailable' END AS freshness, "
        "CASE WHEN latest_success_at IS NULL THEN NULL ELSE "
        "GREATEST(0, FLOOR(EXTRACT(EPOCH FROM "
        "(CURRENT_TIMESTAMP - latest_success_at)) / 60))::integer END AS age_minutes, "
        ":stale_after_minutes AS stale_after_minutes "
        "FROM classified" + type_filter + " ORDER BY resource_type",
        params=params,
    )
    return rows


def _freshness_for_type(resource_type):
    rows = _sync_freshness(resource_type)
    if rows:
        return rows[0]
    return {
        "resource_type": resource_type,
        "status": None,
        "finished_at": None,
        "row_count": None,
        "current_count": 0,
        "last_success_at": None,
        "last_success_row_count": None,
        "unknown_attribute_count": None,
        "oldest_captured_at": None,
        "latest_success_at": None,
        "freshness": "unavailable",
        "age_minutes": None,
        "stale_after_minutes": _inventory_stale_after_minutes(),
    }


# ── Tool dispatch ─────────────────────────────────────────────────────────────────────────────────
def _ok(body):
    return {"statusCode": 200, "body": json.dumps(body, default=str)}


def lambda_handler(event, context):
    """Entry point. Read-only: every tool issues SELECT-only queries against Aurora."""
    params = event if isinstance(event, dict) else json.loads(event)
    tool_name = resolve_tool_name(params, context)
    arguments = params.get("arguments", params)
    if isinstance(arguments, dict):
        arguments.pop("target_account_id", None)  # single-account; accept-and-ignore

    if tool_name in ("find_unused_resources", ""):
        by_type = _fetch_by_type(["target_group", "alb", "nlb", "cloudfront", "ebs"])
        findings = detect_unused(by_type)
        category = arguments.get("category") if isinstance(arguments, dict) else None
        if category:
            findings = [f for f in findings if category.lower() in f["category"].lower()]
        return _ok({"findings": findings, "count": len(findings), "note": COVERAGE_NOTE})

    if tool_name == "get_topology":
        resource_id = arguments.get("resource_id") if isinstance(arguments, dict) else None
        if isinstance(arguments, dict) and "resource_id" in arguments and (
            not isinstance(resource_id, str) or not resource_id.strip() or len(resource_id) > 4096
        ):
            return {"statusCode": 400, "body": json.dumps(
                {"error": "resource_id must be a nonempty string of at most 4096 characters"})}
        cls = (arguments.get("class") or "flow") if isinstance(arguments, dict) else "flow"
        if cls not in ("flow", "infra", "trace"):
            # Reject unknown class (400) — do NOT silently coerce to 'flow'. The /api/graph BFF returns
            # 400 for the same input; a direct-MCP caller must get an error, not the WRONG layer's data
            # (plan T7b: both read paths reject identically) (M4).
            return {"statusCode": 400, "body": json.dumps(
                {"error": "invalid class: " + str(cls) + " (expected flow|infra|trace)"})}
        collection = _fetch_trace_collection() if cls == "trace" else _inventory_graph_collection(cls)
        nodes, edges, graph_metadata = _fetch_topology_graph(resource_id=resource_id, cls=cls)
        if cls != "trace":
            # Data API selections use multiple bounded reads. A publication between them cannot
            # certify one coherent snapshot; disclose it without altering Task2 selection limits.
            after = _inventory_graph_collection(cls)
            changed = any(after.get(key) != collection.get(key) for key in (
                "attempted_at", "captured_at", "status", "sources", "publishedSources", "failureReason"))
            collection = after
            if changed:
                collection = {**after, "stale": True, "snapshotConsistent": False,
                              "failureReason": after.get("failureReason") or "publication_changed"}
        result = {"class": cls, "nodes": nodes, "edges": edges, **graph_metadata,
                  "node_count": len(nodes), "edge_count": len(edges),
                  "note": TRACE_TOPOLOGY_NOTE if cls == "trace" else COVERAGE_NOTE}
        if resource_id:
            result["from"] = resource_id
        if collection is not None:
            result["collection"] = collection
            result["captured_at"] = collection["captured_at"]
            if collection["stale"] or collection["status"] == "partial":
                result["warning"] = (
                    ("Trace" if cls == "trace" else "Graph") + " collection evidence is incomplete or stale; inspect collection before "
                    "treating nodes or edges as current."
                )
        selection_status = graph_metadata["selection"]["status"]
        selection_warning = None
        if selection_status == "ambiguous":
            selection_warning = "Ambiguous resource_id; use a canonical node ID from selection.candidate_ids."
        elif selection_status == "not_found":
            selection_warning = "Requested resource_id was not found in this host's selected graph class."
        elif any(graph_metadata["truncation"][key] for key in ("nodes", "edges")):
            selection_warning = "Topology response is truncated; inspect truncation before inferring full coverage."
        if selection_warning:
            result["warning"] = " ".join(filter(None, [result.get("warning"), selection_warning]))
        return _ok(result)

    if tool_name == "query_inventory":
        rtype = arguments.get("resource_type") if isinstance(arguments, dict) else None
        if not rtype:
            return {"statusCode": 400, "body": json.dumps({"error": "resource_type required"})}
        resource_id = arguments.get("resource_id")
        if resource_id is not None and (rtype != "cloudfront" or not isinstance(resource_id, str)
                                            or not re.fullmatch(r"[A-Z0-9]{5,32}", resource_id)):
            return {"statusCode": 400, "body": json.dumps({"error": "valid CloudFront resource_id required"})}
        try:
            limit = min(int(arguments.get("limit", 200)), 500) if isinstance(arguments, dict) else 200
        except (TypeError, ValueError):
            limit = 200  # a hallucinated non-numeric limit must not 500
        rows = _fetch_one_type(rtype, limit, resource_id)
        result = {
            "resource_type": rtype,
            "count": len(rows),
            "resources": rows,
            "freshness": _freshness_for_type(rtype),
        }
        if resource_id is not None:
            result.update(projection="identity_only", resource_id=resource_id)
            if not rows:
                result["note"] = ("No matching identity was observed in the host/self synced inventory. "
                                  "This is not evidence of absence in AWS; check freshness or a direct CloudFront read.")
        if rtype not in PROJECTIONS:
            # PR #197 review MAJOR: an unregistered type's `resources` entries only carry whatever
            # keys happen to be on SOME other type's projection allowlist — genuinely absent fields
            # read the same as accidentally-omitted ones. Say so, rather than let a model (or a
            # human reading the response) mistake this for the resource's full JSON.
            result["note"] = (
                f"field-level detail for resource_type={rtype!r} is limited by the sql_reader "
                f"view's security boundary (only fields curated for other types may appear, by "
                f"coincidence) — use inventory_summary/find_unused_resources/get_topology, or the "
                f"AWS describe_* tools, for this type's full detail."
            )
        return _ok(result)

    if tool_name == "inventory_summary":
        return _ok({"sync": _sync_freshness(), "note": COVERAGE_NOTE})

    return {"statusCode": 400, "body": json.dumps({"error": "Unknown tool: " + str(tool_name)})}
