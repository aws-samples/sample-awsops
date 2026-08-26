"""Hybrid LLM fallback for graph_catalog.py — v1 scope: ClickHouse `trace_spans` only, for a schema
that doesn't match the standard OTel-exporter column shape (a renamed/custom span table). Everything
else (standard clickhouse/tempo schemas, prometheus/mimir metric-name matching, loki's structural
unavailability) is answered deterministically by the catalog with zero LLM cost — see
docs/superpowers/specs/2026-07-08-registry-graph-sources-design.md.

`try_generate_clickhouse_trace_spans(schema, integration_id, invoke_connector)` is the entry point,
called by datasource_index.py only when the catalog itself couldn't match. Gated on
GRAPH_QUERYGEN_ENABLED (default unset/false); never raises; returns None on ANY failure at any stage
so the caller falls back to the catalog's `unavailable` row.

Validation pipeline, in order — (a) and (c) are the load-bearing checks; (b) is advisory only:
  (a) static read-only / single-statement guard
  (b) AgentCore Code Interpreter sandbox check (best-effort — skipped entirely, never blocking, when
      no interpreter is provisioned or the call fails for ANY reason)
  (c) a live `LIMIT 1` dry run against the connector, asserting the required output columns appear
A query that survives is cached with `meta.provenance = 'generated'`, keyed to the caller's
schema_version — so it only regenerates when the schema actually drifts, never on every daily run.
"""
import json
import logging
import os
import re

_REQUIRED_ALIASES = ["TraceId", "SpanId", "ParentSpanId", "ServiceName", "Timestamp", "Duration"]

_FORBIDDEN_KEYWORDS = (
    "insert", "update", "delete", "drop", "alter", "create", "truncate", "grant", "revoke",
    "attach", "detach", "rename", "optimize", "system", "kill", "exchange",
)

_PROMPT_TEMPLATE = (
    "You are generating a READ-ONLY ClickHouse SQL SELECT for a distributed-tracing span table. "
    "Table `{table}` has columns: {columns}. Write EXACTLY ONE SELECT statement (no semicolons, no "
    "other statements, no CTEs referencing other tables) that aliases columns to exactly these "
    "output names where a plausible source column exists: TraceId, SpanId, ParentSpanId, "
    "ServiceName, Timestamp, Duration. Add a WHERE clause filtering the time column to the last "
    "{{window}} minutes and end with LIMIT {{cap}} — keep those two placeholders LITERAL (do not "
    "substitute numbers) in your output. Reply with ONLY the SQL statement, no explanation, no "
    "markdown code fences."
)


def _find_candidate_table(schema):
    """Heuristic: a table with a trace-shaped AND span-shaped AND time-shaped column name (case-
    insensitive substring) is a plausible (non-standard) span table worth generating a query for.
    Pure; never raises. Returns {name, columns:[str,...]} or None."""
    tables = (schema or {}).get("tables") or []
    for t in tables:
        if not isinstance(t, dict):
            continue
        cols = [str(c.get("name", "")) for c in (t.get("columns") or []) if isinstance(c, dict)]
        lower = [c.lower() for c in cols]
        has_trace = any("trace" in c for c in lower)
        has_span = any("span" in c for c in lower)
        has_time = any(("time" in c) or c == "ts" or c.endswith("_ts") for c in lower)
        if has_trace and has_span and has_time:
            return {"name": t.get("name"), "columns": cols}
    return None


def _static_readonly_check(sql):
    """(a) Reject anything but a single, literal-placeholder-carrying SELECT. Pure."""
    if not isinstance(sql, str) or not sql.strip():
        return False
    body = sql.strip()
    stripped = body[:-1] if body.endswith(";") else body
    if ";" in stripped:
        return False  # a semicolon anywhere but a single trailing one → multi-statement
    lowered = stripped.lower()
    if not lowered.lstrip().startswith("select"):
        return False
    for kw in _FORBIDDEN_KEYWORDS:
        if re.search(rf"\b{kw}\b", lowered):
            return False
    if "{window}" not in stripped or "{cap}" not in stripped:
        return False  # the runtime placeholders must survive generation literally
    return True


def _bedrock_invoke(prompt):
    """Default Bedrock invoke (Haiku, global inference profile — mirrors insight/generate.py's
    established pattern; bedrock:InvokeModel is already granted to the worker Lambda role via the
    worker_lambda_diagnosis IAM policy, no new grant needed). Lazy boto3 import."""
    import boto3
    region = os.environ.get("AWS_REGION", "ap-northeast-2")
    model = os.environ.get("GRAPH_QUERYGEN_MODEL_ID", "global.anthropic.claude-haiku-4-5-20251001-v1:0")
    body = {"anthropic_version": "bedrock-2023-05-31", "max_tokens": 800,
            "messages": [{"role": "user", "content": prompt}]}
    resp = boto3.client("bedrock-runtime", region_name=region).invoke_model(modelId=model, body=json.dumps(body))
    payload = json.loads(resp["body"].read())
    return "".join(p.get("text", "") for p in payload.get("content", []))


def _generate_sql(candidate, invoke=None):
    """Ask the model for one SELECT statement against `candidate`. `invoke` is injectable (tests
    never call Bedrock for real). May raise — the caller wraps this."""
    invoke = invoke or _bedrock_invoke
    prompt = _PROMPT_TEMPLATE.format(table=candidate["name"], columns=", ".join(candidate["columns"]))
    text = (invoke(prompt) or "").strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text[:4].lower().startswith("sql\n"):
            text = text[4:]
        elif text[:3].lower() == "sql":
            text = text[3:]
    return text.strip()


def _extract_rows(result):
    """Tolerant of a few connector envelope shapes (mirrors trace-source.ts's extractRows)."""
    if isinstance(result, list):
        return result
    if isinstance(result, dict):
        if isinstance(result.get("rows"), list):
            return result["rows"]
        if isinstance(result.get("data"), list):
            return result["data"]
        inner = result.get("result")
        if isinstance(inner, dict) and isinstance(inner.get("rows"), list):
            return inner["rows"]
    return []


def _dry_run_check(sql, integration_id, invoke_connector, required=None):
    """(c) Live LIMIT-1 dry run against the connector; asserts every required alias is a column in
    the returned row. `invoke_connector(args) -> result` is caller-supplied (credential-blind Lambda
    invoke — see datasource_index.py). Never raises; False on any failure (conservative: 0 rows or an
    invoke error can't confirm the shape, so they fail rather than pass)."""
    required = required or _REQUIRED_ALIASES
    dry_sql = sql.replace("{window}", "60").replace("{cap}", "1")
    try:
        result = invoke_connector({"sql": dry_sql, "max_rows": 1, "instance_id": integration_id})
    except Exception:
        return False
    rows = _extract_rows(result)
    if not rows or not isinstance(rows[0], dict):
        return False
    return all(col in rows[0] for col in required)


def _code_interpreter_check(sql, required, ssm_client=None, agentcore_client=None):
    """(b) Best-effort AgentCore Code Interpreter sandbox check — parses the SQL and asserts every
    required alias appears (via `AS <alias>` or a bare reference). Returns True/False when the check
    actually ran, or None to SKIP when no interpreter is provisioned or ANY step fails — this is
    advisory only and must never block the pipeline; (a) and (c) are the checks that actually gate.

    NOTE: the exact bedrock-agentcore Code Interpreter request/response shape used here has not been
    verified against a live-provisioned interpreter (none of the existing v2 worker code calls this
    API yet). Because every failure mode already degrades to a safe skip, an API-shape mismatch in a
    real environment simply means this step never contributes — it does not become unsafe.
    """
    try:
        region = os.environ.get("AWS_REGION", "ap-northeast-2")
        if ssm_client is None:
            import boto3
            ssm_client = boto3.client("ssm", region_name=region)
        project = os.environ.get("PROJECT", "awsops-v2")
        interpreter_id = ssm_client.get_parameter(Name=f"/ops/{project}/agentcore/interpreter_id")["Parameter"]["Value"]
        if not interpreter_id:
            return None
        if agentcore_client is None:
            import boto3
            agentcore_client = boto3.client("bedrock-agentcore", region_name=region)
        session = agentcore_client.start_code_interpreter_session(
            codeInterpreterIdentifier=interpreter_id, sessionTimeoutSeconds=60)
        session_id = session.get("sessionId")
        code = (
            "sql = " + repr(sql) + "\n"
            "required = " + repr(list(required)) + "\n"
            "missing = [r for r in required if r not in sql]\n"
            "print('OK' if not missing else 'MISSING:' + ','.join(missing))\n"
        )
        result = agentcore_client.invoke_code_interpreter(
            codeInterpreterIdentifier=interpreter_id, sessionId=session_id,
            name="executeCode", arguments={"code": code, "language": "python"},
        )
        try:
            agentcore_client.stop_code_interpreter_session(
                codeInterpreterIdentifier=interpreter_id, sessionId=session_id)
        except Exception:  # noqa: BLE001 — cleanup failure must not affect the verdict
            pass
        output = str(result.get("output", result))
        return "OK" in output and "MISSING" not in output
    except Exception as e:  # noqa: BLE001 — advisory only, never blocks
        logging.info("[graph_querygen] code-interpreter check skipped: %s", e)
        return None


def try_generate_clickhouse_trace_spans(schema, integration_id, invoke_connector):
    """Entry point, called from datasource_index.py only when graph_catalog's clickhouse trace_spans
    row is 'unavailable'. Returns a ready row dict (same shape as graph_catalog.build_graph_queries'
    rows, plus `query_key`) on success, or None — never raises."""
    if os.environ.get("GRAPH_QUERYGEN_ENABLED") != "true":
        return None
    try:
        candidate = _find_candidate_table(schema)
        if not candidate:
            return None
        sql = _generate_sql(candidate)
        if not _static_readonly_check(sql):
            return None
        if _code_interpreter_check(sql, _REQUIRED_ALIASES) is False:
            return None
        if not _dry_run_check(sql, integration_id, invoke_connector):
            return None
        return {
            "query_key": "trace_spans", "status": "ready",
            "query": {"tool": "clickhouse_query", "mapper": "otel_v1", "args_template": {"sql": sql}},
            "missing": None, "meta": {"kind": "clickhouse", "provenance": "generated"},
        }
    except Exception as e:  # noqa: BLE001 — never break the catalog-based rebuild
        logging.warning("[graph_querygen] generation failed for integration %s: %s", integration_id, e)
        return None
