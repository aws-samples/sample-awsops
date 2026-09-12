"""Tests for inventory_read_mcp — Aurora-backed read-only topology/unused-resource MCP tool.

The pure detection logic (detect_unused) takes already-fetched inventory rows (the JSONB `data`
of inventory_resources, keyed by resource_type) so it is testable with fixtures — no DB, no boto3.
"""
import os
import json
import sys
import unittest
from unittest import mock

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
        calls = []
        def fake(sql, params=None):
            calls.append((sql, params))
            return [{"data": {"name": "x"}}]
        inv._execute_override = fake
        out = inv.lambda_handler({"tool_name": "query_inventory", "arguments": {"resource_type": "alb"}}, None)
        self.assertEqual(out["statusCode"], 200)
        # user input must be a bound Data API parameter, never inlined into SQL
        inventory_sql, inventory_params = next(
            call for call in calls if "SELECT jsonb_build_object" in call[0]
        )
        self.assertEqual(inventory_params, [{"name": "rt", "value": {"stringValue": "alb"}}])
        self.assertNotIn("alb", inventory_sql)

    def test_query_inventory_discloses_bound_per_type_freshness(self):
        calls = []

        def fake(sql, params=None):
            calls.append((sql, params))
            if "inventory_sync_runs" in sql:
                return [{
                    "resource_type": "alb",
                    "status": "succeeded",
                    "finished_at": "2026-08-31T00:00:00+00:00",
                    "row_count": 1,
                    "last_success_at": "2026-08-31T00:00:00+00:00",
                    "last_success_row_count": 1,
                    "oldest_captured_at": "2026-08-31T00:00:00+00:00",
                    "latest_success_at": "2026-08-31T00:00:00+00:00",
                    "freshness": "stale",
                    "age_minutes": 31,
                    "stale_after_minutes": 30,
                }]
            return [{"data": {"name": "x"}}]

        inv._execute_override = fake
        with mock.patch.dict(os.environ, {"INVENTORY_STALE_AFTER_MINUTES": "30"}):
            out = inv.lambda_handler(
                {"tool_name": "query_inventory", "arguments": {"resource_type": "alb"}},
                None,
            )

        import json as _j
        body = _j.loads(out["body"])
        self.assertEqual(body["freshness"]["resource_type"], "alb")
        self.assertEqual(body["freshness"]["freshness"], "stale")
        self.assertEqual(body["freshness"]["age_minutes"], 31)
        self.assertEqual(body["freshness"]["last_success_row_count"], 1)
        freshness_call = next(call for call in calls if "inventory_sync_runs" in call[0])
        self.assertEqual(
            freshness_call[1],
            [
                {"name": "stale_after_minutes", "value": {"longValue": 30}},
                {"name": "rt", "value": {"stringValue": "alb"}},
            ],
        )
        self.assertNotIn("'alb'", freshness_call[0])

    def test_query_inventory_discloses_partial_as_degraded_without_hiding_oldest_data(self):
        calls = []

        def fake(sql, params=None):
            calls.append((sql, params))
            if "inventory_sync_runs" in sql:
                return [{
                    "resource_type": "ec2",
                    "status": "partial",
                    "finished_at": "2026-08-31T00:15:00+00:00",
                    "row_count": 3,
                    "last_success_at": "2026-08-31T00:00:00+00:00",
                    "last_success_row_count": 4,
                    "oldest_captured_at": "2026-08-31T00:00:00+00:00",
                    "latest_success_at": "2026-08-31T00:00:00+00:00",
                    "freshness": "degraded",
                    "age_minutes": 15,
                    "stale_after_minutes": 30,
                }]
            return [{"data": {"instance_id": "i-1"}}]

        inv._execute_override = fake
        out = inv.lambda_handler(
            {"tool_name": "query_inventory", "arguments": {"resource_type": "ec2"}},
            None,
        )

        import json as _j
        body = _j.loads(out["body"])
        self.assertEqual(body["freshness"]["status"], "partial")
        self.assertEqual(body["freshness"]["freshness"], "degraded")
        self.assertEqual(body["freshness"]["oldest_captured_at"], "2026-08-31T00:00:00+00:00")
        freshness_sql = next(sql for sql, _ in calls if "inventory_sync_runs" in sql)
        self.assertIn("MIN(captured_at) AS oldest_captured_at", freshness_sql)
        self.assertIn("LEFT JOIN resource_counts resources", freshness_sql)
        self.assertIn("runs.last_success_at", freshness_sql)
        self.assertIn("runs.last_success_row_count", freshness_sql)
        self.assertIn("COALESCE(oldest_captured_at, last_success_at)", freshness_sql)
        self.assertIn("IN ('partial', 'failed', 'running')", freshness_sql)
        self.assertNotIn("MAX(resources.captured_at)", freshness_sql)

    def test_first_run_partial_or_failed_without_durable_success_is_unavailable(self):
        calls = []

        def fake(sql, params=None):
            calls.append((sql, params))
            return [
                {
                    "resource_type": "cloudfront_vpc_origin",
                    "status": "partial",
                    "last_success_at": None,
                    "oldest_captured_at": "2026-08-31T00:14:00+00:00",
                    "latest_success_at": None,
                    "freshness": "unavailable",
                    "age_minutes": None,
                    "stale_after_minutes": 30,
                },
                {
                    "resource_type": "alb_listener_rule",
                    "status": "failed",
                    "last_success_at": None,
                    "oldest_captured_at": "2026-08-31T00:14:00+00:00",
                    "latest_success_at": None,
                    "freshness": "unavailable",
                    "age_minutes": None,
                    "stale_after_minutes": 30,
                },
            ]

        inv._execute_override = fake
        with mock.patch.dict(os.environ, {"INVENTORY_STALE_AFTER_MINUTES": "30"}):
            rows = inv._sync_freshness()

        self.assertEqual(
            {row["resource_type"]: row["freshness"] for row in rows},
            {
                "cloudfront_vpc_origin": "unavailable",
                "alb_listener_rule": "unavailable",
            },
        )
        freshness_sql, freshness_params = calls[0]
        self.assertIn(
            "CASE WHEN last_success_at IS NULL THEN NULL ELSE "
            "LEAST(last_success_at, COALESCE(oldest_captured_at, last_success_at)) END "
            "AS latest_success_at",
            freshness_sql,
        )
        self.assertEqual(
            freshness_params,
            [{"name": "stale_after_minutes", "value": {"longValue": 30}}],
        )

    def test_repeated_partial_uses_old_success_or_older_capture_for_stale_precedence(self):
        calls = []

        def fake(sql, params=None):
            calls.append((sql, params))
            return [
                {
                    "resource_type": "s3",
                    "status": "partial",
                    "last_success_at": "2026-08-31T00:00:00+00:00",
                    "oldest_captured_at": "2026-08-31T00:10:00+00:00",
                    "latest_success_at": "2026-08-31T00:00:00+00:00",
                    "freshness": "stale",
                    "age_minutes": 45,
                    "stale_after_minutes": 30,
                },
                {
                    "resource_type": "s3_public_access",
                    "status": "partial",
                    "last_success_at": "2026-08-31T00:25:00+00:00",
                    "oldest_captured_at": "2026-08-31T00:20:00+00:00",
                    "latest_success_at": "2026-08-31T00:20:00+00:00",
                    "freshness": "degraded",
                    "age_minutes": 25,
                    "stale_after_minutes": 30,
                },
            ]

        inv._execute_override = fake
        rows = inv._sync_freshness()

        by_type = {row["resource_type"]: row for row in rows}
        self.assertEqual(by_type["s3"]["freshness"], "stale")
        self.assertEqual(by_type["s3"]["latest_success_at"], "2026-08-31T00:00:00+00:00")
        self.assertEqual(by_type["s3_public_access"]["freshness"], "degraded")
        self.assertEqual(
            by_type["s3_public_access"]["latest_success_at"],
            "2026-08-31T00:20:00+00:00",
        )
        freshness_sql = calls[0][0]
        self.assertLess(
            freshness_sql.index("WHEN latest_success_at IS NULL THEN 'unavailable'"),
            freshness_sql.index(
                "WHEN latest_success_at < CURRENT_TIMESTAMP - "
                "(:stale_after_minutes * INTERVAL '1 minute') THEN 'stale'"
            ),
        )
        self.assertLess(
            freshness_sql.index(
                "WHEN latest_success_at < CURRENT_TIMESTAMP - "
                "(:stale_after_minutes * INTERVAL '1 minute') THEN 'stale'"
            ),
            freshness_sql.index("WHEN status IN ('partial', 'failed', 'running') THEN 'degraded'"),
        )

    def test_succeeded_run_with_attribute_blind_spots_is_degraded_not_healthy(self):
        calls = []

        def fake(sql, params=None):
            calls.append((sql, params))
            return [
                {
                    "resource_type": "s3_public_access",
                    "status": "succeeded",
                    "last_success_at": "2026-08-31T00:25:00+00:00",
                    "unknown_attribute_count": 2,
                    "oldest_captured_at": "2026-08-31T00:25:00+00:00",
                    "latest_success_at": "2026-08-31T00:25:00+00:00",
                    "freshness": "degraded",
                    "age_minutes": 2,
                    "stale_after_minutes": 30,
                },
                {
                    "resource_type": "s3",
                    "status": "succeeded",
                    "last_success_at": "2026-08-31T00:25:00+00:00",
                    "unknown_attribute_count": 0,
                    "oldest_captured_at": "2026-08-31T00:25:00+00:00",
                    "latest_success_at": "2026-08-31T00:25:00+00:00",
                    "freshness": "healthy",
                    "age_minutes": 2,
                    "stale_after_minutes": 30,
                },
                {
                    "resource_type": "alb",
                    "status": "succeeded",
                    "last_success_at": "2026-08-31T00:25:00+00:00",
                    "unknown_attribute_count": None,
                    "oldest_captured_at": "2026-08-31T00:25:00+00:00",
                    "latest_success_at": "2026-08-31T00:25:00+00:00",
                    "freshness": "healthy",
                    "age_minutes": 2,
                    "stale_after_minutes": 30,
                },
            ]

        inv._execute_override = fake
        rows = inv._sync_freshness()

        by_type = {row["resource_type"]: row for row in rows}
        # blind attribute reads degrade the DISCLOSED freshness; an explicit 0/None stays healthy
        self.assertEqual(by_type["s3_public_access"]["freshness"], "degraded")
        self.assertEqual(by_type["s3_public_access"]["unknown_attribute_count"], 2)
        self.assertEqual(by_type["s3"]["freshness"], "healthy")
        self.assertEqual(by_type["alb"]["freshness"], "healthy")
        freshness_sql = calls[0][0]
        self.assertIn("runs.unknown_attribute_count", freshness_sql)
        self.assertIn(
            "WHEN status = 'succeeded' AND COALESCE(unknown_attribute_count, 0) > 0 "
            "THEN 'degraded'",
            freshness_sql,
        )
        # the unknown-attribute arm must precede the plain succeeded->healthy arm
        self.assertLess(
            freshness_sql.index(
                "WHEN status = 'succeeded' AND COALESCE(unknown_attribute_count, 0) > 0 "
                "THEN 'degraded'"
            ),
            freshness_sql.index("WHEN status = 'succeeded' THEN 'healthy'"),
        )

    def test_inventory_summary_binds_threshold_and_returns_per_type_freshness(self):
        calls = []

        def fake(sql, params=None):
            calls.append((sql, params))
            return [{
                "resource_type": "ec2",
                "status": "succeeded",
                "finished_at": "2026-08-31T00:00:00+00:00",
                "row_count": 2,
                "current_count": 5,
                "last_success_at": "2026-08-31T00:00:00+00:00",
                "last_success_row_count": 2,
                "oldest_captured_at": "2026-08-31T00:04:00+00:00",
                "latest_success_at": "2026-08-31T00:00:00+00:00",
                "freshness": "healthy",
                "age_minutes": 4,
                "stale_after_minutes": 30,
            }]

        inv._execute_override = fake
        with mock.patch.dict(os.environ, {"INVENTORY_STALE_AFTER_MINUTES": "30"}):
            out = inv.lambda_handler({"tool_name": "inventory_summary"}, None)

        import json as _j
        body = _j.loads(out["body"])
        self.assertEqual(body["sync"][0]["resource_type"], "ec2")
        self.assertEqual(body["sync"][0]["freshness"], "healthy")
        self.assertEqual(body["sync"][0]["row_count"], 2)
        self.assertEqual(body["sync"][0]["current_count"], 5)
        self.assertEqual(
            calls[0][1],
            [{"name": "stale_after_minutes", "value": {"longValue": 30}}],
        )
        summary_sql = calls[0][0]
        self.assertIn("COUNT(*)::integer AS current_count", summary_sql)
        self.assertIn(
            "FROM inventory_resources WHERE account_id = 'self' GROUP BY resource_type",
            summary_sql,
        )
        self.assertIn("resources.current_count", summary_sql)
        self.assertNotIn(
            "LEFT JOIN inventory_resources resources",
            summary_sql,
            "joining raw resources to the run ledger can multiply summary counts",
        )

    def test_inventory_summary_discloses_stale_and_zero_row_failed_histories(self):
        def fake(sql, params=None):
            return [
                {
                    "resource_type": "alb",
                    "status": "partial",
                    "last_success_at": "2026-08-31T00:00:00+00:00",
                    "last_success_row_count": 2,
                    "oldest_captured_at": "2026-08-30T23:00:00+00:00",
                    "latest_success_at": "2026-08-30T23:00:00+00:00",
                    "freshness": "stale",
                    "age_minutes": 60,
                    "stale_after_minutes": 30,
                },
                {
                    "resource_type": "route53",
                    "status": "failed",
                    "last_success_at": "2026-08-31T00:10:00+00:00",
                    "last_success_row_count": 0,
                    "oldest_captured_at": None,
                    "latest_success_at": "2026-08-31T00:10:00+00:00",
                    "freshness": "degraded",
                    "age_minutes": 5,
                    "stale_after_minutes": 30,
                },
            ]

        inv._execute_override = fake
        out = inv.lambda_handler({"tool_name": "inventory_summary"}, None)

        import json as _j
        body = _j.loads(out["body"])
        by_type = {row["resource_type"]: row for row in body["sync"]}
        self.assertEqual(by_type["alb"]["freshness"], "stale")
        self.assertEqual(by_type["route53"]["freshness"], "degraded")
        self.assertEqual(by_type["route53"]["last_success_row_count"], 0)
        self.assertIsNone(by_type["route53"]["oldest_captured_at"])

    def test_stale_threshold_env_defaults_and_rejects_invalid_values(self):
        self.assertEqual(inv._inventory_stale_after_minutes({}), 30)
        self.assertEqual(
            inv._inventory_stale_after_minutes({"INVENTORY_STALE_AFTER_MINUTES": "45"}),
            45,
        )
        for raw in ("0", "1441", "1.5", "not-a-number", ""):
            with self.subTest(raw=raw):
                self.assertEqual(
                    inv._inventory_stale_after_minutes(
                        {"INVENTORY_STALE_AFTER_MINUTES": raw}
                    ),
                    30,
                )

    def test_query_inventory_returns_ecs_service_rows(self):
        calls = []
        def fake(sql, params=None):
            calls.append((sql, params))
            return [{"data": {"service_name": "api", "desired_count": 2, "running_count": 1}}]
        inv._execute_override = fake
        import json as _j
        out = inv.lambda_handler({"tool_name": "query_inventory", "arguments": {"resource_type": "ecs_service"}}, None)
        self.assertEqual(out["statusCode"], 200)
        body = _j.loads(out["body"])
        self.assertEqual(body["resource_type"], "ecs_service")
        self.assertEqual(body["resources"][0]["service_name"], "api")
        inventory_sql, inventory_params = next(
            call for call in calls
            if "inventory_resources" in call[0] and "inventory_sync_runs" not in call[0]
        )
        self.assertEqual(
            inventory_params,
            [{"name": "rt", "value": {"stringValue": "ecs_service"}}],
        )
        self.assertNotIn("ecs_service", inventory_sql)

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


class TestTraceTopologyCollection(unittest.TestCase):
    NOW = 1_789_128_000  # 2026-09-11T12:00:00Z
    CAPTURED = "2026-09-11T11:55:00+00:00"
    ATTEMPTED = "2026-09-11T11:59:00+00:00"

    def tearDown(self):
        inv._execute_override = None

    def _read(self, state, nodes=None, edges=None, arguments=None,
              schema_present=True, edge_meta_present=True):
        calls = []

        def fake(sql, params=None):
            calls.append((sql, params))
            if "to_regclass" in sql:
                return [{"state_relation": "sql_reader.topology_graph_state" if schema_present else None}]
            if "topology_graph_state" in sql:
                if not schema_present:
                    raise RuntimeError("relation topology_graph_state does not exist")
                return [state] if state is not None else []
            if "topology_nodes" in sql:
                return nodes if nodes is not None else [
                    {"id": "svc:checkout", "kind": "service", "label": "checkout", "meta": {}},
                ]
            if "topology_edges" in sql:
                if not edge_meta_present and "to_jsonb(e)->'meta' AS meta" not in sql:
                    raise RuntimeError("column meta does not exist")
                return edges or []
            self.fail(f"unexpected query: {sql}")

        inv._execute_override = fake
        # Use the real clock boundary; no DB, boto3, or live AWS call can occur.
        with mock.patch("time.time", return_value=self.NOW):
            response = inv.lambda_handler({
                "tool_name": "get_topology", "arguments": {"class": "trace", **(arguments or {})},
            }, None)
        self.assertEqual(response["statusCode"], 200)
        return json.loads(response["body"]), calls

    def _state(self, status="ok", details=None, captured_at=CAPTURED):
        return {"status": status, "attempted_at": self.ATTEMPTED, "captured_at": captured_at,
                "details": {"sources": [], "retainedPrevious": False} if details is None else details}

    def test_queue_arn_claims_remain_unverified_including_before_projection_migration(self):
        for attrs in [
            {"accountId": "111122223333", "region": "us-east-1"},
            {"claimedAccountId": "111122223333", "claimedRegion": "us-east-1"},
        ]:
            body, _ = self._read(self._state(), nodes=[{
                "id": "queue:one", "kind": "queue", "label": "orders",
                "meta": {**attrs, "identityProvenance": "aws_verified", "infra_ref": "inventory:queue"},
            }])
            self.assertEqual(body["nodes"][0]["meta"], {
                "claimedAccountId": "111122223333", "claimedRegion": "us-east-1",
                "identityProvenance": "telemetry_claim",
            })
            self.assertIn("not verified AWS", body["note"])

    def test_trace_returns_latest_failure_and_retained_snapshot_evidence(self):
        source = {
            "sourceId": "tempo:7", "status": "error", "reasons": ["trace_fetch_failed"], "itemCount": 0,
            "windowStartMs": 1_789_124_340_000, "windowEndMs": 1_789_127_940_000,
        }
        body, _ = self._read(self._state("error", {
            "sources": [source], "retainedPrevious": True,
            "windowStartMs": source["windowStartMs"], "windowEndMs": source["windowEndMs"],
        }))
        self.assertEqual(body["collection"], {
            "status": "error", "stale": True, "attempted_at": self.ATTEMPTED, "captured_at": self.CAPTURED,
            "sources": [source], "retainedPrevious": True,
            "windowStartMs": source["windowStartMs"], "windowEndMs": source["windowEndMs"],
        })
        self.assertEqual(body["captured_at"], self.CAPTURED)
        self.assertEqual(body["node_count"], 1, "retained nodes remain available with their failed collection state")
        self.assertIn("warning", body)
        self.assertNotIn("synced Aurora inventory", body["note"])

    def test_partial_collection_keeps_source_reasons_counts_caps_and_orphans(self):
        details = {
            "sources": [{
                "sourceId": "clickhouse:42", "status": "partial", "reasons": ["cap_reached"],
                "itemCount": 1000, "windowStartMs": 1_789_124_340_000, "windowEndMs": 1_789_127_940_000,
            }],
            "retainedPrevious": False, "windowStartMs": 1_789_124_340_000, "windowEndMs": 1_789_127_940_000,
            "nodeDrops": 10, "edgeDrops": 20, "orphanSpans": 3, "invalidSpans": 2, "infraUnavailable": True,
        }
        body, _ = self._read(self._state("partial", json.dumps(details)))
        self.assertEqual(body["collection"], {
            **details, "status": "partial", "stale": False,
            "attempted_at": self.ATTEMPTED, "captured_at": self.CAPTURED,
        })
        self.assertIn("warning", body)

    def test_missing_state_is_unknown_even_with_retained_nodes(self):
        body, _ = self._read(None)
        self.assertEqual(body["collection"], {
            "status": "unknown", "stale": True, "attempted_at": None, "captured_at": None, "sources": [],
        })
        self.assertIsNone(body["captured_at"])
        self.assertEqual(body["node_count"], 1)
        self.assertIn("warning", body)

    def test_stale_success_and_unavailable_reads_are_not_current(self):
        for status, captured in [
            ("ok", "2026-09-11T11:44:59Z"),
            ("unavailable", self.CAPTURED),
            ("ok", None),
            ("ok", "not-a-timestamp"),
        ]:
            with self.subTest(status=status, captured=captured):
                body, _ = self._read(self._state(status, captured_at=captured))
                self.assertEqual(body["collection"]["status"], status)
                self.assertTrue(body["collection"]["stale"])
                self.assertIn("warning", body)

    def test_stale_threshold_matches_graph_api_interval_with_fifteen_minute_floor(self):
        for interval, captured, stale in [
            ("0", "2026-09-11T11:45:00Z", False),
            ("0", "2026-09-11T11:44:59Z", True),
            ("30", "2026-09-11T11:01:00Z", False),
            ("30", "2026-09-11T10:59:59Z", True),
            ("NaN", "2026-09-11T11:44:59Z", True),
        ]:
            with self.subTest(interval=interval, captured=captured):
                with mock.patch.dict(os.environ, {"GRAPH_REBUILD_INTERVAL_MINS": interval}):
                    body, _ = self._read(self._state(captured_at=captured))
                self.assertEqual(body["collection"]["stale"], stale)

    def test_successfully_collected_empty_graph_is_not_reported_as_unmaterialized(self):
        body, _ = self._read(self._state("empty"), nodes=[])
        self.assertEqual(body["collection"]["status"], "empty")
        self.assertFalse(body["collection"]["stale"])
        self.assertNotIn("warning", body)
        self.assertEqual(body["nodes"], [])

    def test_retention_and_authoritative_columns_override_conflicting_details(self):
        body, _ = self._read(self._state("error", {
            "sources": [], "retainedPrevious": True, "status": "ok", "stale": False,
            "attempted_at": "bogus", "captured_at": "bogus",
        }))
        self.assertEqual(body["collection"]["status"], "error")
        self.assertTrue(body["collection"]["stale"])
        self.assertEqual(body["collection"]["captured_at"], self.CAPTURED)
        body, _ = self._read(self._state("ok", {"sources": [], "retainedPrevious": True}))
        self.assertTrue(body["collection"]["stale"])

    def test_malformed_state_is_unknown_rather_than_success(self):
        for state in [
            self._state(details="not-json"),
            self._state(details="[]"),
            self._state(details={"sources": "not-an-array"}),
            self._state(status="unexpected"),
        ]:
            with self.subTest(state=state):
                body, _ = self._read(state)
                self.assertEqual(body["collection"]["status"], "unknown")
                self.assertTrue(body["collection"]["stale"])

    def test_state_permission_or_database_failure_is_not_swallowed_as_healthy(self):
        for error in (PermissionError("reader view denied"), ConnectionError("DB unavailable")):
            for phase in ("probe", "read"):
                with self.subTest(error=error, phase=phase):
                    def fake(sql, params=None):
                        if "to_regclass" in sql:
                            if phase == "probe":
                                raise error
                            return [{"state_relation": "sql_reader.topology_graph_state"}]
                        if "topology_graph_state" in sql:
                            raise error
                        return [{"id": "retained", "kind": "service", "label": "old", "meta": {}}] if "topology_nodes" in sql else []
                    inv._execute_override = fake
                    with self.assertRaises(type(error)):
                        inv.lambda_handler({"tool_name": "get_topology", "arguments": {"class": "trace"}}, None)

    def test_trace_edge_counts_are_separate_observations_not_probability(self):
        for confidence in ("observed", "0.95", 0.95):
            with self.subTest(confidence=confidence):
                body, calls = self._read(self._state(), edges=[{
                    "source": "svc:checkout", "target": "svc:orders", "rel": "calls",
                    "confidence": confidence, "meta": json.dumps({"spanCount": 3, "metricCount": 12.5}),
                }])
                self.assertEqual(body["edges"], [{
                    "source": "svc:checkout", "target": "svc:orders", "rel": "calls",
                    "confidence": "observed", "meta": {"spanCount": 3, "metricCount": 12.5},
                }])
                edge_sql = next(sql for sql, _ in calls if "FROM topology_edges" in sql)
                self.assertIn("meta", edge_sql)
                self.assertIn("not a probability", body["note"])

    def test_legacy_edge_without_metadata_does_not_invent_evidence_counts(self):
        body, _ = self._read(None, edges=[{
            "source": "svc:a", "target": "svc:b", "rel": "calls", "confidence": "0.7",
        }])
        self.assertEqual(body["edges"][0]["meta"], {})
        self.assertEqual(body["edges"][0]["confidence"], "unknown")
        self.assertEqual(body["collection"]["status"], "unknown")

    def test_pre_migration_trace_graph_returns_retained_nodes_with_unknown_collection_and_evidence(self):
        body, calls = self._read(None, schema_present=False, edge_meta_present=False, edges=[{
            "source": "svc:a", "target": "svc:b", "rel": "calls", "confidence": "0.7", "meta": None,
        }])
        self.assertEqual(body["node_count"], 1)
        self.assertEqual(body["collection"], {
            "status": "unknown", "stale": True, "attempted_at": None, "captured_at": None, "sources": [],
        })
        self.assertEqual(body["edges"], [{
            "source": "svc:a", "target": "svc:b", "rel": "calls", "confidence": "unknown", "meta": {},
        }])
        self.assertIn("warning", body)
        self.assertTrue(any("to_regclass" in sql for sql, _ in calls))
        self.assertFalse(any("FROM topology_graph_state" in sql for sql, _ in calls))
        self.assertNotIn('"0.7"', json.dumps(body))

    def test_missing_reader_view_is_unknown_without_falling_back_to_public_tables(self):
        body, calls = self._read(self._state(), schema_present=False)
        self.assertEqual(body["collection"]["status"], "unknown")
        self.assertTrue(body["collection"]["stale"])
        self.assertFalse(any("FROM topology_graph_state" in sql or "FROM public." in sql for sql, _ in calls))

    def test_optional_edge_column_can_be_absent_while_collection_state_exists(self):
        body, _ = self._read(self._state(), edge_meta_present=False, edges=[{
            "source": "svc:a", "target": "svc:b", "rel": "calls", "confidence": "0.95", "meta": None,
        }])
        self.assertEqual(body["collection"]["status"], "ok")
        self.assertEqual(body["edges"][0]["confidence"], "unknown")
        self.assertEqual(body["edges"][0]["meta"], {})

    def test_empty_or_invalid_edge_counts_do_not_certify_observed_evidence(self):
        for meta in ({}, None, {"spanCount": None, "metricCount": "0.7"},
                     {"spanCount": -1, "metricCount": False}):
            with self.subTest(meta=meta):
                body, _ = self._read(self._state(), edges=[{
                    "source": "svc:a", "target": "svc:b", "rel": "calls", "confidence": "observed", "meta": meta,
                }])
                self.assertEqual(body["edges"][0]["confidence"], "unknown")
                self.assertEqual(body["edges"][0]["meta"], {})

    def test_edge_permission_failure_remains_visible_when_state_schema_is_absent(self):
        def fake(sql, params=None):
            if "to_regclass" in sql:
                return [{"state_relation": None}]
            if "topology_edges" in sql:
                raise PermissionError("topology view denied")
            if "topology_nodes" in sql:
                return []
            self.fail("must not query the absent state relation")
        inv._execute_override = fake
        with self.assertRaises(PermissionError):
            inv.lambda_handler({"tool_name": "get_topology", "arguments": {"class": "trace"}}, None)

    def test_collection_read_and_neighbourhood_remain_host_scoped_and_bounded(self):
        body, calls = self._read(self._state(), nodes=[
            {"id": key, "kind": "service", "label": key, "meta": {}}
            for key in ("svc:checkout", "svc:orders", "svc:unrelated")
        ], edges=[{
            "source": "svc:checkout", "target": "svc:orders", "rel": "calls",
            "confidence": "observed", "meta": {"spanCount": 2, "metricCount": 0},
        }], arguments={"resource_id": "svc:checkout", "target_account_id": "222222222222", "limit": 999999})
        self.assertEqual({n["id"] for n in body["nodes"]}, {"svc:checkout", "svc:orders"})
        self.assertEqual(body["from"], "svc:checkout")
        self.assertIn("collection", body)
        self.assertEqual(len(calls), 4)
        for sql, _ in calls:
            if "to_regclass" not in sql:
                self.assertIn("account_id = 'self'", sql)
            self.assertNotIn("222222222222", sql)
            self.assertNotIn("public.", sql)
            self.assertTrue(sql.lstrip().startswith("SELECT"))
        self.assertIn("LIMIT 1", next(sql for sql, _ in calls if "FROM topology_graph_state" in sql))
        self.assertIn("LIMIT 500", next(sql for sql, _ in calls if "topology_nodes" in sql))

    def test_other_graph_classes_do_not_read_collection_or_change_edge_contract(self):
        for cls in ("flow", "infra"):
            with self.subTest(cls=cls):
                body, calls = self._read(None, edges=[{
                    "source": "a", "target": "b", "rel": "routes", "confidence": "inferred",
                }], arguments={"class": cls})
                self.assertNotIn("collection", body)
                self.assertNotIn("captured_at", body)
                self.assertEqual(body["edges"][0], {
                    "source": "a", "target": "b", "rel": "routes", "confidence": "inferred",
                })
                self.assertFalse(any("topology_graph_state" in sql for sql, _ in calls))


if __name__ == "__main__":
    unittest.main()
