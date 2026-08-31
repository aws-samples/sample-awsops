"""Orchestration tests for network_path.py — resolve/discover/verify/conclude, deadline behavior,
multi-candidate independence, evidence redaction, PK-collision safety, and the grep-verifiable
`_test_http_connectivity`-never-called invariant."""
import glob
import json
import os

import pytest

import network_path as np
import network_path_adapters as ad


class FakeConn:
    """`node_rows_by_ref`/`edge_rows_by_node` let a test seed `fetch_live_topology`'s two SELECTs
    (against `topology_nodes`/`topology_edges`) without a real Aurora connection — keyed the same way
    `_find_infra_node`/`_infra_placement` build their own query params (`pat="%:" + ref`,
    `s=node_id`)."""
    def __init__(self, node_rows_by_ref=None, edge_rows_by_node=None, accounts_rows=None):
        self.calls = []
        self.node_rows_by_ref = node_rows_by_ref or {}
        self.edge_rows_by_node = edge_rows_by_node or {}
        # CI-review MAJOR fix (round 17) test wiring: `resolve_live_identity()` now resolves
        # external_id from the enabled `accounts` registry instead of trusting the definition —
        # default to a registered row for the fixtures' own account id so existing tests don't all
        # need to seed this explicitly; a test exercising the registry check overrides it.
        self.accounts_rows = accounts_rows if accounts_rows is not None else {"111111111111": (None,)}

    def run(self, sql, **kwargs):
        self.calls.append((sql, kwargs))
        if "FROM topology_nodes" in sql:
            ref = kwargs.get("pat", "")[2:]  # strip the fixed "%:" prefix _find_infra_node builds
            return self.node_rows_by_ref.get(ref, [])
        if "FROM topology_edges" in sql:
            return self.edge_rows_by_node.get(kwargs.get("s"), [])
        if "FROM accounts" in sql:
            row = self.accounts_rows.get(kwargs.get("a"))
            return [row] if row is not None else []
        return []

    def inserted_steps(self):
        return [c[1] for c in self.calls if "INSERT INTO network_path_run_steps" in c[0]]

    def inserted_candidates(self):
        return [c[1] for c in self.calls if "INSERT INTO network_path_run_candidates" in c[0]]

    def candidate_updates(self):
        return [c[1] for c in self.calls if "UPDATE network_path_run_candidates" in c[0]]

    def run_finishes(self):
        return [c[1] for c in self.calls if "UPDATE network_path_runs SET status" in c[0]]


def _definition(dest_kind="aws_resource", via="direct"):
    return {
        "source": {"kind": "pod", "account_id": "111111111111", "region": "ap-northeast-2",
                    "eni_id": "eni-src"},
        "destination": {"kind": dest_kind, "eni_id": "eni-dst", "cidr": "10.0.2.0/24",
                          "ip": "203.0.113.10", "host": "example.com"},
        "request": {"protocol": "tcp", "port": 443},
    }


def _topology_one_candidate(kind="resolved", via="direct", sg_allowed=True):
    sg_rules = [{"sg_id": "sg-1", "protocol": "tcp", "from_port": 443, "to_port": 443,
                 "cidr": "0.0.0.0/0" if sg_allowed else "192.168.0.0/16"}]
    return {"candidates": [{
        "kind": kind, "via": via,
        "data": {
            "sg": {"sg_rules": sg_rules, "peer_ip": "10.0.2.5"},
            "nacl": {"nacl_forward": [{"rule_number": 100, "protocol": "-1", "action": "allow"}],
                     "nacl_return": [{"rule_number": 100, "protocol": "-1", "action": "allow"}]},
            "route": {"route_table": [{"destination_cidr": "10.0.2.0/24", "target": "local",
                                         "state": "active"}], "dest_cidr": "10.0.2.0/24"},
        },
    }]}


# ── resolve ──────────────────────────────────────────────────────────────────────────────────────

class TestResolve:
    def test_missing_source_account_raises(self):
        d = _definition()
        d["source"].pop("account_id")
        with pytest.raises(np.NetworkPathError):
            np.resolve_identities(d)

    def test_unsupported_source_kind_raises(self):
        d = _definition()
        d["source"]["kind"] = "service"
        with pytest.raises(np.NetworkPathError):
            np.resolve_identities(d)

    def test_valid_definition_resolves(self):
        resolved = np.resolve_identities(_definition())
        assert resolved["source"]["eni_id"] == "eni-src"

    def test_resolve_failure_run_completes_failed_directly(self):
        conn = FakeConn()
        d = _definition()
        d["source"].pop("account_id")
        result = np.run({"run_id": "r1", "definition": d}, conn)
        assert result["status"] == "failed"
        # No candidates were ever created — global failure bypasses per-candidate reduction.
        assert conn.inserted_candidates() == []
        finishes = conn.run_finishes()
        assert finishes[-1]["s"] == "failed"
        assert finishes[-1]["os"] == "failed"
        # MINOR fix: the error text must actually be persisted to network_path_runs.error, not
        # just returned in run()'s in-memory result (which the caller/reaper never see again).
        assert finishes[-1]["err"] == result["error"]
        assert "account_id" in finishes[-1]["err"]

    # ── CI-review MAJOR fix (round 18): the resolve phase now performs DB I/O
    #    (`_account_external_id()`'s `conn.run`) but used to catch only `NetworkPathError` — a
    #    `conn.run` failure escaped uncaught, leaving `network_path_runs` stuck at
    #    `running`/`resolve` instead of terminating the run visibly. ─────────────────────────────

    def test_resolve_phase_db_error_terminates_the_run_instead_of_crashing_uncaught(self):
        class ExplodingConn(FakeConn):
            def run(self, sql, **kwargs):
                if "FROM accounts" in sql:
                    raise RuntimeError("connection reset by peer")
                return super().run(sql, **kwargs)

        conn = ExplodingConn()
        result = np.run({"run_id": "r-explode", "definition": _pod_definition(),
                          "source_account_id": "111111111111"}, conn)
        assert result["status"] == "failed"
        assert "connection reset" in result["error"]
        finishes = conn.run_finishes()
        assert finishes[-1]["s"] == "failed"
        assert finishes[-1]["os"] == "failed"

    def test_run_rejects_a_definition_account_id_mismatched_against_the_checks_own_column(self):
        """CI-review MAJOR fix (round 17, item 5, second half): a check's declared source account
        must match (or be validated against) the account the check was actually created/authorized
        for -- `definition.source.account_id` is user-authored (part of the check's own JSON
        definition) and must never be accepted as-is if it disagrees with the check's own
        `source_account_id` column, threaded into the payload as `source_account_id` by
        web/lib/network-path.ts's createRun(). This must fail BEFORE resolve_live_identity ever
        gets a chance to attempt an AssumeRole."""
        conn = FakeConn()
        d = _definition()
        assert d["source"]["account_id"] == "111111111111"
        result = np.run({"run_id": "r-mismatch", "definition": d,
                          "source_account_id": "222222222222"}, conn)
        assert result["status"] == "failed"
        assert conn.inserted_candidates() == []
        finishes = conn.run_finishes()
        assert finishes[-1]["s"] == "failed"
        assert "does not match" in finishes[-1]["err"]
        # CI-review MINOR fix (round 23): this NetworkPathError branch used to persist `str(e)`
        # verbatim, unlike the broad-Exception branch's `_redact_sensitive` — the raw 12-digit
        # account ids embedded in this exact message must not reach the persisted error column.
        assert "111111111111" not in finishes[-1]["err"]
        assert "222222222222" not in finishes[-1]["err"]

    def test_run_rejects_a_missing_source_account_id_on_the_payload(self):
        """A payload lacking `source_account_id` entirely is treated as fail-closed the same as a
        mismatch -- every payload created by createRun() always carries this field, so its
        absence means the run didn't go through the trusted enqueue path."""
        conn = FakeConn()
        result = np.run({"run_id": "r-missing", "definition": _definition()}, conn)
        assert result["status"] == "failed"
        assert conn.inserted_candidates() == []


# ── Gap 1: fetch_live_topology() — real, best-effort cached-topology discovery ─────────────────

class TestFetchLiveTopology:
    def test_same_vpc_known_sg_resolves_a_real_resolved_candidate(self):
        """Source and destination ENIs both resolve to a single inventoried node in the SAME vpc,
        with a known attached SG on the destination side -- discovery must surface that REAL
        placement data (not fabricate a confident sg/nacl/route verdict from it, per the module's
        own docstring)."""
        conn = FakeConn(
            node_rows_by_ref={
                "eni-src": [("ec2:i-src", "ec2")],
                "eni-dst": [("ec2:i-dst", "ec2")],
            },
            edge_rows_by_node={
                "ec2:i-src": [("infra:in_vpc", "vpc-1"), ("infra:in_subnet", "subnet-1"),
                              ("infra:uses_sg", "sg-src")],
                "ec2:i-dst": [("infra:in_vpc", "vpc-1"), ("infra:in_subnet", "subnet-2"),
                              ("infra:uses_sg", "sg-dst")],
            },
        )
        resolved = np.resolve_identities(_definition(dest_kind="aws_resource"))
        topo = np.fetch_live_topology(resolved, conn)
        candidates = topo["candidates"]
        assert len(candidates) == 1
        c = candidates[0]
        assert c["kind"] == "resolved"  # both endpoints resolved unambiguously -> no ambiguity found
        assert c["via"] == "direct"
        assert c["dest_eni_known"] is True
        placement = c["data"]["placement"]
        assert placement["same_vpc"] is True
        assert placement["source"]["vpc"] == "vpc-1"
        assert placement["destination"]["sg_ids"] == ["sg-dst"]
        # Never a fabricated sg/nacl/route verdict from placement data alone.
        assert "sg_rules" not in c["data"].get("sg", {})
        assert "peer_sg_ids" not in c["data"].get("sg", {})

    def test_ambiguous_node_match_degrades_to_hypothesis_not_a_guess(self):
        """More than one cached node matches the same ref -> _find_infra_node refuses to pick one;
        discovery must degrade to `hypothesis`, never silently resolve to an arbitrary match."""
        conn = FakeConn(node_rows_by_ref={
            "eni-src": [("ec2:i-src", "ec2")],
            "eni-dst": [("ec2:i-dst-a", "ec2"), ("ec2:i-dst-b", "ec2")],  # ambiguous
        })
        resolved = np.resolve_identities(_definition(dest_kind="aws_resource"))
        topo = np.fetch_live_topology(resolved, conn)
        c = topo["candidates"][0]
        assert c["kind"] == "hypothesis"
        assert c["dest_eni_known"] is False

    def test_sparse_topology_never_fabricates_a_confident_path(self):
        """Zero seeded rows anywhere -- discovery must still return exactly one candidate (per
        discover_candidates()'s own "always >=1 candidate" contract) tagged `hypothesis`, with empty
        placement, never a confident sg/nacl/route verdict."""
        conn = FakeConn()
        resolved = np.resolve_identities(_definition(dest_kind="aws_resource"))
        topo = np.fetch_live_topology(resolved, conn)
        assert len(topo["candidates"]) == 1
        c = topo["candidates"][0]
        assert c["kind"] == "hypothesis"
        assert c["data"]["placement"]["source"] == {}
        assert c["data"]["placement"]["destination"] == {}
        assert c["data"]["placement"]["same_vpc"] is False

    def test_internet_destination_never_looked_up_as_an_infra_node(self):
        """An internet/onprem destination has no ENI of its own to resolve -- fetch_live_topology
        must not even attempt a destination-node lookup for it (dest_eni_known stays False, and no
        FakeConn call is made keyed on the destination's ip/host)."""
        conn = FakeConn(node_rows_by_ref={"eni-src": [("ec2:i-src", "ec2")]})
        resolved = np.resolve_identities(_definition(dest_kind="internet"))
        topo = np.fetch_live_topology(resolved, conn)
        c = topo["candidates"][0]
        assert c["dest_eni_known"] is False

    def test_onprem_candidate_from_fetcher_is_unknown_at_boundary_not_confident_blocked(self):
        """CI-review MAJOR fix (round 19, item 3): `fetch_live_topology()` never populates
        `aws_side_state`/`boundary` for an on-prem destination (no cached-topology signal for
        either exists today — see the fetcher's own docstring), but `_layer_plan_for` still always
        appends a `vpn`/`dx` boundary layer for an onprem destination. Before the fix,
        `eval_vpn_or_dx` treated the resulting missing `aws_side_state` (`None`) the same as a
        CONFIRMED-down state, so every on-prem candidate this fetcher produces got a confident
        false `blocked` at that layer. This exercises the REAL end-to-end pipeline (fetch ->
        discover -> verify) and asserts the boundary layer is `unknown`, not `blocked`."""
        conn = FakeConn(node_rows_by_ref={"eni-src": [("ec2:i-src", "ec2")]})
        resolved = np.resolve_identities(_definition(dest_kind="onprem"))
        topo = np.fetch_live_topology(resolved, conn)
        candidates = np.discover_candidates(resolved, topo)
        assert "vpn" in candidates[0]["layer_plan"]  # default boundary, no hint supplied
        steps = np.verify_candidate(candidates[0], resolved["request"], deadline_at=1e18)
        vpn_step = next(s for s in steps if s["layer"] == "vpn")
        assert vpn_step["status"] == "unknown"

    def test_member_account_topology_query_never_admits_self_tagged_rows(self, monkeypatch):
        """CI-review MAJOR fix (round 17, item 3): `'self'` is this repo's established sentinel
        for HOST-account rows specifically (web/lib/inventory.ts, web/lib/sg-analysis.ts) — for a
        MEMBER-account check (account_id != the host account), `_find_infra_node`/
        `_infra_placement` must query strictly `account_id=:a`, with NO `'self'` fallback that
        would admit host-account topology into this member account's placement/candidate
        resolution."""
        monkeypatch.setattr(np, "HOST_ACCOUNT_ID", "999999999999")  # a DIFFERENT account than 111111111111
        conn = FakeConn(node_rows_by_ref={"eni-src": [("ec2:i-src", "ec2")]})
        resolved = np.resolve_identities(_definition(dest_kind="internet"))
        np.fetch_live_topology(resolved, conn)
        node_query_calls = [kw for sql, kw in conn.calls if "FROM topology_nodes" in sql]
        assert node_query_calls, "expected at least one topology_nodes query"
        node_query_sql = [sql for sql, kw in conn.calls if "FROM topology_nodes" in sql][0]
        assert "'self'" not in node_query_sql

    def test_host_account_topology_query_still_admits_self_tagged_rows(self, monkeypatch):
        """The 'self' fallback must still work for a genuine host-account check -- this fix must
        not remove that case entirely, only stop it leaking into member-account checks."""
        monkeypatch.setattr(np, "HOST_ACCOUNT_ID", "111111111111")  # SAME account as the definition
        conn = FakeConn(node_rows_by_ref={"eni-src": [("ec2:i-src", "ec2")]})
        resolved = np.resolve_identities(_definition(dest_kind="internet"))
        np.fetch_live_topology(resolved, conn)
        node_query_sql = [sql for sql, kw in conn.calls if "FROM topology_nodes" in sql][0]
        assert "'self'" in node_query_sql


# ── Gap 4: resolve_live_identity() — confirm source identity via live K8s/EC2 calls ─────────────

def _pod_definition(namespace="default", pod_name="my-pod", cluster="my-cluster", region="ap-northeast-2"):
    d = _definition()
    d["source"] = {
        "kind": "pod", "account_id": "111111111111", "region": region,
        "cluster": cluster, "namespace": namespace, "pod_name": pod_name,
        # user-supplied, must NOT be trusted once a live call succeeds/fails
        "eni_id": "eni-stale-user-supplied",
    }
    return d


def _node_definition(node_name="ip-10-0-1-5.ec2.internal", cluster="my-cluster"):
    d = _definition()
    d["source"] = {
        "kind": "node", "account_id": "111111111111", "region": "ap-northeast-2",
        "cluster": cluster, "node_name": node_name, "eni_id": "eni-stale-user-supplied",
    }
    return d


class TestResolveLiveIdentity:
    def test_no_cluster_declared_is_a_no_op(self):
        """A source with no `cluster` is the pre-existing directly-known-ENI path — untouched."""
        resolved = np.resolve_identities(_definition())
        out = np.resolve_live_identity(resolved, FakeConn())
        assert out is resolved

    # ── CI-review MAJOR fix (round 17): confused-deputy regression — `external_id` used to be
    #    trusted straight from the user-authored definition, with no check against the enabled
    #    `accounts` registry, against a wildcard `sts:AssumeRole` grant. ────────────────────────────

    def test_refuses_an_unregistered_account(self):
        conn = FakeConn(accounts_rows={})  # no row at all for 111111111111
        resolved = np.resolve_identities(_pod_definition())
        with pytest.raises(np.NetworkPathError, match="not a registered, enabled account"):
            np.resolve_live_identity(resolved, conn)

    def test_refuses_a_disabled_account(self):
        conn = FakeConn(accounts_rows={})  # modeled the same as unregistered — no enabled row
        resolved = np.resolve_identities(_pod_definition())
        with pytest.raises(np.NetworkPathError, match="not a registered, enabled account"):
            np.resolve_live_identity(resolved, conn)

    def test_resolves_external_id_from_the_registry_not_the_definition(self):
        """Even if the definition declares its OWN `external_id`, the registry's value must be
        used instead — a user-authored external_id must never reach `_assumed_session`."""
        conn = FakeConn(accounts_rows={"111111111111": ("registry-ext-id",)})
        d = _pod_definition()
        d["source"]["external_id"] = "attacker-supplied-ext-id"
        captured = {}

        def fake_k8s_get(account_id, region, cluster, path, external_id=None):
            captured["external_id"] = external_id
            return {"status": {"podIP": "10.0.1.42", "phase": "Running"},
                    "spec": {"nodeName": "ip-10-0-1-5.ec2.internal"}}

        with pytest.raises(np.NetworkPathError):
            # fails later (no node fixture), but the pod call already captured external_id
            np.resolve_live_identity(np.resolve_identities(d), conn, k8s_get=fake_k8s_get)
        assert captured["external_id"] == "registry-ext-id"

    def test_host_account_source_skips_the_registry_lookup(self, monkeypatch):
        monkeypatch.setattr(np, "HOST_ACCOUNT_ID", "111111111111")
        conn = FakeConn(accounts_rows={})  # would refuse if the lookup ran at all
        d = _pod_definition()

        def fake_k8s_get(account_id, region, cluster, path, external_id=None):
            assert external_id is None
            if path.endswith("/pods/my-pod"):
                return {"status": {"podIP": "10.0.1.42", "phase": "Running"},
                        "spec": {"nodeName": "ip-10-0-1-5.ec2.internal"}}
            return {"spec": {"providerID": "aws:///ap-northeast-2a/i-0abc123def456"}}

        def fake_ec2_lookup(account_id, region, instance_id, pod_ip=None, external_id=None):
            return {"instance_id": instance_id, "eni_id": "eni-x", "subnet_id": "subnet-x",
                    "vpc_id": "vpc-x"}

        out = np.resolve_live_identity(np.resolve_identities(d), conn,
                                        k8s_get=fake_k8s_get, ec2_lookup=fake_ec2_lookup)
        assert out["source"]["eni_id"] == "eni-x"

    # ── CI-review MAJOR fix (round 17): K8s API path-injection — namespace/pod_name/node_name/
    #    cluster must be rejected outright if they contain a `/` (or any other unsafe character),
    #    rather than being interpolated straight into the GET path/signed header. ─────────────────

    def test_refuses_a_path_traversal_namespace(self):
        conn = FakeConn()
        d = _pod_definition(namespace="../../etc")
        with pytest.raises(np.NetworkPathError, match="not a valid Kubernetes resource name"):
            np.resolve_live_identity(np.resolve_identities(d), conn)

    def test_refuses_a_path_traversal_pod_name(self):
        conn = FakeConn()
        d = _pod_definition(pod_name="my-pod/../../secrets")
        with pytest.raises(np.NetworkPathError, match="not a valid Kubernetes resource name"):
            np.resolve_live_identity(np.resolve_identities(d), conn)

    def test_refuses_a_path_traversal_cluster(self):
        conn = FakeConn()
        d = _pod_definition(cluster="cluster/../admin")
        with pytest.raises(np.NetworkPathError, match="not a valid Kubernetes resource name"):
            np.resolve_live_identity(np.resolve_identities(d), conn)

    def test_refuses_an_invalid_region(self):
        """CI-review MAJOR fix (round 24): `region` is a definition-authored identity field that
        reaches `boto3.client("sts", region_name=region)` and a hand-built presigned STS URL —
        the same trust boundary `_validate_k8s_name` already guards for cluster/namespace/pod/
        node names, but `region` itself was never validated here at all."""
        conn = FakeConn()
        d = _pod_definition(region="us-east-1/../evil")
        with pytest.raises(np.NetworkPathError, match="not a valid AWS region name"):
            np.resolve_live_identity(np.resolve_identities(d), conn)

    def test_accepts_a_dotted_ec2_style_node_name(self):
        """A real EC2-style Node name (`ip-10-0-1-5.ec2.internal`) is a DNS-1123 SUBDOMAIN with
        dots — must not be rejected as invalid."""
        conn = FakeConn()
        d = _node_definition(node_name="ip-10-0-1-5.ec2.internal")

        def fake_k8s_get(account_id, region, cluster, path, external_id=None):
            assert path.endswith("/nodes/ip-10-0-1-5.ec2.internal")
            return {"spec": {"providerID": "aws:///ap-northeast-2a/i-0abc123def456"}}

        def fake_ec2_lookup(account_id, region, instance_id, pod_ip=None, external_id=None):
            return {"instance_id": instance_id, "eni_id": "eni-x", "subnet_id": "subnet-x",
                    "vpc_id": "vpc-x"}

        out = np.resolve_live_identity(np.resolve_identities(d), conn,
                                        k8s_get=fake_k8s_get, ec2_lookup=fake_ec2_lookup)
        assert out["source"]["eni_id"] == "eni-x"

    def test_successful_pod_resolution_populates_real_pod_node_eni_subnet_vpc(self):
        pod_obj = {"status": {"podIP": "10.0.1.42", "phase": "Running"},
                   "spec": {"nodeName": "ip-10-0-1-5.ec2.internal"}}
        node_obj = {"spec": {"providerID": "aws:///ap-northeast-2a/i-0abc123def456"}}

        def fake_k8s_get(account_id, region, cluster, path, external_id=None):
            if path.endswith("/pods/my-pod"):
                return pod_obj
            if path.endswith("/nodes/ip-10-0-1-5.ec2.internal"):
                return node_obj
            raise AssertionError(f"unexpected path {path}")

        def fake_ec2_lookup(account_id, region, instance_id, pod_ip=None, external_id=None):
            assert instance_id == "i-0abc123def456"
            assert pod_ip == "10.0.1.42"
            return {"instance_id": instance_id, "eni_id": "eni-real123",
                    "subnet_id": "subnet-real1", "vpc_id": "vpc-real1"}

        resolved = np.resolve_identities(_pod_definition())
        out = np.resolve_live_identity(resolved, FakeConn(), k8s_get=fake_k8s_get, ec2_lookup=fake_ec2_lookup)
        src = out["source"]
        assert src["pod_ip"] == "10.0.1.42"
        assert src["node_name"] == "ip-10-0-1-5.ec2.internal"
        assert src["instance_id"] == "i-0abc123def456"
        assert src["eni_id"] == "eni-real123"  # never the stale user-supplied value
        assert src["subnet_id"] == "subnet-real1"
        assert src["vpc_id"] == "vpc-real1"

    def test_successful_node_resolution_populates_real_eni_subnet_vpc(self):
        node_obj = {"spec": {"providerID": "aws:///ap-northeast-2a/i-0deadbeef000"}}

        def fake_k8s_get(account_id, region, cluster, path, external_id=None):
            assert path.endswith("/nodes/ip-10-0-1-5.ec2.internal")
            return node_obj

        def fake_ec2_lookup(account_id, region, instance_id, pod_ip=None, external_id=None):
            assert pod_ip is None  # no pod IP for a bare node source
            return {"instance_id": instance_id, "eni_id": "eni-node-real",
                    "subnet_id": "subnet-node-real", "vpc_id": "vpc-node-real"}

        resolved = np.resolve_identities(_node_definition())
        out = np.resolve_live_identity(resolved, FakeConn(), k8s_get=fake_k8s_get, ec2_lookup=fake_ec2_lookup)
        assert out["source"]["eni_id"] == "eni-node-real"
        assert "pod_ip" not in out["source"]

    def test_pod_not_found_fails_with_bounded_error(self):
        def fake_k8s_get(account_id, region, cluster, path, external_id=None):
            raise RuntimeError("HTTP 404: pods \"my-pod\" not found")

        resolved = np.resolve_identities(_pod_definition())
        with pytest.raises(np.NetworkPathError) as ei:
            np.resolve_live_identity(resolved, FakeConn(), k8s_get=fake_k8s_get)
        assert "my-pod" in str(ei.value)
        assert "not found" in str(ei.value) or "404" in str(ei.value)

    def test_pod_with_no_assigned_ip_fails_with_bounded_error(self):
        def fake_k8s_get(account_id, region, cluster, path, external_id=None):
            return {"status": {"phase": "Pending"}, "spec": {}}

        resolved = np.resolve_identities(_pod_definition())
        with pytest.raises(np.NetworkPathError) as ei:
            np.resolve_live_identity(resolved, FakeConn(), k8s_get=fake_k8s_get)
        assert "Pending" in str(ei.value)

    def test_node_ec2_instance_not_resolvable_fails_with_bounded_error(self):
        node_obj = {"spec": {"providerID": "aws:///ap-northeast-2a/i-0abcdef01234"}}

        def fake_k8s_get(account_id, region, cluster, path, external_id=None):
            return node_obj

        def fake_ec2_lookup(account_id, region, instance_id, pod_ip=None, external_id=None):
            raise np.NetworkPathError(f"EC2 instance {instance_id} not found (DescribeInstances returned none)")

        with pytest.raises(np.NetworkPathError) as ei:
            np.resolve_live_identity(np.resolve_identities(_node_definition()), FakeConn(),
                                      k8s_get=fake_k8s_get, ec2_lookup=fake_ec2_lookup)
        assert "i-0abcdef01234" in str(ei.value)
        assert "not found" in str(ei.value)

    def test_node_with_no_provider_id_fails_with_bounded_error(self):
        def fake_k8s_get(account_id, region, cluster, path, external_id=None):
            return {"spec": {}}  # Fargate-profile virtual node, no EC2 providerID

        resolved = np.resolve_identities(_node_definition())
        with pytest.raises(np.NetworkPathError) as ei:
            np.resolve_live_identity(resolved, FakeConn(), k8s_get=fake_k8s_get)
        assert "providerID" in str(ei.value)

    def test_error_message_is_redacted(self):
        """A raw exception embedding an ARN/account id must be redacted before it reaches the
        bounded NetworkPathError message (same _redact_sensitive contract run() already applies)."""
        def fake_k8s_get(account_id, region, cluster, path, external_id=None):
            raise RuntimeError(
                "AccessDenied assuming arn:aws:iam::222222222222:role/AWSopsReadOnlyRole")

        resolved = np.resolve_identities(_pod_definition())
        with pytest.raises(np.NetworkPathError) as ei:
            np.resolve_live_identity(resolved, FakeConn(), k8s_get=fake_k8s_get)
        assert "arn:aws:iam" not in str(ei.value)
        assert "<arn-redacted>" in str(ei.value)

    def test_run_fails_closed_when_live_identity_cannot_be_resolved(self):
        """Full run() integration: a pod source declaring a cluster, with a k8s_get that raises,
        must terminate the run as `failed` -- never falling back to the stale user-supplied eni_id
        as though it were verified live data."""
        conn = FakeConn()

        def fake_k8s_get(account_id, region, cluster, path, external_id=None):
            raise RuntimeError("connection refused")

        result = np.run({"run_id": "r-live-1", "definition": _pod_definition(),
                          "source_account_id": "111111111111"}, conn,
                         k8s_get=fake_k8s_get)
        assert result["status"] == "failed"
        assert conn.inserted_candidates() == []
        finishes = conn.run_finishes()
        assert finishes[-1]["s"] == "failed"
        assert "eni-stale-user-supplied" not in (finishes[-1]["err"] or "")

    def test_run_succeeds_with_live_resolved_identity(self):
        """Full run() integration: a successful live resolution feeds the REAL eni_id into
        discovery/topology — proving the confirmed identity, not the stale declared one, is what
        the rest of the pipeline actually sees."""
        conn = FakeConn()
        pod_obj = {"status": {"podIP": "10.0.1.42", "phase": "Running"},
                   "spec": {"nodeName": "ip-10-0-1-5.ec2.internal"}}
        node_obj = {"spec": {"providerID": "aws:///ap-northeast-2a/i-0abc123def456"}}

        def fake_k8s_get(account_id, region, cluster, path, external_id=None):
            return pod_obj if path.endswith("/pods/my-pod") else node_obj

        def fake_ec2_lookup(account_id, region, instance_id, pod_ip=None, external_id=None):
            return {"instance_id": instance_id, "eni_id": "eni-real123",
                    "subnet_id": "subnet-real1", "vpc_id": "vpc-real1"}

        seen_resolved = {}

        def capture_topology(resolved):
            seen_resolved.update(resolved)
            return _topology_one_candidate()

        result = np.run({"run_id": "r-live-2", "definition": _pod_definition(),
                          "source_account_id": "111111111111"}, conn,
                         topology_fetcher=capture_topology, k8s_get=fake_k8s_get,
                         ec2_lookup=fake_ec2_lookup)
        assert result["status"] == "succeeded"
        assert seen_resolved["source"]["eni_id"] == "eni-real123"
        assert seen_resolved["source"]["pod_ip"] == "10.0.1.42"


# ── MINOR fix: _default_ec2_lookup() must fail closed for a pod source whose IP matches no ────
#    attached ENI, rather than silently falling back to the instance's primary ENI. ──────────────

class TestDefaultEc2Lookup:
    class _FakeEc2:
        def __init__(self, enis):
            self._enis = enis

        def describe_instances(self, InstanceIds):
            return {"Reservations": [{"Instances": [{"NetworkInterfaces": self._enis}]}]}

    def _patch_session(self, monkeypatch, enis):
        fake_ec2 = self._FakeEc2(enis)

        class FakeSession:
            def client(self, name):
                assert name == "ec2"
                return fake_ec2

        monkeypatch.setattr(np, "_assumed_session", lambda *a, **k: FakeSession())

    def test_pod_ip_matching_no_eni_fails_closed(self, monkeypatch):
        """A pod's IP that matches none of the instance's top-level attached ENIs (e.g. an
        unenumerated SG-for-Pods branch ENI) must raise, never silently fall back to the primary
        ENI -- that ENI is known NOT to be the pod's."""
        self._patch_session(monkeypatch, [
            {"NetworkInterfaceId": "eni-primary", "SubnetId": "subnet-1", "VpcId": "vpc-1",
             "Attachment": {"DeviceIndex": 0}, "PrivateIpAddresses": [{"PrivateIpAddress": "10.0.0.5"}]},
        ])
        with pytest.raises(np.NetworkPathError, match="does not match any network interface"):
            np._default_ec2_lookup("111111111111", "ap-northeast-2", "i-0abc", pod_ip="10.0.1.42")

    def test_pod_ip_matching_eni_is_used(self, monkeypatch):
        self._patch_session(monkeypatch, [
            {"NetworkInterfaceId": "eni-primary", "SubnetId": "subnet-1", "VpcId": "vpc-1",
             "Attachment": {"DeviceIndex": 0}, "PrivateIpAddresses": [{"PrivateIpAddress": "10.0.0.5"}]},
            {"NetworkInterfaceId": "eni-branch", "SubnetId": "subnet-2", "VpcId": "vpc-1",
             "Attachment": {"DeviceIndex": 1}, "PrivateIpAddresses": [{"PrivateIpAddress": "10.0.1.42"}]},
        ])
        out = np._default_ec2_lookup("111111111111", "ap-northeast-2", "i-0abc", pod_ip="10.0.1.42")
        assert out["eni_id"] == "eni-branch"

    def test_node_source_with_no_pod_ip_uses_primary_eni(self, monkeypatch):
        """A bare node source (no pod_ip at all) still uses the primary-ENI fallback -- a Node
        genuinely IS its primary ENI, unlike a pod that could be on any branch ENI."""
        self._patch_session(monkeypatch, [
            {"NetworkInterfaceId": "eni-primary", "SubnetId": "subnet-1", "VpcId": "vpc-1",
             "Attachment": {"DeviceIndex": 0}},
        ])
        out = np._default_ec2_lookup("111111111111", "ap-northeast-2", "i-0abc")
        assert out["eni_id"] == "eni-primary"

    # ── CI review MINOR fix: a pod IP carved out of a VPC-CNI prefix-delegation Ipv4Prefixes CIDR
    #    (not its own discrete PrivateIpAddress) must still resolve to that ENI, not fail closed.

    def test_pod_ip_inside_a_prefix_delegation_cidr_is_matched(self, monkeypatch):
        self._patch_session(monkeypatch, [
            {"NetworkInterfaceId": "eni-primary", "SubnetId": "subnet-1", "VpcId": "vpc-1",
             "Attachment": {"DeviceIndex": 0}, "PrivateIpAddresses": [{"PrivateIpAddress": "10.0.0.5"}]},
            {"NetworkInterfaceId": "eni-prefix", "SubnetId": "subnet-2", "VpcId": "vpc-1",
             "Attachment": {"DeviceIndex": 1}, "PrivateIpAddresses": [{"PrivateIpAddress": "10.0.2.1"}],
             "Ipv4Prefixes": [{"Ipv4Prefix": "10.0.3.0/28"}]},
        ])
        out = np._default_ec2_lookup("111111111111", "ap-northeast-2", "i-0abc", pod_ip="10.0.3.7")
        assert out["eni_id"] == "eni-prefix"

    def test_pod_ip_outside_every_prefix_and_address_still_fails_closed(self, monkeypatch):
        self._patch_session(monkeypatch, [
            {"NetworkInterfaceId": "eni-primary", "SubnetId": "subnet-1", "VpcId": "vpc-1",
             "Attachment": {"DeviceIndex": 0}, "PrivateIpAddresses": [{"PrivateIpAddress": "10.0.0.5"}],
             "Ipv4Prefixes": [{"Ipv4Prefix": "10.0.3.0/28"}]},
        ])
        with pytest.raises(np.NetworkPathError, match="does not match any network interface"):
            np._default_ec2_lookup("111111111111", "ap-northeast-2", "i-0abc", pod_ip="10.0.99.9")

    # ── CI-review MAJOR fix (round 22): IPv6/dual-stack clusters were entirely unsupported here
    #    (only PrivateIpAddresses/Ipv4Prefixes were checked) — every pod/node on such a cluster
    #    failed closed on EVERY live identity resolution. ─────────────────────────────────────────

    def test_pod_ipv6_address_discrete_match_is_used(self, monkeypatch):
        self._patch_session(monkeypatch, [
            {"NetworkInterfaceId": "eni-primary", "SubnetId": "subnet-1", "VpcId": "vpc-1",
             "Attachment": {"DeviceIndex": 0}, "PrivateIpAddresses": [{"PrivateIpAddress": "10.0.0.5"}]},
            {"NetworkInterfaceId": "eni-v6", "SubnetId": "subnet-2", "VpcId": "vpc-1",
             "Attachment": {"DeviceIndex": 1}, "Ipv6Addresses": [{"Ipv6Address": "2001:db8::42"}]},
        ])
        out = np._default_ec2_lookup("111111111111", "ap-northeast-2", "i-0abc", pod_ip="2001:db8::42")
        assert out["eni_id"] == "eni-v6"

    def test_pod_ipv6_inside_a_prefix_delegation_cidr_is_matched(self, monkeypatch):
        self._patch_session(monkeypatch, [
            {"NetworkInterfaceId": "eni-primary", "SubnetId": "subnet-1", "VpcId": "vpc-1",
             "Attachment": {"DeviceIndex": 0}, "PrivateIpAddresses": [{"PrivateIpAddress": "10.0.0.5"}]},
            {"NetworkInterfaceId": "eni-v6-prefix", "SubnetId": "subnet-2", "VpcId": "vpc-1",
             "Attachment": {"DeviceIndex": 1},
             "Ipv6Prefixes": [{"Ipv6Prefix": "2001:db8:1::/80"}]},
        ])
        out = np._default_ec2_lookup("111111111111", "ap-northeast-2", "i-0abc", pod_ip="2001:db8:1::7")
        assert out["eni_id"] == "eni-v6-prefix"


# ── MINOR fix: the K8s GET must never follow a redirect with the same bearer token ──────────────

class TestNoRedirectHandler:
    def test_redirect_request_refuses_to_follow(self):
        handler = np._NoRedirectHandler()
        req = np.Request("https://cluster.example.com/api/v1/nodes/x")
        result = handler.redirect_request(req, None, 302, "Found",
                                           {"Location": "https://attacker.example.com/steal"},
                                           "https://attacker.example.com/steal")
        assert result is None


# ── CI-review MAJOR fix (round 19, item 6): defense-in-depth allowlist on the K8s GET path ────────

class TestK8sGetPathAllowlist:
    def test_pod_path_is_allowed(self):
        path = "/api/v1/namespaces/default/pods/my-pod"
        assert np._validate_k8s_get_path(path) == path

    def test_node_path_is_allowed(self):
        path = "/api/v1/nodes/ip-10-0-1-5.ec2.internal"
        assert np._validate_k8s_get_path(path) == path

    @pytest.mark.parametrize("bad_path", [
        "/api/v1/secrets",
        "/api/v1/namespaces/default/secrets/my-secret",
        "/api/v1/namespaces/default/pods",  # list, not a single GET
        "/api/v1/nodes",  # list, not a single GET
        "/api/v1/namespaces/default/pods/my-pod/exec",
        "/api/v1/namespaces/default/pods/my-pod/../../secrets/x",
        "/../etc/passwd",
        "",
        None,
    ])
    def test_disallowed_paths_are_rejected(self, bad_path):
        with pytest.raises(np.NetworkPathError):
            np._validate_k8s_get_path(bad_path)

    def test_default_k8s_get_rejects_a_disallowed_path_before_any_http_call(self, monkeypatch):
        """The allowlist check must run BEFORE `_default_k8s_get` ever assumes a session or makes
        an HTTP request — proven here by making the session-assumption step itself raise if it's
        ever reached for a disallowed path."""
        def must_not_be_called(*a, **k):
            raise AssertionError("must not assume a session for a disallowed K8s GET path")
        monkeypatch.setattr(np, "_assumed_session", must_not_be_called)
        with pytest.raises(np.NetworkPathError, match="disallowed K8s API path"):
            np._default_k8s_get("111111111111", "ap-northeast-2", "my-cluster", "/api/v1/secrets")


# ── discover ─────────────────────────────────────────────────────────────────────────────────────

class TestDiscover:
    def test_zero_candidates_raises(self):
        resolved = np.resolve_identities(_definition())
        with pytest.raises(np.NetworkPathError):
            np.discover_candidates(resolved, {"candidates": []})

    def test_invalid_kind_raises(self):
        resolved = np.resolve_identities(_definition())
        with pytest.raises(np.NetworkPathError):
            np.discover_candidates(resolved, {"candidates": [{"kind": "maybe"}]})

    def test_irrelevant_layer_omitted_not_marked_unknown(self):
        resolved = np.resolve_identities(_definition(dest_kind="aws_resource"))
        candidates = np.discover_candidates(resolved, _topology_one_candidate())
        # A direct aws_resource candidate never gets a peering/tgw/vpn/dx/onprem-segment layer.
        plan = candidates[0]["layer_plan"]
        assert "peering" not in plan
        assert "tgw" not in plan
        assert "onprem-segment" not in plan

    def test_onprem_destination_gets_boundary_and_segment_layers(self):
        resolved = np.resolve_identities(_definition(dest_kind="onprem"))
        topo = _topology_one_candidate()
        topo["candidates"][0]["boundary"] = "dx"
        candidates = np.discover_candidates(resolved, topo)
        assert "dx" in candidates[0]["layer_plan"]
        assert "onprem-segment" in candidates[0]["layer_plan"]

    def test_k8s_destination_wires_in_every_mesh_stub_layer(self):
        """L4 finding #12: the mesh-policy layers (Calico/Cilium/Istio) were registered in
        `_ADAPTER_BY_LAYER` but `_layer_plan_for` never inserted them into any candidate's plan —
        they could never even run (not even to record `unknown`). Whenever the k8s_network_policy
        hint is set, every mesh layer must now appear in the plan too."""
        resolved = np.resolve_identities(_definition())
        topo = _topology_one_candidate()
        topo["candidates"][0]["k8s_network_policy"] = True
        candidates = np.discover_candidates(resolved, topo)
        plan = candidates[0]["layer_plan"]
        assert "k8s-networkpolicy" in plan
        for layer in np._MESH_LAYERS:
            assert layer in plan

    # ── L4 finding #13 (cheap mitigation): destination-side SG/NACL second pass ──────────────────

    def test_dest_eni_known_adds_destination_side_sg_and_nacl_layers(self):
        resolved = np.resolve_identities(_definition(dest_kind="aws_resource"))
        topo = _topology_one_candidate()
        topo["candidates"][0]["dest_eni_known"] = True
        candidates = np.discover_candidates(resolved, topo)
        plan = candidates[0]["layer_plan"]
        assert "sg-dst" in plan
        assert "nacl-dst" in plan

    def test_dest_eni_unknown_omits_destination_side_layers(self):
        resolved = np.resolve_identities(_definition(dest_kind="aws_resource"))
        candidates = np.discover_candidates(resolved, _topology_one_candidate())
        plan = candidates[0]["layer_plan"]
        assert "sg-dst" not in plan
        assert "nacl-dst" not in plan

    def test_dest_side_sg_block_produces_a_distinct_blocked_step(self):
        """A destination-side SG that denies the traffic must surface as its OWN `sg-dst` blocked
        step — independent from (and even when) the source-side `sg` step is allowed."""
        resolved = np.resolve_identities(_definition(dest_kind="aws_resource"))
        topo = _topology_one_candidate(sg_allowed=True)  # source-side sg: allowed
        topo["candidates"][0]["dest_eni_known"] = True
        topo["candidates"][0]["data"]["sg-dst"] = {
            "sg_rules": [{"sg_id": "sg-dst-1", "protocol": "tcp", "from_port": 22, "to_port": 22,
                          "cidr": "0.0.0.0/0"}],
            "peer_ip": "10.0.1.5",
        }
        topo["candidates"][0]["data"]["nacl-dst"] = topo["candidates"][0]["data"]["nacl"]
        candidates = np.discover_candidates(resolved, topo)
        deadline_at = np.time.monotonic() + 60
        steps = np.verify_candidate(candidates[0], resolved["request"], deadline_at)
        sg_step = next(s for s in steps if s["layer"] == "sg")
        sg_dst_step = next(s for s in steps if s["layer"] == "sg-dst")
        assert sg_step["status"] == "allowed"
        assert sg_dst_step["status"] == "blocked"  # port 443 not in the dest-side sg-dst-1 rule (22 only)

    def test_non_k8s_destination_never_gets_mesh_layers(self):
        resolved = np.resolve_identities(_definition())
        candidates = np.discover_candidates(resolved, _topology_one_candidate())
        plan = candidates[0]["layer_plan"]
        for layer in np._MESH_LAYERS:
            assert layer not in plan

    def test_mesh_layers_run_as_unknown_never_fabricating_allowed_or_blocked(self):
        """Each mesh layer is still a bounded stub (`eval_mesh_policy_stub`) — wiring it in must
        make it VISIBLE as `unknown`, never a confident allowed/blocked."""
        resolved = np.resolve_identities(_definition())
        topo = _topology_one_candidate()
        topo["candidates"][0]["k8s_network_policy"] = True
        candidates = np.discover_candidates(resolved, topo)
        deadline_at = np.time.monotonic() + 60
        steps = np.verify_candidate(candidates[0], resolved["request"], deadline_at)
        mesh_steps = [s for s in steps if s["layer"] in np._MESH_LAYERS]
        assert len(mesh_steps) == len(np._MESH_LAYERS)
        assert all(s["status"] == "unknown" for s in mesh_steps)


# ── verify: deadline / adapter isolation ────────────────────────────────────────────────────────

class TestVerify:
    def test_adapter_exception_isolated_to_one_layer(self):
        candidate = {"candidate_id": "c0", "kind": "resolved",
                     "layer_plan": ["sg", "route"],
                     "data": {"sg": {"sg_rules": "not-a-list-will-not-error-but-force-bad-data"},
                               "route": {"route_table": [{"destination_cidr": "10.0.0.0/8",
                                                            "target": "local", "state": "active"}],
                                          "dest_cidr": "10.0.0.5"}}}
        # Force the sg adapter to raise by handing it a non-iterable-of-dicts value via monkeypatch
        orig = ad.eval_security_group

        def boom(*a, **k):
            raise RuntimeError("boom")
        ad.eval_security_group = boom
        try:
            steps = np.verify_candidate(candidate, {"protocol": "tcp", "port": 443}, deadline_at=1e18)
        finally:
            ad.eval_security_group = orig
        assert steps[0]["status"] == "unknown"
        assert "boom" in steps[0]["summary"]
        assert steps[1]["status"] == "allowed"  # route layer unaffected

    def test_deadline_truncation_marks_remaining_not_run(self):
        candidate = {"candidate_id": "c0", "kind": "resolved", "layer_plan": ["sg", "nacl", "route"],
                     "data": _topology_one_candidate()["candidates"][0]["data"]}
        # deadline already passed -> every layer is not_run
        steps = np.verify_candidate(candidate, {"protocol": "tcp", "port": 443}, deadline_at=-1)
        assert all(s["status"] == "not_run" for s in steps)

    def test_partial_deadline_first_layer_runs_rest_not_run(self):
        candidate = {"candidate_id": "c0", "kind": "resolved", "layer_plan": ["sg", "nacl", "route"],
                     "data": _topology_one_candidate()["candidates"][0]["data"]}
        clock = iter([0, 10])  # first check passes (0 < 5), second check fails (10 >= 5)

        def fake_now():
            return next(clock, 999)
        steps = np.verify_candidate(candidate, {"protocol": "tcp", "port": 443}, deadline_at=5, now=fake_now)
        assert steps[0]["status"] != "not_run"
        assert steps[1]["status"] == "not_run"
        assert steps[2]["status"] == "not_run"

    def test_evidence_is_bounded_and_redacted(self):
        candidate = {"candidate_id": "c0", "kind": "resolved", "layer_plan": ["sg"],
                     "data": {"sg": {"sg_rules": [{"sg_id": "sg-1", "protocol": "-1",
                                                     "cidr": "0.0.0.0/0", "password": "shh"}],
                                       "peer_ip": "1.2.3.4"}}}
        steps = np.verify_candidate(candidate, {"protocol": "tcp", "port": 443}, deadline_at=1e18)
        evidence = steps[0]["evidence"]
        assert evidence
        assert evidence[0].get("password") == "[redacted]"

    # ── CI-review MAJOR fix (round 18): `_nacl_or_unknown` used to guard only `nacl_forward` — an
    #    empty `nacl_return` fell straight through to `ad.eval_nacl`, which reads that emptiness as
    #    a confident deny on the return path, even though a real NACL always carries entries in
    #    BOTH directions (missing return data is exactly as "we have no data" as missing forward
    #    data). ─────────────────────────────────────────────────────────────────────────────────────

    def test_nacl_layer_is_unknown_when_return_entries_are_missing_even_with_forward_present(self):
        candidate = {"candidate_id": "c0", "kind": "resolved", "layer_plan": ["nacl"],
                     "data": {"nacl": {
                         "nacl_forward": [{"rule_number": 100, "protocol": "-1", "action": "allow"}],
                         "nacl_return": [],
                     }}}
        steps = np.verify_candidate(candidate, {"protocol": "tcp", "port": 443}, deadline_at=1e18)
        assert steps[0]["status"] == "unknown"

    def test_nacl_layer_is_unknown_when_forward_entries_are_missing(self):
        candidate = {"candidate_id": "c0", "kind": "resolved", "layer_plan": ["nacl"],
                     "data": {"nacl": {
                         "nacl_forward": [],
                         "nacl_return": [{"rule_number": 100, "protocol": "-1", "action": "allow"}],
                     }}}
        steps = np.verify_candidate(candidate, {"protocol": "tcp", "port": 443}, deadline_at=1e18)
        assert steps[0]["status"] == "unknown"

    def test_nacl_layer_evaluates_normally_when_both_directions_present(self):
        candidate = {"candidate_id": "c0", "kind": "resolved", "layer_plan": ["nacl"],
                     "data": {"nacl": {
                         "nacl_forward": [{"rule_number": 100, "protocol": "-1", "action": "allow"}],
                         "nacl_return": [{"rule_number": 100, "protocol": "-1", "action": "allow"}],
                     }}}
        steps = np.verify_candidate(candidate, {"protocol": "tcp", "port": 443}, deadline_at=1e18)
        assert steps[0]["status"] == "allowed"

    def test_k8s_calico_layer_wiring_is_unknown_when_policies_fetched_marker_is_absent(self):
        """CI-review MAJOR fix (round 23): the `k8s-calico` layer's wiring used to default
        `policies_fetched` to `True` — inconsistent with the sibling `dns`/`k8s-service-
        resolution` wiring (both default `False`) and a regression versus the OLD stub this real
        evaluator replaced (which always returned `unknown`). Partially-populated candidate data
        (a real Calico policy list, but no `policies_fetched` marker at all — the marker simply
        was never plumbed through by whatever populated `policies`) must not reach a confident
        verdict from data this worker never actually confirmed it fetched."""
        candidate = {"candidate_id": "c0", "kind": "resolved",
                     "layer_plan": ["k8s-calico"],
                     "data": {"k8s-calico": {
                         "policies": [{"selector": "role == 'web'", "types": ["Ingress"], "ingress": []}],
                         "pod_labels": {"role": "web"}, "direction": "ingress",
                         "crd_present": True, "api_version": "projectcalico.org/v3",
                         # deliberately no "policies_fetched" key
                     }}}
        steps = np.verify_candidate(candidate, {"protocol": "tcp", "port": 443}, deadline_at=1e18)
        assert steps[0]["status"] == "unknown"

    def test_evidence_item_count_capped(self):
        big_evidence = [{"i": i} for i in range(50)]
        bounded = np.bound_evidence(big_evidence)
        assert len(bounded) <= np._MAX_EVIDENCE_ITEMS

    def test_evidence_byte_size_capped(self):
        big_evidence = [{"blob": "x" * 10_000}]
        bounded = np.bound_evidence(big_evidence)
        assert len(bounded) == 0  # single item already exceeds the byte cap


# ── conclude ─────────────────────────────────────────────────────────────────────────────────────

class TestConclude:
    def test_multiple_candidates_independent_status(self):
        candidates = [
            {"candidate_id": "c0", "kind": "resolved",
             "steps": [{"layer": "sg", "status": "allowed", "summary": "ok"}]},
            {"candidate_id": "c1", "kind": "resolved",
             "steps": [{"layer": "sg", "status": "blocked", "summary": "denied"}]},
        ]
        per_candidate, overall = np.conclude(candidates)
        assert per_candidate[0]["status"] == "allowed"
        assert per_candidate[1]["status"] == "blocked"
        assert per_candidate[1]["first_blocker"] is not None
        assert overall == "conditional"  # disagreement among resolved candidates

    def test_validation_bundle_only_when_no_x_and_all_o(self):
        candidates = [{"candidate_id": "c0", "kind": "resolved",
                        "steps": [{"layer": "sg", "status": "allowed", "summary": "ok"}]}]
        bundle = np.build_validation_bundle(candidates, "allowed")
        assert bundle is not None

    def test_validation_bundle_absent_when_blocked(self):
        candidates = [{"candidate_id": "c0", "kind": "resolved",
                        "steps": [{"layer": "sg", "status": "blocked", "summary": "no"}]}]
        assert np.build_validation_bundle(candidates, "blocked") is None

    def test_validation_bundle_absent_when_conditional_layer_present(self):
        candidates = [{"candidate_id": "c0", "kind": "resolved",
                        "steps": [{"layer": "nacl", "status": "conditional", "summary": "scoped"}]}]
        assert np.build_validation_bundle(candidates, "conditional") is None

    def test_validation_bundle_lists_unknown_layers(self):
        candidates = [{"candidate_id": "c0", "kind": "resolved", "steps": [
            {"layer": "sg", "status": "allowed", "summary": "ok"},
            {"layer": "dns", "status": "unknown", "summary": "not evaluated"},
        ]}]
        bundle = np.build_validation_bundle(candidates, "allowed")
        assert bundle is not None
        assert "dns" in bundle["unknown_layers"]


# ── full run(): PK collision safety, multi-candidate persistence ───────────────────────────────

class TestFullRun:
    def test_two_candidates_no_pk_collision_at_same_ordinal(self):
        conn = FakeConn()
        resolved_definition = _definition()

        def two_candidate_topology(_resolved):
            topo = _topology_one_candidate()
            topo["candidates"].append(dict(topo["candidates"][0]))
            return topo

        result = np.run({"run_id": "run-1", "definition": resolved_definition,
                          "source_account_id": "111111111111"}, conn,
                         topology_fetcher=two_candidate_topology)
        assert result["status"] == "succeeded"
        steps = conn.inserted_steps()
        # Both candidates wrote a step at ordinal 0 — distinguished by candidate_id, no collision.
        ordinal_zero = [s for s in steps if s["o"] == 0]
        assert len(ordinal_zero) == 2
        assert {s["c"] for s in ordinal_zero} == {"c0", "c1"}

    def test_run_succeeds_and_writes_overall_status(self):
        conn = FakeConn()
        result = np.run({"run_id": "run-2", "definition": _definition(),
                          "source_account_id": "111111111111"}, conn,
                         topology_fetcher=lambda r: _topology_one_candidate())
        assert result["status"] == "succeeded"
        # MAJOR fix (2026-08-19+ review): the fixture's NACL forward+return rules are genuinely
        # unrestricted (protocol "-1", no port scoping at all) — with eval_nacl's fix, this is no
        # longer force-capped at `conditional`; it correctly reaches `allowed`. This is the
        # end-to-end proof that candidate-level `allowed` (and the validation bundle) ARE reachable
        # through the real run() path — not just hand-fed into build_validation_bundle() directly.
        assert result["overall_status"] == "allowed"
        finishes = conn.run_finishes()
        assert finishes[-1]["s"] == "succeeded"
        assert finishes[-1]["os"] == "allowed"
        assert finishes[-1]["vb"] is not None  # validation bundle is populated, not dead code
        bundle = json.loads(finishes[-1]["vb"])
        assert bundle["unknown_layers"] == []  # sg/nacl/route are all inspectable and allowed here


    def test_default_topology_fetcher_uses_real_fetch_live_topology(self):
        """Gap 1: fetch_live_topology() is no longer a stub — run()'s default fetcher now goes
        through it (against the Aurora `conn` run() already holds) and, with zero seeded topology
        rows, degrades honestly to a single `hypothesis` candidate rather than crashing or
        fabricating a confident path. This replaces the old stub-era test that asserted a terminal
        `failed`/NotImplementedError run."""
        conn = FakeConn()  # no seeded node/edge rows -> nothing resolves
        result = np.run({"run_id": "run-3", "definition": _definition(),
                          "source_account_id": "111111111111"}, conn)  # default fetcher
        assert result["status"] == "succeeded"
        candidates = conn.inserted_candidates()
        assert len(candidates) == 1
        assert candidates[0]["k"] == "hypothesis"  # nothing resolved -> honest ambiguity, not a guess
        # sg/nacl/route all degrade to `unknown` (no cached rule/ACL/route content) -- never a
        # fabricated allowed/blocked from empty data.
        steps = conn.inserted_steps()
        by_layer = {s["l"]: s["st"] for s in steps}
        assert by_layer["sg"] == "unknown"
        assert by_layer["nacl"] == "unknown"
        assert by_layer["route"] == "unknown"


# ── grep-verifiable: never calls the SSRF-risk active-probe helper ─────────────────────────────

def test_never_calls_test_http_connectivity():
    # The name may appear in a comment/docstring explaining that it's NOT used (as it does in
    # network_path_adapters.py's module docstring) — what must never appear is an actual CALL.
    targets = glob.glob(os.path.join(os.path.dirname(os.path.abspath(__file__)), "network_path*.py"))
    assert targets
    for path in targets:
        if os.path.basename(path).startswith("test_"):
            continue
        with open(path, encoding="utf-8") as f:
            src = f.read()
        assert "_test_http_connectivity(" not in src, path
