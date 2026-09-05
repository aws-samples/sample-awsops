"""AWSops v2 P2 — shared Aurora access (pg8000) + worker_jobs CRUD.

Env: AURORA_ENDPOINT, AURORA_DATABASE, AURORA_USER (default awsops_worker), AWS_REGION. Auth is RDS
IAM database auth (rds-db:connect on the caller's role) — a fresh SigV4-signed token is generated
per connect(), never cached, so a warm Lambda execution environment can never hold a stale
credential across the master secret's rotation cycle (mirrors web/lib/db.ts and steampipe.tf).
Transitions are CONDITIONAL: terminal states (succeeded/failed/canceled) are immutable, so an SFN
Catch cannot overwrite a worker's succeeded, and retries cannot resurrect a done job.
"""
import json
import os
import ssl
import boto3
import pg8000.native

_TERMINAL = ("succeeded", "failed", "canceled", "manual_intervention")  # widen the terminal set


def _auth_token():
    rds = boto3.client("rds", region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))
    return rds.generate_db_auth_token(
        DBHostname=os.environ["AURORA_ENDPOINT"], Port=5432,
        DBUsername=os.environ.get("AURORA_USER", "awsops_worker"),
    )


def _ssl_ctx():
    # Match the web's pg ssl: rejectUnauthorized:false (no RDS CA bundling in dev). Prod: bundle RDS CA.
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


def connect():
    return pg8000.native.Connection(
        user=os.environ.get("AURORA_USER", "awsops_worker"), password=_auth_token(),
        host=os.environ["AURORA_ENDPOINT"], database=os.environ["AURORA_DATABASE"],
        port=5432, ssl_context=_ssl_ctx(),
    )


def insert_job(conn, job_id, type_, payload, dry_run=False, idempotency_key=None, requested_by=None):
    """requested_by defaults to NULL (internal-only enqueue — reaper/generic dispatchers with no
    end-user principal; treated admin-only on read, see app/api/jobs/route.ts GET). Callers that
    enqueue on behalf of a specific user MUST pass their domain row's ownership key; for example,
    schedule_dispatcher.py passes report_schedules.user_sub (the immutable Cognito sub)."""
    conn.run(
        "INSERT INTO worker_jobs (job_id, type, payload, dry_run, idempotency_key, requested_by) "
        "VALUES (:id, :t, :p::jsonb, :d, :k, :rb)",
        id=job_id, t=type_, p=json.dumps(payload), d=dry_run, k=idempotency_key, rb=requested_by,
    )


def claim_running(conn, job_id, runtime):
    """queued|running -> running (idempotent re-claim). Returns rows affected (0 = already terminal)."""
    rows = conn.run(
        "UPDATE worker_jobs SET status='running', runtime=:r, attempt=attempt+1 "
        "WHERE job_id=:id AND status NOT IN ('succeeded','failed','canceled') RETURNING job_id",
        id=job_id, r=runtime,
    )
    return len(rows)


def finish_job(conn, job_id, status, result=None, artifact_uri=None, error=None):
    """Set a TERMINAL status only if not already terminal (immutable). Returns rows affected."""
    assert status in _TERMINAL
    rows = conn.run(
        "UPDATE worker_jobs SET status=:s, result=:res::jsonb, artifact_uri=:a, error=:e "
        "WHERE job_id=:id AND status NOT IN ('succeeded','failed','canceled') RETURNING job_id",
        s=status, res=(json.dumps(result) if result is not None else None),
        a=artifact_uri, e=error, id=job_id,
    )
    return len(rows)


# Single source of truth for get_job's SELECT + dict keys (avoids positional-zip drift).
_JOB_COLS = ["job_id", "type", "status", "payload", "result", "artifact_uri", "error", "dry_run"]


def get_job(conn, job_id):
    rows = conn.run(f"SELECT {','.join(_JOB_COLS)} FROM worker_jobs WHERE job_id=:id", id=job_id)
    return dict(zip(_JOB_COLS, rows[0])) if rows else None


def set_manual_intervention(conn, job_id, error):
    rows = conn.run(
        "UPDATE worker_jobs SET status='manual_intervention', error=:e "
        "WHERE job_id=:id AND status NOT IN ('succeeded','failed','canceled','manual_intervention') RETURNING job_id",
        e=error, id=job_id)
    return len(rows)


# ── ai_insights (AI Insights dashboard cache) ────────────────────────────────────────────────────
_INSIGHT_COLS = ["status", "insights", "sources_used", "model", "error", "generated_at"]


def insert_insight(conn, status, insights, sources_used, model=None, error=None):
    """Append one insight row. jsonb fields bound + cast (never inlined)."""
    conn.run(
        "INSERT INTO ai_insights (account_id, status, insights, sources_used, model, error) "
        "VALUES ('self', :st, :ins::jsonb, :src::jsonb, :md, :err)",
        st=status, ins=json.dumps(insights or []), src=json.dumps(sources_used or {}),
        md=model, err=error,
    )


# ── datasource_diag_signals (pre-built Prometheus/Mimir diagnostic signals) ──────────────────────
_DDS_COLS = ["signal_key", "title", "status", "query", "missing_metrics", "meta"]


def _maybe_json(v):
    """pg8000 may return jsonb as a parsed object OR a string depending on type adaptation — normalize."""
    if isinstance(v, str):
        try:
            return json.loads(v)
        except (ValueError, TypeError):
            return v
    return v


# A kind whose catalog matches nothing (clickhouse today) produces zero rows, and with no row there is
# no schema_version — so read_signal_schema_version() returns None forever and datasource_index rebuilds
# on EVERY run, re-invoking Bedrock daily wherever the fallback flag is on (review MAJOR, 2 models). This
# sentinel records the version without being a signal: the BFF read path filters it out, so it never
# reaches the UI as a chip.
SCHEMA_VERSION_SENTINEL_KEY = "__schema_version__"


def upsert_diag_signals(conn, integration_id, rows, schema_version):
    """Idempotent upsert of built signal rows for one instance. jsonb fields are bound + cast (never
    inlined). Caller sweeps stale keys via sweep_diag_signals.

    Empty rows are NOT a no-op any more: a sentinel row carries schema_version so that "this schema
    genuinely yields no signals" is remembered instead of being retried forever.

    Returns the signal_keys actually written, which is what the caller must sweep against — sweeping the
    caller's own `rows` would delete the sentinel in the same transaction, and unconditionally KEEPING it
    would leave a stale-version row next to real ones, making read_signal_schema_version() see two
    versions and rebuild every run. Neither is what we want.
    """
    rows = list(rows or [])
    if not rows:
        rows = [{
            "signal_key": SCHEMA_VERSION_SENTINEL_KEY,
            "title": "(no signals for this schema)",
            "status": "unavailable", "query": None, "missing_metrics": None,
            "meta": {"sentinel": True},
        }]
    for r in rows:
        conn.run(
            "INSERT INTO datasource_diag_signals "
            "(account_id, integration_id, signal_key, title, status, query, missing_metrics, meta, schema_version, built_at) "
            "VALUES ('self', :iid, :sk, :ti, :st, :q::jsonb, :mm::jsonb, :me::jsonb, :sv, now()) "
            "ON CONFLICT (account_id, integration_id, signal_key) DO UPDATE SET "
            "title=EXCLUDED.title, status=EXCLUDED.status, query=EXCLUDED.query, "
            "missing_metrics=EXCLUDED.missing_metrics, meta=EXCLUDED.meta, "
            "schema_version=EXCLUDED.schema_version, built_at=now()",
            iid=integration_id, sk=r["signal_key"], ti=r["title"], st=r["status"],
            q=(json.dumps(r["query"]) if r.get("query") is not None else None),
            mm=(json.dumps(r["missing_metrics"]) if r.get("missing_metrics") is not None else None),
            me=json.dumps(r.get("meta") or {}), sv=schema_version,
        )
    return [r["signal_key"] for r in rows]


def read_signal_schema_version(conn, integration_id):
    """Return a stable schema_version only when all existing rows agree.

    Mixed versions can happen after a historical partial rebuild; treating one arbitrary row as current
    would make datasource_index skip forever with stale/missing signals.
    """
    rows = conn.run(
        "SELECT COUNT(DISTINCT schema_version), MIN(schema_version) "
        "FROM datasource_diag_signals "
        "WHERE account_id='self' AND integration_id=:iid",
        iid=integration_id)
    if not rows:
        return None
    distinct, version = rows[0]
    return version if distinct == 1 and version else None


def list_diag_signals(conn, integration_id):
    """All signal rows for one instance (ready + unavailable), jsonb fields parsed."""
    rows = conn.run(
        f"SELECT {','.join(_DDS_COLS)} FROM datasource_diag_signals "
        "WHERE account_id='self' AND integration_id=:iid ORDER BY signal_key",
        iid=integration_id)
    out = []
    for row in rows:
        d = dict(zip(_DDS_COLS, row))
        d["query"] = _maybe_json(d["query"])
        d["missing_metrics"] = _maybe_json(d["missing_metrics"])
        d["meta"] = _maybe_json(d["meta"])
        out.append(d)
    return out


BUDGET_KEY = "__diag_signal_budget__"   # bookkeeping row: NOT a signal, filtered from the BFF read
BUDGET_TITLE = "(diag-signal retry budget)"   # its human label — never a signal title


def _diag_signal_budget_meta(conn, integration_id):
    """The bookkeeping row's whole `meta` object ({} when the row does not exist). Shared by the
    two readers below: the MARKER and the numeric COUNTER live in the same row's meta, and both
    are needed to tell a crashed attempt apart from a never-attempted one."""
    rows = conn.run(
        f"SELECT meta FROM datasource_diag_signals WHERE account_id='self' AND integration_id=:iid "
        f"AND signal_key=:sk",
        iid=integration_id, sk=BUDGET_KEY)
    if not rows:
        return {}
    return _maybe_json(rows[0][0]) or {}


def read_diag_signal_budget(conn, integration_id):
    """The weekly-retry marker (`<hash>:<pend|done>N w<week>[s<streak>]`), stored in a DEDICATED row's
    `meta.budget` field — deliberately NOT in that row's own `schema_version` column, and deliberately NOT
    sharing a column with the content rows' schema_version at all.

    Two rounds of trying to reuse the CONTENT rows' schema_version column for this both broke something:
    excluding the budget/generated keys from read_signal_schema_version()'s agreement check left a
    clickhouse-only (deterministic catalog always empty) build with zero rows to check, reading as
    permanently version-less; and PRESERVING a stale marker string as the row's schema_version to protect
    the budget's identity meant the CONTENT rows written alongside it were ALSO tagged with that stale
    version — so if the schema later rolled back to the one the stale tag actually named, the agreement
    check saw a match and skipped, serving the WRONG (newer, mistagged) content as if it were current
    (review, this round). Storing the marker in `meta` instead of `schema_version` means content rows are
    free to always carry the CURRENT schema's real version (content freshness stays correct in every case)
    while the budget tracks its own, completely independent state in its own column.
    """
    return _diag_signal_budget_meta(conn, integration_id).get("budget")


def read_diag_signal_reservation(conn, integration_id):
    """`(week, attempts)` from the bookkeeping row's NUMERIC counter, or None when no attempt was
    ever reserved for this instance.

    reserve_diag_signal_attempt() writes `meta.week`/`meta.attempts` durably BEFORE the Bedrock
    call (pg8000 autocommits outside the caller's explicit BEGIN), while the marker string is only
    written at the very END of the rebuild. A crash in between — Lambda timeout, OOM, uncaught
    raise — therefore leaves a charged reservation with NO marker at all, and a marker-only read
    reported that as None. datasource_index read None as "nothing was ever owed", i.e. settled, so
    an unchanged schema skipped FOREVER and the reservation's cost stayed invisible (review
    CRITICAL). These two fields are the only durable evidence that the attempt happened.
    """
    meta = _diag_signal_budget_meta(conn, integration_id)
    week = meta.get("week")
    if not week:
        return None
    try:
        attempts = int(meta.get("attempts") or 0)
    except (TypeError, ValueError):   # a hand-edited row must not sink the rebuild
        attempts = 0
    return week, attempts


def reserve_diag_signal_attempt(conn, integration_id, week, max_attempts, schema_version,
                                known_attempts=0):
    """Atomically charge ONE of this ISO week's generation attempts; return the new attempt count, or
    None when the week's budget is already spent (the caller must then NOT call Bedrock).

    read-budget → call Bedrock → write-budget was a read-modify-write with a multi-second gap: two
    workers racing on one integration (the daily dispatcher overlapping a schema-refresh or a user
    enqueue) both read the same count, both called Bedrock, and both stored the same incremented value,
    so real usage was undercounted against a HARD cap (review MAJOR). The charge is therefore a
    RESERVATION: ONE `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` statement, so racing workers
    serialize on the row lock and get 1 and 2 instead of 1 and 1, the cap is enforced by the statement's
    own WHERE (not by the caller's already-stale read), and because pg8000 autocommits outside the
    explicit BEGIN blocks this module uses, the charge is durable BEFORE the model call — a crash
    mid-generation still costs the attempt it actually spent.

    The counter is a NUMBER (`meta.attempts` + `meta.week`) beside the marker string in the same row,
    because a packed `<hash>:<state>N w<week>` cannot be incremented in SQL without parsing it there.
    The number ENFORCES the cap; the marker keeps the state/streak/hash the rebuild logic reads.
    write_diag_signal_budget() is the only writer of the marker and never touches these two fields.

    `known_attempts` is what the CALLER has already established about this same week from the marker, and
    the new count is `GREATEST(stored, known) + 1`: both are lower bounds on real usage, so the higher one
    wins. Without it, a state the number cannot know about would silently reset the cap — the v4→v5
    bootstrap is exactly that case (no bookkeeping row exists yet, so no number exists either, while the
    legacy marker may say this same ISO week already spent 2 of its 3 tries; Codex stop-gate, fourth pass).
    The caller is expected to have short-circuited on `known_attempts >= max_attempts` already, which is
    why the INSERT path does not re-check the cap.
    """
    rows = conn.run(
        "INSERT INTO datasource_diag_signals "
        "(account_id, integration_id, signal_key, title, status, meta, schema_version, built_at) "
        "VALUES ('self', :iid, :sk, :ti, :st, "
        "jsonb_build_object('week', :wk::text, 'attempts', :known + 1), :sv, now()) "
        "ON CONFLICT (account_id, integration_id, signal_key) DO UPDATE SET "
        "meta = jsonb_set(jsonb_set(datasource_diag_signals.meta, '{week}', to_jsonb(:wk::text)), "
        "'{attempts}', to_jsonb(GREATEST("
        "CASE WHEN datasource_diag_signals.meta->>'week' = :wk::text "
        "THEN coalesce((datasource_diag_signals.meta->>'attempts')::int, 0) ELSE 0 END, :known) + 1)), "
        "built_at = now() "
        "WHERE GREATEST(CASE WHEN datasource_diag_signals.meta->>'week' = :wk::text "
        "THEN coalesce((datasource_diag_signals.meta->>'attempts')::int, 0) ELSE 0 END, :known) < :cap "
        "RETURNING (datasource_diag_signals.meta->>'attempts')::int",
        iid=integration_id, sk=BUDGET_KEY, ti=BUDGET_TITLE, st="unavailable",
        wk=week, sv=schema_version, cap=max_attempts, known=known_attempts)
    return rows[0][0] if rows else None


def release_diag_signal_attempt(conn, integration_id, week):
    """Hand back a reservation that never reached the model.

    One caller only: the querygen flag is off, so try_generate_signal_with_status() returned DISABLED
    without making a Bedrock call. Charging that would let a period spent with the feature OFF pre-empt
    the budget the moment an operator turns it ON — the invariant `charged` has always encoded. Scoped
    to the reservation's OWN week (a week rollover between reserve and release must never decrement the
    NEW week's count) and floored at 0.
    """
    conn.run(
        "UPDATE datasource_diag_signals SET meta = jsonb_set(meta, '{attempts}', "
        "to_jsonb(GREATEST(coalesce((meta->>'attempts')::int, 1) - 1, 0))) "
        "WHERE account_id='self' AND integration_id=:iid AND signal_key=:sk "
        "AND meta->>'week' = :wk",
        iid=integration_id, sk=BUDGET_KEY, wk=week)


# pend < done < conc, matching datasource_index._marker_state's own reading of settledness: `pend` owes a
# retry this week, `done` has spent this week's budget and is parked until it rolls, `conc` is settled for
# this SCHEMA regardless of the week. The ORDER is what makes the marker write monotonic (review MAJOR-1,
# round 3) — see write_diag_signal_budget's `live_marker`.
_MARKER_STATE_RANK = {"pend": 0, "done": 1, "conc": 2}

# The live marker, parsed back out of the row inside the UPDATE. Deliberately COLON-FREE regexes: a `:`
# inside a SQL string literal is ambiguous with pg8000's own `:name` parameter markers, so `:(pend|…)`
# and a non-capturing `(?:s[0-9]+)` are both avoided. Dropping the leading colon is safe because the
# marker's prefix is a sha256 hex digest — 'pend'/'done'/'conc' each need a non-hex letter (p, o, n), so
# none of them can ever match inside it. substring() returns the FIRST capture group.
_LIVE_BUDGET = "datasource_diag_signals.meta->>'budget'"
_LIVE_STATE = "substring(" + _LIVE_BUDGET + " from '(pend|done|conc)[0-9]+w')"
_LIVE_WEEK = "substring(" + _LIVE_BUDGET + " from 'w([0-9]{5,8})(s[0-9]+)?$')"
_LIVE_STREAK = "coalesce(substring(" + _LIVE_BUDGET + " from 's([0-9]+)$')::int, 0)"
# The live state's RANK, or -1 for "nothing comparable is stored". Scoping is deliberately asymmetric and
# mirrors _marker_state: a live `conc` counts regardless of week (settled-ness does not expire when the
# week rolls — that is the whole reason the third state exists), while `pend`/`done` count only within
# THIS ISO week, because a past week's park is exactly what the week rolling over is supposed to release.
# Hash-scoped in every case: carrying a DIFFERENT schema's state onto this version's marker would claim
# we had evaluated THIS schema when we never did — the trap datasource_index.py's byte-for-byte
# preservation branch documents.
_LIVE_RANK = ("CASE WHEN split_part(" + _LIVE_BUDGET + ", ':', 1) = :ver::text "
              "AND (" + _LIVE_STATE + " = 'conc' OR " + _LIVE_WEEK + " = :wk::text) "
              "THEN CASE " + _LIVE_STATE + " WHEN 'conc' THEN 2 WHEN 'done' THEN 1 "
              "WHEN 'pend' THEN 0 ELSE -1 END ELSE -1 END")


def write_diag_signal_budget(conn, integration_id, marker, schema_version, live_marker=None):
    """Upsert the bookkeeping row's marker string + schema_version, WITHOUT touching the numeric
    `meta.attempts`/`meta.week` counter that reserve/release own.

    The budget row deliberately does not go through upsert_diag_signals: its `meta = EXCLUDED.meta`
    replaces the whole object, so a concurrent worker's already-charged attempt would be overwritten by
    this call's (older) view of the count — reopening exactly the race the reservation closes. `status`
    stays 'unavailable' because the table has CHECK (status IN ('ready','unavailable')) and this row is
    bookkeeping, not a signal.

    `live_marker=(version, state, streak, week, floor)` re-derives the WHOLE marker inside the UPDATE
    itself, monotonically, rather than storing the caller's string. The caller decides its state/streak
    BEFORE a multi-second Bedrock call, so last-writer-wins let the worker that finished SECOND overwrite
    a MORE advanced outcome with its own stale one: a `conc` settlement undone back to `pend`, or a
    streak regressed below what was already durably recorded (which can keep _MAX_SPENT_WEEKS from ever
    being reached). An earlier round fixed only the embedded attempts DIGIT this way; state and streak
    stayed last-writer-wins (review MAJOR-1, round 3).

    The merge picks the more-advanced (state, streak) PAIR by _MARKER_STATE_RANK — not each field
    independently. Choosing per-field would make the streak un-resettable: `ready_now` legitimately
    resets it to 0, and a plain GREATEST would pin it high forever, eventually parking an instance that
    is actually succeeding. With pair-selection, a proposed `conc`+streak-0 outranks a live `done`+streak-2
    and the reset lands. On a RANK TIE the higher streak wins, which is the anti-regression rule itself.
    (A tie at `conc` therefore keeps a stale streak; harmless, because a `conc` marker already parks an
    unchanged schema on its own, and a changed schema resets the streak via _marker_state's hash check.)

    The attempts digit keeps its own independent `GREATEST(live counter, floor)` — it is the number the DB
    itself enforced the cap against, orthogonal to which state won, and its week guard is the same
    `CASE WHEN meta->>'week' = :wk` reserve() uses so a previous week's count cannot leak in.

    The INSERT path keeps the caller's `marker` verbatim: with no row there is no live marker to be
    monotonic against, and the expression would reproduce that same string anyway. Omit `live_marker` to
    store `marker` byte-for-byte — the one caller that must, because its marker deliberately belongs to a
    DIFFERENT schema whose embedded count and state describe that schema, not this week's live numbers.
    """
    bg_expr = ":bg::text"
    extra = {}
    if live_marker is not None:
        version, state, streak, week, floor = live_marker
        attempts = ("GREATEST(CASE WHEN datasource_diag_signals.meta->>'week' = :wk::text "
                    "THEN coalesce((datasource_diag_signals.meta->>'attempts')::int, 0) ELSE 0 END, "
                    ":floor)")
        # Pair-selection, not per-field: the winning rank decides whose streak is used, and only a tie
        # falls back to GREATEST. See the docstring for why per-field would break the ready-reset.
        merged_streak = ("CASE WHEN (" + _LIVE_RANK + ") > :rank THEN " + _LIVE_STREAK + " "
                         "WHEN (" + _LIVE_RANK + ") < :rank THEN :strk "
                         "ELSE GREATEST(" + _LIVE_STREAK + ", :strk) END")
        bg_expr = (":ver::text || ':' || "
                   "CASE GREATEST(:rank, " + _LIVE_RANK + ") "
                   "WHEN 2 THEN 'conc' WHEN 1 THEN 'done' ELSE 'pend' END || "
                   + attempts + "::text || 'w' || :wk::text || "
                   "CASE WHEN (" + merged_streak + ") > 0 "
                   "THEN 's' || (" + merged_streak + ")::text ELSE '' END")
        extra = dict(ver=version, wk=week, floor=floor, strk=streak,
                     rank=_MARKER_STATE_RANK.get(state, 0))
    conn.run(
        "INSERT INTO datasource_diag_signals "
        "(account_id, integration_id, signal_key, title, status, meta, schema_version, built_at) "
        "VALUES ('self', :iid, :sk, :ti, :st, jsonb_build_object('budget', :bg::text), :sv, now()) "
        "ON CONFLICT (account_id, integration_id, signal_key) DO UPDATE SET "
        f"meta = jsonb_set(datasource_diag_signals.meta, '{{budget}}', to_jsonb({bg_expr})), "
        "schema_version = :sv, built_at = now()",
        iid=integration_id, sk=BUDGET_KEY, ti=BUDGET_TITLE, st="unavailable",
        bg=marker, sv=schema_version, **extra)


def touch_generated_signal_version(conn, integration_id, schema_version):
    """Bump the generated row's OWN schema_version column to match this call's, without touching its
    content — a no-op if the row doesn't exist (0 rows affected).

    Exists for exactly one case: a carry-over read failed, so the row is sweep-spared (never deleted on the
    strength of a read error we can't attribute to the row itself), but its version is now stale relative
    to the deterministic rows this same call DID write. read_signal_schema_version() requires ALL rows to
    agree — a version-blind EXCLUSION of this one key was tried first and broke the opposite way: for a kind
    whose deterministic catalog is ALWAYS empty (clickhouse), the generated row can be the ONLY row in the
    table, and excluding it left zero rows to check, so the version read as permanently absent and the
    build regenerated on every single call forever (review, this round). Touching only the version column —
    never the content, since an unread row's content is exactly what we don't know — keeps the agreement
    check meaningful without needing to know or preserve anything about the row beyond its fixed key.
    """
    conn.run(
        "UPDATE datasource_diag_signals SET schema_version=:sv "
        "WHERE account_id='self' AND integration_id=:iid AND signal_key='generated_signal'",
        iid=integration_id, sv=schema_version)


def sweep_diag_signals(conn, integration_id, keep_keys):
    """Delete this instance's signal rows whose key is NOT in keep_keys (mark-sweep after a rebuild).
    Empty keep_keys → delete all rows for the instance."""
    conn.run(
        "DELETE FROM datasource_diag_signals "
        "WHERE account_id='self' AND integration_id=:iid AND signal_key <> ALL(:keep)",
        iid=integration_id, keep=list(keep_keys or []))


# ── datasource_graph_queries (pre-built topology-graph queries) ─────────────────────────────────
# Mirrors the datasource_diag_signals helpers above exactly, one table over — see graph_catalog.py.


def upsert_graph_queries(conn, integration_id, rows, schema_version):
    """Idempotent upsert of built graph-query rows for one instance. jsonb fields are bound + cast
    (never inlined). Caller sweeps stale keys via sweep_graph_queries. No-op on empty rows."""
    for r in rows or []:
        conn.run(
            "INSERT INTO datasource_graph_queries "
            "(account_id, integration_id, query_key, status, query, missing, meta, schema_version, built_at) "
            "VALUES ('self', :iid, :qk, :st, :q::jsonb, :mi::jsonb, :me::jsonb, :sv, now()) "
            "ON CONFLICT (account_id, integration_id, query_key) DO UPDATE SET "
            "status=EXCLUDED.status, query=EXCLUDED.query, missing=EXCLUDED.missing, "
            "meta=EXCLUDED.meta, schema_version=EXCLUDED.schema_version, built_at=now()",
            iid=integration_id, qk=r["query_key"], st=r["status"],
            q=(json.dumps(r["query"]) if r.get("query") is not None else None),
            mi=(json.dumps(r["missing"]) if r.get("missing") is not None else None),
            me=json.dumps(r.get("meta") or {}), sv=schema_version,
        )


def read_graph_schema_version(conn, integration_id):
    """Return a stable schema_version only when all existing graph-query rows agree (mirrors
    read_signal_schema_version — see its docstring for why mixed versions must not short-circuit)."""
    rows = conn.run(
        "SELECT COUNT(DISTINCT schema_version), MIN(schema_version) "
        "FROM datasource_graph_queries "
        "WHERE account_id='self' AND integration_id=:iid",
        iid=integration_id)
    if not rows:
        return None
    distinct, version = rows[0]
    return version if distinct == 1 and version else None


def sweep_graph_queries(conn, integration_id, keep_keys):
    """Delete this instance's graph-query rows whose key is NOT in keep_keys (mark-sweep after a
    rebuild). Empty keep_keys → delete all rows for the instance."""
    conn.run(
        "DELETE FROM datasource_graph_queries "
        "WHERE account_id='self' AND integration_id=:iid AND query_key <> ALL(:keep)",
        iid=integration_id, keep=list(keep_keys or []))


# ── datasource_dashboard_cards (pre-built dashboard cards) ──────────────────────────────────────
# Third pre-built-content family; mirrors the diag-signal helpers (sentinel on empty build) with the
# graph-query helpers' simpler shape — deterministic only, so no budget/provenance machinery.


def upsert_dashboard_cards(conn, integration_id, rows, schema_version):
    """Idempotent upsert of built dashboard-card rows for one instance. jsonb fields are bound + cast
    (never inlined). Caller sweeps stale keys via sweep_dashboard_cards.

    Empty rows write the schema-version sentinel row (see upsert_diag_signals' docstring) so
    "this schema genuinely yields no cards" is remembered instead of rebuilt every run.
    Returns the card_keys actually written — what the caller must sweep against.
    """
    rows = list(rows or [])
    if not rows:
        rows = [{
            "card_key": SCHEMA_VERSION_SENTINEL_KEY,
            "title": "(no cards for this schema)",
            "viz": "stat", "unit": "", "status": "unavailable", "query": None, "missing": [],
        }]
    for r in rows:
        conn.run(
            "INSERT INTO datasource_dashboard_cards "
            "(account_id, integration_id, card_key, title, viz, unit, status, query, missing, schema_version, built_at) "
            "VALUES ('self', :iid, :ck, :ti, :vz, :un, :st, :q::jsonb, :mi::jsonb, :sv, now()) "
            "ON CONFLICT (account_id, integration_id, card_key) DO UPDATE SET "
            "title=EXCLUDED.title, viz=EXCLUDED.viz, unit=EXCLUDED.unit, status=EXCLUDED.status, "
            "query=EXCLUDED.query, missing=EXCLUDED.missing, "
            "schema_version=EXCLUDED.schema_version, built_at=now()",
            iid=integration_id, ck=r["card_key"], ti=r["title"], vz=r["viz"],
            un=r.get("unit") or "", st=r["status"],
            q=(json.dumps(r["query"]) if r.get("query") is not None else None),
            mi=json.dumps(r.get("missing") or []), sv=schema_version,
        )
    return [r["card_key"] for r in rows]


def read_card_schema_version(conn, integration_id):
    """Return a stable schema_version only when all existing card rows agree (mirrors
    read_signal_schema_version — see its docstring for why mixed versions must not short-circuit)."""
    rows = conn.run(
        "SELECT COUNT(DISTINCT schema_version), MIN(schema_version) "
        "FROM datasource_dashboard_cards "
        "WHERE account_id='self' AND integration_id=:iid",
        iid=integration_id)
    if not rows:
        return None
    distinct, version = rows[0]
    return version if distinct == 1 and version else None


def sweep_dashboard_cards(conn, integration_id, keep_keys):
    """Delete this instance's card rows whose key is NOT in keep_keys (mark-sweep after a rebuild).
    Empty keep_keys → delete all rows for the instance."""
    conn.run(
        "DELETE FROM datasource_dashboard_cards "
        "WHERE account_id='self' AND integration_id=:iid AND card_key <> ALL(:keep)",
        iid=integration_id, keep=list(keep_keys or []))


_MAX_SCHEMA_BYTES = 256_000  # mirrors web/lib/datasource-schema.ts's MAX_SCHEMA_BYTES — same table/cap


def _trim_schema_for_cache(schema):
    """Mirror of web/lib/datasource-schema.ts trimSchemaForCache: bound an over-limit schema instead
    of caching NOTHING. Tables → 50 × 80 columns; metric schemas (Prometheus/Mimir — the connector
    cap is a name COUNT, so long-name stacks can exceed the byte cap) → labels 100 + every k-th metric
    name (interleaved, so late node_*/kube_* families survive). Always marks `truncated`."""
    if not isinstance(schema, dict):
        return schema
    if isinstance(schema.get("tables"), list):
        tables = []
        for t in schema["tables"][:50]:
            if isinstance(t, dict) and isinstance(t.get("columns"), list):
                tables.append({**t, "columns": t["columns"][:80]})
            else:
                tables.append(t)
        return {**schema, "tables": tables, "truncated": True}
    if isinstance(schema.get("metrics"), list):
        allm = schema["metrics"]
        # `probed` names present in the original list MUST survive the stride — card_catalog reads
        # "probed but absent from metrics" as a DEFINITIVE absence. `trimmed` marks a size trim.
        present = set(allm)
        keep = {p for p in schema.get("probed", []) if p in present} if isinstance(schema.get("probed"), list) else set()
        out = {**schema, "truncated": True, "trimmed": True}
        if isinstance(schema.get("labels"), list):
            out["labels"] = schema["labels"][:100]
        stride = 1
        while len(json.dumps(out).encode("utf-8")) > _MAX_SCHEMA_BYTES and stride < len(allm):
            stride *= 2
            out["metrics"] = [m for i, m in enumerate(allm) if i % stride == 0 or m in keep]
        return out
    return schema


def upsert_datasource_schema(conn, account_id, integration_id, kind, schema):
    """Write-back of a freshly re-introspected schema (drift refresh, datasource_index.py only —
    the BFF's normal warm/refresh path uses upsertSchema in web/lib/datasource-schema.ts; this is the
    python-worker-side mirror, same table). jsonb bound + cast, never inlined. Raises (caller falls
    back to the cached schema — see run()'s `fresh is not None` write-back path) when the introspected
    schema exceeds the same size cap the BFF enforces AND cannot be trimmed; a trimmable over-limit
    schema (tables / metrics) is stored as a bounded `truncated` copy, same as the BFF's upsertSchema."""
    payload = json.dumps(schema)
    if len(payload.encode("utf-8")) > _MAX_SCHEMA_BYTES:
        payload = json.dumps(_trim_schema_for_cache(schema))
        if len(payload.encode("utf-8")) > _MAX_SCHEMA_BYTES:
            raise ValueError("introspected schema exceeds size limit")
    conn.run(
        "INSERT INTO datasource_schemas (account_id, integration_id, kind, schema, fetched_at) "
        "VALUES (:acct, :iid, :k, :s::jsonb, now()) "
        "ON CONFLICT (account_id, integration_id) DO UPDATE SET "
        "kind=EXCLUDED.kind, schema=EXCLUDED.schema, fetched_at=now()",
        acct=account_id, iid=integration_id, k=kind, s=payload,
    )
