"""SG Rules & Usage — daily scan handler (`sg_rule_scan` job, Fargate runtime).

Per source, in order (design spec's "Daily pipeline" section):
  1. validate the saved source metadata (sg_flow_sources)
  2. snapshot current SGRs (DescribeSecurityGroupRules) + ENI-SG memberships
     (DescribeNetworkInterfaces) -> upsert sg_rule_inventory + append-only
     sg_rule_inventory_versions
  3. compute the next unprocessed completed UTC day, honoring SG_RULE_DELIVERY_LAG_HOURS
  4. ONE Athena query for that account/region/day via the isolated broker Lambda
     (sg_rule_athena_broker.py — this module never assumes AWSopsSgRuleAthenaRole itself)
  5. select/aggregate only the fields needed
  6. match accepted flows against candidate rules (sg_rule_matching.py)
  7. one transaction: delete+insert that day's sg_rule_activity_daily rows, write
     sg_rule_scan_runs coverage
  8. advance the watermark only after the transaction commits
  9. separately, re-run the trailing SG_RULE_RESCAN_WINDOW_DAYS as an idempotent re-run (never
     moves the watermark backward)

Cross-account access uses TWO separate roles, never conflated (ADR-019 §4):
  - Role A (rule inventory / ENI describe): the existing, reused AWSopsReadOnlyRole — the SAME
    trust boundary the web task role / Steampipe task role / agent Lambda already assume.
  - Role B (Athena query): the isolated AWSopsSgRuleAthenaRole, assumed ONLY by the broker Lambda
    (sg_rule_athena_broker.py) — this module talks to the broker via lambda:InvokeFunction, never
    assumes that role directly.
"""
import datetime as dt
import json
import os
import uuid

import boto3

import sg_rule_matching as sm

DELIVERY_LAG_HOURS = int(os.environ.get("SG_RULE_DELIVERY_LAG_HOURS", "6"))
# item 3 follow-up fix: sg_rule_inventory_versions.valid_from/valid_to are observation timestamps
# (set by THIS scan's own run time), not the actual rule-change timestamp — see
# sm.day_coverage()'s docstring. The scan is nominally scheduled every SCAN_INTERVAL_HOURS (the
# EventBridge daily-trigger cadence, `rate(24 hours)` in sg-rules.tf) — but item 2 follow-up fix
# (round 2): this constant is NO LONGER fed into `sm.day_coverage()`'s `observation_lag` directly.
# A fixed nominal cadence is wrong whenever scans are actually delayed or missed for multiple days
# in a row — see `previous_successful_scan_gap()` below, which derives the REAL elapsed gap from
# `sg_rule_scan_runs` instead. `SCAN_INTERVAL_HOURS` below is NOT wired into any runtime decision
# in this module (or anywhere else) — it exists PURELY as documentation of the EventBridge
# scheduled cadence (`rate(24 hours)` in sg-rules.tf), for a human reading this file to cross-check
# against the actual Terraform schedule. If it's ever wired to something (e.g. an eligibility or
# alerting threshold), update this comment accordingly.
SCAN_INTERVAL_HOURS = int(os.environ.get("SG_RULE_SCAN_INTERVAL_HOURS", "24"))  # descriptive only
MEMBERSHIP_STALENESS_DAYS = int(os.environ.get("SG_RULE_MEMBERSHIP_STALENESS_DAYS", "3"))
RESCAN_WINDOW_DAYS = int(os.environ.get("SG_RULE_RESCAN_WINDOW_DAYS", "2"))
MAX_QUERY_BYTES = int(os.environ.get("SG_RULE_ACTIVITY_MAX_QUERY_BYTES", "107374182400"))
HOST_ACCOUNT_ID = os.environ.get("AWS_ACCOUNT_ID", "")
READONLY_ROLE_NAME = "AWSopsReadOnlyRole"


class SourceNotConfigured(Exception):
    pass


class SourceInvalid(Exception):
    pass


class AccountNotRegistered(Exception):
    """Round-4 CI-review finding (L3, item 2): raised by `account_external_id` when `account_id`
    has no enabled row in the `accounts` table — the SAME confused-deputy guard
    `sg_rule_athena_broker.py`'s `_resolve_external_id` already enforces for Role B. Before this
    fix, `account_external_id` resolved external_id with a bare `SELECT ... WHERE account_id=:a`
    (no `AND enabled`) and fell back to `None` on a miss, so `_assumed_session` below would still
    attempt `sts:AssumeRole` into `AWSopsReadOnlyRole` with NO ExternalId for a disabled or
    unregistered account — disabling an account never revoked Role A access."""
    pass


# ── Source metadata + cross-account clients (Role A) ─────────────────────────────────────────────

def load_source(conn, account_id, region):
    rows = conn.run(
        "SELECT id, account_id, region, workgroup, database_name, table_name, enabled, validation, "
        "created_at FROM sg_flow_sources WHERE account_id=:a AND region=:r",
        a=account_id, r=region)
    if not rows:
        raise SourceNotConfigured(f"no sg_flow_sources row for {account_id}/{region}")
    cols = ["id", "account_id", "region", "workgroup", "database_name", "table_name", "enabled",
            "validation", "created_at"]
    row = dict(zip(cols, rows[0]))
    if not row["enabled"]:
        raise SourceNotConfigured(f"source {account_id}/{region} is disabled")
    validation = row["validation"]
    if isinstance(validation, str):
        try:
            validation = json.loads(validation)
        except (ValueError, TypeError):
            validation = {}
    row["validation"] = validation or {}
    if row["validation"].get("status") not in ("valid", "pending"):
        # 'invalid'/'error'/'unconfigured' — do not scan against a known-bad source config.
        raise SourceInvalid(f"source {account_id}/{region} failed validation: {row['validation']}")
    return row


def _assumed_session(account_id, region, role_name, external_id=None):
    if account_id == HOST_ACCOUNT_ID:
        return boto3.Session(region_name=region)
    sts = boto3.client("sts", region_name=region)
    kwargs = {
        "RoleArn": f"arn:aws:iam::{account_id}:role/{role_name}",
        "RoleSessionName": "awsops-sg-rule-scan", "DurationSeconds": 3600,
    }
    if external_id:
        kwargs["ExternalId"] = external_id
    creds = sts.assume_role(**kwargs)["Credentials"]
    return boto3.Session(
        aws_access_key_id=creds["AccessKeyId"], aws_secret_access_key=creds["SecretAccessKey"],
        aws_session_token=creds["SessionToken"], region_name=region,
    )


def readonly_ec2_client(account_id, region, external_id=None):
    """Role A — the existing, reused AWSopsReadOnlyRole pattern (workload.tf/steampipe.tf/ai.tf)."""
    return _assumed_session(account_id, region, READONLY_ROLE_NAME, external_id).client("ec2")


def account_external_id(conn, account_id):
    """Resolve `external_id` from the trusted `accounts` table for `account_id`, requiring an
    `enabled` row — identical enforcement to `sg_rule_athena_broker.py`'s `_resolve_external_id`
    (round-4 CI-review finding: this Role A path used to omit the `enabled` predicate and fall back
    to `None`, letting a disabled/unregistered account still get a guard-less AssumeRole). Duplicated
    (rather than imported from the broker module) to keep the Fargate worker's deployable code
    independent of the isolated broker Lambda's (ADR-019 §4 draws that isolation at the IAM-grant
    boundary, but there's no reason to add a cross-deployable Python import for a pure SQL lookup) —
    the SAME logic, kept in lockstep by test coverage in both test_sg_rule_scan.py and
    test_sg_rule_athena_broker.py."""
    rows = conn.run("SELECT external_id FROM accounts WHERE account_id=:a AND enabled", a=account_id)
    if not rows:
        raise AccountNotRegistered(
            f"account_id {account_id!r} is not a registered, enabled account in the accounts "
            "table — refusing to assume a role for an unregistered account")
    return rows[0][0]


# ── Step 2: SGR + ENI-membership snapshot ─────────────────────────────────────────────────────────
# (MINOR cleanup: the DescribePermissions-shaped `_perm_to_rules` helper was dead code —
# `snapshot_rules_via_describe` below uses `DescribeSecurityGroupRules` exclusively, per the
# spec's Rule inventory section — so it has been removed rather than left unreachable.)


def snapshot_rules_via_describe(ec2):
    """Uses DescribeSecurityGroupRules (paginated) directly — never reconstructs sgr-* IDs from
    DescribeSecurityGroups, per the spec's Rule inventory section."""
    rules = []
    token = None
    while True:
        kwargs = {"MaxResults": 200}
        if token:
            kwargs["NextToken"] = token
        resp = ec2.describe_security_group_rules(**kwargs)
        for r in resp.get("SecurityGroupRules", []):
            peer_kind, peer_value = None, None
            if r.get("CidrIpv4"):
                peer_kind, peer_value = "cidr", r["CidrIpv4"]
            elif r.get("CidrIpv6"):
                peer_kind, peer_value = "cidr", r["CidrIpv6"]
            elif r.get("ReferencedGroupInfo"):
                peer_kind, peer_value = "sg", r["ReferencedGroupInfo"].get("GroupId", "")
            elif r.get("PrefixListId"):
                peer_kind, peer_value = "pl", r["PrefixListId"]
            protocol = "all" if r.get("IpProtocol") == "-1" else sm.PROTO_NAME.get(str(r.get("IpProtocol")), str(r.get("IpProtocol")))
            rules.append({
                "rule_id": r["SecurityGroupRuleId"], "group_id": r["GroupId"],
                "is_egress": bool(r.get("IsEgress")), "protocol": protocol,
                "from_port": r.get("FromPort"), "to_port": r.get("ToPort"),
                "peer_kind": peer_kind, "peer_value": peer_value or "",
                "description": r.get("Description"),
            })
        token = resp.get("NextToken")
        if not token:
            break
    return rules


def snapshot_eni_membership_via_describe(ec2):
    """Returns (memberships, truncated). `private_ips` carries BOTH IPv4 (`PrivateIpAddresses`) AND
    IPv6 (`Ipv6Addresses`) addresses (L2 finding #2 — an ENI's IPv6 addresses were never captured
    before, so every IPv6 flow failed the `src/dst in private_ips` membership check and silently
    reported `no_observed_evidence` despite real traffic; the matching logic already treats
    `private_ips` as a generic address set — `_is_v6`/CIDR matching in sg_rule_matching.py works
    unchanged on either family). `truncated` is True when the 20,000-ENI describe cap was hit (L4
    finding #9 — the same silent-undercount class as the Athena row LIMIT) so callers can mark
    membership resolution as coverage-limited rather than silently confident."""
    memberships = []
    token = None
    count = 0
    truncated = False
    while True:
        kwargs = {"MaxResults": 1000}
        if token:
            kwargs["NextToken"] = token
        resp = ec2.describe_network_interfaces(**kwargs)
        for eni in resp.get("NetworkInterfaces", []):
            ips = [p.get("PrivateIpAddress") for p in eni.get("PrivateIpAddresses", []) if p.get("PrivateIpAddress")]
            ips += [p.get("Ipv6Address") for p in eni.get("Ipv6Addresses", []) if p.get("Ipv6Address")]
            memberships.append({
                "vpc_id": eni.get("VpcId", ""), "eni_id": eni.get("NetworkInterfaceId", ""),
                "group_ids": [g.get("GroupId") for g in eni.get("Groups", []) if g.get("GroupId")],
                "private_ips": ips,
            })
        count += len(resp.get("NetworkInterfaces", []))
        token = resp.get("NextToken")
        if not token:
            break
        if count >= 20000:
            truncated = True
            break
    return memberships, truncated


# ── Step 2: upsert sg_rule_inventory + append-only versions ──────────────────────────────────────

def group_vpc_map_from_memberships(memberships):
    """Gap-5 fix: derives {group_id -> vpc_id} purely from the ENI-membership snapshot the worker
    already fetches for step 2 of the daily pipeline (`snapshot_eni_membership_via_describe`) — no
    extra AWS call. An SG belongs to exactly one VPC, so the first ENI observed carrying a given
    group_id determines that group's vpc_id; a group_id with no ENI in this snapshot (e.g.
    currently unattached) has no entry, which callers must treat as "unknown", not fabricate."""
    out = {}
    for m in memberships:
        vpc_id = m.get("vpc_id")
        if not vpc_id:
            continue
        for gid in m.get("group_ids") or []:
            out.setdefault(gid, vpc_id)
    return out


def upsert_inventory_and_versions(conn, account_id, region, rules, now, group_vpc_map=None):
    """Per rule: upsert the current-state cache (sg_rule_inventory) and, only when the freshly
    computed fingerprint differs from the currently-open version, close the old version and open a
    new one in sg_rule_inventory_versions (append-only). A rule seen for the first time gets its
    first version row with valid_from = now (approximating first_seen_at, since this IS the first
    observation).

    `group_vpc_map` (gap-5 fix, optional dict {group_id -> vpc_id} from
    `group_vpc_map_from_memberships`): populates the nullable `sg_rule_inventory.vpc_id` column.
    On conflict, a fresh non-NULL resolution always overwrites the stored value (an SG's VPC never
    changes, but a fresher, more complete snapshot should still win); when this run couldn't
    resolve a VPC for the group (not in `group_vpc_map`), the previously stored value — if any — is
    preserved via COALESCE rather than being clobbered back to NULL."""
    group_vpc_map = group_vpc_map or {}
    seen_ids = []
    for rule in rules:
        fp = sm.rule_fingerprint(rule)
        seen_ids.append(rule["rule_id"])
        vpc_id = group_vpc_map.get(rule["group_id"])
        conn.run(
            "INSERT INTO sg_rule_inventory "
            "(account_id, region, rule_id, group_id, is_egress, protocol, from_port, to_port, "
            " peer_kind, peer_value, description, fingerprint, first_seen_at, last_seen_at, active, "
            " vpc_id) "
            "VALUES (:a,:r,:rid,:gid,:eg,:proto,:fp_,:tp,:pk,:pv,:desc,:fp,:now,:now,true,:vpc) "
            "ON CONFLICT (account_id, region, rule_id) DO UPDATE SET "
            "group_id=EXCLUDED.group_id, is_egress=EXCLUDED.is_egress, protocol=EXCLUDED.protocol, "
            "from_port=EXCLUDED.from_port, to_port=EXCLUDED.to_port, peer_kind=EXCLUDED.peer_kind, "
            "peer_value=EXCLUDED.peer_value, description=EXCLUDED.description, "
            "fingerprint=EXCLUDED.fingerprint, last_seen_at=:now, active=true, "
            "vpc_id=COALESCE(EXCLUDED.vpc_id, sg_rule_inventory.vpc_id)",
            a=account_id, r=region, rid=rule["rule_id"], gid=rule["group_id"], eg=rule["is_egress"],
            proto=rule["protocol"], fp_=rule.get("from_port"), tp=rule.get("to_port"),
            pk=rule["peer_kind"], pv=rule["peer_value"], desc=rule.get("description"), fp=fp, now=now,
            vpc=vpc_id,
        )
        open_rows = conn.run(
            "SELECT fingerprint FROM sg_rule_inventory_versions "
            "WHERE account_id=:a AND region=:r AND rule_id=:rid AND valid_to IS NULL",
            a=account_id, r=region, rid=rule["rule_id"])
        if not open_rows:
            conn.run(
                "INSERT INTO sg_rule_inventory_versions "
                "(account_id, region, rule_id, fingerprint, group_id, is_egress, protocol, from_port, "
                " to_port, peer_kind, peer_value, valid_from, valid_to) "
                "VALUES (:a,:r,:rid,:fp,:gid,:eg,:proto,:fp_,:tp,:pk,:pv,:now,NULL)",
                a=account_id, r=region, rid=rule["rule_id"], fp=fp, gid=rule["group_id"],
                eg=rule["is_egress"], proto=rule["protocol"], fp_=rule.get("from_port"),
                tp=rule.get("to_port"), pk=rule["peer_kind"], pv=rule["peer_value"], now=now)
        elif open_rows[0][0] != fp:
            conn.run(
                "UPDATE sg_rule_inventory_versions SET valid_to=:now "
                "WHERE account_id=:a AND region=:r AND rule_id=:rid AND valid_to IS NULL",
                a=account_id, r=region, rid=rule["rule_id"], now=now)
            conn.run(
                "INSERT INTO sg_rule_inventory_versions "
                "(account_id, region, rule_id, fingerprint, group_id, is_egress, protocol, from_port, "
                " to_port, peer_kind, peer_value, valid_from, valid_to) "
                "VALUES (:a,:r,:rid,:fp,:gid,:eg,:proto,:fp_,:tp,:pk,:pv,:now,NULL)",
                a=account_id, r=region, rid=rule["rule_id"], fp=fp, gid=rule["group_id"],
                eg=rule["is_egress"], proto=rule["protocol"], fp_=rule.get("from_port"),
                tp=rule.get("to_port"), pk=rule["peer_kind"], pv=rule["peer_value"], now=now)
    # Sweep disappeared rules — ALWAYS runs, even when `rules` (this snapshot) is empty (fix for the
    # MAJOR "disappeared rules' open version rows never closed" finding: an empty snapshot for a
    # source that previously had rules means ALL of them disappeared, not "no update needed" — the
    # old `if seen_ids:` guard skipped this sweep entirely on an empty snapshot, which is exactly
    # backwards). `rule_id <> ALL(:seen)` with an empty `seen` array is vacuously true for every row,
    # which is the correct behavior here (every previously-known rule has disappeared).
    conn.run(
        "UPDATE sg_rule_inventory SET active=false "
        "WHERE account_id=:a AND region=:r AND rule_id <> ALL(:seen)",
        a=account_id, r=region, seen=seen_ids)
    # Close the open version epoch for any rule that disappeared from this snapshot — a rule that no
    # longer exists can never re-open its own version row, and leaving valid_to NULL would let it
    # keep matching flows forever (the same MAJOR finding).
    conn.run(
        "UPDATE sg_rule_inventory_versions SET valid_to=:now "
        "WHERE account_id=:a AND region=:r AND valid_to IS NULL AND rule_id <> ALL(:seen)",
        a=account_id, r=region, now=now, seen=seen_ids)


def write_eni_snapshot(conn, account_id, region, memberships, now):
    for mship in memberships:
        conn.run(
            "INSERT INTO sg_eni_membership_snapshots "
            "(account_id, region, vpc_id, observed_at, eni_id, group_ids, private_ips) "
            "VALUES (:a,:r,:vpc,:now,:eni,:gids::jsonb,:ips::jsonb) "
            "ON CONFLICT (account_id, region, observed_at, eni_id) DO NOTHING",
            a=account_id, r=region, vpc=mship["vpc_id"], now=now, eni=mship["eni_id"],
            gids=json.dumps(mship["group_ids"]), ips=json.dumps(mship["private_ips"]))


# ── Step 3: watermark ─────────────────────────────────────────────────────────────────────────────

def last_committed_day(conn, flow_source_id):
    rows = conn.run(
        "SELECT max(partition_start::date) FROM sg_rule_scan_runs "
        "WHERE flow_source_id=:fid AND status='succeeded'", fid=flow_source_id)
    return rows[0][0] if rows and rows[0][0] else None


def previous_successful_scan_gap(conn, flow_source_id, before):
    """Item 2 follow-up fix (round 2): the uncertainty window `sm.day_coverage()` applies to a
    closed rule-inventory version must reflect the ACTUAL elapsed gap since the previous successful
    scan for this source, not a fixed `SG_RULE_SCAN_INTERVAL_HOURS` constant — after a multi-day
    scan outage (delayed/missed runs), the real rule-shape change could have happened anywhere in
    the WHOLE gap, not just within one nominal cadence period.

    Returns the `timedelta` gap between `before` (this run's own observation instant — the same
    `now` value that closes any version in THIS call) and the most recent PRIOR `sg_rule_scan_runs`
    row with `status='succeeded'` for this `flow_source_id`, or `None` when there is no reasonably
    recent previous successful run to compare against (e.g. the very first scan for this source, or
    Athena scanning was only just enabled). Callers must treat `None` as "unknown" and mark the
    affected day `unassessable` rather than guessing a window (`sm.day_coverage`'s own contract)."""
    rows = conn.run(
        "SELECT max(started_at) FROM sg_rule_scan_runs "
        "WHERE flow_source_id=:fid AND status='succeeded' AND started_at < :before",
        fid=flow_source_id, before=before)
    prev = rows[0][0] if rows and rows[0][0] else None
    if prev is None:
        return None
    return before - prev


def boundary_lag_resolver(conn, flow_source_id):
    """Item 2 follow-up fix (round 3): `run()` used to resolve ONE `observation_lag` value — the
    gap between `now` (this run's own observation instant) and the previous successful scan — and
    thread that SAME value into `sm.day_coverage()` for EVERY version boundary evaluated across
    EVERY day in the batch (the fresh day AND every day in the trailing rescan window). That is only
    correct for a version boundary THIS run itself just closed; a boundary closed by some EARLIER
    run (the common case for a rescan-window day being idempotently re-evaluated days or weeks
    later) needs the gap that preceded THAT run, not the gap before today's.

    Concretely: a 4-day scan outage means the run that finally closes an old version on day D
    correctly sees a wide gap and marks the affected day `unassessable`. A day or two later, the
    NEXT run's lag is short again — but its trailing rescan window (`RESCAN_WINDOW_DAYS`,
    delete-then-insert, idempotent) revisits that SAME day. Passing that run's own short lag into
    `day_coverage()` for a boundary closed by the OLD, wide-gap run would silently overwrite the
    correct `unassessable` with a confident (wrong) attribution — precisely defeating the point of
    resolving a real gap at all.

    Fix: `sm.day_coverage()`'s `observation_lag` parameter now accepts a CALLABLE `f(valid_to) ->
    timedelta|None`, invoked lazily per covering version's own `valid_to`. This returns exactly
    that callable — for a given `valid_to`, it looks up the gap to the previous successful run
    BEFORE `valid_to` itself (`previous_successful_scan_gap(conn, flow_source_id, before=valid_to)`)
    — i.e. the gap that existed AT THE TIME the run that closed this specific boundary ran, not the
    gap before whatever run happens to be re-evaluating the day today. If no prior successful run
    can be found before `valid_to` (e.g. old `sg_rule_scan_runs` history was pruned), the resolver
    returns `None` — `sm.day_coverage()`'s own contract then marks that day `unassessable` rather
    than assuming a short/confident lag; missing history must never default to "looks fine."

    Memoized per `valid_to` (a small dict, scoped to one `run()` call) since many rules can share
    the exact same version-closing timestamp within one scan."""
    cache = {}

    def resolve(valid_to):
        if valid_to not in cache:
            cache[valid_to] = previous_successful_scan_gap(conn, flow_source_id, valid_to)
        return cache[valid_to]

    return resolve


# ── Step 4-6: Athena query + matching for one day ─────────────────────────────────────────────────

# `_safe_ident`/`build_day_select` now live in sg_rule_matching.py (a boto3-free pure module) so
# BOTH this worker and sg_rule_athena_broker.py can build/validate the identical day-SELECT text —
# the broker resolves a source's config from Aurora itself and builds the SQL SERVER-SIDE (L3
# finding #6); this module keeps these names as thin re-exports for backwards-compatible call
# sites/tests (`scan.build_day_select(...)`).
_safe_ident = sm._safe_ident
build_day_select = sm.build_day_select


def invoke_broker_query(lambda_client, broker_arn, flow_source_id, day):
    """Invokes the broker's `query_by_source` action (L3 finding #6 redesign): the caller supplies
    ONLY an opaque `flow_source_id` + day — never raw account_id/region/workgroup/database/query
    text. The broker resolves and validates all of that itself from Aurora. Loops on the broker's
    own pagination continuation token (L2 finding #4) until it reports `done`, accumulating rows
    client-side up to `sg_rule_matching.ROW_LIMIT` — if that cap is hit before `done`, the result is
    marked `truncated` so `process_day` downgrades affected rules to `unassessable` instead of a
    confident `no_observed_evidence` (L4 finding #9)."""
    day_str = day.isoformat()
    rows = []
    continuation = None
    data_scanned_bytes = 0
    # round-3 finding #7: the broker's `skipdata_count` describes the WHOLE day (it's only computed
    # on the first page, alongside the main query) and was never threaded through this wrapper's
    # return value at all — `run()`'s `coverage_flags["skipdata_count"] = body.get("skipdata_count")`
    # therefore always read `None` from THIS function's own return dict, making the entire SKIPDATA
    # signal dead plumbing. Carry it across the whole pagination loop (a later page's body simply
    # won't have the key, so `body.get("skipdata_count")` naturally leaves it unchanged).
    skipdata_count = None
    while True:
        payload = {"action": "query_by_source", "flow_source_id": flow_source_id, "day": day_str,
                    "max_bytes": MAX_QUERY_BYTES}
        if continuation:
            payload["continuation"] = continuation
        resp = lambda_client.invoke(FunctionName=broker_arn, Payload=json.dumps(payload).encode("utf-8"))
        raw_payload = resp.get("Payload")
        body = json.loads((raw_payload.read() if hasattr(raw_payload, "read") else raw_payload) or b"{}")
        # MINOR fix: surface an unhandled broker crash (FunctionError set, or a body that isn't the
        # broker's own {"ok": ...} shape) as a diagnosable failure instead of a bare
        # {"status":"failed","reason":None} the caller can't act on.
        if resp.get("FunctionError") or "ok" not in body:
            return {"ok": False, "reason": f"broker invocation error: FunctionError={resp.get('FunctionError')!r}, body={body!r}"}
        if not body.get("ok"):
            return body
        rows.extend(body.get("rows") or [])
        data_scanned_bytes = body.get("data_scanned_bytes") or data_scanned_bytes
        if body.get("skipdata_count") is not None:
            skipdata_count = body.get("skipdata_count")
        if len(rows) >= sm.ROW_LIMIT:
            return {"ok": True, "rows": rows[:sm.ROW_LIMIT], "data_scanned_bytes": data_scanned_bytes,
                    "truncated": True, "skipdata_count": skipdata_count}
        if body.get("done", True):
            return {"ok": True, "rows": rows, "data_scanned_bytes": data_scanned_bytes,
                    "truncated": False, "skipdata_count": skipdata_count}
        continuation = {
            "query_execution_id": body.get("query_execution_id"),
            "next_token": body.get("next_token"),
            "columns": body.get("columns"),
        }


def invoke_broker_validate(lambda_client, broker_arn, source):
    """CI-review MAJOR fix (round 5): a source whose persisted `validation` predates the
    `partitionKeyTypes`/`scopeResolution` fields (or the single-key date-shape gate those fields
    back) reads `status: "valid"` from Aurora yet `sm.has_resolved_partition_strategy()` — applied
    identically at scan time, with no migration/grandfathering branch — refuses it on every run.
    Manually re-saving the source (which re-runs the web BFF's PUT-time validate call) fixes this,
    but nothing forces that to happen, so a source can sit permanently refused indefinitely. `run()`
    calls this to re-run the broker's OWN `validate` action — the exact check the web BFF's PUT
    route already trusts — against the source's live schema, so a genuinely stale (never-rejected,
    just never-rechecked) validation self-heals with no operator action required. Returns the
    broker's raw `validate` response ({"ok": True, ...} on success, {"ok": False, "reason": ...}
    otherwise) — callers must treat a failure as "leave the existing (still-refusing) validation in
    place," never as a reason to proceed unvalidated."""
    payload = {
        "action": "validate", "account_id": source["account_id"], "region": source["region"],
        "workgroup": source["workgroup"], "database": source["database_name"], "table": source["table_name"],
    }
    resp = lambda_client.invoke(FunctionName=broker_arn, Payload=json.dumps(payload).encode("utf-8"))
    raw_payload = resp.get("Payload")
    body = json.loads((raw_payload.read() if hasattr(raw_payload, "read") else raw_payload) or b"{}")
    if resp.get("FunctionError") or "ok" not in body:
        return {"ok": False, "reason": f"broker invocation error: FunctionError={resp.get('FunctionError')!r}, body={body!r}"}
    return body


def wrap_broker_validation_result(fresh):
    """CI-review MAJOR fix (round 6): the broker's own `_validate` (`sg_rule_athena_broker.py`)
    returns `{"ok": True, "columnMap": ..., "partitionKeyTypes": ..., "scopeResolution": ...}` —
    it never sets a `status` key at all. `status: "valid"` is added only by the web BFF
    (`web/lib/sg-rules.ts`'s `validateFlowSourceViaBroker`) when a human saves a source via the PUT
    route. The round-5 self-heal path used to persist the broker's raw response verbatim, so the
    JUST-self-healed row still had `validation.status != "valid"` — `query_by_source`'s own guard
    (`sg_rule_athena_broker.py`'s `_query_by_source`) refused it in the SAME run, and `run()`'s own
    `validation.status != "valid"` guard (above) exits with `awaiting_validation` on every
    SUBSEQUENT run, permanently bricking the source (worse than before self-heal existed, since
    there was previously no re-validation path that could scribble a broken shape over a
    passing one). Mirrors the BFF's wrapping exactly: `ok: True` -> `status: "valid"` (+ a fresh
    `checkedAt`), `ok: False` -> `status: "error"`, preserving every other field the broker (or
    the BFF) returns."""
    checked_at = dt.datetime.now(dt.timezone.utc).isoformat()
    if fresh.get("ok"):
        return {**fresh, "status": "valid", "checkedAt": checked_at}
    return {**fresh, "status": "error", "checkedAt": checked_at}


def eni_group_ids_for_ip(memberships, ip):
    """memberships: list of {eni_id, group_ids, private_ips} for the resolved snapshot. Returns the
    union of group_ids of any ENI carrying `ip`."""
    gids = set()
    for m in memberships:
        if ip in (m.get("private_ips") or []):
            gids.update(m.get("group_ids") or [])
    return gids


def process_day(conn, source, day, flows, rule_versions_by_id, memberships_by_vpc, earliest_snapshot_at,
                 stale_vpcs=None, coverage_flags=None, peered_or_shared_vpc_ids_by_vpc=None,
                 observation_lag=None, observed_at=None):
    """Matches `flows` (already-aggregated Athena rows) against every rule for this account/region,
    classifies the whole day per rule, and commits sg_rule_activity_daily + sg_rule_scan_runs in
    ONE transaction (delete-then-insert for the day — idempotent regardless of how many times this
    day is reprocessed). Returns the coverage summary dict.

    CRITICAL fix: a flow may only be credited to a rule whose `group_id` is actually carried by the
    flow's OWN ENI (`flow["interface_id"]`, selected by the Athena query but previously never read)
    — resolved via an eni_id -> {group_ids, private_ips, vpc_id} index built once from
    `memberships_by_vpc` (also fixes the MINOR "VPC lookup inside the innermost loop" complexity
    note, and the MINOR "unique_eni_count counts destination IP strings, not ENIs" — it now counts
    the flow's own interface_id). Direction ("ingress"/"egress") and which side of the flow tuple is
    the local peer are derived from whether the ENI's own private_ips contain srcaddr or dstaddr —
    never guessed from dstaddr alone (fixes the MAJOR "direction hardcoded ingress" finding; every
    egress rule is now matchable). A flow whose ENI cannot be resolved (no membership snapshot
    covers it) contributes no evidence to any rule — it is never fabricated.

    `stale_vpcs` (set, L4 finding #11): VPCs whose resolved membership snapshot came from OUTSIDE
    the staleness window (`resolve_membership_snapshot`'s "stale" outcome). A flow whose own ENI
    lives in a stale-resolved VPC can still be evaluated, but any MATCH it would otherwise produce
    is downgraded to `match_unassessable` instead of `compatible` — `SG_RULE_MEMBERSHIP_STALENESS_DAYS`
    must actually change the output, not just be computed and discarded.

    `coverage_flags` (dict, L4 finding #9): {"flow_result_truncated": bool, "eni_snapshot_truncated":
    bool, "skipdata_count": int|None} — silent-undercount signals from the broker/ENI-describe steps.
    A day flagged truncated can never commit a confident `no_observed_evidence` for a rule with zero
    matches — it is downgraded to `unassessable` instead (an incomplete scan must never look
    identical to a genuinely-clean rule).

    `peered_or_shared_vpc_ids_by_vpc` (round-3 finding #9, dict `vpc_id -> set[vpc_id]`, optional):
    for each VPC, the set of OTHER vpc ids known to be able to legally reference an SG in it (VPC
    peering / RAM shared-VPC). Threaded into `sg_resolver_factory` via `sm.eni_matches_vpc_scope` so
    SG-reference resolution considers that VPC's peered/shared partners, not just the flow's own
    VPC. When the caller has no peering/RAM topology data at all (the common case today — no
    describe-vpc-peering-connections/RAM data source exists yet), this defaults to empty scope per
    VPC, which is the SAFE direction: a cross-VPC SG-reference hit then resolves `unassessable`
    (see `sg_resolver_factory`) rather than either a false `no_observed_evidence` (old behavior) or
    a false confident match across VPCs with coincidental RFC1918 overlap.

    Round-3 finding #8: flows whose ENI can't be resolved against any membership snapshot, or whose
    direction can't be oriented (neither flow-tuple endpoint matches the ENI's own known private
    IPs), are counted in `unresolved_flow_count` (persisted into every rule's `coverage` jsonb, and
    into the run's own `coverage`) — a non-trivial count of such flows means real traffic existed
    that could not be attributed to any rule, so per-rule zero-match `no_observed_evidence` is
    downgraded to `unassessable` for that day exactly like `flow_result_truncated`/
    `eni_snapshot_truncated` already are (an unattributed flow must not look identical to a
    genuinely-clean, fully-evidenced zero).

    `observation_lag` (item 2 follow-up fix, round 2): the `timedelta` uncertainty window
    `sm.day_coverage()` applies to a CLOSED rule-inventory version's day — resolved by the caller
    (`run()`) from the ACTUAL gap to the previous successful scan (`previous_successful_scan_gap()`),
    never a fixed nominal cadence. Defaults to `None` ("unknown gap" — every closed version's day is
    then marked unassessable rather than guessing) when the caller doesn't resolve one.

    `observed_at` (CI-review MAJOR fix, round 5): the `sg_rule_scan_runs.started_at` row this call
    commits is what `previous_successful_scan_gap()` later reads to resolve THIS run's own
    observation instant for some FUTURE run's `boundary_lag_resolver`. It must therefore be the same
    `now` `run()` passed to `upsert_inventory_and_versions()` when it closed/opened rule-inventory
    versions for this scan — NOT the wall-clock time this transaction happens to commit at. Those
    two differ by however long the EC2 describes + Athena wait + matching took, and for a multi-day
    batch, EVERY day's row gets stamped with the SAME single run-wide observation instant (there is
    only one inventory snapshot per `run()` call, matching `upsert_inventory_and_versions`' own
    per-run `now`). Using the commit-time wall clock instead would systematically UNDER-estimate the
    gap a later run resolves via `previous_successful_scan_gap`, silently narrowing the very
    uncertainty window items 2/3 exist to widen. Defaults to `dt.datetime.now(dt.timezone.utc)` only
    for callers/tests that have no run-wide observation instant to pass (single-day, standalone
    invocations) — `run()` itself always passes its own captured `now` explicitly.
    """
    stale_vpcs = stale_vpcs or set()
    coverage_flags = coverage_flags or {}
    peered_or_shared_vpc_ids_by_vpc = peered_or_shared_vpc_ids_by_vpc or {}
    observed_at = observed_at or dt.datetime.now(dt.timezone.utc)
    flow_result_truncated = bool(coverage_flags.get("flow_result_truncated"))
    eni_snapshot_truncated = bool(coverage_flags.get("eni_snapshot_truncated"))
    unresolved_flow_count = 0

    account_id, region = source["account_id"], source["region"]
    day_str = day.isoformat()
    run_id = str(uuid.uuid4())
    start, end = sm.day_bounds_utc(day)

    per_rule = {}
    any_crossing = False
    for rule_id, versions in rule_versions_by_id.items():
        day_cov = sm.day_coverage(versions, day, observation_lag=observation_lag)
        per_rule[rule_id] = {
            "compatible": 0, "overlap": 0, "bytes": 0,
            "unassessable": day_cov["crossing"],  # fingerprint-epoch-crossing (day-level)
            "match_unassessable": False,          # any flow evaluated UNASSESSABLE (pl/icmp/etc.)
            "version": day_cov["version"],        # the day-covering version (None when crossing) —
                                                   # fixes the "wrong fingerprint persisted" MAJOR
                                                   # finding (was rule_versions_by_id[rule_id][-1]).
            "last_observed_at": None, "eni_ids": set(),
        }
        if day_cov["crossing"]:
            any_crossing = True

    # Hoisted once per call (not per flow/rule): eni_id -> {group_ids, private_ips, vpc_id, stale}.
    eni_index = {}
    for vpc_id, snap in memberships_by_vpc.items():
        for m in snap:
            eni_id = m.get("eni_id")
            if not eni_id:
                continue
            eni_index[eni_id] = {
                "group_ids": set(m.get("group_ids") or []),
                "private_ips": set(m.get("private_ips") or []),
                "vpc_id": vpc_id,
                "stale": vpc_id in stale_vpcs,
            }

    def sg_resolver_factory(vpc_id):
        """round-3 finding #9: SG-reference resolution must scope to `vpc_id` PLUS any VPC known
        (via `peered_or_shared_vpc_ids_by_vpc`) to be able to legally reference an SG in it — not
        `vpc_id` alone. A group_id hit found ONLY in a VPC outside that whole scope means the SG is
        genuinely referenced cross-VPC but this call has no way to confirm the peering/RAM
        relationship is legitimate — that must resolve `unassessable` (return None), never a
        confident `no_observed_evidence`-producing empty set."""
        peered_or_shared = peered_or_shared_vpc_ids_by_vpc.get(vpc_id) or set()
        if vpc_id not in memberships_by_vpc and not any(
                sm.eni_matches_vpc_scope(vpc_id, other_vpc, peered_or_shared)
                for other_vpc in memberships_by_vpc):
            return None

        def _resolve(group_id):
            in_scope_ips = set()
            out_of_scope_hit = False
            found_anywhere = False
            for other_vpc, snap in memberships_by_vpc.items():
                in_scope = sm.eni_matches_vpc_scope(vpc_id, other_vpc, peered_or_shared)
                for m in snap:
                    if group_id in (m.get("group_ids") or []):
                        found_anywhere = True
                        if in_scope:
                            in_scope_ips.update(m.get("private_ips") or [])
                        else:
                            out_of_scope_hit = True
            if not found_anywhere:
                # Follow-up fix (item 6): the referenced group_id is not present ANYWHERE in this
                # account/region's own membership snapshot data — this can be a LEGALLY
                # cross-account or cross-region SG reference (AWS supports referencing an SG across
                # accounts/regions via VPC peering), which this account/region's own snapshot data
                # structurally cannot verify either way. Before this fix, "not found anywhere"
                # fell through to `return in_scope_ips` (an empty set, not None), which
                # `match_peer`/`sg_peer_ip_resolver` then treats as a confident, resolved-but-empty
                # answer -> NO_MATCH -> a false `no_observed_evidence`. Resolving `None` here makes
                # this genuinely UNASSESSABLE, matching the in-scope-but-elsewhere case just below.
                return None
            if not in_scope_ips and out_of_scope_hit:
                return None  # cross-VPC hit outside the known-legal scope -> unassessable
            return in_scope_ips
        return _resolve

    for flow in flows:
        interface_id = flow.get("interface_id")
        dst = flow.get("dstaddr")
        src = flow.get("srcaddr")
        port = int(flow["dstport"]) if flow.get("dstport") not in (None, "") else None
        proto = flow.get("protocol")
        bytes_ = int(flow.get("bytes") or 0)
        cnt = int(flow.get("cnt") or 1)
        last_start = None
        if flow.get("last_start") not in (None, ""):
            try:
                last_start = dt.datetime.fromtimestamp(int(flow["last_start"]), tz=dt.timezone.utc)
            except (TypeError, ValueError):
                last_start = None
        if not dst or not src or not interface_id:
            unresolved_flow_count += 1
            continue
        eni = eni_index.get(interface_id)
        if eni is None or not eni["group_ids"]:
            # This flow's own ENI membership cannot be resolved (no snapshot covers it, or it
            # carries no SGs) — never fabricate membership; the flow contributes no evidence.
            # round-3 finding #8: count it — it must not silently vanish from coverage.
            unresolved_flow_count += 1
            continue
        if src in eni["private_ips"]:
            direction, peer_ip = "egress", dst
        elif dst in eni["private_ips"]:
            direction, peer_ip = "ingress", src
        else:
            # Neither tuple endpoint matches this ENI's own known private IPs (stale/incomplete
            # membership snapshot, secondary IP not captured, NAT/ELB-rewritten flow, ...) —
            # direction and local/peer orientation cannot be safely inferred; skip rather than guess.
            # round-3 finding #8: count it — it must not silently vanish from coverage.
            unresolved_flow_count += 1
            continue
        vpc_id = eni["vpc_id"]
        resolver = sg_resolver_factory(vpc_id)

        # L2 finding #1: a flow that matches MORE THAN ONE eligible rule must credit the additional
        # rule(s) as `overlap`, not just silently ignore them after the first match — collect every
        # matching rule_id for this flow before crediting anything.
        matched_rule_ids = []
        for rule_id in rule_versions_by_id:
            cov = per_rule[rule_id]
            if cov["unassessable"]:
                continue
            version = cov["version"]
            if version is None:
                continue
            # ENI -> SG membership check (the CRITICAL fix): only a rule whose group_id this flow's
            # OWN ENI actually carries can be credited with this flow's traffic.
            if version["group_id"] not in eni["group_ids"]:
                continue
            rule = {"protocol": version["protocol"], "from_port": version.get("from_port"),
                    "to_port": version.get("to_port"), "peer_kind": version["peer_kind"],
                    "peer_value": version["peer_value"], "is_egress": version["is_egress"],
                    "group_id": version["group_id"]}
            outcome = sm.match_flow_against_rule(
                rule, {"peer_ip": peer_ip, "port": port, "protocol": proto, "direction": direction},
                sg_peer_ip_resolver=resolver, prefix_list_resolver=None)
            if outcome == sm.MatchOutcome.MATCH:
                if eni["stale"]:
                    # L4 finding #11: a MATCH resolved through a stale membership snapshot must not
                    # be credited as confident evidence — downgrade to unassessable instead.
                    cov["match_unassessable"] = True
                else:
                    matched_rule_ids.append(rule_id)
            elif outcome == sm.MatchOutcome.UNASSESSABLE:
                # MAJOR fix: UNASSESSABLE (prefix-list peer, ICMP, unresolvable SG reference) must
                # never be silently discarded — it downgrades this rule/day to `unassessable` unless
                # a confident MATCH is also found (classify_rule_day already gives MATCH priority).
                cov["match_unassessable"] = True

        if matched_rule_ids:
            # round-3 finding #4: EVERY matched rule gets its own `compatible` credit (each one
            # legitimately had a compatible flow) — crediting only the arbitrary dict-iteration-order
            # "first" rule undercounted every later rule's genuinely compatible traffic. When N>1
            # rules match the SAME flow, that IS an overlap signal, so ALL of them (not just the
            # ones after some arbitrary first pick) also get an `overlap` credit — the overlap
            # applies to the whole matched set, not to "everyone but the first." Iterate in a
            # deterministic (sorted by rule_id) order for reproducibility, independent of dict order.
            is_overlap = len(matched_rule_ids) > 1
            for rid in sorted(matched_rule_ids):
                cov = per_rule[rid]
                cov["compatible"] += cnt
                cov["bytes"] += bytes_
                cov["eni_ids"].add(interface_id)
                if is_overlap:
                    cov["overlap"] += cnt
                if last_start and (cov["last_observed_at"] is None or last_start > cov["last_observed_at"]):
                    cov["last_observed_at"] = last_start

    # round-3 finding #8: any unresolved/unorientable flow is material enough on its own — a real
    # flow existed for this account/region/day that could not be attributed to any rule, so it must
    # not be indistinguishable from a genuinely evidenced, confident zero. Folded into the SAME
    # downgrade path as the pre-existing truncation flags.
    unresolved_flows_present = unresolved_flow_count > 0
    day_truncated = flow_result_truncated or eni_snapshot_truncated or unresolved_flows_present

    conn.run("BEGIN")
    try:
        conn.run(
            "DELETE FROM sg_rule_activity_daily WHERE account_id=:a AND region=:r AND observed_on=:d",
            a=account_id, r=region, d=day_str)
        for rule_id, cov in per_rule.items():
            if cov["version"] is not None:
                fp = cov["version"]["fingerprint"]
            elif rule_versions_by_id[rule_id]:
                # Epoch-crossing day: no single version covers the whole day. Fall back to the
                # latest known version's fingerprint purely as a display reference — the `coverage`
                # JSON's `fingerprint_epoch_crossing: true` is the authoritative signal that this
                # fingerprint must NOT be trusted as "the" shape for this day.
                fp = rule_versions_by_id[rule_id][-1]["fingerprint"]
            else:
                fp = ""
            status = sm.classify_rule_day(cov["compatible"], cov["overlap"], True,
                                           cov["unassessable"] or cov["match_unassessable"])
            # L4 finding #9: a truncated day (Athena LIMIT hit, or the 20k-ENI describe cap hit)
            # must never let a rule with zero matches settle on a confident `no_observed_evidence` —
            # downgrade it to `unassessable` instead (an incomplete scan must not look identical to
            # a genuinely-clean rule).
            if day_truncated and status == "no_observed_evidence":
                status = "unassessable"
            final_unassessable = cov["unassessable"] or cov["match_unassessable"] or (
                day_truncated and status == "unassessable" and cov["compatible"] == 0)
            coverage = {
                "unassessable": final_unassessable,
                "fingerprint_epoch_crossing": cov["unassessable"],
                "match_unassessable": cov["match_unassessable"],
                "status": status,
                "flow_result_truncated": flow_result_truncated,
                "eni_snapshot_truncated": eni_snapshot_truncated,
                "unresolved_flow_count": unresolved_flow_count,
                "skipdata_count": coverage_flags.get("skipdata_count"),
            }
            conn.run(
                "INSERT INTO sg_rule_activity_daily "
                "(account_id, region, rule_id, rule_fingerprint, observed_on, compatible_match_count, "
                " compatible_bytes, overlap_match_count, unique_eni_count, last_observed_at, coverage) "
                "VALUES (:a,:r,:rid,:fp,:d,:cm,:cb,:om,:ue,:lo,:cov::jsonb)",
                a=account_id, r=region, rid=rule_id, fp=fp, d=day_str, cm=cov["compatible"],
                cb=cov["bytes"], om=cov["overlap"], ue=len(cov["eni_ids"]), lo=cov["last_observed_at"],
                cov=json.dumps(coverage),
            )
        conn.run(
            "INSERT INTO sg_rule_scan_runs "
            "(id, flow_source_id, status, partition_start, partition_end, rows_processed, coverage, started_at, finished_at) "
            "VALUES (:id,:fid,'succeeded',:ps,:pe,:rows,:cov::jsonb,:started_at,now())",
            id=run_id, fid=source["id"], ps=start, pe=end, rows=len(flows),
            cov=json.dumps({"fingerprint_epoch_crossing_any": any_crossing,
                             "unresolved_flow_count": unresolved_flow_count}),
            started_at=observed_at,
        )
        conn.run("COMMIT")
    except Exception:
        conn.run("ROLLBACK")
        raise
    return {"run_id": run_id, "day": day_str, "rule_count": len(per_rule), "any_crossing": any_crossing}


# ── Load rule-version rows + ENI-membership snapshots for matching ───────────────────────────────

def load_rule_versions(conn, account_id, region):
    """rule_id -> list of version dicts (valid_from/valid_to/shape fields), matching source of
    truth per the spec (never the mutable sg_rule_inventory cache)."""
    rows = conn.run(
        "SELECT rule_id, fingerprint, group_id, is_egress, protocol, from_port, to_port, "
        "peer_kind, peer_value, valid_from, valid_to FROM sg_rule_inventory_versions "
        "WHERE account_id=:a AND region=:r ORDER BY rule_id, valid_from",
        a=account_id, r=region)
    out = {}
    for r in rows:
        d = {"rule_id": r[0], "fingerprint": r[1], "group_id": r[2], "is_egress": r[3],
             "protocol": r[4], "from_port": r[5], "to_port": r[6], "peer_kind": r[7],
             "peer_value": r[8], "valid_from": r[9], "valid_to": r[10]}
        out.setdefault(r[0], []).append(d)
    return out


def load_membership_by_vpc(conn, account_id, region, day, staleness_days):
    """One resolved snapshot (list of {eni_id, group_ids, private_ips}) per vpc_id, using
    nearest-prior-in-time / pre-snapshotting-backfill resolution (sg_rule_matching.resolve_membership_snapshot).

    Returns (resolved, stale_vpcs) — L4 finding #11 fix: the resolver's `stale`/
    `pre_snapshotting_backfill` outcome is no longer discarded. `stale_vpcs` (a set) is threaded
    into process_day so a `stale` snapshot downgrades that VPC's matches to `unassessable` instead
    of being credited exactly like an in-window snapshot (which would defeat
    `SG_RULE_MEMBERSHIP_STALENESS_DAYS` entirely). `earliest_snapshot_at` — the earliest observation
    across EVERY vpc for this account/region — is computed once here and threaded into EVERY vpc's
    resolution, so the pre-snapshotting-backfill rule pins to one fixed reference for the whole
    source, not "whatever's current now" per vpc.
    """
    rows = conn.run(
        "SELECT vpc_id, observed_at, eni_id, group_ids, private_ips FROM sg_eni_membership_snapshots "
        "WHERE account_id=:a AND region=:r", a=account_id, r=region)
    by_vpc = {}
    for r in rows:
        by_vpc.setdefault(r[0], []).append({
            "observed_at": r[1], "eni_id": r[2],
            "group_ids": r[3] if isinstance(r[3], list) else json.loads(r[3] or "[]"),
            "private_ips": r[4] if isinstance(r[4], list) else json.loads(r[4] or "[]"),
        })
    all_observed_ats = [s["observed_at"] for snaps in by_vpc.values() for s in snaps]
    earliest_snapshot_at = min(all_observed_ats) if all_observed_ats else None

    resolved = {}
    stale_vpcs = set()
    for vpc_id, snaps in by_vpc.items():
        by_time = {}
        for s in snaps:
            by_time.setdefault(s["observed_at"], []).append(s)
        snapshot_rows = [{"observed_at": t} for t in by_time]
        chosen, outcome = sm.resolve_membership_snapshot(
            snapshot_rows, day, staleness_days, earliest_snapshot_at=earliest_snapshot_at)
        if chosen is not None:
            resolved[vpc_id] = by_time[chosen["observed_at"]]
            if outcome == "stale":
                stale_vpcs.add(vpc_id)
    return resolved, stale_vpcs


def _write_failed_run(conn, source, day, reason, error_code):
    """Write a terminal `failed` sg_rule_scan_runs row (MAJOR "failure invisibility" fix) — so the
    reaper's stale-run reconciliation and any downstream API/UI caller see a real failed row
    instead of silence (previously only an in-memory list entry that run()'s top-level
    `{"status": "ok"}` return discarded). MINOR fix: `reason` is redacted (sm.redact_sensitive)
    before persisting — it can be a raw AWS exception message embedding an ARN/account id/query
    id, and this `coverage` jsonb is operator-readable."""
    start, end = sm.day_bounds_utc(day)
    conn.run(
        "INSERT INTO sg_rule_scan_runs "
        "(id, flow_source_id, status, partition_start, partition_end, rows_processed, coverage, "
        " error_code, started_at, finished_at) "
        "VALUES (:id,:fid,'failed',:ps,:pe,0,:cov::jsonb,:ec,now(),now())",
        id=str(uuid.uuid4()), fid=source["id"], ps=start, pe=end,
        cov=json.dumps({"reason": sm.redact_sensitive(str(reason or ""))[:2000]}), ec=error_code,
    )


def run(payload, conn, ec2_client_factory=None, lambda_client_factory=None):
    """Top-level entry point for handlers.py's `sg_rule_scan` handler.

    `ec2_client_factory(account_id, region, external_id) -> boto3 ec2 client` and
    `lambda_client_factory() -> boto3 lambda client` are injectable for testing; production
    defaults use readonly_ec2_client (Role A) and a plain boto3 lambda client respectively.
    """
    account_id = payload["account_id"]
    region = payload["region"]
    source = load_source(conn, account_id, region)
    # The host account never assumes a role at all (see `_assumed_session`'s own bypass below) —
    # the confused-deputy `accounts.enabled` guard exists to gate cross-account AssumeRole, not the
    # host's own in-account calls, so it is skipped only in that one case, exactly mirroring
    # `_assumed_session`'s existing bypass condition.
    ext_id = None if account_id == HOST_ACCOUNT_ID else account_external_id(conn, account_id)

    ec2 = (ec2_client_factory or readonly_ec2_client)(account_id, region, ext_id)
    now = dt.datetime.now(dt.timezone.utc)
    rules = snapshot_rules_via_describe(ec2)
    memberships, eni_snapshot_truncated = snapshot_eni_membership_via_describe(ec2)
    # Gap-5 fix: derive vpc_id per group_id from the SAME membership snapshot just fetched above —
    # no extra AWS call — and thread it into the inventory upsert (see
    # group_vpc_map_from_memberships's docstring).
    group_vpc_map = group_vpc_map_from_memberships(memberships)
    upsert_inventory_and_versions(conn, account_id, region, rules, now, group_vpc_map=group_vpc_map)
    write_eni_snapshot(conn, account_id, region, memberships, now)

    broker_arn = os.environ.get("SG_RULE_ATHENA_BROKER_ARN")
    if not broker_arn:
        return {"status": "inventory_only", "reason": "SG_RULE_ATHENA_BROKER_ARN not set (feature flag off)"}
    # L3 finding #8a: a source whose validation.status isn't 'valid' (e.g. still 'pending') must
    # never be scanned — the broker's own `query_by_source` action enforces this too (defense in
    # depth, since the web BFF's source-validation path never goes through this module at all), but
    # short-circuiting HERE avoids a pointless broker invocation + a noisy daily `failed` run row.
    if (source.get("validation") or {}).get("status") != "valid":
        return {"status": "awaiting_validation",
                "reason": f"source validation.status={source.get('validation', {}).get('status')!r} is not 'valid'"}
    lam = (lambda_client_factory or (lambda: boto3.client("lambda", region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))))()

    # CI-review MAJOR fix (round 5, corrected round 7): distinguish a validation that predates the
    # round-4/round-2 scope/type fields entirely — persisted before they existed, never re-run
    # since — from one that was genuinely CHECKED under the CURRENT gate. The original round-5
    # condition keyed self-heal on `not sm.has_resolved_partition_strategy(validation)`, which is
    # `True` (no re-heal needed, by that check's own logic) for ANY Hive-style year/month/day
    # layout regardless of `scopeResolution` — `has_resolved_partition_strategy` never looks at
    # scope metadata at all. A pre-round-2 Hive-style source on a centralized/org-wide table
    # therefore NEVER re-validated, permanently missing `scopeResolution`/`scannedUnscoped` and
    # `_build_scope_predicate`'s account/region predicate — exactly the "scanned entirely unscoped,
    # which used to be silent" defect the round-2 fix exists to close, just reopened for every
    # legacy source the round-5 self-heal was supposed to reach. The correct staleness signal is
    # simpler and doesn't depend on whether the CURRENT gate happens to already accept the layout:
    # either `partitionKeyTypes` or `scopeResolution` being absent from the persisted validation
    # means it predates the schema those fields belong to, full stop — self-heal by re-running the
    # broker's own `validate` action rather than requiring a manual admin no-op re-save (the ONLY
    # previously documented remediation) before it can ever scan again, or worse, silently keep
    # scanning unscoped forever without anyone noticing.
    validation = source.get("validation") or {}
    if "partitionKeyTypes" not in validation or "scopeResolution" not in validation:
        fresh = invoke_broker_validate(lam, broker_arn, source)
        if fresh.get("ok"):
            healed = wrap_broker_validation_result(fresh)
            conn.run("UPDATE sg_flow_sources SET validation=:v WHERE id=:id",
                      v=json.dumps(healed), id=source["id"])
            source["validation"] = healed
        else:
            # CI-review MAJOR fix (round 8): the comment this replaces claimed that
            # `has_resolved_partition_strategy` below would still refuse the scan exactly as it
            # already would have, if re-validation fails and the stale validation is left in
            # place — that is FALSE for a Hive-style year/month/day layout, which satisfies
            # `has_resolved_partition_strategy` without needing `scopeResolution`/`partitionKeyTypes`
            # at all. Falling through on a failed self-heal therefore let a pre-round-2 Hive-style
            # centralized-table source scan UNSCOPED (stale `columnMap` has no account/region
            # predicate) on every run where re-validation happens to fail (a transient Lambda/Glue
            # error, or a table that now genuinely fails the current gate) — reopening exactly the
            # "silently keep scanning unscoped forever" defect the round-2/6 fixes exist to close.
            # A stale, never-fully-re-validated source must never be trusted to scan on its OLD
            # validation once we know we can't confirm it against the current gate — refuse this
            # run and retry re-validation on the next scheduled run, the same posture `run()`
            # already takes for a source whose validation.status genuinely isn't 'valid'.
            return {"status": "awaiting_validation",
                    "reason": f"stale validation predates partitionKeyTypes/scopeResolution and "
                              f"re-validation failed: {fresh.get('reason')!r} — refusing to scan on "
                              "unconfirmed stale validation"}

    fid = source["id"]
    # Item 2 follow-up fix (round 3): a SINGLE `observation_lag` value (the gap before THIS run's
    # own `now`) used to be threaded into every day/version this call processes — correct only for
    # a boundary this run itself just closed, and WRONG for a historical boundary a rescan-window
    # day re-evaluates (see `boundary_lag_resolver`'s own docstring for the exact failure mode).
    # Pass a per-boundary resolver instead — `sm.day_coverage()` now accepts either a plain
    # timedelta/None (unchanged single-value behavior) or a callable, invoked lazily per covering
    # version's own `valid_to`.
    observation_lag = boundary_lag_resolver(conn, fid)
    watermark = last_committed_day(conn, fid)
    source_created_day = source["created_at"].date() if hasattr(source["created_at"], "date") else source["created_at"]
    next_day = sm.next_day_to_process(watermark, source_created_day)

    days_to_run = []
    if sm.is_day_eligible(next_day, now, DELIVERY_LAG_HOURS):
        days_to_run.append(next_day)
    days_to_run.extend(sm.rescan_window_days(watermark, RESCAN_WINDOW_DAYS))

    rule_versions = load_rule_versions(conn, account_id, region)
    results = []
    for day in days_to_run:
        if not sm.is_day_eligible(day, now, DELIVERY_LAG_HOURS):
            continue
        # L3 finding #6: the broker is invoked by opaque flow_source_id + day only — never raw
        # account_id/region/workgroup/database/query text (see invoke_broker_query's own docstring).
        body = invoke_broker_query(lam, broker_arn, fid, day)
        if not body.get("ok"):
            # MAJOR fix ("failure invisibility"): a failed Athena day must not be invisible to the
            # reaper/API/UI — write a terminal `failed` sg_rule_scan_runs row, not just an in-memory
            # note that the top-level `run()` result silently drops on the floor.
            _write_failed_run(conn, source, day, body.get("reason"), "athena_query_failed")
            results.append({"day": day.isoformat(), "status": "failed", "reason": body.get("reason")})
            continue
        memberships_by_vpc, stale_vpcs = load_membership_by_vpc(
            conn, account_id, region, day, MEMBERSHIP_STALENESS_DAYS)
        coverage_flags = {
            "flow_result_truncated": bool(body.get("truncated")),
            "eni_snapshot_truncated": eni_snapshot_truncated,
            "skipdata_count": body.get("skipdata_count"),
        }
        try:
            res = process_day(conn, source, day, body.get("rows", []), rule_versions, memberships_by_vpc,
                               None, stale_vpcs=stale_vpcs, coverage_flags=coverage_flags,
                               observation_lag=observation_lag, observed_at=now)
        except Exception as e:  # noqa: BLE001 — one day's transaction failure must not crash run()
            # process_day() itself still raises on internal failure (its own rollback contract is
            # unchanged, see test_process_day_rolls_back_on_failure) — this is the caller-side
            # translation into a visible, terminal run row for THIS day, so other days keep going.
            _write_failed_run(conn, source, day, str(e), "process_day_failed")
            results.append({"day": day.isoformat(), "status": "failed", "reason": str(e)})
            continue
        results.append(res)
    return {"status": "ok", "days": results}
