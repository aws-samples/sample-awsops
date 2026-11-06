"""Code-owned, bounded evidence collection. No model-selected SDK or SQL calls.

Storage uses ``self`` for the host; every public identity uses the validated
12-digit report account. Telemetry claims never change this scope.
"""
import copy
import datetime as dt
import hashlib
import ipaddress
import json
import math
import os
import re
import threading

import boto3
from botocore.config import Config

from redact import redact
from finops.guards import guard_hits

try:
    from pg8000.exceptions import InterfaceError as _DriverTransport
except ImportError:  # pragma: no cover - driver absent in unit environments
    _DriverTransport = OSError

MAX_REGIONS = 8
MAX_PAGES = 3
MAX_RESOURCES = 200
MAX_INVENTORY_RESOURCES = 180  # Reserve space for trace identities and live DB proxies.
MAX_RELATIONSHIPS = 400
MAX_EVIDENCE = 1200
MAX_BYTES = 192 * 1024
METRIC_DAYS = 14
PERIOD = 3600
_ACCOUNT = re.compile(r"^\d{12}$")
_REGION = re.compile(r"^[a-z]{2}(?:-gov)?-[a-z]+-\d+$")
_INSTANCE = re.compile(r"^i-(?:[a-f0-9]{8}|[a-f0-9]{17})$")
_FACT_KEYS = (
    "arn", "name", "instance_type", "instance_state", "private_ip_address",
    "db_instance_identifier", "endpoint_address",
    "engine", "engine_version", "multi_az", "availability_zone",
    "publicly_accessible", "storage_encrypted", "encrypted", "backup_retention_period",
    "storage_type", "allocated_storage", "iops", "vpc_id", "subnet_id",
    "read_replica_source_db_instance_identifier",
    "architecture", "tags", "class", "status", "endpoint_port", "last_status",
    "task_arn", "task_group", "cluster_arn", "attachments",
)
_TAG_KEYS = {"name", "dr", "disaster-recovery", "compliance", "retention", "do-not-delete", "donotdelete"}
_NODE_KEYS = ("resourceId", "inventoryAccount", "accountId", "region", "host", "service",
              "sourceId", "invType", "namespace", "deployment", "environment")
_REASONS = {"missing_configuration", "configuration_failed", "query_failed", "malformed_payload",
            "malformed_rows", "payload_truncated", "trace_fetch_failed", "cap_reached",
            "invalid_request", "source_failed", "registry_read_failed", "missing_ledger", "incomplete_collection",
            "unknown_attributes", "unknown_capture", "unknown_account_coverage",
            "empty_not_confirmed", "count_not_confirmed"}
_CAPABILITIES = {"resource_metrics", "provider_sizing", "graph_refresh"}
_clients = {}
_client_lock = threading.Lock()


def _stale_seconds():
    """INVENTORY_STALE_AFTER_MINUTES parity with web/lib/graph-state.ts and inventory_read_mcp."""
    return _bounded_int(os.environ.get("INVENTORY_STALE_AFTER_MINUTES"), 30, 1440, floor=1) * 60


def _now():
    return dt.datetime.now(dt.timezone.utc)


def _client(service, region, budget):
    remaining = budget.remaining(analysis=True)
    if remaining <= 2:
        raise TimeoutError("discovery_deadline")
    # Connect and read phases together fit the current analysis deadline. No
    # hidden SDK retry may spend a second timeout after that deadline.
    read_timeout = min(10, max(1, int(remaining - 1)))
    key = (service, region, read_timeout)
    with _client_lock:
        if key not in _clients:
            _clients[key] = boto3.client(service, region_name=region, config=Config(
                connect_timeout=1, read_timeout=read_timeout,
                retries={"total_max_attempts": 1, "mode": "standard"}))
        return _clients[key]


def _json(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str)


def _id(prefix, *parts):
    return prefix + ":" + hashlib.sha256(_json(parts).encode()).hexdigest()[:32]


def _dict(value):
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            out = json.loads(value)
            return out if isinstance(out, dict) else {}
        except (ValueError, TypeError):
            pass
    return {}


def _text(value, limit=240):
    return redact(value[:limit]) if isinstance(value, str) else None


def _number(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else None


def _stamp(value):
    try:
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return dt.datetime.fromtimestamp(value / 1000, dt.timezone.utc)
        if isinstance(value, str):
            value = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        if isinstance(value, dt.datetime):
            return value.replace(tzinfo=dt.timezone.utc) if value.tzinfo is None else value.astimezone(dt.timezone.utc)
    except (ValueError, TypeError, OverflowError, OSError):
        pass
    return None


def _iso(value):
    stamp = _stamp(value)
    return stamp.isoformat() if stamp else None


def _fresh(value, seconds):
    stamp = _stamp(value)
    return stamp is not None and 0 <= (_now() - stamp).total_seconds() <= seconds


def _mark(bundle, category, reason):
    if reason not in bundle[category]:
        bundle[category].append(reason)


def _available(bundle, budget):
    if budget.remaining(analysis=True) <= 2:
        _mark(bundle, "incomplete", "discovery_deadline")
        return False
    return True


def _db_read(conn, bundle, budget, sql, **parameters):
    """Bound code-owned SELECTs and restore the caller's session policy.

    pg8000's native connection exposes its transport as _usock. Bound it before
    even SHOW/SET so a disconnected database cannot hang until the worker timeout.
    The server statement timeout cancels slow reads without closing a healthy
    connection; the transport timeout also bounds a lost server response.
    """
    if bundle["coverage"].get("database_connection_broken"):
        raise ConnectionError("database_connection_broken")
    if not _available(bundle, budget):
        raise TimeoutError("discovery_deadline")
    # The server cancels (statement_timeout) before the transport gives up, so
    # a slow read fails cleanly and the pg8000 connection stays usable.
    seconds = min(10, max(0.001, budget.remaining(analysis=True) - 1))
    sock = getattr(conn, "_usock", None)
    prior_socket = None
    if sock is not None:
        prior_socket = sock.gettimeout()
        sock.settimeout(min(seconds, prior_socket) if prior_socket is not None else seconds)
    prior_statement = None
    try:
        prior_statement = _run(conn, bundle, "SHOW statement_timeout")[0][0]
        if not _available(bundle, budget):
            raise TimeoutError("discovery_deadline")
        seconds = min(seconds, budget.remaining(analysis=True) - 1)
        if sock is not None:
            sock.settimeout(seconds)
        _run(conn, bundle, "SELECT set_config('statement_timeout',:timeout,false)",
             timeout=f"{max(1, int(max(seconds - 2, seconds / 2) * 1000))}ms")
        if not _available(bundle, budget):
            raise TimeoutError("discovery_deadline")
        if sock is not None:
            sock.settimeout(min(seconds, budget.remaining(analysis=True) - 1))
        return _run(conn, bundle, sql, **parameters)
    finally:
        try:
            if prior_statement is not None and not bundle["coverage"].get("database_connection_broken"):
                if sock is not None:
                    # Restore with at most one second of the reserved export
                    # window, even if the analysis deadline was just exhausted.
                    sock.settimeout(min(1, seconds))
                _run(conn, bundle, "SELECT set_config('statement_timeout',:timeout,false)",
                     timeout=prior_statement)
        except Exception:
            _mark(bundle, "degraded", "database_timeout_restore_failed")
        if bundle["coverage"].get("database_connection_broken"):
            try:  # Fail closed: no later caller may read a desynced protocol stream.
                conn.close()
            except Exception:
                pass
        elif sock is not None:
            sock.settimeout(prior_socket)


def _run(conn, bundle, sql, **parameters):
    try:
        return conn.run(sql, **parameters)
    except (OSError, _DriverTransport):
        # A transport failure mid-message desyncs pg8000; the connection is unusable.
        bundle["coverage"]["database_connection_broken"] = True
        _mark(bundle, "degraded", "database_connection_broken")
        raise


def _address(value):
    if not isinstance(value, str) or len(value) > 45:
        return None
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return None
    return str(address) if address.version == 4 and not (
        address.is_unspecified or address.is_loopback or address.is_multicast) else None


def _facts(data, *, account=None, region=None):
    out = {}
    for key in _FACT_KEYS:
        value = data.get(key)
        if key == "tags":
            tags = value if isinstance(value, dict) else {}
            out["tags"] = {k: _text(str(v), 100) for k, v in tags.items()
                           if isinstance(k, str) and k.lower() in _TAG_KEYS}
        elif key == "attachments" and isinstance(value, list):
            # Only ENI identifiers; container environment/credentials stay outside SQL projection.
            if len(value) > 4 or any(isinstance(a, dict) and a.get("Type") == "ElasticNetworkInterface"
                    and (not isinstance(a.get("Details"), list) or len(a["Details"]) > 8) for a in value):
                out[key] = []
                out["attachments_complete"] = False
                continue
            out[key] = [{"Type": a.get("Type"), "Details": [
                {"Name": x.get("Name"), "Value": (
                    _address(x.get("Value")) if x.get("Name") == "privateIPv4Address"
                    else _text(x.get("Value"), 100))}
                for x in a.get("Details", [])[:8] if isinstance(x, dict)
                and x.get("Name") in ("subnetId", "privateIPv4Address", "networkInterfaceId")
                and isinstance(x.get("Value"), str)]}
                for a in value if isinstance(a, dict) and isinstance(a.get("Details"), list)]
        elif key == "read_replica_source_db_instance_identifier" and key in data:
            # Presence matters: a synced null means standalone, an absent key means unknown.
            out[key] = _text(value, 200) if isinstance(value, str) else ""
        elif key == "private_ip_address":
            address = _address(value)
            if address is not None:
                out[key] = address
        elif key in ("arn", "task_arn", "cluster_arn") and isinstance(value, str):
            match = re.fullmatch(
                r"arn:(aws|aws-cn|aws-us-gov):(ec2|rds|ecs|lambda|elasticloadbalancing|eks):"
                r"([a-z0-9-]+):(\d{12}):[A-Za-z0-9_+=,.@:/-]{1,512}", value)
            # Keep code-level identities until correlation; the specialist
            # prompt boundary scrubs source strings before every model call.
            out[key] = value if match and match[3] == region and match[4] == account else _text(value)
        elif isinstance(value, (bool, int, float)) and (isinstance(value, bool) or _number(value) is not None):
            out[key] = value
        elif isinstance(value, str):
            out[key] = _text(value)
    return out


def _resource(bundle, account, region, kind, native_id, facts):
    # Reports are single-account, so the digest omits the account (not enumerable from ids).
    rid = _id("r", region, kind, native_id)
    existing = next((r for r in bundle["resources"] if r["id"] == rid), None)
    if existing:
        return existing
    if len(bundle["resources"]) >= MAX_RESOURCES:
        _mark(bundle, "incomplete", "resource_cap")
        return None
    item = {"id": rid, "account": account, "region": region, "kind": kind,
            "resource_id": native_id, "facts": facts}
    bundle["resources"].append(item)
    return item


def _evidence(bundle, source, kind, resources, facts, captured, *, region, fresh,
              window=None, coverage=None):
    item = {"id": _id("e", source, kind, resources, facts, captured),
            "source": source, "kind": kind, "account": bundle["coverage"]["account"],
            "region": region, "resource_ids": resources, "facts": facts,
            "captured_at": _iso(captured), "window": window or {},
            "coverage": coverage or {}, "fresh": bool(fresh)}
    existing = next((e for e in bundle["evidence"] if e["id"] == item["id"]), None)
    if existing is not None:
        # Follow-up can discover partial/stale provenance for the same stored
        # facts. Replace its qualification instead of preserving old freshness.
        existing.clear()
        existing.update(item)
    else:
        if len(bundle["evidence"]) >= MAX_EVIDENCE:
            _mark(bundle, "incomplete", "evidence_cap")
            return None
        bundle["evidence"].append(item)
    return item


def _relationship(bundle, source, target, kind, item):
    if item is None:
        return
    rid = _id("edge", source, target, kind, item["id"])
    if any(r["id"] == rid for r in bundle["relationships"]):
        return
    counts = bundle["coverage"].setdefault("relationships", {})
    counts["matched"] = counts.get("matched", len(bundle["relationships"])) + 1
    if len(bundle["relationships"]) >= MAX_RELATIONSHIPS:
        _mark(bundle, "incomplete", "relationship_cap")
        return
    bundle["relationships"].append({"id": rid, "source": source, "target": target,
                                    "kind": kind, "evidence_ids": [item["id"]]})


def _read_inventory(conn, bundle, budget, scope):
    if not _available(bundle, budget):
        return
    account = bundle["coverage"]["account"]
    try:
        counts = _db_read(conn, bundle, budget,
            "SELECT count(*), array_agg(DISTINCT region ORDER BY region) "
            "FROM inventory_resources WHERE account_id=:scope", scope=scope)
        total, regions = counts[0] if counts else (0, [])
        regions = sorted({r for r in (regions or []) if isinstance(r, str) and _REGION.fullmatch(r)})
        selected = regions[:MAX_REGIONS]
        bundle["coverage"]["regions"] = {"total": len(regions), "selected": selected,
                                         "omitted": len(regions) - len(selected)}
        if len(regions) > MAX_REGIONS:
            _mark(bundle, "incomplete", "region_cap")
        if not _available(bundle, budget):
            return
        # Projection happens inside SQL, before provider JSON crosses the pg8000
        # boundary. No environment, policy, user-data or credentials are selected.
        rows = _db_read(conn, bundle, budget,
            "WITH seeds AS (SELECT *, row_number() OVER(PARTITION BY resource_type "
            "ORDER BY region,resource_id) AS seed_rank FROM inventory_resources "
            "WHERE account_id=:scope AND region=ANY(:regions)) "
            "SELECT account_id, region, resource_type, resource_id, "
            "(SELECT coalesce(jsonb_object_agg(key,value),'{}'::jsonb) FROM jsonb_each(data) "
            " WHERE key=ANY(:keys)), captured_at FROM seeds "
            "ORDER BY seed_rank,resource_type,region,resource_id LIMIT 201",
            scope=scope, keys=list(_FACT_KEYS), regions=selected)
        # Preserve SQL fairness even for adapters returning an unordered batch.
        groups = {}
        for row in sorted(rows, key=lambda r: (r[2], r[1], r[3])):
            groups.setdefault(row[2], []).append(row)
        rows = [row for i in range(max((len(g) for g in groups.values()), default=0))
                for g in groups.values() if i < len(g) for row in [g[i]]][:MAX_INVENTORY_RESOURCES]
        runs = _db_read(conn, bundle, budget,
            "SELECT resource_type,status,finished_at,last_success_at,row_count,unknown_attribute_count,started_at "
            "FROM inventory_sync_runs WHERE account_id='self' AND resource_type=ANY(:resource_types)",
            resource_types=sorted({r[2] for r in rows}))
        points = _db_read(conn, bundle, budget,
            "SELECT DISTINCT ON(resource_type) resource_type,resource_count,captured_at "
            "FROM inventory_snapshots WHERE account_id=:scope AND resource_type=ANY(:resource_types) "
            "ORDER BY resource_type,captured_at DESC", scope=scope, resource_types=sorted({r[2] for r in rows}))
        scoped_counts = dict(_db_read(conn, bundle, budget,
            "SELECT resource_type,count(*) FROM inventory_resources "
            "WHERE account_id=:scope AND resource_type=ANY(:resource_types) GROUP BY resource_type",
            scope=scope, resource_types=sorted({r[2] for r in rows})))
        run_by_type, point_by_type = {r[0]: r for r in runs}, {r[0]: r for r in points}
        matched, stale = 0, _stale_seconds()
        for storage, region, kind, native_id, data, captured in rows:
            if storage != scope or region not in selected or not isinstance(native_id, str):
                continue
            matched += 1
            r = _resource(bundle, account, region, kind, native_id,
                          _facts(_dict(data), account=account, region=region))
            if r is None:
                continue
            run, point = run_by_type.get(kind), point_by_type.get(kind)
            complete = bool(run and point and len(run) == 7 and run[1] == "succeeded" and run[5] == 0
                            and isinstance(run[4], int) and run[4] >= scoped_counts.get(kind, 0)
                            and point[1] == scoped_counts.get(kind)
                            and _stamp(run[6]) and _stamp(point[2])
                            and _stamp(run[6]) <= _stamp(point[2])
                            and _fresh(run[3], stale) and _fresh(point[2], stale)
                            and _stamp(run[2]) == _stamp(run[3])
                            and _stamp(point[2]) <= _stamp(run[2]))
            fresh = complete and _fresh(captured, stale) and _stamp(captured) >= _stamp(run[6])
            if not fresh:
                _mark(bundle, "incomplete", "inventory_unqualified")
            _evidence(bundle, "inventory", "inventory", [r["id"]], r["facts"], captured,
                      region=region, fresh=fresh, coverage={"complete": complete,
                      "producer_status": run[1] if run else "unknown",
                      "unknown_attributes": run[5] if run else None})
        from .workload_identities import project_tasks
        project_tasks(bundle)
        returned = len(bundle["resources"])
        bundle["coverage"]["inventory"] = {"total": int(total), "matched": matched,
                                           "returned": returned, "omitted": max(0, int(total) - returned)}
        if int(total) > returned:
            _mark(bundle, "incomplete", "inventory_cap")
    except Exception:
        _mark(bundle, "degraded", "inventory_read_failed")


def _graph_state(value, cls):
    state = value or {}
    details = _dict(state.get("details"))
    max_age = max(15, _bounded_int(os.environ.get("GRAPH_REBUILD_INTERVAL_MINS"), 0, 1440) * 2) * 60
    fresh = _fresh(state.get("captured"), max_age)
    complete = state.get("status") in ("ok", "empty")
    fresh = fresh and complete and not any(details.get(k) is True for k in
                ("retainedPrevious", "metadataTruncated", "inputTruncated", "graphTruncated"))
    drops = _number(details.get("instanceObservationDrops")) or 0
    if drops > 0:
        fresh = False
    sources = details.get("sources" if cls == "trace" else "publishedSources")
    projected = []
    if not isinstance(sources, list) or not sources:
        fresh = False
    else:
        for row in sources[:128]:
            if not isinstance(row, dict):
                fresh = False
                continue
            item = {k: row[k] for k in ("sourceId", "status", "producerStatus", "scope", "itemCount",
                    "windowStartMs", "windowEndMs", "capturedAtMs", "lastSuccessAtMs",
                    "attemptedAtMs", "finishedAtMs") if k in row and
                    ((isinstance(row[k], str) and len(row[k]) <= 128) or _number(row[k]) is not None or row[k] is None)}
            reasons = row.get("reasons", [])
            reasons = reasons if isinstance(reasons, list) else [None]
            item["reasons"] = [r for r in reasons if isinstance(r, str) and r in _REASONS][:16]
            projected.append(item)
            # An unknown reason is still a reason: fail closed rather than dropping it.
            if row.get("status") not in ("ok", "empty") or reasons:
                fresh = False
            if cls != "trace" and (row.get("producerStatus") != "succeeded"
                    or not _fresh(row.get("lastSuccessAtMs"), _stale_seconds())
                    or (row.get("itemCount", 0) > 0 and not _fresh(row.get("capturedAtMs"), _stale_seconds()))):
                fresh = False
        if len(sources) > 128:
            fresh = False
    window = {k: details[k] for k in ("windowStartMs", "windowEndMs") if _number(details.get(k)) is not None}
    return fresh, {"status": state.get("status", "unknown"), "complete": fresh,
                   "sources": projected, "retained_previous": details.get("retainedPrevious") is True,
                   "instance_observations_omitted": drops}, window


def _bounded_int(value, default, ceiling, floor=0):
    try:
        number = int(value)
        return number if floor <= number <= ceiling else default
    except (TypeError, ValueError):
        return default


def _node_inventory(meta, resources, account, kind=None, *, scope="self"):
    storage = meta.get("inventoryAccount", meta.get("accountId"))
    if storage not in (scope, account):
        return None
    kind = kind or meta.get("invType")
    matches = [r for r in resources if r["resource_id"] == meta.get("resourceId")
               and r["region"] == meta.get("region") and r["account"] == account
               and (kind is None or r["kind"] == kind)]
    return matches[0] if len(matches) == 1 else None


def _invalidate_graph(bundle, classes, status):
    """Retain prior graph facts as history until this refresh requalifies them.

    Relationships retain their citations; every citation becomes stale before
    IO, so a missing row or failed read cannot preserve an observed connection.
    Other evidence sources have independent collection lifecycles.
    """
    account = bundle["coverage"]["account"]
    retired = set()
    for row in bundle["evidence"]:
        if row.get("source") != "stored_graph" or row.get("account", account) != account:
            continue
        retired.add(row["id"])
        row["fresh"] = False
        row["coverage"] = {**row.get("coverage", {}), "complete": False,
                           "status": status, "retained_previous": True}
    bundle["coverage"]["graph"] = {
        cls: {"status": status, "complete": False, "sources": []} for cls in classes
    }
    return retired


def _read_graph(conn, bundle, budget, scope):
    account = bundle["coverage"]["account"]
    classes = ["flow", "infra", "trace"] if scope == "self" else ["flow", "infra"]
    retired = _invalidate_graph(bundle, classes, "refresh_pending")
    if not _available(bundle, budget):
        return
    try:
        states = _db_read(conn, bundle, budget,
            "SELECT class,status,attempted_at,captured_at,details FROM topology_graph_state "
            "WHERE account_id=:scope AND class=ANY(:classes)", scope=scope, classes=classes)
        by_class = {r[0]: {"status": r[1], "attempted": r[2], "captured": r[3], "details": r[4]} for r in states}
        # The edge's explicit observed pairs are projected separately from raw
        # meta. SQL caps prevent a large source graph from becoming unbounded IO.
        focus_ids = sorted({r["resource_id"] for r in bundle["resources"] if r["account"] == account})
        nodes = _db_read(conn, bundle, budget,
            "WITH RECURSIVE seeds AS (SELECT class,id FROM topology_nodes WHERE "
            "account_id=:scope AND class=ANY(:classes) AND meta->>'resourceId'=ANY(:focus_ids) "
            "AND coalesce(meta->>'inventoryAccount',meta->>'accountId') IN (:scope,:account)), "
            "focused(class,id,depth) AS (SELECT class,id,0 FROM seeds UNION ALL "
            "SELECT f.class,e.neighbor,f.depth+1 FROM focused f CROSS JOIN LATERAL "
            "(SELECT CASE WHEN source=f.id THEN target ELSE source END AS neighbor "
            "FROM topology_edges WHERE account_id=:scope AND class=f.class "
            "AND (source=f.id OR target=f.id) ORDER BY source,target,rel LIMIT 20) e "
            "WHERE f.depth<2), depths AS (SELECT class,id,min(depth) AS depth FROM focused GROUP BY class,id), "
            "ranked AS (SELECT n.*,row_number() OVER(PARTITION BY class "
            "ORDER BY coalesce(d.depth,3),id) AS seed_rank FROM topology_nodes n "
            "LEFT JOIN depths d USING(class,id) WHERE account_id=:scope AND class=ANY(:classes)) "
            "SELECT id,kind,label,(SELECT coalesce(jsonb_object_agg(key,value),'{}'::jsonb) "
            "FROM jsonb_each(meta) WHERE key=ANY(:keys)),captured_at,class "
            "FROM ranked ORDER BY seed_rank,class,id LIMIT 601", scope=scope, account=account,
            classes=classes, keys=list(_NODE_KEYS), focus_ids=focus_ids)
        selected_nodes = [r[5] + "|" + r[0] for r in nodes[:600]]
        bound_nodes = [r[5] + "|" + r[0] for r in nodes[:600]
                       if _node_inventory(_dict(r[3]), bundle["resources"], account, scope=scope)]
        edges = _db_read(conn, bundle, budget,
            "WITH ranked AS (SELECT *,row_number() OVER(PARTITION BY class ORDER BY "
            "CASE WHEN class||'|'||source=ANY(:bound_nodes) OR class||'|'||target=ANY(:bound_nodes) "
            "THEN 0 WHEN class='trace' AND jsonb_typeof(meta->'instance_observations')='array' "
            "AND meta->'instance_observations'!='[]'::jsonb THEN 1 "
            "WHEN class||'|'||source=ANY(:nodes) AND class||'|'||target=ANY(:nodes) "
            "THEN 2 ELSE 3 END,source,target,rel) AS seed_rank FROM topology_edges "
            "WHERE account_id=:scope AND class=ANY(:classes)) "
            "SELECT source,target,rel,confidence,jsonb_build_object("
            "'spanCount',meta->'spanCount','metricCount',meta->'metricCount',"
            "'instance_observations',(SELECT coalesce(jsonb_agg(pair),'[]'::jsonb) FROM "
            "(SELECT pair FROM jsonb_array_elements(CASE WHEN jsonb_typeof(meta->'instance_observations')='array' "
            "THEN meta->'instance_observations' ELSE '[]'::jsonb END) AS p(pair) LIMIT 200) pairs),"
            "'instance_observations_omitted',meta->'instance_observations_omitted'),captured_at,class "
            "FROM ranked ORDER BY seed_rank,class,source,target,rel LIMIT 401",
            scope=scope, classes=classes, nodes=selected_nodes, bound_nodes=bound_nodes)
        metadata = {(r[5], r[0]): {k: v for k, v in _dict(r[3]).items() if k in _NODE_KEYS
                                 and isinstance(v, str) and len(v) <= 512} for r in nodes[:600]}
        graph_resources = {}
        qualification = {cls: _graph_state(by_class.get(cls), cls) for cls in classes}
        bundle["coverage"]["graph"] = {cls: coverage for cls, (_, coverage, _) in qualification.items()}
        for cls, (fresh, _, _) in qualification.items():
            if not fresh:
                _mark(bundle, "incomplete", f"graph_{cls}_unqualified")
            if qualification[cls][1]["instance_observations_omitted"]:
                _mark(bundle, "incomplete", "instance_observation_cap")
        for node_id, kind, label, _, captured, cls in nodes[:600]:
            meta = metadata[(cls, node_id)]
            inventory_r = _node_inventory(meta, bundle["resources"], account, scope=scope)
            if inventory_r:
                graph_resources[(cls, node_id)] = inventory_r
            elif cls == "trace" and meta.get("accountId") == account and meta.get("region") in bundle["coverage"].get("regions", {}).get("selected", []):
                graph_resources[(cls, node_id)] = _resource(bundle, account, meta["region"], kind, node_id,
                    {k: _text(v) for k, v in meta.items() if k in ("host", "service", "sourceId", "namespace", "deployment")})
        if len(nodes) > 600 or len(edges) > MAX_RELATIONSHIPS:
            _mark(bundle, "incomplete", "graph_cap")
        observation_count = 0
        for source, target, rel, confidence, raw_meta, captured, cls in edges[:MAX_RELATIONSHIPS]:
            fresh, coverage, window = qualification[cls]
            source_r, target_r = graph_resources.get((cls, source)), graph_resources.get((cls, target))
            meta = _dict(raw_meta)
            kind = "observed_call" if cls == "trace" and confidence == "observed" else "configured_dependency"
            if source_r and target_r:
                facts = {"relation": _text(rel), "graph_class": cls}
                for key in ("spanCount", "metricCount"):
                    if _number(meta.get(key)) is not None:
                        facts[key] = meta[key]
                item = _evidence(bundle, "stored_graph", kind, [source_r["id"], target_r["id"]],
                    facts, captured, region=source_r["region"], fresh=fresh and _fresh(captured, 1800),
                    window=window, coverage=coverage)
                _relationship(bundle, source_r["id"], target_r["id"], kind, item)
            observations = meta.get("instance_observations") or []
            if _number(meta.get("instance_observations_omitted")) or (isinstance(observations, list) and len(observations) > 200):
                _mark(bundle, "incomplete", "instance_observation_cap")
            if cls != "trace" or rel != "queries" or not isinstance(observations, list):
                continue
            for pair in observations[:200]:
                observation_count += 1
                if observation_count > MAX_RELATIONSHIPS:
                    _mark(bundle, "incomplete", "instance_observation_cap")
                    break
                if not isinstance(pair, dict):
                    _mark(bundle, "incomplete", "unresolved_instance_observation")
                    continue
                instance = _node_inventory(metadata.get(("infra", pair.get("instance_ref")), {}),
                                           bundle["resources"], account, "ec2", scope=scope)
                database = _node_inventory(metadata.get(("infra", pair.get("database_ref")), {}),
                                           bundle["resources"], account, "rds", scope=scope)
                host = pair.get("db_host")
                target_host = metadata.get((cls, target), {}).get("host")
                observed = _stamp(pair.get("observed_at_ms"))
                start, end = _stamp(window.get("windowStartMs")), _stamp(window.get("windowEndMs"))
                valid = (confidence == "observed" and instance and database and pair.get("account") == account
                    and source_r and target_r and source_r["account"] == target_r["account"] == account
                    and source_r["region"] == target_r["region"] == instance["region"]
                    and pair.get("region") == instance["region"] == database["region"]
                    and pair.get("instance_id") == instance["resource_id"]
                    and _INSTANCE.fullmatch(instance["resource_id"])
                    and isinstance(host, str) and host.lower() == str(database["facts"].get("endpoint_address", "")).lower()
                    and host.lower() == str(target_host or "").lower()
                    and sum(r["kind"] == "rds" and r["account"] == account and r["region"] == pair.get("region")
                        and str(r["facts"].get("endpoint_address", "")).lower() == host.lower()
                        for r in bundle["resources"]) == 1
                    and pair.get("provenance") == "trace_span"
                    and isinstance(pair.get("correlation_id"), str) and 8 <= len(pair["correlation_id"]) <= 128
                    and observed and start and end and start <= observed <= end
                    and isinstance(pair.get("source_id"), str)
                    and any(s.get("sourceId") == pair["source_id"] for s in coverage["sources"]))
                if not valid:
                    _mark(bundle, "incomplete", "unresolved_instance_observation")
                    continue
                facts = {"correlation_id": pair["correlation_id"], "db_host": host,
                         "instance_id": instance["resource_id"], "relation": "queries",
                         "provenance": "trace_span", "source_id": pair["source_id"],
                         "service": _text(metadata.get((cls, source), {}).get("service") or source)}
                inventory_fresh = all(any(e["source"] == "inventory" and e["fresh"] and
                    r["id"] in e["resource_ids"] for e in bundle["evidence"]) for r in (instance, database))
                item = _evidence(bundle, "stored_graph", "observed_call", [instance["id"], database["id"]],
                    facts, pair["observed_at_ms"], region=instance["region"],
                    fresh=fresh and inventory_fresh and _fresh(observed, 1800),
                    window=window, coverage=coverage)
                _relationship(bundle, instance["id"], database["id"], "observed_call", item)
        if any(row["id"] in retired and row["coverage"].get("status") == "refresh_pending"
               for row in bundle["evidence"]):
            _mark(bundle, "incomplete", "graph_retained_history")
    except Exception:
        _invalidate_graph(bundle, classes, "read_failed")
        _mark(bundle, "degraded", "graph_read_failed")
        _mark(bundle, "incomplete", "graph_refresh_failed")


def _pages(client, operation, arguments, bundle, budget, coverage, token_key="NextToken"):
    """Bound paginator pages before each HTTP request and detect repeated tokens."""
    iterator = iter(client.get_paginator(operation).paginate(**arguments))
    tokens = set()
    for _ in range(MAX_PAGES):
        if not _available(bundle, budget):
            coverage["complete"] = False
            return
        config = getattr(client, "_client_config", None)
        if config is not None and budget.remaining(analysis=True) <= config.connect_timeout + config.read_timeout:
            coverage["complete"] = False
            _mark(bundle, "incomplete", "discovery_deadline")
            return
        try:
            page = next(iterator)
        except StopIteration:
            return
        coverage["pages"] = coverage.get("pages", 0) + 1
        yield page
        token = page.get(token_key)
        coverage["continuation"] = bool(token)
        if token in tokens:
            coverage["complete"] = False
            _mark(bundle, "incomplete", "xray_repeated_token" if operation == "get_service_graph" else "metrics_repeated_token")
            return
        if token:
            tokens.add(token)
        else:
            return
    if coverage.get("continuation"):
        coverage["complete"] = False
        _mark(bundle, "incomplete", "xray_page_cap" if operation == "get_service_graph" else "metrics_page_cap")


def _xray(bundle, budget, regions):
    account = bundle["coverage"]["account"]
    bundle["coverage"].setdefault("xray", {})
    for region in regions:
        if not _available(bundle, budget):
            return
        coverage = {"pages": 0, "complete": True, "sampled": True, "continuation": False}
        bundle["coverage"]["xray"][region] = coverage
        end, start = _now(), _now() - dt.timedelta(hours=3)
        services = {}
        try:
            client = _client("xray", region, budget)
            for page in _pages(client, "get_service_graph", {"StartTime": start, "EndTime": end},
                               bundle, budget, coverage):
                for service in (page.get("Services") or [])[:MAX_RESOURCES]:
                    ref = service.get("ReferenceId")
                    if isinstance(ref, int) and len(services) < MAX_RESOURCES:
                        services[ref] = service
                    else:
                        coverage["complete"] = False
                        _mark(bundle, "incomplete", "xray_node_cap")
        except Exception:
            coverage["complete"] = False
            _mark(bundle, "degraded", "xray_read_failed")
        for ref, service in services.items():
            for edge in (service.get("Edges") or [])[:MAX_RELATIONSHIPS]:
                target = edge.get("ReferenceId")
                if not isinstance(target, int):
                    _mark(bundle, "incomplete", "xray_unresolved_target")
                    continue
                source_r = _resource(bundle, account, region, "service", f"xray:{ref}", {"name": _text(service.get("Name"))})
                target_r = _resource(bundle, account, region, "service", f"xray:{target}",
                                     {"name": _text(services.get(target, {}).get("Name"))})
                if not source_r or not target_r:
                    continue
                stats = _dict(edge.get("SummaryStatistics"))
                calls = _number(stats.get("TotalCount"))
                errors = _number(_dict(stats.get("ErrorStatistics")).get("TotalCount"))
                faults = _number(_dict(stats.get("FaultStatistics")).get("TotalCount"))
                facts = {"from_ref": ref, "to_ref": target, "from_name": _text(service.get("Name")),
                         "to_name": _text(services.get(target, {}).get("Name")), "calls": calls,
                         "error_rate": errors / calls if errors is not None and calls else None,
                         "fault_rate": faults / calls if faults is not None and calls else None,
                         "resource_binding": "unresolved"}
                if target not in services:
                    _mark(bundle, "incomplete", "xray_unresolved_target")
                item = _evidence(bundle, "xray", "observed_call", [source_r["id"], target_r["id"]],
                    facts, end, region=region, fresh=True, window={"start": start.isoformat(), "end": end.isoformat()},
                    coverage=dict(coverage))
                _relationship(bundle, source_r["id"], target_r["id"], "observed_call", item)


_METRICS = {
    "ec2": [("CPUUtilization", "p95"), ("CPUUtilization", "Maximum"),
            ("NetworkIn", "Maximum"), ("NetworkOut", "Maximum"),
            ("EBSReadBytes", "Sum"), ("EBSWriteBytes", "Sum")],
    "rds": [("CPUUtilization", "p95"), ("CPUUtilization", "Maximum"),
            ("FreeableMemory", "Minimum"), ("DatabaseConnections", "Maximum"),
            ("ReadIOPS", "Maximum"), ("WriteIOPS", "Maximum"),
            ("ReadLatency", "p95"), ("WriteLatency", "p95"), ("DiskQueueDepth", "Maximum"),
            ("NetworkReceiveThroughput", "Maximum"), ("NetworkTransmitThroughput", "Maximum")],
}
_UNITS = {
    "CPUUtilization": "Percent", "FreeableMemory": "Bytes",
    "NetworkIn": "Bytes", "NetworkOut": "Bytes",
    "EBSReadBytes": "Bytes", "EBSWriteBytes": "Bytes",
    "DatabaseConnections": "Count", "DiskQueueDepth": "Count",
    "ReadIOPS": "Count/Second", "WriteIOPS": "Count/Second",
    "ReadLatency": "Seconds", "WriteLatency": "Seconds", "ReplicaLag": "Seconds",
    "NetworkReceiveThroughput": "Bytes/Second", "NetworkTransmitThroughput": "Bytes/Second",
}


def _summary(values):
    return {"min": min(values), "max": max(values), "mean": sum(values) / len(values), "samples": len(values)}


def _metrics(bundle, budget, resources, *, client_factory=None):
    for region in sorted({r["region"] for r in resources}):
        scoped = [r for r in resources if r["region"] == region and r["kind"] in _METRICS]
        for offset in range(0, len(scoped), 8):  # <=88 query IDs, <=29,568 hourly datapoints/page
            if not _available(bundle, budget):
                return
            queries, mapping, dimensions = [], {}, {}
            batch = scoped[offset:offset + 8]
            for r in batch:
                native = r["resource_id"] if r["kind"] == "ec2" else r["facts"].get("db_instance_identifier", r["resource_id"])
                if r["kind"] == "ec2" and not _INSTANCE.fullmatch(native):
                    _mark(bundle, "incomplete", "metric_identity_unresolved")
                    continue
                if r["kind"] == "rds" and (not isinstance(native, str) or ":" in native or len(native) > 63):
                    _mark(bundle, "incomplete", "metric_identity_unresolved")
                    continue
                dim = [{"Name": "InstanceId" if r["kind"] == "ec2" else "DBInstanceIdentifier", "Value": native}]
                dimensions[r["id"]] = dim
                for name, statistic in _METRICS[r["kind"]]:
                    qid = f"m{len(queries)}"
                    mapping[qid] = (r["id"], name, statistic)
                    queries.append({"Id": qid, "MetricStat": {"Metric": {
                        "Namespace": "AWS/EC2" if r["kind"] == "ec2" else "AWS/RDS",
                        "MetricName": name, "Dimensions": dim}, "Period": PERIOD, "Stat": statistic},
                        "ReturnData": True})
            if not queries:
                continue
            end = _now()
            start = end - dt.timedelta(days=METRIC_DAYS)
            result, memory = {}, {}
            page_coverage = {"pages": 0, "complete": True}
            try:
                client = (client_factory or _client)("cloudwatch", region, budget)
                for page in _pages(client, "get_metric_data", {"MetricDataQueries": queries, "StartTime": start,
                        "EndTime": end, "MaxDatapoints": 100800}, bundle, budget, page_coverage):
                    for row in page.get("MetricDataResults", []):
                        if row.get("Id") not in mapping:
                            continue
                        dst = result.setdefault(row["Id"], {"samples": {}, "statuses": []})
                        dst["statuses"].append(row.get("StatusCode", "unknown"))
                        for timestamp, value in zip(row.get("Timestamps", []), row.get("Values", [])):
                            timestamp = _stamp(timestamp)
                            if timestamp and start <= timestamp < end and _number(value) is not None:
                                dst["samples"][timestamp.isoformat()] = value
            except Exception:
                page_coverage["complete"] = False
                _mark(bundle, "degraded", "metrics_read_failed")
            else:
                from .memory_metrics import collect as collect_memory
                memory = collect_memory(client, batch, start, end, budget)
            for r in batch:
                metrics, ratios, statuses = {}, [], []
                for qid, (rid, name, stat) in mapping.items():
                    if rid != r["id"]:
                        continue
                    row = result.get(qid, {})
                    vals = list(row.get("samples", {}).values())
                    status = row.get("statuses", [])
                    good = bool(status) and all(s == "Complete" for s in status)
                    ratios.append(min(1, len(vals) / (METRIC_DAYS * 24)) if good else 0)
                    statuses.extend(status or ["missing"])
                    metrics.setdefault(name, {})[stat] = {**(_summary(vals) if vals else {"samples": 0}),
                                                          "status": "Complete" if good else "incomplete",
                                                          "unit": _UNITS[name]}
                io_names = ("EBSReadBytes", "EBSWriteBytes") if r["kind"] == "ec2" else ("ReadIOPS", "WriteIOPS")
                missing_io = any(not any(v.get("samples", 0) > 0 and v.get("status") == "Complete"
                                         for v in metrics.get(name, {}).values()) for name in io_names)
                missing_memory = not metrics.get("FreeableMemory", {}).get("Minimum", {}).get("samples")
                if r["kind"] == "ec2":
                    observed = memory.get(r["id"], {})
                    missing_memory = observed.get("complete") is not True
                    if observed.get("metric"):
                        metrics["MemoryUtilization"] = {"Maximum": observed["metric"]}
                        ratios.append(observed["sample_ratio"])
                        statuses.append(observed["metric"]["status"])
                    if missing_memory:
                        _mark(bundle, "gaps", observed.get("reason") or "memory_metric_absent")
                ratio = min(ratios) if ratios else 0
                complete = page_coverage["complete"] and ratio >= 0.9 and all(s == "Complete" for s in statuses)
                if not complete:
                    _mark(bundle, "incomplete", "metrics_partial")
                facts = {"resource_type": r["kind"], "metrics": metrics, "dimensions": dimensions.get(r["id"], []),
                         "window_days": METRIC_DAYS, "missing_memory": bool(missing_memory), "missing_io": missing_io,
                         "multi_az": r["facts"].get("multi_az"), "replica_source": _replica_source(bundle, r)}
                _evidence(bundle, "cloudwatch", "metrics", [r["id"]], facts, end, region=region,
                    fresh=page_coverage["complete"],
                    window={"start": start.isoformat(), "end": end.isoformat()},
                    coverage={**page_coverage, "complete": complete, "lookback_days": METRIC_DAYS, "sample_ratio": ratio})


def _arn(r):
    arn = r["facts"].get("arn")
    service, suffix = ("ec2", "instance/" + r["resource_id"]) if r["kind"] == "ec2" else ("rds", "db:" + r["resource_id"])
    if not arn and not r["resource_id"].startswith("arn:"):
        arn = f"arn:aws:{service}:{r['region']}:{r['account']}:{suffix}"
    if not arn:
        arn = r["resource_id"]
    match = re.fullmatch(r"arn:(aws|aws-cn|aws-us-gov):(ec2|rds):([^:]+):(\d{12}):(.+)", str(arn))
    native_matches = arn == r["resource_id"] if r["resource_id"].startswith("arn:") else bool(match and match[5] == suffix)
    return arn if match and native_matches and match[2] == service and match[3] == r["region"] and match[4] == r["account"] else None


def _replica_source(bundle, r):
    """Replica source from inventory; rows synced before the field existed never imply standalone."""
    if r["kind"] != "rds":
        return None
    key = "read_replica_source_db_instance_identifier"
    if key in r["facts"]:
        return r["facts"][key] or "none"
    _mark(bundle, "gaps", "rds_replica_source_unknown")
    return "unknown"


def _utilization(values):
    return [{"name": _text(v.get("name"), 80), "statistic": _text(v.get("statistic"), 40), "value": v["value"]}
            for v in (values or [])[:30] if isinstance(v, dict) and _number(v.get("value")) is not None
            and isinstance(v.get("name"), str)]


def _provider_row(bundle, r, row, kind):
    is_ec2 = kind == "ec2"
    opts = row.get("recommendationOptions" if is_ec2 else "instanceRecommendationOptions") or []
    ranked = [o for o in opts if isinstance(o, dict) and _number(o.get("rank")) is not None]
    if not ranked:
        _mark(bundle, "incomplete", "provider_option_missing")
        return
    top = min(ranked, key=lambda o: o["rank"])
    savings = top.get("savingsOpportunityAfterDiscounts") or top.get("savingsOpportunity") or {}
    money = _dict(savings).get("estimatedMonthlySavings") or {}
    utilization = _utilization(row.get("utilizationMetrics"))
    names = {re.sub(r"[^a-z0-9]", "", v["name"].lower()) for v in utilization}
    # GPU or Aurora memory-health counters do not measure host memory use.
    memory = "memory" in names
    read_names = {"ebsreadopspersecond", "ebsreadbytespersecond", "diskreadopspersecond",
                  "diskreadbytespersecond", "ebsvolumereadiops", "ebsvolumereadthroughput",
                  "readiops", "volumereadiops", "readiopsephemeralstorage"}
    write_names = {"ebswriteopspersecond", "ebswritebytespersecond", "diskwriteopspersecond",
                   "diskwritebytespersecond", "ebsvolumewriteiops", "ebsvolumewritethroughput",
                   "writeiops", "volumewriteiops", "writeiopsephemeralstorage"}
    io = bool(names & read_names) and bool(names & write_names)
    lookback = _number(row.get("lookBackPeriodInDays" if is_ec2 else "lookbackPeriodInDays"))
    generated = row.get("lastRefreshTimestamp")
    tags = {t.get("key"): t.get("value") for t in row.get("tags", [])
            if isinstance(t, dict) and isinstance(t.get("key"), str) and t["key"].lower() in _TAG_KEYS}
    tags.update(r["facts"].get("tags", {}))
    fresh = _fresh(generated, 24 * 3600)
    guards = guard_hits(tags=tags, lookback_days=lookback, stale=not fresh)
    if lookback is None:
        guards.append("unknown_observation_period")
    replica = _replica_source(bundle, r)
    if replica == "unknown":
        guards.append("replica_source_unknown")
    facts = {"resource_type": kind, "current_type": _text(row.get("currentInstanceType" if is_ec2 else "currentDBInstanceClass")),
             "recommended_type": _text(top.get("instanceType" if is_ec2 else "dbInstanceClass")),
             "finding": _text(row.get("finding" if is_ec2 else "instanceFinding")),
             "rank": top["rank"], "lookback_days": lookback, "generation_time": _iso(generated),
             "performance_risk": top.get("performanceRisk") if _number(top.get("performanceRisk")) is not None else None,
             "monthly_savings": _number(money.get("value")), "currency": _text(money.get("currency"), 3),
             "savings_basis": "after_discounts" if top.get("savingsOpportunityAfterDiscounts") else "on_demand",
             "guard_hits": guards, "missing_memory": not memory, "missing_io": not io,
             "utilization": utilization, "projected_utilization": _utilization(top.get("projectedUtilizationMetrics")),
             "multi_az": r["facts"].get("multi_az"), "replica_source": replica}
    _evidence(bundle, "compute_optimizer", "provider_sizing", [r["id"]], facts, generated,
              region=r["region"], fresh=fresh, coverage={"complete": True, "lookback_days": lookback,
              "sample_ratio": 1 if memory and io and lookback is not None and lookback >= 14 else 0})


def _provider_sizing(bundle, budget, resources, *, client_factory=None):
    if os.environ.get("DIAGNOSIS_EVIDENCE_LOOP_ENABLED") != "true":
        _mark(bundle, "gaps", "provider_sizing_disabled")
        return
    for region in sorted({r["region"] for r in resources}):
        for kind in ("ec2", "rds"):
            selected = [r for r in resources if r["region"] == region and r["kind"] == kind and _arn(r)]
            if not selected or not _available(bundle, budget):
                continue
            try:
                client = (client_factory or _client)("compute-optimizer", region, budget)
                operation = client.get_ec2_instance_recommendations if kind == "ec2" else client.get_rds_database_recommendations
                key = "instanceArns" if kind == "ec2" else "resourceArns"
                rows_key = "instanceRecommendations" if kind == "ec2" else "rdsDBRecommendations"
                # These APIs do not have botocore paginator models. Explicit
                # bounded continuation retains their per-object error channel.
                for offset in range(0, len(selected), 100):
                    by_arn = {_arn(r): r for r in selected[offset:offset + 100]}
                    token, seen = None, set()
                    for page_num in range(MAX_PAGES):
                        if not _available(bundle, budget):
                            break
                        config = getattr(client, "_client_config", None)
                        if config is not None and budget.remaining(analysis=True) <= config.connect_timeout + config.read_timeout:
                            _mark(bundle, "incomplete", "discovery_deadline")
                            break
                        arguments = {key: list(by_arn), "maxResults": 100}
                        if token:
                            arguments["nextToken"] = token
                        page = operation(**arguments)
                        if page.get("errors"):
                            _mark(bundle, "degraded", "provider_object_errors")
                        for row in page.get(rows_key, [])[:MAX_RESOURCES]:
                            arn = row.get("instanceArn" if kind == "ec2" else "resourceArn")
                            r = by_arn.get(arn)
                            if not r or row.get("accountId") != bundle["coverage"]["account"]:
                                _mark(bundle, "incomplete", "provider_scope_mismatch")
                                continue
                            _provider_row(bundle, r, row, kind)
                        token = page.get("nextToken")
                        if not token:
                            break
                        if token in seen:
                            _mark(bundle, "incomplete", "provider_repeated_token")
                            break
                        seen.add(token)
                        if page_num == MAX_PAGES - 1:
                            _mark(bundle, "incomplete", "provider_page_cap")
            except Exception:
                _mark(bundle, "degraded", "provider_sizing_read_failed")


def _finops(conn, bundle, budget):
    if not _available(bundle, budget):
        return
    try:
        rows = _db_read(conn, bundle, budget,
            "SELECT f.id,f.account_id,f.region,f.resource_id,f.rule_id,f.status,"
            "f.monthly_savings_usd,f.evidence,f.guard_hits,f.last_seen_at,r.finished_at,r.status "
            "FROM finops_findings f LEFT JOIN finops_runs r ON r.id=f.run_id "
            "WHERE f.account_id='self' AND f.region=ANY(:regions) "
            "AND f.rule_id IN ('ec2_rightsizing','rds_rightsizing') AND f.status<>'resolved' "
            "ORDER BY f.last_seen_at DESC,f.id LIMIT 201",
            regions=bundle["coverage"].get("regions", {}).get("selected", []))
        if len(rows) > MAX_RESOURCES:
            _mark(bundle, "incomplete", "finops_cap")
        for fid, storage, region, arn, rule, status, amount, raw, guards, captured, finished, run_status in rows[:MAX_RESOURCES]:
            r = next((r for r in bundle["resources"] if r["region"] == region and _arn(r) == arn), None)
            if storage != "self" or r is None:
                _mark(bundle, "incomplete", "finops_scope_unresolved")
                continue
            raw = _dict(raw)
            # The historical engine does not retain provider generation,
            # currency, memory, I/O or full performance-risk coverage. Preserve
            # it as an investigation candidate, never promote it to a safe size.
            facts = {"resource_type": r["kind"], "current_type": _text(raw.get("current_type", raw.get("current_class"))),
                     "recommended_type": _text(raw.get("recommended_type", raw.get("recommended_class"))),
                     "lookback_days": _number(raw.get("lookback_days")), "finding": _text(raw.get("finding")),
                     "performance_risk": _number(raw.get("performance_risk")), "generation_time": None,
                     "monthly_savings": _number(float(amount)) if amount is not None else None, "currency": None,
                     "guard_hits": [g for g in (guards or []) if isinstance(g, str) and len(g) <= 100],
                     "missing_memory": True, "missing_io": True, "rank": None, "status": status,
                     "savings_basis": _text(raw.get("savings_basis")), "provider_provenance": "incomplete"}
            _evidence(bundle, "finops", "provider_sizing", [r["id"]], facts, captured, region=region,
                      fresh=_fresh(captured, 86400) and _fresh(finished, 86400) and run_status == "succeeded",
                      coverage={"complete": False, "lookback_days": facts["lookback_days"], "sample_ratio": 0})
    except Exception:
        _mark(bundle, "degraded", "finops_read_failed")


_EVICTION = {"xray": 0, "stored_graph": 1, "cloudwatch": 3, "compute_optimizer": 3, "finops": 3}


def _finish(bundle):
    # Apply the JSON byte bound after all projections. Removing evidence also
    # removes dependent edges; removing a resource removes its evidence. No
    # dangling citations enter the evidence index.
    original = {k: max(len(bundle[k]), bundle["coverage"].get(k, {}).get("matched", 0))
                for k in ("resources", "evidence", "relationships")}
    while len(json.dumps(bundle, ensure_ascii=False, default=str).encode()) > MAX_BYTES - 512:
        _mark(bundle, "incomplete", "context_byte_cap")
        if bundle["evidence"]:
            # Evict the newest low-priority evidence first (X-Ray, then graph);
            # sizing, metrics and FinOps rows are retained longest.
            rows = bundle["evidence"]
            row = rows.pop(min(range(len(rows)), key=lambda i: (_EVICTION.get(rows[i].get("source"), 2), -i)))
            evicted = bundle["coverage"].setdefault("byte_cap_evicted", {})
            evicted[row.get("source")] = evicted.get(row.get("source"), 0) + 1
            removed = row["id"]
            bundle["relationships"] = [r for r in bundle["relationships"] if removed not in r["evidence_ids"]]
        elif bundle["relationships"]:
            bundle["relationships"].pop()
        elif bundle["resources"]:
            bundle["resources"].pop()
        else:
            break
    for key in original:
        bundle["coverage"][key] = {"matched": original[key], "returned": len(bundle[key]),
                                  "omitted": original[key] - len(bundle[key])}
    bundle["gaps"].sort()
    bundle["degraded"].sort()
    bundle["incomplete"].sort()
    return bundle


def collect(conn, account, budget, *, scope="self"):
    bundle = {"resources": [], "evidence": [], "relationships": [],
              "coverage": {"account": account, "storage_scope": scope},
              "gaps": [], "degraded": [], "incomplete": []}
    # These collectors are deliberately not duplicated from collect_all.
    # Their absence is explicit per pillar rather than a fabricated healthy
    # score. They can gain a bounded projection in a later source adapter.
    bundle["native_sources"] = {key: {"status": "not_collected"} for key in
                               ("cost", "posture", "what_changed", "commitment", "idle", "datasources_obs")}
    for key in bundle["native_sources"]:
        _mark(bundle, "gaps", f"{key}_not_collected")
    if not isinstance(account, str) or not _ACCOUNT.fullmatch(account) or scope not in ("self", account):
        _mark(bundle, "degraded", "invalid_discovery_scope")
        return _finish(bundle)
    host = os.environ.get("DIAGNOSIS_HOST_ACCOUNT_ID")
    if (scope == "self") != (host == account):
        # The host is never read through the member path, and vice versa.
        _mark(bundle, "degraded", "untrusted_host_scope" if scope == "self" else "host_member_scope_rejected")
        return _finish(bundle)
    _read_inventory(conn, bundle, budget, scope)
    _read_graph(conn, bundle, budget, scope)
    resources = [r for r in bundle["resources"] if r["kind"] in _METRICS]
    if scope == "self":
        regions = bundle["coverage"].get("regions", {}).get("selected", [])
        _xray(bundle, budget, regions)
        _metrics(bundle, budget, resources)
        _finops(conn, bundle, budget)
        _provider_sizing(bundle, budget, resources)
    elif bundle["coverage"].get("database_connection_broken"):
        _mark(bundle, "gaps", "member_live_sources_unsupported")
    else:
        try:
            from .scoped_clients import member_factory
            client_factory = member_factory(conn, account, budget)
        except Exception:
            _mark(bundle, "gaps", "member_live_sources_unsupported")
        else:
            _metrics(bundle, budget, resources, client_factory=client_factory)
            _provider_sizing(bundle, budget, resources, client_factory=client_factory)
            _mark(bundle, "gaps", "member_trace_network_sources_unsupported")
    return _finish(bundle)


def follow_up(conn, account, bundle, requests, budget):
    merged = copy.deepcopy(bundle)
    if merged.get("coverage", {}).get("account") != account or not _ACCOUNT.fullmatch(str(account)):
        _mark(merged, "gaps", "follow_up_rejected")
        return _finish(merged)
    scope = merged["coverage"].get("storage_scope")
    if (scope not in ("self", account) or (scope == "self") != (os.environ.get("DIAGNOSIS_HOST_ACCOUNT_ID") == account)
            or merged["coverage"].get("follow_up_passes", 0) >= 1):
        _mark(merged, "gaps", "follow_up_rejected")
        return _finish(merged)
    merged["coverage"]["follow_up_passes"] = 1
    if not isinstance(requests, list) or len(requests) > 4:
        _mark(merged, "gaps", "follow_up_rejected")
        return _finish(merged)
    by_id = {r["id"]: r for r in merged["resources"] if r.get("account") == account}
    seen = set()
    for request in requests:
        if (not isinstance(request, dict) or set(request) != {"capability", "resource_ids"}
                or request["capability"] not in _CAPABILITIES
                or not isinstance(request["resource_ids"], list) or not 1 <= len(request["resource_ids"]) <= 4
                or any(not isinstance(r, str) or r not in by_id for r in request["resource_ids"])):
            _mark(merged, "gaps", "follow_up_rejected")
            continue
        key = (request["capability"], tuple(sorted(set(request["resource_ids"]))))
        if key in seen:
            continue
        seen.add(key)
        resources = [by_id[r] for r in key[1]]
        if key[0] == "graph_refresh":
            _read_graph(conn, merged, budget, scope)
        elif not _available(merged, budget):
            break
        elif scope != "self":
            try:
                from .scoped_clients import member_factory
                factory = member_factory(conn, account, budget)
            except Exception:
                _mark(merged, "gaps", "member_live_sources_unsupported")
                continue
            if key[0] == "resource_metrics":
                _metrics(merged, budget, resources, client_factory=factory)
            else:
                _provider_sizing(merged, budget, resources, client_factory=factory)
        elif key[0] == "resource_metrics":
            _metrics(merged, budget, resources)
        else:
            _provider_sizing(merged, budget, resources)
    return _finish(merged)
