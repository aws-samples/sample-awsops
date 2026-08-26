"""Tests for inventory_read_mcp — Aurora-backed read-only topology/unused-resource MCP tool.

The pure detection logic (detect_unused) takes already-fetched inventory rows (the JSONB `data`
of inventory_resources, keyed by resource_type) so it is testable with fixtures — no DB, no boto3.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import inventory_read_mcp as inv  # noqa: E402


def _tg(name, lb_arns, states):
    """A target_group `data` row: load_balancer_arns + target_health_descriptions[].TargetHealth.State."""
    return {
        "target_group_arn": f"arn:aws:elasticloadbalancing:ap-northeast-2:1:targetgroup/{name}/abc",
        "target_group_name": name,
        "load_balancer_arns": lb_arns,
        "target_health_descriptions": [{"Target": {"Id": f"i-{i}"}, "TargetHealth": {"State": s}}
                                       for i, s in enumerate(states)],
    }


def _lb(name, dns):
    return {"name": name, "dns_name": dns, "arn": f"arn:aws:elasticloadbalancing:ap-northeast-2:1:loadbalancer/app/{name}/xyz",
            "type": "application", "state_code": "active"}


def _cf(cid, enabled, origin_domains):
    return {"id": cid, "domain_name": f"{cid}.cloudfront.net", "enabled": enabled,
            "origins": [{"DomainName": d, "Id": d} for d in origin_domains]}


class TestOrphanTargetGroup(unittest.TestCase):
    def test_tg_with_no_load_balancer_is_flagged_high(self):
        findings = inv.detect_unused({"target_group": [_tg("orphan-tg", [], [])]})
        hit = [f for f in findings if f["resource_id"].endswith("orphan-tg/abc") or f["name"] == "orphan-tg"]
        self.assertEqual(len(hit), 1, f"expected orphan-tg flagged once, got {findings}")
        self.assertEqual(hit[0]["severity"], "high")
        self.assertEqual(hit[0]["resource_type"], "TargetGroup")
        self.assertIn("load balancer", hit[0]["reason"].lower())

    def test_tg_attached_to_lb_is_not_orphan(self):
        findings = inv.detect_unused({
            "target_group": [_tg("attached-tg", ["arn:...:loadbalancer/app/x/1"], ["healthy"])],
        })
        self.assertEqual([f for f in findings if f["name"] == "attached-tg"], [])


class TestUnhealthyTargetGroup(unittest.TestCase):
    def test_attached_tg_with_zero_healthy_is_flagged(self):
        findings = inv.detect_unused({
            "target_group": [_tg("dead-tg", ["arn:...:loadbalancer/app/x/1"], ["unhealthy", "unhealthy"])],
        })
        hit = [f for f in findings if f["name"] == "dead-tg"]
        self.assertEqual(len(hit), 1)
        self.assertEqual(hit[0]["severity"], "high")
        self.assertIn("healthy", hit[0]["reason"].lower())

    def test_healthy_tg_not_flagged(self):
        findings = inv.detect_unused({
            "target_group": [_tg("live-tg", ["arn:...:loadbalancer/app/x/1"], ["healthy", "unhealthy"])],
        })
        self.assertEqual([f for f in findings if f["name"] == "live-tg"], [])


class TestEmptyCloudFrontOrigin(unittest.TestCase):
    def test_origin_pointing_at_lb_with_no_healthy_backend_is_empty(self):
        dns = "grafana-nlb.elb.ap-northeast-2.amazonaws.com"
        findings = inv.detect_unused({
            "cloudfront": [_cf("E1EMPTY", True, [dns])],
            "nlb": [_lb("grafana-nlb", dns)],
            # the only TG on this LB has zero healthy targets → origin is "empty"
            "target_group": [_tg("g-tg", ["arn:aws:elasticloadbalancing:ap-northeast-2:1:loadbalancer/app/grafana-nlb/xyz"], [])],
        })
        hit = [f for f in findings if f["resource_type"] == "CloudFront" and "E1EMPTY" in f["resource_id"]]
        self.assertTrue(hit, f"expected empty-origin CF flagged, got {findings}")
        self.assertIn("origin", hit[0]["reason"].lower())

    def test_origin_with_healthy_backend_not_flagged_as_empty(self):
        dns = "good-alb.elb.ap-northeast-2.amazonaws.com"
        findings = inv.detect_unused({
            "cloudfront": [_cf("E1GOOD", True, [dns])],
            "alb": [_lb("good-alb", dns)],
            "target_group": [_tg("ok-tg", ["arn:aws:elasticloadbalancing:ap-northeast-2:1:loadbalancer/app/good-alb/xyz"], ["healthy"])],
        })
        self.assertEqual([f for f in findings if f["resource_type"] == "CloudFront" and "E1GOOD" in f["resource_id"]], [])

    def test_disabled_distribution_flagged_medium(self):
        findings = inv.detect_unused({"cloudfront": [_cf("E1OFF", False, [])]})
        hit = [f for f in findings if "E1OFF" in f["resource_id"]]
        self.assertTrue(hit)
        self.assertEqual(hit[0]["severity"], "medium")


class TestUnattachedEbs(unittest.TestCase):
    def test_available_volume_flagged_high(self):
        findings = inv.detect_unused({"ebs": [{"volume_id": "vol-1", "state": "available", "size": 50, "volume_type": "gp3"}]})
        hit = [f for f in findings if f["resource_id"] == "vol-1"]
        self.assertEqual(len(hit), 1)
        self.assertEqual(hit[0]["severity"], "high")

    def test_in_use_volume_not_flagged(self):
        findings = inv.detect_unused({"ebs": [{"volume_id": "vol-2", "state": "in-use", "size": 50}]})
        self.assertEqual([f for f in findings if f["resource_id"] == "vol-2"], [])


class TestEmptyInputSafe(unittest.TestCase):
    def test_no_inventory_returns_empty_list(self):
        self.assertEqual(inv.detect_unused({}), [])


class TestHandlerWithInjectedDataApi(unittest.TestCase):
    """Handler dispatch + RDS Data API integration, with _execute injected (no real AWS)."""

    def tearDown(self):
        inv._execute_override = None

    def test_find_unused_resources_returns_findings_and_note(self):
        def fake(sql, params=None):
            self.assertIn("inventory_resources", sql)
            return [{"resource_type": "target_group", "data": _tg("lonely-tg", [], [])}]
        inv._execute_override = fake
        out = inv.lambda_handler({"tool_name": "find_unused_resources"}, None)
        self.assertEqual(out["statusCode"], 200)
        import json as _j
        body = _j.loads(out["body"])
        self.assertGreaterEqual(body["count"], 1)
        self.assertTrue(any(f["name"] == "lonely-tg" for f in body["findings"]))
        self.assertIn("note", body)

    def test_query_inventory_binds_resource_type_as_parameter(self):
        seen = {}
        def fake(sql, params=None):
            seen["sql"], seen["params"] = sql, params
            return [{"data": {"name": "x"}}]
        inv._execute_override = fake
        out = inv.lambda_handler({"tool_name": "query_inventory", "arguments": {"resource_type": "alb"}}, None)
        self.assertEqual(out["statusCode"], 200)
        # user input must be a bound Data API parameter, never inlined into SQL
        self.assertEqual(seen["params"], [{"name": "rt", "value": {"stringValue": "alb"}}])
        self.assertNotIn("alb", seen["sql"])

    def test_query_inventory_returns_ecs_service_rows(self):
        seen = {}
        def fake(sql, params=None):
            seen["sql"], seen["params"] = sql, params
            return [{"data": {"service_name": "api", "desired_count": 2, "running_count": 1}}]
        inv._execute_override = fake
        import json as _j
        out = inv.lambda_handler({"tool_name": "query_inventory", "arguments": {"resource_type": "ecs_service"}}, None)
        self.assertEqual(out["statusCode"], 200)
        body = _j.loads(out["body"])
        self.assertEqual(body["resource_type"], "ecs_service")
        self.assertEqual(body["resources"][0]["service_name"], "api")
        self.assertEqual(seen["params"], [{"name": "rt", "value": {"stringValue": "ecs_service"}}])
        self.assertNotIn("ecs_service", seen["sql"])

    def test_query_inventory_requires_resource_type(self):
        out = inv.lambda_handler({"tool_name": "query_inventory", "arguments": {}}, None)
        self.assertEqual(out["statusCode"], 400)

    def test_unknown_tool_is_400(self):
        out = inv.lambda_handler({"tool_name": "delete_everything"}, None)
        self.assertEqual(out["statusCode"], 400)

    def test_fetch_by_type_ignores_non_allowlisted_types(self):
        # guards against any non-allowlisted (potentially malicious) resource_type reaching SQL
        calls = []
        def fake(sql, params=None):
            calls.append((sql, params))
            return []
        inv._execute_override = fake
        inv._fetch_by_type(["target_group", "'; DROP TABLE x; --"])
        self.assertEqual(len(calls), 1)  # only the allowlisted type is queried
        self.assertNotIn("DROP", calls[0][0])
        self.assertEqual(calls[0][1][0]["value"]["stringValue"], "target_group")

    def test_fetch_by_type_projects_fields_to_avoid_1mb_data_api_limit(self):
        # Must NOT SELECT the full `data` column (RDS Data API hard 1MB cap) — project only the
        # keys the detector reads, one bounded query per type with the type bound as a parameter.
        calls = []
        def fake(sql, params=None):
            calls.append((sql, params))
            return []
        inv._execute_override = fake
        inv._fetch_by_type(["target_group", "cloudfront"])
        self.assertEqual(len(calls), 2)  # one projected query per type
        for sql, params in calls:
            self.assertIn("jsonb_build_object", sql)        # projected, not full-column
            self.assertNotIn("SELECT data ", sql)
            self.assertEqual(params[0]["name"], "rt")
        self.assertEqual({p[0]["value"]["stringValue"] for _, p in calls}, {"target_group", "cloudfront"})

    def test_query_inventory_non_numeric_limit_does_not_500(self):
        inv._execute_override = lambda sql, params=None: [{"data": {"name": "x"}}]
        out = inv.lambda_handler({"tool_name": "query_inventory",
                                  "arguments": {"resource_type": "alb", "limit": "oops"}}, None)
        self.assertEqual(out["statusCode"], 200)

    def test_get_topology_reads_topology_tables_not_inventory(self):
        """get_topology must query topology_nodes/edges, returning the /api/graph node+edge contract."""
        calls = []
        def fake(sql, params=None):
            calls.append(sql)
            if "topology_nodes" in sql:
                return [{"id": "cf:E1", "kind": "cloudfront", "label": "my-cf", "meta": {"id": "E1"}}]
            if "topology_edges" in sql:
                return [{"source": "cf:E1", "target": "alb:arn-1", "rel": "ORIGIN", "confidence": "observed"}]
            return []
        inv._execute_override = fake
        out = inv.lambda_handler({"tool_name": "get_topology"}, None)
        self.assertEqual(out["statusCode"], 200)
        import json as _j
        body = _j.loads(out["body"])
        # /api/graph contract: nodes + edges, NOT "chains"
        self.assertIn("nodes", body)
        self.assertIn("edges", body)
        self.assertNotIn("chains", body)
        self.assertEqual(body["class"], "flow")
        self.assertEqual(body["node_count"], 1)
        self.assertEqual(body["edge_count"], 1)
        self.assertTrue(any("topology_nodes" in c for c in calls), "must query topology_nodes")
        self.assertTrue(any("topology_edges" in c for c in calls), "must query topology_edges")
        # must NOT query inventory_resources for get_topology
        self.assertFalse(any("inventory_resources" in c for c in calls), "must not fall back to raw inventory")

    def test_get_topology_with_resource_id_scopes_to_neighbourhood(self):
        """resource_id must filter to the requested node + its 1-hop neighbours only."""
        def fake(sql, params=None):
            if "topology_nodes" in sql:
                return [
                    {"id": "cf:E1", "kind": "cloudfront", "label": "my-cf", "meta": {}},
                    {"id": "alb:arn-1", "kind": "alb", "label": "my-alb", "meta": {}},
                    {"id": "tg:arn-2", "kind": "tg", "label": "my-tg", "meta": {}},
                    {"id": "tg:arn-99", "kind": "tg", "label": "unrelated", "meta": {}},
                ]
            if "topology_edges" in sql:
                return [
                    {"source": "cf:E1", "target": "alb:arn-1", "rel": "ORIGIN", "confidence": "observed"},
                    {"source": "alb:arn-1", "target": "tg:arn-2", "rel": "TARGETS", "confidence": "observed"},
                ]
            return []
        inv._execute_override = fake
        import json as _j
        out = inv.lambda_handler({"tool_name": "get_topology", "arguments": {"resource_id": "alb:arn-1"}}, None)
        body = _j.loads(out["body"])
        ids = {n["id"] for n in body["nodes"]}
        self.assertIn("alb:arn-1", ids)
        self.assertIn("cf:E1", ids)     # 1-hop upstream
        self.assertIn("tg:arn-2", ids)  # 1-hop downstream
        self.assertNotIn("tg:arn-99", ids)  # unconnected → excluded
        self.assertEqual(body["from"], "alb:arn-1")

    def test_get_topology_empty_graph_returns_warning(self):
        """Empty topology_nodes → warning with actionable hint (graph not materialized)."""
        inv._execute_override = lambda sql, params=None: []
        import json as _j
        out = inv.lambda_handler({"tool_name": "get_topology"}, None)
        self.assertEqual(out["statusCode"], 200)
        body = _j.loads(out["body"])
        self.assertEqual(body["nodes"], [])
        self.assertEqual(body["edges"], [])
        self.assertIn("warning", body)
        self.assertIn("graph-rebuild", body["warning"])

    def test_get_topology_class_infra_forwarded(self):
        """class='infra' must be passed as the :cls parameter to both topology queries."""
        seen_cls = []
        def fake(sql, params=None):
            for p in (params or []):
                if p["name"] == "cls":
                    seen_cls.append(p["value"]["stringValue"])
            return []
        inv._execute_override = fake
        inv.lambda_handler({"tool_name": "get_topology", "arguments": {"class": "infra"}}, None)
        self.assertTrue(all(c == "infra" for c in seen_cls), f"expected all cls='infra', got {seen_cls}")
        self.assertEqual(len(seen_cls), 2, "must issue two queries (nodes + edges)")

    def test_get_topology_class_trace_preserved(self):
        """class='trace' (the third materialized layer) must be preserved, NOT silently → flow."""
        import json as _j
        inv._execute_override = lambda sql, params=None: []
        out = inv.lambda_handler({"tool_name": "get_topology", "arguments": {"class": "trace"}}, None)
        self.assertEqual(out["statusCode"], 200)
        body = _j.loads(out["body"])
        self.assertEqual(body["class"], "trace")

    def test_get_topology_unknown_class_is_400(self):
        """Unknown class must be REJECTED (400), not silently coerced to flow — matches the
        /api/graph BFF (plan T7b: both read paths reject identically) (M4)."""
        import json as _j
        inv._execute_override = lambda sql, params=None: []
        out = inv.lambda_handler({"tool_name": "get_topology", "arguments": {"class": "bogus"}}, None)
        self.assertEqual(out["statusCode"], 400)
        body = _j.loads(out["body"])
        self.assertIn("invalid class", body["error"])

    def test_build_topology_chain_skips_null_origin_domain(self):
        # a null origin DomainName must not match a load balancer with a null dns_name
        chains = inv.build_topology_chain({
            "cloudfront": [{"id": "E1", "origins": [{"DomainName": None}]}],
            "alb": [{"name": "x", "dns_name": None, "arn": "a"}],
        })
        self.assertTrue(all(c["loadBalancer"] is None for c in chains))


class TestCatalogWiring(unittest.TestCase):
    def test_inventory_read_catalog_advertises_ecs_service(self):
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "v2", "agentcore"))
        import catalog
        t = catalog.TARGETS.get("inventory-read-target")
        self.assertIsNotNone(t, "inventory-read-target missing from catalog.TARGETS")
        tool = next(x for x in t["tools"] if x["name"] == "query_inventory")
        self.assertIn("ecs_service", tool["description"])


if __name__ == "__main__":
    unittest.main()
