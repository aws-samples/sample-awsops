"""Network Path Check — pure, read-only-data adapter evaluators.

Every function here takes already-fetched, structured AWS/K8s state (dicts/lists the orchestrator
reads from the AWS SDK or the Kubernetes API) and returns a step-result dict shaped per the design
spec's "Result semantics" contract:

    {"layer": str, "status": "allowed"|"blocked"|"unknown"|"conditional"|"not_run",
     "resource": str|None, "summary": str, "evidence": [...]}

No network/API calls happen in this module — the orchestrator (network_path.py) is the only place
that talks to boto3/K8s, so every function here is exercised by fast, deterministic, table-driven
unit tests (test_network_path_adapters.py).

Per the design spec's "Existing assets and gaps" section: `agent/lambda/reachability_read_mcp.py`'s
`check_reachability`/`_route_exists` is NOT reused here, at all — its boolean-only return has no
provenance to distinguish a genuine missing-route deny from a disclaimed-but-relevant condition it
never evaluated (TGW, prefix lists, return route, DNS), and wrapping it unchanged would produce a
false `blocked` for exactly the cases this feature's own "unsupported -> `?`, never `O`" rule exists
to prevent. This module is the "write the route evaluation from scratch" option the spec offers as
an alternative to extending that shared function. It also never calls
`agent/lambda/datasource_diag_mcp.py`'s `_test_http_connectivity` — this feature does no active
probing (see the design spec's Explicit exclusions); grep-verified by test_network_path.py.
"""
import ipaddress
import re

_PROTO_NUM = {"tcp": "6", "udp": "17", "icmp": "1", "icmpv6": "58", "-1": "-1", "all": "-1"}
EPHEMERAL_PROBE_PORT = 49152  # one representative ephemeral port — see eval_nacl's docstring


def _proto_num(p):
    return _PROTO_NUM.get(str(p).lower(), str(p))


def _proto_matches(rule_proto, want_proto):
    rp = _proto_num(rule_proto)
    return rp == "-1" or rp == _proto_num(want_proto)


def _port_in_range(rule, port):
    if port is None:
        return True
    lo = rule.get("from_port")
    hi = rule.get("to_port")
    if lo is None and hi is None:
        return True  # protocol has no ports (e.g. -1/all, icmp without type/code filter)
    lo = -1 if lo is None else lo
    hi = 65535 if hi is None else hi
    return lo <= port <= hi


def _cidr_contains(cidr, ip):
    if not cidr or not ip:
        return False
    try:
        return ipaddress.ip_address(ip) in ipaddress.ip_network(cidr, strict=False)
    except ValueError:
        return False


def _is_valid_ip(ip):
    """MINOR fix: the partial-peer guards below key only on `peer_ip is None` — a PRESENT-BUT-
    MALFORMED `peer_ip` string (not a valid IPv4/IPv6 literal) used to fall through to
    `_cidr_contains`, which swallows the `ValueError` and returns a plain `False`, i.e. an ordinary
    non-match. That let a failed identity PARSE (as opposed to a genuinely missing one) still
    produce a confident `blocked`/non-match verdict instead of `unknown`. Callers must treat a
    malformed `peer_ip` exactly like `peer_ip is None` for gating purposes."""
    if ip is None:
        return False
    try:
        ipaddress.ip_address(ip)
        return True
    except ValueError:
        return False


# ── AWS L3/L4: Security Groups (ingress/egress, multi-SG union) ─────────────────────────────────

def eval_security_group(rules, protocol, port, peer_ip=None, peer_sg_ids=None, layer="sg"):
    """SG evaluation, written from scratch (not a wrapper around any shared boolean helper).

    `rules`: list of {"protocol": str, "from_port": int|None, "to_port": int|None,
                       "cidr": str|None, "referenced_group_id": str|None, "sg_id": str}
             — the UNION of every rule across every SG attached to the source ENI (multi-SG union
             rule, per spec Testing section). SGs are allow-list only (no explicit deny), so the
             candidate is `allowed` iff at least one rule (from ANY attached SG) matches.
    `peer_sg_ids`: SG ids attached to the peer ENI — matches a rule's `referenced_group_id`.
    """
    # MINOR fix: `peer_sg_ids=None` (resolution failed/unknown) and `peer_sg_ids=[]` (resolution
    # SUCCEEDED — the peer legitimately has zero SGs) are different signals; collapsing both into
    # the same falsy empty set below (as the pre-fix code did at every check site) treated a
    # confident "peer has no SGs, so no sg-reference rule can match" the same as "we don't know the
    # peer's SGs" — the latter must stay `unknown`/unevaluable, the former is a legitimate
    # confident non-match. `peer_sg_ids_unresolved` captures the ORIGINAL None-ness before it's
    # normalized to a set for membership checks.
    peer_sg_ids_unresolved = peer_sg_ids is None
    peer_sg_ids = set(peer_sg_ids or [])
    # MINOR fix: a present-but-malformed `peer_ip` (not a valid IP literal) must be treated the
    # same as a missing one — a failed parse is not evidence of anything, and letting it reach
    # `_cidr_contains` below (which silently swallows the ValueError as a plain non-match) could
    # yield a confident `blocked` from bad data rather than `unknown`.
    peer_ip_usable = peer_ip is not None and _is_valid_ip(peer_ip)
    if not peer_ip_usable:
        peer_ip = None
    if peer_ip is None and peer_sg_ids_unresolved:
        # MAJOR fix: missing/unparseable peer identity must map to `unknown`, never a confident
        # `blocked` — the module's own docstring gives exactly this reasoning for not reusing
        # `check_reachability`'s boolean-only return (never invent a false verdict). Without ANY
        # peer identity, cidr rules can't be evaluated (peer_ip needed) and sg-reference rules
        # can't be evaluated (peer_sg_ids needed) — there is structurally no basis for a verdict.
        return {
            "layer": layer, "status": "unknown", "resource": None,
            "summary": "peer identity (peer_ip/peer_sg_ids) is missing; cannot evaluate SG rules",
            "evidence": [],
        }
    matched = None
    # Follow-up fix (item 9): a PARTIAL peer identity (e.g. peer_sg_ids known but peer_ip missing,
    # or vice versa) leaves an entire class of rule unevaluable rather than the whole call. Track
    # whether any proto/port-eligible rule couldn't be checked because its OWN peer kind's data is
    # missing — if nothing confidently matches AND such a rule existed, the verdict must be
    # `unknown`, not a confident `blocked` (only the fully-missing-everything case above was
    # guarded before this fix).
    had_unevaluable_rule = False
    for rule in rules:
        if not _proto_matches(rule.get("protocol", "-1"), protocol):
            continue
        if not _port_in_range(rule, port):
            continue
        cidr = rule.get("cidr")
        if cidr:
            if peer_ip is None:
                had_unevaluable_rule = True
            elif _cidr_contains(cidr, peer_ip):
                matched = rule
                break
        ref_group = rule.get("referenced_group_id")
        if ref_group:
            if peer_sg_ids_unresolved:
                had_unevaluable_rule = True
            elif ref_group in peer_sg_ids:
                matched = rule
                break
    if matched:
        return {
            "layer": layer, "status": "allowed",
            "resource": matched.get("sg_id"),
            "summary": f"matched SG rule {matched.get('sg_id')} allowing {protocol}/{port}",
            "evidence": [matched],
        }
    if had_unevaluable_rule:
        return {
            "layer": layer, "status": "unknown", "resource": None,
            "summary": (
                f"one or more SG rules for {protocol}/{port} could not be evaluated due to partial "
                "missing peer data (a CIDR rule with no peer_ip, or an SG-reference rule with no "
                "peer_sg_ids) and no rule confidently matched"
            ),
            "evidence": [],
        }
    return {
        "layer": layer, "status": "blocked",
        "resource": None,
        "summary": f"no SG rule allows {protocol}/{port} to/from {peer_ip or list(peer_sg_ids)}",
        "evidence": [],
    }


# ── AWS L3/L4: NACL (first-match, forward + ephemeral return) ───────────────────────────────────

def _first_match(entries, protocol, port, peer_ip=None):
    """First-match-wins by ascending rule_number, mirroring EC2 NACL evaluation order.

    MAJOR fix: entries carrying a `cidr` field are now scoped to `peer_ip` — a NACL entry allowing
    (or denying) only an unrelated CIDR must not be treated as matching every peer. An entry with NO
    `cidr` field at all is treated as unrestricted (preserves prior behavior for callers/tests that
    don't model CIDR scope), matching how EC2 NACL entries with `0.0.0.0/0` behave.

    Follow-up fix (item 1): when the FIRST proto/port-eligible entry encountered carries a `cidr`
    field but `peer_ip` is unavailable, this function cannot tell whether that entry would actually
    match — under first-match-wins semantics it is structurally wrong to either (a) skip past it and
    let a LATER, unrelated entry win, or (b) let it win regardless of its CIDR scope (the bug this
    was reported against: the old code did exactly (b), since `peer_ip` was falsy and short-circuited
    the CIDR check away entirely). Returns `(entry, ambiguous)` — `ambiguous=True` means resolution
    genuinely cannot proceed past this position without `peer_ip`; the caller must surface `unknown`,
    never invent a confident verdict from either side of that entry.
    """
    # MINOR fix: a present-but-malformed `peer_ip` must be treated the same as a missing one — see
    # `_is_valid_ip`'s docstring for why (a failed parse falls through to `_cidr_contains`'s
    # swallowed-ValueError non-match otherwise, which is indistinguishable from a genuine miss).
    if peer_ip is not None and not _is_valid_ip(peer_ip):
        peer_ip = None
    for entry in sorted(entries, key=lambda e: e["rule_number"]):
        if entry["rule_number"] >= 32767:  # implicit default-deny catch-all
            return entry, False
        if not _proto_matches(entry.get("protocol", "-1"), protocol):
            continue
        if not _port_in_range(entry, port):
            continue
        cidr = entry.get("cidr")
        if cidr:
            if peer_ip is None:
                # Cannot determine whether this entry (the first eligible one, evaluated in
                # ascending rule_number order) matches — first-match-wins means we cannot safely
                # skip it either, since a real peer_ip might have matched it here.
                return None, True
            if not _cidr_contains(cidr, peer_ip):
                continue
        return entry, False
    return None, False


def eval_nacl(forward_entries, return_entries, protocol, port, peer_ip=None, layer="nacl"):
    """Forward NACL rules are evaluated at the ACTUAL requested port (a definite verdict is
    possible). The return path is evaluated at a single REPRESENTATIVE ephemeral port
    (EPHEMERAL_PROBE_PORT) — per the design spec's 2026-08-19 review fix, a verdict built on that
    probe is scoped to the probed port only UNLESS the matched return rule's own port range already
    covers the full 0-65535 span (an unrestricted/wildcard rule) — in that case ANY ephemeral port
    is genuinely, unambiguously allowed, and the caveat about generalizing a narrow probe simply
    does not apply, so this can correctly return `allowed` (MAJOR fix: candidate-level `allowed`
    was structurally unreachable before this, since this layer could never emit anything but
    `blocked`/`conditional`). A return rule scoped to a narrower range (e.g. only the probed port,
    or a sub-range of the ephemeral space) still yields `conditional` — the scoped-verdict caveat
    is preserved for exactly that narrower case.

    `layer` (default "nacl") lets a caller reuse this SAME function for a second, DESTINATION-side
    evaluation pass (L4 finding #13's cheap mitigation — see network_path.py's `_layer_plan_for`
    "sg-dst"/"nacl-dst" wiring) without the two passes' steps colliding under one layer name.
    """
    fwd, fwd_ambiguous = _first_match(forward_entries, protocol, port, peer_ip)
    if fwd_ambiguous:
        # Follow-up fix (item 1): the first proto/port-eligible forward entry is CIDR-scoped but
        # peer_ip is missing — first-match-wins cannot be resolved past it, so this must not
        # silently let a later entry (or an implicit assumption) decide a confident verdict.
        return {
            "layer": layer, "status": "unknown", "resource": None,
            "summary": (
                "a NACL forward entry scoped to a CIDR could not be evaluated because peer_ip is "
                "missing; cannot confidently determine allow/deny for this entry"
            ),
            "evidence": [],
        }
    if fwd is None or fwd.get("action") != "allow":
        return {
            "layer": layer, "status": "blocked",
            "resource": fwd.get("resource") if fwd else None,
            "summary": f"NACL forward rule denies {protocol}/{port}",
            "evidence": [fwd] if fwd else [],
        }
    ret, ret_ambiguous = _first_match(return_entries, protocol, EPHEMERAL_PROBE_PORT, peer_ip)
    if ret_ambiguous:
        return {
            "layer": layer, "status": "unknown", "resource": None,
            "summary": (
                "a NACL return entry scoped to a CIDR could not be evaluated because peer_ip is "
                "missing; cannot confidently determine the return path"
            ),
            "evidence": [fwd],
        }
    if ret is None:
        return {
            "layer": layer, "status": "blocked",
            "resource": None,
            "summary": f"NACL return rule denies the ephemeral probe port {EPHEMERAL_PROBE_PORT}",
            "evidence": [],
        }
    if ret.get("action") != "allow":
        # MAJOR fix (L4 finding #10, asymmetric with the allow-side fix above): a DENY that matched
        # only because it happened to cover the single probed ephemeral port must not generalize to
        # a confident `blocked` — a different ephemeral port might still be allowed. Only a deny
        # whose OWN port range already spans the full 0-65535 ephemeral space (genuinely
        # unrestricted — e.g. the implicit default-deny catch-all, or an explicit wildcard deny)
        # can confidently produce `blocked`; a deny scoped to a narrower range yields `conditional`,
        # matching the allow side's "generalize only when genuinely unrestricted" rule.
        unrestricted_deny = _port_in_range(ret, 0) and _port_in_range(ret, 65535)
        if unrestricted_deny:
            return {
                "layer": layer, "status": "blocked",
                "resource": ret.get("resource"),
                "summary": (
                    f"NACL return rule denies the ephemeral probe port {EPHEMERAL_PROBE_PORT}; "
                    "deny covers the full 0-65535 range (genuinely unrestricted) — generalized deny"
                ),
                "evidence": [ret],
            }
        return {
            "layer": layer, "status": "conditional",
            "resource": ret.get("resource"),
            "summary": (
                f"NACL return rule denies only the probed ephemeral port {EPHEMERAL_PROBE_PORT} "
                "(not the full ephemeral range) — a different ephemeral port may still be allowed; "
                "scoped verdict, not a generalized block"
            ),
            "evidence": [fwd, ret],
        }
    unrestricted_return = _port_in_range(ret, 0) and _port_in_range(ret, 65535)
    if unrestricted_return:
        return {
            "layer": layer, "status": "allowed",
            "resource": fwd.get("resource"),
            "summary": (
                f"NACL forward {protocol}/{port} allowed; return rule covers the full 0-65535 "
                "range (genuinely unrestricted, not just the probed port) — generalized allow"
            ),
            "evidence": [fwd, ret],
        }
    return {
        "layer": layer, "status": "conditional",
        "resource": fwd.get("resource"),
        "summary": (
            f"NACL forward {protocol}/{port} allowed; return probed only at ephemeral port "
            f"{EPHEMERAL_PROBE_PORT} (not the full ephemeral range) — scoped verdict, not a "
            "generalized allow"
        ),
        "evidence": [fwd, ret],
    }


# ── AWS L3/L4: subnet routes (longest-prefix match + blackhole), one- or two-ended ─────────────

def eval_route(route_table, dest_cidr, layer="route"):
    """Longest-prefix-match route evaluation. `route_table`: list of
    {"destination_cidr": str, "target": str, "state": "active"|"blackhole"}.

    This function requires only ONE side's route table and a destination CIDR/IP — it is the
    "one-ended, source-side-only" path the design spec requires for internet/on-premises
    destinations (no destination ENI needed), and is exactly the same function used for an
    ENI-to-ENI candidate's source-side route check. No wrapping of any ENI-to-ENI-only helper.
    """
    if dest_cidr is None:
        # MAJOR fix: missing destination must map to `unknown`, never a confident `blocked` — same
        # "never invent a false verdict" reasoning as eval_security_group's missing-peer fix.
        return {
            "layer": layer, "status": "unknown", "resource": None,
            "summary": "destination CIDR/IP is missing; cannot evaluate route coverage", "evidence": [],
        }
    # Normalize the destination once: a bare IP checks membership directly; a CIDR checks that it
    # is fully contained in the candidate route's network (a route can only claim a destination
    # network it fully covers).
    is_dest_network = "/" in str(dest_cidr)
    try:
        dest_net = ipaddress.ip_network(dest_cidr, strict=False) if is_dest_network else None
        dest_ip = None if is_dest_network else ipaddress.ip_address(dest_cidr)
    except ValueError:
        dest_net = dest_ip = None
    if dest_net is None and dest_ip is None:
        # MAJOR fix: malformed/unparseable destination -> `unknown`, distinct from "a genuinely
        # valid destination with no covering route" (that IS a real `blocked`, handled below).
        return {
            "layer": layer, "status": "unknown", "resource": None,
            "summary": f"destination {dest_cidr!r} is not a parseable IP/CIDR; cannot evaluate route coverage",
            "evidence": [],
        }

    best = None
    best_prefixlen = -1
    for r in route_table:
        try:
            net = ipaddress.ip_network(r["destination_cidr"], strict=False)
        except (ValueError, TypeError, KeyError):
            continue
        if dest_net is not None:
            contains = dest_net.network_address in net and dest_net.broadcast_address in net
        elif dest_ip is not None:
            contains = dest_ip in net
        else:
            contains = False
        if contains and net.prefixlen > best_prefixlen:
            best = r
            best_prefixlen = net.prefixlen
    if best is None:
        return {
            "layer": layer, "status": "blocked", "resource": None,
            "summary": f"no route table entry covers {dest_cidr}", "evidence": [],
        }
    if best.get("state") == "blackhole":
        return {
            "layer": layer, "status": "blocked", "resource": best.get("target"),
            "summary": f"longest-prefix route to {dest_cidr} is a blackhole ({best.get('target')})",
            "evidence": [best],
        }
    return {
        "layer": layer, "status": "allowed", "resource": best.get("target"),
        "summary": f"route to {dest_cidr} via {best.get('target')}",
        "evidence": [best],
    }


# ── AWS L3/L4: Transit Gateway (attachment / association / propagation / static / blackhole) ──

def eval_tgw(attachment_state, associated, propagation_enabled, route_entry):
    """`route_entry`: the TGW route-table entry matching the destination, or None.
    Encodes association/propagation/static-route/blackhole per spec Testing section, including an
    inability to confirm the RETURN path -> `conditional` (asymmetric-return risk), never `allowed`.
    """
    if attachment_state != "available":
        return {
            "layer": "tgw", "status": "blocked", "resource": None,
            "summary": f"TGW attachment state is {attachment_state!r}, not available", "evidence": [],
        }
    if not associated:
        return {
            "layer": "tgw", "status": "blocked", "resource": None,
            "summary": "TGW attachment is not associated with a route table", "evidence": [],
        }
    if route_entry is None:
        if propagation_enabled:
            return {
                "layer": "tgw", "status": "unknown", "resource": None,
                "summary": "propagation enabled but no matching route entry found — cache may be stale",
                "evidence": [],
            }
        return {
            "layer": "tgw", "status": "blocked", "resource": None,
            "summary": "no static or propagated route to destination in the TGW route table",
            "evidence": [],
        }
    if route_entry.get("state") == "blackhole":
        return {
            "layer": "tgw", "status": "blocked", "resource": route_entry.get("attachment_id"),
            "summary": "TGW route to destination is a blackhole", "evidence": [route_entry],
        }
    return {
        "layer": "tgw", "status": "conditional", "resource": route_entry.get("attachment_id"),
        "summary": (
            "TGW forward route confirmed; return-path route table was not independently verified "
            "(asymmetric TGW routing is possible) — scoped verdict, not a full round-trip allow"
        ),
        "evidence": [route_entry],
    }


# ── AWS L3/L4: Peering / VPN / Direct Connect boundary classification ──────────────────────────

def eval_peering(state):
    if state == "active":
        return {"layer": "peering", "status": "allowed", "resource": None,
                "summary": "VPC peering connection is active", "evidence": [{"state": state}]}
    return {"layer": "peering", "status": "blocked", "resource": None,
            "summary": f"VPC peering connection state is {state!r}", "evidence": [{"state": state}]}


def eval_vpn_or_dx(kind, aws_side_state, route_present):
    """AWS-side segment only, per spec: 'For on-premises destinations, AWSops evaluates the
    AWS-visible segment only.' The customer router/firewall side is never assertable and is not
    modeled here — the orchestrator's DNS/L7 layer records the on-prem boundary as `unknown`
    separately (see network_path.py). This function reports only the AWS-side attachment/route.

    CI-review MAJOR fix (round 19): `aws_side_state=None` (this layer's data was never fetched —
    `fetch_live_topology` never populates it) used to fall into the same `!= "up"` branch as a
    CONFIRMED-down state, reporting a confident `blocked` for a layer this evaluator has no data
    on at all. `None` now degrades to `unknown`, mirroring this module's `_nacl_or_unknown` and
    every other "missing data, not a confirmed negative" layer — only an actually-observed
    non-`up` state (e.g. `"down"`) still confidently blocks. (Round 26 docstring fix: `route_present`
    got the SAME `None`-vs-`False` treatment in round 25, below — this paragraph originally only
    covered `aws_side_state`.)"""
    if aws_side_state is None:
        return {"layer": kind, "status": "unknown", "resource": None,
                "summary": f"{kind} AWS-side attachment state was not fetched — cannot evaluate "
                           "(missing data, not a confirmed down state)", "evidence": []}
    if aws_side_state != "up":
        return {"layer": kind, "status": "blocked", "resource": None,
                "summary": f"{kind} AWS-side state is {aws_side_state!r}", "evidence": []}
    # CI-review MAJOR fix (round 25): the round-19 fix distinguished `aws_side_state=None`
    # (not fetched) from a confirmed non-`up` value, but left `route_present` exactly where it
    # was — `not route_present` treats a genuinely UNFETCHED route marker (`None`) the same as a
    # CONFIRMED-absent one (`False`), reporting a confident `blocked` for data this evaluator
    # never actually has. The same distinction is applied here now.
    if route_present is None:
        return {"layer": kind, "status": "unknown", "resource": None,
                "summary": f"{kind} AWS-side route presence was not fetched — cannot evaluate "
                           "(missing data, not a confirmed absent route)", "evidence": []}
    if not route_present:
        return {"layer": kind, "status": "blocked", "resource": None,
                "summary": f"{kind} is up but no AWS-side route to destination", "evidence": []}
    return {"layer": kind, "status": "allowed", "resource": None,
            "summary": f"{kind} AWS-side segment up with a route to destination", "evidence": []}


# ── AWS L3/L4: Network Firewall ──────────────────────────────────────────────────────────────

_NFW_ALLOW = {"pass"}
_NFW_DENY = {"drop", "reject"}


def eval_network_firewall(rule_action, uninspectable=False):
    if uninspectable:
        return {"layer": "network-firewall", "status": "unknown", "resource": None,
                "summary": "matching rule form is not statically inspectable (e.g. opaque domain-list SIDs)",
                "evidence": []}
    if rule_action in _NFW_ALLOW:
        return {"layer": "network-firewall", "status": "allowed", "resource": None,
                "summary": f"Network Firewall rule action: {rule_action}", "evidence": []}
    if rule_action in _NFW_DENY:
        return {"layer": "network-firewall", "status": "blocked", "resource": None,
                "summary": f"Network Firewall rule action: {rule_action}", "evidence": []}
    return {"layer": "network-firewall", "status": "unknown", "resource": None,
            "summary": f"unrecognized Network Firewall rule action: {rule_action!r}", "evidence": []}


# ── DNS/L7: ALB listener (first-match + fixed response + target group) ─────────────────────────

def _glob_match(req_val, patterns):
    """`*` glob semantics — used by BOTH `path-pattern` and `host-header` conditions, matching
    ALB's actual behavior for either field (L2 finding #5c: host-header wildcards like
    `*.example.com` never matched anything before, since only path-pattern implemented `*`)."""
    for v in patterns:
        if req_val == v:
            return True
        if "*" not in v and "?" not in v:
            continue
        # ALB's own glob semantics: `*` matches 0+ chars, `?` matches exactly 1 char. Translate to
        # a regex anchored on the whole value (fnmatch-equivalent, but explicit and dependency-free).
        pattern = "^" + "".join(
            ".*" if ch == "*" else "." if ch == "?" else re.escape(ch) for ch in v
        ) + "$"
        if re.match(pattern, req_val):
            return True
    return False


def _rule_matches(condition, request):
    kind = condition.get("field")
    val = condition.get("values", [])
    req_val = request.get(kind)
    if req_val is None:
        return False
    if kind in ("path-pattern", "host-header"):
        return _glob_match(req_val, val)
    return req_val in val


def _priority_sort_key(rule):
    """ALB's real `default` action carries the literal priority value `"default"` (a string, per
    ELBv2's own API contract) — `sorted(rules, key=priority)` crashed comparing int to str. Treat
    `"default"` as sorting LAST (infinite priority): every numbered rule is evaluated first, and the
    default action — which ALWAYS exists on a real listener — is the final fallback, never crashing
    (L2 finding #5b)."""
    p = rule.get("priority")
    if p == "default":
        return float("inf")
    try:
        return float(p)
    except (TypeError, ValueError):
        return float("inf")


def eval_alb_listener(rules, request):
    """`rules`: priority-ordered list of {"priority": int|"default", "conditions": [...],
    "action": {...}}. First matching rule wins (ALB semantics); `"default"` (ELBv2's own literal
    priority value for the listener's always-present default action) sorts last.

    L2 finding #5a: a real ALB listener ALWAYS has a default action — a rule set that omits it is
    MISSING DATA (an incomplete describe/fixture), not a genuine "nothing matched, traffic denied"
    outcome. Falling through the whole rule list without ever hitting a `priority == "default"` row
    must therefore return `unknown`, never a confident `blocked` (matching the same "missing data
    never yields a confident deny" fix already applied to eval_security_group/eval_route)."""
    has_default = any(r.get("priority") == "default" for r in rules)
    for rule in sorted(rules, key=_priority_sort_key):
        conditions = rule.get("conditions", [])
        if conditions and not all(_rule_matches(c, request) for c in conditions):
            continue
        action = rule.get("action", {})
        kind = action.get("type")
        label = f"rule/{rule['priority']}"
        if kind == "fixed-response":
            code = int(action.get("status_code", 200))
            status = "blocked" if code >= 400 else "allowed"
            return {"layer": "alb-listener", "status": status, "resource": label,
                    "summary": f"fixed-response {code}", "evidence": [rule]}
        if kind == "redirect":
            return {"layer": "alb-listener", "status": "conditional", "resource": label,
                     "summary": "redirect action changes the destination; not evaluated further",
                     "evidence": [rule]}
        if kind == "forward":
            return {"layer": "alb-listener", "status": "allowed", "resource": label,
                    "summary": f"forward to target group {action.get('target_group_arn')}",
                    "evidence": [rule]}
        return {"layer": "alb-listener", "status": "unknown", "resource": label,
                "summary": f"unrecognized action type {kind!r}", "evidence": [rule]}
    if not has_default:
        return {
            "layer": "alb-listener", "status": "unknown", "resource": None,
            "summary": "no listener rule matched and no default action is present in the input "
                       "(a real ALB listener always has one — this is missing data, not a confirmed deny)",
            "evidence": [],
        }
    return {"layer": "alb-listener", "status": "blocked", "resource": None,
            "summary": "no listener rule matched and no default action reached", "evidence": []}


def eval_target_group_health(healthy_target_count, total_target_count):
    if total_target_count == 0:
        return {"layer": "target-group", "status": "blocked", "resource": None,
                "summary": "target group has no registered targets", "evidence": []}
    if healthy_target_count == 0:
        return {"layer": "target-group", "status": "blocked", "resource": None,
                "summary": "target group has zero healthy targets", "evidence": []}
    if healthy_target_count < total_target_count:
        return {"layer": "target-group", "status": "conditional", "resource": None,
                "summary": f"{healthy_target_count}/{total_target_count} targets healthy",
                "evidence": []}
    return {"layer": "target-group", "status": "allowed", "resource": None,
            "summary": f"{healthy_target_count}/{total_target_count} targets healthy", "evidence": []}


# ── Kubernetes policy: NetworkPolicy (default-deny + selector match) ───────────────────────────

def _labels_match(selector, labels):
    return all(labels.get(k) == v for k, v in (selector or {}).items())


def _policy_type_applies(policy, direction):
    """Kubernetes' REAL `policyTypes`-defaulting semantics (L4 finding #10a): when `policy_types`
    is genuinely absent from the policy (not merely an empty list — an explicit `[]` is NOT the
    same as "key omitted" and is treated as "selects nothing", matching the K8s API), the default
    is `[Ingress]`, PLUS `Egress` whenever the policy's own `egress` key is present at all (even
    with zero rules — presence of the field, not the rule COUNT, is what triggers the K8s
    apiserver's default). When `policy_types` IS present, only that explicit (case-insensitive) list
    matters — no defaulting applies."""
    pts = policy.get("policy_types")
    if pts is not None:
        want = "ingress" if direction == "ingress" else "egress"
        return want in {str(t).lower() for t in pts}
    if direction == "ingress":
        return True  # K8s default: Ingress always applies when policyTypes is omitted entirely.
    return "egress" in policy  # Egress applies only if the `egress` key itself is present.


def _k8s_port_matches(rule, protocol, port):
    """L4 finding #10b: a NetworkPolicy rule's `ports` field was never evaluated before — a policy
    allowing only port 53 read as "any port allowed". `rule["ports"]`: list of
    {"protocol": "TCP"|"UDP"|"SCTP", "port": int|str, "endPort": int (optional range end)}. An
    ABSENT/empty `ports` list means "all ports" (K8s semantics — a rule with no `ports` field
    applies to every port). When `ports` IS present but the flow's own `port` is unknown, this
    conservatively does NOT match (never fail-open on a port-restricted rule just because the
    caller didn't supply a port to check).

    Returns `True` (matched), `False` (confidently does not match), or `None` (item 2b follow-up
    fix: at least one `ports` entry names a PORT BY NAME — e.g. `"port": "http"` — that this pure
    adapter has no Service-port-name resolution for, and no OTHER entry produced a confident match;
    treating an unresolvable named port as a non-match would silently deny traffic that a real
    cluster might actually allow. `None` tells the caller this rule is unevaluable for that entry,
    not that it confidently denies)."""
    ports = rule.get("ports")
    if not ports:
        return True
    saw_unresolvable_named_port = False
    for p in ports:
        want_proto = str(p.get("protocol") or "TCP").upper()
        if protocol is not None and want_proto != str(protocol).upper():
            continue
        want_port = p.get("port")
        if want_port is None:
            return True
        if port is None:
            continue
        try:
            want_i = int(want_port)
        except (TypeError, ValueError):
            # Named port (e.g. "http") — this adapter never resolves Service/container port names,
            # so it cannot confidently say this entry does NOT match either.
            saw_unresolvable_named_port = True
            continue
        try:
            port_i = int(port)
        except (TypeError, ValueError):
            continue
        end_port = p.get("endPort")
        if end_port is not None:
            try:
                if want_i <= port_i <= int(end_port):
                    return True
            except (TypeError, ValueError):
                continue
        elif port_i == want_i:
            return True
    if saw_unresolvable_named_port:
        return None
    return False


def eval_k8s_network_policy(policies, pod_labels, direction, peer_labels=None, peer_ip=None,
                             protocol=None, port=None, data_available=True,
                             peer_namespace_labels=None, policy_namespace=None, peer_namespace=None):
    """`policies`: list of {"pod_selector": {...}, "policy_types": ["Ingress","Egress"] (optional —
    see `_policy_type_applies` for the real K8s defaulting semantics when omitted),
    "ingress"/"egress": [{"from"/"to": [...], "ports": [...]}]}.

    K8s NetworkPolicy semantics: a pod with NO policy selecting it (for this direction) is fully
    open (`allowed`). A pod selected by >=1 policy for this direction becomes default-deny for that
    direction; it is `allowed` only if at least one rule across the selecting policies matches BOTH
    the peer AND the rule's own `ports` restriction (L4 finding #10b).

    `data_available` (L4 finding #10c): the caller (network_path.py's orchestrator, which actually
    knows whether the topology fetch for this namespace/pod succeeded) must pass `False` when
    `policies` is empty because the fetch itself failed/returned no data — an empty list from a
    GENUINELY policy-free namespace (the common, correct case: most clusters have zero
    NetworkPolicies, and that legitimately means default-allow) must stay distinguishable from "we
    don't actually know." Defaults to `True` so existing "no policy found, and we know it" callers
    are unaffected.

    `policy_namespace`/`peer_namespace` (item 2c follow-up fix): Kubernetes restricts a BARE
    `podSelector` peer (no `namespaceSelector` alongside it) to the SAME namespace as the policy
    itself — it is never cluster-wide. This function has no namespace concept in its earlier input
    contract, so a caller that can supply both of these (the policy's own namespace and the actual
    peer's namespace) gets a correctly-scoped match/no-match; a caller that supplies neither (or
    only one) gets `unknown` for that specific peer entry when its labels would otherwise match —
    never a confident cross-namespace `allowed`.

    MAJOR fix (L2 finding #2): an `ipBlock` peer with an `except` list of CIDRs must NOT match a
    peer whose IP falls inside one of those excluded CIDRs, even though it also falls inside the
    rule's main `cidr` — `except` carves that sub-range back OUT of the allow. Also, a peer entry
    using `namespaceSelector` (alone or combined with `podSelector`) selects pods by NAMESPACE
    labels this function has no way to evaluate unless the caller supplies `peer_namespace_labels`
    — silently skipping such a peer would let a real match fall through to a confident `blocked`
    (a false-deny), so when at least one candidate rule/peer could only be resolved by
    `namespaceSelector` data the caller didn't provide, the verdict is downgraded to `unknown`
    rather than `blocked` (never invent a confident verdict from data we don't have).

    Follow-up fix (item 2a): a `pod_selector` peer with `peer_labels=None`, or an `ip_block` peer
    with `peer_ip=None`, used to fall straight through to a confident `blocked` (indistinguishable
    from a genuine, evaluated non-match) — both are now tracked the same way the namespaceSelector
    gap already is, and downgrade the final verdict to `unknown` when nothing else confidently
    matched.
    """
    if not data_available:
        return {"layer": "k8s-networkpolicy", "status": "unknown", "resource": None,
                "summary": "NetworkPolicy data was not fetched for this pod/namespace — cannot "
                           "evaluate (missing data, not a confirmed absence of policy)",
                "evidence": []}
    key = "ingress" if direction == "ingress" else "egress"
    # MAJOR fix (fail-open bug): the docstring's OWN documented input shape uses Kubernetes
    # canonical casing ("Ingress"/"Egress"), but this used to compare against the lowercase `key`
    # directly — with the documented shape, no policy ever selected the pod, so a default-deny pod
    # always returned `allowed`. `_policy_type_applies` normalizes case AND implements the real
    # defaulting-when-omitted rule (L4 finding #10a).
    selecting = [p for p in policies if _labels_match(p.get("pod_selector"), pod_labels)
                 and _policy_type_applies(p, direction)]
    if not selecting:
        return {"layer": "k8s-networkpolicy", "status": "allowed", "resource": None,
                "summary": "no NetworkPolicy selects this pod for this direction (default allow)",
                "evidence": []}
    saw_unresolvable_namespace_selector = False
    saw_unresolvable_peer_data = False
    saw_unscoped_bare_pod_selector = False
    for policy in selecting:
        for rule in policy.get(key, []):
            port_match = _k8s_port_matches(rule, protocol, port)
            # MINOR fix (round 2): a CONFIDENT port non-match (`False`) must still skip this rule
            # immediately, exactly as before — the rule is irrelevant regardless of its peers, and
            # evaluating peers anyway can surface an UNRELATED ambiguity (e.g. a bare podSelector
            # peer whose namespace scoping can't be confirmed) that would incorrectly downgrade an
            # otherwise-confident `blocked` to `unknown`. Only an UNRESOLVABLE port (`None` — a named
            # port this adapter can't resolve) defers the decision to peer evaluation below, and even
            # then only actually taints the verdict if some peer would otherwise be a confident
            # match — a rule whose peers definitively don't match is still irrelevant regardless of
            # whether its port could be resolved (item 2b's original concern, now scoped correctly).
            if port_match is False:
                continue
            peers = rule.get("from" if direction == "ingress" else "to", [])
            if not peers:  # an empty peer list on a present rule means "allow all" for that rule
                if port_match is None:
                    saw_unresolvable_peer_data = True
                    continue
                return {"layer": "k8s-networkpolicy", "status": "allowed", "resource": None,
                        "summary": "matching NetworkPolicy rule allows all peers", "evidence": [rule]}
            for peer in peers:
                has_ns_selector = "namespace_selector" in peer
                has_pod_selector = "pod_selector" in peer
                has_ip_block = "ip_block" in peer

                if has_ns_selector:
                    # MINOR fix: an EMPTY namespaceSelector (`{}` — no matchLabels/matchExpressions)
                    # is Kubernetes' own "match every namespace" semantics, a vacuous match that
                    # needs no namespace-label data at all. The old code checked
                    # `peer_namespace_labels is None` before even looking at whether the selector
                    # was trivial, turning a decidable `allowed` into an unnecessary `unknown`. Only
                    # a genuinely non-trivial (non-empty) selector requires namespace-label data.
                    ns_selector = peer["namespace_selector"]
                    if ns_selector:
                        if peer_namespace_labels is None:
                            # Can't evaluate a namespaceSelector peer without namespace label data
                            # — do NOT fall through to a confident blocked; remember it and keep
                            # scanning other peers/rules in case one of THEM confidently allows.
                            saw_unresolvable_namespace_selector = True
                            continue
                        if not _labels_match(ns_selector, peer_namespace_labels):
                            continue  # namespace doesn't match this peer's namespaceSelector

                if has_pod_selector:
                    # MINOR fix: same empty-selector vacuous-match treatment as namespaceSelector
                    # above — `podSelector: {}` matches every pod and needs no peer_labels.
                    pod_selector = peer["pod_selector"]
                    if pod_selector:
                        if peer_labels is None:
                            # item 2a: can't evaluate a podSelector peer without peer label data —
                            # unresolved, not a confident non-match.
                            saw_unresolvable_peer_data = True
                            continue
                        if not _labels_match(pod_selector, peer_labels):
                            continue  # labels genuinely don't match this peer — confident non-match

                    if not has_ns_selector:
                        # item 2c: a BARE podSelector (no namespaceSelector alongside it) is
                        # restricted by K8s to the policy's OWN namespace — labels matched, but we
                        # still need namespace confirmation before this can be a confident allow.
                        if policy_namespace is None or peer_namespace is None:
                            saw_unscoped_bare_pod_selector = True
                            continue
                        if policy_namespace != peer_namespace:
                            continue  # different namespace — bare podSelector cannot reach it

                    if port_match is None:
                        saw_unresolvable_peer_data = True
                        continue
                    return {"layer": "k8s-networkpolicy", "status": "allowed", "resource": None,
                            "summary": "matched pod_selector peer rule", "evidence": [peer]}

                if has_ns_selector:
                    # namespaceSelector alone (no podSelector): matches every pod in that namespace.
                    if port_match is None:
                        saw_unresolvable_peer_data = True
                        continue
                    return {"layer": "k8s-networkpolicy", "status": "allowed", "resource": None,
                            "summary": "matched namespaceSelector peer rule", "evidence": [peer]}

                if has_ip_block:
                    cidr = peer["ip_block"].get("cidr")
                    # MINOR fix: a present-but-malformed peer_ip must be treated the same as a
                    # missing one — see `_is_valid_ip`'s docstring.
                    if peer_ip is None or not _is_valid_ip(peer_ip):
                        # item 2a: can't evaluate an ipBlock peer without a valid peer_ip — unresolved.
                        saw_unresolvable_peer_data = True
                        continue
                    if not _cidr_contains(cidr, peer_ip):
                        continue
                    excepts = peer["ip_block"].get("except") or []
                    if any(_cidr_contains(ex, peer_ip) for ex in excepts):
                        continue  # excluded sub-range carves this peer back OUT of the allow
                    if port_match is None:
                        saw_unresolvable_peer_data = True
                        continue
                    return {"layer": "k8s-networkpolicy", "status": "allowed", "resource": None,
                            "summary": "matched ipBlock peer rule", "evidence": [peer]}
    if saw_unresolvable_namespace_selector:
        return {
            "layer": "k8s-networkpolicy", "status": "unknown", "resource": None,
            "summary": "a candidate NetworkPolicy rule uses namespaceSelector but the caller did "
                       "not supply peer namespace labels — cannot confidently evaluate", "evidence": [],
        }
    if saw_unscoped_bare_pod_selector:
        return {
            "layer": "k8s-networkpolicy", "status": "unknown", "resource": None,
            "summary": "a candidate NetworkPolicy rule's bare podSelector peer's labels match, but "
                       "the policy's own namespace and/or the peer's namespace were not supplied — "
                       "cannot confirm the same-namespace scoping K8s requires for a bare podSelector",
            "evidence": [],
        }
    if saw_unresolvable_peer_data:
        return {
            "layer": "k8s-networkpolicy", "status": "unknown", "resource": None,
            "summary": "a candidate NetworkPolicy rule could not be evaluated due to missing peer "
                       "data (podSelector peer with no peer_labels, ipBlock peer with no peer_ip, or "
                       "a named port this adapter cannot resolve) — cannot confidently evaluate",
            "evidence": [],
        }
    return {"layer": "k8s-networkpolicy", "status": "blocked", "resource": None,
            "summary": "pod is selected by >=1 NetworkPolicy for this direction; no rule matched the peer",
            "evidence": []}


# ── Kubernetes policy: Calico / Cilium / Istio — supported vs unsupported schema ───────────────

_SUPPORTED_CRD_VERSIONS = {
    "calico": {"projectcalico.org/v3"},
    "cilium": {"cilium.io/v2"},
    "istio-virtualservice": {"networking.istio.io/v1", "networking.istio.io/v1beta1"},
    "istio-destinationrule": {"networking.istio.io/v1", "networking.istio.io/v1beta1"},
    "istio-authorizationpolicy": {"security.istio.io/v1", "security.istio.io/v1beta1"},
    "istio-peerauthentication": {"security.istio.io/v1", "security.istio.io/v1beta1"},
}


def eval_mesh_policy_stub(kind, observed_api_version, crd_present):
    """Bounded stub for Cilium (policy + egress gateways) and Istio VirtualService, DestinationRule,
    Gateway, AuthorizationPolicy, PeerAuthentication. This is intentionally NOT a full live policy
    evaluator (see the report: these stay correctly-stubbed-`unknown`, detection-only) — it never
    returns `allowed`/`blocked` for a schema it cannot fully parse, satisfying the spec's
    "Unsupported versions, missing CRDs ... become `?`. They never become `O`."

    Its three branches already distinguish "genuinely no mesh CRD installed" from "CRD present, but
    an unsupported version" from "CRD present and a supported version, but not evaluated" via
    `crd_present`/`observed_api_version` — the DETECTION half of gap 2's ask is already real here;
    what remains a stub is the actual rule evaluation for Cilium/Istio (no code in this worker reads
    live Cilium/Istio CRD content today — see the report for why: this worker has no live K8s client
    at all, only whatever the topology fetcher/discover phase supplies in `data`). Calico now has its
    OWN dedicated evaluator (`eval_calico_policy`, below) wired into network_path.py in place of this
    stub — this function is kept for Cilium/Istio and for any caller that still wants the pre-Calico
    stub behavior directly (e.g. the TestMeshPolicyStub suite exercising it with kind="calico").
    """
    layer = f"k8s-{kind}"
    if not crd_present:
        return {"layer": layer, "status": "unknown", "resource": None,
                "summary": f"{kind} CRD not installed in this cluster", "evidence": []}
    supported = _SUPPORTED_CRD_VERSIONS.get(kind, set())
    if observed_api_version not in supported:
        return {"layer": layer, "status": "unknown", "resource": None,
                "summary": f"unsupported {kind} apiVersion {observed_api_version!r}", "evidence": []}
    return {"layer": layer, "status": "unknown", "resource": None,
            "summary": f"{kind} policy evaluation is not implemented in this release", "evidence": []}


# ── Kubernetes policy: Calico NetworkPolicy (projectcalico.org/v3) — REAL evaluation ────────────

_CALICO_TERM_RE = re.compile(r"^\s*([\w./-]+)\s*(==|!=|not\s+in|in)\s*(.+?)\s*$")


def _parse_calico_value_list(raw):
    raw = raw.strip()
    if raw.startswith("{") and raw.endswith("}"):
        raw = raw[1:-1]
    return [v.strip().strip("'\"") for v in raw.split(",") if v.strip()]


def _calico_selector_matches(selector, labels):
    """Evaluate a Calico label-selector STRING against `labels` (dict).

    Returns `True`/`False` for a confidently-evaluated selector, or `None` when the selector uses a
    construct this bounded parser cannot confidently evaluate — callers MUST treat `None` as
    unresolvable (never as a confident non-match), matching every other "missing data -> never a
    fabricated verdict" rule in this module.

    Supported subset: `''`/`'all()'` (matches everything — Calico's own "select everything");
    a FLAT `&&`-joined conjunction of `key == 'value'` / `key != 'value'` / `key in {'a','b'}` /
    `key not in {'a','b'}` terms. Calico's selector language is a much larger boolean DSL
    (`||`, `has()`/`!has()`, parenthesized grouping, glob-style operators) — none of that is
    supported here; any of it makes this return `None` rather than guess.
    """
    selector = (selector or "").strip()
    if selector in ("", "all()"):
        return True
    # CI-review MAJOR fix (round 24): a non-trivial selector needs REAL labels to evaluate any
    # `==`/`!=`/`in`/`not in` term against — but the per-term loop below normalizes `labels or {}`,
    # silently treating an absent (`None`) label set as an EMPTY-but-present one, so an `==` term
    # confidently evaluates `False` and a `!=` term confidently `True` from data this adapter never
    # actually has. This is the exact asymmetry round 20 already closed at each individual CALL
    # SITE (`peer_labels is None`/`peer_namespace_labels is None` guards before calling this
    # helper) — guarding it HERE closes it for every caller at once, including `eval_calico_policy`
    # -> pod_labels, which the round-23 `k8s-calico` wiring passes as `data.get("pod_labels", {})`
    # (silently defaulting to an empty dict on partially-populated candidate data, the same failure
    # mode round 23 already fixed for `policies_fetched`).
    if labels is None:
        return None
    if "||" in selector or "has(" in selector or "(" in selector.replace("all()", ""):
        return None
    for term in (t.strip() for t in selector.split("&&")):
        m = _CALICO_TERM_RE.match(term)
        if not m:
            return None
        key, op, val = m.groups()
        op = re.sub(r"\s+", " ", op.strip())
        actual = (labels or {}).get(key)
        if op == "==":
            if actual != val.strip("'\""):
                return False
        elif op == "!=":
            if actual == val.strip("'\""):
                return False
        elif op == "in":
            if actual not in _parse_calico_value_list(val):
                return False
        elif op == "not in":
            if actual in _parse_calico_value_list(val):
                return False
        else:  # pragma: no cover — regex only captures the 4 ops above
            return None
    return True


def _calico_policy_type_applies(policy, direction):
    """Calico's `types` defaulting: when present, only that explicit list applies (case-insensitive,
    same as core K8s). When OMITTED, Calico's own docs default `types` to a THREE-way rule: `Ingress`
    applies unless the policy has EGRESS rules but NO ingress rules (an egress-only policy);
    `Egress` applies iff the policy has egress rules. Equivalently: Ingress applies for the
    no-rules case, the ingress-only case, AND the both-rules case — it is excluded ONLY for the
    egress-only case.

    CI-review MAJOR fix (round 23): the earlier "symmetric rule presence" defaulting (`key in
    policy` for BOTH directions) inverted the verdict for the no-rules-at-all case — a
    selector-only policy with NEITHER an `ingress` NOR an `egress` key, and no `types`, is a valid
    Calico default-deny shape whose real default is `types: [Ingress]` (Calico ALWAYS defaults
    Ingress in when there are no egress rules to override that), so it SHOULD select the pod for
    Ingress and reduce to `blocked` — the old code returned `key in policy` -> `False` for
    Ingress, treating the policy as not selecting the pod at all and confidently `allowed`ing
    traffic a real cluster would default-deny. Egress's own defaulting (applies iff an `egress`
    key is present) was already correct and is unchanged.

    CI-review MAJOR fix (round 24): the round-23 fix (`"egress" not in policy` for ingress) closed
    the no-rules case but REGRESSED the both-rules case — a policy with BOTH `ingress` and
    `egress` keys and omitted `types` now returned `False` for ingress (since `"egress" in
    policy` was `True`), even though real Calico defaults such a policy to `[Ingress, Egress]`
    (both apply). A genuinely ingress-governing policy was silently treated as not selecting the
    pod, risking a confident `allowed` a real cluster would deny. Ingress is now excluded ONLY
    for the true egress-only shape (`egress` present, `ingress` absent) — every other combination
    (no rules, ingress-only, or both) correctly includes Ingress."""
    types = policy.get("types")
    if types:
        want = "ingress" if direction == "ingress" else "egress"
        return want in {str(t).lower() for t in types}
    if direction == "ingress":
        return not ("egress" in policy and "ingress" not in policy)
    return "egress" in policy


def eval_calico_policy(policies, pod_labels, direction, crd_present=True, observed_api_version=None,
                        peer_labels=None, peer_ip=None, peer_namespace_labels=None,
                        protocol=None, port=None, data_available=True):
    """Real Calico NetworkPolicy (`projectcalico.org/v3`) evaluation — deliberately reuses
    `eval_k8s_network_policy`'s port-matching (`_k8s_port_matches`) and CIDR/IP helpers
    (`_cidr_contains`/`_is_valid_ip`), since Calico's policy model is a superset of core K8s
    NetworkPolicy for the overlapping feature set (selector-based allow rules, default-deny-once-
    selected, per-rule ports, CIDR/`nets` peers). It differs mainly in its label-selector language
    (a string DSL, `_calico_selector_matches`) instead of core K8s's dict `matchLabels`, and in its
    peer shape (`source`/`destination` carrying `selector`/`namespaceSelector`/`nets` together,
    ANDed, rather than core K8s's `from`/`to` peer list of alternative OR'd peer entries).

    `policies`: [{"selector": str, "types": ["Ingress","Egress"] (optional),
    "ingress"/"egress": [{"action": "Allow"|"Deny"|"Log"|"Pass" (only "Allow" rules are ever
    evaluated — see below), "source"/"destination": {"selector": str, "namespaceSelector": str,
    "nets": [cidr, ...]}, "protocol": str, "ports": [...]}]}.

    Only `action: Allow` rules ever contribute a confident `allowed` — a `Deny`/`Log`/`Pass` rule
    that would otherwise match is simply skipped (not evaluated as a blocker), matching this
    feature's "never invent a confident `blocked` from a mechanism this adapter cannot fully model"
    rule. (Round-26 docstring fix: a rule whose `action` is ABSENT or unrecognized is not assumed
    to be any of the four real Calico actions either — it vetoes a confident verdict the same
    conservative way, since `action` is a required field on a real `Rule` and its absence/
    malformation is partially-fetched data, not "no constraint.") Calico's real deny/pass
    precedence also depends on `order` across policies (lower order
    wins, ties are undefined across tiers), which this bounded evaluator does not model — assigning
    a Deny/Pass rule an authoritative `blocked` here could be wrong relative to a differently-ordered
    Allow elsewhere. The final "no Allow rule matched" case still correctly reduces to `blocked`
    (mirrors `eval_k8s_network_policy`'s own default-deny-once-selected semantics), since the ABSENCE
    of any matching Allow is itself confidently evaluable without needing Calico's ordering model.

    CI-review MAJOR fix (round 17): the SAME unmodeled-`order` problem the docstring above already
    defends `blocked` against also applies to `allowed` — a lower-order Deny/Pass rule that ALSO
    matches this peer would win over a later-listed Allow rule under Calico's real precedence, but
    (before this fix) a skipped Deny/Pass rule was never even checked against the peer, so this
    function could still confidently return `allowed` while such a conflicting Deny/Pass existed.
    Every skipped Deny/Pass rule is now checked against the SAME peer/port criteria an Allow rule
    would be; if it matches (or its match can't be confidently ruled out), the result degrades to
    `unknown` instead of a confident `allowed`, mirroring this module's own "never invent" rule for
    the direction it was previously missing.
    """
    layer = "k8s-calico"
    if not crd_present:
        return {"layer": layer, "status": "unknown", "resource": None,
                "summary": "calico CRD not installed in this cluster", "evidence": []}
    if observed_api_version not in _SUPPORTED_CRD_VERSIONS.get("calico", set()):
        return {"layer": layer, "status": "unknown", "resource": None,
                "summary": f"unsupported calico apiVersion {observed_api_version!r}", "evidence": []}
    if not data_available:
        return {"layer": layer, "status": "unknown", "resource": None,
                "summary": "Calico NetworkPolicy data was not fetched for this pod/namespace — "
                           "cannot evaluate (missing data, not a confirmed absence of policy)",
                "evidence": []}

    # CI-review MAJOR fix (round 23): round 21's allowlist principle was applied to Rule/EntityRule
    # keys only — a real Calico policy SPEC field this adapter doesn't read (e.g.
    # `serviceAccountSelector`, `preDNAT`, `applyOnForward`, `doNotTrack`) could scope the policy
    # away from this pod, or change how/whether it applies, entirely silently; the same
    # whack-a-mole class rounds 18-22 closed at the rule level was left open at the policy level.
    # `order` is deliberately allowlisted as "known and already handled elsewhere" — this module's
    # existing cross-policy-order gap is a documented, accepted limitation (see this function's own
    # docstring on `saw_deny_or_pass_conflict`), not something this guard needs to re-flag.
    _MODELED_POLICY_KEYS = {"selector", "types", "ingress", "egress", "order"}
    selecting = []
    for p in policies:
        if any(k not in _MODELED_POLICY_KEYS for k in p):
            return {"layer": layer, "status": "unknown", "resource": None,
                    "summary": "a Calico policy uses a spec field this adapter does not model "
                               "(e.g. serviceAccountSelector/preDNAT/applyOnForward/doNotTrack) — "
                               "whether/how it governs this pod cannot be confidently determined",
                    "evidence": []}
        match = _calico_selector_matches(p.get("selector"), pod_labels)
        if match is None:
            return {"layer": layer, "status": "unknown", "resource": None,
                    "summary": "a Calico policy's own selector uses a construct this adapter cannot "
                               "confidently evaluate (supported subset: '', 'all()', or a flat && "
                               "chain of ==/!=/in/not-in terms)", "evidence": []}
        if match and _calico_policy_type_applies(p, direction):
            selecting.append(p)
    if not selecting:
        return {"layer": layer, "status": "allowed", "resource": None,
                "summary": "no Calico NetworkPolicy selects this pod for this direction (default allow)",
                "evidence": []}

    key = "ingress" if direction == "ingress" else "egress"
    saw_unresolvable = False
    saw_deny_or_pass_conflict = False
    saw_pass_conflict = False
    saw_unresolvable_action = False
    matched_allow_rule = None
    _CALICO_ACTIONS = {"allow", "deny", "log", "pass"}
    for policy in selecting:
        for rule in policy.get(key, []):
            match = _calico_rule_peer_match(rule, direction, peer_labels, peer_ip,
                                             peer_namespace_labels, protocol, port)
            # CI-review MAJOR fix (round 25): `action` is a REQUIRED field on a real Calico v3
            # `Rule` — an absent `action` is malformed/partially-fetched data, not the absence of
            # a constraint. Defaulting it to `"Allow"` let a bare rule like `{}` (no peer/port
            # criteria at all, so `_calico_rule_peer_match` confidently matches ANY peer) reach a
            # confident `allowed` for a rule whose real action might be `Deny`. A matching (or
            # possibly-matching) rule with no `action` at all is now treated the same way an
            # unmodeled Deny/Pass conflict already is — it vetoes a confident verdict rather than
            # being guessed as an Allow.
            # CI-review MINOR fix (round 26): the round-25 guard only caught an ABSENT `action`
            # key — a PRESENT-but-malformed value (`""`, a typo like `"Alow"`) fell through to
            # `action != "allow"`, which treats anything not spelled exactly `"allow"` as
            # Deny/Pass-like. A garbled value could just as easily have MEANT `Allow`; guessing
            # it's a blocker is the same malformed-data class this round's rationale already
            # covers for the absent-key case. Only the four real Calico actions are recognized;
            # anything else is unresolvable, not assumed Deny/Pass.
            raw_action = rule.get("action")
            if raw_action is None or str(raw_action).lower() not in _CALICO_ACTIONS:
                if match is not False:
                    saw_unresolvable_action = True
                continue
            action = str(raw_action).lower()
            if action != "allow":
                # CI-review MAJOR fix (round 17): a Deny/Log/Pass rule used to be skipped WITHOUT
                # ever checking whether it matches this peer — see the docstring above for why a
                # matching (or possibly-matching) Deny/Pass rule anywhere in the list must veto a
                # confident `allowed`, since this adapter has no model of cross-policy `order`.
                if match is not False:
                    saw_deny_or_pass_conflict = True
                    # CI-review MAJOR fix (round 18, part c): unlike Deny (which simply drops the
                    # packet, so "no Allow matched" is safely `blocked` regardless), a matching
                    # `Pass` rule delegates evaluation to the next tier/profile — which may itself
                    # allow the traffic. Absent an Allow match, this must degrade to `unknown`, not
                    # fall through to the same confident `blocked` a Deny would correctly get.
                    if action == "pass":
                        saw_pass_conflict = True
                continue
            if match is False:
                continue
            if match is None:
                saw_unresolvable = True
                continue
            if matched_allow_rule is None:
                matched_allow_rule = rule
    if matched_allow_rule is not None:
        if saw_deny_or_pass_conflict or saw_unresolvable_action:
            return {"layer": layer, "status": "unknown", "resource": None,
                    "summary": "an Allow rule matches this peer, but a Deny/Pass rule (or a rule "
                               "whose `action` is absent or unrecognized, which this adapter "
                               "cannot assume is an Allow) that also matches (or might match) it "
                               "exists — Calico's "
                               "real precedence between them depends on policy/rule `order`, "
                               "which this adapter does not model", "evidence": [matched_allow_rule]}
        return {"layer": layer, "status": "allowed", "resource": None,
                "summary": "matched Calico rule peer", "evidence": [matched_allow_rule]}
    # No Allow rule matched. A matching/possibly-matching DENY here still safely reduces to
    # `blocked` (dropping the packet needs no ordering model), but a matching/possibly-matching
    # PASS does not — it delegates elsewhere, so `saw_pass_conflict` vetoes the confident `blocked`
    # below (see `test_deny_action_rule_is_never_a_confident_blocker` for why plain Deny/no-match
    # still safely falls through to `blocked`). A matching/possibly-matching rule with NO `action`
    # at all is treated the same conservative way — its real action (possibly Allow) is unknown.
    if saw_unresolvable or saw_pass_conflict or saw_unresolvable_action:
        return {"layer": layer, "status": "unknown", "resource": None,
                "summary": "a candidate Calico rule could not be confidently evaluated due to "
                           "missing peer data, an unmodeled negation field, a matching `Pass` "
                           "rule (which delegates to the next tier/profile), a rule whose "
                           "`action` field is absent or unrecognized, or a selector construct "
                           "this adapter cannot parse", "evidence": []}
    return {"layer": layer, "status": "blocked", "resource": None,
            "summary": "pod is selected by >=1 Calico NetworkPolicy for this direction; no Allow "
                       "rule matched the peer", "evidence": []}


def _normalize_calico_ports(ports):
    """Build the `{"port", "endPort"}` dict shape `_k8s_port_matches` expects from Calico's native
    `ports` list, which is plain ints/strings (`numorstring.Port` in the Calico CRD schema) — e.g.
    `[80, 443]` or `["8080:9090", "http"]` — never core K8s's own `{"protocol", "port"}` dicts. A
    dict entry (some test fixtures/callers already use that shape directly) passes through
    unchanged; an int or a pure numeric string becomes `{"port": N}`; a `"N:M"` range becomes
    `{"port": N, "endPort": M}`; anything else (a named port, e.g. `"http"`) is passed through as
    `{"port": <name>}` so `_k8s_port_matches`'s own int() conversion failure marks it as an
    unresolvable named port (`None`), never a guessed match/non-match."""
    out = []
    for p in ports or []:
        if isinstance(p, dict):
            out.append(p)
            continue
        s = str(p)
        if ":" in s:
            lo, _, hi = s.partition(":")
            try:
                out.append({"port": int(lo), "endPort": int(hi)})
                continue
            except ValueError:
                pass
        out.append({"port": p})
    return out


# CI-review MAJOR fix (round 22): Calico's `protocol` field is a `numorstring` — a rule may spell
# it either as a name ("TCP") or as its IANA protocol number ("6"/6). Only the IANA numbers this
# repo's own layers actually distinguish are mapped; anything else is left unresolved rather than
# guessed.
_CALICO_PROTOCOL_NUMBERS = {1: "ICMP", 6: "TCP", 17: "UDP", 58: "ICMPV6", 132: "SCTP"}


def _calico_protocol_name(value):
    """Normalize a Calico `protocol` value to its uppercase name, or `None` if `value` is absent
    or not a representation this adapter can confidently resolve (an unrecognized protocol
    number, or a non-numeric string is passed through uppercased as a best-effort name match)."""
    if value is None:
        return None
    if isinstance(value, int):
        return _CALICO_PROTOCOL_NUMBERS.get(value)
    s = str(value)
    if s.isdigit():
        return _CALICO_PROTOCOL_NUMBERS.get(int(s))
    return s.upper()


def _calico_rule_peer_match(rule, direction, peer_labels, peer_ip, peer_namespace_labels, protocol, port):
    """Whether `rule`'s protocol/port + peer (`selector`/`namespaceSelector`/`nets`) criteria match
    the given peer — the SAME logic `eval_calico_policy` applies to an Allow rule, factored out so
    it can ALSO be applied to a skipped Deny/Pass rule (round 17 fix, see that function's
    docstring). Returns `True` (confirmed match), `False` (confirmed no match), or `None` (this
    adapter cannot confidently tell — missing peer data, an unmodeled negation field, or a selector
    construct it cannot parse).

    CI-review MAJOR fix (round 18, part a): unlike core K8s NetworkPolicy (where `protocol` lives
    per-`ports`-entry), Calico carries a RULE-LEVEL `protocol` field independent of `ports` — a rule
    with `protocol: UDP` and no `ports` used to reach `_k8s_port_matches({}, ...)`, whose own
    "absent `ports` -> match any port" contract short-circuits to `True` before ever consulting the
    protocol argument, so a UDP-only Allow rule confidently `allowed`ed TCP traffic. The rule's own
    `protocol` is now checked directly, independent of whatever `_k8s_port_matches` decides about
    `ports`. The old `protocol or rule.get("protocol")` fallback into `_k8s_port_matches` is
    removed too — the CALLER's protocol is what per-`ports`-entry protocol should be compared to,
    not the rule's own (which would make a rule always match itself).

    CI-review MAJOR fix (round 18, part b): Calico's `notNets`/`notSelector`/`notPorts` peer/port
    negation fields were silently ignored — a rule declaring `nets: [0.0.0.0/0], notNets:
    [10.0.0.0/8]` reported a confident match for a 10.x peer this adapter cannot actually confirm is
    excluded (or included, for a rule this adapter can't parse the negation of at all). Any of these
    fields present makes the rule genuinely unresolvable, not a guessed match/non-match.

    CI-review MAJOR fix (round 18, part a, follow-up): Calico's native `ports` entries are plain
    ints/strings (e.g. `[80, 443]` or `["8080:9090"]`) — NOT the `{"protocol", "port"}` dict shape
    `_k8s_port_matches` expects (that shape is core K8s NetworkPolicy's own). Passing Calico ports
    straight through used to make every entry fail `isinstance` checks inside `_k8s_port_matches`
    silently (an int has no `.get`), so a Calico rule with a real native `ports` list never actually
    restricted anything. `_normalize_calico_ports` below builds the dict shape first.

    CI-review MAJOR fix (round 19): `ports`/`notPorts` were read off the RULE root, but the real
    Calico v3 `Rule` schema has no top-level `ports`/`notPorts` at all — those fields live inside
    the `EntityRule` (`source`/`destination`), same as `selector`/`nets`. A `ports` restriction
    always describes the DESTINATION port of the connection regardless of direction (the port the
    connection is made TO), so it is read from `destination` for both ingress and egress — for
    egress `destination` is already `peer` (the entity being contacted); for ingress it is the
    protected workload's own listening port, a separate EntityRule from `peer` (`source`, the
    sender). Reading from the rule root used to silently ignore any real `ports`/`notPorts`
    restriction (and never trigger the `notPorts` negation guard), so a port-restricted Allow rule
    confidently `allowed` traffic to every port. `notProtocol` (a real rule-level field, independent
    of `EntityRule`) is added to the negation guard alongside the peer/port ones for the same
    reason `notNets`/`notSelector`/`notPorts` are guarded — this adapter cannot evaluate a negated
    protocol match.

    CI-review MAJOR fix (round 20, part a): for INGRESS, `peer` is `source` (the sender) and
    `dest` is `destination` (the protected workload) — two DIFFERENT EntityRules. Only `dest`'s
    `ports`/`notPorts` were ever read; a real Calico ingress rule can ALSO constrain `destination.
    nets`/`selector`/`namespaceSelector`/`notNets`/`notSelector` (which of the policy-selected
    workloads THIS rule applies to), and none of that was evaluated at all — a rule allowing
    `source.nets: [0.0.0.0/0]` only to `destination.nets: [10.0.1.0/24]` used to confidently
    `allowed` a peer reaching a workload outside that net. Any of those fields present on
    `destination`, for ingress, now forces `unknown` (this adapter has no signal for "is THIS
    protected workload the one `destination` scopes to"). `ipVersion` (a real rule-level field,
    unmodeled either way) is guarded the same way.

    CI-review MAJOR fix (round 20, part b): the `namespaceSelector` branch passed
    `peer_namespace_labels` straight into `_calico_selector_matches` without ever checking for
    `None` first — that helper's own `labels or {}` normalization makes an absent-labels input
    silently behave like an EMPTY (but present) label set, so every `==`/`in` term confidently
    evaluates `False` and every `!=`/`not in` term confidently evaluates `True`. Unfetched
    namespace labels thus produced a confident `blocked`/`allowed` instead of `unknown` — the
    exact asymmetry the `selector`/`peer_labels` branch already guards against below. A `None`
    `peer_namespace_labels` now short-circuits to unresolvable, mirroring that branch.

    CI-review MAJOR fix (round 21): rounds 18-20 each closed one more Calico field this function
    silently ignored (protocol, negation fields, destination-side constraints, ipVersion) via a
    hand-maintained DENY-list — the exact whack-a-mole pattern that guarantees the next unmodeled
    field (round 21 found `serviceAccounts`/`notServiceAccounts`/`notNamespaceSelector`, and
    `source`-side `ports`/`notPorts` on the sender for ingress) produces the same confident
    `allowed`. The guard is now an ALLOWLIST: any key on the Rule itself, or on EITHER EntityRule
    (`source`/`destination`), outside the explicitly modeled set forces `unknown` — this closes
    the whole class (including `icmp`/`notICMP`/`http`) at once rather than one field per round."""
    _MODELED_RULE_KEYS = {"action", "protocol", "notProtocol", "ipVersion", "source", "destination", "metadata"}
    _MODELED_ENTITY_KEYS = {"nets", "selector", "namespaceSelector", "notNets", "notSelector", "ports", "notPorts"}
    source_entity = rule.get("source") or {}
    dest_entity = rule.get("destination") or {}
    if (any(k not in _MODELED_RULE_KEYS for k in rule)
            or any(k not in _MODELED_ENTITY_KEYS for k in source_entity)
            or any(k not in _MODELED_ENTITY_KEYS for k in dest_entity)):
        return None
    peer = rule.get("source" if direction == "ingress" else "destination") or {}
    dest = rule.get("destination") or {}
    if (rule.get("notProtocol") or rule.get("ipVersion") is not None
            or dest.get("notPorts") or peer.get("notSelector") or peer.get("notNets")):
        return None
    # The entity NOT used as `peer` for this direction (destination for ingress, source for
    # egress) can still carry its own nets/selector/namespaceSelector constraint — a real Calico
    # field this adapter has no way to evaluate (it has no signal for "is THIS policy-selected
    # workload the one that entity scopes to"), generalizing round 20's ingress-only version of
    # this same guard to cover the symmetric egress case too.
    opposite_entity = dest_entity if direction == "ingress" else source_entity
    if (opposite_entity.get("nets") or opposite_entity.get("selector") or opposite_entity.get("namespaceSelector")
            or opposite_entity.get("notSelector") or opposite_entity.get("notNets")):
        return None
    # CI-review MAJOR fix (round 21): a `ports`/`notPorts` restriction on the ENTITY not used as
    # the destination side (i.e. `source` — ports always describe the connection's destination
    # port regardless of direction, per round 19) is a real, if unusual, Calico field this adapter
    # never reads and never guards; silently ignoring it could let an intended source-port
    # restriction fall through to a confident match/non-match it cannot actually support.
    if source_entity.get("ports") or source_entity.get("notPorts"):
        return None
    # CI-review MAJOR fix (round 22, part a): Calico's `protocol` is a `numorstring` — `protocol:
    # 6` is a valid IANA-number spelling of TCP, but `str(6).upper() != "TCP"` made this comparison
    # confidently (and wrongly) `False` for a rule that actually matches, falling through to a
    # confident `blocked` for traffic a real Allow rule would have allowed. Numeric protocol
    # values are now normalized to their name via `_calico_protocol_name`; an unrecognized
    # representation degrades to unresolvable (`None`) rather than a guessed mismatch.
    rule_protocol_name = _calico_protocol_name(rule.get("protocol"))
    if rule.get("protocol") is not None and rule_protocol_name is None:
        return None
    if rule_protocol_name is not None and protocol is not None and rule_protocol_name != str(protocol).upper():
        return False
    raw_ports = dest.get("ports")
    # CI-review MAJOR fix (round 22, part b): `_normalize_calico_ports` builds `{"port": N}`
    # entries with NO `protocol` key (Calico's native `ports` carries no per-entry protocol at
    # all, unlike core K8s NetworkPolicy) — but `_k8s_port_matches` defaults an absent per-entry
    # protocol to `"TCP"` (that function's own core-K8s-NetworkPolicy contract) and compares it
    # against the CALLER's `protocol` argument. For a `protocol: UDP` rule with a `destination.
    # ports` restriction, every normalized entry was defaulted to "TCP" and rejected against the
    # UDP request, so `_k8s_port_matches` returned a confident `False` even though the rule-level
    # protocol check just above already confirmed the match — reintroducing the exact round-18
    # bug through the port path instead of the no-ports path. The rule-level protocol match is
    # already fully handled above; `_k8s_port_matches` is now called with `protocol=None` so it
    # evaluates port NUMBERS only, never re-litigating a protocol Calico's `ports` entries don't
    # even carry.
    port_match = _k8s_port_matches(
        {"ports": _normalize_calico_ports(raw_ports)} if raw_ports else {}, None, port)
    if port_match is False:
        return False
    selector, ns_selector, nets = peer.get("selector"), peer.get("namespaceSelector"), peer.get("nets")
    if not selector and not ns_selector and not nets:
        return None if port_match is None else True
    if ns_selector:
        if peer_namespace_labels is None:
            return None
        ns_match = _calico_selector_matches(ns_selector, peer_namespace_labels)
        if ns_match is None:
            return None
        if not ns_match:
            return False
    if selector:
        if peer_labels is None:
            return None
        pod_match = _calico_selector_matches(selector, peer_labels)
        if pod_match is None:
            return None
        if not pod_match:
            return False
    if nets:
        if peer_ip is None or not _is_valid_ip(peer_ip):
            return None
        if not any(_cidr_contains(n, peer_ip) for n in nets):
            return False
    if port_match is None:
        return None
    return True


# ── DNS/L7: Route 53 resolution ─────────────────────────────────────────────────────────────────

# Record types whose presence actually indicates address resolution — TXT/MX/etc. prove nothing
# about whether the name resolves to a reachable address (round-18 fix, see eval_route53_resolution).
_R53_ADDRESS_TYPES = {"A", "AAAA", "ALIAS"}


def eval_route53_resolution(records, query_host, data_available=True):
    """Real Route 53 resolution evaluation, given already-fetched hosted-zone record data (this
    module makes no AWS calls itself — see the module docstring; a caller/orchestrator that has read
    `ListResourceRecordSets` and, for ALIAS/failover records, health-check status is expected to
    supply it here).

    `records`: [{"name": str, "type": "A"|"AAAA"|"CNAME"|"ALIAS"|"NS"|"SOA"|..., "alias_target":
    str|None, "health_check_status": "healthy"|"unhealthy"|None, "failover":
    "PRIMARY"|"SECONDARY"|None}]. CI-review MAJOR fix (round 28): `NS` and `SOA` rows are
    LOAD-BEARING inputs for the zone-delegation check below, not optional extras — a feeder that
    filters them out (as `scripts/v2/steampipe/sync_lambda.py`'s current `A`/`AAAA`/`CNAME`-only
    query does) leaves delegation detection permanently inert (no NS rows at all ever reach this
    function). CI-review MAJOR fix (round 29): an NS RRset with no co-located SOA ALWAYS degrades
    that name to `unknown` (never a confident `blocked`), regardless of whether the fetched set
    happens to carry an SOA row elsewhere — an NS row is affirmative evidence resolution
    continues in a child zone, so treating it as a confirmed NXDOMAIN when no SOA is fetched
    anywhere (an earlier revision of this fix did exactly that) is the SAME class of honest-degrade
    violation as confidently resolving it, just in the opposite direction. Whether the fetched set
    contains at least one SOA row only changes which DIAGNOSTIC reason accompanies that `unknown`
    (a confirmed delegation cut vs. "this payload's producer may simply never send SOA at all, so
    a real apex can't be told apart from a cut" — see `_delegation_check_armed`), never the
    verdict itself. A real `ListResourceRecordSets` sweep with no `type` filter always returns the
    zone's own apex NS + SOA, plus any child-zone NS delegation records; a `type IN (...)`
    projection must include both for this check to ever confidently rule OUT a delegation.

    Matching order: FIRST, the delegation check — walking EVERY ancestor of the query name
    (including the name itself) for an NS RRset with no co-located SOA (a real delegation point
    never carries an SOA; only the zone apex does) — occludes exact matches, empty non-terminals,
    and wildcard synthesis alike, degrading to `unknown` before any of them get a chance to
    answer (this paragraph's earlier revisions described delegation as a late qualifier on
    wildcard synthesis only — no longer true since round 27 moved it to run first, over the whole
    ancestor chain). Absent a delegation: exact name match, else the RFC 4592 closest-encloser
    wildcard (see `_find`'s own comment — NOT every ancestor's wildcard independently, only the
    nearest ancestor that actually exists in the zone), else (for a CNAME/ALIAS target)
    chain-following across MULTIPLE hops, bounded by a cycle guard — NOT just one hop (the chain
    has followed multiple hops since round 21's cycle-detection rewrite). Not a full recursive
    resolver — this is read-only zone-data inspection, never an actual DNS query (spec's "no
    active probe" boundary).
    """
    if not data_available:
        return {"layer": "dns", "status": "unknown", "resource": None,
                "summary": "Route 53 record data was not fetched for this hosted zone — cannot "
                           "evaluate (missing data, not a confirmed absence of a record)",
                "evidence": []}
    host = (query_host or "").rstrip(".").lower()
    if not host:
        return {"layer": "dns", "status": "unknown", "resource": None,
                "summary": "no query host supplied; cannot evaluate Route 53 resolution",
                "evidence": []}
    by_name = {}
    for r in records or []:
        by_name.setdefault(str(r.get("name", "")).rstrip(".").lower(), []).append(r)

    # CI-review MAJOR fix (round 20): every ancestor level's wildcard is NOT independently
    # eligible to synthesize an answer — RFC 4592 wildcard synthesis is valid only from the
    # CLOSEST ENCLOSER (the nearest ancestor of the query name that actually exists in the zone,
    # whether as a real owner name or as an "empty non-terminal" — a name with descendants but no
    # RRset of its own). The round-19 fix (checking every ancestor wildcard, nearest first) traded
    # a false `blocked` for a false `allowed`: if `b.example.com` exists in the zone (e.g. because
    # `x.b.example.com` is a real record) but has no `*.b.example.com` wildcard child, a query for
    # `a.b.example.com` is genuinely NXDOMAIN in real DNS — `b.example.com` IS the closest
    # encloser, and its own lack of a wildcard child ends the search; a further-away
    # `*.example.com` wildcard must NOT be allowed to answer instead. `_existing_nodes` derives
    # every ancestor-node of every fetched record name (since any ancestor of a real owner name is
    # itself a real node in the DNS tree, with or without its own RRset) — the closest encloser is
    # the nearest one of those that is a strict ancestor of the query name.
    _existing_nodes = set()
    for k in by_name:
        klabels = k.split(".")
        for i in range(len(klabels)):
            _existing_nodes.add(".".join(klabels[i:]))

    # CI-review MAJOR fix (round 25): a name whose closest encloser owns an NS RRset is under a
    # ZONE DELEGATION — the real answer lives in a child zone this evaluator was never given any
    # data for at all (a hosted-zone fetch only ever returns records for ITS OWN zone). The
    # closest-encloser search below used to return a plain NXDOMAIN (`None`) for this case exactly
    # like a genuine "nothing exists here" miss, reaching a confident `blocked` even though the
    # fetched NS record itself proves resolution continues elsewhere, not that it fails. This
    # mutable flag lets `_find` signal "delegated, not NXDOMAIN" to its caller without changing
    # its own return-value contract (still `None` on a miss either way).
    _delegated = [False]
    _delegation_point = [None]
    # CI-review MAJOR fix (round 28, ITSELF reverted by round 29 — see below): an earlier version
    # of this fix "disarmed" the whole delegation check whenever the fetched set carried zero SOA
    # rows anywhere, on the theory that a future feeder emitting NS with no SOA at all would
    # otherwise misclassify every name in the zone as delegated. That traded one honest-degrade
    # violation for another: disarming made an NS-without-SOA cut fall through to a confident
    # `blocked` (NXDOMAIN) — but an NS row IS affirmative evidence that resolution continues
    # elsewhere, so `blocked` is exactly as wrong here as the round-26 apex misclassification was
    # in the other direction, and the round-25 test this regressed proves it (base: `unknown`;
    # round-28: `blocked`). `_delegation_check_armed` is kept only as a DIAGNOSTIC signal (whether
    # this evaluator can distinguish "real delegation" from "producer never sends SOA at all") —
    # it now only changes the SUMMARY wording below, never the `unknown`-vs-`blocked` status: an
    # NS-without-SOA ancestor is unresolvable either way, so it always degrades to `unknown`.
    _delegation_check_armed = any(str(r.get("type", "")).upper() == "SOA" for r in (records or []))

    def _find(name):
        # CI-review MINOR fix (round 21): the CNAME-chain loop that calls this is bounded by its
        # own `seen_names` cycle guard (a genuine cycle degrades to `unknown` there), not by a
        # depth counter here — this function never recurses into itself, so a `depth` parameter
        # would always be 0 and never actually bound anything. Removed rather than left as
        # dead/misleading code.
        # CI-review MINOR fix (round 29): reset the delegation-signal flags at the top of every
        # call — currently safe either way (every write below is immediately followed by
        # `return None`, and both consumers run right after their own `_find` call, before a
        # later call could overwrite them), but that invariant is now load-bearing across the
        # CNAME-chain loop's multiple `_find` calls; resetting here is free insurance against a
        # future change relying on a stale `True` from an earlier, unrelated `_find` call.
        _delegated[0] = False
        _delegation_point[0] = None
        labels = name.split(".")
        # CI-review MAJOR fix (round 27): the round-25/26 delegation check only ever inspected the
        # CLOSEST EXISTING encloser, and only ran on the NXDOMAIN (closest-encloser-miss) path —
        # leaving the identical occlusion open on two other paths within this same function:
        # (a) an EXACT match below a delegation cut (e.g. stale/glue data — `ns.delegated.example.
        #     com A` alongside `delegated.example.com NS`, no SOA) used to hit the `name in
        #     by_name` return immediately, never reaching any delegation check at all, and reached
        #     a confident `allowed` even though the real answer is occluded in a child zone;
        # (b) a cut ABOVE the closest existing node (e.g. `x.ns.delegated.example.com` whose
        #     closest existing node is `ns.delegated.example.com`, one level below the actual NS
        #     cut at `delegated.example.com`) never inspected anything past that nearest node, so
        #     the delegation one level up was invisible.
        # Both are the "same occlusion, one path over" pattern this series already treats as
        # gate-worthy (rounds 22/24/25) — fixed by walking EVERY strict ancestor of the query name
        # (not just the closest EXISTING one) for an NS-without-SOA cut, checked FIRST, before
        # exact-match, empty-non-terminal, or wildcard handling get a chance to answer. The apex
        # exemption (a real delegation point never carries an SOA; only the zone apex does — round
        # 26) composes correctly here since it's evaluated per-ancestor.
        # CI-review MAJOR fix (round 28): "strict ancestors only" (`range(1, ...)`) still missed
        # the QUERY NAME ITSELF being the delegation cut — a query for `delegated.example.com`
        # where the records include `delegated.example.com NS` (no SOA) plus a same-owner `A` row
        # (occluded parent-zone glue, one label shallower than round 27's own regression tests)
        # hit `name in by_name` immediately below, never reaching this check at all, and reached a
        # confident `allowed`. The walk now starts at `i=0` (the name itself), not `i=1`; the
        # apex exemption still composes correctly since a genuine apex query carries its own SOA.
        # (Round 29: this walk always runs now, regardless of `_delegation_check_armed` — see that
        # variable's own comment above for why gating it off was itself a contract violation.)
        for i in range(0, len(labels)):
            ancestor = ".".join(labels[i:])
            ancestor_types = {str(r.get("type", "")).upper() for r in by_name.get(ancestor, [])}
            if "NS" in ancestor_types and "SOA" not in ancestor_types:
                _delegated[0] = True
                _delegation_point[0] = ancestor
                return None
        if name in by_name:
            return by_name[name]
        # CI-review MAJOR fix (round 21): the query name ITSELF can exist in the zone as an
        # "empty non-terminal" (a name with descendants but no RRset of its own — e.g. `b.example.
        # com` exists because `x.b.example.com` is a real record, even though `b.example.com` has
        # no record). RFC 4592 wildcard synthesis is NEVER permitted for a name that already
        # exists in the zone, RRset or not — real DNS answers NODATA for it, not a wildcard
        # match. The closest-encloser loop below only ever checked STRICT ancestors, so a query
        # for exactly such an existing-but-empty name incorrectly fell through to wildcard
        # synthesis from a farther ancestor.
        if name in _existing_nodes:
            return None
        closest_encloser = None
        for i in range(1, len(labels)):
            candidate = ".".join(labels[i:])
            if candidate in _existing_nodes:
                closest_encloser = candidate
                break
        if closest_encloser is None:
            return None
        wildcard = "*." + closest_encloser
        if wildcard in by_name:
            return by_name[wildcard]
        return None

    # CI-review MINOR fix (round 29): built once, shared by both delegation-report call sites
    # (the entry-name miss below, and the mid-chain-hop branch inside the CNAME loop) so their
    # wording stays consistent. Branches on whether the delegation point IS the queried name
    # itself (round 28's `i=0` case — it doesn't "fall under" a delegation, it IS the cut) vs. an
    # ancestor of it, and on `_delegation_check_armed` (round 29: when disarmed, this evaluator
    # cannot rule out that the NS-without-SOA ancestor is actually an apex whose SOA this payload
    # simply never included — still `unknown` either way, just a different, honest reason why).
    def _delegation_summary(queried_name):
        point = _delegation_point[0]
        subject = f"{queried_name!r} is itself" if point == queried_name else f"{point!r}"
        if _delegation_check_armed:
            reason = f"{subject} an NS RRset with no SOA — a real delegation cut"
        else:
            reason = (f"{subject} an NS RRset with no SOA, and this payload contains no SOA row "
                      "at all — cannot distinguish a real delegation cut from a zone apex whose "
                      "own SOA this payload simply never included")
        return (f"Route 53 resolution for {queried_name!r} cannot be confidently determined: "
                f"{reason}; the real answer may live in a child zone this evaluator has no data "
                "for, not a confirmed NXDOMAIN")

    matched = _find(host)
    if matched is None:
        if _delegated[0]:
            return {"layer": "dns", "status": "unknown", "resource": None,
                    "summary": _delegation_summary(host), "evidence": []}
        return {"layer": "dns", "status": "blocked", "resource": None,
                "summary": f"no Route 53 record resolves {host!r} (NXDOMAIN against known zone data)",
                "evidence": []}
    # CI-review MAJOR fix (round 23): the chain-following loop below only ever ran when EXACTLY
    # ONE record matched — a weighted/failover/latency SET of >=2 CNAME/ALIAS records at the same
    # name (a real, supported Route 53 routing-policy shape) skipped chain-following entirely, and
    # since `ALIAS` is in `_R53_ADDRESS_TYPES`, those records were then treated as terminally
    # address-resolving on their own even though every one of them is still just a pointer whose
    # OWN target was never checked — the same "trust a pointer without following it" class the
    # round-18/22 fixes closed for the single-record case, left open here. This module has no
    # routing-policy model (which record in the set would actually answer a given query), so a
    # multi-record set where EVERY record is an unresolved CNAME/ALIAS pointer degrades to
    # `unknown` rather than guessing any one of them is the answer.
    # CI-review MAJOR fix (round 24): the round-23 guard only fired when EVERY record in the set
    # was a well-formed pointer (`alias_target` truthy) — a MIXED set (one CNAME/ALIAS record
    # missing its own `alias_target`, plus other, unrelated records) bypassed it entirely, since
    # `all(...)` is vacuously satisfied by neither-CNAME-nor-truthy-target entries failing the
    # predicate. The multi-record ambiguity (which record answers) is real whenever ANY matched
    # record is a CNAME/ALIAS pointer at all — well-formed or not — so the guard now fires on
    # `any(...)` instead of `all(...)`.
    def _multi_pointer_ambiguous(rows):
        # CI-review MINOR fix (round 26): this comparison read `type` raw, while the NS-delegation
        # check already normalized with `str(...).upper()` — a lowercase `"alias"`/`"cname"`
        # (Route 53 itself always returns uppercase, but this evaluator's own contract doesn't
        # require it) would silently bypass this guard. The chain-loop condition below had the
        # SAME gap and is normalized in this same round-26 pass, for consistency.
        return len(rows) > 1 and any(str(r.get("type", "")).upper() in ("CNAME", "ALIAS") for r in rows)

    if _multi_pointer_ambiguous(matched):
        return {"layer": "dns", "status": "unknown", "resource": host,
                "summary": f"Route 53 has multiple records for {host!r} including a CNAME/ALIAS "
                           "pointer (a weighted/failover/latency routing-policy set) — which one "
                           "answers a given query, and whether the pointer's own target resolves, "
                           "is not determinable from zone data without routing-policy modeling",
                "evidence": matched}
    # A CNAME (or ALIAS — see round-22 fix below) with no further usable data at its target is
    # followed one hop, still within the already-fetched `records` set (no live DNS query is
    # ever issued).
    seen_names = {host}
    cycle_detected = False
    out_of_zone_target = None
    # CI-review MAJOR fix (round 22): only `type == "CNAME"` was ever chain-followed — an ALIAS
    # record (Route 53's own AWS-target construct, e.g. pointing at an ALB/CloudFront/another
    # record in the SAME zone) was treated as terminally address-resolving on its own, because
    # `_R53_ADDRESS_TYPES` includes `"ALIAS"`. But an ALIAS record carries no address data of its
    # own — it is exactly as much a pointer as a CNAME — so a dangling or in-zone-chained ALIAS
    # (its `alias_target` never actually checked) reported a confident `allowed` the same way the
    # round-18 fix closed for CNAME. ALIAS is now followed identically to CNAME.
    while (len(matched) == 1 and str(matched[0].get("type", "")).upper() in ("CNAME", "ALIAS")
           and matched[0].get("alias_target")):
        target = str(matched[0]["alias_target"]).rstrip(".").lower()
        if target in seen_names:
            # MINOR fix: a genuine CNAME cycle (target already seen in this chain) must not fall
            # through to the healthy/unhealthy check below using the stale `matched` record — that
            # would misreport a broken zone as a confident `allowed`. An out-of-zone CNAME target
            # that ISN'T a cycle (the `nxt is None` branch below) stays a separate, correctly
            # `allowed`-eligible case.
            cycle_detected = True
            break
        seen_names.add(target)
        nxt = _find(target)
        if nxt is None:
            # CI-review MINOR fix (round 28): `_find` can return `None` here for TWO distinct
            # reasons — a genuine out-of-zone target, or the target itself falling under a zone
            # delegation (`_delegated[0]` set as a side effect of this same `_find` call). The old
            # code always reported the generic "not in the fetched zone data" message even when
            # the zone data DOES explain why (an NS-without-SOA cut) — `unknown` was still the
            # right status either way, but the diagnostic was misleading.
            if _delegated[0]:
                return {"layer": "dns", "status": "unknown", "resource": host,
                        "summary": f"Route 53 CNAME chain for {host!r} terminates at {target!r}: "
                                   f"{_delegation_summary(target)}", "evidence": matched}
            # CI-review MAJOR fix (round 18): an out-of-zone CNAME target used to fall through to
            # the healthy/unhealthy check below using the STALE CNAME record itself (which carries
            # no health-check/address data of its own) — reporting a confident `allowed` for a
            # target this evaluator has no zone data on at all. The target's own resolvability is
            # genuinely unknown from this zone's data (it could resolve fine in another zone, or be
            # NXDOMAIN) — this must degrade to `unknown`, not `allowed`.
            out_of_zone_target = target
            break
        matched = nxt
    # CI-review MAJOR fix (round 25): the multi-pointer ambiguity guard above only ever ran on
    # the ENTRY name, before this loop starts — the loop's own `len(matched) == 1` condition
    # naturally exits (silently) the moment a chain hop's `_find(target)` lands on a multi-record
    # set, so a CNAME hop landing on a weighted/failover SET of >=2 ALIAS records (ALIAS being an
    # address type) reached the health-check block below with none of those pointers' own targets
    # ever checked — the identical failure the guard above exists to close, reintroduced one hop
    # deep. Re-run the SAME check on whatever `matched` this loop actually terminated with.
    if _multi_pointer_ambiguous(matched):
        return {"layer": "dns", "status": "unknown", "resource": host,
                "summary": f"Route 53 CNAME/ALIAS chain for {host!r} terminates at multiple "
                           "records including a CNAME/ALIAS pointer (a weighted/failover/latency "
                           "routing-policy set) — which one answers, and whether its own target "
                           "resolves, is not determinable from zone data alone",
                "evidence": matched}
    if cycle_detected:
        return {"layer": "dns", "status": "unknown", "resource": host,
                "summary": f"Route 53 CNAME chain for {host!r} forms a cycle — cannot confidently "
                           "resolve this record", "evidence": matched}
    if out_of_zone_target is not None:
        return {"layer": "dns", "status": "unknown", "resource": host,
                "summary": f"Route 53 CNAME chain for {host!r} terminates at {out_of_zone_target!r}, "
                           "which is not in the fetched zone data — its own resolvability cannot be "
                           "confirmed from this zone alone", "evidence": matched}
    # CI-review MAJOR fix (round 24): the chain-following loop's own condition requires
    # `alias_target` to be TRUTHY to enter — but the declared record shape permits
    # `alias_target: None` (or an absent key). A single matched CNAME/ALIAS record with no target
    # data at all never enters the loop, falls through with `matched` unchanged, passes the
    # `_R53_ADDRESS_TYPES` check below (ALIAS is an address type), and would otherwise reach a
    # confident `allowed` — the exact "trust a pointer without confirming its target" class the
    # round-18/22/23 fixes closed for every OTHER shape of this problem, left open for this one.
    if (len(matched) == 1 and str(matched[0].get("type", "")).upper() in ("CNAME", "ALIAS")
            and not matched[0].get("alias_target")):
        return {"layer": "dns", "status": "unknown", "resource": host,
                "summary": f"Route 53 record for {host!r} is a CNAME/ALIAS with no target data "
                           "at all — its own resolvability cannot be confirmed", "evidence": matched}

    # CI-review MAJOR fix (round 18): a matched record whose TYPE doesn't actually indicate address
    # resolution (e.g. TXT, MX) used to still report a confident `allowed` — the presence of ANY
    # record at this name proves nothing about whether it resolves to a reachable address.
    non_address = [r for r in matched if str(r.get("type", "")).upper() not in _R53_ADDRESS_TYPES]
    if non_address and len(non_address) == len(matched):
        return {"layer": "dns", "status": "unknown", "resource": host,
                "summary": f"Route 53 record(s) for {host!r} are type "
                           f"{sorted({str(r.get('type')) for r in matched})} — not an address-"
                           "resolving type (A/AAAA/ALIAS), so this proves nothing about actual "
                           "resolution", "evidence": matched}

    unhealthy = [r for r in matched if r.get("health_check_status") == "unhealthy"]
    healthy_or_unchecked = [r for r in matched if r.get("health_check_status") != "unhealthy"]
    if unhealthy and not healthy_or_unchecked:
        # CI-review MAJOR fix (round 21): Route 53's DOCUMENTED behavior when every record in a
        # set fails its health check is FAIL-OPEN — it answers as if all records were healthy,
        # not NXDOMAIN/refuse. A confident `blocked` here contradicts that real behavior (a false
        # verdict, not an honest degrade) — this module also has no routing-policy modeling
        # (`failover`/weighted/latency records are accepted in the record shape but never
        # consulted), so whether the real answer would actually route away entirely depends on a
        # policy this adapter cannot evaluate. Degrades to `unknown` instead of a confident
        # `blocked`.
        return {"layer": "dns", "status": "unknown", "resource": host,
                "summary": f"Route 53 record(s) for {host!r} all report an unhealthy health check "
                           "— Route 53's documented behavior in this case is to fail OPEN (answer "
                           "as if healthy) rather than NXDOMAIN, and this module does not model "
                           "routing policy (failover/weighted/latency), so the real outcome cannot "
                           "be confidently determined from health-check status alone",
                "evidence": matched}
    if unhealthy and healthy_or_unchecked:
        return {"layer": "dns", "status": "conditional", "resource": host,
                "summary": (
                    f"Route 53 has both healthy and unhealthy record(s) for {host!r} (e.g. a "
                    "failover/weighted set) — which one actually answers a given query is not "
                    "resolved from zone data alone"),
                "evidence": matched}
    return {"layer": "dns", "status": "allowed", "resource": host,
            "summary": f"Route 53 resolves {host!r}", "evidence": matched}


# ── DNS/L7: Kubernetes Ingress -> Service -> EndpointSlice resolution ───────────────────────────

def eval_k8s_service_resolution(ingress_rules, services, endpoint_slices, request, data_available=True):
    """Real Ingress -> Service -> EndpointSlice resolution, given already-fetched K8s objects — this
    module never calls the Kubernetes API itself (no code path in this worker holds a live K8s
    client at all; see network_path.py's own docstring/report for why this layer stays unreachable
    in practice until a live K8s read path is added upstream of this pure function). Implemented for
    real now so that wiring is a data-plumbing change only, not a logic change, once such a read path
    exists.

    `ingress_rules`: [{"host": str|None, "path": str|None, "path_type": "Exact"|"Prefix"|"ImplementationSpecific",
    "backend_service": str, "backend_port": int|str|None}] (`backend_port` is the Ingress
    `backend.service.port.number` or `.name` — a real Ingress object always carries exactly one of
    those two, `int` or `str` respectively; `None` means the Ingress object omitted the port,
    which K8s only accepts when the Service declares exactly one port).
    `services`: {service_name: {"selector": {...}, "ports": [{"port": int, "name": str|None}]}}
    (`ports` are the Service's OWN declared ports — what the Ingress backend's port reference is
    validated against, not the pod's `target_port`).
    `endpoint_slices`: {service_name: [{"ready": bool}, ...]} (one entry per endpoint).
    `request`: {"host": str|None, "path": str|None, "port": int|None}.

    CI-review MAJOR fix (round 17, item 4): this used to report a confident `allowed` whenever ANY
    endpoint was ready, without ever checking that the Ingress backend's referenced port actually
    exists on the Service's own `ports` list — a real, common misconfiguration (an Ingress
    pointing at a port name/number the Service never declared) would silently report `allowed`.
    """
    if not data_available:
        return {"layer": "k8s-service-resolution", "status": "unknown", "resource": None,
                "summary": "Ingress/Service/EndpointSlice data was not fetched — cannot evaluate",
                "evidence": []}
    # CI-review MAJOR fix (round 24): `req_host` used to be compared raw against `rule_host` —
    # DNS hostnames are case-insensitive and a trailing dot is a valid FQDN form, so `API.EXAMPLE.
    # COM` or `api.example.com.` used to confidently fail to match `api.example.com` (including
    # its wildcard form), producing a confident false `blocked`. Normalized the same way
    # `eval_route53_resolution` already normalizes its own query host.
    _req_host_raw = request.get("host")
    req_host = _req_host_raw.rstrip(".").lower() if _req_host_raw else None
    req_path = request.get("path") or "/"

    # CI-review MAJOR fix (round 18): rule selection used to be plain first-match over the input
    # list — Kubernetes Ingress precedence is neither insertion order nor host-agnostic: an exact
    # host beats a wildcard host beats no host at all; among matching rules, `Exact` path beats
    # `Prefix` beats `ImplementationSpecific`, and among `Prefix` matches the LONGEST path wins.
    # Overlapping rules routing to different Services under first-match could silently select the
    # wrong backend and report a confident wrong `allowed`/`blocked`. Wildcard hosts (`*.example.
    # com`) were also never matched at all (only bare equality), producing a confident false
    # `blocked` for a real wildcard-routed request.
    def _host_match(rule_host):
        """Returns `(matches, specificity)` — higher specificity wins on a tie-break — or `None`
        when this rule's host requirement genuinely cannot be evaluated (a host-scoped rule but
        no request host at all). `None` `rule_host` (no host on the rule) is least specific; an
        exact match is most specific; `*.parent` is in between (an exact, documented wildcard
        semantic — not a guess).

        CI-review MAJOR fix (round 19): a Kubernetes Ingress wildcard host covers exactly ONE DNS
        label — `*.example.com` matches `api.example.com` but NOT `a.b.example.com`. The pre-fix
        check (`req_host.endswith(parent)`) matched a suffix of ANY depth, so a multi-label
        subdomain would confidently select a wildcard-routed backend the real Ingress controller
        would never route to. The label the wildcard covers is now required to be non-empty and
        contain no further `.` (i.e. exactly one label between the request host and `parent`).

        CI-review MAJOR fix (round 24): a `None` request host used to silently fail every
        host-scoped rule as a confident non-match, so a request with no host at all could reach a
        confident `blocked` from evidence ("no host supplied") that actually proves nothing —
        this degrades to unresolvable (`None`) instead whenever the RULE is host-scoped and the
        request supplies none."""
        if rule_host is None:
            return True, 0
        if req_host is None:
            return None
        rule_host_norm = str(rule_host).rstrip(".").lower()
        if rule_host_norm == req_host:
            return True, 2
        if rule_host_norm.startswith("*."):
            parent = rule_host_norm[1:]  # ".example.com"
            if req_host.endswith(parent):
                label = req_host[: -len(parent)]
                if label and "." not in label:
                    return True, 1
        return False, -1

    def _path_match(rule):
        """Returns (matches, rank, path_len), or `None` when this rule's path semantics genuinely
        cannot be confidently determined — an `ImplementationSpecific` path_type with an actual
        path filter is controller-defined behavior this adapter does not guess at (round-18 fix;
        it used to be silently treated as a Prefix match)."""
        rp = rule.get("path")
        if not rp:
            return True, 0, 0  # no path filter on this rule — least specific, always matches
        pt = rule.get("path_type", "ImplementationSpecific")
        if pt == "Exact":
            return req_path == rp, 2, len(rp)
        if pt == "Prefix":
            matches = req_path == rp.rstrip("/") or req_path.startswith(rp if rp.endswith("/") else rp + "/")
            return matches, 1, len(rp)
        return None

    candidates = []
    saw_unresolvable_path = False
    saw_unresolvable_host = False
    for r in (ingress_rules or []):
        host_result = _host_match(r.get("host"))
        if host_result is None:
            saw_unresolvable_host = True
            continue
        host_ok, host_rank = host_result
        if not host_ok:
            continue
        path_result = _path_match(r)
        if path_result is None:
            saw_unresolvable_path = True
            continue
        path_ok, path_rank, path_len = path_result
        if not path_ok:
            continue
        candidates.append((host_rank, path_rank, path_len, r))

    # CI-review MAJOR fix (round 20): this used to consult `saw_unresolvable_path` only inside
    # `if not candidates:` — but an ImplementationSpecific-with-path rule whose HOST matches is
    # controller-defined behavior (e.g. an nginx regex path) that could take precedence over
    # whatever Exact/Prefix/no-path rule this adapter DID confidently select, regardless of
    # whether any such rule exists. Silently discarding it and returning a confident verdict for
    # the selected candidate contradicted this function's own "degrades to unknown rather than
    # being guessed" contract; it now degrades to `unknown` whenever ANY host-matching rule's
    # path semantics are unresolvable, independent of whether other rules also matched.
    if saw_unresolvable_path:
        return {"layer": "k8s-service-resolution", "status": "unknown", "resource": None,
                "summary": f"an Ingress rule for host={req_host!r} uses an "
                           "ImplementationSpecific path_type this adapter cannot confidently "
                           "evaluate — its controller-defined precedence relative to any other "
                           "matching rule cannot be determined", "evidence": []}
    # CI-review MAJOR fix (round 24): mirrors the `saw_unresolvable_path` guard above, for the
    # symmetric host case — at least one host-SCOPED rule exists but the request supplies no host
    # at all, so this adapter cannot rule out that the (unknown) real request host would have
    # matched that rule instead of whatever no-host/catch-all rule this evaluator DID confidently
    # select. Degrades unconditionally, the same way a controller-defined path ambiguity does.
    if saw_unresolvable_host:
        return {"layer": "k8s-service-resolution", "status": "unknown", "resource": None,
                "summary": "at least one Ingress rule is host-scoped, but the request supplies "
                           "no host at all — cannot confidently rule out that rule taking "
                           "precedence over whatever host-agnostic rule this adapter selected",
                "evidence": []}
    if not candidates:
        return {"layer": "k8s-service-resolution", "status": "blocked", "resource": None,
                "summary": f"no Ingress rule matches host={req_host!r} path={req_path!r}",
                "evidence": []}

    best = max(c[:3] for c in candidates)
    tied = [c[3] for c in candidates if c[:3] == best]
    # CI-review MAJOR fix (round 22): this used to dedupe by `backend_service` alone — two
    # equally-specific rules routing to the SAME Service but DIFFERENT `backend_port`s collapsed
    # to one "backend," `tied[0]` was picked by input order, and this function's own port
    # validation then ran against an arbitrary one of the two ports — an order-dependent
    # confident verdict, the same "ambiguous precedence must degrade" contract this same tie-break
    # already enforces across different Services. Backends are now compared as
    # (backend_service, backend_port) pairs so a port-level tie is caught too.
    distinct_backends = {(t.get("backend_service"), t.get("backend_port")) for t in tied}
    if len(distinct_backends) > 1:
        return {"layer": "k8s-service-resolution", "status": "unknown", "resource": None,
                "summary": f"multiple equally-specific Ingress rules for host={req_host!r} "
                           f"path={req_path!r} route to different Service/port combinations "
                           f"{sorted(str(b) for b in distinct_backends)} — precedence between "
                           "them is ambiguous",
                "evidence": tied}
    matched_rule = tied[0]
    svc_name = matched_rule.get("backend_service")
    svc = (services or {}).get(svc_name)
    if svc is None:
        return {"layer": "k8s-service-resolution", "status": "blocked", "resource": svc_name,
                "summary": f"Ingress backend Service {svc_name!r} does not exist", "evidence": []}
    # CI-review MAJOR fix (round 17, item 4): `backend_port` (and the Service's own declared
    # ports) were never checked at all — an Ingress rule referencing a Service port the Service
    # doesn't actually declare returned a confident `allowed` whenever any endpoint happened to be
    # ready. A real Ingress backend port reference is EITHER a number (`service.port.number`,
    # matched against a Service port's own `port` field) OR a name (`service.port.name`, matched
    # against a Service port's own `name` field) — never both at once, so both are checked here.
    backend_port = matched_rule.get("backend_port")
    svc_ports = [p for p in (svc.get("ports") or []) if isinstance(p, dict)]
    if backend_port is None:
        # CI-review MAJOR fix (round 20): this function's OWN docstring states real K8s only
        # accepts an omitted `backend_port` when the Service declares EXACTLY ONE port — but the
        # code let a `None` backend_port through unconditionally, with no check against
        # `svc_ports`'s actual length. An incomplete/malformed backend reference (or stale fixture
        # data not actually admission-validated) against a multi-port Service used to report a
        # confident `allowed` without ever proving which port the Ingress targets. A `None`
        # backend_port against anything other than exactly one declared Service port now degrades
        # to `unknown` instead.
        if len(svc_ports) != 1:
            return {"layer": "k8s-service-resolution", "status": "unknown", "resource": svc_name,
                    "summary": f"Ingress backend for Service {svc_name!r} omits a port reference, "
                               f"but the Service declares {len(svc_ports)} ports (not exactly "
                               "one) — cannot confirm which port this backend targets",
                    "evidence": svc_ports}
    elif isinstance(backend_port, str):
        if not any(p.get("name") == backend_port for p in svc_ports):
            return {"layer": "k8s-service-resolution", "status": "blocked", "resource": svc_name,
                    "summary": f"Ingress backend references port name {backend_port!r}, which "
                               f"Service {svc_name!r} does not declare "
                               f"(declared names: {sorted(p.get('name') for p in svc_ports if p.get('name'))})",
                    "evidence": svc_ports}
    else:
        if not any(p.get("port") == backend_port for p in svc_ports):
            return {"layer": "k8s-service-resolution", "status": "blocked", "resource": svc_name,
                    "summary": f"Ingress backend references port {backend_port!r}, which Service "
                               f"{svc_name!r} does not declare "
                               f"(declared ports: {sorted(p.get('port') for p in svc_ports if p.get('port') is not None)})",
                    "evidence": svc_ports}
    eps = (endpoint_slices or {}).get(svc_name, [])
    # MINOR fix: an EndpointSlice endpoint's `ready` condition being `null`/absent means "unknown,
    # treat as ready" per Kubernetes' own EndpointConditions guidance (only an explicit `false`
    # means genuinely not ready) — treating a missing/null `ready` the same as `False` (the pre-fix
    # behavior) undercounted ready endpoints and could report a confident `blocked`/`conditional`
    # for a Service that real kube-proxy/Ingress would still route to.
    ready = [e for e in eps if e.get("ready") is not False]
    if not eps:
        return {"layer": "k8s-service-resolution", "status": "blocked", "resource": svc_name,
                "summary": f"Service {svc_name!r} has no EndpointSlice entries (no pods matched its selector)",
                "evidence": []}
    if not ready:
        return {"layer": "k8s-service-resolution", "status": "blocked", "resource": svc_name,
                "summary": f"Service {svc_name!r} has {len(eps)} endpoint(s), none ready", "evidence": []}
    if len(ready) < len(eps):
        return {"layer": "k8s-service-resolution", "status": "conditional", "resource": svc_name,
                "summary": f"Service {svc_name!r}: {len(ready)}/{len(eps)} endpoints ready",
                "evidence": eps}
    return {"layer": "k8s-service-resolution", "status": "allowed", "resource": svc_name,
            "summary": f"Ingress resolves to Service {svc_name!r} with {len(ready)} ready endpoint(s)",
            "evidence": eps}
