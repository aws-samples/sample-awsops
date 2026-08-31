"""Table-driven tests for network_path_adapters.py's pure evaluators."""
import network_path_adapters as ad


# ── Security Groups ──────────────────────────────────────────────────────────────────────────────

class TestSecurityGroup:
    def test_matches_cidr_rule(self):
        rules = [{"sg_id": "sg-1", "protocol": "tcp", "from_port": 443, "to_port": 443, "cidr": "10.0.0.0/8"}]
        r = ad.eval_security_group(rules, "tcp", 443, peer_ip="10.1.2.3")
        assert r["status"] == "allowed"

    def test_no_match_is_blocked(self):
        rules = [{"sg_id": "sg-1", "protocol": "tcp", "from_port": 443, "to_port": 443, "cidr": "10.0.0.0/8"}]
        r = ad.eval_security_group(rules, "tcp", 22, peer_ip="10.1.2.3")
        assert r["status"] == "blocked"

    def test_protocol_number_and_name_are_equivalent(self):
        rules = [{"sg_id": "sg-1", "protocol": "6", "from_port": 80, "to_port": 80, "cidr": "0.0.0.0/0"}]
        r = ad.eval_security_group(rules, "tcp", 80, peer_ip="1.2.3.4")
        assert r["status"] == "allowed"

    def test_all_protocols_wildcard(self):
        rules = [{"sg_id": "sg-1", "protocol": "-1", "cidr": "0.0.0.0/0"}]
        r = ad.eval_security_group(rules, "udp", 53, peer_ip="8.8.8.8")
        assert r["status"] == "allowed"

    def test_port_range(self):
        rules = [{"sg_id": "sg-1", "protocol": "tcp", "from_port": 1024, "to_port": 65535, "cidr": "0.0.0.0/0"}]
        assert ad.eval_security_group(rules, "tcp", 50000, peer_ip="1.1.1.1")["status"] == "allowed"
        assert ad.eval_security_group(rules, "tcp", 80, peer_ip="1.1.1.1")["status"] == "blocked"

    def test_referenced_security_group_match(self):
        rules = [{"sg_id": "sg-1", "protocol": "tcp", "from_port": 5432, "to_port": 5432,
                  "referenced_group_id": "sg-db"}]
        r = ad.eval_security_group(rules, "tcp", 5432, peer_sg_ids=["sg-db"])
        assert r["status"] == "allowed"

    def test_missing_peer_identity_is_unknown_not_blocked(self):
        # MAJOR fix: missing/unparseable peer identity must never invent a confident `blocked`.
        rules = [{"sg_id": "sg-1", "protocol": "tcp", "from_port": 443, "to_port": 443, "cidr": "0.0.0.0/0"}]
        r = ad.eval_security_group(rules, "tcp", 443, peer_ip=None, peer_sg_ids=None)
        assert r["status"] == "unknown"

    # ── item 9: partial peer identity (known SG but no IP, or vice versa) must never yield a
    #    confident `blocked` when a CIDR/SG-reference rule couldn't be evaluated ────────────────

    def test_known_peer_sg_but_missing_peer_ip_leaves_cidr_rule_unknown(self):
        rules = [{"sg_id": "sg-1", "protocol": "tcp", "from_port": 443, "to_port": 443, "cidr": "0.0.0.0/0"}]
        r = ad.eval_security_group(rules, "tcp", 443, peer_ip=None, peer_sg_ids=["sg-peer"])
        assert r["status"] == "unknown"

    def test_known_peer_ip_but_missing_peer_sg_ids_leaves_sg_reference_rule_unknown(self):
        rules = [{"sg_id": "sg-1", "protocol": "tcp", "from_port": 5432, "to_port": 5432,
                  "referenced_group_id": "sg-db"}]
        r = ad.eval_security_group(rules, "tcp", 5432, peer_ip="10.1.2.3", peer_sg_ids=None)
        assert r["status"] == "unknown"

    def test_partial_data_still_confidently_allowed_when_a_different_rule_matches(self):
        # The CIDR rule is unevaluable (no peer_ip), but a separate SG-reference rule DOES
        # confidently match via peer_sg_ids — the confident match must win over `unknown`.
        rules = [
            {"sg_id": "sg-1", "protocol": "tcp", "from_port": 443, "to_port": 443, "cidr": "0.0.0.0/0"},
            {"sg_id": "sg-2", "protocol": "tcp", "from_port": 443, "to_port": 443,
             "referenced_group_id": "sg-db"},
        ]
        r = ad.eval_security_group(rules, "tcp", 443, peer_ip=None, peer_sg_ids=["sg-db"])
        assert r["status"] == "allowed"
        assert r["resource"] == "sg-2"

    # ── MINOR fix: `peer_sg_ids=[]` (resolved successfully, peer legitimately has zero SGs) must
    #    be a confident non-match, never conflated with `peer_sg_ids=None` (resolution failed). ────

    def test_resolved_empty_peer_sg_ids_is_a_confident_no_match_not_unknown(self):
        rules = [{"sg_id": "sg-1", "protocol": "tcp", "from_port": 5432, "to_port": 5432,
                  "referenced_group_id": "sg-db"}]
        r = ad.eval_security_group(rules, "tcp", 5432, peer_ip="10.1.2.3", peer_sg_ids=[])
        # peer_sg_ids was successfully resolved to "no SGs" — the SG-reference rule confidently
        # does not match (never `unknown`, unlike the peer_sg_ids=None case tested above).
        assert r["status"] == "blocked"

    def test_none_peer_sg_ids_stays_unknown_distinctly_from_the_empty_list_case(self):
        rules = [{"sg_id": "sg-1", "protocol": "tcp", "from_port": 5432, "to_port": 5432,
                  "referenced_group_id": "sg-db"}]
        r = ad.eval_security_group(rules, "tcp", 5432, peer_ip="10.1.2.3", peer_sg_ids=None)
        assert r["status"] == "unknown"

    def test_multi_sg_union(self):
        # Second SG's rule is the one that actually allows — union across all attached SGs.
        rules = [
            {"sg_id": "sg-1", "protocol": "tcp", "from_port": 22, "to_port": 22, "cidr": "10.0.0.0/8"},
            {"sg_id": "sg-2", "protocol": "tcp", "from_port": 443, "to_port": 443, "cidr": "0.0.0.0/0"},
        ]
        r = ad.eval_security_group(rules, "tcp", 443, peer_ip="203.0.113.5")
        assert r["status"] == "allowed"
        assert r["resource"] == "sg-2"

    # ── MINOR fix: a PRESENT-BUT-MALFORMED peer_ip (a failed identity parse, not a missing value)
    #    must be treated the same as peer_ip=None — never silently fall through to `_cidr_contains`
    #    as an ordinary non-match and yield a confident `blocked`. ─────────────────────────────────

    def test_malformed_peer_ip_is_unknown_not_a_confident_blocked(self):
        rules = [{"sg_id": "sg-1", "protocol": "tcp", "from_port": 443, "to_port": 443, "cidr": "0.0.0.0/0"}]
        r = ad.eval_security_group(rules, "tcp", 443, peer_ip="not-an-ip", peer_sg_ids=None)
        assert r["status"] == "unknown"

    def test_malformed_peer_ip_with_confident_sg_reference_match_still_allows(self):
        rules = [{"sg_id": "sg-1", "protocol": "tcp", "from_port": 5432, "to_port": 5432,
                  "referenced_group_id": "sg-db"}]
        r = ad.eval_security_group(rules, "tcp", 5432, peer_ip="999.999.999.999", peer_sg_ids=["sg-db"])
        assert r["status"] == "allowed"


# ── NACL ──────────────────────────────────────────────────────────────────────────────────────────

class TestNacl:
    def test_forward_deny_first_match(self):
        fwd = [{"rule_number": 100, "protocol": "tcp", "from_port": 443, "to_port": 443, "action": "deny"},
               {"rule_number": 200, "protocol": "-1", "action": "allow"}]
        r = ad.eval_nacl(fwd, [], "tcp", 443)
        assert r["status"] == "blocked"

    def test_forward_allow_first_match_lower_rule_number_wins(self):
        fwd = [{"rule_number": 100, "protocol": "-1", "action": "allow"},
               {"rule_number": 200, "protocol": "tcp", "from_port": 443, "to_port": 443, "action": "deny"}]
        # Return rule is scoped to just the probed ephemeral port (not the full range) so this test
        # stays focused on forward first-match-wins, independent of the unrestricted-return case.
        ret = [{"rule_number": 100, "protocol": "tcp", "from_port": ad.EPHEMERAL_PROBE_PORT,
                 "to_port": ad.EPHEMERAL_PROBE_PORT, "action": "allow"}]
        r = ad.eval_nacl(fwd, ret, "tcp", 443)
        # Forward allowed at rule 100 (evaluated before rule 200); return also allowed but scoped ->
        # conditional (ephemeral probe only), not a flat allow.
        assert r["status"] == "conditional"

    def test_implicit_deny_default(self):
        fwd = [{"rule_number": 32767, "action": "deny"}]
        r = ad.eval_nacl(fwd, [], "tcp", 443)
        assert r["status"] == "blocked"

    def test_return_denied_blocks_even_when_forward_allowed(self):
        fwd = [{"rule_number": 100, "protocol": "-1", "action": "allow"}]
        ret = [{"rule_number": 100, "protocol": "tcp",
                 "from_port": 0, "to_port": ad.EPHEMERAL_PROBE_PORT - 1, "action": "allow"},
                {"rule_number": 32767, "action": "deny"}]
        r = ad.eval_nacl(fwd, ret, "tcp", 443)
        assert r["status"] == "blocked"

    def test_scoped_return_range_stays_conditional_not_allowed(self):
        # 2026-08-19 review fix: a return rule scoped to a NARROW range (here: exactly the probed
        # ephemeral port, not the full ephemeral space) never generalizes to a flat allow.
        fwd = [{"rule_number": 100, "protocol": "-1", "action": "allow"}]
        ret = [{"rule_number": 100, "protocol": "tcp", "from_port": ad.EPHEMERAL_PROBE_PORT,
                 "to_port": ad.EPHEMERAL_PROBE_PORT, "action": "allow"}]
        r = ad.eval_nacl(fwd, ret, "tcp", 443)
        assert r["status"] == "conditional"

    def test_genuinely_unrestricted_return_range_is_allowed(self):
        # 2026-08-19 review fix, PART 2 (this PR): when the return rule set is genuinely,
        # unambiguously unrestricted (protocol -1 / wildcard, no port scoping at all — covering the
        # FULL ephemeral range, not just the one probed port), the scoped-verdict caveat does not
        # apply and candidate-level `allowed` must be reachable.
        fwd = [{"rule_number": 100, "protocol": "-1", "action": "allow"}]
        ret = [{"rule_number": 100, "protocol": "-1", "action": "allow"}]
        r = ad.eval_nacl(fwd, ret, "tcp", 443)
        assert r["status"] == "allowed"

    def test_unrestricted_wide_port_range_return_is_allowed(self):
        fwd = [{"rule_number": 100, "protocol": "-1", "action": "allow"}]
        ret = [{"rule_number": 100, "protocol": "tcp", "from_port": 0, "to_port": 65535, "action": "allow"}]
        r = ad.eval_nacl(fwd, ret, "tcp", 443)
        assert r["status"] == "allowed"

    # ── CIDR scoping (MAJOR fix: _first_match ignored CIDR scope entirely) ─────────────────────

    def test_allow_rule_scoped_to_unrelated_cidr_does_not_match(self):
        fwd = [{"rule_number": 100, "protocol": "-1", "cidr": "192.168.0.0/16", "action": "allow"},
               {"rule_number": 32767, "action": "deny"}]
        r = ad.eval_nacl(fwd, [], "tcp", 443, peer_ip="10.1.2.3")
        # The only allow rule is scoped to an unrelated CIDR — the peer doesn't match it, so the
        # implicit deny is what actually applies. Must NOT be a false "not blocked".
        assert r["status"] == "blocked"

    def test_allow_rule_scoped_to_matching_cidr_does_match(self):
        fwd = [{"rule_number": 100, "protocol": "-1", "cidr": "10.0.0.0/8", "action": "allow"}]
        ret = [{"rule_number": 100, "protocol": "-1", "action": "allow"}]
        r = ad.eval_nacl(fwd, ret, "tcp", 443, peer_ip="10.1.2.3")
        assert r["status"] == "allowed"

    def test_deny_rule_scoped_to_unrelated_cidr_does_not_block(self):
        fwd = [{"rule_number": 50, "protocol": "-1", "cidr": "192.168.0.0/16", "action": "deny"},
               {"rule_number": 100, "protocol": "-1", "action": "allow"}]
        ret = [{"rule_number": 100, "protocol": "-1", "action": "allow"}]
        r = ad.eval_nacl(fwd, ret, "tcp", 443, peer_ip="10.1.2.3")
        # A narrow deny scoped to an unrelated CIDR must not falsely block a peer it doesn't cover —
        # the peer falls through to the broader allow rule at 100.
        assert r["status"] == "allowed"

    # ── L4 finding #10: deny-side asymmetry — a probe-scoped return DENY must not generalize ──────

    def test_return_deny_scoped_to_probed_port_only_is_conditional_not_blocked(self):
        """A return-path deny that matches ONLY because it covers the single probed ephemeral port
        (49152) must NOT generalize to a confident `blocked` — a different ephemeral port might
        still be allowed. Before this fix, ANY matched deny (however narrowly scoped) produced a
        confident `blocked`, asymmetric with the allow-side scoping fix."""
        fwd = [{"rule_number": 100, "protocol": "-1", "action": "allow"}]
        ret = [{"rule_number": 50, "protocol": "tcp", "from_port": ad.EPHEMERAL_PROBE_PORT,
                 "to_port": ad.EPHEMERAL_PROBE_PORT, "action": "deny"},
               {"rule_number": 100, "protocol": "-1", "action": "allow"}]
        r = ad.eval_nacl(fwd, ret, "tcp", 443)
        assert r["status"] == "conditional"

    # ── item 1: a CIDR-scoped entry with NO peer_ip must never yield a confident verdict ──────────

    def test_cidr_scoped_forward_entry_with_no_peer_ip_is_unknown_not_a_confident_match(self):
        """Before this fix, `peer_ip is None` short-circuited the CIDR scoping check entirely,
        letting the first proto/port-matching entry win regardless of CIDR — a confident verdict
        from missing evidence. The only forward entry is CIDR-scoped and peer_ip is unavailable, so
        this must be `unknown`, not a confident `allowed` (nor a confident `blocked`)."""
        fwd = [{"rule_number": 100, "protocol": "-1", "cidr": "10.0.0.0/8", "action": "allow"},
               {"rule_number": 32767, "action": "deny"}]
        r = ad.eval_nacl(fwd, [], "tcp", 443, peer_ip=None)
        assert r["status"] == "unknown"

    def test_cidr_scoped_return_entry_with_no_peer_ip_is_unknown_even_when_forward_resolves(self):
        fwd = [{"rule_number": 100, "protocol": "-1", "action": "allow"}]
        ret = [{"rule_number": 100, "protocol": "-1", "cidr": "10.0.0.0/8", "action": "allow"}]
        r = ad.eval_nacl(fwd, ret, "tcp", 443, peer_ip=None)
        assert r["status"] == "unknown"

    def test_cidr_scoped_entry_with_peer_ip_present_still_resolves_confidently(self):
        # Regression guard: supplying peer_ip must still produce the pre-existing confident verdict.
        fwd = [{"rule_number": 100, "protocol": "-1", "cidr": "10.0.0.0/8", "action": "allow"}]
        ret = [{"rule_number": 100, "protocol": "-1", "action": "allow"}]
        r = ad.eval_nacl(fwd, ret, "tcp", 443, peer_ip="10.1.2.3")
        assert r["status"] == "allowed"

    # ── MINOR fix: a malformed (not a parseable IP literal) peer_ip must be treated exactly like
    #    peer_ip=None — not fall through as an ordinary CIDR non-match. ────────────────────────────

    def test_cidr_scoped_forward_entry_with_malformed_peer_ip_is_unknown(self):
        fwd = [{"rule_number": 100, "protocol": "-1", "cidr": "10.0.0.0/8", "action": "allow"},
               {"rule_number": 32767, "action": "deny"}]
        r = ad.eval_nacl(fwd, [], "tcp", 443, peer_ip="definitely-not-an-ip")
        assert r["status"] == "unknown"

    def test_return_deny_covering_full_ephemeral_range_is_confidently_blocked(self):
        """A deny that genuinely spans the full 0-65535 ephemeral range (unrestricted) legitimately
        blocks every ephemeral port, so a confident `blocked` remains correct."""
        fwd = [{"rule_number": 100, "protocol": "-1", "action": "allow"}]
        ret = [{"rule_number": 50, "protocol": "tcp", "from_port": 0, "to_port": 65535,
                 "action": "deny"}]
        r = ad.eval_nacl(fwd, ret, "tcp", 443)
        assert r["status"] == "blocked"


# ── Routes ────────────────────────────────────────────────────────────────────────────────────────

class TestRoute:
    def test_longest_prefix_wins(self):
        rt = [{"destination_cidr": "0.0.0.0/0", "target": "igw-1", "state": "active"},
              {"destination_cidr": "10.0.1.0/24", "target": "local", "state": "active"}]
        r = ad.eval_route(rt, "10.0.1.5")
        assert r["target_resource"] if "target_resource" in r else True
        assert r["resource"] == "local"

    def test_blackhole_route_blocks(self):
        rt = [{"destination_cidr": "192.168.0.0/16", "target": "pcx-1", "state": "blackhole"}]
        r = ad.eval_route(rt, "192.168.1.1")
        assert r["status"] == "blocked"

    def test_no_covering_route_blocks(self):
        rt = [{"destination_cidr": "10.0.0.0/8", "target": "local", "state": "active"}]
        r = ad.eval_route(rt, "8.8.8.8")
        assert r["status"] == "blocked"

    def test_default_route_covers_internet(self):
        rt = [{"destination_cidr": "0.0.0.0/0", "target": "nat-1", "state": "active"}]
        r = ad.eval_route(rt, "8.8.8.8")
        assert r["status"] == "allowed"
        assert r["resource"] == "nat-1"

    def test_one_ended_source_side_only_needs_no_destination_eni(self):
        # Same function, no destination ENI at all — CIDR-only destination for internet/on-prem.
        rt = [{"destination_cidr": "203.0.113.0/24", "target": "vgw-1", "state": "active"}]
        r = ad.eval_route(rt, "203.0.113.0/24")
        assert r["status"] == "allowed"

    def test_missing_destination_is_unknown_not_blocked(self):
        # MAJOR fix: missing destination must never invent a confident `blocked`.
        rt = [{"destination_cidr": "0.0.0.0/0", "target": "igw-1", "state": "active"}]
        r = ad.eval_route(rt, None)
        assert r["status"] == "unknown"

    def test_malformed_destination_is_unknown_not_blocked(self):
        rt = [{"destination_cidr": "0.0.0.0/0", "target": "igw-1", "state": "active"}]
        r = ad.eval_route(rt, "not-an-ip-or-cidr")
        assert r["status"] == "unknown"


# ── TGW ───────────────────────────────────────────────────────────────────────────────────────────

class TestTgw:
    def test_attachment_not_available_blocks(self):
        r = ad.eval_tgw("deleting", True, True, {"state": "active", "attachment_id": "tgw-attach-1"})
        assert r["status"] == "blocked"

    def test_not_associated_blocks(self):
        r = ad.eval_tgw("available", False, True, None)
        assert r["status"] == "blocked"

    def test_blackhole_blocks(self):
        r = ad.eval_tgw("available", True, True, {"state": "blackhole", "attachment_id": "tgw-attach-1"})
        assert r["status"] == "blocked"

    def test_no_matching_route_no_propagation_blocks(self):
        r = ad.eval_tgw("available", True, False, None)
        assert r["status"] == "blocked"

    def test_propagation_enabled_but_no_route_is_unknown_stale_cache(self):
        r = ad.eval_tgw("available", True, True, None)
        assert r["status"] == "unknown"

    def test_forward_route_present_is_conditional_asymmetric_return_risk(self):
        r = ad.eval_tgw("available", True, True, {"state": "active", "attachment_id": "tgw-attach-1"})
        assert r["status"] == "conditional"


# ── Peering / VPN / DX boundary classification ──────────────────────────────────────────────────

class TestBoundaryClassification:
    def test_peering_active(self):
        assert ad.eval_peering("active")["status"] == "allowed"

    def test_peering_not_active(self):
        assert ad.eval_peering("pending-acceptance")["status"] == "blocked"

    def test_vpn_up_with_route(self):
        r = ad.eval_vpn_or_dx("vpn", "up", True)
        assert r["status"] == "allowed"

    def test_vpn_down(self):
        r = ad.eval_vpn_or_dx("vpn", "down", True)
        assert r["status"] == "blocked"

    def test_dx_up_no_route(self):
        r = ad.eval_vpn_or_dx("dx", "up", False)
        assert r["status"] == "blocked"

    def test_missing_aws_side_state_is_unknown_not_a_confident_block(self):
        """CI-review MAJOR fix (round 19): `aws_side_state=None` (never fetched) must not report
        the same confident `blocked` as a CONFIRMED-down state — the topology fetcher never
        populates this field today, so this is the honest-degrade path a real on-prem candidate
        takes until live wiring exists."""
        r = ad.eval_vpn_or_dx("vpn", None, True)
        assert r["status"] == "unknown"

    def test_missing_route_present_is_unknown_not_a_confident_block(self):
        """CI-review MAJOR fix (round 25): the round-19 fix distinguished a missing
        `aws_side_state` from a confirmed-down one, but left `route_present` on the old
        `not route_present` shortcut — a genuinely unfetched route marker (`None`) reported the
        same confident `blocked` as a CONFIRMED-absent route (`False`)."""
        r = ad.eval_vpn_or_dx("vpn", "up", None)
        assert r["status"] == "unknown"


# ── Network Firewall ─────────────────────────────────────────────────────────────────────────────

class TestNetworkFirewall:
    def test_pass(self):
        assert ad.eval_network_firewall("pass")["status"] == "allowed"

    def test_drop(self):
        assert ad.eval_network_firewall("drop")["status"] == "blocked"

    def test_reject(self):
        assert ad.eval_network_firewall("reject")["status"] == "blocked"

    def test_uninspectable_form(self):
        r = ad.eval_network_firewall("pass", uninspectable=True)
        assert r["status"] == "unknown"

    def test_unrecognized_action_is_unknown(self):
        r = ad.eval_network_firewall("alert")
        assert r["status"] == "unknown"


# ── ALB listener ──────────────────────────────────────────────────────────────────────────────────

class TestAlbListener:
    def test_first_match_wins(self):
        rules = [
            {"priority": 1, "conditions": [{"field": "path-pattern", "values": ["/api/*"]}],
             "action": {"type": "forward", "target_group_arn": "tg-api"}},
            {"priority": 2, "conditions": [], "action": {"type": "forward", "target_group_arn": "tg-default"}},
        ]
        r = ad.eval_alb_listener(rules, {"path-pattern": "/api/orders"})
        assert r["status"] == "allowed"
        assert "tg-api" in r["summary"]

    def test_fixed_response_4xx_blocks(self):
        rules = [{"priority": 1, "conditions": [], "action": {"type": "fixed-response", "status_code": 403}}]
        r = ad.eval_alb_listener(rules, {})
        assert r["status"] == "blocked"

    def test_fixed_response_2xx_allows(self):
        rules = [{"priority": 1, "conditions": [], "action": {"type": "fixed-response", "status_code": 200}}]
        r = ad.eval_alb_listener(rules, {})
        assert r["status"] == "allowed"

    def test_redirect_is_conditional(self):
        rules = [{"priority": 1, "conditions": [], "action": {"type": "redirect"}}]
        r = ad.eval_alb_listener(rules, {})
        assert r["status"] == "conditional"

    def test_no_match_and_no_default_action_present_is_unknown_not_blocked(self):
        """L2 finding #5a: a real ALB listener ALWAYS has a default action — an input rule set
        that omits one entirely is missing data, not a confirmed deny. Must be `unknown`, never a
        confident `blocked` (the same "missing data never yields a confident deny" fix already
        applied to eval_security_group/eval_route)."""
        rules = [{"priority": 1, "conditions": [{"field": "path-pattern", "values": ["/api/*"]}],
                  "action": {"type": "forward"}}]
        r = ad.eval_alb_listener(rules, {"path-pattern": "/other"})
        assert r["status"] == "unknown"

    def test_no_match_but_default_action_present_blocks(self):
        """When the rule set DOES include the always-present default action (priority literal
        "default", ELBv2's own value) and it also fails to match, `blocked` is the correct,
        confident verdict."""
        rules = [
            {"priority": 1, "conditions": [{"field": "path-pattern", "values": ["/api/*"]}],
             "action": {"type": "forward"}},
            {"priority": "default", "conditions": [{"field": "path-pattern", "values": ["/never/*"]}],
             "action": {"type": "forward"}},
        ]
        r = ad.eval_alb_listener(rules, {"path-pattern": "/other"})
        assert r["status"] == "blocked"

    def test_default_priority_string_does_not_crash_sort(self):
        """L2 finding #5b: `sorted(rules, key=priority)` raised TypeError on ELBv2's literal
        `"default"` priority value (int vs str comparison) — must sort last instead of crashing."""
        rules = [
            {"priority": "default", "conditions": [], "action": {"type": "forward", "target_group_arn": "tg-default"}},
            {"priority": 5, "conditions": [{"field": "path-pattern", "values": ["/api/*"]}],
             "action": {"type": "forward", "target_group_arn": "tg-api"}},
        ]
        r = ad.eval_alb_listener(rules, {"path-pattern": "/api/orders"})
        assert r["status"] == "allowed"
        assert "tg-api" in r["summary"]  # the numbered rule, not the default, wins

    def test_host_header_wildcard_matches(self):
        """L2 finding #5c: host-header wildcards (`*.example.com`) must match, mirroring ALB's own
        glob semantics — previously only path-pattern implemented `*`."""
        rules = [{"priority": 1, "conditions": [{"field": "host-header", "values": ["*.example.com"]}],
                  "action": {"type": "forward", "target_group_arn": "tg-wild"}}]
        r = ad.eval_alb_listener(rules, {"host-header": "api.example.com"})
        assert r["status"] == "allowed"
        assert "tg-wild" in r["summary"]

    def test_host_header_wildcard_does_not_match_unrelated_host(self):
        rules = [{"priority": 1, "conditions": [{"field": "host-header", "values": ["*.example.com"]}],
                  "action": {"type": "forward", "target_group_arn": "tg-wild"}},
                 {"priority": "default", "conditions": [], "action": {"type": "fixed-response", "status_code": 404}}]
        r = ad.eval_alb_listener(rules, {"host-header": "api.other.com"})
        assert r["status"] == "blocked"


class TestNaclLayerParam:
    def test_default_layer_is_nacl(self):
        r = ad.eval_nacl([{"rule_number": 100, "protocol": "-1", "action": "allow"}],
                          [{"rule_number": 100, "protocol": "-1", "action": "allow"}], "tcp", 443)
        assert r["layer"] == "nacl"

    def test_custom_layer_name_is_threaded_through_every_branch(self):
        """L4 finding #13: eval_nacl must be reusable for a second (destination-side) pass under a
        distinct layer name — every returned dict (blocked-forward, blocked-return, allowed,
        conditional) must carry the CALLER's layer name, not a hardcoded "nacl"."""
        blocked_fwd = ad.eval_nacl([], [], "tcp", 443, layer="nacl-dst")
        assert blocked_fwd["layer"] == "nacl-dst"
        blocked_ret = ad.eval_nacl([{"rule_number": 100, "protocol": "-1", "action": "allow"}],
                                    [], "tcp", 443, layer="nacl-dst")
        assert blocked_ret["layer"] == "nacl-dst"
        allowed = ad.eval_nacl([{"rule_number": 100, "protocol": "-1", "action": "allow"}],
                                [{"rule_number": 100, "protocol": "-1", "action": "allow"}],
                                "tcp", 443, layer="nacl-dst")
        assert allowed["layer"] == "nacl-dst"
        conditional = ad.eval_nacl(
            [{"rule_number": 100, "protocol": "-1", "action": "allow"}],
            [{"rule_number": 100, "protocol": "tcp", "action": "allow",
              "from_port": ad.EPHEMERAL_PROBE_PORT, "to_port": ad.EPHEMERAL_PROBE_PORT}],
            "tcp", 443, layer="nacl-dst")
        assert conditional["layer"] == "nacl-dst"


class TestTargetGroupHealth:
    def test_no_targets(self):
        assert ad.eval_target_group_health(0, 0)["status"] == "blocked"

    def test_all_unhealthy(self):
        assert ad.eval_target_group_health(0, 3)["status"] == "blocked"

    def test_partial_healthy_is_conditional(self):
        assert ad.eval_target_group_health(1, 3)["status"] == "conditional"

    def test_all_healthy(self):
        assert ad.eval_target_group_health(3, 3)["status"] == "allowed"


# ── K8s NetworkPolicy ────────────────────────────────────────────────────────────────────────────

class TestK8sNetworkPolicy:
    def test_no_policy_selects_pod_default_allow(self):
        r = ad.eval_k8s_network_policy([], {"app": "orders"}, "ingress")
        assert r["status"] == "allowed"

    def test_selected_default_deny_no_matching_rule(self):
        policies = [{"pod_selector": {"app": "orders"}, "policy_types": ["ingress"], "ingress": [
            {"from": [{"pod_selector": {"app": "gateway"}}]}]}]
        r = ad.eval_k8s_network_policy(policies, {"app": "orders"}, "ingress", peer_labels={"app": "other"})
        assert r["status"] == "blocked"

    def test_selected_matching_pod_selector_allows(self):
        policies = [{"pod_selector": {"app": "orders"}, "policy_types": ["ingress"], "ingress": [
            {"from": [{"pod_selector": {"app": "gateway"}}]}]}]
        # item 2c: a bare podSelector (no namespaceSelector) is scoped to the policy's OWN
        # namespace — confirming same-namespace is required for a confident `allowed`.
        r = ad.eval_k8s_network_policy(policies, {"app": "orders"}, "ingress", peer_labels={"app": "gateway"},
                                        policy_namespace="orders-ns", peer_namespace="orders-ns")
        assert r["status"] == "allowed"

    def test_ip_block_peer_match(self):
        policies = [{"pod_selector": {"app": "orders"}, "policy_types": ["egress"], "egress": [
            {"to": [{"ip_block": {"cidr": "10.0.0.0/8"}}]}]}]
        r = ad.eval_k8s_network_policy(policies, {"app": "orders"}, "egress", peer_ip="10.1.2.3")
        assert r["status"] == "allowed"

    def test_empty_peer_list_allows_all(self):
        policies = [{"pod_selector": {"app": "orders"}, "policy_types": ["ingress"], "ingress": [{}]}]
        r = ad.eval_k8s_network_policy(policies, {"app": "orders"}, "ingress")
        assert r["status"] == "allowed"

    # ── MAJOR fail-open fix: the docstring's OWN documented shape uses canonical K8s casing ──────

    def test_canonical_cased_policy_types_select_the_pod(self):
        """The docstring's documented input shape is `"policy_types": ["Ingress","Egress"]`
        (Kubernetes canonical casing) — with that EXACT shape, a policy selecting the pod for
        ingress must actually select it (previously: lowercase-only comparison meant no policy
        ever selected the pod under the documented shape, so a default-deny pod fail-opened to
        `allowed`)."""
        policies = [{"pod_selector": {"app": "orders"}, "policy_types": ["Ingress", "Egress"],
                     "ingress": [{"from": [{"pod_selector": {"app": "gateway"}}]}]}]
        r = ad.eval_k8s_network_policy(policies, {"app": "orders"}, "ingress", peer_labels={"app": "other"})
        # Selected (canonical-cased policy_types matched) + no rule matches the actual peer -> blocked
        # (default-deny), NOT allowed — proving the pod is genuinely selected, not fail-open.
        assert r["status"] == "blocked"

    def test_canonical_cased_policy_types_matching_peer_allows(self):
        policies = [{"pod_selector": {"app": "orders"}, "policy_types": ["Ingress"],
                     "ingress": [{"from": [{"pod_selector": {"app": "gateway"}}]}]}]
        r = ad.eval_k8s_network_policy(policies, {"app": "orders"}, "ingress", peer_labels={"app": "gateway"},
                                        policy_namespace="ns", peer_namespace="ns")
        assert r["status"] == "allowed"

    # ── L4 finding #10a: policyTypes OMITTED entirely must still apply K8s' real defaulting ──────

    def test_omitted_policy_types_still_selects_pod_for_ingress_default_deny(self):
        """A policy with NO `policy_types` key at all still selects the pod for Ingress (K8s
        default: [Ingress], or [Ingress, Egress] if `egress` is present) — previously this policy
        was silently invisible (no key present -> never selected -> fail-open to `allowed`)."""
        policies = [{"pod_selector": {"app": "orders"},
                     "ingress": [{"from": [{"pod_selector": {"app": "gateway"}}]}]}]
        r = ad.eval_k8s_network_policy(policies, {"app": "orders"}, "ingress", peer_labels={"app": "other"})
        assert r["status"] == "blocked"  # genuinely selected + default-deny, not fail-open allowed

    def test_omitted_policy_types_does_not_select_pod_for_egress_without_egress_key(self):
        """The same omitted-policyTypes policy must NOT apply to Egress unless the `egress` key is
        itself present — Ingress-only defaulting must not overreach into Egress."""
        policies = [{"pod_selector": {"app": "orders"},
                     "ingress": [{"from": [{"pod_selector": {"app": "gateway"}}]}]}]
        r = ad.eval_k8s_network_policy(policies, {"app": "orders"}, "egress", peer_ip="10.0.0.1")
        assert r["status"] == "allowed"  # not selected for egress -> genuinely default-allow

    def test_omitted_policy_types_with_egress_key_present_selects_for_egress_too(self):
        policies = [{"pod_selector": {"app": "orders"},
                     "egress": [{"to": [{"ip_block": {"cidr": "10.0.0.0/8"}}]}]}]
        r = ad.eval_k8s_network_policy(policies, {"app": "orders"}, "egress", peer_ip="192.168.1.1")
        assert r["status"] == "blocked"  # selected via `egress` key presence, peer doesn't match

    # ── L4 finding #10b: a rule's own `ports` restriction must actually be evaluated ────────────

    def test_port_restricted_rule_blocks_a_different_port(self):
        policies = [{"pod_selector": {"app": "dns"}, "policy_types": ["ingress"], "ingress": [
            {"from": [{"pod_selector": {"app": "client"}}], "ports": [{"protocol": "UDP", "port": 53}]}]}]
        r = ad.eval_k8s_network_policy(policies, {"app": "dns"}, "ingress",
                                        peer_labels={"app": "client"}, protocol="tcp", port=8080)
        assert r["status"] == "blocked"

    def test_port_restricted_rule_allows_the_matching_port(self):
        policies = [{"pod_selector": {"app": "dns"}, "policy_types": ["ingress"], "ingress": [
            {"from": [{"pod_selector": {"app": "client"}}], "ports": [{"protocol": "UDP", "port": 53}]}]}]
        r = ad.eval_k8s_network_policy(policies, {"app": "dns"}, "ingress",
                                        peer_labels={"app": "client"}, protocol="udp", port=53,
                                        policy_namespace="ns", peer_namespace="ns")
        assert r["status"] == "allowed"

    def test_rule_with_no_ports_field_allows_any_port(self):
        policies = [{"pod_selector": {"app": "orders"}, "policy_types": ["ingress"], "ingress": [
            {"from": [{"pod_selector": {"app": "gateway"}}]}]}]
        r = ad.eval_k8s_network_policy(policies, {"app": "orders"}, "ingress",
                                        peer_labels={"app": "gateway"}, protocol="tcp", port=9999,
                                        policy_namespace="ns", peer_namespace="ns")
        assert r["status"] == "allowed"

    def test_port_range_via_end_port_matches(self):
        policies = [{"pod_selector": {"app": "orders"}, "policy_types": ["ingress"], "ingress": [
            {"from": [{"pod_selector": {"app": "gateway"}}],
             "ports": [{"protocol": "TCP", "port": 8000, "endPort": 8100}]}]}]
        r = ad.eval_k8s_network_policy(policies, {"app": "orders"}, "ingress",
                                        peer_labels={"app": "gateway"}, protocol="tcp", port=8050,
                                        policy_namespace="ns", peer_namespace="ns")
        assert r["status"] == "allowed"

    # ── item 2b: named ports must never confidently deny ────────────────────────────────────────

    def test_named_port_that_cannot_be_resolved_is_unknown_not_blocked(self):
        """A rule restricted to a named port ("port": "http") that this pure adapter has no
        Service-port-name resolution for must not be treated as a confident non-match (the old
        `int()` conversion silently swallowed the ValueError via a bare `continue`, producing a
        false `blocked`)."""
        policies = [{"pod_selector": {"app": "web"}, "policy_types": ["ingress"], "ingress": [
            {"from": [{"pod_selector": {"app": "client"}}],
             "ports": [{"protocol": "TCP", "port": "http"}]}]}]
        r = ad.eval_k8s_network_policy(policies, {"app": "web"}, "ingress",
                                        peer_labels={"app": "client"}, protocol="tcp", port=80,
                                        policy_namespace="ns", peer_namespace="ns")
        assert r["status"] == "unknown"

    def test_named_port_alongside_a_confidently_matching_port_still_allows(self):
        """When another, numeric ports entry in the SAME rule confidently matches, that confident
        match wins — an unresolvable named port elsewhere must not downgrade an otherwise-confident
        allow."""
        policies = [{"pod_selector": {"app": "web"}, "policy_types": ["ingress"], "ingress": [
            {"from": [{"pod_selector": {"app": "client"}}],
             "ports": [{"protocol": "TCP", "port": "http"}, {"protocol": "TCP", "port": 80}]}]}]
        r = ad.eval_k8s_network_policy(policies, {"app": "web"}, "ingress",
                                        peer_labels={"app": "client"}, protocol="tcp", port=80,
                                        policy_namespace="ns", peer_namespace="ns")
        assert r["status"] == "allowed"

    def test_named_port_unresolved_but_peer_definitely_mismatches_stays_confident_blocked(self):
        """MINOR fix (round 2): the rule's own peer (podSelector `app: other`) definitively does not
        match the flow's peer (`app: client`) regardless of port — this rule is irrelevant, and must
        not taint the verdict to `unknown` just because ITS OWN port entry happens to be an
        unresolvable named port. Only a rule whose peers WOULD otherwise match, but whose port can't
        be resolved, should downgrade to `unknown` (see the two tests above)."""
        policies = [{"pod_selector": {"app": "web"}, "policy_types": ["ingress"], "ingress": [
            {"from": [{"pod_selector": {"app": "other"}}],
             "ports": [{"protocol": "TCP", "port": "http"}]}]}]
        r = ad.eval_k8s_network_policy(policies, {"app": "web"}, "ingress",
                                        peer_labels={"app": "client"}, protocol="tcp", port=80,
                                        policy_namespace="ns", peer_namespace="ns")
        assert r["status"] == "blocked"

    # ── item 2a: partial peer data (podSelector w/o peer_labels, ipBlock w/o peer_ip) -> unknown ──

    def test_pod_selector_peer_with_no_peer_labels_is_unknown_not_blocked(self):
        policies = [{"pod_selector": {"app": "orders"}, "policy_types": ["ingress"], "ingress": [
            {"from": [{"pod_selector": {"app": "gateway"}}]}]}]
        r = ad.eval_k8s_network_policy(policies, {"app": "orders"}, "ingress", peer_labels=None)
        assert r["status"] == "unknown"

    def test_ip_block_peer_with_no_peer_ip_is_unknown_not_blocked(self):
        policies = [{"pod_selector": {"app": "orders"}, "policy_types": ["egress"], "egress": [
            {"to": [{"ip_block": {"cidr": "10.0.0.0/8"}}]}]}]
        r = ad.eval_k8s_network_policy(policies, {"app": "orders"}, "egress", peer_ip=None)
        assert r["status"] == "unknown"

    # ── MINOR fix: a malformed (unparseable) peer_ip on an ipBlock peer must be treated exactly
    #    like peer_ip=None, not fall through to `_cidr_contains` as an ordinary non-match. ─────────

    def test_ip_block_peer_with_malformed_peer_ip_is_unknown_not_blocked(self):
        policies = [{"pod_selector": {"app": "orders"}, "policy_types": ["egress"], "egress": [
            {"to": [{"ip_block": {"cidr": "10.0.0.0/8"}}]}]}]
        r = ad.eval_k8s_network_policy(policies, {"app": "orders"}, "egress", peer_ip="not-an-ip")
        assert r["status"] == "unknown"

    # ── MINOR fix: an EMPTY namespaceSelector/podSelector ({} — K8s' own "match everything")
    #    must resolve as a vacuous match WITHOUT needing peer_labels/peer_namespace_labels, rather
    #    than downgrading a decidable `allowed` to `unknown`. ───────────────────────────────────────

    def test_empty_pod_selector_matches_without_any_peer_labels(self):
        policies = [{"pod_selector": {"app": "orders"}, "policy_types": ["ingress"], "ingress": [
            {"from": [{"pod_selector": {}, "namespace_selector": {}}]}]}]
        r = ad.eval_k8s_network_policy(policies, {"app": "orders"}, "ingress",
                                        peer_labels=None, peer_namespace_labels=None)
        assert r["status"] == "allowed"

    def test_empty_namespace_selector_alone_matches_without_namespace_labels(self):
        policies = [{"pod_selector": {"app": "orders"}, "policy_types": ["ingress"], "ingress": [
            {"from": [{"namespace_selector": {}}]}]}]
        r = ad.eval_k8s_network_policy(policies, {"app": "orders"}, "ingress", peer_namespace_labels=None)
        assert r["status"] == "allowed"

    # ── item 2c: bare podSelector-only peer without namespace confirmation -> unknown ────────────

    def test_bare_pod_selector_without_namespace_data_is_unknown_even_when_labels_match(self):
        """K8s restricts a bare podSelector (no namespaceSelector) to the SAME namespace as the
        policy — without namespace data to confirm that, a label match alone must not become a
        confident cross-namespace `allowed`."""
        policies = [{"pod_selector": {"app": "orders"}, "policy_types": ["ingress"], "ingress": [
            {"from": [{"pod_selector": {"app": "gateway"}}]}]}]
        r = ad.eval_k8s_network_policy(policies, {"app": "orders"}, "ingress", peer_labels={"app": "gateway"})
        assert r["status"] == "unknown"

    def test_bare_pod_selector_different_namespace_does_not_match(self):
        policies = [{"pod_selector": {"app": "orders"}, "policy_types": ["ingress"], "ingress": [
            {"from": [{"pod_selector": {"app": "gateway"}}]}]}]
        r = ad.eval_k8s_network_policy(policies, {"app": "orders"}, "ingress", peer_labels={"app": "gateway"},
                                        policy_namespace="ns-a", peer_namespace="ns-b")
        assert r["status"] == "blocked"

    def test_bare_pod_selector_label_mismatch_is_a_confident_non_match_no_namespace_needed(self):
        """When the labels themselves don't match, that's a confident non-match regardless of
        namespace data — the namespace-confirmation requirement only applies to entries that would
        otherwise match."""
        policies = [{"pod_selector": {"app": "orders"}, "policy_types": ["ingress"], "ingress": [
            {"from": [{"pod_selector": {"app": "gateway"}}]}]}]
        r = ad.eval_k8s_network_policy(policies, {"app": "orders"}, "ingress", peer_labels={"app": "other"})
        assert r["status"] == "blocked"

    # ── L4 finding #10c: data_available=False must yield `unknown`, never a fail-open `allowed` ──

    def test_data_unavailable_is_unknown_not_allowed(self):
        r = ad.eval_k8s_network_policy([], {"app": "orders"}, "ingress", data_available=False)
        assert r["status"] == "unknown"

    def test_data_available_true_with_empty_policies_is_genuinely_allowed(self):
        """The pre-existing, correct behavior: when the fetch DID happen and genuinely found zero
        policies, that's a real default-allow — must not regress to `unknown`."""
        r = ad.eval_k8s_network_policy([], {"app": "orders"}, "ingress", data_available=True)
        assert r["status"] == "allowed"

    # ── L2 finding #2: ipBlock.except must carve the excluded sub-range back OUT of the allow ────

    def test_ip_block_except_excludes_peer_inside_the_exception(self):
        """A peer matching the main `cidr` but ALSO matching an `except` sub-CIDR must NOT be
        reported allowed by that rule — before this fix, `except` was never read at all, so this
        peer was a false-allow."""
        policies = [{"pod_selector": {"app": "orders"}, "policy_types": ["ingress"], "ingress": [
            {"from": [{"ip_block": {"cidr": "10.0.0.0/8", "except": ["10.1.0.0/16"]}}]}]}]
        r = ad.eval_k8s_network_policy(policies, {"app": "orders"}, "ingress", peer_ip="10.1.2.3")
        assert r["status"] == "blocked"

    def test_ip_block_except_still_allows_peer_outside_the_exception(self):
        policies = [{"pod_selector": {"app": "orders"}, "policy_types": ["ingress"], "ingress": [
            {"from": [{"ip_block": {"cidr": "10.0.0.0/8", "except": ["10.1.0.0/16"]}}]}]}]
        r = ad.eval_k8s_network_policy(policies, {"app": "orders"}, "ingress", peer_ip="10.2.2.3")
        assert r["status"] == "allowed"

    # ── L2 finding #2: namespaceSelector with insufficient data -> unknown, never allowed/blocked ─

    def test_namespace_selector_without_namespace_data_is_unknown(self):
        policies = [{"pod_selector": {"app": "orders"}, "policy_types": ["ingress"], "ingress": [
            {"from": [{"namespace_selector": {"team": "platform"}}]}]}]
        r = ad.eval_k8s_network_policy(policies, {"app": "orders"}, "ingress", peer_labels={"app": "other"})
        assert r["status"] == "unknown"

    def test_namespace_selector_matching_with_namespace_data_allows(self):
        policies = [{"pod_selector": {"app": "orders"}, "policy_types": ["ingress"], "ingress": [
            {"from": [{"namespace_selector": {"team": "platform"}}]}]}]
        r = ad.eval_k8s_network_policy(
            policies, {"app": "orders"}, "ingress",
            peer_namespace_labels={"team": "platform"},
        )
        assert r["status"] == "allowed"

    def test_namespace_selector_non_matching_with_namespace_data_blocks(self):
        policies = [{"pod_selector": {"app": "orders"}, "policy_types": ["ingress"], "ingress": [
            {"from": [{"namespace_selector": {"team": "platform"}}]}]}]
        r = ad.eval_k8s_network_policy(
            policies, {"app": "orders"}, "ingress",
            peer_namespace_labels={"team": "other-team"},
        )
        assert r["status"] == "blocked"


# ── Calico / Cilium / Istio bounded stubs ───────────────────────────────────────────────────────

class TestMeshPolicyStub:
    def test_crd_missing_is_unknown(self):
        r = ad.eval_mesh_policy_stub("calico", None, crd_present=False)
        assert r["status"] == "unknown"

    def test_unsupported_version_is_unknown(self):
        r = ad.eval_mesh_policy_stub("cilium", "cilium.io/v1alpha1", crd_present=True)
        assert r["status"] == "unknown"

    def test_supported_version_still_unknown_not_full_eval(self):
        # Even a "supported" schema version never returns allowed/blocked in this release — this is
        # a bounded stub, not a full live evaluator (see the report).
        r = ad.eval_mesh_policy_stub("calico", "projectcalico.org/v3", crd_present=True)
        assert r["status"] == "unknown"

    def test_never_returns_allowed_or_blocked(self):
        for kind, version, present in [
            ("calico", "projectcalico.org/v3", True), ("cilium", "cilium.io/v2", True),
            ("istio-virtualservice", "networking.istio.io/v1", True),
            ("istio-authorizationpolicy", None, False),
        ]:
            r = ad.eval_mesh_policy_stub(kind, version, present)
            assert r["status"] not in ("allowed", "blocked")


# ── Gap 2: Calico — REAL evaluation (superset of core K8s NetworkPolicy semantics) ─────────────

_CALICO_VERSION = "projectcalico.org/v3"


class TestCalicoPolicy:
    def test_crd_missing_is_unknown(self):
        r = ad.eval_calico_policy([], {}, "ingress", crd_present=False)
        assert r["status"] == "unknown"

    def test_unsupported_version_is_unknown(self):
        r = ad.eval_calico_policy([], {}, "ingress", crd_present=True, observed_api_version="v2alpha1")
        assert r["status"] == "unknown"

    def test_no_policy_selects_pod_default_allow(self):
        # Matches core K8s NetworkPolicy semantics for the overlapping case: unselected -> allow.
        r = ad.eval_calico_policy(
            [{"selector": "role == 'other'", "types": ["Ingress"]}], {"role": "web"}, "ingress",
            crd_present=True, observed_api_version=_CALICO_VERSION)
        assert r["status"] == "allowed"

    def test_selected_default_deny_no_matching_rule(self):
        r = ad.eval_calico_policy(
            [{"selector": "role == 'web'", "types": ["Ingress"], "ingress": []}],
            {"role": "web"}, "ingress", crd_present=True, observed_api_version=_CALICO_VERSION)
        assert r["status"] == "blocked"

    def test_selector_equality_match_allows(self):
        policies = [{"selector": "role == 'web'", "types": ["Ingress"], "ingress": [
            {"action": "Allow", "source": {"selector": "role == 'frontend'"}}]}]
        r = ad.eval_calico_policy(policies, {"role": "web"}, "ingress", peer_labels={"role": "frontend"},
                                   crd_present=True, observed_api_version=_CALICO_VERSION)
        assert r["status"] == "allowed"

    def test_selector_equality_mismatch_blocks(self):
        policies = [{"selector": "role == 'web'", "types": ["Ingress"], "ingress": [
            {"action": "Allow", "source": {"selector": "role == 'frontend'"}}]}]
        r = ad.eval_calico_policy(policies, {"role": "web"}, "ingress", peer_labels={"role": "backend"},
                                   crd_present=True, observed_api_version=_CALICO_VERSION)
        assert r["status"] == "blocked"

    def test_nets_cidr_match_allows(self):
        policies = [{"selector": "role == 'web'", "types": ["Ingress"], "ingress": [
            {"action": "Allow", "source": {"nets": ["10.0.0.0/8"]}}]}]
        r = ad.eval_calico_policy(policies, {"role": "web"}, "ingress", peer_ip="10.1.2.3",
                                   crd_present=True, observed_api_version=_CALICO_VERSION)
        assert r["status"] == "allowed"

    def test_deny_action_rule_is_never_a_confident_blocker(self):
        # A Deny rule that would otherwise match a peer must not itself yield `blocked` -- Calico's
        # real deny/pass precedence depends on cross-policy `order`, which this adapter doesn't
        # model; the ABSENCE of a matching Allow still correctly reduces to blocked on its own.
        policies = [{"selector": "role == 'web'", "types": ["Ingress"], "ingress": [
            {"action": "Deny", "source": {"selector": "role == 'frontend'"}}]}]
        r = ad.eval_calico_policy(policies, {"role": "web"}, "ingress", peer_labels={"role": "frontend"},
                                   crd_present=True, observed_api_version=_CALICO_VERSION)
        assert r["status"] == "blocked"  # no Allow rule matched (the Deny rule was skipped, not applied)

    # ── CI-review MAJOR fix (round 17): a Deny/Pass rule that ALSO matches the peer must veto a
    #    confident `allowed` from a later-listed Allow rule — Calico's real precedence between them
    #    depends on unmodeled cross-policy `order`, so this adapter cannot know which one would
    #    actually win. ──────────────────────────────────────────────────────────────────────────────

    def test_a_matching_deny_rule_downgrades_a_would_be_allowed_to_unknown(self):
        policies = [{"selector": "role == 'web'", "types": ["Ingress"], "ingress": [
            {"action": "Deny", "source": {"selector": "role == 'frontend'"}},
            {"action": "Allow", "source": {"selector": "role == 'frontend'"}},
        ]}]
        r = ad.eval_calico_policy(policies, {"role": "web"}, "ingress", peer_labels={"role": "frontend"},
                                   crd_present=True, observed_api_version=_CALICO_VERSION)
        assert r["status"] == "unknown"

    def test_a_non_matching_deny_rule_does_not_affect_a_matching_allow(self):
        """A Deny rule for a DIFFERENT peer must not spuriously downgrade an Allow that matches
        THIS peer — only a Deny/Pass that itself matches (or might match) the peer counts."""
        policies = [{"selector": "role == 'web'", "types": ["Ingress"], "ingress": [
            {"action": "Deny", "source": {"selector": "role == 'other'"}},
            {"action": "Allow", "source": {"selector": "role == 'frontend'"}},
        ]}]
        r = ad.eval_calico_policy(policies, {"role": "web"}, "ingress", peer_labels={"role": "frontend"},
                                   crd_present=True, observed_api_version=_CALICO_VERSION)
        assert r["status"] == "allowed"

    # ── CI-review MAJOR fix (round 18): three more holes in the Calico evaluator. ─────────────────

    def test_rule_level_protocol_mismatch_with_no_ports_is_not_a_match(self):
        """A UDP-only Allow rule with no `ports` list must not confidently `allowed` a TCP
        request — the rule-level `protocol` field is independent of `ports` in Calico."""
        policies = [{"selector": "role == 'web'", "types": ["Ingress"], "ingress": [
            {"action": "Allow", "protocol": "UDP", "source": {"nets": ["0.0.0.0/0"]}},
        ]}]
        r = ad.eval_calico_policy(policies, {"role": "web"}, "ingress", peer_ip="10.0.0.5",
                                   protocol="tcp", crd_present=True, observed_api_version=_CALICO_VERSION)
        assert r["status"] == "blocked"

    def test_rule_level_protocol_match_with_no_ports_allows(self):
        policies = [{"selector": "role == 'web'", "types": ["Ingress"], "ingress": [
            {"action": "Allow", "protocol": "UDP", "source": {"nets": ["0.0.0.0/0"]}},
        ]}]
        r = ad.eval_calico_policy(policies, {"role": "web"}, "ingress", peer_ip="10.0.0.5",
                                   protocol="udp", crd_present=True, observed_api_version=_CALICO_VERSION)
        assert r["status"] == "allowed"

    def test_a_matching_pass_rule_with_no_allow_is_unknown_not_blocked(self):
        """`Pass` delegates to the next tier/profile — unlike Deny, absence of a matching Allow
        must NOT fall through to a confident `blocked`."""
        policies = [{"selector": "role == 'web'", "types": ["Ingress"], "ingress": [
            {"action": "Pass", "source": {"selector": "role == 'frontend'"}},
        ]}]
        r = ad.eval_calico_policy(policies, {"role": "web"}, "ingress", peer_labels={"role": "frontend"},
                                   crd_present=True, observed_api_version=_CALICO_VERSION)
        assert r["status"] == "unknown"

    def test_a_negated_nets_field_is_unknown_not_a_guessed_match(self):
        """`notNets` is not modeled — a rule declaring it must degrade to `unknown`, never a
        confident match/non-match derived by ignoring the negation."""
        policies = [{"selector": "role == 'web'", "types": ["Ingress"], "ingress": [
            {"action": "Allow", "source": {"nets": ["0.0.0.0/0"], "notNets": ["10.0.0.0/8"]}},
        ]}]
        r = ad.eval_calico_policy(policies, {"role": "web"}, "ingress", peer_ip="10.1.2.3",
                                   crd_present=True, observed_api_version=_CALICO_VERSION)
        assert r["status"] == "unknown"

    def test_unsupported_selector_construct_is_unknown_not_a_guess(self):
        policies = [{"selector": "role == 'web' || tier == 'edge'", "types": ["Ingress"], "ingress": []}]
        r = ad.eval_calico_policy(policies, {"role": "web"}, "ingress",
                                   crd_present=True, observed_api_version=_CALICO_VERSION)
        assert r["status"] == "unknown"

    def test_native_ports_list_matches_requested_port(self):
        """Calico's own `ports` shape is a plain int/string list (e.g. `[80, 443]`), not core
        K8s's `{"protocol", "port"}` dicts — this must still restrict the match. `ports` lives in
        the `destination` EntityRule per the real Calico v3 schema (there is no rule-root
        `ports`), regardless of ingress/egress direction (round-19 fix)."""
        policies = [{"selector": "role == 'web'", "types": ["Ingress"], "ingress": [
            {"action": "Allow", "source": {"nets": ["0.0.0.0/0"]}, "destination": {"ports": [80, 443]}},
        ]}]
        r = ad.eval_calico_policy(policies, {"role": "web"}, "ingress", peer_ip="10.0.0.5",
                                   port=443, crd_present=True, observed_api_version=_CALICO_VERSION)
        assert r["status"] == "allowed"

    def test_native_ports_list_does_not_match_other_port(self):
        policies = [{"selector": "role == 'web'", "types": ["Ingress"], "ingress": [
            {"action": "Allow", "source": {"nets": ["0.0.0.0/0"]}, "destination": {"ports": [80, 443]}},
        ]}]
        r = ad.eval_calico_policy(policies, {"role": "web"}, "ingress", peer_ip="10.0.0.5",
                                   port=22, crd_present=True, observed_api_version=_CALICO_VERSION)
        assert r["status"] == "blocked"

    def test_native_ports_range_string_matches_within_range(self):
        policies = [{"selector": "role == 'web'", "types": ["Ingress"], "ingress": [
            {"action": "Allow", "source": {"nets": ["0.0.0.0/0"]}, "destination": {"ports": ["8080:9090"]}},
        ]}]
        r = ad.eval_calico_policy(policies, {"role": "web"}, "ingress", peer_ip="10.0.0.5",
                                   port=8500, crd_present=True, observed_api_version=_CALICO_VERSION)
        assert r["status"] == "allowed"

    # ── CI-review MAJOR fix (round 19): ports/notPorts live in the destination EntityRule, not the
    #    rule root — a rule-root `ports` (the pre-fix shape) must NOT restrict anything. ──────────

    def test_rule_root_ports_is_not_the_real_calico_shape_and_is_unmodeled(self):
        """A `ports` key placed at the rule root (not inside `destination`) is not a real Calico
        field. It must not be silently ignored either (that was the round-19-era behavior, before
        the round-21 allowlist) — an unrecognized rule shape is exactly the kind of thing this
        adapter cannot confidently reason about, so it degrades to `unknown`, not a confident
        `allowed` derived by pretending the field isn't there."""
        policies = [{"selector": "role == 'web'", "types": ["Ingress"], "ingress": [
            {"action": "Allow", "source": {"nets": ["0.0.0.0/0"]}, "ports": [80, 443]},
        ]}]
        r = ad.eval_calico_policy(policies, {"role": "web"}, "ingress", peer_ip="10.0.0.5",
                                   port=22, crd_present=True, observed_api_version=_CALICO_VERSION)
        assert r["status"] == "unknown"

    def test_destination_not_ports_is_unknown_not_a_guessed_match(self):
        policies = [{"selector": "role == 'web'", "types": ["Ingress"], "ingress": [
            {"action": "Allow", "source": {"nets": ["0.0.0.0/0"]},
             "destination": {"ports": [80, 443], "notPorts": [443]}},
        ]}]
        r = ad.eval_calico_policy(policies, {"role": "web"}, "ingress", peer_ip="10.0.0.5",
                                   port=80, crd_present=True, observed_api_version=_CALICO_VERSION)
        assert r["status"] == "unknown"

    def test_rule_level_not_protocol_is_unknown_not_a_guessed_match(self):
        policies = [{"selector": "role == 'web'", "types": ["Ingress"], "ingress": [
            {"action": "Allow", "notProtocol": "TCP", "source": {"nets": ["0.0.0.0/0"]}},
        ]}]
        r = ad.eval_calico_policy(policies, {"role": "web"}, "ingress", peer_ip="10.0.0.5",
                                   protocol="tcp", crd_present=True, observed_api_version=_CALICO_VERSION)
        assert r["status"] == "unknown"

    def test_egress_destination_ports_restrict_the_peer_port(self):
        """For egress, `destination` is already the peer being contacted — its `ports` must still
        restrict the match (not merely fail to break it)."""
        policies = [{"selector": "role == 'web'", "types": ["Egress"], "egress": [
            {"action": "Allow", "destination": {"nets": ["0.0.0.0/0"], "ports": [443]}},
        ]}]
        r = ad.eval_calico_policy(policies, {"role": "web"}, "egress", peer_ip="10.0.0.5",
                                   port=22, crd_present=True, observed_api_version=_CALICO_VERSION)
        assert r["status"] == "blocked"

    def test_missing_peer_labels_for_selector_peer_is_unknown_not_blocked(self):
        policies = [{"selector": "role == 'web'", "types": ["Ingress"], "ingress": [
            {"action": "Allow", "source": {"selector": "role == 'frontend'"}}]}]
        r = ad.eval_calico_policy(policies, {"role": "web"}, "ingress", peer_labels=None,
                                   crd_present=True, observed_api_version=_CALICO_VERSION)
        assert r["status"] == "unknown"

    def test_missing_pod_labels_for_a_non_trivial_policy_selector_is_unknown_not_allowed(self):
        """CI-review MAJOR fix (round 24): the `k8s-calico` wiring used to default `pod_labels`
        to `{}` on absence — indistinguishable from a REAL confirmed-empty label set, so a
        non-trivial policy selector confidently non-matched and the layer confidently `allowed`ed
        from data this worker never actually fetched. `None` must degrade to `unknown`."""
        policies = [{"selector": "role == 'web'", "types": ["Ingress"], "ingress": []}]
        r = ad.eval_calico_policy(policies, None, "ingress",
                                   crd_present=True, observed_api_version=_CALICO_VERSION)
        assert r["status"] == "unknown"

    # ── CI-review MAJOR fix (round 20): two more Calico holes. ─────────────────────────────────

    def test_missing_peer_namespace_labels_for_namespace_selector_is_unknown_not_a_guess(self):
        """A `None` peer_namespace_labels must not be silently treated as an EMPTY-but-present
        label set (which `_calico_selector_matches`'s own `labels or {}` normalization would do,
        making an `==` term confidently False and a `!=` term confidently True)."""
        policies = [{"selector": "role == 'web'", "types": ["Ingress"], "ingress": [
            {"action": "Allow", "source": {"namespaceSelector": "team == 'platform'"}}]}]
        r = ad.eval_calico_policy(policies, {"role": "web"}, "ingress", peer_namespace_labels=None,
                                   crd_present=True, observed_api_version=_CALICO_VERSION)
        assert r["status"] == "unknown"

    def test_ingress_destination_nets_constraint_is_unknown_not_ignored(self):
        """For ingress, `destination` (the protected workload) can carry its OWN `nets`/`selector`
        constraint — a real Calico field this adapter does not model at all. A rule allowing
        `source.nets: 0.0.0.0/0` only to `destination.nets: 10.0.1.0/24` must not confidently
        `allowed` a peer reaching a workload outside that net; it must degrade to `unknown`."""
        policies = [{"selector": "role == 'web'", "types": ["Ingress"], "ingress": [
            {"action": "Allow", "source": {"nets": ["0.0.0.0/0"]},
             "destination": {"nets": ["10.0.1.0/24"]}}]}]
        r = ad.eval_calico_policy(policies, {"role": "web"}, "ingress", peer_ip="10.0.0.5",
                                   crd_present=True, observed_api_version=_CALICO_VERSION)
        assert r["status"] == "unknown"

    def test_rule_level_ip_version_is_unknown_not_ignored(self):
        policies = [{"selector": "role == 'web'", "types": ["Ingress"], "ingress": [
            {"action": "Allow", "ipVersion": 4, "source": {"nets": ["0.0.0.0/0"]}}]}]
        r = ad.eval_calico_policy(policies, {"role": "web"}, "ingress", peer_ip="10.0.0.5",
                                   crd_present=True, observed_api_version=_CALICO_VERSION)
        assert r["status"] == "unknown"

    # ── CI-review MAJOR fix (round 21): the round-18/19/20 deny-list guard covered one more
    #    unmodeled field each round; converted to an allowlist so an ARBITRARY unmodeled field
    #    (not just the specific ones already caught) forces `unknown`. ───────────────────────────

    def test_entity_service_accounts_constraint_is_unknown_not_a_guaranteed_match(self):
        """A rule scoped ONLY by `source.serviceAccounts` (no nets/selector/namespaceSelector at
        all) used to fall into the "no peer criteria" branch and confidently match ANY peer —
        `serviceAccounts` is a real, unmodeled Calico field, not the absence of a constraint."""
        policies = [{"selector": "role == 'web'", "types": ["Ingress"], "ingress": [
            {"action": "Allow", "source": {"serviceAccounts": {"names": ["frontend-sa"]}}}]}]
        r = ad.eval_calico_policy(policies, {"role": "web"}, "ingress", peer_ip="10.0.0.5",
                                   crd_present=True, observed_api_version=_CALICO_VERSION)
        assert r["status"] == "unknown"

    def test_entity_not_namespace_selector_is_unknown_not_ignored(self):
        policies = [{"selector": "role == 'web'", "types": ["Ingress"], "ingress": [
            {"action": "Allow", "source": {"nets": ["0.0.0.0/0"], "notNamespaceSelector": "team == 'x'"}}]}]
        r = ad.eval_calico_policy(policies, {"role": "web"}, "ingress", peer_ip="10.0.0.5",
                                   crd_present=True, observed_api_version=_CALICO_VERSION)
        assert r["status"] == "unknown"

    def test_source_side_ports_restriction_is_unknown_not_ignored(self):
        """`ports`/`notPorts` on `source` (the sender's OWN port, distinct from the connection's
        destination port always read from `destination`) is a real, if unusual, Calico field this
        adapter never evaluates — its presence must not be silently dropped."""
        policies = [{"selector": "role == 'web'", "types": ["Ingress"], "ingress": [
            {"action": "Allow", "source": {"nets": ["0.0.0.0/0"], "ports": [1024]}}]}]
        r = ad.eval_calico_policy(policies, {"role": "web"}, "ingress", peer_ip="10.0.0.5",
                                   crd_present=True, observed_api_version=_CALICO_VERSION)
        assert r["status"] == "unknown"

    def test_rule_level_icmp_field_is_unknown_not_ignored(self):
        policies = [{"selector": "role == 'web'", "types": ["Ingress"], "ingress": [
            {"action": "Allow", "icmp": {"type": 8}, "source": {"nets": ["0.0.0.0/0"]}}]}]
        r = ad.eval_calico_policy(policies, {"role": "web"}, "ingress", peer_ip="10.0.0.5",
                                   crd_present=True, observed_api_version=_CALICO_VERSION)
        assert r["status"] == "unknown"

    # ── CI-review MAJOR fix (round 22): the rule-level protocol check and the port-entry match
    #    were both re-litigating protocol against a value Calico's `ports` shape doesn't carry,
    #    producing a confident false `blocked` for a genuinely matching UDP/numeric-protocol rule.

    def test_udp_only_rule_with_destination_ports_still_allows_udp(self):
        """CI-review MAJOR fix (round 22, part b): `_normalize_calico_ports` entries carry no
        `protocol` key, so `_k8s_port_matches`'s own "absent per-entry protocol defaults to TCP"
        contract used to reject every entry of a UDP-only rule's port restriction — even though
        the rule-level protocol check just above had already confirmed the match."""
        policies = [{"selector": "role == 'web'", "types": ["Ingress"], "ingress": [
            {"action": "Allow", "protocol": "UDP", "source": {"nets": ["0.0.0.0/0"]},
             "destination": {"ports": [53]}}]}]
        r = ad.eval_calico_policy(policies, {"role": "web"}, "ingress", peer_ip="10.0.0.5",
                                   protocol="udp", port=53, crd_present=True,
                                   observed_api_version=_CALICO_VERSION)
        assert r["status"] == "allowed"

    def test_numeric_protocol_spelling_matches_the_named_equivalent(self):
        """CI-review MAJOR fix (round 22, part a): Calico's `protocol` is a `numorstring` —
        `protocol: 17` is a valid spelling of UDP, but a bare textual comparison
        (`str(17).upper() != "UDP"`) made this confidently NOT match."""
        policies = [{"selector": "role == 'web'", "types": ["Ingress"], "ingress": [
            {"action": "Allow", "protocol": 17, "source": {"nets": ["0.0.0.0/0"]}}]}]
        r = ad.eval_calico_policy(policies, {"role": "web"}, "ingress", peer_ip="10.0.0.5",
                                   protocol="udp", crd_present=True, observed_api_version=_CALICO_VERSION)
        assert r["status"] == "allowed"

    def test_unrecognized_numeric_protocol_is_unknown_not_a_guessed_mismatch(self):
        policies = [{"selector": "role == 'web'", "types": ["Ingress"], "ingress": [
            {"action": "Allow", "protocol": 47, "source": {"nets": ["0.0.0.0/0"]}}]}]
        r = ad.eval_calico_policy(policies, {"role": "web"}, "ingress", peer_ip="10.0.0.5",
                                   protocol="tcp", crd_present=True, observed_api_version=_CALICO_VERSION)
        assert r["status"] == "unknown"

    def test_rule_with_no_action_field_matching_the_peer_is_unknown_not_a_guessed_allow(self):
        """CI-review MAJOR fix (round 25): `action` is a REQUIRED field on a real Calico v3
        `Rule` — an absent `action` is malformed/partially-fetched data, not "no constraint."
        A bare rule with no peer/port criteria at all would confidently match ANY peer; defaulting
        the missing action to `Allow` let that reach a confident `allowed` for a rule whose real
        action might be `Deny`."""
        policies = [{"selector": "role == 'web'", "types": ["Ingress"], "ingress": [{}]}]
        r = ad.eval_calico_policy(policies, {"role": "web"}, "ingress",
                                   crd_present=True, observed_api_version=_CALICO_VERSION)
        assert r["status"] == "unknown"

    def test_rule_with_a_malformed_action_value_is_unknown_not_a_guessed_deny(self):
        """CI-review MINOR fix (round 26): the round-25 guard only caught an ABSENT `action` key
        — a PRESENT-but-malformed value (e.g. a typo) used to fall through to `action != "allow"`,
        which treats anything not spelled exactly `"allow"` as Deny/Pass-like. A garbled value
        could just as easily have MEANT `Allow`; only the four real Calico actions are now
        recognized as confidently non-Allow."""
        policies = [{"selector": "role == 'web'", "types": ["Ingress"], "ingress": [
            {"action": "Alow", "source": {"nets": ["0.0.0.0/0"]}}]}]
        r = ad.eval_calico_policy(policies, {"role": "web"}, "ingress", peer_ip="10.0.0.5",
                                   crd_present=True, observed_api_version=_CALICO_VERSION)
        assert r["status"] == "unknown"
        # CI-review MINOR fix (round 27): the diagnostic text used to assert the field was
        # entirely absent even for a present-but-malformed value like "Alow" — verify the wording
        # now correctly covers both cases.
        assert "absent or unrecognized" in r["summary"]
        assert "no `action` at all" not in r["summary"]

    def test_egress_source_side_selector_constraint_is_unknown_not_ignored(self):
        """Symmetric to round 20's ingress-side `destination` guard: for EGRESS, `destination` is
        the peer being matched, but `source` (the workload itself) can still carry its own
        `selector`/`nets` constraint that this adapter never evaluates for egress."""
        policies = [{"selector": "role == 'web'", "types": ["Egress"], "egress": [
            {"action": "Allow", "source": {"selector": "tier == 'restricted'"},
             "destination": {"nets": ["0.0.0.0/0"]}}]}]
        r = ad.eval_calico_policy(policies, {"role": "web"}, "egress", peer_ip="10.0.0.5",
                                   crd_present=True, observed_api_version=_CALICO_VERSION)
        assert r["status"] == "unknown"

    def test_data_unavailable_is_unknown_not_allowed(self):
        r = ad.eval_calico_policy([], {}, "ingress", crd_present=True,
                                   observed_api_version=_CALICO_VERSION, data_available=False)
        assert r["status"] == "unknown"

    def test_omitted_types_defaults_on_rule_presence_like_calico_docs(self):
        # Calico's own omitted-types default differs from core K8s's (_policy_type_applies):
        # symmetric rule-presence defaulting for BOTH directions, not "Ingress always applies".
        policies = [{"selector": "role == 'web'", "egress": []}]  # no "types", no "ingress" key
        ingress_result = ad.eval_calico_policy(policies, {"role": "web"}, "ingress",
                                                crd_present=True, observed_api_version=_CALICO_VERSION)
        egress_result = ad.eval_calico_policy(policies, {"role": "web"}, "egress",
                                               crd_present=True, observed_api_version=_CALICO_VERSION)
        assert ingress_result["status"] == "allowed"  # no "ingress" key -> Ingress type doesn't apply
        assert egress_result["status"] == "blocked"   # "egress" key present -> selected, no rule matches

    def test_policy_level_unmodeled_field_is_unknown_not_ignored(self):
        """CI-review MAJOR fix (round 23): round 21's allowlist principle applied to Rule/
        EntityRule keys only — a real Calico POLICY spec field this adapter never reads (e.g.
        `serviceAccountSelector`) could scope the policy away from this pod entirely silently,
        so its presence must degrade the result, not be ignored."""
        policies = [{"selector": "role == 'web'", "types": ["Ingress"], "ingress": [],
                     "serviceAccountSelector": "team == 'platform'"}]
        r = ad.eval_calico_policy(policies, {"role": "web"}, "ingress",
                                   crd_present=True, observed_api_version=_CALICO_VERSION)
        assert r["status"] == "unknown"

    def test_no_rules_at_all_and_omitted_types_still_defaults_to_ingress_selected(self):
        """CI-review MAJOR fix (round 23): a policy with NEITHER an `ingress` NOR an `egress` key,
        and no `types`, is a valid Calico default-deny shape — real Calico defaults `types` to
        `[Ingress]` whenever there are no egress rules (this case has none), so the policy SHOULD
        select the pod for Ingress and reduce to `blocked`. The old "symmetric rule presence"
        defaulting treated this as not-selecting-at-all and confidently `allowed`ed instead."""
        policies = [{"selector": "role == 'web'"}]  # no "types", no "ingress"/"egress" keys at all
        r = ad.eval_calico_policy(policies, {"role": "web"}, "ingress",
                                   crd_present=True, observed_api_version=_CALICO_VERSION)
        assert r["status"] == "blocked"

    def test_both_ingress_and_egress_keys_with_omitted_types_still_selects_ingress(self):
        """CI-review MAJOR fix (round 24): the round-23 fix regressed this case — a policy with
        BOTH `ingress` and `egress` keys and omitted `types` real-Calico-defaults to
        `[Ingress, Egress]` (both apply), but the round-23 formula (`"egress" not in policy`)
        excluded Ingress here since an `egress` key IS present. A genuinely ingress-governing
        policy must still select the pod for Ingress."""
        policies = [{"selector": "role == 'web'", "ingress": [], "egress": []}]
        r = ad.eval_calico_policy(policies, {"role": "web"}, "ingress",
                                   crd_present=True, observed_api_version=_CALICO_VERSION)
        assert r["status"] == "blocked"  # selected for Ingress, no Allow rule matches


# ── Gap 3: Route 53 resolution — REAL evaluation of already-fetched zone data ──────────────────

class TestRoute53Resolution:
    def test_no_data_is_unknown(self):
        r = ad.eval_route53_resolution([], "app.example.com", data_available=False)
        assert r["status"] == "unknown"

    def test_no_matching_record_is_blocked(self):
        records = [{"name": "other.example.com", "type": "A"}]
        r = ad.eval_route53_resolution(records, "app.example.com")
        assert r["status"] == "blocked"

    def test_exact_match_healthy_allows(self):
        records = [{"name": "app.example.com", "type": "A", "health_check_status": None}]
        r = ad.eval_route53_resolution(records, "app.example.com")
        assert r["status"] == "allowed"

    def test_wildcard_match_allows(self):
        records = [{"name": "*.example.com", "type": "A"}]
        r = ad.eval_route53_resolution(records, "app.example.com")
        assert r["status"] == "allowed"

    def test_query_name_existing_as_an_empty_non_terminal_gets_no_wildcard_synthesis(self):
        """CI-review MAJOR fix (round 21): the query name ITSELF can exist in the zone as an
        empty non-terminal (has descendants, no RRset of its own) — real DNS answers NODATA/
        NXDOMAIN for it, never a wildcard match, regardless of a farther ancestor's wildcard.
        Here `b.example.com` exists solely because `x.b.example.com` is a real record; querying
        `b.example.com` directly must not synthesize from `*.example.com`."""
        records = [
            {"name": "x.b.example.com", "type": "A"},
            {"name": "*.example.com", "type": "A"},
        ]
        r = ad.eval_route53_resolution(records, "b.example.com")
        assert r["status"] == "blocked"

    def test_name_under_an_ns_delegated_closest_encloser_is_unknown_not_blocked(self):
        """CI-review MAJOR fix (round 25): if the closest encloser of the query name owns an NS
        RRset, the query name falls under a zone DELEGATION — the real answer lives in a child
        zone this evaluator was never given any data for. Returning a confident `blocked`
        (NXDOMAIN) is wrong; the fetched NS record itself proves resolution continues elsewhere.
        (Round 28: an apex SOA row is included so `_delegation_check_armed` — this evaluator's
        own signal that the fetched set is a real zone sweep, not a producer that never emits
        SOA at all — is set, matching every other delegation fixture in this class.)"""
        records = [
            {"name": "example.com", "type": "SOA"},
            {"name": "delegated.example.com", "type": "NS", "alias_target": None},
        ]
        r = ad.eval_route53_resolution(records, "sub.delegated.example.com")
        assert r["status"] == "unknown"

    def test_zone_apex_ns_with_soa_is_not_a_delegation_and_nxdomain_still_blocks(self):
        """CI-review MAJOR fix (round 26): the round-25 delegation check misclassified the ZONE
        APEX's own NS RRset as a delegation — every real hosted zone carries an authoritative NS
        (and SOA) RRset at its apex, and the apex is frequently the closest encloser for any
        flat, non-delegated name (e.g. `foo.example.com` closest-enclosed by `example.com`). A
        delegation point never carries an SOA; the apex always does — NS-without-SOA is the real
        signal. A genuine NXDOMAIN under a normal (non-delegated) apex must still `blocked`."""
        records = [
            {"name": "example.com", "type": "NS"},
            {"name": "example.com", "type": "SOA"},
        ]
        r = ad.eval_route53_resolution(records, "foo.example.com")
        assert r["status"] == "blocked"

    def test_zone_apex_wildcard_synthesis_still_works_despite_apex_ns_soa(self):
        records = [
            {"name": "example.com", "type": "NS"},
            {"name": "example.com", "type": "SOA"},
            {"name": "*.example.com", "type": "A"},
        ]
        r = ad.eval_route53_resolution(records, "foo.example.com")
        assert r["status"] == "allowed"

    def test_exact_match_below_a_delegation_cut_is_unknown_not_a_confident_allowed(self):
        """CI-review MAJOR fix (round 27): the round-25/26 delegation check only ran on the
        closest-encloser-MISS (NXDOMAIN) path — an EXACT match below a delegation cut (e.g. stale
        parent-zone glue data: `ns.delegated.example.com A` alongside `delegated.example.com NS`,
        no SOA) used to return `by_name[name]` immediately, bypassing every delegation check and
        reaching a confident `allowed` even though the real answer is occluded in the child zone.
        The delegation check now runs FIRST, over every strict ancestor, before exact-match.
        (Round 28: an apex SOA row is included so `_delegation_check_armed` is set.)"""
        records = [
            {"name": "example.com", "type": "SOA"},
            {"name": "delegated.example.com", "type": "NS"},
            {"name": "ns.delegated.example.com", "type": "A"},
        ]
        r = ad.eval_route53_resolution(records, "ns.delegated.example.com")
        assert r["status"] == "unknown"

    def test_delegation_cut_above_the_closest_existing_node_is_still_caught(self):
        """CI-review MAJOR fix (round 27): the round-25/26 delegation check only inspected the
        CLOSEST EXISTING node — a query one level below that (e.g. `x.ns.delegated.example.com`,
        whose closest existing node is `ns.delegated.example.com`, itself one level below the
        actual NS cut at `delegated.example.com`) never saw the delegation at all and reached a
        confident `blocked` (NXDOMAIN). Walking every strict ancestor (not just the nearest
        existing one) now catches a cut at any distance.
        (Round 28: an apex SOA row is included so `_delegation_check_armed` is set.)"""
        records = [
            {"name": "example.com", "type": "SOA"},
            {"name": "delegated.example.com", "type": "NS"},
            {"name": "ns.delegated.example.com", "type": "A"},
        ]
        r = ad.eval_route53_resolution(records, "x.ns.delegated.example.com")
        assert r["status"] == "unknown"

    def test_query_name_itself_at_the_delegation_cut_is_unknown_not_allowed(self):
        """CI-review MAJOR fix (round 28): the round-27 walk still used `range(1, ...)` — STRICT
        ancestors only — so a query for the delegation cut NAME ITSELF (`delegated.example.com`,
        which owns both the NS-without-SOA cut AND a same-owner `A` row — occluded parent-zone
        glue, real shape) hit `name in by_name` before ever reaching the delegation check, and
        reached a confident `allowed`. The walk now starts at `i=0` (the name itself)."""
        records = [
            {"name": "example.com", "type": "SOA"},
            {"name": "delegated.example.com", "type": "NS"},
            {"name": "delegated.example.com", "type": "A"},
        ]
        r = ad.eval_route53_resolution(records, "delegated.example.com")
        assert r["status"] == "unknown"

    def test_ns_without_soa_anywhere_in_the_payload_is_still_unknown_not_blocked(self):
        """CI-review MAJOR fix (round 29): round 28's own fix over-corrected — it "disarmed" the
        delegation check entirely whenever the fetched set had zero SOA rows anywhere, which made
        this EXACT payload (the round-25 regression fixture) return a confident `blocked`
        instead of `unknown`. But an NS row is still affirmative evidence resolution continues
        elsewhere, regardless of whether this payload happens to carry an SOA row too — `blocked`
        is exactly as wrong here as the round-26 apex misclassification was in the OTHER
        direction. `_delegation_check_armed` now only changes the summary's wording (whether this
        evaluator can rule out "producer never sends SOA" vs. a confirmed delegation), never the
        `unknown`-vs-`blocked` status: NS-without-SOA always degrades to `unknown`."""
        records = [{"name": "delegated.example.com", "type": "NS"}]  # no SOA anywhere at all
        r = ad.eval_route53_resolution(records, "sub.delegated.example.com")
        assert r["status"] == "unknown"

    def test_closer_empty_non_terminal_without_its_own_wildcard_blocks_a_farther_wildcard(self):
        """CI-review MAJOR fix (round 20): RFC 4592 wildcard synthesis is valid ONLY from the
        CLOSEST encloser, not from any ancestor with a wildcard child. Here `b.example.com` is a
        real node in the zone (it has a descendant, `x.b.example.com`) but has NO `*.b.example.com`
        wildcard of its own — that makes `a.b.example.com` genuinely NXDOMAIN, even though a
        FARTHER `*.example.com` wildcard exists; the round-19 fix (checking every ancestor,
        nearest first) would have incorrectly synthesized from the farther wildcard."""
        records = [
            {"name": "x.b.example.com", "type": "A"},
            {"name": "*.example.com", "type": "A"},
        ]
        r = ad.eval_route53_resolution(records, "a.b.example.com")
        assert r["status"] == "blocked"

    def test_ancestor_wildcard_beyond_the_immediate_parent_still_resolves(self):
        """CI-review MAJOR fix (round 19): the immediate parent of `a.b.example.com` is
        `b.example.com`, which has no wildcard record here — but `*.example.com` (a higher
        ancestor) does, and per RFC 4592 wildcard synthesis that still resolves the query. The
        pre-fix code checked only the immediate-parent wildcard and would confidently report
        `blocked` (NXDOMAIN) for this name."""
        records = [{"name": "*.example.com", "type": "A"}]
        r = ad.eval_route53_resolution(records, "a.b.example.com")
        assert r["status"] == "allowed"

    def test_all_unhealthy_is_unknown_not_confidently_blocked(self):
        """CI-review MAJOR fix (round 21): Route 53's documented behavior when every record fails
        its health check is FAIL-OPEN (answer as if healthy), not NXDOMAIN — a confident `blocked`
        here was itself a false verdict, the exact failure mode this module's contract forbids."""
        records = [{"name": "app.example.com", "type": "A", "health_check_status": "unhealthy"}]
        r = ad.eval_route53_resolution(records, "app.example.com")
        assert r["status"] == "unknown"

    def test_mixed_health_is_conditional(self):
        records = [
            {"name": "app.example.com", "type": "A", "health_check_status": "unhealthy"},
            {"name": "app.example.com", "type": "A", "health_check_status": "healthy"},
        ]
        r = ad.eval_route53_resolution(records, "app.example.com")
        assert r["status"] == "conditional"

    def test_cname_chain_is_followed(self):
        records = [
            {"name": "app.example.com", "type": "CNAME", "alias_target": "lb.example.com"},
            {"name": "lb.example.com", "type": "A"},
        ]
        r = ad.eval_route53_resolution(records, "app.example.com")
        assert r["status"] == "allowed"

    def test_cname_hop_landing_on_a_multi_pointer_set_is_unknown_not_allowed(self):
        """CI-review MAJOR fix (round 25): the multi-pointer ambiguity guard only ever ran on
        the ENTRY name — a CNAME hop landing on a weighted/failover SET of >=2 ALIAS records
        (ALIAS being an address type) exited the chain-following loop silently (its own
        `len(matched) == 1` condition just stops matching) and reached the health-check block
        with neither pointer's own target checked."""
        records = [
            {"name": "app.example.com", "type": "CNAME", "alias_target": "lb.example.com"},
            {"name": "lb.example.com", "type": "ALIAS", "alias_target": "primary.example.com", "failover": "PRIMARY"},
            {"name": "lb.example.com", "type": "ALIAS", "alias_target": "secondary.example.com", "failover": "SECONDARY"},
        ]
        r = ad.eval_route53_resolution(records, "app.example.com")
        assert r["status"] == "unknown"

    def test_no_query_host_is_unknown(self):
        r = ad.eval_route53_resolution([{"name": "app.example.com", "type": "A"}], None)
        assert r["status"] == "unknown"

    def test_cname_cycle_is_unknown_not_allowed(self):
        """MINOR fix: a genuine CNAME cycle (a hits b hits a) must not fall through to a confident
        `allowed` using the stale record from before the cycle was detected."""
        records = [
            {"name": "a.example.com", "type": "CNAME", "alias_target": "b.example.com"},
            {"name": "b.example.com", "type": "CNAME", "alias_target": "a.example.com"},
        ]
        r = ad.eval_route53_resolution(records, "a.example.com")
        assert r["status"] == "unknown"

    # ── CI-review MAJOR fix (round 18): an out-of-zone CNAME target (not a cycle, just genuinely
    #    absent from the fetched zone data) used to fall through to a confident `allowed` using the
    #    stale CNAME record itself — the target's OWN resolvability is unconfirmed (could be
    #    NXDOMAIN, could resolve fine elsewhere); this is a distinct case from a genuine cycle, but
    #    both must degrade to `unknown`, not `allowed`. ─────────────────────────────────────────────

    def test_out_of_zone_cname_target_not_a_cycle_is_unknown_not_allowed(self):
        records = [{"name": "app.example.com", "type": "CNAME", "alias_target": "external.other-domain.com"}]
        r = ad.eval_route53_resolution(records, "app.example.com")
        assert r["status"] == "unknown"

    def test_a_record_at_the_matched_name_still_allows(self):
        """A genuinely address-resolving record type (A) still reports `allowed` — the round-18
        fix scopes to non-address types (TXT/MX/etc.) and unresolved CNAME targets, not this case."""
        records = [{"name": "app.example.com", "type": "A"}]
        r = ad.eval_route53_resolution(records, "app.example.com")
        assert r["status"] == "allowed"

    def test_txt_only_record_is_unknown_not_allowed(self):
        """A TXT (or MX, etc.) record proves nothing about address resolution."""
        records = [{"name": "app.example.com", "type": "TXT"}]
        r = ad.eval_route53_resolution(records, "app.example.com")
        assert r["status"] == "unknown"

    # ── CI-review MAJOR fix (round 22): ALIAS is exactly as much a pointer as CNAME — it carries
    #    no address data of its own — but was never chain-followed, only trusted terminally.

    def test_out_of_zone_alias_target_is_unknown_not_allowed(self):
        records = [{"name": "app.example.com", "type": "ALIAS", "alias_target": "external-lb.other-domain.com"}]
        r = ad.eval_route53_resolution(records, "app.example.com")
        assert r["status"] == "unknown"

    def test_multiple_alias_pointer_records_at_the_same_name_is_unknown_not_allowed(self):
        """CI-review MAJOR fix (round 23): a weighted/failover/latency routing-policy SET of >=2
        ALIAS records at the same name is a real, supported Route 53 shape — chain-following only
        ran for a SINGLE matched record, so this set skipped it entirely and (since ALIAS is an
        address type) reported a confident `allowed` without ever checking either pointer's own
        target. Which record answers, and whether its target resolves, is unmodeled — `unknown`."""
        records = [
            {"name": "app.example.com", "type": "ALIAS", "alias_target": "primary.example.com", "failover": "PRIMARY"},
            {"name": "app.example.com", "type": "ALIAS", "alias_target": "secondary.example.com", "failover": "SECONDARY"},
        ]
        r = ad.eval_route53_resolution(records, "app.example.com")
        assert r["status"] == "unknown"

    def test_alias_with_no_target_data_at_all_is_unknown_not_allowed(self):
        """CI-review MAJOR fix (round 24): the chain-following loop's condition requires
        `alias_target` to be truthy — a single matched ALIAS record with a missing/None target
        never enters the loop and used to fall through to a confident `allowed` since ALIAS is
        an address type. Its own resolvability was never actually confirmed."""
        records = [{"name": "app.example.com", "type": "ALIAS", "alias_target": None}]
        r = ad.eval_route53_resolution(records, "app.example.com")
        assert r["status"] == "unknown"

    def test_mixed_set_with_one_targetless_alias_and_others_is_unknown(self):
        """CI-review MAJOR fix (round 24): the round-23 multi-pointer guard used `all(...)`,
        vacuously satisfied-false by a mixed set (one CNAME/ALIAS record missing its own
        `alias_target`, plus an unrelated record) — bypassing the guard entirely. Any CNAME/ALIAS
        pointer in a multi-record set makes the set ambiguous, well-formed or not."""
        records = [
            {"name": "app.example.com", "type": "ALIAS", "alias_target": None},
            {"name": "app.example.com", "type": "A"},
        ]
        r = ad.eval_route53_resolution(records, "app.example.com")
        assert r["status"] == "unknown"

    def test_in_zone_alias_target_is_followed_to_its_real_address_record(self):
        records = [
            {"name": "app.example.com", "type": "ALIAS", "alias_target": "lb.example.com"},
            {"name": "lb.example.com", "type": "A"},
        ]
        r = ad.eval_route53_resolution(records, "app.example.com")
        assert r["status"] == "allowed"


# ── Gap 3: K8s Ingress -> Service -> EndpointSlice resolution — REAL evaluation ─────────────────

class TestK8sServiceResolution:
    def test_no_data_is_unknown(self):
        r = ad.eval_k8s_service_resolution([], {}, {}, {"host": "app.example.com"}, data_available=False)
        assert r["status"] == "unknown"

    def test_no_matching_ingress_rule_is_blocked(self):
        rules = [{"host": "other.example.com", "backend_service": "svc-a"}]
        r = ad.eval_k8s_service_resolution(rules, {}, {}, {"host": "app.example.com", "path": "/"})
        assert r["status"] == "blocked"

    def test_missing_backend_service_is_blocked(self):
        rules = [{"host": "app.example.com", "backend_service": "svc-missing"}]
        r = ad.eval_k8s_service_resolution(rules, {}, {}, {"host": "app.example.com", "path": "/"})
        assert r["status"] == "blocked"

    def test_no_endpoints_is_blocked(self):
        rules = [{"host": "app.example.com", "backend_service": "svc-a"}]
        services = {"svc-a": {"selector": {"app": "a"}, "ports": [{"port": 80}]}}
        r = ad.eval_k8s_service_resolution(rules, services, {"svc-a": []}, {"host": "app.example.com", "path": "/"})
        assert r["status"] == "blocked"

    def test_all_endpoints_ready_allows(self):
        rules = [{"host": "app.example.com", "backend_service": "svc-a"}]
        services = {"svc-a": {"selector": {"app": "a"}, "ports": [{"port": 80}]}}
        eps = {"svc-a": [{"ready": True}, {"ready": True}]}
        r = ad.eval_k8s_service_resolution(rules, services, eps, {"host": "app.example.com", "path": "/"})
        assert r["status"] == "allowed"

    def test_partial_ready_is_conditional(self):
        rules = [{"host": "app.example.com", "backend_service": "svc-a"}]
        services = {"svc-a": {"selector": {"app": "a"}, "ports": [{"port": 80}]}}
        eps = {"svc-a": [{"ready": True}, {"ready": False}]}
        r = ad.eval_k8s_service_resolution(rules, services, eps, {"host": "app.example.com", "path": "/"})
        assert r["status"] == "conditional"

    def test_null_or_missing_ready_is_treated_as_ready(self):
        """MINOR fix: EndpointSlice `ready: null`/missing means unknown per Kubernetes'
        EndpointConditions guidance — treated as ready, not unready. Only an explicit `false`
        counts as genuinely not ready."""
        rules = [{"host": "app.example.com", "backend_service": "svc-a"}]
        services = {"svc-a": {"selector": {"app": "a"}, "ports": [{"port": 80}]}}
        eps = {"svc-a": [{"ready": None}, {}]}
        r = ad.eval_k8s_service_resolution(rules, services, eps, {"host": "app.example.com", "path": "/"})
        assert r["status"] == "allowed"

    def test_path_prefix_match(self):
        rules = [{"host": "app.example.com", "path": "/api", "path_type": "Prefix",
                   "backend_service": "svc-a"}]
        services = {"svc-a": {"selector": {"app": "a"}, "ports": [{"port": 80}]}}
        eps = {"svc-a": [{"ready": True}]}
        r = ad.eval_k8s_service_resolution(rules, services, eps,
                                            {"host": "app.example.com", "path": "/api/v1"})
        assert r["status"] == "allowed"

    def test_path_exact_mismatch_blocks(self):
        rules = [{"host": "app.example.com", "path": "/api", "path_type": "Exact",
                   "backend_service": "svc-a"}]
        r = ad.eval_k8s_service_resolution(rules, {}, {}, {"host": "app.example.com", "path": "/api/v1"})
        assert r["status"] == "blocked"

    # ── CI-review MAJOR fix (round 17): `backend_port` was never checked against the Service's own
    #    declared ports — an Ingress referencing a nonexistent Service port returned `allowed`
    #    whenever any endpoint happened to be ready. ────────────────────────────────────────────────

    def test_backend_port_not_declared_on_service_blocks(self):
        rules = [{"host": "app.example.com", "backend_service": "svc-a", "backend_port": 9999}]
        services = {"svc-a": {"selector": {"app": "a"}, "ports": [{"port": 80, "target_port": 8080}]}}
        eps = {"svc-a": [{"ready": True}]}
        r = ad.eval_k8s_service_resolution(rules, services, eps, {"host": "app.example.com", "path": "/"})
        assert r["status"] == "blocked"
        assert "9999" in r["summary"]

    def test_backend_port_declared_on_service_allows(self):
        rules = [{"host": "app.example.com", "backend_service": "svc-a", "backend_port": 80}]
        services = {"svc-a": {"selector": {"app": "a"}, "ports": [{"port": 80, "target_port": 8080}]}}
        eps = {"svc-a": [{"ready": True}]}
        r = ad.eval_k8s_service_resolution(rules, services, eps, {"host": "app.example.com", "path": "/"})
        assert r["status"] == "allowed"

    def test_no_backend_port_declared_skips_the_port_check(self):
        """No `backend_port` on the Ingress rule at all (e.g. a name-based backend port) — nothing
        to validate, must not spuriously block."""
        rules = [{"host": "app.example.com", "backend_service": "svc-a"}]
        services = {"svc-a": {"selector": {"app": "a"}, "ports": [{"port": 80, "target_port": 8080}]}}
        eps = {"svc-a": [{"ready": True}]}
        r = ad.eval_k8s_service_resolution(rules, services, eps, {"host": "app.example.com", "path": "/"})
        assert r["status"] == "allowed"

    def test_no_backend_port_declared_against_a_multi_port_service_is_unknown(self):
        """CI-review MAJOR fix (round 20): real K8s only accepts an omitted `backend_port` when
        the Service declares EXACTLY ONE port — an omitted reference against a multi-port Service
        is an incomplete/malformed backend that must not confidently `allowed` without proving
        which port is actually targeted."""
        rules = [{"host": "app.example.com", "backend_service": "svc-a"}]
        services = {"svc-a": {"selector": {"app": "a"},
                               "ports": [{"port": 80}, {"port": 443}]}}
        eps = {"svc-a": [{"ready": True}]}
        r = ad.eval_k8s_service_resolution(rules, services, eps, {"host": "app.example.com", "path": "/"})
        assert r["status"] == "unknown"

    # ── CI-review MAJOR fix (round 18): Ingress rule selection used to be plain first-match — real
    #    K8s precedence is exact-host > wildcard-host > no-host, and Exact > longest-Prefix >
    #    ImplementationSpecific. ──────────────────────────────────────────────────────────────────

    def test_exact_path_wins_over_a_shorter_prefix_to_a_different_service(self):
        rules = [
            {"host": "app.example.com", "path": "/api", "path_type": "Prefix", "backend_service": "svc-prefix"},
            {"host": "app.example.com", "path": "/api/v1", "path_type": "Exact", "backend_service": "svc-exact"},
        ]
        services = {
            "svc-prefix": {"ports": [{"port": 80}]},
            "svc-exact": {"ports": [{"port": 80}]},
        }
        eps = {"svc-prefix": [{"ready": True}], "svc-exact": [{"ready": True}]}
        r = ad.eval_k8s_service_resolution(rules, services, eps, {"host": "app.example.com", "path": "/api/v1"})
        assert r["status"] == "allowed"
        assert r["resource"] == "svc-exact"

    def test_longest_prefix_wins_over_a_shorter_one(self):
        rules = [
            {"host": "app.example.com", "path": "/api", "path_type": "Prefix", "backend_service": "svc-short"},
            {"host": "app.example.com", "path": "/api/v1", "path_type": "Prefix", "backend_service": "svc-long"},
        ]
        services = {
            "svc-short": {"ports": [{"port": 80}]},
            "svc-long": {"ports": [{"port": 80}]},
        }
        eps = {"svc-short": [{"ready": True}], "svc-long": [{"ready": True}]}
        r = ad.eval_k8s_service_resolution(rules, services, eps, {"host": "app.example.com", "path": "/api/v1/x"})
        assert r["resource"] == "svc-long"

    def test_exact_host_wins_over_a_wildcard_host(self):
        rules = [
            {"host": "*.example.com", "backend_service": "svc-wildcard"},
            {"host": "app.example.com", "backend_service": "svc-exact-host"},
        ]
        services = {
            "svc-wildcard": {"ports": [{"port": 80}]},
            "svc-exact-host": {"ports": [{"port": 80}]},
        }
        eps = {"svc-wildcard": [{"ready": True}], "svc-exact-host": [{"ready": True}]}
        r = ad.eval_k8s_service_resolution(rules, services, eps, {"host": "app.example.com", "path": "/"})
        assert r["resource"] == "svc-exact-host"

    def test_wildcard_host_matches_a_subdomain(self):
        """A wildcard host was never matched at all before round 18 — only bare equality —
        producing a confident false `blocked` for a real wildcard-routed request."""
        rules = [{"host": "*.example.com", "backend_service": "svc-a"}]
        services = {"svc-a": {"ports": [{"port": 80}]}}
        eps = {"svc-a": [{"ready": True}]}
        r = ad.eval_k8s_service_resolution(rules, services, eps, {"host": "app.example.com", "path": "/"})
        assert r["status"] == "allowed"

    def test_wildcard_host_does_not_match_the_bare_parent_domain(self):
        rules = [{"host": "*.example.com", "backend_service": "svc-a"}]
        r = ad.eval_k8s_service_resolution(rules, {}, {}, {"host": "example.com", "path": "/"})
        assert r["status"] == "blocked"

    def test_host_matching_is_case_insensitive_and_ignores_trailing_dot(self):
        """CI-review MAJOR fix (round 24): DNS hostnames are case-insensitive and a trailing dot
        is a valid FQDN form — a raw comparison confidently failed to match either variation."""
        rules = [{"host": "app.example.com", "backend_service": "svc-a"}]
        services = {"svc-a": {"ports": [{"port": 80}]}}
        eps = {"svc-a": [{"ready": True}]}
        r = ad.eval_k8s_service_resolution(rules, services, eps, {"host": "APP.EXAMPLE.COM.", "path": "/"})
        assert r["status"] == "allowed"

    def test_missing_request_host_with_a_host_scoped_rule_present_is_unknown(self):
        """CI-review MAJOR fix (round 24): a request with NO host at all used to silently fail
        every host-scoped rule as a confident non-match, so a host-scoped-only rule set could
        reach a confident `blocked` from evidence that actually proves nothing about the real
        (unknown) request host."""
        rules = [{"host": "app.example.com", "backend_service": "svc-a"}]
        services = {"svc-a": {"ports": [{"port": 80}]}}
        eps = {"svc-a": [{"ready": True}]}
        r = ad.eval_k8s_service_resolution(rules, services, eps, {"host": None, "path": "/"})
        assert r["status"] == "unknown"

    def test_wildcard_host_does_not_match_a_multi_label_subdomain(self):
        """CI-review MAJOR fix (round 19): a K8s Ingress wildcard covers exactly ONE DNS label —
        `*.example.com` matches `api.example.com` but must NOT match `a.b.example.com`."""
        rules = [{"host": "*.example.com", "backend_service": "svc-a"}]
        services = {"svc-a": {"ports": [{"port": 80}]}}
        eps = {"svc-a": [{"ready": True}]}
        r = ad.eval_k8s_service_resolution(rules, services, eps, {"host": "a.b.example.com", "path": "/"})
        assert r["status"] == "blocked"

    def test_implementation_specific_path_type_with_a_path_is_unknown_not_guessed(self):
        """ImplementationSpecific path semantics are controller-defined — must not be silently
        treated as a Prefix match when no other rule confidently matches."""
        rules = [{"host": "app.example.com", "path": "/api", "path_type": "ImplementationSpecific",
                   "backend_service": "svc-a"}]
        r = ad.eval_k8s_service_resolution(rules, {}, {}, {"host": "app.example.com", "path": "/api/v1"})
        assert r["status"] == "unknown"

    def test_implementation_specific_rule_degrades_even_when_another_rule_confidently_matches(self):
        """CI-review MAJOR fix (round 20): an unresolvable, host-matching ImplementationSpecific
        rule must degrade the result to `unknown` even when a DIFFERENT rule (e.g. a catch-all
        with no path filter) also confidently matches — its controller-defined precedence
        relative to that other rule is exactly what this adapter cannot determine, so silently
        picking the other rule's backend is still a guess."""
        rules = [
            {"host": "app.example.com", "path": "/api", "path_type": "ImplementationSpecific",
             "backend_service": "svc-is"},
            {"host": "app.example.com", "backend_service": "svc-catchall"},
        ]
        services = {"svc-catchall": {"ports": [{"port": 80}]}}
        eps = {"svc-catchall": [{"ready": True}]}
        r = ad.eval_k8s_service_resolution(rules, services, eps,
                                            {"host": "app.example.com", "path": "/api/v1"})
        assert r["status"] == "unknown"

    def test_ambiguous_equally_specific_rules_to_different_services_is_unknown(self):
        rules = [
            {"host": "app.example.com", "backend_service": "svc-a"},
            {"host": "app.example.com", "backend_service": "svc-b"},
        ]
        r = ad.eval_k8s_service_resolution(rules, {}, {}, {"host": "app.example.com", "path": "/"})
        assert r["status"] == "unknown"

    def test_ambiguous_equally_specific_rules_to_the_same_service_different_ports_is_unknown(self):
        """CI-review MAJOR fix (round 22): the tie-break used to dedupe by `backend_service`
        alone — two equally-specific rules to the SAME Service but DIFFERENT ports must still
        degrade to `unknown`, not silently pick whichever rule happened to come first."""
        rules = [
            {"host": "app.example.com", "backend_service": "svc-a", "backend_port": 80},
            {"host": "app.example.com", "backend_service": "svc-a", "backend_port": 443},
        ]
        services = {"svc-a": {"ports": [{"port": 80}, {"port": 443}]}}
        eps = {"svc-a": [{"ready": True}]}
        r = ad.eval_k8s_service_resolution(rules, services, eps, {"host": "app.example.com", "path": "/"})
        assert r["status"] == "unknown"

    def test_backend_port_by_name_declared_on_service_allows(self):
        """`backend_port` can also be a NAME (Ingress `service.port.name`) — must be matched
        against the Service port's own `name` field, not its numeric `port`."""
        rules = [{"host": "app.example.com", "backend_service": "svc-a", "backend_port": "https"}]
        services = {"svc-a": {"selector": {"app": "a"},
                               "ports": [{"port": 443, "name": "https"}, {"port": 80, "name": "http"}]}}
        eps = {"svc-a": [{"ready": True}]}
        r = ad.eval_k8s_service_resolution(rules, services, eps, {"host": "app.example.com", "path": "/"})
        assert r["status"] == "allowed"

    def test_backend_port_by_name_not_declared_on_service_blocks(self):
        rules = [{"host": "app.example.com", "backend_service": "svc-a", "backend_port": "metrics"}]
        services = {"svc-a": {"selector": {"app": "a"},
                               "ports": [{"port": 443, "name": "https"}]}}
        eps = {"svc-a": [{"ready": True}]}
        r = ad.eval_k8s_service_resolution(rules, services, eps, {"host": "app.example.com", "path": "/"})
        assert r["status"] == "blocked"
        assert "metrics" in r["summary"]
