"""
Tempo read-only MCP Lambda — TraceQL search + trace fetch + tag discovery against a user-registered
Tempo endpoint. Fourth of the v1 datasource family; uses datasource_http (credential load, SSRF host
guard, auth, no-redirect HTTP).

READ-ONLY by construction. Tempo specifics: start/end are unix SECONDS; multi-tenant via optional
X-Scope-OrgID; trace_id is hex-validated then URL-quoted (path injection defense); the search/trace
responses have NO envelope `status` field → success = HTTP 2xx. Trace payloads can be multi-MB →
bound trace count + per-trace bytes (UTF-8) + ensure_ascii=False. Stdlib + boto3 only.
"""
import base64
import binascii
import json
import re
import time
from http.client import HTTPException
from urllib.parse import quote, urlencode

from cross_account import resolve_tool_name
from datasource_http import (
    NotConnected, SsrfBlocked, assert_host_allowed, auth_headers, health, http_json, load_datasource,
    set_request_conn,
)

SLUG = "tempo"
MAX_TRACES = 50
DEFAULT_SEARCH_LIMIT = 20
MAX_TOTAL_BYTES = 1_000_000  # cap serialized trace payload well under the 6 MB Lambda limit
MAX_SCHEMA_TAGS = 200
MAX_SCHEMA_BYTES = 64_000
MAX_SCHEMA_VALUES = 32
_SCHEMA_WINDOW_S = 3600
_SCHEMA_TIMEOUT_S = 4  # optional buildinfo/type evidence has a shorter deadline
_SCHEMA_NAMES_TIMEOUT_S = 12  # mandatory discovery retains the normal datasource HTTP budget
_SCHEMA_SCOPES = {"span", "resource", "event", "link", "instrumentation"}
# Four lookups maximum, and only for attributes actually returned by the scoped tags API.
_SCHEMA_TYPE_ATTRIBUTES = (
    "span.http.status_code", "span.http.response.status_code",
    "resource.service.name", "span.service.name",
)
_SCHEMA_TYPES = {"string", "int", "float", "bool", "duration", "status", "kind"}
_UNQUOTED_ATTRIBUTE = re.compile(r"[A-Za-z_][A-Za-z0-9_.]*")
_REL = re.compile(r"^(\d+)([smhdw])$")
_UNIT = {"s": 1, "m": 60, "h": 3600, "d": 86400, "w": 604800}
_HEX = re.compile(r"^[0-9a-fA-F]+$")


class _ApiError(Exception):
    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


def _parse_time_s(v, default_delta_s=None):
    """now / '1h'/'30m' (now-delta) / unix-seconds passthrough → unix SECONDS string (integer)."""
    now = int(time.time())
    if v is None:
        return str(now - default_delta_s) if default_delta_s else str(now)
    s = str(v).strip()
    m = _REL.match(s)
    if m:
        return str(now - int(m.group(1)) * _UNIT[m.group(2)])
    return s


def _headers(creds):
    h = dict(auth_headers(creds))
    if creds.get("org_id"):
        h["X-Scope-OrgID"] = str(creds["org_id"])
    return h


def _ds():
    creds = load_datasource(SLUG)
    assert_host_allowed(creds["endpoint"])
    return creds


def _get(creds, path, params=None, *, timeout=None, with_status=False):
    url = creds["endpoint"].rstrip("/") + path + ("?" + urlencode(params, doseq=True) if params else "")
    request_options = {"timeout": timeout} if timeout is not None else {}
    status, data = http_json("GET", url, headers=_headers(creds), **request_options)
    if status >= 400:  # Tempo has no envelope status → HTTP 2xx is success
        detail = (data.get("raw") or data.get("error") or data) if isinstance(data, dict) else "non-object error response"
        raise _ApiError(f"Tempo HTTP {status}: {str(detail)[:300]}", status)
    return (data, status) if with_status else data


def _byte_bound(obj):
    """Serialize; if over the UTF-8 byte budget, return a truncated marker payload."""
    body = json.dumps(obj, default=str, ensure_ascii=False)
    if len(body.encode("utf-8")) <= MAX_TOTAL_BYTES:
        return obj, False
    return {"truncated": True,
            "note": f"trace payload exceeded {MAX_TOTAL_BYTES} bytes; fetch fewer/narrower"}, True


def _proto_integer(value, bits, signed=False):
    if isinstance(value, str) and len(value) <= 20 and re.fullmatch(r"-?(0|[1-9][0-9]*)", value):
        value = int(value)
    return (type(value) is int and (-(1 << (bits - 1)) if signed else 0) <= value
            < (1 << (bits - int(signed))))


_SEARCH_UINT32 = {"inspectedTraces", "totalBlocks", "completedJobs", "totalJobs"}
_SEARCH_UINT64 = {"inspectedBytes", "totalBlockBytes", "inspectedSpans", "backendReads", "backendBytes"}
_SEARCH_FIELDS = _SEARCH_UINT32 | _SEARCH_UINT64 | {"additionalMetrics"}


def _search_metrics_valid(metrics):
    """Validate known counters; unknown version fields are neither errors nor proof."""
    if not isinstance(metrics, dict):
        return False
    for key in _SEARCH_FIELDS:
        if key not in metrics:
            continue
        value = metrics[key]
        if key == "additionalMetrics":
            if not isinstance(value, dict) or not all(
                    isinstance(k, str) and _proto_integer(v, 64, signed=True) for k, v in value.items()):
                return False
        elif not _proto_integer(value, 32 if key in _SEARCH_UINT32 else 64):
            return False
    return True


def _trace_identity(value, size, allow_zero=False):
    if not isinstance(value, str) or not value:
        return None
    if len(value) <= size * 2 and _HEX.fullmatch(value):
        if size == 8 and len(value) != 16:
            return None
        decoded = bytes.fromhex(value.zfill(size * 2))
    else:
        if len(value) != ((size + 2) // 3) * 4:
            return None
        try:
            decoded = base64.b64decode(value, validate=True)
        except (ValueError, binascii.Error):
            return None
        if len(decoded) != size or base64.b64encode(decoded).decode() != value:
            return None
    return decoded if allow_zero or any(decoded) else None

def _valid_trace_span(span, trace_id):
    if (not isinstance(span, dict) or not _trace_identity(span.get("spanId"), 8)
            or not all(_proto_integer(span.get(key), 64) for key in ("startTimeUnixNano", "endTimeUnixNano"))
            or int(span["endTimeUnixNano"]) < int(span["startTimeUnixNano"])
            or ("traceId" in span and _trace_identity(span["traceId"], 16) != trace_id)):
        return False
    if "parentSpanId" in span and span["parentSpanId"] != "" and _trace_identity(span["parentSpanId"], 8, True) is None:
        return False
    if "name" in span and not isinstance(span["name"], str):
        return False
    if "status" in span:
        if not isinstance(span["status"], dict):
            return False
        code = span["status"].get("code", 0)
        if (type(code) not in (int, str)
                or str(code).upper().removeprefix("STATUS_CODE_") not in ("0", "1", "2", "UNSET", "OK", "ERROR")):
            return False
    if "links" in span and (not isinstance(span["links"], list) or any(
            not isinstance(link, dict) or not _trace_identity(link.get("traceId"), 16)
            or not _trace_identity(link.get("spanId"), 8) for link in span["links"])):
        return False
    return True

_TRACE_ATTRIBUTES = {
    "service.name", "service.namespace", "service.version", "cloud.account.id", "cloud.region",
    "deployment.environment.name", "deployment.environment", "k8s.namespace.name",
    "k8s.cluster.name", "k8s.pod.name", "k8s.deployment.name", "db.system", "db.name",
    "server.address", "server.port", "net.peer.name", "net.peer.port", "peer.service",
    "messaging.system", "messaging.destination.name", "messaging.destination",
}


def _json_size(value):
    return len(json.dumps(value, default=str, ensure_ascii=False).encode("utf-8"))


def _trace_attributes(value):
    if not isinstance(value, list):
        return None
    selected = {}
    for entry in value:
        if (not isinstance(entry, dict) or not isinstance(entry.get("key"), str)
                or not entry["key"] or not isinstance(entry.get("value"), dict)):
            return None
        if entry["key"] in _TRACE_ATTRIBUTES:
            selected[entry["key"]] = entry  # Preserve last-value identity semantics, never shorten IDs.
    return list(selected.values())


def _trace_projection(data, requested_trace_id):
    """Over-budget only: retain scoped identities/timing in valid OTLP, never a fake empty."""
    if (not isinstance(data, dict) or "error" in data or data.get("status") == "error"
            or data.get("collectionStatus") == "error"):
        return None
    key = "batches" if "batches" in data else "resourceSpans"
    batches = data.get(key)
    trace_id = _trace_identity(requested_trace_id, 16)
    if not isinstance(batches, list) or trace_id is None:
        return None
    out = {"truncated": True, "projection": "bounded_otlp",
           "note": "Trace payload exceeded byte budget; bounded span projection", key: []}
    used = _json_size(out)
    for batch in batches:
        if not isinstance(batch, dict) or not isinstance(batch.get("resource", {}), dict):
            return None
        resource_attrs = _trace_attributes(batch.get("resource", {}).get("attributes", []))
        scopes = batch.get("scopeSpans", batch.get("instrumentationLibrarySpans"))
        if resource_attrs is None or not isinstance(scopes, list):
            return None
        for scope in scopes:
            if not isinstance(scope, dict) or not isinstance(scope.get("spans"), list):
                return None
            group = {"resource": {"attributes": resource_attrs}, "scopeSpans": [{"spans": []}]}
            group_cost = _json_size(group) + 2
            for span in scope["spans"]:
                # Validate before spending output budget. Never turn malformed
                # fitting spans into apparently usable projected evidence.
                if not _valid_trace_span(span, trace_id):
                    return None
                projected = {field: span[field] for field in (
                    "traceId", "spanId", "parentSpanId", "kind", "startTimeUnixNano", "endTimeUnixNano",
                ) if field in span}
                if "name" in span and _json_size(span["name"]) <= 1024:
                    projected["name"] = span["name"]
                if "status" in span:
                    if not isinstance(span["status"], dict):
                        return None
                    projected["status"] = {k: v for k, v in span["status"].items() if k == "code"}
                span_attrs = _trace_attributes(span.get("attributes", []))
                if span_attrs is None:
                    return None
                projected["attributes"] = span_attrs
                if "links" in span:
                    if not isinstance(span["links"], list) or any(not isinstance(link, dict) for link in span["links"]):
                        return None
                    projected["links"] = [{k: v for k, v in link.items() if k in ("traceId", "spanId")}
                                          for link in span["links"][:64]]
                cost = _json_size(projected) + 2
                if used + group_cost + cost > MAX_TOTAL_BYTES:
                    return out if out[key] else {"truncated": True, "note": "payload omitted at byte limit",
                                                "tracePayloadTruncated": True, "collectionStatus": "partial"}
                if group_cost:
                    out[key].append(group)
                    used += group_cost
                    group_cost = 0
                group["scopeSpans"][0]["spans"].append(projected)
                used += cost
    return out if out[key] else None


def tempo_search(args):
    query = (args.get("query") or "").strip()
    if not query:
        return err("query (TraceQL) required")
    params = {"q": query, "start": _parse_time_s(args.get("start"), 3600), "end": _parse_time_s(args.get("end"))}
    limit = args.get("limit")
    raw_limit = str(DEFAULT_SEARCH_LIMIT if limit is None or limit == "" else limit).strip()
    if len(raw_limit) > 16 or not re.fullmatch(r"[+-]?\d+", raw_limit):
        return err("limit must be an integer")
    try:
        requested = max(1, min(MAX_TRACES, int(raw_limit)))
    except ValueError:
        return err("limit must be an integer")
    params["limit"] = str(requested)
    data, status = _get(_ds(), "/api/search", params, with_status=True)
    if isinstance(data, dict) and (data.get("status") == "error"
            or any(data.get(key) not in (None, "") for key in ("error", "errorType", "exception"))):
        return err("Tempo search returned an error")
    # Tempo HTTPFinal returns 200 after finalization; jsonpb omits default/repeated fields.
    # Require a recognizable message. Bare {} is unverified, not universal API malformation.
    metrics = data.get("metrics") if isinstance(data, dict) else None
    known_metrics = isinstance(metrics, dict) and (not metrics or any(key in metrics for key in _SEARCH_FIELDS))
    recognizable = isinstance(data, dict) and ("traces" in data or known_metrics) and "raw" not in data
    raw = data.get("traces", []) if recognizable else None
    traces = raw[:MAX_TRACES] if isinstance(raw, list) else []
    truncated = isinstance(raw, list) and len(raw) > MAX_TRACES
    valid = (status in (200, 206) and recognizable and isinstance(raw, list)
             and ("metrics" not in data or _search_metrics_valid(metrics))
             and all(isinstance(t, dict) and isinstance(t.get("traceID"), str)
                     and _HEX.fullmatch(t["traceID"]) for t in traces))
    state = "unknown" if not valid else "partial" if status == 206 or truncated or len(raw) >= requested else "ok" if traces else "empty"
    if isinstance(data, dict):
        for key in ("warnings", "partial", "truncated"):
            if key in data:
                value = data[key]
                if not (isinstance(value, list) and all(isinstance(item, str) for item in value)
                        if key == "warnings" else type(value) is bool):
                    state = "unknown"
                elif value and state != "unknown":
                    state = "partial"
    if valid and isinstance(metrics, dict):
        completed, total = int(metrics.get("completedJobs", 0)), int(metrics.get("totalJobs", 0))
        # Counters veto incomplete work when a positive total is reported. Their presence,
        # 0/0, and inspectedBytes do not establish completion: the synchronous API does.
        if total > 0:
            if completed > total:
                state = "unknown"
            elif completed < total and state in ("ok", "empty"):
                state = "partial"
    completion = {"completionReason": "search_response_unverified"} if state == "unknown" else {}
    # Do not echo unconsulted version fields or malformed counter payloads.
    safe_metrics = {key: metrics[key] for key in _SEARCH_FIELDS if key in metrics} if _search_metrics_valid(metrics) else None
    payload, btr = _byte_bound({"traces": traces, "metrics": safe_metrics})
    if btr:
        return ok({**payload, **completion, "collectionStatus": "unknown" if state == "unknown" else "partial"})
    return ok({"truncated": truncated, **payload, **completion, "collectionStatus": state})


def tempo_get_trace(args):
    tid = (args.get("trace_id") or "").strip()
    if not tid or not _HEX.match(tid):
        return err("trace_id must be a hex string")
    data = _get(_ds(), f"/api/traces/{quote(tid, safe='')}")
    if isinstance(data, dict) and (data.get("status") == "error"
            or any(data.get(key) not in (None, "") for key in ("error", "errorType", "exception"))):
        return err("Tempo trace fetch returned an error")
    if not isinstance(data, dict) or "raw" in data:
        return err("Tempo trace response is not a JSON object")
    # These controls belong to this producer, never to the upstream JSON body.
    upstream_truncated = data.get("truncated", False)
    payload = {key: value for key, value in data.items() if key not in {
        "truncated", "collectionStatus", "tracePayloadTruncated", "tracePayloadUnverified",
        "projection", "completionReason", "collectionReason",
    }}
    payload["truncated"] = upstream_truncated is True
    if type(upstream_truncated) is not bool:
        payload["collectionStatus"] = "unknown"
    elif upstream_truncated:
        payload["collectionStatus"] = "partial"
    clean = payload
    payload, btr = _byte_bound(clean)
    if btr:
        projected = _trace_projection(clean, tid)
        return ok(projected if projected is not None else {
            "truncated": True, "tracePayloadUnverified": True, "collectionStatus": "unknown",
            "note": "unverified trace omitted",
        })
    return ok(payload)


def tempo_search_tags(args):
    data = _get(_ds(), "/api/search/tags")
    return ok(data if isinstance(data, dict) else {"tags": data})


def tempo_tag_values(args):
    tag = (args.get("tag") or "").strip()
    if not tag:
        return err("tag required")
    scope, separator, key = tag.partition(".")
    qualified = bool(separator) and scope in _SCHEMA_SCOPES | {""}
    raw_key = tag
    if qualified:
        # Schema identifiers quote the whole raw key. Decode exactly one JSON
        # string, never split inside it or URL-decode literal percent escapes.
        if key.startswith('"'):
            try:
                raw_key = json.loads(key)
            except ValueError:
                return err("invalid quoted tag identifier")
        elif _UNQUOTED_ATTRIBUTE.fullmatch(key):
            raw_key = key
        else:
            return err("invalid tag identifier")
        if _schema_identifier(raw_key, "") is None:
            return err("invalid tag identifier")
    creds = _ds()
    if qualified:
        try:
            data = _get(creds, f"/api/v2/search/tag/{quote(tag, safe='')}/values")
        except _ApiError as exc:
            if exc.status not in (404, 405, 501):
                raise
            # V1 cannot express scope; preserve only the actual raw key.
            data = _get(creds, f"/api/search/tag/{quote(raw_key, safe='')}/values")
    else:
        data = _get(creds, f"/api/search/tag/{quote(tag, safe='')}/values")
    return ok(data if isinstance(data, dict) else {"values": data})


def _schema_identifier(tag, scope):
    """Tag APIs return raw keys: preserve them, quoting unsafe names as TraceQL strings."""
    if not isinstance(tag, str) or not tag or len(tag) > 1024:
        return None
    try:
        if len(tag.encode("utf-8")) > 1024:
            return None
    except UnicodeEncodeError:
        return None
    if any(ord(c) < 32 or ord(c) == 127 for c in tag):
        return None
    # Scope keywords are lexer tokens even inside attribute keys; quoting preserves the raw key.
    reserved = tag.partition(".")[0] in _SCHEMA_SCOPES | {"parent", "trace"}
    name = tag if _UNQUOTED_ATTRIBUTE.fullmatch(tag) and not reserved else json.dumps(tag, ensure_ascii=False)
    return f"{scope}.{name}"  # empty legacy scope intentionally produces a leading dot


def _schema_attributes(data, scoped):
    """Normalize a bounded subset; malformed/omitted entries never acquire invented scopes."""
    truncated = isinstance(data, dict) and data.get("truncated") is True
    if scoped:
        scopes = (data.get("scopes") if isinstance(data, dict)
                  and "raw" not in data and "tagNames" not in data else None)
    else:
        tags = data.get("tagNames") if isinstance(data, dict) and "raw" not in data else None
        scopes = [{"name": "", "tags": tags}]
    if not isinstance(scopes, list):
        return {}, {}, True

    attributes, raw_names = {}, {}
    allowed_scopes = _SCHEMA_SCOPES if scoped else {""}
    # Builtins are supplied by the prompt. Ignore the entire intrinsic scope,
    # including future names, without consuming the custom-name budget or
    # suggesting that custom attributes were omitted.
    if scoped:
        scopes = [scope for scope in scopes
                  if not isinstance(scope, dict) or scope.get("name") != "intrinsic"]
    # Also bound malformed/duplicate custom scope envelopes locally.
    truncated |= len(scopes) > 16
    for scope in scopes[:16]:
        if not isinstance(scope, dict):
            truncated = True
            continue
        name, tags = scope.get("name"), scope.get("tags")
        if not isinstance(name, str) or name not in allowed_scopes or not isinstance(tags, list):
            truncated = True
            continue
        # Ask for one extra name to distinguish a full schema from the local 200-name cap.
        truncated |= len(tags) >= MAX_SCHEMA_TAGS + 1
        for tag in tags[:MAX_SCHEMA_TAGS + 1]:
            identifier = _schema_identifier(tag, name)
            if identifier is None:
                truncated = True
                continue
            if identifier in attributes:
                continue
            if len(attributes) >= MAX_SCHEMA_TAGS:
                truncated = True
                if identifier not in _SCHEMA_TYPE_ATTRIBUTES:
                    continue
                # A large earlier scope must not crowd out observed HTTP/service candidates.
                victim = next(key for key in reversed(attributes) if key not in _SCHEMA_TYPE_ATTRIBUTES)
                del attributes[victim]
                del raw_names[victim]
            attributes[identifier] = {"name": identifier}
            raw_names[identifier] = tag
    return attributes, raw_names, truncated


def _schema_observed_types(creds, attributes, window):
    """Retain only explicit Tempo types; never return, cache or infer from sample values."""
    truncated = False
    for identifier in _SCHEMA_TYPE_ATTRIBUTES:
        if identifier not in attributes:
            continue
        try:
            # Do not request maxStaleValues here: it can stop before another type
            # appears while still returning fewer than MAX_SCHEMA_VALUES values.
            # The omitted threshold defaults to zero (disabled) in Tempo; the
            # value limit and short HTTP deadline still bound this observation.
            data = _get(creds, f"/api/v2/search/tag/{quote(identifier, safe='')}/values",
                        {**window, "limit": MAX_SCHEMA_VALUES},
                        timeout=_SCHEMA_TIMEOUT_S)
        except (_ApiError, OSError, HTTPException, SsrfBlocked):
            continue  # optional type evidence; the names remain useful on older/unavailable endpoints
        values = data.get("tagValues", []) if isinstance(data, dict) else None
        if not isinstance(values, list):
            continue
        # A full sample can hide another type beyond the limit. Preserve this per
        # attribute so the prompt renderer does not present the observed type as
        # definitive, or confuse a type-sample limit with omitted attribute names.
        types_truncated = len(values) >= MAX_SCHEMA_VALUES or data.get("truncated") is True
        truncated |= types_truncated
        types = {
            item["type"] for item in values[:MAX_SCHEMA_VALUES]
            if isinstance(item, dict) and isinstance(item.get("type"), str) and item["type"] in _SCHEMA_TYPES
        }
        if types:
            attributes[identifier]["types"] = sorted(types)
            attributes[identifier]["types_truncated"] = types_truncated
    return truncated


def tempo_schema(args):
    """Bounded schema observations, not an exhaustive catalog.

    API shapes/limits: https://grafana.com/docs/tempo/latest/api_docs/
    V2 has scopes[{name,tags}] and tagValues[{type,value}]. V1 names have no scope/type
    evidence. Its virtual intrinsics are injected only for scope=intrinsic, which
    we never request; do not map raw names to builtins based on their spelling.
    Verified: grafana/tempo v2.9.0 modules/frontend/tag_handlers.go (newTagsHTTPHandler).
    All network reads retain the existing credential/SSRF/auth guarded _get.
    """
    creds = _ds()
    end = int(time.time())
    window = {"start": str(end - _SCHEMA_WINDOW_S), "end": str(end)}
    try:  # best-effort server version for version-aware TraceQL
        bi = _get(creds, "/api/status/buildinfo", timeout=_SCHEMA_TIMEOUT_S)
        version = bi.get("version") if isinstance(bi, dict) else None
        if not isinstance(version, str) or len(version) > 128 or _schema_identifier(version, "") is None:
            version = None
    except (_ApiError, OSError, HTTPException, SsrfBlocked):
        version = None
    # Omitted maxStaleValues defaults to zero (disabled). A stale-name threshold
    # could hide later names below the count cap without any truncation signal.
    params = {**window, "limit": MAX_SCHEMA_TAGS + 1}
    scoped = True
    try:
        data = _get(creds, "/api/v2/search/tags", params, timeout=_SCHEMA_NAMES_TIMEOUT_S)
    except _ApiError as exc:
        if exc.status not in (404, 405, 501):
            raise
        scoped = False
        data = _get(creds, "/api/search/tags", params, timeout=_SCHEMA_NAMES_TIMEOUT_S)
    attributes, raw_names, names_truncated = _schema_attributes(data, scoped)
    types_truncated = _schema_observed_types(creds, attributes, window) if scoped else False
    body = {
        "version": version, "tags": [], "attributes": list(attributes.values()),
        "names_truncated": names_truncated, "types_truncated": types_truncated,
        "truncated": names_truncated or types_truncated,  # compatibility with older consumers
    }
    while True:
        body["tags"] = list(dict.fromkeys(raw_names[attr["name"]] for attr in body["attributes"]))
        if len(json.dumps(body, ensure_ascii=False).encode("utf-8")) <= MAX_SCHEMA_BYTES:
            return ok(body)
        # Retain the four important attributes through the byte cap as well as the count cap.
        index = next(i for i in range(len(body["attributes"]) - 1, -1, -1)
                     if body["attributes"][i]["name"] not in _SCHEMA_TYPE_ATTRIBUTES)
        body["attributes"].pop(index)
        body["names_truncated"] = True
        body["truncated"] = True


_TOOLS = {
    "tempo_search": tempo_search, "tempo_get_trace": tempo_get_trace,
    "tempo_search_tags": tempo_search_tags, "tempo_tag_values": tempo_tag_values, "tempo_schema": tempo_schema,
}


def tempo_health(args):
    """Connectivity probe for the pre-save Test / status badge: GET /ready."""
    return ok(health(load_datasource(SLUG), "/ready"))


_TOOLS["tempo_health"] = tempo_health


def lambda_handler(event, context):
    params = event if isinstance(event, dict) else json.loads(event)
    t = resolve_tool_name(params, context)
    args = params.get("arguments", params)
    inst = args.get("instance_id") if isinstance(args, dict) else None
    conn = params.get("conn_config")
    if isinstance(args, dict):
        args.pop("target_account_id", None)
        args.pop("instance_id", None)        # routing arg, not a tool arg
    try:
        # BFF inline conn (trusted) > per-instance secret (credential-blind worker) > kind-mirror default.
        if conn:
            set_request_conn(conn)
        elif inst is not None:
            set_request_conn(load_datasource(SLUG, instance_id=inst))
        else:
            set_request_conn(None)
        fn = _TOOLS.get(t)
        if fn is None:
            return err(f"unknown tool: {t}")
        return fn(args)
    except (NotConnected, SsrfBlocked, _ApiError) as e:
        return err(str(e))
    except Exception as e:  # noqa: BLE001
        return err(f"tempo error: {e}")
    finally:
        set_request_conn(None)  # guaranteed reset — no warm-container bleed


def ok(body):
    return {"statusCode": 200, "body": json.dumps(body, default=str, ensure_ascii=False)}


def err(msg):
    return {"statusCode": 400, "body": json.dumps({"error": msg, "collectionStatus": "error"})}
