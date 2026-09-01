"""EventBridge-scheduled (hourly). Scans report_schedules for due rows and enqueues an AI-diagnosis
`report` job per due schedule — the v2 equivalent of v1's in-process report-scheduler.

Read-only effect on AWS: it only enqueues a diagnosis job (the diagnosis itself is read-only).
Idempotent against double-fire: the due rows are CLAIMED atomically by advancing next_run_at in the same
UPDATE … RETURNING (a concurrent invocation sees the advanced next_run_at and claims 0 rows). A per-row
enqueue failure is logged and does NOT block the other due schedules. Enqueue is the canonical dual-write:
db.insert_job (worker_jobs ledger) + an SQS message identical to the BFF's enqueueJob, so the existing
dispatcher→Step-Functions→Fargate path runs the report. The Fargate `_report` handler self-creates the
diagnosis_reports row when no report_id is supplied, so this dispatcher does not pre-create it.
"""
import json
import os
import uuid
from datetime import datetime, timedelta, timezone

import boto3

import db

# KST as a fixed +9 offset — Korea has no DST, so no tzdata needed in the slim image.
_KST = timezone(timedelta(hours=9))

QUEUE_URL = os.environ.get("JOBS_QUEUE_URL", "")
HOST_ACCOUNT = os.environ.get("AWS_ACCOUNT_ID", "")  # account to diagnose (single-account host)
_sqs = boto3.client("sqs", region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))

# Advance-first claim: add one interval to next_run_at for every enabled+due row, RETURNING the claimed rows.
_CLAIM_SQL = (
    "UPDATE report_schedules "
    "SET last_run_at = now(), next_run_at = now() + (CASE schedule_type "
    "  WHEN 'weekly' THEN interval '7 days' "
    "  WHEN 'biweekly' THEN interval '14 days' "
    "  ELSE interval '1 month' END) "
    "WHERE enabled = true AND next_run_at <= now() "
    "RETURNING user_sub, schedule_type, config, next_run_at"
)


def _coerce_config(config):
    """pg8000 usually returns JSONB as a dict, but tolerate a JSON string (and anything else) so a row can
    never throw AFTER the claim already advanced next_run_at (that would silently drop the scheduled run)."""
    if isinstance(config, str):
        try:
            return json.loads(config)
        except (ValueError, TypeError):
            return {}
    return config if isinstance(config, dict) else {}


def _int_in(v, lo, hi):
    return isinstance(v, int) and not isinstance(v, bool) and lo <= v <= hi


def _precise_next_run(schedule_type, cfg, claimed_next=None):
    """Next occurrence honoring the config detail fields (gap L51): dayOfWeek 0-6 (JS getDay
    convention, 0=Sun, KST) for weekly/biweekly, dayOfMonth 1-28 (KST) for monthly, hour 0-23
    (KST) for all. The precise weekday/date branch runs only when the cadence's PARTNER field
    is present — an `hour` alone keeps the coarse interval with the run hour pinned (KST),
    never inventing a run date. Returns an aware KST datetime, or None when the config carries
    no usable detail field — the caller then keeps the coarse interval the claim SQL already
    wrote (today's behavior). Runs AFTER the advance-first claim, as a follow-up UPDATE:
    idempotent, and a crash between the two UPDATEs degrades to the coarse interval (never a
    double run)."""
    dow = cfg.get("dayOfWeek")
    dom = cfg.get("dayOfMonth")
    hour = cfg.get("hour")
    has_hour = _int_in(hour, 0, 23)
    has_partner = _int_in(dom, 1, 28) if schedule_type == "monthly" else _int_in(dow, 0, 6)
    if not has_partner and not has_hour:
        return None
    h = hour if has_hour else 0
    now = datetime.now(_KST)
    if not has_partner:
        # hour-only: reuse the DATE the claim SQL already wrote (Postgres `+ interval '1 month'`
        # clamps month-ends correctly — Jan 31 → Feb 28/29) and pin only the hour. Re-deriving the
        # date here diverged from the claim on month-ends (a min(day,28) clamp permanently shifted
        # day-30/31 schedules). Without the claimed value (direct calls/tests), fall back to a
        # plain interval — weekly/biweekly are day-exact; monthly keeps the claim's value by
        # returning None (no refinement needed when we can't do better than the claim).
        if isinstance(claimed_next, datetime):
            base = claimed_next.astimezone(_KST)
            return base.replace(hour=h, minute=0, second=0, microsecond=0)
        if schedule_type in ("weekly", "biweekly"):
            cand = now + timedelta(days=7 if schedule_type == "weekly" else 14)
            return cand.replace(hour=h, minute=0, second=0, microsecond=0)
        return None
    if schedule_type in ("weekly", "biweekly"):
        py_target = (dow + 6) % 7  # JS 0=Sun → python weekday() 0=Mon
        cand = now.replace(hour=h, minute=0, second=0, microsecond=0) \
            + timedelta(days=(py_target - now.weekday()) % 7)
        if cand <= now:
            cand += timedelta(days=7)
        if schedule_type == "biweekly":
            cand += timedelta(days=7)
        return cand
    cand = now.replace(day=dom, hour=h, minute=0, second=0, microsecond=0)
    if cand <= now:  # 1-28 always exists in every month, so a +32d/day-reset hop is safe
        cand = (cand.replace(day=1) + timedelta(days=32)).replace(day=dom)
    return cand


def _create_report(conn, tier, owner_sub, model, account=None):
    """Pre-create a visible 'running' diagnosis_reports row mirroring the BFF createReport — including
    `model` (UI metadata) and `parent_report_id` (diff lineage = most-recent SUCCEEDED report of the same
    tier) — so a scheduled run is tracked, shows its model, supports regression diff, and a pre-_report
    failure is not invisible."""
    rows = conn.run(
        "INSERT INTO diagnosis_reports (worker_job_id, tier, requested_by, status, parent_report_id, model) "
        "VALUES (NULL, :t, :rb, 'running', "
        # Owner + account scoped, matching the BFF's createReport() as far as this process CAN.
        #
        # NOT full dual-key parity, and the previous comment wrongly claimed it was (PR #203 review
        # MAJOR, reported from three lenses): `ok` binds the sub ALONE. The BFF can pass
        # ownerKeysForRead() because it holds the caller's token and therefore their email; this
        # dispatcher only has report_schedules.user_sub. There is no email to bind, and inventing one
        # (a Cognito lookup per due schedule) would put an IdP call on the scheduled path for a
        # baseline hint.
        # Consequence, stated rather than hidden: while LEGACY_EMAIL_OWNER_MATCH is true and a user's
        # older reports are still email-keyed, a scheduled run finds no parent and stamps NULL. That
        # is fixed at INSERT, so a later `make backfill-owner-sub` does NOT restore the lineage — run
        # the backfill BEFORE relying on scheduled regression diffs. The log line below makes the
        # loss visible; without it the user just sees "no change" instead of "no baseline".
        # Two tiers, mirroring the BFF (PR #203 review, both directions):
        #   1. an ATTRIBUTED baseline — its job is found through the link or the payload, and its account
        #      must then match. Attributed rows never cross accounts.
        #   2. only if tier 1 is empty AND this call is not account-scoped: a row that cannot be attributed
        #      at all. The _report handler self-creates reports with worker_job_id NULL and never writes the
        #      id into the payload, so requiring attribution can leave a user with no baseline — but when an
        #      account IS named, an unattributable row cannot be shown to belong to it, and a baseline from
        #      the wrong account is worse than none (the diff would report a regression that never happened,
        #      fixed at INSERT). So tier 2 requires :acct IS NULL.
        # Payload branch fences: type = 'report' (the generic /api/jobs allowlist excludes it), same
        # owner (a type value is not provenance), and a TEXT compare against r.id::text — never a
        # ::bigint cast of the payload, since AND does not order evaluation in Postgres.
        "  COALESCE("
        "   (SELECT r.id FROM diagnosis_reports r "
        "     JOIN worker_jobs j ON (j.job_id = r.worker_job_id "
        "        OR (j.type = 'report' AND j.payload->>'report_id' = r.id::text "
        "            AND j.requested_by = r.requested_by)) "
        "    WHERE r.tier = :t AND r.requested_by = ANY(:ok) "
        "      AND r.status = 'succeeded' AND r.deleted_at IS NULL "
        "      AND (:acct IS NULL OR j.payload->>'account' = :acct) "
        "    ORDER BY r.created_at DESC LIMIT 1), "
        "   (SELECT r.id FROM diagnosis_reports r "
        "    WHERE :acct IS NULL "
        "      AND r.tier = :t AND r.requested_by = ANY(:ok) "
        "      AND r.status = 'succeeded' AND r.deleted_at IS NULL "
        "      AND NOT EXISTS (SELECT 1 FROM worker_jobs j2 "
        "                       WHERE j2.job_id = r.worker_job_id "
        "                          OR (j2.type = 'report' AND j2.payload->>'report_id' = r.id::text "
        "                              AND j2.requested_by = r.requested_by)) "
        "    ORDER BY r.created_at DESC LIMIT 1)), :m) RETURNING id",
        t=tier, rb=owner_sub, m=model, ok=[owner_sub], acct=account,
    )
    report_id = rows[0][0]
    # No parent? Say why it might be missing — but do NOT claim to know that a baseline exists.
    #
    # The first version of this check asked whether ANY email-keyed succeeded report of this tier
    # existed, which is unscoped in both directions (codex stop-gate): another user's legacy report,
    # or one from a different account, would trigger a warning about THIS schedule. And it could
    # never be scoped correctly, because the whole reason the dispatcher cannot use a dual key is
    # that it has no email for this sub — so it cannot ask "does this owner have legacy rows".
    #
    # So the warning states the situation, not a false certainty: this owner has no succeeded
    # ancestor under their sub for this tier+account, and if they have pre-cutover reports those are
    # email-keyed and invisible here. Only this owner's own rows are queried.
    try:
        own = conn.run(
            "SELECT count(*)::int FROM diagnosis_reports r "
            "  LEFT JOIN worker_jobs j ON j.job_id = r.worker_job_id "
            " WHERE r.requested_by = :rb AND r.tier = :t AND r.status = 'succeeded' "
            "   AND r.deleted_at IS NULL "
            "   AND (:acct IS NULL OR j.payload->>'account' = :acct)",
            rb=owner_sub, t=tier, acct=account)
        parent = conn.run(
            "SELECT parent_report_id FROM diagnosis_reports WHERE id = :rid", rid=report_id)
        no_parent = bool(parent) and parent[0][0] is None
        if no_parent and own and own[0][0] == 0:
            print(f"[schedule] report {report_id}: no succeeded {tier} ancestor under sub "
                  f"{owner_sub} (account {account}) — regression diff has no baseline. If this user "
                  f"ran diagnoses before the ownership cut-over those rows are email-keyed and this "
                  f"path cannot see them; run `make backfill-owner-sub` (ADR-009 Amendment step 2) "
                  f"BEFORE relying on scheduled regression diffs — parent_report_id is fixed at "
                  f"INSERT, so a later backfill does not repair it.")
    except Exception as e:  # never let a diagnostic break the enqueue
        print(f"[schedule] lineage-gap check skipped: {e}")
    return report_id


def _enqueue_report(conn, owner_sub, config):
    """`owner_sub` is the immutable Cognito sub stored in report_schedules.user_sub. Pass it through
    unchanged as requested_by; the diagnosis and jobs read paths accept both sub and identity(user)."""
    cfg = _coerce_config(config)
    account = cfg.get("account") or HOST_ACCOUNT
    tier = cfg.get("tier", "mid")
    # only the deep tier may select opus; light/mid are pinned to sonnet (matches the BFF/worker resolver).
    model = "opus" if (tier == "deep" and cfg.get("model") == "opus") else "sonnet"
    # Report output language (gap L50) — allowlist fail-closed to 'ko', matching the worker handler.
    lang = cfg.get("lang") if cfg.get("lang") in ("ko", "en", "zh", "ja") else "ko"
    report_id = _create_report(conn, tier, owner_sub, model, account)  # visible 'running' row first
    job_id = str(uuid.uuid4())
    payload = {
        "account": account,
        "tier": tier,
        "model": model,
        "lang": lang,
        "requested_by": owner_sub,
        "report_id": report_id,  # _report uses this → no duplicate self-created row
        "scheduled": True,
    }
    # requested_by=owner_sub: worker_jobs ownership must match, or GET /api/jobs/[id] (owner-or-
    # admin check) would 403 the very user this scheduled run was created for (round-2 MAJOR).
    db.insert_job(conn, job_id, "report", payload, requested_by=owner_sub)  # durable ledger row
    conn.run("UPDATE diagnosis_reports SET worker_job_id = :jid WHERE id = :rid", jid=job_id, rid=report_id)
    try:
        _sqs.send_message(
            QueueUrl=QUEUE_URL,
            MessageBody=json.dumps({"job_id": job_id, "type": "report", "payload": payload, "dry_run": False}),
        )
    except Exception:
        # Ledger row + report exist but no SFN trigger — mark the report failed (mirrors the BFF's
        # EnqueueDeliveryError handling) so it never appears stuck 'running'. Re-raise → counted as failed.
        conn.run(
            "UPDATE diagnosis_reports SET status = 'failed', error = 'enqueue delivery failed' WHERE id = :rid",
            rid=report_id,
        )
        raise
    return job_id


def lambda_handler(_event, _ctx):
    if not QUEUE_URL:
        raise RuntimeError("JOBS_QUEUE_URL is required for schedule_dispatcher")  # fail loud, not silent no-op
    conn = db.connect()
    try:
        due = conn.run(_CLAIM_SQL)  # atomic claim+advance
        enqueued, failed = [], []
        for row in due or []:
            owner_sub, _schedule_type, config, claimed_next = row[0], row[1], row[2], row[3]
            try:
                enqueued.append(_enqueue_report(conn, owner_sub, config))
                # L51: when the config carries detail fields, refine the coarse interval the
                # claim already wrote to the precise next occurrence (KST). Follow-up UPDATE by
                # the unique (user_sub, schedule_type) key — idempotent; skipped on enqueue failure
                # (the coarse advance still prevents an immediate re-claim). The `next_run_at =
                # :c` guard makes a user's concurrent save between claim and refinement win
                # instead of being overwritten.
                nxt = _precise_next_run(_schedule_type, _coerce_config(config), claimed_next)
                if nxt is not None:
                    conn.run(
                        "UPDATE report_schedules SET next_run_at = :n "
                        "WHERE user_sub = :u AND schedule_type = :t AND next_run_at = :c",
                        n=nxt, u=owner_sub, t=_schedule_type, c=claimed_next,
                    )
            except Exception as exc:  # noqa: BLE001 — one bad row must not block the rest
                print(f"schedule_dispatcher: enqueue failed for {owner_sub}: {exc}")
                failed.append(owner_sub)
        out = {"due": len(due or []), "enqueued": len(enqueued), "failed": len(failed)}
        print(f"schedule_dispatcher: {out}")
        return out
    finally:
        try:
            conn.close()
        except Exception:  # noqa: BLE001
            pass
