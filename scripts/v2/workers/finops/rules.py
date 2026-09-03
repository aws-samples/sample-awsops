"""ADR-020 active rule implementations. Each rule is `(conn, ce_calls) -> list[dict]`, where
ce_calls is a single-element list used as a mutable int counter (this PR ships no CE-calling rule
yet, so it stays 0 for now — see catalog.py / ADR-020 for the current vs. planned source list).
Each item dict has: resource_id, title, category, monthly_savings_usd (float or None — NEVER 0 as
a stand-in for "unknown"), evidence (dict, JSON-serializable), tags (dict or None), lookback_days
(int or None, passed to guards.insufficient_observation — the real Compute Optimizer signal for
"not enough data yet", not a `finding` enum value).

Amounts come from either a fixed, published AWS list-price rate (EBS: no CUR, so this is the
closest deterministic estimate available — documented per rate) or directly from an AWS
recommendation API's own estimate (Compute Optimizer) — never invented by this code.

Compute Optimizer response shapes below were verified against botocore's own service model
(`botocore.session.get_session().get_service_model("compute-optimizer")`), not hand-derived —
an earlier version of this file guessed wrong on three separate axes (finding enum casing, the
savings field's nesting, and the entire RDS response shape), which a PR review caught."""
import os
from datetime import datetime, timedelta, timezone

import boto3

_REGION = os.environ.get("AWS_REGION", "ap-northeast-2")

# Published AWS EBS $/GB-month list prices — **ap-northeast-2 (Seoul) only**, on-demand. This is a
# deterministic constant, not a CUR-derived actual — see the ADR-020 Context section: CUR/Athena
# don't exist in this repo, so an unattached volume's cost is estimated from its type+size against
# the published rate card, not read back from a bill line item. Kept IDENTICAL to
# diagnosis/sources.py's collect_idle() CASE table (the ADR-020 Context section names this exact
# duplication as one of the "three scattered places" it exists to eventually consolidate — this
# rule reuses the same numbers rather than adding a fourth, slightly different rate table to the
# pile). A PR review caught that this table was being applied to EVERY synced account/region
# (inventory_resources spans all of them) as if it were a universal rate — see _PRICED_REGIONS.
# NOTE: no "default" key — a later review round caught that falling back to an invented rate for
# an unrecognized/future volume type (inherited from diagnosis/sources.py's ELSE 0.10 CASE, which
# predates this ADR's "amounts are never invented" invariant) produced a confident dollar amount
# for something genuinely unpriced, exactly the failure mode _PRICED_REGIONS exists to prevent for
# regions. An unlisted type now gets the same NULL + evidence-marker treatment as an unpriced
# region (see the lookup below), never a guessed number.
_EBS_GB_MONTH_USD = {
    "gp3": 0.0912, "gp2": 0.114, "io1": 0.125, "io2": 0.125,
    "st1": 0.045, "sc1": 0.025,
}

# Only ap-northeast-2 has a published rate in _EBS_GB_MONTH_USD above — pricing a us-east-1 (or any
# other) volume against Korea list rates would present a confident, wrong dollar amount, in direct
# tension with this ADR's own "amounts are never invented" invariant. A row outside this set still
# surfaces (never silently hidden — the ADR's discard-hiding-is-worse-than-honest-NULL discipline),
# but with monthly_savings_usd=None rather than a misleading number.
_PRICED_REGIONS = {"ap-northeast-2"}


def _co_client():
    return boto3.client("compute-optimizer", region_name=_REGION)


# A review round correctly caught that AccessDeniedException must not degrade to an empty (and
# therefore "confirmed clean") result — it is exactly as likely to mean "an IAM/SCP policy
# regressed" as anything else (this ADR itself exists partly because a Cost Optimization Hub
# AccessDenied went unnoticed for months — see the CHANGELOG entry). A LATER review round caught
# that OptInRequiredException/SubscriptionRequiredException deserve the identical treatment: an
# opt-out (or a support-plan lapse) is a DATA-AVAILABILITY state, not evidence that yesterday's
# real EC2/RDS rightsizing findings were fixed. Every Compute Optimizer exception — opt-out,
# AccessDenied, throttling, a malformed response, page-bound truncation — therefore now propagates
# uniformly to engine.py's per-rule try/except, which marks the run `partial` and skips
# resolve_stale for this rule THIS RUN, leaving yesterday's real findings untouched instead of a
# transient (or permanent-but-still-not-"confirmed-clean") state wiping them.


# inventory_resources is populated by the Steampipe inv_sync Lambda on a 15-min cadence when
# steampipe_enabled=true — but ADR-020 deliberately requires only workers_enabled, so
# finops_baseline can run with steampipe_enabled=false, or with a sync that has stopped updating.
# Either way, that must not be treated as "confirmed zero unattached volumes" (see
# _require_fresh_inventory below). NOTE: this must NOT be judged from inventory_resources row
# counts — a resource_type with genuinely zero live resources (e.g. an account with no EBS volumes
# at all) produces zero inventory_resources rows on a perfectly healthy, successful sync, which
# looked identical to "sync never ran" under an earlier version of this check and wrongly refused
# to resolve real stale findings forever. inventory_sync_runs is the correct signal: sync_lambda.py
# writes exactly one row per resource_type (keyed under the 'self' sentinel — a job-level ledger,
# not per scanned account) with status/finished_at/row_count, INCLUDING a `row_count=0,
# status='succeeded'` row when the sync ran fine and genuinely found nothing.
_INVENTORY_STALE_AFTER_HOURS = 24


def _require_fresh_inventory(conn, resource_type):
    """Raise (not return-empty) unless inventory_sync_runs shows inventory for `resource_type`
    that is fresh within _INVENTORY_STALE_AFTER_HOURS. The PRIMARY signal is the durable
    `last_success_at` column: a later `partial` run (one SDK sub-call failed) preserves every
    last-good row and does NOT reset that marker, so it — not the latest run's status — is the
    honest freshness signal. The legacy latest-run `status == 'succeeded'` check remains only as
    the fallback for pre-migration ledger rows where `last_success_at` was never populated.
    No row / never-succeeded / stale all mean "this rule cannot honestly evaluate this run" —
    letting the caller return [] here would make engine.run()'s resolve_stale wipe every real
    prior finding for the rule, mistaking absent/stale/failed sync state for a confirmed clean
    result (the same class of bug the Compute Optimizer rules fix for a different data source).
    A successful run with row_count=0 passes this check — that IS a trustworthy true zero, not
    treated as unavailable."""
    rows = conn.run(
        "SELECT status, finished_at, last_success_at FROM inventory_sync_runs WHERE resource_type = :rt AND account_id = 'self'",
        rt=resource_type,
    )
    if not rows:
        raise RuntimeError(
            f"inventory_sync_runs has no row for {resource_type!r} — Steampipe inv_sync is "
            f"disabled or has never run; treating as data-unavailable rather than 'confirmed none found'"
        )
    status, finished_at, last_success_at = rows[0]
    if last_success_at is not None:
        # Durable success marker (freshness migration): a later 'partial' run preserves
        # every last-good row AND leaves last_success_at at the last fully-successful
        # sweep, so it — not the latest run's status — is the honest freshness signal.
        if _is_stale(last_success_at, _INVENTORY_STALE_AFTER_HOURS):
            raise RuntimeError(
                f"inventory_sync_runs for {resource_type!r} last fully succeeded at "
                f"{last_success_at} (> {_INVENTORY_STALE_AFTER_HOURS}h ago) — treating as "
                f"data-unavailable rather than 'confirmed none found'"
            )
        return
    # Pre-freshness ledger rows (last_success_at never populated): fall back to the
    # legacy latest-run contract.
    if status != "succeeded" or finished_at is None:
        raise RuntimeError(
            f"inventory_sync_runs for {resource_type!r} is status={status!r} (not a completed "
            f"succeeded run) — treating as data-unavailable rather than 'confirmed none found'"
        )
    if _is_stale(finished_at, _INVENTORY_STALE_AFTER_HOURS):
        raise RuntimeError(
            f"inventory_sync_runs for {resource_type!r} last succeeded at {finished_at} "
            f"(> {_INVENTORY_STALE_AFTER_HOURS}h ago) — treating as data-unavailable rather than "
            f"'confirmed none found'"
        )


def _is_stale(ts, hours):
    if ts is None:
        return True
    now = datetime.now(timezone.utc)
    ts_utc = ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)
    return now - ts_utc > timedelta(hours=hours)


def ebs_unattached(conn, ce_calls):
    """Unattached (state='available') EBS volumes from the synced inventory. Pure storage cost —
    no compute is running against it. Reads inventory_resources directly (worker DB role), NOT the
    curated sql_reader view inventory_read_mcp.py uses — the same underlying detection signal
    (`state == 'available'`) as that tool's `find_unused_resources`, kept independently here because
    that tool is agent-chat-facing and this path must not depend on AgentCore being enabled.

    _require_fresh_inventory only proves the JOB as a whole succeeded recently — sync_lambda.py's
    own M5 guard deliberately PRESERVES (never prunes) an unreachable account's rows rather than
    deleting them, so a row can come back from a "succeeded" job while itself being weeks old
    (job-level success masking stale per-account data). Each row's own `captured_at` is therefore
    also checked here, per-row, and a stale one is demoted via the guard mechanism (visible,
    flagged `stale_inventory_data`, and — because it's still returned — protected from
    engine.run()'s resolve_stale, instead of being silently trusted as confirmed-current evidence
    or silently dropped from the seen-set and wrongly resolved)."""
    _require_fresh_inventory(conn, "ebs_volume")
    rows = conn.run(
        "SELECT resource_id, account_id, region, data, captured_at FROM inventory_resources "
        "WHERE resource_type = 'ebs_volume' AND data->>'state' = 'available'"
    )
    out = []
    for resource_id, account_id, region, data, captured_at in rows or []:
        size = data.get("size")
        vtype = (data.get("volume_type") or "").lower()
        rate = _EBS_GB_MONTH_USD.get(vtype) if region in _PRICED_REGIONS else None
        # A PR review caught that the GB-rate alone materially understates io1/io2/gp3 cost — the
        # provisioned-IOPS charge routinely dominates io1/io2 (e.g. a 100 GiB io2 volume at 5,000
        # IOPS: storage ~$12.50/mo vs. IOPS in the hundreds/mo), and gp3 bills for IOPS/throughput
        # above its free baseline (3,000 IOPS / 125 MiB/s) too. `sync_lambda.py` captures `iops`
        # but NOT gp3's throughput at all — a follow-up review round correctly caught that an
        # earlier version of this fix only demoted gp3 when `iops > 3000`, which is unsound:
        # a gp3 volume can sit at baseline IOPS while still having PROVISIONED THROUGHPUT above
        # the free tier, and that charge is entirely invisible with no signal to gate on. Since
        # there is no way to price ANY of io1/io2/gp3 completely without inventing a number this
        # ADR's own invariant forbids, all three demote to NULL + a `partial_rate` evidence marker
        # unconditionally — same treatment as an unpriced region/type, and for the same reason.
        needs_iops_pricing_not_available = vtype in ("io1", "io2", "gp3")
        if needs_iops_pricing_not_available:
            rate = None
        savings = round(size * rate, 2) if (rate is not None and size) else None
        evidence = {"account_id": account_id, "region": region, "size_gib": size, "volume_type": vtype,
                    "rate_usd_per_gb_month": rate, "captured_at": str(captured_at)}
        if region not in _PRICED_REGIONS:
            evidence["unpriced_region"] = region
        elif needs_iops_pricing_not_available:
            evidence["partial_rate"] = "provisioned IOPS/throughput charges not priced"
        elif rate is None:
            evidence["unpriced_volume_type"] = vtype
        out.append({
            "resource_id": resource_id,
            "account_id": account_id,
            "region": region,
            "title": f"Unattached EBS volume {resource_id} ({size or '?'} GiB, {vtype})",
            "category": "storage",
            "monthly_savings_usd": savings,
            "evidence": evidence,
            "tags": data.get("tags") or {},
            "lookback_days": None,  # not a Compute Optimizer finding — this guard never applies here
            "stale": _is_stale(captured_at, _INVENTORY_STALE_AFTER_HOURS),
        })
    out.extend(_ebs_stale_account_coverage_gaps(conn))
    return out


def _ebs_stale_account_coverage_gaps(conn):
    """Surfaces the false-clean gap the per-row stale guard above cannot see: `WHERE
    data->>'state' = 'available'` is evaluated against a SNAPSHOT — if an account's whole
    ebs_volume snapshot is stale (sync_lambda.py's M5 guard preserves an unreachable account's
    rows rather than pruning them), a volume that was `in-use` at snapshot time and has since
    become genuinely unattached produces NO row here at all: no finding, no guard, no coverage
    signal, while the run still records `succeeded`. That can't be fixed by re-deriving "is it
    unattached now" from stale data — the only honest fix is to surface the coverage gap itself,
    so a viewer can tell "confirmed no waste" apart from "this account's data is too old to know."
    Emits one coverage-gap item per stale (account_id, region) scope (NULL amount, `stale=True` so
    the existing stale_inventory_data guard covers it, never counted as `active` savings).

    DELIBERATELY NOT DETECTED HERE: an account with zero ebs_volume rows. A previous revision
    cross-referenced the `accounts` registry and flagged any enabled account with no rows as
    "never synced" — a stop-time review correctly caught that as a false-coverage-failure
    generator, and it is the same mistake this module's own _require_fresh_inventory comment warns
    against: **row absence is not a sync-failure signal.** An account that genuinely owns no EBS
    volumes produces zero rows on a perfectly healthy sync, and `inventory_sync_runs` is a
    JOB-level ledger keyed under the `'self'` sentinel (see _require_fresh_inventory) — there is
    no per-account row to distinguish "this account's connection failed" from "this account has no
    volumes." So that detector would have flagged every volume-less account as a permanent
    coverage failure on every run. Closing this properly needs a per-account sync ledger from
    sync_lambda.py, which is out of scope here; until then _require_fresh_inventory's job-level
    check is the honest bound on what this rule can claim."""
    rows = conn.run(
        "SELECT account_id, region, MAX(captured_at) FROM inventory_resources "
        "WHERE resource_type = 'ebs_volume' GROUP BY account_id, region"
    )
    out = []
    for account_id, region, latest_captured_at in rows or []:
        if not _is_stale(latest_captured_at, _INVENTORY_STALE_AFTER_HOURS):
            continue
        out.append({
            "resource_id": f"__coverage_gap__:stale:{account_id}:{region}",
            "account_id": account_id,
            "region": region,
            "title": f"EBS inventory data for {account_id}/{region} is stale — unattached-volume "
                     f"coverage may be incomplete",
            "category": "storage",
            "monthly_savings_usd": None,
            "evidence": {"account_id": account_id, "region": region,
                         "latest_captured_at": str(latest_captured_at), "coverage_gap": True},
            "tags": {},
            "lookback_days": None,
            "stale": True,
        })
    return out


# Safety bound on pagination — protects against a runaway loop on a malformed/looping nextToken,
# not a real-world account size limit (500 recommendations of either kind would be unusual). If
# the bound is hit and a nextToken is STILL present, the result is a silent partial truncation —
# raising (not returning the partial list) so engine.py skips resolve_stale for this run rather
# than resolving everything past page 5 as if it no longer existed.
_CO_MAX_PAGES = 5

# `lookBackPeriodInDays`/`lookbackPeriodInDays` (passed through as `lookback_days` below) is the
# REAL per-recommendation "not enough data yet" signal — there is no "INSUFFICIENT_DATA" value in
# either API's `finding` enum (verified against botocore's service model); an earlier version of
# this file checked for one that can never appear, making guards.insufficient_observation
# permanently dead code. The actual threshold lives in guards.py, next to the guard itself.


def _co_page(get_fn, list_key):
    """Shared pagination helper: yields each page's raw response dict. Raises RuntimeError if the
    page bound is hit with a nextToken still present (truncated, not exhausted) — see _CO_MAX_PAGES.

    Also raises on a non-empty `errors` array (verified present on both GetEC2InstanceRecommendations
    and GetRDSDatabaseRecommendations via botocore's service model: `GetRecommendationError` with
    identifier/code/message). A review round caught that this in-band per-object/per-account failure
    channel was silently ignored — the HTTP call succeeds, some resources are missing from the
    result for a reason the response itself reports, and without this check that missing coverage
    reads as "confirmed none found" and resolve_stale wipes real prior findings for it — the exact
    failure class this file's exception-propagation-over-degrading design otherwise prevents."""
    token = None
    for i in range(_CO_MAX_PAGES):
        kwargs = {"maxResults": 100}
        if token:
            kwargs["nextToken"] = token
        resp = get_fn(**kwargs)
        errors = resp.get("errors") or []
        if errors:
            raise RuntimeError(
                f"{list_key} response reported {len(errors)} in-band error(s) — e.g. "
                f"{errors[0].get('code')}: {errors[0].get('message')} — treating the result as "
                f"incomplete rather than a confirmed full list"
            )
        yield resp
        token = resp.get("nextToken")
        if not token:
            return
    raise RuntimeError(
        f"{list_key} pagination hit the {_CO_MAX_PAGES}-page safety bound with a nextToken still "
        f"present — result is a silent partial truncation, not a complete list"
    )


def _preferred_savings(option):
    """Returns (value, basis) from a Compute Optimizer recommendation option. A review round
    caught both rightsizing rules reading only `savingsOpportunity` (Compute Optimizer's
    on-demand-rate estimate) — for a fleet covered by Reserved Instances/Savings Plans, the actual
    dollar impact of following the recommendation is `savingsOpportunityAfterDiscounts`, which can
    differ materially from the on-demand figure. That's the same "confident but misleading amount"
    class this file demotes rate-card figures for elsewhere, just via a wrong basis instead of a
    missing rate. Prefers the after-discounts value when Compute Optimizer provides one; falls
    back to the on-demand estimate otherwise (both fields verified present on both EC2's and RDS's
    option shapes via botocore's service model)."""
    after_discounts = (option.get("savingsOpportunityAfterDiscounts") or {}).get(
        "estimatedMonthlySavings", {}).get("value")
    if isinstance(after_discounts, (int, float)):
        return after_discounts, "after_discounts"
    on_demand = (option.get("savingsOpportunity") or {}).get("estimatedMonthlySavings", {}).get("value")
    return on_demand, "on_demand"


def ec2_rightsizing(conn, ce_calls):
    """EC2 rightsizing via Compute Optimizer, paginated (a single maxResults=100 page silently
    truncated large accounts). Registered as ITS OWN catalog rule (not merged with RDS) so that an
    error here does not also skip the RDS call, and — the more important half — so that
    engine.py's per-rule resolve_stale only ever resolves EC2-rightsizing findings against an
    EC2-rightsizing result set, never against a result set that silently dropped EC2 because the
    RDS call (or vice versa) happened to fail first inside a combined function.

    Every exception (opt-out, AccessDenied, throttling, a transient AWS-side error, a malformed
    response, page-bound truncation) propagates uniformly to engine.py's per-rule try/except,
    which marks the run `partial` and skips resolve_stale for this rule THIS RUN, leaving
    yesterday's real findings untouched instead of some being wiped by a state that looks like
    "confirmed clean" but isn't ("falsely resolved" — the bug a PR review caught this rule doing
    under the wrong enum values anyway, since the finding filter below never matched anything
    before that fix).

    COVERAGE SCOPE (PR review, deliberate, not yet closed): Compute Optimizer is a per-region
    endpoint, and this call only queries `_REGION` (the worker's host region). A resource in any
    other region is invisible to this rule while the run still reports `succeeded` — unlike
    ebs_unattached, which spans every synced account/region and surfaces its own gaps via
    _ebs_stale_account_coverage_gaps. Every finding's evidence carries `coverage:
    "host-region-only"` so this is visible per-row rather than silently assumed global; closing
    it for real needs iterating CO over the account's enabled regions (tracked as follow-up, out
    of scope for this pass)."""
    co = _co_client()
    out = []
    for resp in _co_page(co.get_ec2_instance_recommendations, "EC2"):
        for r in resp.get("instanceRecommendations", []):
            # Wire values are CamelCase (verified against botocore's service model), not the
            # SCREAMING_SNAKE_CASE an earlier version of this file guessed — that guess matched
            # zero rows, ever.
            finding = r.get("finding")
            if finding not in ("Overprovisioned", "NotOptimized"):
                continue  # Underprovisioned / Optimized are not cost-saving opportunities
            options = sorted(r.get("recommendationOptions") or [], key=lambda o: o.get("rank", 999))
            if not options:
                # A review round caught this asymmetric with rds_rightsizing (which already
                # skips a no-option row below) — a Finding of Overprovisioned/NotOptimized with
                # no recommendation option has nothing actionable to show, and previously produced
                # a "? -> ?" title with no savings figure at all.
                continue
            top = options[0]
            savings, savings_basis = _preferred_savings(top)
            arn = r.get("instanceArn", "")
            out.append({
                "resource_id": arn,
                "account_id": "self",  # Compute Optimizer is called against the host account only
                "region": _REGION,
                "title": f"EC2 rightsizing: {r.get('currentInstanceType', '?')} -> "
                         f"{top.get('instanceType', '?')} ({r.get('instanceName') or arn.rsplit('/', 1)[-1]})",
                "category": "compute",
                "monthly_savings_usd": round(savings, 2) if isinstance(savings, (int, float)) else None,
                # 리뷰 MAJOR(PR #232): Compute Optimizer 엔드포인트는 리전별이라 _REGION(host)에서만
                # 호출한다 — 다른 리전의 rightsizing 기회는 이 룰에 전혀 나타나지 않는데도 run은
                # 'succeeded'로 기록된다. EBS 룰(_ebs_stale_account_coverage_gaps)의 "결손은 항상
                # 드러낸다" 기준과 동일하게, 여기도 evidence에 명시적 커버리지 마커를 남긴다 —
                # 값을 발명하지 않고 범위를 정직하게 고지하는 쪽(리뷰 제안 1의 2안: 문서화+고지).
                "evidence": {"current_type": r.get("currentInstanceType"), "recommended_type": top.get("instanceType"),
                             "finding": finding, "performance_risk": top.get("performanceRisk"),
                             "lookback_days": r.get("lookBackPeriodInDays"), "savings_basis": savings_basis,
                             "coverage": "host-region-only", "coverage_region": _REGION},
                "tags": {t.get("key"): t.get("value") for t in (r.get("tags") or [])},
                "lookback_days": r.get("lookBackPeriodInDays"),
            })
    return out


def rds_rightsizing(conn, ce_calls):
    """RDS rightsizing via Compute Optimizer, paginated. See ec2_rightsizing's docstring — the
    same independent-rule + paginate + let-every-exception-propagate reasoning applies here.
    NOTE: the response shape is NOT a copy of the EC2 one — `GetRDSDatabaseRecommendations`
    returns `rdsDBRecommendations` with `instanceRecommendationOptions` and a SEPARATE
    `instanceFinding`/`storageFinding` pair (verified against botocore's service model); an earlier
    version of this file assumed the EC2 field names and iterated zero rows, ever."""
    co = _co_client()
    out = []
    for resp in _co_page(co.get_rds_database_recommendations, "RDS"):
        for r in resp.get("rdsDBRecommendations", []):
            finding = r.get("instanceFinding")
            if finding != "Overprovisioned":
                # Underprovisioned is an upscale recommendation — not a savings opportunity;
                # surfacing it here (as an earlier version of this file did unconditionally)
                # would show "recommend a BIGGER instance" as a cost-saving finding.
                continue
            options = sorted(r.get("instanceRecommendationOptions") or [], key=lambda o: o.get("rank", 999))
            if not options:
                continue  # no recommendation option -> nothing actionable to show
            top = options[0]
            savings, savings_basis = _preferred_savings(top)
            arn = r.get("resourceArn", "")
            out.append({
                "resource_id": arn,
                "account_id": "self",  # Compute Optimizer is called against the host account only
                "region": _REGION,
                "title": f"RDS rightsizing: {r.get('currentDBInstanceClass', '?')} -> "
                         f"{top.get('dbInstanceClass', '?')} ({arn.rsplit(':', 1)[-1]})",
                "category": "database",
                "monthly_savings_usd": round(savings, 2) if isinstance(savings, (int, float)) else None,
                # See the matching comment in ec2_rightsizing — same host-region-only gap, same fix.
                "evidence": {"current_class": r.get("currentDBInstanceClass"),
                             "recommended_class": top.get("dbInstanceClass"), "engine": r.get("engine"),
                             "finding": finding, "lookback_days": r.get("lookbackPeriodInDays"),
                             "savings_basis": savings_basis,
                             "coverage": "host-region-only", "coverage_region": _REGION},
                "tags": {t.get("key"): t.get("value") for t in (r.get("tags") or [])},
                "lookback_days": r.get("lookbackPeriodInDays"),
            })
    return out
