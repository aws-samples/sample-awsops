"""SG Rules & Usage — pure matching engine (no DB/boto3 imports; unit-tested in isolation).

Implements the design spec's "Match model" + "Why versioning" sections:
docs/superpowers/specs/2026-08-13-security-group-rules-usage-design.md

Everything here is a pure function over already-fetched inputs (rule dicts, flow-log rows,
membership snapshots, rule-version rows) — no AWS/DB calls. sg_rule_scan.py wires this to Aurora
+ the Athena broker; this module is what the "Matching" test list in the spec's Testing section
targets directly.
"""
import hashlib
import ipaddress
import json
import re
from datetime import datetime, timedelta, timezone

PROTO_NAME = {"6": "tcp", "17": "udp", "1": "icmp", "58": "icmpv6"}

# MINOR fix: a raw AWS exception message persisted verbatim into an operator-readable field
# (`sg_rule_scan_runs.coverage`'s `reason`, etc.) can embed an ARN/account id/Athena
# QueryExecutionId — strip those common leaky shapes (never a full redaction framework) before
# persisting. Shared here since both sg_rule_scan.py and sg_rule_athena_broker.py already import
# this boto3-free module.
_ARN_RE = re.compile(r'arn:aws[a-zA-Z0-9-]*:[a-zA-Z0-9-]+:[a-zA-Z0-9-]*:\d{12}:[^\s\'"]+')
_UUID_RE = re.compile(r'\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b')
_ACCOUNT_ID_RE = re.compile(r'(?<!\d)\d{12}(?!\d)')


def redact_sensitive(text):
    if not text:
        return text
    text = _ARN_RE.sub("<arn-redacted>", text)
    text = _UUID_RE.sub("<id-redacted>", text)
    text = _ACCOUNT_ID_RE.sub("<account-redacted>", text)
    return text

# Row cap shared by the day-SELECT's own `LIMIT` and the caller-side pagination-accumulation cap
# (L2 finding #4 / L4 finding #9(i)) — if a day's accumulated row count reaches this exact number,
# the result MUST be treated as possibly-truncated (the LIMIT may have cut off real data), never as
# a confident "this is everything."
ROW_LIMIT = 200_000


class UnsafeIdentifier(Exception):
    """Raised by `_safe_ident` when a caller-controlled identifier fails strict allowlist
    validation AND no safe fallback name was supplied — e.g. `database_name`/`table_name`, where
    silently substituting a different table would be worse than refusing outright (L3 finding #7)."""


# ── Rule fingerprint (sg_rule_inventory_versions) ────────────────────────────────────────────────

def rule_fingerprint(rule: dict) -> str:
    """Stable hash of the fields that define a rule's SHAPE (not its identity/timestamps). Two
    snapshots of the same rule_id with identical shape must hash identically so a same-shape
    re-snapshot never spuriously opens a new version row."""
    shape = {
        "group_id": rule["group_id"], "is_egress": bool(rule["is_egress"]),
        "protocol": rule["protocol"], "from_port": rule.get("from_port"),
        "to_port": rule.get("to_port"), "peer_kind": rule["peer_kind"],
        "peer_value": rule["peer_value"],
    }
    blob = json.dumps(shape, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


# ── Day-granularity fingerprint-epoch-crossing check ─────────────────────────────────────────────

def day_bounds_utc(day) -> tuple:
    """`day` a date -> (start_of_day, end_of_day) as timezone-aware UTC datetimes, end EXCLUSIVE."""
    start = datetime(day.year, day.month, day.day, tzinfo=timezone.utc)
    return start, start + timedelta(days=1)


def version_covering(versions: list, at: datetime):
    """The single sg_rule_inventory_versions row whose [valid_from, valid_to) covers instant `at`,
    or None. `versions` is a list of dicts with valid_from/valid_to (valid_to may be None = open)."""
    for v in versions:
        vf = v["valid_from"]
        vt = v.get("valid_to")
        if vf <= at and (vt is None or at < vt):
            return v
    return None


def day_coverage(versions: list, day, observation_lag: timedelta = timedelta(days=1)) -> dict:
    """Per the spec's "Why versioning" section: a day matches confidently only if ONE version's
    [valid_from, valid_to) covers the WHOLE day (start-of-day AND end-of-day resolve to the same
    version row, by identity — not just equal fingerprint, since valid_from/valid_to distinguish
    epochs even when a rule flips back to an identical shape). If they differ (or either boundary
    resolves to no version at all), the day is `fingerprint_epoch_crossing` and MUST be classified
    `unassessable` for that rule/day — never a lower-bound number (spec's own round-12 self-check).

    Item 3 follow-up fix: `valid_from`/`valid_to` are *observation* timestamps (when the daily scan
    first/last saw a fingerprint) per the migration's own header comment — NOT the actual rule-change
    timestamp. A rule that changed at, say, 14:00 on day D is only observed at the NEXT scan run,
    which closes the old version with `valid_to` = that scan's run time (some time on day D+1). The
    real change could have happened anywhere in `(valid_to - observation_lag, valid_to]` — a window
    bounded by the scan cadence (`observation_lag`, default one day between successive daily scans).
    If that uncertainty window overlaps this day (i.e. `valid_to - observation_lag < end`), part of
    day D's traffic may have occurred under either the old or the new shape — the day can't be
    confidently attributed to the version that merely *covers* it, even though a single version's
    interval technically spans start-of-day through end-of-day. This only applies to a version whose
    `valid_to` is closed (a still-open version, `valid_to is None`, keeps the pre-existing "no
    lower bound assumed" behavior — never a false negative from a change that hasn't happened yet).

    Item 2 follow-up fix (round 2): `observation_lag` used to be a FIXED value derived from the
    nominal scan cadence (`SG_RULE_SCAN_INTERVAL_HOURS`, nominally 24h) — but that's wrong whenever
    scans were actually delayed or missed for multiple days: the real change could have happened
    anywhere in the WHOLE gap since the previous successful scan, not just within one nominal
    cadence period. Callers (`sg_rule_scan.py`) now resolve `observation_lag` from the ACTUAL elapsed
    gap between successive successful `sg_rule_scan_runs` rows for this source before passing it in.
    `observation_lag=None` means that gap is unknown (no reasonably recent previous successful run to
    compare against, e.g. the very first scan) — a closed version's day can then never be trusted as
    confident, and is marked crossing/unassessable rather than guessing a window.

    Item 2 follow-up fix (round 3): a single, run-wide `observation_lag` scalar is only correct for
    the version boundary that THIS run itself just closed — every OTHER (historical) closed version
    a rescan-window day might resolve to needs the gap that preceded the run that closed THAT
    boundary, not the gap before the CURRENT run's own `now`. `observation_lag` may therefore also be
    a CALLABLE `f(valid_to) -> timedelta|None` — called lazily, exactly once per covering version's
    `valid_to`, so each historical boundary gets its own correctly-anchored lag instead of the
    current run's. A plain `timedelta`/`None` (non-callable) keeps the pre-existing single-value
    behavior unchanged (still used directly by every test in this module and by any caller that
    genuinely only has one uniform value to offer).

    Returns {"crossing": bool, "version": dict|None} — version is set only when NOT crossing.
    """
    start, end = day_bounds_utc(day)
    at_start = version_covering(versions, start)
    # end is exclusive; check the instant just before day-end (end - epsilon), i.e. "at or before
    # end of day" — using `end` minus a microsecond avoids falsely picking up a version whose
    # valid_from == end (a version starting exactly at midnight belongs to the NEXT day only).
    at_end = version_covering(versions, end - timedelta(microseconds=1))
    if at_start is None or at_end is None:
        return {"crossing": True, "version": None}
    same = (at_start.get("valid_from") == at_end.get("valid_from"))
    if not same:
        return {"crossing": True, "version": None}
    valid_to = at_start.get("valid_to")
    if valid_to is not None:
        lag = observation_lag(valid_to) if callable(observation_lag) else observation_lag
        if lag is None:
            # No reasonably recent previous successful scan (relative to THIS boundary's own
            # closing observation) to derive a real gap from — never guess a window; treat this
            # closed version's day as unassessable.
            return {"crossing": True, "version": None, "reason": "observation_lag_unknown"}
        if (valid_to - lag) < end:
            # The actual change to this version's successor could have happened inside day D's own
            # window (per the docstring above) — the day's true rule-shape is ambiguous, not
            # confident.
            return {"crossing": True, "version": None, "reason": "observation_lag_boundary"}
    return {"crossing": False, "version": at_start}


# ── ENI/SG membership resolution (nearest-prior-in-time, staleness-bounded) ──────────────────────

def resolve_membership_snapshot(snapshots: list, day, staleness_days: int, earliest_snapshot_at=None):
    """`snapshots` sorted or unsorted list of dicts with `observed_at` (datetime), for one
    account/region/vpc. Returns (snapshot_or_None, outcome) where outcome is one of:
      - "in_window": nearest-prior-or-equal-to end-of-day snapshot found within staleness_days
      - "stale": a prior snapshot exists but it's older than staleness_days relative to this day
      - "pre_snapshotting_backfill": day is older than the EARLIEST snapshot this source ever took
        -> pinned to that earliest snapshot (fixed reference, not "whatever's current now" — see
        the spec's "Initial historical backfill" section for why this must never float).
      - "no_snapshot": no snapshot exists at all (source never snapshotted, or wrong vpc)
    """
    if not snapshots:
        return None, "no_snapshot"
    _, day_end = day_bounds_utc(day)
    ordered = sorted(snapshots, key=lambda s: s["observed_at"])
    earliest = ordered[0]
    earliest_at = earliest_snapshot_at or earliest["observed_at"]
    if day_end <= earliest_at:
        # Day predates (or is exactly at) the earliest snapshot ever taken for this source — pin to
        # that fixed earliest snapshot, regardless of what other snapshots exist "now".
        return earliest, "pre_snapshotting_backfill"
    # Nearest snapshot at-or-before end of day.
    candidates = [s for s in ordered if s["observed_at"] <= day_end]
    if not candidates:
        return None, "no_snapshot"
    nearest = max(candidates, key=lambda s: s["observed_at"])
    age_days = (day_end - nearest["observed_at"]).total_seconds() / 86400.0
    if age_days <= staleness_days:
        return nearest, "in_window"
    return nearest, "stale"


# ── Peer / CIDR / SG-reference / prefix-list matching ────────────────────────────────────────────

def _is_v6(addr: str) -> bool:
    return ":" in addr


def ip_in_cidr(addr: str, cidr: str) -> bool:
    try:
        return ipaddress.ip_address(addr) in ipaddress.ip_network(cidr, strict=False)
    except ValueError:
        return False


def eni_matches_vpc_scope(target_vpc_id: str, eni_vpc_id: str, peered_or_shared_vpc_ids: set) -> bool:
    """SG-reference resolution must scope to the flow's own VPC plus any VPC known to be able to
    legally reference it (peering / RAM shared-VPC participant) — never "any VPC" (RFC1918 overlap
    would let an unrelated VPC's ENI match by coincidence) and never "same VPC only" (that produces
    a false no_observed_evidence for legitimately cross-VPC-referenced rules)."""
    return eni_vpc_id == target_vpc_id or eni_vpc_id in peered_or_shared_vpc_ids


def resolve_sg_peer_ips(snapshot: dict, group_id: str) -> set:
    """IPs of ENIs in `snapshot` (one point-in-time membership row's aggregate — callers pass the
    resolved snapshot for the relevant vpc) that carry `group_id`. `snapshot` shape:
    {"eni_id":..., "group_ids": [...], "private_ips": [...]}. Callers typically pass a LIST of
    such rows for one observed_at and reduce; this helper handles one row."""
    if group_id in (snapshot.get("group_ids") or []):
        return set(snapshot.get("private_ips") or [])
    return set()


class MatchOutcome:
    MATCH = "match"
    NO_MATCH = "no_match"
    UNASSESSABLE = "unassessable"  # structurally cannot be decided (pl, IPv6-unsupported, etc.)


def match_protocol_port(rule: dict, flow_protocol: str, flow_port) -> bool:
    if rule["protocol"] != "all":
        proto_name = PROTO_NAME.get(str(flow_protocol), str(flow_protocol))
        if proto_name != rule["protocol"]:
            return False
    from_port = rule.get("from_port")
    to_port = rule.get("to_port")
    if from_port is not None and from_port != -1:
        if flow_port is None:
            return False
        if flow_port < from_port or flow_port > (to_port if to_port is not None else from_port):
            return False
    return True


def match_peer(rule: dict, peer_ip: str, sg_peer_ip_resolver=None, prefix_list_resolver=None) -> str:
    """Returns a MatchOutcome. `sg_peer_ip_resolver(group_id) -> set[str] | None` (None = SG not
    resolvable this window -> unassessable, per ruleMatchable's precedent in sg-analysis.ts).
    `prefix_list_resolver(pl_id) -> set[str] | None` (entries as CIDRs; None = not resolvable)."""
    kind = rule["peer_kind"]
    if kind == "cidr":
        if _is_v6(rule["peer_value"]) != _is_v6(peer_ip):
            return MatchOutcome.NO_MATCH
        if rule["peer_value"] in ("0.0.0.0/0", "::/0"):
            return MatchOutcome.MATCH
        return MatchOutcome.MATCH if ip_in_cidr(peer_ip, rule["peer_value"]) else MatchOutcome.NO_MATCH
    if kind == "sg":
        if sg_peer_ip_resolver is None:
            return MatchOutcome.UNASSESSABLE
        ips = sg_peer_ip_resolver(rule["peer_value"])
        if ips is None:
            return MatchOutcome.UNASSESSABLE
        return MatchOutcome.MATCH if peer_ip in ips else MatchOutcome.NO_MATCH
    if kind == "pl":
        if prefix_list_resolver is None:
            return MatchOutcome.UNASSESSABLE
        entries = prefix_list_resolver(rule["peer_value"])
        if entries is None:
            return MatchOutcome.UNASSESSABLE
        return MatchOutcome.MATCH if any(ip_in_cidr(peer_ip, e) for e in entries) else MatchOutcome.NO_MATCH
    return MatchOutcome.UNASSESSABLE


def match_flow_against_rule(rule: dict, flow: dict, sg_peer_ip_resolver=None, prefix_list_resolver=None) -> str:
    """Single flow-tuple vs one candidate rule -> MatchOutcome. `flow` shape:
    {"peer_ip":..., "port":..., "protocol":..., "direction": "ingress"|"egress"|None}.
    ICMP/ICMPv6 rules are structurally unassessable (from_port/to_port are type/code, not a port
    range — comparing against a Flow Log dstport is meaningless, mirrors sg-analysis.ts)."""
    if rule["protocol"] in ("icmp", "icmpv6"):
        return MatchOutcome.UNASSESSABLE
    if flow.get("direction") is not None:
        want_egress = flow["direction"] == "egress"
        if want_egress != bool(rule["is_egress"]):
            return MatchOutcome.NO_MATCH
    if not match_protocol_port(rule, flow.get("protocol"), flow.get("port")):
        return MatchOutcome.NO_MATCH
    return match_peer(rule, flow["peer_ip"], sg_peer_ip_resolver, prefix_list_resolver)


def classify_rule_day(compatible_count: int, overlap_count: int, has_source: bool, unassessable: bool) -> str:
    """Roll one rule/day's counters into the spec's 5-way classification."""
    if not has_source:
        return "not_configured"
    if unassessable and compatible_count == 0:
        return "unassessable"
    if overlap_count > 0:
        return "overlapping"
    if compatible_count > 0:
        return "observed_compatible"
    return "no_observed_evidence"


# ── Identifier re-validation + the day-SELECT builder (shared by sg_rule_scan.py's caller-side
#    tests and, per the L3 #6/#7 broker redesign, by sg_rule_athena_broker.py itself — the broker
#    now resolves a source's config from Aurora and builds this SQL SERVER-SIDE, so the builder
#    must live in a boto3-free module both processes can import cheaply) ────────────────────────

_IDENT_RE = re.compile(r'^[A-Za-z_][A-Za-z0-9_-]{0,127}$')


def _safe_ident(name, fallback=None):
    """Defense-in-depth re-validation of a column/database/table identifier. Allows '-' too: AWS's
    own default VPC Flow Log Athena tables name columns like "interface-id"/"log-status"
    (hyphenated). When `fallback` is given, an invalid `name` silently falls back to it (safe for
    column aliases, where the fallback is just "assume the canonical underscore name"). When
    `fallback` is None (database_name/table_name — there is no safe substitute for an entire
    table), an invalid `name` raises `UnsafeIdentifier` instead of ever being interpolated."""
    if isinstance(name, str) and _IDENT_RE.match(name):
        return name
    if fallback is not None:
        return fallback
    raise UnsafeIdentifier(f"unsafe identifier: {name!r}")


_ACCOUNT_ID_VALUE_RE = re.compile(r'^\d{12}$')
_REGION_VALUE_RE = re.compile(r'^[a-z]{2,4}(-[a-z]+)+-\d$')


def _safe_scope_value(value, pattern):
    """Defense-in-depth re-validation of a literal VALUE (not an identifier) interpolated into a
    generated SQL string — used for `account_id`/`region` scoping (item 4 follow-up fix). Unlike
    `_safe_ident`, there is no safe fallback for a scope value: an invalid one means the resolved
    source row itself is corrupted, and refusing to build the query is the only safe option."""
    if isinstance(value, str) and pattern.match(value):
        return value
    raise UnsafeIdentifier(f"unsafe scope value: {value!r}")


# item 7 follow-up fix: Glue catalog types that are safe to assume accept an ISO date-string
# literal (`'2026-03-05'`) for a single (non-Hive-style) partition key — a plain `date`/`timestamp`
# column, or a string/varchar/char column storing the date as text (the common
# manually-partitioned Flow Log table pattern). An int/bigint/etc.-typed key must never be assumed
# to accept a string literal. (Item 3 follow-up fix, round 2, extends this set with "timestamp" —
# see `date_literal` below for why the LITERAL FORM still differs per type even though all of these
# are accepted as "safe to bound a scan on.")
_DATE_LIKE_PARTITION_TYPES = {"date", "string", "varchar", "char", "timestamp"}

_TYPE_PARAM_SUFFIX_RE = re.compile(r'\(.*\)$')


def _normalize_glue_type(type_str) -> str:
    """CI-review MAJOR fix (round 6): Glue/Hive legitimately types a column `varchar(10)`/`char(20)`
    (length-parameterized) — a lowercased exact-string membership check against
    `_DATE_LIKE_PARTITION_TYPES` never matches those, even though the underlying type IS
    varchar/char. This is a regression: base code (before this round's fixes) built the ISO-date
    predicate for ANY lone partition key regardless of type, so a `varchar(10)` date-as-text column
    scanned fine before, and a bare exact-match check now permanently refuses it (with no rescue
    path — re-validation raises `BrokerError` too, since `sg_rule_athena_broker._validate` calls the
    same `is_date_like_partition_type` at validate time). Strips a trailing parenthesized
    length/precision suffix (`varchar(10)` -> `varchar`, `decimal(10,2)` -> `decimal`) before any
    date-likeness comparison."""
    return _TYPE_PARAM_SUFFIX_RE.sub("", str(type_str or "").strip().lower())


def is_date_like_partition_type(type_str) -> bool:
    """Public accessor for `_DATE_LIKE_PARTITION_TYPES` — used by
    `sg_rule_athena_broker._validate` (item 4 follow-up fix, round 2) to reject a single-key
    partition strategy AT VALIDATION TIME when the Glue-catalog type isn't date-shaped, instead of
    letting it validate `status: "valid"` and then have the runtime scan
    (`has_resolved_partition_strategy`) permanently refuse every real scan. Normalizes away any
    parameterized length/precision suffix first (round 6 fix, see `_normalize_glue_type`)."""
    return _normalize_glue_type(type_str) in _DATE_LIKE_PARTITION_TYPES


# The subset of `_DATE_LIKE_PARTITION_TYPES` that stores the date as TEXT (as opposed to `date`/
# `timestamp`, which are genuine temporal Glue types with no `projection.<col>.format` ambiguity —
# partition projection's format-string parameter only applies to a STRING-typed projected column).
_STRING_LIKE_PARTITION_TYPES = {"string", "varchar", "char"}


def is_string_like_partition_type(type_str) -> bool:
    """CI-review MAJOR fix (round 7): `sg_rule_athena_broker._validate`'s projection date-format
    gate used to run only when `str(key_type).strip().lower() == "string"` EXACTLY — missing
    `varchar`/`varchar(10)`/`char`/`char(20)`, which `_normalize_glue_type`/`is_date_like_partition_
    type` already treat as date-like text columns elsewhere in this module. Since the `projection`
    strategy has no `_partition_exists` existence check to catch a format mismatch, a `varchar`-typed
    projected key with a non-ISO `projection.<col>.format` slipped the gate entirely and would
    silently match zero rows every day. Normalizes the same way `is_date_like_partition_type` does
    so `string`/`varchar(10)`/`char(20)` are all covered uniformly."""
    return _normalize_glue_type(type_str) in _STRING_LIKE_PARTITION_TYPES


def partition_keys_excluding_scope(validation: dict) -> list:
    """Item 1 follow-up fix (round 3): the partition-key names remaining AFTER excluding any key
    already resolved as an `account_id`/`region` SCOPE key (`validation['scopeResolution']` marking
    a canonical field `"partition"` — i.e. it's one of the ACTUAL Glue `PartitionKeys`, per
    `sg_rule_athena_broker._validate`'s item-1/round-2 fix — versus `"column"`, a plain table column
    that isn't a partition dimension at all and needs no exclusion here).

    A centralized/org-wide table's canonical `dt + account-id + region` partition-key layout has
    THREE partition keys, but only ONE of them (`dt`) is a date candidate — the other two are
    already accounted for by `_build_scope_predicate`/`_build_scope_expr`. Date-key detection
    (`single_date_partition_key` below) must look at the partition keys REMAINING after excluding
    the scope ones, not the raw full list — otherwise a 3-key layout never resolves to a lone date
    candidate, `has_resolved_partition_strategy()` returns `False`, and `_query_by_source` hard-
    refuses every scan of a layout that `sg_rule_athena_broker._validate` reported `status: "valid"`
    for (the exact validate-vs-scan mismatch the CI review flagged). Both `_validate` (at validation
    time) and this module (at scan time) call this SAME function so the two can never disagree."""
    validation = validation or {}
    partition_keys = validation.get("partitionKeys") or []
    scope_resolution = validation.get("scopeResolution") or {}
    column_map = validation.get("columnMap") or {}
    excluded_lower = set()
    for canonical in ("account_id", "region"):
        if scope_resolution.get(canonical) == "partition":
            actual = column_map.get(canonical)
            if actual:
                excluded_lower.add(str(actual).lower())
    return [k for k in partition_keys if str(k).lower() not in excluded_lower]


def _single_partition_key_and_type(validation: dict):
    """Shared resolution behind `single_date_partition_key`/`single_date_partition_key_type` —
    returns (key_name, lowercased_glue_type) for the single CONFIRMED date-like partition key, or
    (None, None) when there isn't exactly one REMAINING after excluding scope-resolved partition
    keys (`partition_keys_excluding_scope`, item 1 follow-up fix round 3), or its type isn't
    known/date-like. `partitionKeyTypes` is positional against the FULL `partitionKeys` list (Glue's
    own ordering), so the remaining key's type is looked up by its index in that full list, not by
    position in the excluded-down remainder."""
    validation = validation or {}
    all_keys = validation.get("partitionKeys") or []
    remaining = partition_keys_excluding_scope(validation)
    if len(remaining) != 1:
        return None, None
    types = validation.get("partitionKeyTypes")
    if not types or len(types) != len(all_keys):
        return None, None
    key = remaining[0]
    try:
        idx = next(i for i, k in enumerate(all_keys) if k == key)
    except StopIteration:
        return None, None
    t = _normalize_glue_type(types[idx])
    if t not in _DATE_LIKE_PARTITION_TYPES:
        return None, None
    return key, t


def single_date_partition_key(validation: dict):
    """item 7 follow-up fix: the single-key (non-Hive) branch of `_build_partition_predicate` /
    `_partition_exists` used to treat ANY lone partition key as a date column and interpolate an
    ISO date string into it — true only when Glue's own catalog (`partitionKeyTypes`, persisted by
    the broker's `_validate`) confirms the key's type is actually date-like. A key typed `bigint`
    (e.g. an epoch-day column also happening to be named `dt`) would either error against a string
    literal or silently produce a permanent `zero_partition_match`/query failure — never confidently
    assumed. Returns the key name when safe to use as a date predicate, else `None` — including when
    `partitionKeyTypes` was never recorded at all (an older source, or one whose `validate` action
    predates this field): callers must treat that the same as "can't verify," not "assume date.\""""
    key, _ = _single_partition_key_and_type(validation)
    return key


def single_date_partition_key_type(validation: dict):
    """Item 3 follow-up fix (round 2): the resolved (lowercased) Glue catalog type for the single
    confirmed date-like partition key (see `single_date_partition_key`), or `None` when there isn't
    one — used by callers to pick the correctly-typed SQL literal via `date_literal` below."""
    _, t = _single_partition_key_and_type(validation)
    return t


def date_literal(iso_date_str: str, key_type) -> str:
    """Item 3 follow-up fix (round 2): `_DATE_LIKE_PARTITION_TYPES` includes genuinely `date`-typed
    (and `timestamp`-typed) Glue partition columns, but Athena (Trino/Presto) REJECTS comparing a
    `date`/`timestamp` column to a bare string literal (`date_col IN ('2026-03-05', ...)`) with a
    type error — a table whose single partition key is truly `date`-typed therefore *validated*
    successfully (item 7's fix accepts it) yet failed EVERY scan. Emit a properly typed literal
    (`DATE '2026-03-05'` / `TIMESTAMP '2026-03-05 00:00:00'`) for those two catalog types; keep the
    plain quoted-string form for `string`/`varchar`/`char`-typed keys (the common
    manually-partitioned-as-text pattern), which IS correct for those — never change that branch."""
    t = str(key_type or "").lower()
    if t == "date":
        return f"DATE '{iso_date_str}'"
    if t == "timestamp":
        return f"TIMESTAMP '{iso_date_str} 00:00:00'"
    return f"'{iso_date_str}'"


def _build_partition_predicate(validation, day):
    """Shared by `build_day_select`/`build_day_skipdata_count_select` (item 5 follow-up fix): Hive
    partitions are keyed by delivery/file time, not flow-start time, so a flow whose own `start`
    timestamp falls on day D can be delivered into day D+1's partition file (delivery lag only ever
    pushes FORWARD, never backward). Querying strictly `partition = D` can therefore miss records
    that are logically day-D traffic but partitioned under D+1. The predicate below widens to
    `partition IN {D, D+1}` (one extra day, never unbounded) while the caller's own `start`/`end`
    row-level filter remains the authoritative test for which flows actually belong to day D — this
    predicate only decides which PARTITION FILES are scanned, never which rows are counted."""
    partition_keys = (validation or {}).get("partitionKeys") or []
    next_day = day + timedelta(days=1)
    lower_keys = {k.lower(): k for k in partition_keys}
    if {"year", "month", "day"} <= set(lower_keys):
        y, mo, d = lower_keys["year"], lower_keys["month"], lower_keys["day"]
        y_col, mo_col, d_col = _safe_ident(y, "year"), _safe_ident(mo, "month"), _safe_ident(d, "day")
        return (
            f' AND (("{y_col}" = \'{day.year:04d}\' AND "{mo_col}" = \'{day.month:02d}\' '
            f'AND "{d_col}" = \'{day.day:02d}\') OR ("{y_col}" = \'{next_day.year:04d}\' '
            f'AND "{mo_col}" = \'{next_day.month:02d}\' AND "{d_col}" = \'{next_day.day:02d}\'))'
        )
    dk_raw = single_date_partition_key(validation)
    if dk_raw:
        # MINOR fix: match `scope_partition_expr_clauses`' fail-closed posture (round 4) instead of
        # silently falling back to `""` — a stored key name that passed the date-type strategy gate
        # but fails `_safe_ident` means the resolved source row itself is corrupted, and building an
        # empty/no-op predicate here is unsafe: for the `partition_keys` strategy it still fails
        # closed via `_partition_exists` returning `None`, but for `projection` (which has no
        # existence check at all) it would silently run the query partition-unbounded instead.
        dk = _safe_ident(dk_raw, None)
        if dk:
            key_type = single_date_partition_key_type(validation)
            if key_type == "timestamp":
                # CI-review MAJOR fix (round 4): a `timestamp`-typed partition value is not
                # guaranteed to sit at exact midnight (e.g. an hourly-partitioned table) — the
                # equality/IN form below only ever matched an exact `D 00:00:00`/`D+1 00:00:00`
                # instant, silently missing every non-midnight partition value even though the
                # column validated as date-like. Use a half-open range spanning the whole two-day
                # window instead: it matches any partition value within [D 00:00:00, D+2 00:00:00),
                # regardless of what time-of-day component the partition actually carries.
                after_next_day = next_day + timedelta(days=1)
                lo = date_literal(day.isoformat(), key_type)
                hi = date_literal(after_next_day.isoformat(), key_type)
                return f' AND "{dk}" >= {lo} AND "{dk}" < {hi}'
            lit_a = date_literal(day.isoformat(), key_type)
            lit_b = date_literal(next_day.isoformat(), key_type)
            return f' AND "{dk}" IN ({lit_a}, {lit_b})'
    return ""


def _build_scope_predicate(column_map, source):
    """item 4/item 1 (round 2) follow-up fix: against a centralized/org-wide flow-log table
    (partitioned/columned additionally by account/region beyond just date), every account's traffic
    gets scanned unless explicitly scoped — inflating cost, tripping byte ceilings, and consuming
    the row `LIMIT` with foreign rows. When the broker's own `_validate` resolved an `account_id`
    and/or `region` alias (persisted into `validation.columnMap` — resolved from the UNION of
    PartitionKeys and Columns, with the same hyphen-alias mechanism as the required Flow Log
    fields, per the item 1 round-2 fix), add an exact-match predicate for EACH one resolved,
    independently — a table exposing only one of the two still gets that half of scoping, which is
    strictly better than none (round 1 required both together, silently discarding the available
    half). When the table exposes NEITHER (a single-account source — the common case, per
    `sg_flow_sources`' one-row-per-account+region schema), no predicate is added, which is
    correct/unchanged; `sg_rule_athena_broker._validate`'s `scannedUnscoped` flag records that case
    explicitly for operators, rather than leaving it indistinguishable from "not applicable."""
    clauses = []
    if "account_id" in column_map:
        acct_col = _safe_ident(column_map["account_id"], "account_id")
        acct_val = _safe_scope_value(str(source["account_id"]), _ACCOUNT_ID_VALUE_RE)
        clauses.append(f'"{acct_col}" = \'{acct_val}\'')
    if "region" in column_map:
        region_col = _safe_ident(column_map["region"], "region")
        region_val = _safe_scope_value(str(source["region"]), _REGION_VALUE_RE)
        clauses.append(f'"{region_col}" = \'{region_val}\'')
    if not clauses:
        return ""
    return " AND " + " AND ".join(clauses)


def scope_partition_expr_clauses(validation, source):
    """Item 3 follow-up fix (round 3): `sg_rule_athena_broker._partition_exists`'s Glue
    `GetPartitions` existence check used to OR together only the DATE dimensions of its
    `Expression` — for a Hive-style `year/month/day` table that ALSO carries `account_id`/`region`
    as partition keys (the layout item 1's fix makes scannable), that means ANY tenant's partition
    satisfies "a partition exists," not necessarily the resolved source's OWN account/region. A
    genuinely wrong/mis-resolved scope mapping could then return a real zero-row Athena result
    (scoped to the wrong account) that gets waved through as confident zero-traffic, because the
    existence check never looked at scope at all.

    Returns a list of already-safe (`_safe_ident`/`_safe_scope_value`-checked) Glue-Expression
    clauses (double-quoted `"col" = 'value'` — CI-review MAJOR fix, round 4: Glue's `GetPartitions`
    `Expression` is parsed by JSQLParser, the SAME quoted-identifier grammar Athena SQL uses, and
    `_safe_ident` deliberately allows hyphens for AWS's own `interface-id`-style column names; a
    BARE hyphenated identifier here (e.g. `account-id`) parses as arithmetic subtraction, not a
    column reference, raising and permanently refusing every day for that table. Double-quoting
    matches what `_build_scope_predicate` already emits for Athena SQL) for each of
    `account_id`/`region` that resolved as an ACTUAL Glue PARTITION KEY
    (`scopeResolution[...] == "partition"`). A scope field that resolved only as a plain table
    COLUMN is not a partition dimension at all — Glue's partition-Expression syntax has nothing to
    filter on for it, so it's intentionally omitted here (the row-level SQL predicate
    `_build_scope_predicate` already builds still covers that case at query time)."""
    validation = validation or {}
    scope_resolution = validation.get("scopeResolution") or {}
    column_map = validation.get("columnMap") or {}
    clauses = []
    if scope_resolution.get("account_id") == "partition":
        # CI-review MINOR fix: fall back to `None` (raise `UnsafeIdentifier`), not `""` (silently
        # drop the clause) — a corrupted/unresolvable stored column name for a field that DID
        # resolve as a partition key means the scope predicate cannot be safely built at all, and
        # silently omitting it reopens the any-tenant existence-check hole this function exists to
        # close. Matches `_safe_scope_value`'s own fail-closed posture for the value half.
        col = _safe_ident(column_map.get("account_id"), None)
        val = _safe_scope_value(str(source["account_id"]), _ACCOUNT_ID_VALUE_RE)
        clauses.append(f'"{col}" = \'{val}\'')
    if scope_resolution.get("region") == "partition":
        col = _safe_ident(column_map.get("region"), None)
        val = _safe_scope_value(str(source["region"]), _REGION_VALUE_RE)
        clauses.append(f'"{col}" = \'{val}\'')
    return clauses


def build_day_select(source, day):
    """Validated SELECT for one account/region/day. Every identifier here is re-validated
    (`_safe_ident`) before interpolation; workgroup/database/table already passed strict allowlist
    regexes at PUT time (web/lib/sg-rules.ts) and the broker's own `_validate` re-resolves the exact
    column ALIASES actually present in the table (persisted as `validation.columnMap`, canonical ->
    actual name — e.g. `interface_id` -> `interface-id`) — this function uses THAT resolved mapping
    instead of assuming underscore names. `bytes` is conditional on `validation.optionalFields` and
    a partition predicate is added whenever validation resolved partition key names. The only
    literals interpolated below are ISO day boundaries the worker itself computed (never user
    input) and identifiers that passed `_safe_ident` — `database_name`/`table_name` have NO
    fallback, so a corrupted/unsafe stored value raises `UnsafeIdentifier` rather than being
    interpolated (L3 finding #7)."""
    validation = source.get("validation") or {}
    column_map = validation.get("columnMap") or {}
    optional_fields = set(validation.get("optionalFields") or [])

    interface_col = _safe_ident(column_map.get("interface_id"), "interface_id")
    log_status_col = _safe_ident(column_map.get("log_status"), "log_status")
    start_col = _safe_ident(column_map.get("start"), "start")

    start, end = day_bounds_utc(day)
    table = f'"{_safe_ident(source["database_name"])}"."{_safe_ident(source["table_name"])}"'

    has_optional_info = bool(column_map) or bool(optional_fields)
    has_bytes = ("bytes" in optional_fields) if has_optional_info else True
    bytes_select = ', sum("bytes") as bytes' if has_bytes else ''

    partition_predicate = _build_partition_predicate(validation, day)
    scope_predicate = _build_scope_predicate(column_map, source)

    return (
        # `srcport` is deliberately NOT selected/grouped (L4 finding #9(i)) — process_day() never
        # reads it, and ephemeral source ports would otherwise inflate group cardinality toward
        # per-flow granularity, making the `LIMIT`/coverage-truncation check meaningless.
        f'SELECT "{interface_col}" as interface_id, srcaddr, dstaddr, dstport, protocol, '
        f'action{bytes_select}, count(*) as cnt, max("{start_col}") as last_start FROM {table} '
        f'WHERE "{start_col}" >= {int(start.timestamp())} AND "{start_col}" < {int(end.timestamp())} '
        f"AND action = 'ACCEPT' AND \"{log_status_col}\" = 'OK'{partition_predicate}{scope_predicate} "
        f'GROUP BY "{interface_col}", srcaddr, dstaddr, dstport, protocol, action '
        f"LIMIT {ROW_LIMIT}"
    )


def build_day_skipdata_count_select(source, day):
    """A cheap, single-row companion aggregate: how many rows for this account/region/day carry
    `log_status='SKIPDATA'` (Flow Log delivery loss) — the main day-SELECT's own
    `log_status='OK'`-only filter would otherwise discard this signal entirely (L4 finding #9(iv)).
    Same identifier re-validation and partition-bound discipline as `build_day_select`."""
    validation = source.get("validation") or {}
    column_map = validation.get("columnMap") or {}
    log_status_col = _safe_ident(column_map.get("log_status"), "log_status")
    start_col = _safe_ident(column_map.get("start"), "start")
    start, end = day_bounds_utc(day)
    table = f'"{_safe_ident(source["database_name"])}"."{_safe_ident(source["table_name"])}"'

    partition_predicate = _build_partition_predicate(validation, day)
    scope_predicate = _build_scope_predicate(column_map, source)

    return (
        f'SELECT count(*) as skipdata_count FROM {table} '
        f'WHERE "{start_col}" >= {int(start.timestamp())} AND "{start_col}" < {int(end.timestamp())} '
        f"AND \"{log_status_col}\" = 'SKIPDATA'{partition_predicate}{scope_predicate}"
    )


def has_resolved_partition_strategy(validation: dict) -> bool:
    """True only when validation actually resolved a bound-able partition scheme (Hive-style
    year/month/day, or exactly one CONFIRMED date-typed partition key — item 7 follow-up fix: a
    single key whose Glue-catalog type isn't known to be date-like no longer counts, since
    `_build_partition_predicate` will refuse to build a predicate for it) — used to refuse an
    unbounded full-table scan (L3 finding #8b) rather than silently falling back to one."""
    partition_keys = (validation or {}).get("partitionKeys") or []
    lower_keys = {str(k).lower() for k in partition_keys}
    if {"year", "month", "day"} <= lower_keys:
        return True
    return single_date_partition_key(validation) is not None


# ── Daily pipeline pure helpers (delivery lag, watermark, rescan window) ─────────────────────────

def is_day_eligible(day, now_utc: datetime, delivery_lag_hours: int) -> bool:
    """A day becomes eligible only once it clears the delivery-lag grace period AFTER its own end
    (the day whose data might still be arriving must not be scanned as if complete)."""
    _, day_end = day_bounds_utc(day)
    return now_utc >= day_end + timedelta(hours=delivery_lag_hours)


def next_day_to_process(last_committed_day, source_created_day):
    """`last_committed_day` (date|None) -> the day after it, or source_created_day if nothing has
    been committed yet (first run, initial-historical-backfill start point)."""
    if last_committed_day is None:
        return source_created_day
    return last_committed_day + timedelta(days=1)


def rescan_window_days(last_committed_day, window_days: int) -> list:
    """The trailing N already-committed days to re-scan (idempotent re-run, never touches the
    watermark). Returns dates in ascending order; empty if nothing has been committed yet."""
    if last_committed_day is None or window_days <= 0:
        return []
    return [last_committed_day - timedelta(days=i) for i in range(window_days - 1, -1, -1)]
