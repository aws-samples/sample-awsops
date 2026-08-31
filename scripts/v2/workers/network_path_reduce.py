"""Network Path Check — the deterministic per-candidate and overall status reduction rules.

Pure, side-effect-free functions only (no AWS/Aurora access) — this is the module the design spec
(docs/superpowers/specs/2026-08-13-network-path-check-design.md, "Result semantics" section) calls
the deterministic core the whole feature's correctness depends on. Every rule below cites the exact
spec paragraph it implements so a future edit can be checked against the prose, not just the tests.

Layer status values: 'allowed' | 'blocked' | 'unknown' | 'conditional' | 'not_run'
Candidate status values: 'allowed' | 'blocked' | 'conditional' | 'failed'
Overall status values: 'allowed' | 'blocked' | 'conditional' | 'failed'
Candidate kind: 'resolved' | 'hypothesis'
"""

LAYER_STATUSES = ("allowed", "blocked", "unknown", "conditional", "not_run")
CANDIDATE_STATUSES = ("allowed", "blocked", "conditional", "failed")
OVERALL_STATUSES = ("allowed", "blocked", "conditional", "failed")
CANDIDATE_KINDS = ("resolved", "hypothesis")


def reduce_candidate_status(layer_statuses):
    """Per-candidate status from the list of REQUIRED layer statuses for one candidate.

    A layer that does not apply to this candidate must already be OMITTED from `layer_statuses`
    (never appended as 'unknown') — see the design spec's "A layer that doesn't apply ... is omitted
    from that candidate's step list rather than marked unknown."

    Rules applied IN ORDER (spec, "Per-candidate status", precedence is explicit and load-bearing —
    rule 1 must be checked before rule 3, or "all not_run" would be swallowed by "at least one
    not_run" and the `failed` case would be unreachable, which is exactly the 2026-08-19 review fix):

    1. every required layer `not_run` (zero evidence gathered for this candidate) -> `failed`
    2. any `blocked` layer -> `blocked`
    3. no `blocked`, and at least one required layer is `unknown`, `not_run`, or `conditional` ->
       `conditional`
    4. every required layer `allowed` -> `allowed`

    An empty `layer_statuses` (no required layer even started) is treated the same as
    "every required layer not_run": zero evidence was gathered, so the candidate is `failed`.
    """
    statuses = list(layer_statuses)
    if all(s == "not_run" for s in statuses):  # rule 1 — vacuously true for [] too (zero evidence)
        return "failed"
    if any(s == "blocked" for s in statuses):  # rule 2
        return "blocked"
    if any(s in ("unknown", "not_run", "conditional") for s in statuses):  # rule 3
        return "conditional"
    if statuses and all(s == "allowed" for s in statuses):  # rule 4
        return "allowed"
    return "conditional"  # defensive catch-all; unreachable given LAYER_STATUSES' closed value set


def _reduce_resolved(statuses):
    """All-`resolved` candidate-status reduction (spec, "All candidates resolved", rules 1-4,
    each applying only if the prior ones didn't match — exhaustive over every combination)."""
    if not statuses:
        return None
    if all(s == "allowed" for s in statuses):  # rule 1
        return "allowed"
    if all(s == "blocked" for s in statuses):  # rule 2
        return "blocked"
    if not any(s == "allowed" for s in statuses) and not any(s == "conditional" for s in statuses):
        # rule 3: every candidate blocked and/or failed, and not all-blocked (rule 2 already caught
        # that) -> a zero-evidence `failed` candidate is mixed in, so `failed` is the honest overall.
        return "failed"
    return "conditional"  # rule 4 catch-all


def _reduce_hypothesis(statuses):
    """All-`hypothesis` candidate-status reduction (spec, "All candidates hypothesis"): unanimous
    agreement short-circuits; any disagreement (including an all-blocked+failed, non-unanimous mix)
    is `conditional` — not knowing which candidate is the real path is itself the dominant
    uncertainty, so it takes precedence over anything short of full agreement."""
    if not statuses:
        return None
    if all(s == "allowed" for s in statuses):
        return "allowed"
    if all(s == "blocked" for s in statuses):
        return "blocked"
    if all(s == "failed" for s in statuses):
        return "failed"
    return "conditional"


def reduce_overall_status(candidates):
    """Overall status across candidates (spec, "Overall status" + "Mixed set").

    `candidates`: iterable of {"kind": "resolved"|"hypothesis", "status": <candidate status>}.
    Global execution-level failure before any candidate was discovered (no candidates at all) is
    NOT handled here — the caller bypasses this function entirely in that case (spec: "-> overall
    `failed` directly, bypassing per-candidate reduction entirely, there are no candidates to
    reduce over"). Calling this with an empty `candidates` list is a caller bug; it raises.
    """
    candidates = list(candidates)
    if not candidates:
        raise ValueError(
            "reduce_overall_status requires at least one candidate; a run with zero discovered "
            "candidates is the global-execution-failure case and must bypass this function"
        )
    resolved = [c["status"] for c in candidates if c["kind"] == "resolved"]
    hypothesis = [c["status"] for c in candidates if c["kind"] == "hypothesis"]

    r = _reduce_resolved(resolved)
    h = _reduce_hypothesis(hypothesis)

    if r is not None and h is None:
        return r
    if h is not None and r is None:
        return h

    # Mixed set — both resolved and hypothesis candidates present (spec, "Mixed set"): combine the
    # two partial statuses with the same unanimity logic used within each kind. Neither kind's
    # `allowed` verdict offsets the other kind's non-`allowed` verdict.
    if r == "allowed" and h == "allowed":
        return "allowed"
    if r == "blocked" and h == "blocked":
        return "blocked"
    if "failed" in (r, h) and "allowed" not in (r, h) and "conditional" not in (r, h):
        return "failed"
    return "conditional"  # every other combination, including one partial allowed + anything else
