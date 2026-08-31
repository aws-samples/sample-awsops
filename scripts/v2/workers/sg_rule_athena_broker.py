"""SG Rules & Usage — Athena/Glue broker Lambda (ADR-019 Role B isolation).

This is the ONLY principal in this repository allowed to `sts:AssumeRole` on the target account's
`AWSopsSgRuleAthenaRole` — the shared Fargate worker task role (worker_task, workers.tf) NEVER
gets that grant (ADR-019 §4 / the design spec's IAM section explicitly forbids it: granting it to
the shared role would expose every other job type this worker fleet runs to Athena/S3 access it
has no business needing). The Fargate worker (sg_rule_scan.py) and the web BFF (source validation,
web/lib/sg-rules.ts) both call this broker via `lambda:InvokeFunction` instead of assuming the
Athena role themselves — that grant is safe to give multiple callers because it does not confer
AssumeRole.

Trust-boundary redesign (L3 finding #6, round 2): earlier, `action: "query"` executed a verbatim
caller-supplied SQL string against caller-supplied account_id/region/workgroup/database — any
principal with `lambda:InvokeFunction` (the shared worker fleet AND the web BFF, per this module's
own docstring) could therefore read anything `AWSopsSgRuleAthenaRole` can reach in ANY trusting
account by supplying arbitrary parameters. That action is REMOVED. The only query-shaped action now
is `action: "query_by_source"`, which accepts ONLY an opaque `flow_source_id` (a row id in the
`sg_flow_sources` table) + a `day` (ISO date) — this module resolves account_id/region/workgroup/
database_name/table_name/validation/external_id from Aurora ITSELF (the same rds-db IAM-auth
pattern as db.py/sg_rule_dispatcher.py) and builds the day-SELECT server-side
(sg_rule_matching.build_day_select) from that resolved config. A caller can never inject its own
SQL, account, or table — it can only ask "run source #N's day-D query", and only a source whose
`validation.status == 'valid'` (fully validated, never 'pending') and whose validation resolved a
bound-able partition strategy is ever scanned (L3 finding #8).

Actions:
  - "validate": GetWorkGroup/GetDatabase/GetTable only (read-only existence + schema-resolution
    check backing the spec's "Flow Log source configuration" section, called by web/lib/sg-rules.ts
    BEFORE a flow_source_id even exists, so it still accepts raw account_id/region/workgroup/
    database/table — those are re-validated by strict identifier allowlists here regardless of
    what web/lib/sg-rules.ts already checked at PUT time). No query execution. Also requires the
    workgroup to enforce its own `BytesScannedCutoffPerQuery` (L3 finding #8c) — a workgroup without
    one fails validation outright, so AWS itself pre-emptively enforces a scan-bytes ceiling instead
    of relying solely on this module's own post-hoc check.
  - "query_by_source": resolves the source from Aurora, builds ONE Athena SELECT for one account/
    region/day partition server-side, and runs it: StartQueryExecution -> poll GetQueryExecution ->
    ONE bounded page of GetQueryResults -> return that page + a continuation token (L2 finding #4 —
    never accumulates and returns an unbounded row set synchronously; the caller,
    sg_rule_scan.py's invoke_broker_query, loops on the token until `done`). Also runs a cheap
    companion SKIPDATA-count query and, on an empty first page against a `partition_keys`-strategy
    table, verifies at least one Glue partition actually matched the day's predicate before trusting
    a zero-row result as "no traffic" (L4 finding #9).

Never executes a caller-supplied WHERE/column list, never runs anything but SELECT (the query
string this module itself built is still re-validated defense-in-depth — see _reject_non_select),
never touches CreateWorkGroup/CreateTable/DeleteTable/etc, and never writes S3 outside the
workgroup's own configured result location (that write is Athena's own intrinsic mechanic, not
something this module does directly).
"""
import calendar
import datetime as _dt
import os
import re
import time

import boto3

import sg_rule_matching as sm

_STS_SESSION_NAME = "awsops-sg-rule-athena"
_POLL_INTERVAL_S = 1.0
_MAX_POLL_S = int(os.environ.get("SG_RULE_ATHENA_POLL_TIMEOUT_S", "120"))
_DEFAULT_MAX_BYTES = int(os.environ.get("SG_RULE_ACTIVITY_MAX_QUERY_BYTES", "107374182400"))  # 100 GiB
_ROLE_NAME = "AWSopsSgRuleAthenaRole"
_PAGE_SIZE = 1000  # Athena's own per-call GetQueryResults maximum.

# Defense-in-depth: even though the SQL run here is always built by THIS module from resolved,
# re-validated Aurora config (never a caller-supplied string), it is still re-checked before it
# ever reaches Athena — a second, structurally-different check in a different process/step.
_SELECT_ONLY_RE = re.compile(r"^\s*SELECT\b", re.IGNORECASE)
_FORBIDDEN_RE = re.compile(
    r"\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|GRANT|REVOKE|MERGE|TRUNCATE|CALL|VACUUM|UNLOAD|UNION)\b",
    re.IGNORECASE,
)

# Defense-in-depth (L3 trust-boundary finding): re-apply the SAME strict allowlist regexes
# web/lib/sg-rules.ts already enforces at PUT time to whatever this module reads back out of
# Aurora — a stored row is not automatically trustworthy just because something upstream validated
# it once; a second, structurally different check in a different process.
_GLUE_IDENT_RE = re.compile(r'^[A-Za-z_][A-Za-z0-9_]{0,127}$')
_WORKGROUP_RE = re.compile(r'^[A-Za-z0-9._-]{1,128}$')
# MINOR fix (round 2): these used to be a byte-for-byte duplicate of
# `sg_rule_matching._ACCOUNT_ID_VALUE_RE`/`_REGION_VALUE_RE` — a drift risk (this module already
# imports `sg_rule_matching as sm`, so reuse its definitions directly instead of a second copy).
_ACCOUNT_ID_RE = sm._ACCOUNT_ID_VALUE_RE
_REGION_RE = sm._REGION_VALUE_RE
_DAY_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')


class BrokerError(Exception):
    pass


def _projection_range_upper_bound_expired(range_param, now):
    """CI-review MAJOR fix (round 9, part b): `projection.<col>.range`'s PRESENCE was validated
    above, but never whether the declared window still covers the current date — a common real
    misconfiguration is a closed range (e.g. `2020-01-01,2025-06-30`) an admin forgot to make
    open-ended, which Athena will happily accept as valid config while generating zero candidate
    partitions for any day past its end — genuinely empty (but wrong) results the `projection`
    strategy has no `_partition_exists` check to catch, so this would otherwise be committed as a
    confident false `no_observed_evidence`.

    Athena's projection range grammar supports several forms (`NOW`, `NOW-N/day`, arbitrary
    enum/integer bounds, etc.) that aren't all safely parseable here without guessing. Per the
    "safer path" contract used throughout this module: only the common, unambiguously-parseable
    closed-range-with-a-literal-`yyyy-MM-dd`-end-date form is checked. Anything else (a bare,
    exactly-`NOW`-anchored upper bound, or an upper bound this function can't confidently parse as
    a plain ISO date) is left unvalidated here rather than risk a false rejection — returns `None`
    in those cases (a caller checks `is True` for "confirmed expired", `is False`/`None` are both
    "no confirmed expiry, but not the same as an unparseable case").

    CI-review MAJOR fix (round 11): this used to treat ANY upper bound starting with the string
    `"NOW"` — including an OFFSET form like `NOW-45DAYS` — as "always covers the current date by
    construction," which is true only for the bare, unmodified `NOW`. `NOW-45DAYS` anchors 45 days
    BEFORE today and does NOT cover the current date at all; confidently asserting `False` (never
    expired) for it violates this function's own never-guess contract and could mask a genuinely
    expired range. Only an EXACT (case-insensitive) `NOW` with nothing else is treated as
    confirmed-covers-now; any other `NOW`-prefixed form falls through to the unparseable `None`
    case below, exactly like any other form this function doesn't confidently handle.

    Returns True (expired), False (confirmed still covers `now`), or None (couldn't confidently
    tell — not the common closed-range-with-literal-end-date form, nor a bare `NOW`).
    """
    if not range_param or "," not in range_param:
        return None
    upper = range_param.rsplit(",", 1)[-1].strip()
    if upper.upper() == "NOW":
        # Exactly NOW, unmodified — always covers the current date by construction.
        return False
    if not upper:
        return None
    try:
        upper_date = _dt.datetime.strptime(upper, "%Y-%m-%d").date()
    except ValueError:
        return None  # not the plain-ISO-literal form this check confidently handles (includes
        # any NOW-relative offset form like `NOW-45DAYS`, which this function does not parse)
    return upper_date < now.date()


def _shift_date(d, years=0, months=0, days=0):
    """Calendar-correct `d` shifted back by whole years/months (day-of-month clamped to the
    target month's length, e.g. Feb 29 - 1 year -> Feb 28) then by whole days."""
    total_months = d.year * 12 + (d.month - 1) - months - years * 12
    year, month = divmod(total_months, 12)
    month += 1
    day = min(d.day, calendar.monthrange(year, month)[1])
    return d.replace(year=year, month=month, day=day) - _dt.timedelta(days=days)


# CI-review MAJOR fix (round 15, part a; round 16 CORRECTION): this used to accept only
# `NOW-N<unit>` with YEARS/MONTHS/DAYS. Round 15 widened the unit set to WEEKS/HOURS/MINUTES/
# SECONDS but kept the sign fixed to `-` — Athena's own partition-projection range grammar
# documents BOTH `NOW-N<unit>` and `NOW+N<unit>` (e.g. a late-arrival/timezone-skew upper bound
# like `2020-01-01,NOW+1DAYS`). Round 15 also flipped an unresolved bound from fail-OPEN ("don't
# block") to fail-CLOSED ("refuse") — correct for a genuinely unparseable range, but a `NOW+…`
# bound isn't unparseable, it's simply a sign this regex didn't accept; combined with round 15's
# own fail-closed flip, a perfectly valid, previously-working source with a `NOW+`-anchored bound
# would now validate `status: "valid"` and then have EVERY scan permanently refuse — exactly the
# "validates valid yet permanently refuses every scan" class this PR series exists to close, and
# precisely the round-15 fail-closed fix's own failure mode if the grammar isn't fully covered.
# Both signs are exact, documented arithmetic — not a guess — so both must be parsed.
_NOW_OFFSET_RE = re.compile(
    r'^NOW\s*([+-])\s*(\d+)\s*(YEARS?|MONTHS?|WEEKS?|DAYS?|HOURS?|MINUTES?|SECONDS?)$', re.IGNORECASE)


def _projection_range_bound_date(value, now):
    """Resolves one `projection.<col>.range` bound (either side of the comma) to a concrete
    `date`, or `None` when it isn't one of the forms this can confidently resolve without
    guessing: a bare `NOW`, a `NOW[+-]N/UNIT` offset (an exact, documented Athena grammar — not a
    guess), or a plain `yyyy-MM-dd` literal. Anything else (an enum/integer bound, a malformed
    offset) is left unresolved."""
    value = (value or "").strip()
    if not value:
        return None
    if value.upper() == "NOW":
        return now.date()
    m = _NOW_OFFSET_RE.match(value)
    if m:
        sign, n, unit = (1 if m.group(1) == "+" else -1), int(m.group(2)), m.group(3).upper()
        if unit.startswith("YEAR"):
            return _shift_date(now.date(), years=-sign * n)
        if unit.startswith("MONTH"):
            return _shift_date(now.date(), months=-sign * n)
        if unit.startswith("WEEK"):
            return _shift_date(now.date(), days=-sign * n * 7)
        if unit.startswith("DAY"):
            return _shift_date(now.date(), days=-sign * n)
        if unit.startswith("HOUR"):
            return (now + _dt.timedelta(hours=sign * n)).date()
        if unit.startswith("MINUTE"):
            return (now + _dt.timedelta(minutes=sign * n)).date()
        return (now + _dt.timedelta(seconds=sign * n)).date()
    try:
        return _dt.datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError:
        return None


def _projection_range_day_status(range_param, day, now):
    """CI-review MAJOR fix (round 12, MAJOR #2): `_projection_range_upper_bound_expired` only
    ever runs once, at VALIDATE time, and only confidently flags the narrow bare-`NOW` closed-range
    form. A range like `NOW-3YEARS,NOW-45DAYS` resolves to `None` there (an offset upper bound is
    deliberately left unparsed by that check) and the source is persisted `status: "valid"`
    forever — but the range genuinely EXCLUDES every day in the last 45 days, so every recent
    scan silently gets zero candidate partitions and commits a confident false `no_observed_
    evidence` with no existence check to catch it (`projection` sources have no enumerable Glue
    partitions for `_partition_exists` to inspect). This is a separate, SCAN-time check against the
    actual day being queried (not just "has the range's end already passed `now`"), and resolves
    `NOW-N/UNIT` offsets exactly rather than leaving them unparsed, since day-membership needs both
    bounds to mean anything. Returns `True` (confirmed the day falls outside the declared range),
    `False` (confirmed it falls inside), or `None` (a bound didn't resolve to a concrete date —
    genuinely can't tell, not the same as "inside")."""
    if not range_param or "," not in range_param:
        return None
    lower_str, upper_str = range_param.split(",", 1)
    lower_date = _projection_range_bound_date(lower_str, now)
    upper_date = _projection_range_bound_date(upper_str, now)
    if lower_date is not None and day < lower_date:
        return True
    if upper_date is not None and day > upper_date:
        return True
    if lower_date is None or upper_date is None:
        return None
    return False


def _projection_integer_range_bound(value):
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


def _projection_integer_range_excludes(range_param, value):
    """Same 3-state contract as `_projection_range_day_status`, but for a Hive-style
    `year`/`month`/`day` projection column's plain-integer `.range` (e.g. `2020,2025`), not a
    date-literal one. Returns `True` (confirmed `value` outside the declared bounds), `False`
    (confirmed inside, or a bound didn't resolve), `None` only when the range has no comma at
    all (never actually reached below — a comma-less presence check already rejects that at
    validate time; kept for symmetry with `_projection_range_day_status`)."""
    if not range_param or "," not in range_param:
        return None
    lower_str, upper_str = range_param.split(",", 1)
    lower = _projection_integer_range_bound(lower_str)
    upper = _projection_integer_range_bound(upper_str)
    if lower is not None and value < lower:
        return True
    if upper is not None and value > upper:
        return True
    if lower is None or upper is None:
        return None
    return False


def _hive_day_excluded(actual_by_lower, params, day):
    """Returns `True` (confirmed excluded by at least one key's range), `False` (confirmed
    included by every key that has a range, or nothing to check), or `None` (at least one key's
    range didn't resolve confidently — genuinely can't tell, must not be treated as "included").

    CI-review MAJOR fix (round 15, part a): a range bound this module can't confidently resolve
    (an unparseable form, or previously any `WEEKS`/`HOURS`/`MINUTES`/`SECONDS` offset) used to be
    silently treated as "not excluded" here — fails OPEN for exactly the case the whole point of
    this check is to catch, inconsistent with this module's own Glue-API-error posture (which
    always fails CLOSED, i.e. refuses rather than trusts). `None` now propagates instead."""
    day_value = {"year": day.year, "month": day.month, "day": day.day}
    unresolved = False
    for hive_key, actual_key in actual_by_lower.items():
        range_param = params.get(f"projection.{actual_key}.range")
        if not range_param:
            continue
        status = _projection_integer_range_excludes(range_param, day_value[hive_key])
        if status is True:
            return True
        if status is None:
            unresolved = True
    return None if unresolved else False


def _projection_day_out_of_range(glue, database, table, day, validation, now=None):
    """Scan-time counterpart to `_partition_exists` for the `projection` strategy (which has no
    enumerable Glue partitions to check): before trusting a zero-row Athena result for `day` as
    genuine zero-traffic, confirm `day` actually falls within the resolved date key's own
    declared `projection.<col>.range`. Mirrors `_partition_exists`'s 3-state contract:
      - `True`  = confirmed the query window falls (at least partly) outside the declared range
                  (the empty result is a config/range mismatch, not zero traffic).
      - `False` = confirmed inside the range, or nothing checkable at all (no confirmed single
                  date key or Hive scheme, or no `.range` param present) — don't block.
      - `None`  = genuinely unverifiable — either a Glue API error, OR a declared `.range` bound
                  this module can't confidently resolve (see `_projection_range_bound_date`'s
                  supported grammar). CI-review MAJOR fix (round 15, part a) intentionally flipped
                  an unresolvable bound from the OLD `False` ("don't block," fails open exactly
                  where this check exists to catch a range mismatch) to this `None` ("refuse,"
                  matching the module's own Glue-error posture) — do not revert this to `False`.

    CI-review MAJOR fix (round 14): this used to check only `day` itself — but
    `sm._build_partition_predicate` (Hive delivery-time partitioning: a day-D flow can land in
    day D+1's partition file) widens the QUERY's own predicate to the two-day window {D, D+1},
    and round 3/4 already widened `_partition_exists` (the `partition_keys`-strategy counterpart)
    to match that SAME window. This projection-side check never did — for a day at the range's
    upper boundary, D itself validates in-range while D+1 generates no candidate partition, so
    day-D flows delivered late into D+1's partition are silently missed, a confident false
    zero-traffic day for a low-traffic day, the exact failure mode this PR's contract forbids
    (and the reason `_partition_exists` was widened in the first place). Both the single-key and
    Hive-integer branches below now check the WHOLE window, not just `day`."""
    next_day = day + _dt.timedelta(days=1)
    dk_raw = sm.single_date_partition_key(validation)
    if not dk_raw:
        # CI-review MAJOR fix (round 13, L2-1/L4-1): `single_date_partition_key` returns `None` BY
        # DESIGN for a Hive-style 3-key `year`/`month`/`day` layout (it only ever resolves a LONE
        # remaining key) — this function used to return `False` ("don't block") right here without
        # ever looking at `projection.year|month|day.range`, so a Hive projection table with, e.g.,
        # `projection.year.range=2020,2025` still validated `status: "valid"` (round 9 only checks
        # RANGE PRESENCE for Hive keys, not day-coverage — "remains a scan-time concern" per this
        # module's own changelog) and then silently committed a confident false zero-traffic day
        # for any post-2025 day — the precise failure mode this PR's contract exists to forbid.
        remaining = sm.partition_keys_excluding_scope(validation)
        actual_by_lower = {str(k).lower(): k for k in remaining}
        if set(actual_by_lower) != {"year", "month", "day"}:
            return False  # not a checkable scheme (neither single-key nor Hive)
        try:
            tbl = glue.get_table(DatabaseName=database, Name=table)["Table"]
        except Exception:  # noqa: BLE001 — unverifiable, not a confident "inside the range"
            return None
        params = tbl.get("Parameters", {}) or {}
        status_day = _hive_day_excluded(actual_by_lower, params, day)
        status_next = _hive_day_excluded(actual_by_lower, params, next_day)
        # CI-review MAJOR fix (round 15, part a): `is True` used to collapse an unresolved
        # (`None`) status into "don't block" — see `_hive_day_excluded`'s docstring.
        if status_day is True or status_next is True:
            return True
        if status_day is None or status_next is None:
            return None
        return False
    try:
        tbl = glue.get_table(DatabaseName=database, Name=table)["Table"]
    except Exception:  # noqa: BLE001 — unverifiable, not a confident "inside the range"
        return None
    proj_range = (tbl.get("Parameters", {}) or {}).get(f"projection.{dk_raw}.range")
    if not proj_range:
        return False
    now = now or _dt.datetime.now(_dt.timezone.utc)
    status_day = _projection_range_day_status(proj_range, day, now)
    status_next = _projection_range_day_status(proj_range, next_day, now)
    # CI-review MAJOR fix (round 15, part a): `is True` used to collapse an unresolved (`None`)
    # bound into "don't block," fail-OPEN for a range this module genuinely can't parse (e.g. a
    # `WEEKS`/`HOURS`/`MINUTES`/`SECONDS` offset before this round's grammar extension, or any
    # other form outside this module's confidently-parseable set) — the empty/undercounted result
    # would then be trusted as genuine, inconsistent with this same function's own fail-CLOSED
    # posture for a Glue API error just above.
    if status_day is True or status_next is True:
        return True
    if status_day is None or status_next is None:
        return None
    return False


def _validate_identifiers(account_id, region, workgroup, database, table=None, require_table=False):
    if not isinstance(account_id, str) or not _ACCOUNT_ID_RE.match(account_id):
        raise BrokerError("account_id must be a 12-digit AWS account id")
    if not isinstance(region, str) or not _REGION_RE.match(region):
        raise BrokerError("region must be a valid AWS region name")
    if not isinstance(workgroup, str) or not _WORKGROUP_RE.match(workgroup):
        raise BrokerError("workgroup must match the Athena workgroup-name charset")
    if not isinstance(database, str) or not _GLUE_IDENT_RE.match(database):
        raise BrokerError("database must be a valid Glue identifier")
    if require_table:
        if not isinstance(table, str) or not _GLUE_IDENT_RE.match(table):
            raise BrokerError("table must be a valid Glue identifier")


def _reject_non_select(sql):
    if not _SELECT_ONLY_RE.match(sql or ""):
        raise BrokerError("query must be a bare SELECT")
    if _FORBIDDEN_RE.search(sql):
        raise BrokerError("query contains a forbidden (mutating) keyword")


def _assumed_session(account_id, external_id, region):
    sts = boto3.client("sts", region_name=region)
    role_arn = f"arn:aws:iam::{account_id}:role/{_ROLE_NAME}"
    kwargs = {"RoleArn": role_arn, "RoleSessionName": _STS_SESSION_NAME, "DurationSeconds": 3600}
    if external_id:
        kwargs["ExternalId"] = external_id
    resp = sts.assume_role(**kwargs)
    c = resp["Credentials"]
    return boto3.Session(
        aws_access_key_id=c["AccessKeyId"], aws_secret_access_key=c["SecretAccessKey"],
        aws_session_token=c["SessionToken"], region_name=region,
    )


def _resolve_external_id(conn, account_id):
    """round-3 finding #6: resolve `external_id` from the trusted `accounts` table for `account_id`
    instead of trusting a caller-supplied value. Requires an `enabled` row; an unregistered/disabled
    account_id is rejected outright rather than silently assuming a role with no confused-deputy
    guard bound to a row this system actually trusts. Round-4 CI-review finding (L3, item 1):
    `_load_source_row` now also calls this helper (it used to have its own separate, guard-less
    `SELECT external_id FROM accounts WHERE account_id=:a` with no `enabled` predicate) — every
    external_id resolution in this module goes through the ONE enabled-required path."""
    rows = conn.run("SELECT external_id FROM accounts WHERE account_id=:a AND enabled", a=account_id)
    if not rows:
        raise BrokerError(
            f"account_id {account_id!r} is not a registered, enabled account in the accounts "
            "table — refusing to assume a role for an unregistered account")
    return rows[0][0]


def _validate(event, conn, now=None):
    # `now` is injectable (mirrors `sg_rule_scan.process_day`'s own `observed_at` pattern) so the
    # round-9 range-staleness check below stays testable without a real wall-clock dependency.
    now = now or _dt.datetime.now(_dt.timezone.utc)
    account_id = event.get("account_id")
    region = event.get("region")
    workgroup = event.get("workgroup")
    database = event.get("database")
    table = event.get("table")
    _validate_identifiers(account_id, region, workgroup, database, table, require_table=True)
    # round-3 finding #6: NEVER trust a caller-supplied `external_id` — every other action in this
    # module (per the round-2 redesign) resolves it server-side from the `accounts` table; `validate`
    # was the one holdout that still assumed Role B with a caller-chosen account_id AND a
    # caller-chosen external_id, bypassing the accounts table (and its confused-deputy guard)
    # entirely. `event.get("external_id")` is deliberately never read here anymore.
    external_id = _resolve_external_id(conn, account_id)
    session = _assumed_session(account_id, external_id, region)
    athena = session.client("athena")
    glue = session.client("glue")

    wg = athena.get_work_group(WorkGroup=workgroup)
    wg_config = wg.get("WorkGroup", {}).get("Configuration", {}) or {}
    result_config = wg_config.get("ResultConfiguration", {})
    if not result_config.get("OutputLocation"):
        raise BrokerError("workgroup has no configured query-results S3 location")
    # L3 finding #8c: require AWS itself to pre-emptively enforce a scan-bytes ceiling on this
    # workgroup, rather than relying solely on this module's own post-hoc (after Athena already
    # finished, cost already incurred) budget check.
    if not wg_config.get("BytesScannedCutoffPerQuery"):
        raise BrokerError("workgroup does not enforce a BytesScannedCutoffPerQuery — configure one before use")

    glue.get_database(Name=database)
    tbl = glue.get_table(DatabaseName=database, Name=table)["Table"]
    columns = [c["Name"].lower() for c in tbl.get("StorageDescriptor", {}).get("Columns", [])]
    # CI-review MAJOR fix (round 15, part c): name->Glue-type map for plain STORAGE columns,
    # mirroring `partition_key_types` below — needed so a scope key resolved as `"column"` (not
    # `"partition"`) can also be checked for a string-like catalog type.
    column_types = {c["Name"].lower(): c.get("Type", "")
                     for c in tbl.get("StorageDescriptor", {}).get("Columns", [])}
    # Canonical VPC Flow Log fields (+ their Athena underscore-normalized forms).
    required = {
        "interface_id": ["interface-id", "interface_id"],
        "srcaddr": ["srcaddr"], "dstaddr": ["dstaddr"],
        "srcport": ["srcport"], "dstport": ["dstport"],
        "protocol": ["protocol"], "action": ["action"], "log_status": ["log-status", "log_status"],
        "start": ["start"], "end": ["end"],
    }
    resolved = {}
    missing = []
    for canonical, aliases in required.items():
        hit = next((a for a in aliases if a.lower() in columns), None)
        if hit:
            resolved[canonical] = hit
        else:
            missing.append(canonical)
    if missing:
        raise BrokerError(f"table missing required Flow Log fields: {', '.join(missing)}")

    partition_keys = [c["Name"] for c in tbl.get("PartitionKeys", [])]
    # item 7 follow-up fix: a single-key partition scheme (the non-Hive-style branch of
    # `_build_partition_predicate`/`_partition_exists`) is only safe to treat as a date column when
    # Glue's own catalog says its type actually IS a date/string type — an int/bigint-typed single
    # key (or any type this module hasn't confirmed) must never be assumed to accept an ISO date
    # string literal. Persisted alongside partitionKeys so the matching engine can gate on it.
    partition_key_types = [c.get("Type", "") for c in tbl.get("PartitionKeys", [])]

    # MAJOR fix (item 1, round 2): `sg_rule_matching._build_scope_predicate` scopes the generated
    # day-SELECT to this source's own account_id/region, but the round-1 fix resolved those two
    # fields ONLY from `StorageDescriptor.Columns` — and centralized/org-wide flow-log tables
    # canonically carry account/region as PARTITION KEYS, never plain columns, which left the scope
    # predicate permanently unreachable for exactly the table layout this feature was built to
    # guard. Also, round-1 only matched the exact underscore names, while the REQUIRED-field loop
    # above already accepts hyphen aliases (`interface-id`, `log-status`) for the SAME reason a
    # Glue crawler would name a column `account-id` — extend that same alias mechanism here rather
    # than inventing a new one. Resolve from the UNION of PartitionKeys and Columns, apply each of
    # account_id/region INDEPENDENTLY (a table exposing only one of the two still gets the
    # available half of scoping, which is strictly better than none), and prefer the partition-key
    # form when both resolve the same canonical name — only the partition-key form actually PRUNES
    # scanned partition files; the column form is a post-scan filter only.
    lower_partition_keys = {k.lower(): k for k in partition_keys}
    scope_aliases = {
        "account_id": ["account_id", "account-id", "aws-account-id", "aws_account_id"],
        "region": ["region", "aws-region", "aws_region"],
    }
    scope_resolution = {}  # canonical -> "partition" | "column" | None
    for canonical, aliases in scope_aliases.items():
        pk_hit = next((a for a in aliases if a.lower() in lower_partition_keys), None)
        if pk_hit:
            resolved[canonical] = lower_partition_keys[pk_hit.lower()]
            scope_resolution[canonical] = "partition"
            continue
        col_hit = next((a for a in aliases if a.lower() in columns), None)
        if col_hit:
            resolved[canonical] = col_hit
            scope_resolution[canonical] = "column"
        else:
            scope_resolution[canonical] = None
    # Explicitly recorded (not just inferred from absence) so operators can distinguish a
    # genuinely single-account table from a mis-detected org-wide one — a source that resolves
    # NEITHER field is scanned entirely unscoped, which used to be silent.
    scanned_unscoped = scope_resolution["account_id"] is None and scope_resolution["region"] is None

    projection_enabled = (tbl.get("Parameters", {}) or {}).get("projection.enabled") == "true"
    if not partition_keys and not projection_enabled:
        raise BrokerError("table has no partition keys or partition projection — cannot bound a scan")
    strategy = "projection" if projection_enabled else "partition_keys"

    # CI-review MAJOR fix (round 10, L2-1; corrected round 11): the projection.<col>.type/.format/
    # .range gates below (rounds 7/8/9) only ever ran over the date-candidate keys REMAINING after
    # excluding account_id/region scope keys — they never checked the SCOPE keys themselves.
    # Athena requires projection configuration for EVERY partition column once
    # `projection.enabled=true`, so a projection-enabled centralized table partitioned
    # `dt + account-id + region` (the exact layout the round-2 scope fix exists to support)
    # validated `status: "valid"` with no check that `projection.account-id.*`/`projection.region.*`
    # even exist — Athena then errors on every real query, reproducing this PR's own "validates
    # valid yet permanently refuses" class for the intersection of its two headline scenarios.
    #
    # Round 10's first attempt accepted ANY of `enum/integer/date/injected` for a scope key — but
    # `sm._build_scope_predicate`/`scope_partition_expr_clauses` always compare the source's own
    # LITERAL string value (`"region" = 'ap-northeast-2'`). An `integer`- or `date`-typed
    # projection column generates typed values that can never equal that literal string — the
    # predicate matches zero rows on every real scan, and `enum` was accepted without ever
    # confirming `projection.<col>.values` actually CONTAINS the source's own value. Since
    # `projection` has no `_partition_exists` existence check, every such day would commit a
    # confident false `no_observed_evidence` — precisely the failure mode this PR's contract most
    # explicitly forbids, reintroduced by the very gate meant to close it. Only two projection
    # types can ever generate a value equal to the source's own literal: `injected` (any string
    # value is accepted verbatim, by definition representable), or `enum` whose declared
    # `projection.<col>.values` list is confirmed to contain that exact literal.
    if strategy == "projection":
        proj_params = tbl.get("Parameters", {}) or {}
        scope_literal_values = {"account_id": account_id, "region": region}
        for canonical in ("account_id", "region"):
            if scope_resolution.get(canonical) != "partition":
                continue
            scope_col = resolved[canonical]
            scope_type_param = str(proj_params.get(f"projection.{scope_col}.type") or "").strip().lower()
            if scope_type_param == "injected":
                continue  # any string value passes through untyped — always representable.
            if scope_type_param == "enum":
                declared_values = {
                    v.strip() for v in str(proj_params.get(f"projection.{scope_col}.values") or "").split(",")
                }
                if scope_literal_values[canonical] in declared_values:
                    continue
                raise BrokerError(
                    f"scope partition key {scope_col!r} ({canonical}) is a PROJECTION column typed "
                    f"'enum' but its declared projection.{scope_col}.values does not include this "
                    f"source's own value ({scope_literal_values[canonical]!r}) — the query predicate "
                    "would never match, silently committing a confident false zero-traffic day "
                    "[reason: projection_scope_enum_value_missing]")
            raise BrokerError(
                f"scope partition key {scope_col!r} ({canonical}) is a PROJECTION column with "
                f"projection.{scope_col}.type={scope_type_param!r} — the query predicate always "
                "compares this source's own literal string value, which only an 'injected' "
                "projection (or an 'enum' whose values list contains that literal) can ever match; "
                "'integer'/'date'/absent generates typed values that can never equal the literal, "
                "silently matching zero rows on every real scan "
                "[reason: projection_scope_type_not_representable]")

    # CI-review MAJOR fix (round 14): the round-11 catalog-type check (string-like Glue type
    # required) only ever ran for the Hive `year`/`month`/`day` keys and the single remaining date
    # key — never for a `partition_keys`-strategy SCOPE key (`account_id`/`region` resolved as an
    # actual partition column, not the `projection` strategy's own scope-type gate just above,
    # which is a different check for a different strategy). `sm._build_scope_predicate`/
    # `scope_partition_expr_clauses` always compare this source's own literal STRING value
    # (`"account-id" = '123456789012'`) — a Glue-crawler-misinferred `bigint`/`int` catalog type for
    # a numeric-looking partition value (a common misinference for 12-digit account ids) makes that
    # comparison `bigint = varchar`, which Trino rejects outright. Such a source still validated
    # `status: "valid"` (nothing checked the scope key's catalog type at all) and then every real
    # query permanently refused — the "validates valid yet permanently refuses every scan" class
    # rounds 2/4/5/8/9/13 already close for every OTHER partition key in this module.
    # CI-review MAJOR fix (round 15, part c): the round-14 check above only ever looked at
    # `scope_resolution == "partition"`, gated to `strategy == "partition_keys"` — but
    # `sm._build_scope_predicate` builds the SAME literal-string-comparison SQL predicate for a
    # scope key resolved as a plain `"column"` too (see the `col_hit` branch above), regardless of
    # `strategy`. A Glue-crawler-misinferred `bigint`/`int` catalog type for a numeric-looking
    # STORAGE column (the exact misinference round 14 cites for a partition column) validated
    # `status: "valid"` with no check at all, then hit the SAME `bigint = varchar` Trino rejection
    # on every real query — reproducing the class round 14 closes, just for the other resolution
    # kind. Covers `"column"` for BOTH strategies here (a `"partition"`-resolved scope key under
    # `projection` already gets its own, different type-representability check above).
    for canonical in ("account_id", "region"):
        if scope_resolution.get(canonical) != "column":
            continue
        scope_col = resolved[canonical]
        scope_key_type = column_types.get(scope_col.lower(), "")
        if not sm.is_string_like_partition_type(scope_key_type):
            raise BrokerError(
                f"scope column {scope_col!r} ({canonical}) has Glue type {scope_key_type!r}, "
                "which is not string-like — the query predicate always compares this source's own "
                "literal string value, and a non-string-like catalog type (e.g. a "
                "crawler-misinferred bigint/int for a numeric-looking value) makes that comparison "
                "a type mismatch Trino rejects on every real query "
                "[reason: scope_key_not_string_typed]")

    if strategy == "partition_keys":
        for canonical in ("account_id", "region"):
            if scope_resolution.get(canonical) != "partition":
                continue
            scope_col = resolved[canonical]
            idx = next(i for i, k in enumerate(partition_keys) if k == scope_col)
            scope_key_type = partition_key_types[idx] if idx < len(partition_key_types) else ""
            if not sm.is_string_like_partition_type(scope_key_type):
                raise BrokerError(
                    f"scope partition key {scope_col!r} ({canonical}) has Glue type "
                    f"{scope_key_type!r}, which is not string-like — the query predicate always "
                    "compares this source's own literal string value, and a non-string-like "
                    "catalog type (e.g. a crawler-misinferred bigint/int for a numeric-looking "
                    "value) makes that comparison a type mismatch Trino rejects on every real "
                    "query [reason: scope_key_not_string_typed]")

    # MAJOR fix (item 4, round 2; corrected item 1, round 3; extended to `projection`, round 5): a
    # partition-key layout is only a valid, scannable strategy when it resolves EXACTLY ONE
    # bound-able date candidate AFTER excluding whatever partition keys were already resolved as
    # account_id/region SCOPE keys above — the SAME exclusion-aware logic `sm.single_date_partition_key`/
    # `sm.has_resolved_partition_strategy` apply at RUNTIME (this module's own `_query_by_source`
    # hard-refuses via that check) for BOTH strategies — `has_resolved_partition_strategy` has no
    # strategy-conditional branch at all. Round 2's fix only ever checked `len(partition_keys) == 1`,
    # which (a) validated `status: "valid"` for a `dt + account-id + region` layout (3 partition
    # keys) that then permanently refused to scan at runtime, since date detection there ALSO used
    # to require exactly one TOTAL key — the exact validate-vs-scan mismatch the CI review flagged
    # a third time; and (b) would have validated a single SCOPE-only key (e.g. just `account-id`,
    # no date key at all) as long as its Glue type happened to be string-like, since it never
    # excluded scope keys before checking date-shape at all. Round 4 closed both gaps for
    # `partition_keys` but left this check gated to that ONE strategy — a `projection`-strategy
    # source with a non-date-typed (e.g. `bigint`) single partition key still validated
    # `status: "valid"` yet the SAME unconditional runtime gate refused every scan, reopening the
    # exact mismatch this fix exists to close, just for the other strategy. Both gaps are closed by
    # running the SAME `sm.partition_keys_excluding_scope` exclusion here that scan-time uses,
    # regardless of `strategy`, then requiring either a Hive-style year/month/day scheme among what
    # remains, or exactly one remaining date-typed key — zero or more than one remaining (non-Hive)
    # candidate has no bounded date strategy and must be rejected outright, never silently left to
    # fail at scan time.
    if strategy in ("partition_keys", "projection"):
        probe_validation = {
            "partitionKeys": partition_keys, "partitionKeyTypes": partition_key_types,
            "scopeResolution": scope_resolution, "columnMap": resolved,
        }
        remaining_keys = sm.partition_keys_excluding_scope(probe_validation)
        lower_remaining = {str(k).lower() for k in remaining_keys}
        # CI-review MAJOR fix (round 12): every check below used a SUBSET test
        # (`{"year","month","day"} <= lower_remaining`) to detect the Hive scheme — true for a
        # `year/month/day/hour` (or `.../vpc_id`) layout too, which has a FOURTH remaining
        # partition key that then never gets its own `projection.<col>.*`/catalog-type validated
        # at all (Athena requires projection config for every partition column once enabled, so
        # that extra key's real query would error permanently). The strict "exactly one remaining
        # key" rejection two blocks below only ever ran in the `else` of the subset test, so a
        # 4-key layout satisfied the subset test, skipped that rejection, and validated `status:
        # "valid"` with an unvalidated 4th key. Hive-style detection must require an EXACT match
        # (no extra remaining keys) — an off-schema superset gets no special-cased pass and falls
        # through to the same "does not resolve a single bounded date candidate" rejection a
        # 2-key or 0-key mismatch already gets.
        is_hive_style = lower_remaining == {"year", "month", "day"}
        # CI-review MAJOR fix (round 11): the single-key (non-Hive) branch below has always
        # required the Glue-catalog TYPE to be date-shaped (`sm.is_date_like_partition_type`)
        # before trusting a lone key as a date column — but the Hive year/month/day branch NEVER
        # checked the catalog type of those three columns AT ALL, in either strategy.
        # `sm._build_partition_predicate`/`_partition_exists` always emit quoted STRING literals
        # for the Hive branch (`"month" = '03'`), so an `int`/`bigint`-typed year/month/day column
        # validates `status: "valid"` here and then has Trino reject `integer = varchar` on every
        # real query — reproducing this PR's own "validates valid yet permanently refuses every
        # scan" class a sixth time, for exactly the asymmetry between the two date-detection
        # branches this validate-time gate was built to eliminate. Require each of year/month/day
        # to be a string-like Glue catalog type (matching what the predicate builder assumes).
        if is_hive_style:
            for hive_key in ("year", "month", "day"):
                actual_key = next(k for k in remaining_keys if str(k).lower() == hive_key)
                idx = next(i for i, k in enumerate(partition_keys) if k == actual_key)
                catalog_type = partition_key_types[idx] if idx < len(partition_key_types) else ""
                if not sm.is_string_like_partition_type(catalog_type):
                    raise BrokerError(
                        f"Hive-style partition key {actual_key!r} ({hive_key}) has Glue catalog "
                        f"type {catalog_type!r} — the generated day predicate always compares a "
                        "quoted STRING literal for year/month/day columns, which Trino rejects "
                        "against a non-string-typed (e.g. int/bigint) column on every real query "
                        "[reason: hive_key_not_string_typed]")
        # CI-review MAJOR fix (round 9): the projection-parameter validation added in rounds
        # 7/8 (below) lived ENTIRELY inside the single-key `else` branch of the
        # `{"year","month","day"} <= lower_remaining` check, so it never ran at all for a
        # Hive-style year/month/day PROJECTION layout — the exact "validates valid yet
        # permanently refuses/false-zeros every scan" class this PR fixes elsewhere, just for
        # the OTHER branch this time. A Hive-style projection column conventionally uses
        # `projection.<col>.type=integer` (year/month/day are plain zero-padded integers, not
        # `date`-typed), each requiring its own `.range` — validate that here, symmetrically with
        # the single-key branch's own `.type`/`.range` checks below.
        if strategy == "projection" and is_hive_style:
            params = tbl.get("Parameters", {}) or {}
            for hive_key in ("year", "month", "day"):
                actual_key = next(k for k in remaining_keys if str(k).lower() == hive_key)
                proj_type_param = params.get(f"projection.{actual_key}.type")
                if not proj_type_param or proj_type_param.strip().lower() != "integer":
                    raise BrokerError(
                        f"Hive-style partition key {actual_key!r} ({hive_key}) is a PROJECTION "
                        f"column with projection.{actual_key}.type={proj_type_param!r} — Athena "
                        "requires this parameter to be present and 'integer' for a zero-padded "
                        "numeric year/month/day projection column; a missing or wrong-typed value "
                        "is an invalid/unqueryable projection configuration and every real scan "
                        "would fail [reason: projection_hive_type_not_integer]")
                if not params.get(f"projection.{actual_key}.range"):
                    raise BrokerError(
                        f"Hive-style partition key {actual_key!r} ({hive_key}) is a PROJECTION "
                        f"column missing projection.{actual_key}.range — Athena requires a range "
                        "for every projected partition column; without it the configuration is "
                        "invalid/unqueryable [reason: projection_hive_range_missing]")
                # CI-review MAJOR fix (round 10, L4-1): the day-SELECT/existence-check predicates
                # this module builds (`sm._build_partition_predicate`/`_partition_exists`) always
                # compare ZERO-PADDED string literals (`"month" = '03'`, `"day" = '05'`) — but
                # Athena's `integer`-typed partition projection generates UNPADDED values
                # (`month=3`, not `month=03`) unless `projection.<col>.digits` is explicitly set.
                # A gate-approved table missing `.digits` on month/day therefore matches ZERO rows
                # on every real scan — and `projection` has no `_partition_exists` existence check
                # to catch it, so each such day is committed as a confident false
                # `no_observed_evidence` for real traffic: exactly the false-zero failure mode this
                # PR's honest-degrade contract most explicitly forbids, reintroduced by this same
                # gate. `year` is always 4 digits either way (no padding ambiguity), so only
                # month/day need a digits check.
                if hive_key in ("month", "day"):
                    proj_digits = params.get(f"projection.{actual_key}.digits")
                    if str(proj_digits).strip() != "2":
                        raise BrokerError(
                            f"Hive-style partition key {actual_key!r} ({hive_key}) is a PROJECTION "
                            f"column with projection.{actual_key}.digits={proj_digits!r} — the "
                            f"generated predicate compares a zero-padded 2-digit value; without "
                            f"projection.{actual_key}.digits=2, Athena's unpadded integer "
                            "projection values would match zero rows on every real scan, silently "
                            "committing a confident false zero-traffic day "
                            "[reason: projection_hive_digits_not_zero_padded]")
        if not is_hive_style:
            if len(remaining_keys) != 1:
                raise BrokerError(
                    "partition-key layout does not resolve a single bounded date candidate after "
                    "excluding resolved account_id/region scope keys — expected either a "
                    "Hive-style year/month/day scheme or exactly one remaining date-typed key "
                    "[reason: partition_key_no_date_candidate]")
            remaining_key = remaining_keys[0]
            idx = next(i for i, k in enumerate(partition_keys) if k == remaining_key)
            key_type = partition_key_types[idx] if idx < len(partition_key_types) else ""
            if not sm.is_date_like_partition_type(key_type):
                raise BrokerError(
                    f"single partition key {remaining_key!r} has Glue type {key_type!r}, which is "
                    "not date-shaped (expected date/timestamp/string/varchar/char) — this source "
                    "can never be bounded to a day and must not be scanned; use a Hive-style "
                    "year/month/day partitioned table or re-partition on a date-typed key "
                    "[reason: partition_key_type_not_date_shaped]")
            # MINOR fix (L4 finding, round 6; closed round 7): a `string`-typed single partition
            # key under the PROJECTION strategy is trusted by the check above to hold an ISO
            # `YYYY-MM-DD` date string — but partition projection lets the table's own
            # `projection.<col>.format` parameter declare a DIFFERENT (Java `SimpleDateFormat`-
            # style) pattern, e.g. `yyyy/MM/dd`, and `projection.<col>.type` can declare the
            # projection is `enum`/`integer`/`injected` (arbitrary or epoch-shaped values), NOT a
            # date at all — regardless of what the Glue CATALOG column type happens to say. There
            # is no `_partition_exists` existence check for projection tables (unlike
            # `partition_keys`), so either mismatch would silently match ZERO rows every day and
            # commit a confident `no_observed_evidence` for real traffic.
            #
            # CI-review MAJOR fix (round 7): this check used to (a) compare `key_type` with a bare
            # `== "string"`, missing the SAME length-parameterized `varchar(10)`/`char(20)` forms
            # `sm.is_string_like_partition_type` exists to handle (a `varchar`-typed projection key
            # sailed through unchecked), and (b) never looked at `projection.<col>.type` at all, so an
            # `enum`/`integer`/`injected` projection on a string-typed key passed through whenever
            # no `.format` param happened to be set (treated as "safe ISO default"). Both are
            # closed together: normalize the type before the string-like membership check, and
            # explicitly require `projection.<col>.type` to be `date` — anything else is rejected
            # outright, matching this fix's own "rather than assume ISO, take the safer path"
            # rationale.
            #
            # CI-review MAJOR fix (round 8): round 7 still ACCEPTED `projection.<col>.type` being
            # ABSENT — but Athena requires this parameter for every partition column when
            # `projection.enabled=true` (an enabled-projection table with a partition column
            # missing its own `.type` is not a valid/queryable projection configuration per
            # Athena's own documented contract, regardless of what this module assumes). A source
            # missing it therefore validated `status: "valid"` here and then errored on EVERY real
            # scan attempt — the exact "validates valid yet permanently refuses every scan" class
            # this PR has already fixed at validation time in rounds 2, 4, and 5, reopened at this
            # one remaining edge. Require the parameter to be PRESENT and exactly `date`.
            if strategy == "projection":
                proj_type_param = (tbl.get("Parameters", {}) or {}).get(f"projection.{remaining_key}.type")
                if not proj_type_param or proj_type_param.strip().lower() != "date":
                    raise BrokerError(
                        f"partition key {remaining_key!r} is a PROJECTION column with "
                        f"projection.{remaining_key}.type={proj_type_param!r} — Athena requires this "
                        "parameter to be present and exactly 'date' for every projected partition "
                        "column; a missing or non-'date' value is either an invalid/unqueryable "
                        "projection configuration or one whose values ('enum'/'integer'/'injected') "
                        "are not guaranteed ISO date strings, and either way every real scan would "
                        "fail or silently match zero rows [reason: projection_type_not_date]")
                # CI-review MAJOR fix (round 13, L2-2/L4-2): the round-12 `.format`-required check
                # used to live INSIDE `if sm.is_string_like_partition_type(key_type):` — but
                # `.format` is required by Athena for every `projection.<col>.type=date` column
                # regardless of the underlying Glue CATALOG type, not just a string-like one. A
                # Glue `date`-/`timestamp`-typed partition key with `projection.<col>.type=date`
                # and a missing/non-ISO `.format` still validated `status: "valid"` here (the check
                # above only confirms `.type=date`) and then every real scan would error — the
                # "validates valid yet permanently refuses every scan" class rounds 2/4/5/8/9 close
                # elsewhere. Runs unconditionally now, for every `.type=date` key.
                proj_format = (tbl.get("Parameters", {}) or {}).get(f"projection.{remaining_key}.format")
                # CI-review MAJOR fix (round 12, MAJOR #3): absence of `.format` used to be
                # accepted here as "Athena's own ISO default" — but Athena has no such default;
                # `.format` is a REQUIRED parameter for a `date`-typed projection column
                # (https://docs.aws.amazon.com/athena/latest/ug/partition-projection-supported-types.html),
                # and omitting it is itself an invalid/unqueryable projection configuration, not
                # a safe assumption — every real scan would fail (or silently match zero rows),
                # exactly the class of bug the presence checks above (`.type`/`.range`) already
                # close for their own parameters.
                if not proj_format or proj_format.strip() != "yyyy-MM-dd":
                    raise BrokerError(
                        f"partition key {remaining_key!r} is a PROJECTION column with "
                        f"projection.{remaining_key}.format={proj_format!r} — Athena requires "
                        "this parameter to be present and exactly 'yyyy-MM-dd' for a date-typed "
                        "projection column (it has no ISO default); a missing or non-ISO value "
                        "is either an invalid/unqueryable projection configuration or would "
                        "silently match zero rows every day "
                        "[reason: projection_date_format_missing_or_not_iso]")
                # CI-review MAJOR fix (round 9): `projection.<col>.range` was never validated at
                # all — Athena requires it for every `date`-typed projection column, and its
                # absence means Athena has no candidate partitions to generate at all, so every
                # real scan would fail (or, per Athena's own behavior for an unrecognized/invalid
                # range, silently produce none — indistinguishable at this layer from a genuine
                # zero-traffic day, since `projection` has no `_partition_exists` existence check
                # to catch it). This only confirms PRESENCE (not that the declared range covers any
                # particular day being scanned — that remains a scan-time concern).
                proj_range = (tbl.get("Parameters", {}) or {}).get(f"projection.{remaining_key}.range")
                if not proj_range:
                    raise BrokerError(
                        f"partition key {remaining_key!r} is a PROJECTION column missing "
                        f"projection.{remaining_key}.range — Athena requires a range for every "
                        "date-typed projected partition column; without it the configuration is "
                        "invalid/unqueryable [reason: projection_range_missing]")
                # CI-review MAJOR fix (round 9, part b): a PRESENT but stale range (upper bound
                # already in the past) is just as unqueryable for TODAY's scan as a missing one —
                # see `_projection_range_upper_bound_expired`'s docstring for exactly which range
                # forms this can confidently detect (a closed range with a literal `yyyy-MM-dd` end
                # date) versus which it deliberately leaves unvalidated (`NOW`-anchored or any other
                # form it can't confidently parse without guessing).
                if _projection_range_upper_bound_expired(proj_range, now) is True:
                    raise BrokerError(
                        f"partition key {remaining_key!r} is a PROJECTION column whose "
                        f"projection.{remaining_key}.range={proj_range!r} upper bound has already "
                        "passed — Athena will generate no candidate partitions for the current or "
                        "any future date, so every real scan from today onward would silently match "
                        "zero rows [reason: projection_range_expired]")

    optional_present = [c for c in ("flow-direction", "flow_direction", "tcp-flags", "tcp_flags",
                                    "bytes", "packets") if c.lower() in columns]
    return {
        "ok": True, "schemaFields": sorted(resolved.values()), "partitionStrategy": strategy,
        "optionalFields": optional_present, "partitionKeyTypes": partition_key_types,
        # The canonical -> actual-alias mapping AND the actual partition key names, persisted by
        # web/lib/sg-rules.ts into sg_flow_sources.validation so this module's own
        # `query_by_source` action (via sg_rule_matching.build_day_select) can use the REAL
        # resolved schema instead of hardcoding underscore names / an unbounded scan.
        "columnMap": resolved, "partitionKeys": partition_keys,
        "scopeResolution": scope_resolution, "scannedUnscoped": scanned_unscoped,
    }


# ── Aurora resolution (L3 finding #6): the broker now owns its own Aurora connectivity, mirroring
#    db.py/sg_rule_dispatcher.py's rds-db IAM-auth pattern — never a cached credential. ────────────

def _load_source_row(conn, flow_source_id):
    """Round-4 CI-review finding (L3, items 1 + 3): this used to (a) resolve `external_id` via a
    bare `SELECT external_id FROM accounts WHERE account_id=:a` — no `AND enabled` — falling back to
    `None` on a miss, so `_assumed_session` would still attempt a guard-less `sts:AssumeRole` for a
    disabled or unregistered account; and (b) never look at `sg_flow_sources.enabled` at all, so a
    disabled flow source (the same disable switch the daily dispatcher's `WHERE enabled` and
    `sg_rule_scan.load_source`'s explicit raise both already honor) could still be scanned by calling
    this broker's `query_by_source` action directly, bypassing the dispatcher entirely. Both gaps are
    closed here: `external_id` is now resolved via `_resolve_external_id` (the SAME enabled-required
    helper `validate` uses), and the `enabled` column is selected and enforced."""
    rows = conn.run(
        "SELECT account_id, region, workgroup, database_name, table_name, validation, enabled "
        "FROM sg_flow_sources WHERE id=:id", id=flow_source_id)
    if not rows:
        raise BrokerError(f"no sg_flow_sources row for id={flow_source_id!r}")
    r = rows[0]
    account_id, region, workgroup, database_name, table_name, validation, enabled = (
        r[0], r[1], r[2], r[3], r[4], r[5], r[6])
    if not enabled:
        raise BrokerError(f"sg_flow_sources id={flow_source_id!r} is disabled — refusing to scan")
    if isinstance(validation, str):
        import json as _json
        try:
            validation = _json.loads(validation)
        except (ValueError, TypeError):
            validation = {}
    validation = validation or {}
    external_id = _resolve_external_id(conn, account_id)
    return {
        "account_id": account_id, "region": region, "workgroup": workgroup,
        "database_name": database_name, "table_name": table_name, "validation": validation,
        "external_id": external_id,
    }


def _partition_exists(glue, database, table, day, validation, source=None):
    """Best-effort Glue GetPartitions check (L4 finding #9(iii)): before trusting a zero-row Athena
    result as "no traffic that day", confirm at least one partition actually matches the day's
    predicate — a wrong/guessed partition-key mapping can otherwise silently match zero partitions
    and look exactly like a genuine zero-traffic day. Only meaningful for the `partition_keys`
    strategy (partition projection has no enumerable Glue partitions to check).

    Item 8 follow-up fix: returns one of THREE states now, not a boolean —
      - `True`  = confirmed at least one matching partition exists (or the scheme isn't checkable,
                  e.g. a single non-date-typed key — nothing to disprove, so don't block on it).
      - `False` = confirmed zero matching partitions (the check the caller actually wants).
      - `None`  = genuinely unverifiable (a Glue API error, or an unsafe/unresolvable identifier).
    The docstring on the OLD boolean-returning version claimed a Glue error was "treated as cannot
    verify (True)", but the caller (`_query_by_source`) reads a truthy return as "a partition WAS
    found, so trust the zero-row Athena result as genuine zero-traffic" — collapsing "unverifiable"
    into the SAME value as "confirmed present" is exactly backwards: it lets a transient Glue API
    hiccup silently manufacture a confident zero-traffic day. `None` lets the caller refuse to
    commit that day's watermark instead, and retry on the next run.

    Item 3 follow-up fix (round 3): `source` (the resolved sg_flow_sources row, carrying its own
    account_id/region) is now accepted so the Expression can ALSO be scoped by any account_id/
    region field that resolved as an actual Glue partition key (sm.scope_partition_expr_clauses)
    -- without it, a Hive-style year/month/day table that ALSO partitions by account/region (the
    layout item 1's fix makes scannable) would report "a partition exists" for ANY tenant's
    partition, not necessarily this resolved source's own, and a mis-resolved scope mapping could
    silently manufacture a confident zero-traffic day. `source` defaults to None (existing
    single-tenant-table callers/tests, where there is nothing to scope) so the Expression is
    unchanged when there's no scope to add."""
    dk_raw = sm.single_date_partition_key(validation)  # item 7: only a CONFIRMED date-typed single key
    partition_keys = validation.get("partitionKeys") or []
    lower_keys = {k.lower(): k for k in partition_keys}
    scope_clauses = sm.scope_partition_expr_clauses(validation, source) if source is not None else []
    # MAJOR fix: `sg_rule_matching._build_partition_predicate` widens the QUERY's partition
    # predicate to {D, D+1} (Hive partitions are keyed by delivery time, so day-D flows can land in
    # day D+1's partition file), but this existence check used to look at day D alone in BOTH
    # branches. A day D with legitimately zero traffic (hence no D partition) whose D+1 partition
    # does exist would then be reported as "zero partitions matched" forever, permanently stalling
    # the watermark. The check window must match the query window exactly.
    next_day = day + _dt.timedelta(days=1)
    try:
        # MINOR fix: re-apply the SAME identifier-safety helper this module's own SQL builders
        # (`sg_rule_matching.build_day_select`/`build_day_skipdata_count_select`) use before ever
        # interpolating a stored partition-key name into a Glue `Expression` string.
        #
        # CI-review MAJOR fix (round 4, two issues fixed together per the review's own
        # recommendation): (1) identifiers below are now double-quoted — Glue's `GetPartitions`
        # `Expression` is parsed by JSQLParser, the same quoted-identifier SQL grammar Athena uses,
        # and `_safe_ident` deliberately allows hyphens (AWS's own `interface-id` convention); a
        # BARE hyphenated name (e.g. `account-id`) parses as arithmetic subtraction, raising and
        # permanently refusing every day for that table. (2) literals below are now ALWAYS plain
        # quoted strings, never the typed `DATE '...'`/`TIMESTAMP '...'` form `sm.date_literal()`
        # emits for Athena SQL — Glue partition values are stored as raw strings in the Hive
        # metastore regardless of the column's declared catalog type, and Glue's Expression grammar
        # documents partition-value comparisons as plain string literals; a typed literal risks the
        # exact same permanent-refusal failure mode as the unquoted-identifier bug.
        if {"year", "month", "day"} <= set(lower_keys):
            y = sm._safe_ident(lower_keys["year"], "year")
            mo = sm._safe_ident(lower_keys["month"], "month")
            d = sm._safe_ident(lower_keys["day"], "day")
            expr = (
                f'("{y}" = \'{day.year:04d}\' AND "{mo}" = \'{day.month:02d}\' AND "{d}" = \'{day.day:02d}\')'
                f' OR ("{y}" = \'{next_day.year:04d}\' AND "{mo}" = \'{next_day.month:02d}\' '
                f'AND "{d}" = \'{next_day.day:02d}\')'
            )
        elif dk_raw:
            dk = sm._safe_ident(dk_raw, "")
            if not dk:
                return None  # unsafe identifier — genuinely unverifiable, per the 3-state contract above
            key_type = sm.single_date_partition_key_type(validation)
            if key_type == "timestamp":
                # Mirrors the SQL-side range fix in `sm._build_partition_predicate`: a
                # `timestamp`-typed partition value is not guaranteed to sit at exact midnight, so
                # an equality/IN check would silently report "no partition" for a legitimately
                # non-midnight value. A half-open range matches any value in the two-day window.
                after_next_day = next_day + _dt.timedelta(days=1)
                expr = (
                    f'"{dk}" >= \'{day.isoformat()} 00:00:00\' '
                    f'AND "{dk}" < \'{after_next_day.isoformat()} 00:00:00\''
                )
            else:
                expr = f'"{dk}" IN (\'{day.isoformat()}\', \'{next_day.isoformat()}\')'
        else:
            return True  # not a checkable single/hive-style scheme — do not block on it
        if scope_clauses:
            # Item 3 follow-up fix (round 3): the existence check's Expression must be scoped to
            # this SAME resolved source's own account/region partition values, exactly like the
            # actual query's own predicate — otherwise "a partition exists" is true for any
            # tenant's partition, not necessarily this one.
            expr = f"({expr}) AND {' AND '.join(scope_clauses)}"
        resp = glue.get_partitions(DatabaseName=database, TableName=table, Expression=expr, MaxResults=1)
        return bool(resp.get("Partitions"))
    except Exception:  # noqa: BLE001 — a genuinely unverifiable check must never manufacture a
        return None    # confident "zero traffic" OR a confident "partition present" — both are guesses.


def _run_athena_query(session, workgroup, database, sql, max_bytes):
    athena = session.client("athena")
    start = athena.start_query_execution(
        QueryString=sql, QueryExecutionContext={"Database": database}, WorkGroup=workgroup)
    qid = start["QueryExecutionId"]
    deadline = time.time() + _MAX_POLL_S
    status = None
    exec_ = {}
    scanned_bytes = 0
    while time.time() < deadline:
        exec_ = athena.get_query_execution(QueryExecutionId=qid)["QueryExecution"]
        status = exec_["Status"]["State"]
        scanned_bytes = int((exec_.get("Statistics") or {}).get("DataScannedInBytes") or 0)
        if status in ("SUCCEEDED", "FAILED", "CANCELLED"):
            break
        time.sleep(_POLL_INTERVAL_S)
    else:
        try:
            athena.stop_query_execution(QueryExecutionId=qid)
        except Exception:  # noqa: BLE001
            pass
        return {"ok": False, "reason": "poll deadline exceeded", "query_execution_id": qid}

    if status != "SUCCEEDED":
        reason = (exec_.get("Status", {}) or {}).get("StateChangeReason", status)
        return {"ok": False, "reason": reason, "query_execution_id": qid, "status": status}

    if scanned_bytes > max_bytes:
        return {
            "ok": False, "reason": "scan-bytes budget exceeded", "query_execution_id": qid,
            "data_scanned_bytes": scanned_bytes,
        }
    return {"ok": True, "query_execution_id": qid, "data_scanned_bytes": scanned_bytes, "athena": athena}


def _fetch_page(athena, qid, next_token, first_page):
    kwargs = {"QueryExecutionId": qid, "MaxResults": _PAGE_SIZE}
    if next_token:
        kwargs["NextToken"] = next_token
    page = athena.get_query_results(**kwargs)
    result_rows = page["ResultSet"]["Rows"]
    columns = None
    if first_page:
        if result_rows:
            columns = [c.get("VarCharValue") for c in result_rows[0]["Data"]]
        result_rows = result_rows[1:]
    rows = []
    for r in result_rows:
        values = [c.get("VarCharValue") for c in r["Data"]]
        rows.append(values)
    return columns, rows, page.get("NextToken")


def _rows_as_dicts(columns, raw_rows):
    return [dict(zip(columns or [], values)) for values in raw_rows]


def _query_by_source(event, conn):
    flow_source_id = event.get("flow_source_id")
    day_str = event.get("day")
    if not isinstance(flow_source_id, int) or isinstance(flow_source_id, bool) or flow_source_id <= 0:
        raise BrokerError("flow_source_id must be a positive integer")
    if not isinstance(day_str, str) or not _DAY_RE.match(day_str):
        raise BrokerError("day must be an ISO date string (YYYY-MM-DD)")
    day = _dt.date.fromisoformat(day_str)
    max_bytes = min(int(event.get("max_bytes") or _DEFAULT_MAX_BYTES), _DEFAULT_MAX_BYTES)

    source = _load_source_row(conn, flow_source_id)
    _validate_identifiers(source["account_id"], source["region"], source["workgroup"],
                           source["database_name"], source["table_name"], require_table=True)

    validation = source["validation"]
    status = validation.get("status")
    if status != "valid":
        # L3 finding #8a: a 'pending' (or any other non-'valid') source has never been fully
        # confirmed against the real table schema — it must not be scanned.
        return {"ok": False, "reason": f"source validation.status={status!r} is not 'valid' — refusing to scan"}
    if not sm.has_resolved_partition_strategy(validation):
        # L3 finding #8b: no resolved bound means an unbounded full-table scan — refuse outright
        # rather than silently falling back to one.
        return {"ok": False, "reason": "validation did not resolve a partition strategy — refusing an unbounded scan"}
    if "partitionKeyTypes" not in validation or "scopeResolution" not in validation:
        # CI-review MAJOR fix (round 13, L3-1): the round-8 stale-validation self-heal/refusal
        # (`sg_rule_scan.run()`'s "predates partitionKeyTypes/scopeResolution" check) was only ever
        # enforced by ONE of this broker's callers. `has_resolved_partition_strategy` is satisfied
        # by a bare Hive-style year/month/day layout without needing either field, so a pre-round-2
        # source that has never picked up the round-2/6/8 scope-resolution and date-shape fixes
        # still passes both guards above and would scan account/region-UNSCOPED — this module's own
        # design contract (see the `continuation` handling above) is that any principal able to
        # invoke this broker directly (the worker AND the web BFF task role both hold
        # `lambda:InvokeFunction` on it) must be refused by THIS function, not rely on a caller
        # that happens to self-heal first. Refuse here too, independent of `run()`'s own self-heal.
        return {
            "ok": False,
            "reason": "stale validation predates partitionKeyTypes/scopeResolution and cannot be "
                      "trusted to be scoped/date-shaped correctly — refusing to scan; re-run "
                      "validate to refresh it",
        }

    try:
        sql = sm.build_day_select(source, day)
    except sm.UnsafeIdentifier as e:
        raise BrokerError(f"unsafe identifier in resolved source config: {e}")
    _reject_non_select(sql)

    continuation = event.get("continuation")
    if continuation:
        # round-3 finding #5: a caller-supplied query_execution_id/next_token/columns used to be
        # trusted with NO binding back to the source/day/workgroup/broker-origin, and skipped every
        # validation-status/partition/byte-budget check the initial call enforces — any principal
        # with lambda:InvokeFunction on this broker could page through the results of ANY Athena
        # query reachable by AWSopsSgRuleAthenaRole, not just one this broker itself started
        # (re-opening the same class of hole the L3 finding #6 redesign closed). Fix (option (a) from
        # the review): re-validate status/partition-strategy above (now shared with the fresh-query
        # path), rebuild the EXACT SQL this flow_source_id+day would produce server-side, and require
        # the caller's query_execution_id to belong to a REAL Athena execution whose own WorkGroup +
        # QueryString match that rebuilt SQL exactly — a continuation token for a foreign query (any
        # other query reachable by the assumed role) fails this comparison and is rejected before any
        # data is ever paged out.
        qid = continuation.get("query_execution_id")
        columns = continuation.get("columns")
        if not qid:
            raise BrokerError("continuation.query_execution_id is required")
        session = _assumed_session(source["account_id"], source["external_id"], source["region"])
        athena = session.client("athena")
        try:
            exec_ = athena.get_query_execution(QueryExecutionId=qid)["QueryExecution"]
        except Exception as e:  # noqa: BLE001 — an unresolvable qid is a rejection, not a crash
            raise BrokerError(f"continuation.query_execution_id could not be resolved: {e}")
        if exec_.get("WorkGroup") != source["workgroup"] or exec_.get("Query") != sql:
            # The execution this qid actually points to is NOT the query this resolved
            # flow_source_id+day would itself produce — refuse to page it out, regardless of who's
            # asking or what they claim `columns`/`next_token` should be.
            raise BrokerError(
                "continuation.query_execution_id does not match the resolved source's own query — "
                "refusing to page results of a foreign Athena query")
        # Round-4 CI-review finding (L3, item 4): the initial `_run_athena_query` call rejects an
        # over-budget execution ONLY after it completes (Athena has already run it — cost is
        # already incurred), but that rejection response still includes `query_execution_id`. Before
        # this fix, a continuation call re-verified workgroup+SQL identity (round-3 finding #5) but
        # never rechecked `DataScannedInBytes`, so a query that WAS rejected as over-budget could
        # still have its results paged out via `continuation` — the byte-budget control only ever
        # gated the FIRST page. Reuse the SAME `get_query_execution` response already fetched above
        # (no extra API call) to re-check the scanned bytes against this source's own resolved
        # budget before paging any further.
        scanned_bytes = int((exec_.get("Statistics") or {}).get("DataScannedInBytes") or 0)
        if scanned_bytes > max_bytes:
            return {
                "ok": False, "reason": "scan-bytes budget exceeded", "query_execution_id": qid,
                "data_scanned_bytes": scanned_bytes,
            }
        _, raw_rows, next_token = _fetch_page(athena, qid, continuation.get("next_token"), first_page=False)
        return {
            "ok": True, "rows": _rows_as_dicts(columns, raw_rows), "columns": columns,
            "query_execution_id": qid, "next_token": next_token, "done": next_token is None,
        }

    session = _assumed_session(source["account_id"], source["external_id"], source["region"])
    result = _run_athena_query(session, source["workgroup"], source["database_name"], sql, max_bytes)
    if not result.get("ok"):
        return result
    athena = result.pop("athena")
    columns, raw_rows, next_token = _fetch_page(athena, result["query_execution_id"], None, first_page=True)

    # CI-review MAJOR fix (round 15): this used to run ONLY inside the `if not raw_rows and not
    # next_token:` branch below — but the query's own predicate deliberately widens to the two-day
    # {D, D+1} window (Hive delivery-time partitioning), and when D returns SOME rows while D+1 is
    # excluded by the declared range, `projection` generates no D+1 candidate partition even though
    # matching S3 data may exist there — day-D flows delivered late into D+1 are silently missed,
    # producing an undercount (or, for a rule whose only flows were late-delivered, a confident
    # false `no_observed_evidence`) that a raw_rows-non-empty check can never catch. Unlike
    # `partition_keys` (whose D+1 Glue partition, if it exists, is always enumerable regardless of
    # row count), this is `projection`-specific — its "no enumerable partitions to check" property
    # is exactly what makes a range mismatch invisible on a non-empty result too. Runs
    # unconditionally now, before the empty-result-only checks.
    if validation.get("partitionStrategy") == "projection":
        glue = session.client("glue")
        out_of_range = _projection_day_out_of_range(
            glue, source["database_name"], source["table_name"], day, validation)
        if out_of_range is True:
            return {
                "ok": False,
                "reason": "the day's query window falls (at least partly) outside the resolved "
                          "partition key's own projection.<col>.range — the result cannot be "
                          "trusted as complete",
                "projection_range_uncovered": True,
            }
        if out_of_range is None:
            # CI-review MAJOR fix (round 16): this message used to hardcode "(Glue API error)" as
            # the cause, but `_projection_day_out_of_range` returns `None` for TWO distinct
            # reasons — a Glue API error, or a declared `projection.<col>.range` bound this module
            # genuinely can't parse (see `_projection_range_bound_date`'s supported grammar). The
            # latter is at least as likely in practice, and telling an operator to investigate
            # Glue IAM/API health for what's actually a config problem sends them looking in the
            # wrong place.
            return {
                "ok": False,
                "reason": "could not verify whether the day's query window falls within the "
                          "resolved partition key's projection range — either a Glue API error, "
                          "or the declared projection.<col>.range uses a form this module cannot "
                          "confidently parse — not trusting the result as complete",
                "partition_check_unverified": True,
            }

    if not raw_rows and not next_token:
        # L4 finding #9(iii)/round-3 finding #3: before trusting an empty result as "no traffic",
        # verify the partition predicate actually matched something — but ONLY for the enumerable
        # `partition_keys` strategy. A partition-projection table has no enumerable Glue partitions
        # at all (Athena computes candidate partitions from the projection config, not from a Glue
        # catalog listing), so this check can never find anything for it — the old OR-clause below
        # (`partitionKeys and optionalFields is not None`) was always true for a projection table too
        # (`_validate` always emits both), so every legitimate zero-traffic day on a
        # projection-configured source failed with `zero_partition_match` and the watermark never
        # advanced. Restrict strictly to `partition_keys` — trust the query's own predicate for
        # projection tables, there is nothing to enumerate.
        if validation.get("partitionStrategy") == "partition_keys":
            glue = session.client("glue")
            exists = _partition_exists(glue, source["database_name"], source["table_name"], day,
                                        validation, source=source)
            if exists is False:
                return {
                    "ok": False,
                    "reason": "zero Glue partitions matched the day's predicate — likely a wrong "
                              "partition-key mapping, not a genuine zero-traffic day",
                    "zero_partition_match": True,
                }
            if exists is None:
                # item 8 follow-up fix: a Glue API error (or an unsafe stored identifier) means
                # this could NOT be verified either way — committing the day as zero-traffic here
                # would risk manufacturing a confident false negative from a transient AWS hiccup.
                # Refuse and let the next scheduled run retry; the watermark is never advanced.
                return {
                    "ok": False,
                    "reason": "could not verify whether any Glue partition matches the day's "
                              "predicate (Glue API error) — not trusting the empty result as "
                              "genuine zero-traffic",
                    "partition_check_unverified": True,
                }

    skipdata_count = None
    try:
        skip_sql = sm.build_day_skipdata_count_select(source, day)
        skip_result = _run_athena_query(session, source["workgroup"], source["database_name"], skip_sql, max_bytes)
        if skip_result.get("ok"):
            skip_athena = skip_result.pop("athena")
            _, skip_rows, _ = _fetch_page(skip_athena, skip_result["query_execution_id"], None, first_page=True)
            if skip_rows and skip_rows[0]:
                skipdata_count = int(skip_rows[0][0] or 0)
    except Exception:  # noqa: BLE001 — the SKIPDATA coverage signal is best-effort, never fatal
        skipdata_count = None

    return {
        "ok": True, "rows": _rows_as_dicts(columns, raw_rows), "columns": columns,
        "query_execution_id": result["query_execution_id"], "next_token": next_token,
        "done": next_token is None, "data_scanned_bytes": result.get("data_scanned_bytes"),
        "skipdata_count": skipdata_count,
    }


def lambda_handler(event, _ctx, conn_factory=None):
    action = event.get("action")
    try:
        if action == "validate":
            # Cheap identifier re-validation BEFORE opening any Aurora connection — a malformed
            # request must fail fast without ever touching the DB (matches the pre-existing,
            # test-enforced contract that a bad identifier never reaches an AWS/DB call).
            _validate_identifiers(event.get("account_id"), event.get("region"), event.get("workgroup"),
                                   event.get("database"), event.get("table"), require_table=True)
        if action in ("validate", "query_by_source"):
            # round-3 finding #6: `validate` now also needs Aurora connectivity (to resolve
            # external_id from the `accounts` table) — the same rds-db IAM-auth pattern as
            # `query_by_source` already uses.
            import db  # deferred: only these actions need Aurora/pg8000 connectivity
            conn = (conn_factory or db.connect)()
            try:
                if action == "validate":
                    return _validate(event, conn)
                return _query_by_source(event, conn)
            finally:
                try:
                    conn.close()
                except Exception:  # noqa: BLE001
                    pass
        return {"ok": False, "reason": f"unknown action: {action!r}"}
    except BrokerError as e:
        return {"ok": False, "reason": str(e)}
    except Exception as e:  # noqa: BLE001 — never let a raw AWS exception leak un-shaped
        # MINOR fix: this reason can be persisted into an operator-readable field downstream
        # (sg_rule_scan_runs.coverage) — redact common leaky shapes (ARN/account id/query id).
        return {"ok": False, "reason": sm.redact_sensitive(f"{type(e).__name__}: {e}")}
