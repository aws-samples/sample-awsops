"""datasource_index worker job — (re)build pre-computed diagnostic signals AND pre-built
topology-graph queries for ONE datasource.

Reads the instance's CACHED introspected schema (datasource_schemas — normally written by the BFF's
warm/refresh path), attempts a LIVE re-introspection via the connector's `{kind}_schema` tool (drift
detection — docs/superpowers/specs/2026-07-08-registry-graph-sources-design.md), and rebuilds two
independent tables, each gated on its OWN schema-version hash so a rebuild only happens when something
actually changed:
  - datasource_diag_signals (diagnosis/signal_catalog.py) — prometheus/mimir/loki/tempo deterministic,
    clickhouse via the flag-gated LLM fallback only; jaeger/dynatrace/datadog are NOT wired
    (DIAG_SIGNAL_KINDS, the daily dispatcher's _LIST_SQL and ds_connector_arns are all 5-kind).
    Per-kind catalog + LLM hybrid fallback when a kind's catalog has zero ready matches.
  - datasource_graph_queries (graph_catalog.py) — ALL 5 connector kinds (capability-driven: only
    clickhouse/tempo get span queries, prometheus/mimir get them only with a service-graph metric,
    loki is structurally unavailable — see graph_catalog.py).
Idempotent, bounded, never raises — a bad instance never sinks the dispatcher. Live re-introspection
failing (endpoint down, timeout, bad response) falls back to the cached schema; it never blocks the
rebuild, it only means drift can't be detected on this run.
"""
import hashlib
import json
import logging
import os
import re

import boto3

try:  # fargate/tests: package path; lambda worker zip flattens it to signal_catalog.py
    from diagnosis import signal_catalog as _cat
except ImportError:
    import signal_catalog as _cat  # flattened in the worker_src lambda bundle

import graph_catalog as _graph_cat  # always flat next to this file — never under a package
import card_catalog as _card_cat    # dashboard cards — flat, same packaging contract as graph_catalog
import graph_querygen as _querygen  # hybrid LLM fallback (v1 scope: clickhouse trace_spans only)
from datetime import datetime, timezone

try:  # fargate/tests: package path; lambda worker zip flattens it to signal_catalog_gen.py
    from diagnosis import signal_catalog_gen as _signal_gen
except ImportError:
    import signal_catalog_gen as _signal_gen  # flattened in the worker_src lambda bundle


def _read_cached_schema(conn, integration_id):
    """(kind, schema_dict) from the most-recent cached row, preferring this account then 'self'.
    Returns (None, None) when no cache row exists (connector never succeeded / not refreshed yet)."""
    acct = os.environ.get("HOST_ACCOUNT_ID") or os.environ.get("AWS_ACCOUNT_ID") or "self"
    rows = conn.run(
        "SELECT kind, schema FROM datasource_schemas WHERE account_id IN (:acct, 'self') AND integration_id=:iid "
        "ORDER BY (account_id = :acct) DESC, fetched_at DESC LIMIT 1",
        acct=acct, iid=integration_id)
    if not rows:
        # Account-scope miss → fall back to integration_id alone (mirrors sources.py:_ds_schema). This
        # is safe ONLY because `integrations` is single-account (one integration_id = one instance), and
        # it prevents a BFF/worker HOST_ACCOUNT_ID mismatch from blanking the build (signals never built).
        rows = conn.run(
            "SELECT kind, schema FROM datasource_schemas WHERE integration_id=:iid "
            "ORDER BY fetched_at DESC LIMIT 1",
            iid=integration_id)
        if rows:
            logging.warning("[datasource_index] integration %s schema not under (%r,'self') — using "
                            "integration_id fallback (BFF/worker account-key mismatch)", integration_id, acct)
    if not rows:
        return None, None
    kind, schema = rows[0][0], rows[0][1]
    if isinstance(schema, str):
        try:
            schema = json.loads(schema)
        except (ValueError, TypeError):
            schema = None
    return kind, (schema if isinstance(schema, dict) else None)


def _lambda_invoke(kind, tool, arguments=None):
    """Credential-blind connector invoke (same shape as diagnosis/sources.py:_invoke_connector),
    duplicated locally because this is a LAMBDA-runtime handler whose zip only bundles this file +
    signal_catalog.py + graph_catalog.py + graph_querygen.py (see workers.tf's archive_file), not the
    full diagnosis package. Raises on failure (FunctionError, non-2xx statusCode) — callers decide
    how to handle it; never returns an error envelope as if it were a schema."""
    region = os.environ.get("AWS_REGION", "ap-northeast-2")
    project = os.environ.get("PROJECT", "awsops-v2")
    client = boto3.client("lambda", region_name=region)
    req = json.dumps({"tool_name": tool, "arguments": arguments or {}}).encode("utf-8")
    resp = client.invoke(FunctionName=f"{project}-agent-{kind}-mcp", Payload=req)
    if resp.get("FunctionError"):
        raise RuntimeError(f"{kind}-mcp {tool} invoke FunctionError: {resp['FunctionError']}")
    raw = resp["Payload"].read()
    out = json.loads(raw) if raw else {}
    status = out.get("statusCode")
    if isinstance(status, int) and status >= 400:
        raise RuntimeError(f"{kind}-mcp {tool} returned statusCode {status}")
    body = out.get("body")
    if isinstance(body, str):
        body = json.loads(body)
    return body


# Minimal expected-shape key per connector kind (mirrors the spec's cached-schema shapes) — a
# connector error envelope (e.g. {"error": "..."}) has none of these, so it can never be mistaken
# for a real schema even if `_lambda_invoke` ever let one through undetected.
_SCHEMA_SHAPE_KEY = {
    "clickhouse": "tables", "tempo": "tags", "prometheus": "metrics",
    "mimir": "metrics", "loki": "labels",
}


def _looks_like_schema(kind, body):
    if not isinstance(body, dict):
        return False
    key = _SCHEMA_SHAPE_KEY.get(kind)
    return isinstance(body.get(key), list) if key else True


def _reintrospect(kind, integration_id):
    """Live schema fetch via the `{kind}_schema` tool. Returns the schema dict on success, or None on
    ANY failure OR a response that doesn't look like a real schema (never raises) — the caller falls
    back to the cached schema."""
    try:
        args = {"instance_id": integration_id}
        if kind in ("prometheus", "mimir"):
            # The connector's bulk name list is alphabetically capped at 500 — on real instances the
            # card-required names are capped out, leaving every prom/mimir card permanently
            # "unknown". Naming them here makes the connector probe each one individually, so the
            # returned schema carries definitive presence (merged into `metrics`) / absence
            # (listed in `probed`) for exactly the names card_catalog matches on.
            args["probe_metrics"] = _card_cat.required_metrics()
        body = _lambda_invoke(kind, f"{kind}_schema", args)
        return body if _looks_like_schema(kind, body) else None
    except Exception:  # noqa: BLE001 — a flaky/down connector must never block the daily rebuild
        return None


def _canon(v):
    """Order-insensitive canonical form of a schema value, for HASHING ONLY (never stored, never
    handed downstream).

    json.dumps(..., sort_keys=True) sorts dict KEYS but not list ELEMENTS, and every list the
    connectors' `{kind}_schema` tools return is an unordered SET in practice — prometheus/mimir
    `metrics`/`labels`, loki `labels`, tempo `tags`, clickhouse `tables` and their `columns` are all
    consumed as set comprehensions or name lookups (signal_catalog._missing_for, graph_catalog,
    signal_catalog_gen._vocab_names), never positionally. So two live introspections returning the
    SAME content in a different order hashed differently, read as "the schema changed", and bought a
    full rebuild plus — for the LLM-fallback kinds — a fresh weekly-budget Bedrock call for zero
    actual change (review MAJOR-5).

    Recursive and shape-blind on purpose: sorting a hand-listed set of known list fields would let
    the next list-valued field a connector adds reintroduce this silently. Sorted by each element's
    OWN canonical JSON, because clickhouse `tables` elements are dicts and dicts are not orderable.
    """
    if isinstance(v, dict):
        return {k: _canon(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return sorted((_canon(x) for x in v),
                      key=lambda e: json.dumps(e, sort_keys=True, separators=(",", ":")))
    return v


def _schema_version(schema):
    """Stable cross-process hash of the FULL schema (all kinds' catalog entries key off different
    parts of it — labels/tables/tags, not just metric names) + signal_catalog.CATALOG_VERSION + the
    DIAG_SIGNAL_QUERYGEN_ENABLED flag's on/off state. Mirrors _graph_schema_version's reasoning: the flag is
    mixed in so flipping it — with the schema itself unchanged — still changes
    the version and forces a rebuild; otherwise an instance first indexed while the flag was off
    (catalog matched zero ready rows, LLM fallback skipped) would stay permanently stuck with zero
    ready signals even after the flag turns on, since nothing about the schema itself would ever
    drift again. NOT salted hash()."""
    # EXACTLY ONE flag: DIAG_SIGNAL_QUERYGEN_ENABLED gates THIS pipeline's fallback. Mixing only the graph
    # flag meant turning the new one on left every already-indexed instance's version unchanged → skip → the
    # fallback never ran for the instances it was added for (review). Mixing BOTH then rebuilt signals
    # whenever a graph-only feature was toggled (review MINOR) — dropping the graph flag is safe because
    # CATALOG_VERSION v4 already invalidates every stored hash once.
    flag = "1" if os.environ.get("DIAG_SIGNAL_QUERYGEN_ENABLED") == "true" else "0"
    basis = (json.dumps(_canon(schema), sort_keys=True, separators=(",", ":")) + "|" + _cat.CATALOG_VERSION
             + "|dsquerygen=" + flag)
    return hashlib.sha256(basis.encode("utf-8")).hexdigest()[:16]


def _graph_schema_version(schema):
    """Stable cross-process hash of the FULL schema (graph queries key off tables too, not just
    metric names — e.g. clickhouse) + graph_catalog.CATALOG_VERSION + the querygen flag's on/off
    state. The flag is mixed in so flipping GRAPH_QUERYGEN_ENABLED — with the schema itself
    unchanged — still changes the version and forces a rebuild; otherwise a schema cached while the
    flag was off (catalog 'unavailable', hybrid fallback skipped) stays permanently skipped after the
    flag turns on, since nothing about the schema itself would ever drift again."""
    flag = "1" if os.environ.get("GRAPH_QUERYGEN_ENABLED") == "true" else "0"
    basis = (json.dumps(_canon(schema), sort_keys=True, separators=(",", ":")) + "|" + _graph_cat.CATALOG_VERSION
             + "|querygen=" + flag)
    return hashlib.sha256(basis.encode("utf-8")).hexdigest()[:16]


def _card_schema_version(schema):
    """Stable cross-process hash of the FULL schema + card_catalog.CARD_CATALOG_VERSION. No feature
    flag is mixed in — cards are deterministic-only (no LLM/generation mode to toggle), so only a
    schema drift or a catalog edit should force a rebuild."""
    basis = (json.dumps(_canon(schema), sort_keys=True, separators=(",", ":"))
             + "|" + _card_cat.CARD_CATALOG_VERSION)
    return hashlib.sha256(basis.encode("utf-8")).hexdigest()[:16]


def _rebuild_dashboard_cards(conn, wdb, iid, kind, schema):
    """Third pre-built family (dashboard cards) — mirrors _rebuild_graph_queries: schema-hash skip,
    atomic upsert+sweep. Deterministic only; an empty build writes the version sentinel (db.py)."""
    version = _card_schema_version(schema)
    if wdb.read_card_schema_version(conn, iid) == version:
        return {"cards_skipped": True}
    rows = _card_cat.build_cards(kind, schema)
    conn.run("BEGIN")
    try:
        written = wdb.upsert_dashboard_cards(conn, iid, rows, version)
        wdb.sweep_dashboard_cards(conn, iid, written)
        conn.run("COMMIT")
    except Exception:
        conn.run("ROLLBACK")
        raise
    return {"cards_built": len(rows), "cards_ready": sum(1 for r in rows if r["status"] == "ready")}


_MAX_GENERATION_ATTEMPTS = 3   # TOTAL tries per schema_version PER ISO WEEK, retries included


def _iso_week():
    return datetime.now(timezone.utc).strftime("%G%V")


# The stored value is `<hash>` or `<hash>:<state><attempts>w<isoweek>[s<streak>]`, state ∈ {pend, done, conc}.
# `attempts` = generations spent this week; `streak` = consecutive weeks whose budget was spent without
# producing anything. Four review rounds shaped this grammar, each closing the previous one's hole:
#   * the budget must survive schema churn — the marker is read regardless of which hash prefixes it, or a
#     Prometheus whose metric set moves on every deploy gets a fresh budget daily (MAJOR-3);
#   * a spent budget must not freeze the instance forever — the week rolls and the retry comes back (L4-M3);
#   * a READY/conclusive outcome must not erase the week's usage, or an instance whose catalog match flaps
#     buys 3 more tries per flap (stop-gate);
#   * but "the week rolls" cannot mean retrying forever either: with an unchanged schema that keeps failing,
#     weekly retries are unbounded Bedrock spend (MAJOR-1/-7). After _MAX_SPENT_WEEKS consecutive spent
#     weeks the instance stops until the SCHEMA changes — which is the only new information there is.
# A FIFTH round split the state into three, because one boolean was answering two independent questions
# (review MAJOR, this round): "is this integration settled, and until when" and "how much of THIS ISO week's
# budget is already gone". Conflating them let any ready/DISABLED outcome erase the week's usage — no marker
# was stored, the sweep deleted the row, and the next not-ready rebuild in the SAME week started a fresh
# 3-attempt budget, so a flapping catalog match or a flag toggled off-and-on bought 3 more Bedrock calls per
# flip. `conc` records "conclusively settled for this SCHEMA" while still carrying `attempts`, and — unlike
# `done` — it does NOT expire when the week rolls, which is what keeps the bullet above (a marker whose week
# ages out regenerates an unchanged, already-served schema) fixed rather than traded away.
_MARKER_RE = re.compile(r":(pend|done|conc)(\d+)w(\d{5,8})(?:s(\d+))?$")
_PEND, _DONE, _CONC = "pend", "done", "conc"
_MAX_SPENT_WEEKS = 3


def _marker_state(existing, version):
    """(base_hash, attempts_used_this_week, settled, spent_week_streak).

    Legacy encodings: a plain hash is conclusive and keeps skipping (CATALOG_VERSION v4 retired its
    ambiguous "gave up" meaning), while this branch's earlier `:retryN`, `:retryNw<week>` and `:spent<week>`
    forms read as a fresh, NOT-settled budget — retrying is the safe direction for an unrecognised marker.

    `version` is needed for exactly ONE decision: whether to un-park a streak-capped instance, and it is
    checked ONLY when crossing a WEEK BOUNDARY, never within the same week. That asymmetry is load-bearing,
    not an oversight — two review rounds landed on opposite sides of it:
      * checking the hash WITHIN a week — even scoped to only the same-week `done` branch — means a schema
        that genuinely changes N times in one week grants a fresh 3-try budget N times, i.e. 3N Bedrock
        calls in a single week. "3 per ISO week" (ADR-018 §B-4) is a HARD per-instance ceiling, not a
        per-schema one; a tried-once-this-round fix that un-parked on any same-week hash mismatch broke
        exactly this (review, this round — reverted).
      * NOT checking the hash at the multi-week streak-cap boundary left a genuinely NEW schema, arriving
        after 3 consecutive spent weeks, blocked until the schema-unrelated week rolled over again — the
        earlier review round's fix (kept below). This is safe from the same over-spend risk because it only
        ever grants the SAME weekly renewal that would happen anyway once `streak < _MAX_SPENT_WEEKS` — it
        decides WHETHER a week's normal budget renews, never adds a second budget within one week.
    Within a week, attempts/streak are read regardless of which hash prefixes the marker — that's what
    makes the budget survive ordinary schema churn while actively retrying (review MAJOR-3, three rounds
    ago). A schema that changes mid-week while already exhausted for the week simply waits for the next
    week, same as an unchanged schema would — that is the hard cap working as intended, not a gap.
    """
    m = _MARKER_RE.search(existing or "")
    if not m:
        base, _, marker = (existing or "").partition(":")
        return base, 0, bool(base) and not marker, 0
    state, attempts, week, streak = m.group(1), int(m.group(2)), m.group(3), int(m.group(4) or 0)
    base = existing[:m.start()]
    same_week = week == _iso_week()
    if state == _CONC:
        # Conclusive for this SCHEMA, not merely for this week: settled-ness does not expire when the week
        # rolls (that expiry is exactly what made the daily job re-invoke Bedrock every week on an
        # unchanged, already-served schema), while the ATTEMPT COUNT stays week-scoped like every other
        # state's. That separation is the whole reason a third state exists.
        return base, (attempts if same_week else 0), base == version, streak
    if same_week:
        return base, attempts, state == _DONE, streak
    # A new week. The budget returns, but only while the streak of spent weeks is under the cap; at the cap
    # the instance stays settled UNLESS its schema has genuinely changed, which is the only new information
    # that justifies spending another 3-week budget on it.
    if streak >= _MAX_SPENT_WEEKS:
        if base != version:
            return base, 0, False, 0
        return base, _MAX_GENERATION_ATTEMPTS, True, streak
    return base, 0, False, streak


def _marker(version, attempts, state, streak):
    """The marker string for the grammar _MARKER_RE parses — one source of truth for it.

    This is the CALLER's proposal, not necessarily what ends up stored: on the write path
    db.write_diag_signal_budget re-derives all three of attempts/state/streak from the row's own live
    values, because every one of them is decided before a multi-second Bedrock call and must not be
    regressed by whichever worker happens to finish second (review MAJOR-1, rounds 2 and 3). This
    function still produces the marker verbatim for the byte-for-byte preservation path and for the
    INSERT case, where there is no live row to be monotonic against."""
    tail = f"s{streak}" if streak else ""
    return f"{version}:{state}{attempts}w{_iso_week()}{tail}"


def _keep_last_good_generated(conn, wdb, iid, kind, schema, rows, invoke_connector=None):
    """Carry a previously VERIFIED generated row through a failed re-generation.

    The rebuild is mark-and-sweep: sweep_diag_signals deletes every key not written this time, so a chip
    that generated fine last week was destroyed the moment the weekly retry hit a connector blip — a
    transient outage permanently removing verified content (review MAJOR-2). It is only carried over if its
    expression STILL matches the current schema's vocabulary and still measures something, which is the same
    pure check the generator gates on; a stored query whose table has since disappeared is not resurrected.

    With `invoke_connector`, that lexical check is followed by the SAME live dry run the fresh-generation
    path gates on (_signal_gen.still_relevant_live). The lexical check alone was not enough to justify what
    the caller does with the result: it marks the row `status: "ready"`, which settles the budget marker to
    `conc` and stops the row ever being re-checked — yet this whole path only runs BECAUSE the schema
    changed, and a schema can change in ways the vocabulary cannot see (a column's type, a renamed table
    that still exists but means something else, a revoked grant), so a lexically-valid expression can still
    fail at real query time (review MAJOR-4). Omit `invoke_connector` for a lexical-only pass — the one
    caller that does is the in-transaction late-spare below, which only spares keys from the sweep and
    never marks anything ready or conclusive, so it needs no live verification (and must not make connector
    calls inside an open transaction).

    Returns None on a READ failure — never `rows` unchanged. Silently falling back to `rows` here looked
    safe (never break the rebuild) but wasn't: with nothing carried and generation also having failed, the
    caller would still write and SWEEP, and the sweep deletes any key not in what got written — including
    the actual, still-good generated row in the table, based on nothing but a transient read error on OUR
    side (review, this round: the same MAJOR-2 deletion, reached through a different door). The caller must
    treat None as "cannot verify this run — write nothing" rather than "nothing to carry."

    A TRANSIENT dry-run outcome returns None for that same reason, and it is the reason the dry run can be
    added here at all: "the connector is down" must not be read as "the row is bad", or re-verifying the
    row would itself become the MAJOR-2 deletion. Only a CONCLUSIVE dry-run rejection drops the row.
    """
    try:
        existing = [r for r in wdb.list_diag_signals(conn, iid)
                    if (r.get("meta") or {}).get("provenance") == "generated" and r.get("status") == "ready"]
    except Exception:                      # noqa: BLE001 — signals "cannot verify", not "nothing to carry"
        return None
    kept = []
    for r in existing:
        exprs = [q.get("expr") for q in ((r.get("query") or {}).get("queries") or [])]
        if not exprs or not all(exprs):
            continue
        if invoke_connector is None:
            ok = all(_signal_gen.still_relevant(kind, schema, e) for e in exprs)
            transient = False
        else:
            ok, transient = True, False
            for e in exprs:
                ok, transient = _signal_gen.still_relevant_live(kind, schema, e, iid, invoke_connector)
                if not ok:
                    break
        if transient:
            # Cannot verify this run. Same contract as the read failure above: the caller must spare the
            # row rather than delete it on the strength of a connector blip, and must NOT settle `conc`.
            logging.info("[datasource_index] integration %s: cannot verify generated row %s this run — its "
                         "dry run failed transiently; sparing it without marking it ready", iid,
                         r["signal_key"])
            return None
        if ok:
            kept.append({"signal_key": r["signal_key"], "title": r.get("title"), "status": "ready",
                         "query": r["query"], "missing_metrics": None, "meta": r.get("meta")})
        else:
            logging.info("[datasource_index] integration %s: dropping generated row %s — its expression no "
                         "longer matches the schema, or no longer runs against it", iid, r["signal_key"])
    return list(rows) + kept


def _rebuild_diag_signals(conn, wdb, iid, kind, schema):
    version = _schema_version(schema)
    existing_content_version = wdb.read_signal_schema_version(conn, iid)
    existing_budget = wdb.read_diag_signal_budget(conn, iid)
    if existing_budget is None:
        _legacy = _MARKER_RE.search(existing_content_version or "")
        if _legacy:
            # v4 -> v5 TRANSITION ONLY. The marker used to live embedded in the CONTENT rows' shared
            # schema_version column; a pre-v5 instance's stored value can still literally BE that old
            # marker string, and every already-parked instance would otherwise read `existing_budget=None`
            # (no dedicated row exists pre-v5) and get a silently fresh 3-try budget on its first
            # post-deploy run — a hard-cap violation across the whole fleet at once (Codex stop-gate,
            # first pass).
            #
            # Carrying the OLD attempts/done state over VERBATIM broke the week-rollover un-park check: a
            # pre-v5 hash can never equal a freshly computed v5 hash even for an unchanged schema, so
            # `base != version` misread this deploy's version-scheme change as a real schema change
            # (second pass). Re-anchoring the hash to `version` instead fixed that, but introduced a third
            # failure mode this deploy cannot rule out: the CURRENT schema, at the moment of this exact
            # bootstrap read, might already be a GENUINELY different schema than whatever the v4 marker
            # was originally capped for — nothing in the stored data can tell the two apart, because the
            # very reason for re-anchoring is that hashes computed under different CATALOG_VERSIONs are not
            # comparable in EITHER direction. Forcing "done, capped" onto whatever schema happens to be
            # current would then permanently trap a schema that was never actually tried once, absorbed
            # into a cap that was never really about it (Codex stop-gate, third pass).
            #
            # So the bootstrap does not claim "capped" at all. Only the STREAK (how many consecutive weeks
            # this instance has been failing) carries over unconditionally — this deploy costs each
            # previously-capped instance up to one week's worth of real, bounded attempts, which is a
            # one-time, honestly-scoped price for never mis-attributing a schema across an algorithm change
            # that makes the two hashes fundamentally incomparable.
            #
            # ATTEMPTS carry over too, but only when the legacy marker's week IS the current one: a deploy
            # landing MID-WEEK means the OLD system already spent some of THIS SAME ISO week's budget
            # before this transition. Resetting to 0 regardless let one instance spend its pre-deploy v4
            # attempts AND a fresh v5 _MAX_GENERATION_ATTEMPTS in the same week — more than the hard weekly
            # cap this whole mechanism exists to enforce (Codex stop-gate, fourth pass). A legacy marker
            # from a genuinely PAST week resets attempts to 0 as normal — that is just the week rolling
            # over, exactly like any other hash-blind week transition in this system.
            _streak = int(_legacy.group(4) or 0)
            _same_week_attempts = int(_legacy.group(2)) if _legacy.group(3) == _iso_week() else 0
            existing_budget = _marker(version, _same_week_attempts, _PEND, _streak)
        else:
            # A CHARGED-BUT-UNFINISHED RESERVATION (review CRITICAL). reserve_diag_signal_attempt
            # writes the numeric meta.week/meta.attempts durably before the Bedrock call, while the
            # marker is only written at the very END of this function — so a crash in between
            # (Lambda timeout, OOM, uncaught raise) leaves the counter charged and NO marker at all.
            # Reading only the marker made that state indistinguishable from "brand new, nothing
            # ever owed", which skips unconditionally whenever the content version still matches —
            # i.e. FOREVER for an unchanged schema, with the spent reservation invisible and the
            # rebuild never reaching write_diag_signal_budget to close the loop. Synthesizing a PEND
            # marker says exactly what happened: an attempt cycle is in progress and is NOT settled,
            # so this run rebuilds and does write a marker, while the reservation's cost still counts
            # against the cap (it rides in as `known_attempts`, so reserve charges 1->2, not 0->1 —
            # no bonus free attempt). Attempts carry ONLY within the same ISO week, exactly like the
            # bootstrap above: a reservation from a past week is just the week rolling over. Streak
            # stays 0 — it lives only in the marker, and there is none.
            _res = wdb.read_diag_signal_reservation(conn, iid)
            if _res is not None:
                _res_week, _res_attempts = _res
                existing_budget = _marker(
                    version, _res_attempts if _res_week == _iso_week() else 0, _PEND, 0)
    base, attempts, marker_settled, streak = _marker_state(existing_budget, version)
    # Skip only when BOTH agree there is nothing to do: the CONTENT is fresh (this exact schema was the
    # last one actually built, so `rows` would come out the same) AND the BUDGET says settled for this
    # exact schema (no marker at all means nothing was owed and nothing was spent; a marker means check
    # its settled-ness AND that its own hash still matches — a preserved marker from a DIFFERENT schema
    # must not skip a rebuild for the current one). A `pend` marker means a retry is owed, so it must NOT
    # skip either; a `conc` one is settled for as long as the hash holds, week boundaries included.
    settled = existing_budget is None or (base == version and marker_settled)
    if existing_content_version == version and settled:
        return {"skipped": True, "schema_version": existing_content_version}
    rows = _cat.build_signals(kind, schema)  # present-but-empty metrics → all unavailable
    # ONE connector-invoke callable for both users of it: the fresh generation's dry run and the
    # carry-over's live re-verification. Building it once is what makes them provably the same gate.
    def _invoke_query(args):
        return _lambda_invoke(kind, _cat._KIND_TOOL.get(kind, f"{kind}_query"), args)
    exhausted = attempts >= _MAX_GENERATION_ATTEMPTS
    gen_status = None
    generated_key_unverified = False
    carry_attempted = False
    reserved = None
    if not any(r["status"] == "ready" for r in rows):
        if not exhausted:
            # RESERVE BEFORE THE MODEL CALL (review MAJOR, this round). Read → Bedrock → write is a
            # read-modify-write with a multi-second gap in the middle, so two workers on the same
            # integration (daily dispatcher vs. a schema-refresh or user enqueue) both read the same
            # count, both called Bedrock, and both stored the same incremented value — undercounting real
            # usage against a HARD cap. The DB counter is charged first and IS the authority; the
            # `attempts` parsed from the marker above only decides whether it is worth asking at all.
            # `attempts` rides along as a FLOOR: it is what the marker already established about this same
            # week, which the number cannot always know (the v4→v5 bootstrap has no bookkeeping row yet).
            reserved = wdb.reserve_diag_signal_attempt(conn, iid, _iso_week(),
                                                      _MAX_GENERATION_ATTEMPTS, version,
                                                      known_attempts=attempts)
            if reserved is None:
                # Lost the race: another worker spent the last of this week's budget between our read and
                # this reservation. Adopt the DB's verdict and park exactly like a locally observed
                # exhaustion — that keeps a budget row written (never swept back to a fresh budget) and
                # sends no second Bedrock call.
                attempts, exhausted = _MAX_GENERATION_ATTEMPTS, True
            else:
                generated, gen_status = _signal_gen.try_generate_signal_with_status(
                    kind, schema, iid, _invoke_query)
                if generated:
                    rows = list(rows) + [generated]
                if gen_status == _signal_gen.DISABLED:
                    # The flag is off, so nothing reached the model: hand the reservation back. Charging a
                    # disabled period exhausted the week with the feature OFF and then made turning it ON
                    # a no-op for up to a week (Codex stop-gate — kept, now enforced in the DB).
                    reserved = None
                    wdb.release_diag_signal_attempt(conn, iid, _iso_week())
        # Carrying the last-known-good chip is PART OF THE FEATURE, so it is gated like the feature: with
        # the flag off, generated content must stop being served, and preserving it there kept an LLM row
        # alive indefinitely after the gate closed (Codex stop-gate). It must also run when the week is
        # parked (`exhausted`, so no generation was attempted at all) — otherwise the park itself swept the
        # chip away, which is the same deletion MAJOR-2 was about.
        if os.environ.get("DIAG_SIGNAL_QUERYGEN_ENABLED") == "true" \
                and not any(r["status"] == "ready" for r in rows):
            carry_attempted = True
            # WITH the live dry run (review MAJOR-4): the row this returns is marked `ready`, and a ready
            # row settles the marker to `conc` — conclusive for this schema, never re-checked. A lexical
            # vocabulary match is not enough to claim that, because this path only runs BECAUSE the schema
            # changed and it can have changed in ways the vocabulary cannot see. Same gate, same callable,
            # as the fresh generation above.
            carried = _keep_last_good_generated(conn, wdb, iid, kind, schema, rows,
                                               invoke_connector=_invoke_query)
            if carried is None:
                # Could not verify whether a previously-good generated row still exists, is still relevant,
                # or still RUNS. Two things must BOTH hold, and one fix at a time broke the other (two prior
                # review rounds): a charged attempt's cost must still be recorded (spend the budget as
                # normal below — aborting the whole write let a persistent read failure retry for free
                # forever), AND the row itself must not be deleted on the strength of nothing but our own
                # read error. `generated_key_unverified` carries that second requirement past this point:
                # the sweep below spares GENERATED_SIGNAL_KEY whenever this is set, regardless of whether
                # it ends up in `written` this call, so an unread row's OWN (older) schema_version is left
                # untouched rather than swept — read_signal_schema_version() ignores that key entirely for
                # exactly this reason, so a spared stale-versioned row can never poison the budget tracking
                # for the deterministic rows that DO get a fresh version every call.
                generated_key_unverified = True
            else:
                rows = carried
    # WHICH OUTCOMES ARE WORTH REMEMBERING. A build with no ready signal is remembered (plus a sentinel row
    # when there is nothing at all) so the daily job stops rebuilding — but only when the outcome is
    # conclusive, and "conclusive" cost three review rounds to pin down:
    #   * TRANSIENT (Bedrock throttled, connector down — every exception, since the connectors collapse a
    #     503 into the same 400 as a bad query) is not conclusive. Recording it froze a retryable failure
    #     into a permanent skip, and NOT only for an empty build: loki/tempo normally produce `unavailable`
    #     rows, and persisting THOSE settled the week just as effectively.
    #   * REJECTED is not conclusive either. The model is not deterministic and the prompt, catalog and
    #     gates all change, so "the answer failed a gate once" is not a fact about this schema.
    #   * DISABLED is — the flag is part of the hash, so flipping it rebuilds anyway.
    # The rows are written either way (they carry the "metric X missing" text the UI shows); what differs is
    # whether the marker says this week is settled.
    ready_now = any(r["status"] == "ready" for r in rows)
    # REJECTED retries under the weekly budget too — the model is not deterministic and the prompt, catalog
    # and gates all change, so "the answer failed a gate once" is not a fact about this schema. It only
    # differs from TRANSIENT in the log message a caller might want; both are retried the same way.
    # Count only the attempts that actually reached the model — a reservation handed back (DISABLED, flag
    # off) is not one, because no Bedrock call happened: charging the budget for it meant three rebuilds
    # with the feature OFF exhausted the week, and then turning the flag ON did nothing for up to a week
    # (the flag change rebuilds, being in the hash, but the instance already read as "exhausted"). Enabling
    # a feature must not be pre-empted by the period it spent disabled (Codex stop-gate). When we DID
    # charge, `spent` is the number the DB itself enforced the cap against, even if a concurrent worker has
    # moved the counter since our own read.
    charged = reserved is not None
    spent = reserved if charged else attempts
    retry_needed = gen_status in (_signal_gen.TRANSIENT, _signal_gen.REJECTED) and not ready_now
    if retry_needed and spent >= _MAX_GENERATION_ATTEMPTS:
        logging.warning("[datasource_index] integration %s: generation failed on all %s attempts this week; "
                        "parking it until the week rolls over or the schema changes", iid, spent)
        retry_needed = False
    # The streak counts WEEKS that ended with the budget spent and nothing to show. It advances once per
    # week (only on the run that exhausts the budget), resets the moment something is ready, and caps the
    # weekly retry at _MAX_SPENT_WEEKS so an unchanged, permanently failing schema stops costing Bedrock.
    if ready_now:
        new_streak = 0
    elif not retry_needed and spent >= _MAX_GENERATION_ATTEMPTS and attempts < _MAX_GENERATION_ATTEMPTS:
        new_streak = streak + 1
    else:
        new_streak = streak
    # WHICH STATE THE MARKER CARRIES. One boolean (`needs_marker`) used to answer two questions at once —
    # "is this settled" and "is this week's usage moot" — so a ready/DISABLED outcome wrote NO marker, the
    # sweep deleted the row, and the next not-ready rebuild THAT SAME WEEK started a fresh budget: 3 more
    # Bedrock calls per catalog flap or flag toggle (review MAJOR, this round). The state now answers
    # "settled until when" and `spent` answers "how much of this week is gone", independently:
    #   conc — conclusive for this SCHEMA (ready now, including a carried-over last-known-good chip; or
    #          DISABLED, whose flag state is in the hash anyway). Settled REGARDLESS of the week, so the
    #          marker's week can no longer age out and re-invoke Bedrock on an already-served schema — the
    #          other MAJOR of an earlier round, which the plain-version encoding fixed and this must not
    #          undo (ADR-018 §A-4/Sustainability, "cached, not regenerated");
    #   pend — a retry is owed this week;   done — this week's budget is spent (parked until it rolls).
    conclusive = ready_now or gen_status == _signal_gen.DISABLED
    state = _CONC if conclusive else (_PEND if retry_needed else _DONE)
    if state == _CONC and not spent and not new_streak:
        # The ONLY case that leaves no budget row at all: a conclusive outcome in a week that spent nothing
        # and carries no streak — there is literally nothing to remember, so the sweep clears any stale row.
        stored_budget, budget_live = None, None
    elif state == _DONE and not charged and gen_status is None and base and base != version:
        # Exhausted already (no attempt made THIS call) and the schema genuinely differs from the one the
        # cap applies to. Writing a marker under the CURRENT schema's hash here would silently claim we'd
        # tried IT too — a schema that was NEVER evaluated would look, from the very next read, exactly
        # like "tried 3 times and failed" for THAT schema. At the next week boundary the streak-cap's hash
        # check would then compare against a hash that never got a real try, so a genuinely new schema
        # arriving mid-week while capped stayed parked indefinitely (review, an earlier round). The budget
        # marker is left byte-for-byte unchanged; the capped-schema identity cannot drift until an attempt
        # is actually spent against it.
        # budget_live stays None: this marker's count describes the OTHER schema, so it must be
        # stored byte-for-byte, never re-derived from this week's live counter.
        stored_budget, budget_live = existing_budget, None
    else:
        # Every field here is a PROPOSAL, not the final word: db.write_diag_signal_budget re-derives the
        # whole marker from the row's own live values and keeps the MORE advanced outcome. `spent` is a
        # floor under the live meta.attempts, so a worker that reserved during our Bedrock call is not
        # erased from the marker (review MAJOR-1, round 2); `state`/`new_streak` are floors in the
        # _MARKER_STATE_RANK ordering, so a worker finishing second cannot undo a settlement the first
        # already reached or regress its streak below what is already recorded (review MAJOR-1, round 3).
        stored_budget = _marker(version, spent, state, new_streak)
        budget_live = (version, state, new_streak, _iso_week(), spent)
    # CONTENT rows always carry the CURRENT schema's real version — never a preserved/stale one. Content
    # freshness and budget tracking used to share one column, and every fix to protect the budget's
    # identity (preserving a stale marker, excluding a key from the agreement check) ended up tagging
    # fresh content with a version that didn't describe it — so if the schema later rolled BACK to
    # whatever that stale tag actually named, the agreement check saw a false match and skipped, serving
    # the wrong (newer, mistagged) content as current (review, this round). The budget's own state now
    # lives in a dedicated row's `meta` field (db.read/write_diag_signal_budget), decoupled from
    # schema_version entirely, so content can always be tagged truthfully.
    # The budget row is NOT part of the content upsert: upsert_diag_signals sets `meta = EXCLUDED.meta`,
    # which would replace the whole object and so overwrite the numeric `meta.attempts`/`meta.week` counter
    # that reserve/release own — handing back an attempt a concurrent worker had already charged and
    # reopening the race the reservation closes. db.write_diag_signal_budget touches only `meta.budget` (and
    # the row's schema_version, so read_signal_schema_version()'s agreement check still sees one version
    # across every row). One consequence: an otherwise-empty build now writes db.SCHEMA_VERSION_SENTINEL_KEY
    # (the budget row used to be the one non-empty write that suppressed it), which is that sentinel doing
    # its documented job.
    # Atomic upsert+sweep (M3): a partial upsert must not leave some rows on the new schema_version
    # while others stay stale — the next run would read a new-version row, judge "unchanged", and
    # lock in the stale/missing signals. One transaction makes the rebuild all-or-nothing.
    conn.run("BEGIN")
    try:
        written = wdb.upsert_diag_signals(conn, iid, rows, version)
        if stored_budget is not None:
            wdb.write_diag_signal_budget(conn, iid, stored_budget, version, live_marker=budget_live)
            written = written + [wdb.BUDGET_KEY]
        # Sweep against what was WRITTEN, not against `rows`: an empty build writes a version sentinel
        # (db.SCHEMA_VERSION_SENTINEL_KEY) and sweeping `rows` would delete it right back. Not including
        # the budget row in `written` (stored_budget is None) naturally lets the sweep delete any STALE
        # prior budget row — a settled, unspent week should leave none behind. GENERATED_SIGNAL_KEY is ALSO
        # always spared when it was unverifiable this call — see generated_key_unverified above.
        sweep_keep = written + [_signal_gen.GENERATED_SIGNAL_KEY] if generated_key_unverified else written
        if carry_attempted and not generated_key_unverified:
            # TOCTOU (review MAJOR-2, this round): the carry-over read above ran BEFORE this
            # transaction — and before a multi-second Bedrock call — so a generated row another
            # worker committed in that window is invisible to it, and the sweep below would delete
            # it. That is the same "sweep destroys a verified row" failure the carry-over exists to
            # prevent, reached through a different door. Re-run the very same
            # verified-and-still-relevant check here, adjacent to the DELETE, and spare what it
            # finds through the mechanism already in this function (sweep_keep +
            # touch_generated_signal_version below), rather than carrying content we did not build
            # this call. Gated on carry_attempted so a ready deterministic build — or one with the
            # querygen flag off, where generated content must stop being served — cannot resurrect a
            # row it is supposed to supersede. A None read error yields nothing to spare, which is
            # today's behaviour for a read that succeeds and finds nothing. No-op on the
            # non-racing path. Under READ COMMITTED this narrows the window to the gap between two
            # adjacent statements rather than closing it; closing it fully would need an advisory
            # lock over the whole rebuild, which is out of scope here.
            # LEXICAL-ONLY here, deliberately (no invoke_connector): this call's result is used for
            # nothing but SPARING keys from the DELETE — it never marks a row ready and so can never
            # settle the marker to `conc`, which is the only thing MAJOR-4's live dry run is needed to
            # justify. It also runs inside the open transaction, where a multi-second connector call
            # would hold the sweep's locks for the duration.
            late = [r["signal_key"]
                    for r in (_keep_last_good_generated(conn, wdb, iid, kind, schema, []) or [])
                    if r["signal_key"] not in sweep_keep]
            if late:
                sweep_keep = sweep_keep + late
                generated_key_unverified = True
        wdb.sweep_diag_signals(conn, iid, sweep_keep)
        if generated_key_unverified:
            # The spared row's CONTENT-version is now stale relative to `version` — bump ONLY that column
            # (never its content, which we never read) so read_signal_schema_version()'s agreement check
            # stays meaningful. A no-op if the row doesn't exist.
            wdb.touch_generated_signal_version(conn, iid, version)
        conn.run("COMMIT")
    except Exception:
        conn.run("ROLLBACK")
        raise
    return {"built": len(rows), "ready": sum(1 for r in rows if r["status"] == "ready"),
            "schema_version": version,
            **({"retry": "generation failed transiently"} if retry_needed else {})}


def _hybrid_fallback(kind, schema, iid, rows):
    """v1 scope: clickhouse trace_spans only. If the catalog couldn't match, ask graph_querygen for a
    generated candidate; a success REPLACES that one row. Never lets a querygen failure/exception
    break the catalog-based rebuild — `rows` (the catalog's own, possibly-unavailable, result) is
    always a safe fallback."""
    if kind != "clickhouse":
        return rows
    idx = next((i for i, r in enumerate(rows) if r.get("query_key") == "trace_spans"), None)
    if idx is None or rows[idx].get("status") != "unavailable":
        return rows
    try:
        generated = _querygen.try_generate_clickhouse_trace_spans(
            schema, iid, lambda args: _lambda_invoke("clickhouse", "clickhouse_query", args))
    except Exception as e:  # noqa: BLE001 — querygen must never break the catalog-based rebuild
        logging.warning("[datasource_index] graph_querygen failed for integration %s: %s", iid, e)
        return rows
    if generated:
        rows = list(rows)
        rows[idx] = generated
    return rows


def _rebuild_graph_queries(conn, wdb, iid, kind, schema):
    version = _graph_schema_version(schema)
    if wdb.read_graph_schema_version(conn, iid) == version:
        return {"graph_skipped": True}
    rows = _graph_cat.build_graph_queries(kind, schema)
    rows = _hybrid_fallback(kind, schema, iid, rows)
    conn.run("BEGIN")
    try:
        wdb.upsert_graph_queries(conn, iid, rows, version)
        wdb.sweep_graph_queries(conn, iid, [r["query_key"] for r in rows])
        conn.run("COMMIT")
    except Exception:
        conn.run("ROLLBACK")
        raise
    return {"graph_built": len(rows), "graph_ready": sum(1 for r in rows if r["status"] == "ready")}


def run(payload, conn):
    """Rebuild diag signals + graph queries for payload['integration_id']. Never raises."""
    import db as wdb
    iid = payload.get("integration_id")
    # Gate: only build when the datasource-diagnosis feature is enabled (same DIAG_DATASOURCES_ENABLED
    # the collector checks; wired to the worker lambda via terraform local.ds_env_map, which also grants
    # the connector-invoke IAM this job's live re-introspection needs). Keeps the always-on enqueue path
    # (BFF add/refresh + REGISTRY + the daily dispatcher) a no-op when datasource_diagnosis_enabled=false.
    if os.environ.get("DIAG_DATASOURCES_ENABLED") != "true":
        return {"integration_id": iid, "disabled": True}
    try:
        cached_kind, schema = _read_cached_schema(conn, iid)
        # kind travels in the payload (the dispatcher already knows it from `integrations`) — falls
        # back to the cache for jobs enqueued before this field existed, or manual/ad-hoc enqueues.
        kind = payload.get("kind") or cached_kind
        if kind is None:
            # no cache row AND no kind to even attempt live introspection with → truly nothing to build
            return {"integration_id": iid, "no_schema": True}

        out = {"integration_id": iid}
        fresh = _reintrospect(kind, iid)
        if fresh is not None:
            if schema is None or json.dumps(fresh, sort_keys=True) != json.dumps(schema, sort_keys=True):
                acct = os.environ.get("HOST_ACCOUNT_ID") or os.environ.get("AWS_ACCOUNT_ID") or "self"
                try:
                    wdb.upsert_datasource_schema(conn, acct, iid, kind, fresh)
                except ValueError:
                    # oversized schema (256KB cap, mirrors the BFF) — still USE it for this run's
                    # rebuild below, just don't persist it; the cache keeps the last-good schema.
                    out["schema_cache_skipped"] = "oversized"
            schema = fresh
        else:
            out["introspect_error"] = "introspect_failed"  # fall back to whatever `schema` already is

        if schema is None:
            out["no_schema"] = True
            return out

        out.update(_rebuild_diag_signals(conn, wdb, iid, kind, schema))
        out.update(_rebuild_graph_queries(conn, wdb, iid, kind, schema))
        try:
            # Cards are the newest family — isolate their failure so signals/graph results still land.
            out.update(_rebuild_dashboard_cards(conn, wdb, iid, kind, schema))
        except Exception as e:  # noqa: BLE001 — surfaced on the job result, never sinks the run
            logging.warning("[datasource_index] integration %s card build failed: %s", iid, e)
            out["cards_error"] = str(e)[:200]
        return out
    except Exception as e:  # noqa: BLE001 — never sink the dispatcher; surface on the job result
        logging.warning("[datasource_index] integration %s failed: %s", iid, e)
        return {"integration_id": iid, "error": str(e)[:300]}
