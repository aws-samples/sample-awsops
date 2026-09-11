"""Pure renderer for the Steampipe aws.spc connection config (multi-account / multi-region fan-out).

One `connection "aws_<account_id>"` per enabled account (name = account id, never the alias —
aliases aren't unique and can collide/sanitize to empty). `all_regions` → `regions = ["*"]`;
otherwise the explicit enabled regions; an account that is NOT all-regions and has NO enabled
regions is skipped (never the backwards ["*"]-on-empty). Non-host connections carry `assume_role_arn`
(+ `assume_role_external_id` only when set; 1st-party omits it). An `aws` aggregator spans every per-account
connection so existing `aws.*` queries transparently fan out. All rendered values are HCL-escaped.
Also renders a leading `plugin "aws" { limiter "awsops_global" { ... } }` block from a
`LimiterConfig` — defaults, or env-tunable values (`STEAMPIPE_AWS_MAX_CONCURRENCY` /
`STEAMPIPE_AWS_BUCKET_SIZE` / `STEAMPIPE_AWS_FILL_RATE`) each bounds-validated by
`limiter_config_from_env` so a bad/out-of-range knob raises instead of rendering.
"""
from dataclasses import dataclass
import math
import os
from typing import Mapping, Optional

PLUGIN = "aws@0.142.0"


@dataclass(frozen=True)
class LimiterConfig:
    max_concurrency: int = 4
    bucket_size: int = 4
    fill_rate: float = 2.0


def _bounded_number(name, raw, cast, low, high):
    try:
        value = cast(raw)
    except (TypeError, ValueError):
        raise ValueError(f"{name} must be numeric")
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError(f"{name} must be finite")
    if value < low or value > high:
        raise ValueError(f"{name} must be between {low} and {high}")
    return value


def limiter_config_from_env(env: Optional[Mapping[str, str]] = None) -> LimiterConfig:
    source = os.environ if env is None else env
    return LimiterConfig(
        max_concurrency=_bounded_number(
            "STEAMPIPE_AWS_MAX_CONCURRENCY",
            source.get("STEAMPIPE_AWS_MAX_CONCURRENCY", "4"), int, 1, 20),
        bucket_size=_bounded_number(
            "STEAMPIPE_AWS_BUCKET_SIZE",
            source.get("STEAMPIPE_AWS_BUCKET_SIZE", "4"), int, 1, 40),
        fill_rate=_bounded_number(
            "STEAMPIPE_AWS_FILL_RATE",
            source.get("STEAMPIPE_AWS_FILL_RATE", "2"), float, 0.1, 20.0),
    )


def _hcl(s) -> str:
    """Quote + escape a string for HCL. First neutralize HCL2's template-interpolation markers:
    a literal `$` or `%` must become `$$` / `%%` (HCL2's own doubling-escape convention) BEFORE
    quoting — otherwise operator-supplied text containing `${...}` or `%{...}` (e.g. a 3rd-party
    account's external_id) would be parsed by Steampipe as an interpolation/template directive,
    not a literal string, either crashing aws.spc parsing (fail-closed) or evaluating unintended
    expressions (M2 fix). Then json.dumps gives a valid double-quoted literal with full escaping
    (backslash, quote, AND control chars like newline/tab) — HCL string escaping is JSON-compatible."""
    import json
    escaped = str(s).replace("$", "$$").replace("%", "%%")
    return json.dumps(escaped)


def _regions_list(regions) -> str:
    return "[" + ", ".join(_hcl(r) for r in regions) + "]"


def render_spc(rows, limiter: Optional[LimiterConfig] = None) -> str:
    """rows: list of {account_id, is_host, role_name, external_id, all_regions, regions[]}."""
    limiter = limiter or LimiterConfig()
    blocks = []
    blocks.append(
        'plugin "aws" {\n'
        '  limiter "awsops_global" {\n'
        f"    max_concurrency = {limiter.max_concurrency}\n"
        f"    bucket_size = {limiter.bucket_size}\n"
        f"    fill_rate = {limiter.fill_rate}\n"
        "  }\n"
        "}"
    )
    for r in rows:
        # The HOST always scans all regions (v1 parity) regardless of the flag — it has no
        # account_regions rows, and skipping it would empty the whole inventory (C1).
        if r.get("all_regions") or r.get("is_host"):
            regions = ["*"]
        else:
            regions = [x for x in (r.get("regions") or []) if x]
            if not regions:
                continue  # target that is not all-regions and has nothing enabled → skip
        name = "aws_" + str(r["account_id"])
        lines = [
            f'connection "{name}" {{',
            f"  plugin = {_hcl(PLUGIN)}",
            f"  regions = {_regions_list(regions)}",
        ]
        if not r.get("is_host"):
            # Steampipe AWS plugin assume-role keys are `assume_role_arn` / `assume_role_external_id`
            # (NOT role_arn/external_id) — verified vs scripts/12-setup-multi-account.sh + the live aws.spc.
            lines.append(f'  assume_role_arn = {_hcl("arn:aws:iam::%s:role/%s" % (r["account_id"], r["role_name"]))}')
            if r.get("external_id"):
                lines.append(f"  assume_role_external_id = {_hcl(r['external_id'])}")
        lines.append("}")
        blocks.append("\n".join(lines))

    blocks.append(
        'connection "aws" {\n'
        f"  plugin = {_hcl(PLUGIN)}\n"
        '  type = "aggregator"\n'
        '  connections = ["aws_*"]\n'
        "}"
    )
    return "\n\n".join(blocks) + "\n"
