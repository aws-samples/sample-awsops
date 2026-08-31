"""ADR-020 FinOps baseline engine — orchestrates the run: evaluate every active catalog rule,
apply guards, upsert findings (dedupe key: rule_id + resource_id), resolve findings that stopped
reproducing, and (best-effort) attach an LLM explanation to anything new or changed this run.

Amounts and status are decided entirely above the LLM line (catalog.py + rules.py + guards.py); this
module never computes a dollar figure itself. One rule raising does NOT fail the run or touch that
rule's existing findings (a partial batch is better than none, and a transient AWS API error must
not resolve-away yesterday's real findings for that rule)."""
from . import catalog, guards, llm


def _start_run(conn):
    rows = conn.run("INSERT INTO finops_runs (status) VALUES ('running') RETURNING id")
    return rows[0][0]


def _finish_run(conn, run_id, *, status, rules_evaluated, findings_count, ce_api_calls, error=None):
    conn.run(
        "UPDATE finops_runs SET status=:s, finished_at=now(), rules_evaluated=:re, "
        "findings_count=:fc, ce_api_calls=:ce, error=:e WHERE id=:id",
        s=status, re=rules_evaluated, fc=findings_count, ce=ce_api_calls, e=error, id=run_id,
    )


def _upsert_finding(conn, run_id, rule_id, item, status, guard_hits):
    import json
    rows = conn.run(
        "INSERT INTO finops_findings "
        "  (run_id, rule_id, account_id, region, resource_id, title, category, status, "
        "   monthly_savings_usd, evidence, guard_hits, first_seen_at, last_seen_at) "
        "VALUES (:run_id, :rule_id, :acct, :region, :rid, :title, :cat, :status, :savings, "
        "        :ev::jsonb, :guards, now(), now()) "
        "ON CONFLICT (rule_id, account_id, region, resource_id) DO UPDATE SET "
        "  run_id = EXCLUDED.run_id, title = EXCLUDED.title, category = EXCLUDED.category, "
        "  status = EXCLUDED.status, monthly_savings_usd = EXCLUDED.monthly_savings_usd, "
        # A stale explanation_ko sitting next to a changed amount ("월 $9.12 절감" next to today's
        # $12.40) is exactly the kind of confident-looking-but-wrong text the LLM layer's
        # discard-on-contradiction check exists to prevent — except this path bypasses that check
        # entirely, since the OLD explanation was never re-evaluated against the NEW number. The
        # LLM prompt (llm.explain) is built from title + category + evidence + monthly_savings_usd
        # together, so checking amount alone is not enough: a rule can change the CURRENT/RECOMMENDED
        # instance type or the underlying evidence (region, size, rate) while the dollar figure
        # happens to stay the same, leaving an explanation that quotes the right number next to now-
        # wrong specifics. Clear it whenever ANY of the fields the prompt was built from changed
        # (IS DISTINCT FROM handles the NULL-to-NULL and NULL-to-value cases correctly); an
        # unchanged finding keeps its explanation instead of needlessly re-prompting the LLM every day.
        "  explanation_ko = CASE WHEN finops_findings.monthly_savings_usd IS DISTINCT FROM EXCLUDED.monthly_savings_usd "
        "                          OR finops_findings.title IS DISTINCT FROM EXCLUDED.title "
        "                          OR finops_findings.category IS DISTINCT FROM EXCLUDED.category "
        "                          OR finops_findings.evidence IS DISTINCT FROM EXCLUDED.evidence "
        "                        THEN NULL ELSE finops_findings.explanation_ko END, "
        "  evidence = EXCLUDED.evidence, guard_hits = EXCLUDED.guard_hits, "
        "  last_seen_at = now(), resolved_at = NULL "
        "RETURNING id",
        run_id=run_id, rule_id=rule_id, acct=item.get("account_id") or "self", region=item.get("region") or "",
        rid=item["resource_id"], title=item["title"], cat=item["category"],
        status=status, savings=item.get("monthly_savings_usd"), ev=json.dumps(item.get("evidence") or {}),
        guards=guard_hits,
    )
    return rows[0][0]


def _resolve_stale(conn, rule_id, seen_scoped_ids):
    """Findings for this rule that existed before but were NOT reproduced this run -> resolved.
    Only called for a rule that evaluated successfully this run (see run() below) — a rule that
    raised must never resolve-away its own prior findings.

    `seen_scoped_ids` is a set of "account_id\\x1fregion\\x1fresource_id" strings, not bare
    resource_ids — a PR review caught that resource_id alone is not a safe identity: EBS reads
    inventory_resources across every synced account/region, and a resource_id collision across
    two scopes would let one account's still-true finding be wrongly resolved because a
    DIFFERENT account's same-shaped id stopped reproducing this run."""
    conn.run(
        "UPDATE finops_findings SET status='resolved', resolved_at=now() "
        "WHERE rule_id=:rid AND status != 'resolved' "
        "  AND (account_id || chr(31) || region || chr(31) || resource_id) != ALL(:seen)",
        rid=rule_id, seen=list(seen_scoped_ids) or [""],
    )


_EXPLAIN_BUDGET_SECONDS = 300  # wall-clock cap on the whole explain phase — see docstring below


def _explain_pending(conn):
    """Best-effort: attach an LLM explanation to any finding missing one. Bounded per run (a
    daily batch, not a chat request) — a slow/throttled Bedrock call degrades that one row to
    explanation_ko=NULL, never blocks the others or fails the run.

    A review round caught this loop running BEFORE `_finish_run`, with no bound on total time: up
    to 200 sequential `invoke_model` calls, each able to take the full botocore timeout×retries,
    ran inside the SFN Fargate task's TimeoutSeconds budget (3600s in base sfn.asl.json). A
    hanging/slow Bedrock endpoint could burn that whole budget AFTER the deterministic findings
    were already upserted, killing the task and landing the run `failed` (via the reaper) over a
    batch that was otherwise materially successful — the exact "looks broken but wasn't" outcome
    this ADR's honest-degradation design exists to avoid. `_BEDROCK_CONFIG` in llm.py bounds each
    individual call; this wall-clock check bounds how many of them run in total. Remaining
    NULL-explanation rows are simply picked up by tomorrow's run — explanations are cosmetic, not
    load-bearing (per this module's own docstring, the feature works fully without this layer)."""
    import time
    deadline = time.monotonic() + _EXPLAIN_BUDGET_SECONDS
    rows = conn.run(
        "SELECT id, title, category, monthly_savings_usd, evidence FROM finops_findings "
        "WHERE status != 'resolved' AND explanation_ko IS NULL LIMIT 200"
    )
    for fid, title, category, savings, evidence in rows or []:
        if time.monotonic() >= deadline:
            print(f"[finops] _explain_pending hit its {_EXPLAIN_BUDGET_SECONDS}s budget — "
                  f"leaving remaining rows for the next run")
            break
        text = llm.explain(title, category, savings, evidence)
        if text:
            conn.run("UPDATE finops_findings SET explanation_ko=:t WHERE id=:id", t=text, id=fid)


def run(_payload, conn):
    run_id = _start_run(conn)
    ce_calls = [0]
    evaluated, persisted = 0, 0
    failed_rules = []  # [(rule_id, error message)] — a rule failing must be VISIBLE, not silently
    # absorbed into an otherwise-identical 'succeeded' run. Without this, a permanently-failing
    # rule (e.g. steampipe_enabled=false making ebs_unattached raise every single run) means that
    # rule NEVER evaluates, nothing surfaces it anywhere, and the card/API present a normal-looking
    # "succeeded, N findings" result over a run that quietly skipped part of the catalog forever.
    try:
        for rule in catalog.active_rules():
            evaluated += 1
            try:
                items = rule["fn"](conn, ce_calls)
            except Exception as e:  # noqa: BLE001 — one rule's failure must not sink the batch
                msg = str(e)[:500]
                print(f"[finops] rule {rule['id']} failed (skipped this run, prior findings untouched): {msg}")
                failed_rules.append((rule["id"], msg))
                continue
            seen = []
            for item in items:
                hits = guards.guard_hits(tags=item.get("tags"), lookback_days=item.get("lookback_days"),
                                         stale=item.get("stale", False))
                status = "needs_review" if hits else "active"
                _upsert_finding(conn, run_id, rule["id"], item, status, hits)
                seen.append(f"{item.get('account_id') or 'self'}\x1f{item.get('region') or ''}\x1f{item['resource_id']}")
                persisted += 1
            _resolve_stale(conn, rule["id"], seen)
        _explain_pending(conn)
        status = "partial" if failed_rules else "succeeded"
        error = "; ".join(f"{rid}: {msg}" for rid, msg in failed_rules)[:2000] if failed_rules else None
        _finish_run(conn, run_id, status=status, rules_evaluated=evaluated,
                    findings_count=persisted, ce_api_calls=ce_calls[0], error=error)
        return {"run_id": run_id, "rules_evaluated": evaluated, "findings_count": persisted,
                "ce_api_calls": ce_calls[0], "status": status, "failed_rules": [rid for rid, _ in failed_rules]}
    except Exception as e:  # noqa: BLE001 — surface on the run row, then re-raise (SFN Catch -> failed)
        _finish_run(conn, run_id, status="failed", rules_evaluated=evaluated,
                    findings_count=persisted, ce_api_calls=ce_calls[0], error=str(e)[:2000])
        raise
