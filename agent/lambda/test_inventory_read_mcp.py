"""Tests for inventory_read_mcp — Aurora-backed read-only topology/unused-resource MCP tool.

The pure detection logic (detect_unused) takes already-fetched inventory rows (the JSONB `data`
of inventory_resources, keyed by resource_type) so it is testable with fixtures — no DB, no boto3.
"""
import os
import json
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
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

    def test_cloudfront_identity_lookup_finds_beyond_bulk_limit_without_large_details(self):
        fleet = [{"id": f"E{i:08d}", "origins": ["large-detail" * 1000]} for i in range(601)]
        expected = fleet[-1]["id"]
        def fake(sql, params=None):
            values = {p["name"]: p["value"]["stringValue"] for p in params}
            if "rid" not in values:
                return [{"data": row} for row in fleet[:500]]
            self.assertIn("resource_id = :rid", sql)
            self.assertIn("LIMIT 1", sql)
            self.assertIn("account_id = 'self'", sql)
            self.assertNotIn(expected, sql)
            self.assertNotIn("origins", sql)
            return [{"data": {"id": row["id"]}} for row in fleet if row["id"] == values["rid"]]
        inv._execute_override = fake
        with mock.patch.object(inv, "_freshness_for_type", return_value={}):
            bulk = inv.lambda_handler({"tool_name": "query_inventory", "arguments": {
                "resource_type": "cloudfront", "resource_id": None, "limit": 500}}, None)
            bulk_body = json.loads(bulk["body"])
            self.assertEqual(len(bulk_body["resources"]), 500)
            self.assertNotIn(expected, [row["id"] for row in bulk_body["resources"]])
            self.assertNotIn("projection", bulk_body)
            result = inv.lambda_handler({"tool_name": "query_inventory", "arguments": {
                "resource_type": "cloudfront", "resource_id": expected, "limit": 500}}, None)
        body = json.loads(result["body"])
        self.assertEqual(body["resources"], [{"id": expected}])
        self.assertEqual(body["count"], 1)
        self.assertEqual((body["projection"], body["resource_id"]), ("identity_only", expected))

    def test_null_optional_identity_preserves_other_resource_lists(self):
        inv._execute_override = lambda sql, params=None: [{"data": {"instance_id": "fixture"}}]
        with mock.patch.object(inv, "_freshness_for_type", return_value={}):
            for optional in ({}, {"resource_id": None}):
                result = inv.lambda_handler({"tool_name": "query_inventory", "arguments": {
                    "resource_type": "ec2", **optional}}, None)
                body = json.loads(result["body"])
                self.assertEqual(body["resources"], [{"instance_id": "fixture"}])
                self.assertNotIn("projection", body)

    def test_identity_lookup_rejects_other_types_and_invalid_ids_before_sql(self):
        with mock.patch.object(inv, "_execute") as execute:
            for resource_type, identifier in (("ec2", "E123EXAMPLE"), ("cloudfront", "' OR 1=1"),
                                               ("cloudfront", 123), ("cloudfront", "")):
                result = inv.lambda_handler({"tool_name": "query_inventory", "arguments": {
                    "resource_type": resource_type, "resource_id": identifier}}, None)
                self.assertEqual(result["statusCode"], 400)
            execute.assert_not_called()

    def test_identity_lookup_miss_discloses_observation_limits(self):
        inv._execute_override = lambda sql, params=None: []
        with mock.patch.object(inv, "_freshness_for_type", return_value={"freshness": "unavailable"}):
            result = inv.lambda_handler({"tool_name": "query_inventory", "arguments": {
                "resource_type": "cloudfront", "resource_id": "E123EXAMPLE"}}, None)
        body = json.loads(result["body"])
        self.assertEqual((body["count"], body["resources"]), (0, []))
        self.assertIn("not evidence of absence in AWS", body["note"])
        self.assertIn("freshness", body["note"])

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
                    "freshness": "degraded",
                    "age_minutes": 2,
                    "stale_after_minutes": 30,
                },
            ]

        inv._execute_override = fake
        rows = inv._sync_freshness()

        by_type = {row["resource_type"]: row for row in rows}
        # Unknown attribute coverage stays unknown/degraded; only an explicit zero can be healthy.
        self.assertEqual(by_type["s3_public_access"]["freshness"], "degraded")
        self.assertEqual(by_type["s3_public_access"]["unknown_attribute_count"], 2)
        self.assertEqual(by_type["s3"]["freshness"], "healthy")
        self.assertEqual(by_type["alb"]["freshness"], "degraded")
        self.assertIsNone(by_type["alb"]["unknown_attribute_count"])
        freshness_sql = calls[0][0]
        self.assertIn("runs.unknown_attribute_count", freshness_sql)
        self.assertNotIn("COALESCE(unknown_attribute_count, 0)", freshness_sql)
        self.assertIn(
            "WHEN status = 'succeeded' AND (unknown_attribute_count IS NULL OR unknown_attribute_count > 0) "
            "THEN 'degraded'",
            freshness_sql,
        )
        # the unknown-attribute arm must precede the plain succeeded->healthy arm
        self.assertLess(
            freshness_sql.index(
                "WHEN status = 'succeeded' AND (unknown_attribute_count IS NULL OR unknown_attribute_count > 0) "
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

    def test_query_inventory_sample_has_total_order(self):
        calls = []
        inv._execute_override = lambda sql, params=None: calls.append(sql) or []
        inv._fetch_one_type("cloudfront", 500)
        self.assertIn("ORDER BY captured_at DESC, account_id, region, resource_id LIMIT 500", calls[0])

    def test_get_topology_reads_topology_tables_not_inventory(self):
        """get_topology must query topology_nodes/edges, returning the /api/graph node+edge contract."""
        calls = []
        def fake(sql, params=None):
            calls.append(sql)
            if "topology_nodes" in sql:
                return [
                    {"id": "cf:E1", "kind": "cloudfront", "label": "my-cf", "meta": {"id": "E1"}},
                    {"id": "alb:arn-1", "kind": "alb", "label": "backend", "meta": {}},
                ]
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
        self.assertEqual(body["node_count"], 2)
        self.assertEqual(body["edge_count"], 1)
        self.assertTrue(any("topology_nodes" in c for c in calls), "must query topology_nodes")
        self.assertTrue(any("topology_edges" in c for c in calls), "must query topology_edges")
        # must NOT query inventory_resources for get_topology
        self.assertFalse(any("inventory_resources" in c for c in calls), "must not fall back to raw inventory")

    def test_topology_binds_identifiers_limits_and_selected_endpoints(self):
        """The Data API receives scalar binds even for quotes and ARN separators.

        Actual neighbourhood selection is exercised by TestTopologySelectionSQL.
        """
        root = "alb:arn:example:quoted'value"
        with mock.patch.object(inv, "_inventory_graph_collection", return_value={
            "status": "unknown", "stale": True, "captured_at": None,
        }), mock.patch.object(inv, "_execute", side_effect=[
            [{"id": root}],
            [{"id": root, "kind": "alb", "label": "selected", "meta": {}}],
            [],
        ]) as execute:
            body = json.loads(inv.lambda_handler({
                "tool_name": "get_topology", "arguments": {"resource_id": root},
            }, None)["body"])
        self.assertEqual(body["selection"]["resolved_id"], root)
        self.assertEqual(body["from"], root)
        values = []
        for call in execute.call_args_list:
            sql, params = call.args[0], call.kwargs["params"]
            self.assertNotIn(root, sql)
            self.assertIn("LIMIT :", sql)
            self.assertNotIn("public.", sql)
            self.assertTrue(all("arrayValue" not in p["value"] for p in params))
            values.extend(p["value"] for p in params)
        self.assertIn({"stringValue": root}, values)
        self.assertIn({"stringValue": json.dumps([root])}, values)
        self.assertIn({"longValue": 501}, values)
        self.assertIn({"longValue": 1001}, values)

    def test_invalid_topology_identifier_is_rejected_before_sql(self):
        for identifier in (None, "", "   ", 123, [], {}, "a" * 4097):
            with self.subTest(identifier=identifier), mock.patch.object(inv, "_execute") as execute:
                response = inv.lambda_handler({
                    "tool_name": "get_topology", "arguments": {"resource_id": identifier},
                }, None)
                self.assertEqual(response["statusCode"], 400)
                execute.assert_not_called()

    def test_get_topology_empty_graph_returns_warning(self):
        """Absent state and nodes do not establish a successful empty collection."""
        inv._execute_override = lambda sql, params=None: []
        import json as _j
        out = inv.lambda_handler({"tool_name": "get_topology"}, None)
        self.assertEqual(out["statusCode"], 200)
        body = _j.loads(out["body"])
        self.assertEqual(body["nodes"], [])
        self.assertEqual(body["edges"], [])
        self.assertIn("warning", body)
        self.assertEqual(body["collection"]["status"], "unknown")
        self.assertIn("stale", body["warning"])

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

    def test_inventory_reader_deployment_binds_web_graph_cadence(self):
        # A binding elsewhere in ai.tf does not configure the inventory-reader Lambda.
        for expression in _graph_cadence_expressions().values():
            self.assertRegex(expression, r"^tostring\(\s*var\.graph_rebuild_interval_mins\s*\)$")


def _graph_cadence_expressions():
    """Read the deployed settings, without substituting a test-only cadence binding."""
    foundation = Path(__file__).resolve().parents[2] / "terraform/foundation"
    agent = (foundation / "ai.tf").read_text().split('resource "aws_lambda_function" "agent" {', 1)[1]
    reader = re.search(r'each\.key\s*==\s*"inventory-read"\s*\?\s*\{([^}]+)\}\s*:\s*\{\}', agent)
    assert reader is not None, "inventory-reader environment branch missing"
    binding = re.search(r"^\s*GRAPH_REBUILD_INTERVAL_MINS\s*=\s*([^\n]+)", reader[1], re.M)
    assert binding is not None, "inventory-reader Lambda must receive the web graph rebuild cadence"
    web = re.search(
        r'name\s*=\s*"GRAPH_REBUILD_INTERVAL_MINS"\s*,\s*value\s*=\s*([^}\n]+)',
        (foundation / "workload.tf").read_text(),
    )
    assert web is not None, "web graph rebuild cadence binding missing"
    return {"reader": binding[1].strip(), "web": web[1].strip()}


@unittest.skipUnless(os.environ.get("INVENTORY_TEST_POSTGRES_CONTAINER") or os.environ.get("GRAPH_TEST_POSTGRES_SOCKET"),
                     "Set INVENTORY_TEST_POSTGRES_CONTAINER to an isolated PostgreSQL 17 container")
class TestTopologySelectionSQL(unittest.TestCase):
    """Execute the reader's actual SQL under view-only grants, not a fake SQL interpreter.

    The named container must be disposable: this fixture recreates its awsops graph tables.
    A cached psql client shares the isolated server's network namespace; no AWS access,
    host port, image pull, or extra Python dependency is needed.
    """

    @classmethod
    def _psql(cls, sql, reader=False):
        if os.environ.get("GRAPH_TEST_POSTGRES_SOCKET"):
            import pg8000.native
            connection = pg8000.native.Connection(
                user="awsops_sql_reader" if reader else "postgres", database="awsops",
                unix_sock=os.path.join(os.environ["GRAPH_TEST_POSTGRES_SOCKET"], ".s.PGSQL.5432"),
                timeout=20,
            )
            try:
                rows = connection.run(sql)
                return "\n".join(json.dumps(row[0]) if isinstance(row[0], (dict, list))
                                 else str(row[0]) for row in (rows or []))
            except pg8000.native.DatabaseError as error:
                raise AssertionError(str(error)) from error
            finally:
                connection.close()
        result = subprocess.run([
            "docker", "run", "--pull", "never", "--rm", "-i", "--network",
            "container:" + os.environ["INVENTORY_TEST_POSTGRES_CONTAINER"],
            "--entrypoint", "psql", "postgres:17-alpine",
            "-h", "127.0.0.1", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U",
            "awsops_sql_reader" if reader else "postgres", "-d", "awsops",
        ], input=sql, text=True, capture_output=True, timeout=20)
        if result.returncode:
            raise AssertionError(result.stderr or result.stdout)
        return result.stdout.strip()

    @classmethod
    def setUpClass(cls):
        # Destructive opt-in fixtures require an explicit disposable-database sentinel.
        sentinel = cls._psql("SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()")
        if sentinel != "awsops-disposable-graph-test":
            raise RuntimeError("Refusing graph fixture writes without disposable database sentinel")
        if not cls._psql("SHOW server_version").startswith("17."):
            raise RuntimeError("Graph SQL fixtures require PostgreSQL 17")
        migrations = Path(__file__).resolve().parents[2] / "terraform/foundation/migrations"
        cls._psql("""
            DO $$ BEGIN
              CREATE ROLE awsops_sql_reader LOGIN;
              EXCEPTION WHEN duplicate_object THEN NULL;
            END $$;
            DO $$ BEGIN CREATE ROLE awsops_web;
              EXCEPTION WHEN duplicate_object THEN NULL;
            END $$;
            DO $$ BEGIN CREATE ROLE awsops_worker;
              EXCEPTION WHEN duplicate_object THEN NULL;
            END $$;
            CREATE SCHEMA IF NOT EXISTS sql_reader;
            GRANT USAGE ON SCHEMA sql_reader TO awsops_sql_reader;
            ALTER ROLE awsops_sql_reader SET search_path = sql_reader, pg_catalog;
            ALTER ROLE awsops_sql_reader SET default_transaction_read_only = on;
            ALTER ROLE awsops_sql_reader SET statement_timeout = '5s';
            DROP TABLE IF EXISTS public.topology_edges, public.topology_nodes,
              public.topology_graph_state CASCADE;
        """)
        for name in ("01KV7WYRPC57KGXSGDSEX5CAMT_topology_graph.sql",
                     "01KVAQ9MQNR5R97T5AXX4JVN6Q_topology_class.sql",
                     "01M279W0J9HNG1QT0MAS60KV8K_topology_graph_collection_state.sql"):
            cls._psql((migrations / name).read_text())
        for path in sorted(migrations.glob("*_topology_inventory_evidence.sql")):
            cls._psql(path.read_text())

    def test_source_projection_preserves_clocks_but_excludes_unsafe_payloads(self):
        source = {"sourceId": "inventory:alb", "status": "ok", "scope": "aggregate",
                  "producerStatus": "succeeded", "capturedAtMs": 1789376400000,
                  "lastSuccessAtMs": 1789380000000, "attemptedAtMs": 1789380000000,
                  "finishedAtMs": 1789380000000, "itemCount": 1,
                  "reasons": ["unknown_capture", "credential=secret"],
                  "error": "password=secret", "data": {"token": "secret"}}
        details = {"sources": [source, 123, None], "publishedSources": [source],
                   "inputTruncated": True, "graphTruncated": False,
                   "failureReason": "publication_failed", "raw": {"credential": "secret"}}
        payload = json.dumps(details).replace("'", "''")
        self._psql("INSERT INTO public.topology_graph_state VALUES "
                   "('self','infra','error',now(),now(),'" + payload + "'::jsonb);")
        rows = self._execute("SELECT details FROM topology_graph_state WHERE class='infra'")
        safe = rows[0]["details"]
        self.assertEqual(safe["sources"][0]["capturedAtMs"], 1789376400000)
        self.assertEqual(safe["publishedSources"][0]["lastSuccessAtMs"], 1789380000000)
        self.assertEqual(safe["sources"][0]["scope"], "aggregate")
        self.assertEqual(safe["sources"][0]["reasons"], ["unknown_capture"])
        self.assertEqual(len(safe["sources"]), 1)
        self.assertNotIn("secret", json.dumps(safe))
        self.assertEqual(safe["failureReason"], "publication_failed")
        self.assertTrue(safe["inputTruncated"])
        self.assertFalse(safe["graphTruncated"])
        permissions = self._execute("SELECT has_table_privilege(current_user, 'public.topology_graph_state', 'SELECT') AS base_read")
        self.assertFalse(permissions[0]["base_read"])

    def test_source_projection_bounds_arrays_and_handles_malformed_details(self):
        details = {"sources": [{"sourceId": "inventory:alb", "status": "password=secret",
                               "scope": {"secret": 1}, "capturedAtMs": {"secret": 1},
                               "lastSuccessAtMs": "secret", "producerStatus": "secret"}] * 150,
                   "publishedSources": "secret", "failureReason": "secret"}
        payload = json.dumps(details).replace("'", "''")
        self._psql("INSERT INTO public.topology_graph_state VALUES "
                   "('self','flow','partial',now(),now(),'" + payload + "'::jsonb),"
                   "('member','flow','partial',now(),now(),'null'::jsonb);")
        rows = self._execute("SELECT details FROM topology_graph_state ORDER BY account_id")
        self.assertLessEqual(len(rows[1]["details"]["sources"]), 128)
        self.assertNotIn("secret", json.dumps(rows))

    def setUp(self):
        self._psql("TRUNCATE public.topology_nodes, public.topology_edges, public.topology_graph_state;")
        self.calls = []
        inv._execute_override = self._execute

    def tearDown(self):
        inv._execute_override = None

    def _execute(self, sql, params=None):
        # Translate the Data API's named scalar binds into PostgreSQL PREPARE binds.
        # JSON arrays remain one string bind, as in the Data API (no arrayValue support needed).
        self.calls.append((sql, params))
        params = params or []
        positions = {p["name"]: f"${i}" for i, p in enumerate(params, 1)}
        prepared = re.sub(r"(?<!:):([a-zA-Z_]\w*)", lambda m: positions[m[1]], sql)
        types, values = [], []
        for p in params:
            v = p["value"]
            if "longValue" in v:
                types.append("bigint")
                values.append(str(v["longValue"]))
            else:
                types.append("text")
                values.append("'" + v["stringValue"].replace("'", "''") + "'")
        signature = "(" + ",".join(types) + ")" if types else ""
        args = "(" + ",".join(values) + ")" if values else ""
        result = self._psql(
            f"PREPARE graph_read{signature} AS "
            f"SELECT coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) FROM ({prepared}) r;"
            f"EXECUTE graph_read{args};", reader=True)
        return json.loads(result)

    def _seed(self, ids, edges=(), cls="infra", account="self"):
        nodes = [{"id": key, "kind": key.split(":")[0], "label": key,
                  "meta": {"resourceId": "hidden", "row": {"secret": "not-readable"}}} for key in ids]
        payload = json.dumps({"nodes": nodes, "edges": [
            {"source": a, "target": b, "rel": rel} for a, b, rel in edges
        ]}).replace("'", "''")
        self._psql(f"""
            INSERT INTO public.topology_nodes(account_id, id, kind, label, meta, run_id, class)
            SELECT '{account}', n->>'id', n->>'kind', n->>'label', n->'meta', 'test', '{cls}'
            FROM jsonb_array_elements('{payload}'::jsonb->'nodes') n;
            INSERT INTO public.topology_edges(account_id, source, target, rel, run_id, class)
            SELECT '{account}', e->>'source', e->>'target', e->>'rel', 'test', '{cls}'
            FROM jsonb_array_elements('{payload}'::jsonb->'edges') e;
        """)

    def _read(self, resource_id=None, cls="infra", **arguments):
        if resource_id is not None:
            arguments["resource_id"] = resource_id
        response = inv.lambda_handler({
            "tool_name": "get_topology", "arguments": {"class": cls, **arguments},
        }, None)
        self.assertEqual(response["statusCode"], 200, response)
        return json.loads(response["body"])

    def test_canonical_and_raw_arn_resolve_before_the_first_500_nodes(self):
        arn = "arn:aws:lambda:ap-northeast-2:111111111111:function:orders"
        root = "lambda:" + arn
        self._seed([f"ec2:i-{i:04}" for i in range(600)] + [root, "sg:sg-1"],
                   [(root, "sg:sg-1", "infra:uses_sg")])
        for requested, matched_by in ((root, "canonical"), (arn, "raw")):
            with self.subTest(requested=requested):
                body = self._read(requested)
                self.assertEqual({n["id"] for n in body["nodes"]}, {root, "sg:sg-1"})
                self.assertEqual(body["edge_count"], 1)
                self.assertEqual(body["from"], requested)
                self.assertEqual(body.get("selection"), {
                    "status": "resolved", "requested_id": requested,
                    "resolved_id": root, "matched_by": matched_by,
                })
                self.assertFalse(body["truncation"]["nodes"])

    def test_raw_collision_is_explicit_and_does_not_choose_a_neighbourhood(self):
        self._seed(["ec2:shared", "lambda:shared", "rds:shared"])
        body = self._read("shared")
        self.assertEqual(body["nodes"], [])
        self.assertEqual(body["edges"], [])
        self.assertEqual(body.get("selection", {}).get("status"), "ambiguous")
        self.assertEqual(body["selection"]["candidate_ids"], ["ec2:shared", "lambda:shared"])
        self.assertTrue(body["selection"]["candidates_truncated"])
        self.assertNotIn("graph-rebuild", body.get("warning", ""))

    def test_canonical_match_wins_over_a_raw_id_collision(self):
        self._seed(["lambda:shared", "rds:lambda:shared"])
        body = self._read("lambda:shared")
        self.assertEqual([n["id"] for n in body["nodes"]], ["lambda:shared"])
        self.assertEqual(body.get("selection", {}).get("matched_by"), "canonical")

    def test_two_raw_matches_are_ambiguous_without_truncated_candidates(self):
        self._seed(["lambda:shared", "rds:shared"])
        body = self._read("shared")
        self.assertEqual(body["nodes"], [])
        self.assertEqual(body["edges"], [])
        self.assertEqual(body["selection"]["status"], "ambiguous")
        self.assertEqual(body["selection"]["candidate_ids"], ["lambda:shared", "rds:shared"])
        self.assertFalse(body["selection"]["candidates_truncated"])

    def test_unknown_and_sql_like_ids_never_return_unrelated_nodes(self):
        self._seed(["lambda:orders"])
        for requested in ("missing", "orders%", "orders' OR true --", "orders:extra"):
            with self.subTest(requested=requested):
                body = self._read(requested)
                self.assertEqual(body["nodes"], [])
                self.assertEqual(body["edges"], [])
                self.assertEqual(body.get("selection", {}).get("status"), "not_found")
                self.assertIn("warning", body)
                self.assertNotIn("graph-rebuild", body["warning"])
                self.assertTrue(all(requested not in sql for sql, _ in self.calls))

    def test_one_hop_includes_incoming_and_outgoing_but_not_second_hop(self):
        self._seed(["alb:root", "cf:upstream", "tg:downstream", "ec2:second-hop"],
                   [("cf:upstream", "alb:root", "origin"),
                    ("alb:root", "tg:downstream", "targets"),
                    ("tg:downstream", "ec2:second-hop", "targets"),
                    ("cf:upstream", "tg:downstream", "related")])
        body = self._read("alb:root")
        self.assertEqual({n["id"] for n in body["nodes"]}, {"alb:root", "cf:upstream", "tg:downstream"})
        self.assertEqual(body["edge_count"], 3)

    def test_neighbour_cap_keeps_root_and_reports_truncation_without_dangling_edges(self):
        root = "z:root"
        neighbours = [f"ec2:i-{i:04}" for i in range(601)]
        self._seed(neighbours + [root], [(root, n, "related") for n in neighbours])
        body = self._read(root, limit=999999)
        ids = {n["id"] for n in body["nodes"]}
        self.assertIn(root, ids)
        self.assertEqual(len(ids), 500)
        self.assertEqual(body["edge_count"], 499)
        self.assertTrue(body.get("truncation", {}).get("nodes"))
        self.assertFalse(body["truncation"]["edges"])
        self.assertTrue(all(e["source"] in ids and e["target"] in ids for e in body["edges"]))

    def test_dense_selected_graph_has_a_bounded_edge_response(self):
        self._seed(["lambda:root", "sg:one"],
                   [("lambda:root", "sg:one", f"relation-{i:04}") for i in range(1100)])
        body = self._read("lambda:root")
        self.assertEqual(body["node_count"], 2)
        self.assertEqual(body["edge_count"], 1000)
        self.assertTrue(body.get("truncation", {}).get("edges"))
        self.assertFalse(body["truncation"]["nodes"])
        # Every Data API result query is bounded, including the selected edge fetch.
        self.assertTrue(all("LIMIT :" in sql for sql, _ in self.calls
                            if "topology_nodes" in sql or "topology_edges" in sql))

    def test_whole_graph_is_bounded_and_excludes_missing_or_capped_endpoints(self):
        ids = [f"ec2:i-{i:04}" for i in range(510)]
        self._seed(ids, [(ids[0], ids[1], "valid"), (ids[0], ids[-1], "capped"),
                         (ids[0], "ec2:absent", "dangling")])
        body = self._read()
        self.assertEqual(body["node_count"], 500)
        self.assertEqual([e["rel"] for e in body["edges"]], ["valid"])
        self.assertTrue(body.get("truncation", {}).get("nodes"))
        self.assertEqual(body["selection"]["status"], "all")

    def test_exact_caps_are_complete_not_truncated(self):
        ids = [f"ec2:i-{i:04}" for i in range(500)]
        self._seed(ids, [(ids[0], ids[1], f"relation-{i:04}") for i in range(1000)])
        body = self._read()
        self.assertEqual(body["node_count"], 500)
        self.assertEqual(body["edge_count"], 1000)
        self.assertEqual(body.get("truncation"), {
            "nodes": False, "edges": False, "node_limit": 500, "edge_limit": 1000,
        })

    def test_empty_unknown_and_isolated_selections_are_distinct(self):
        empty = self._read()
        self.assertEqual(empty.get("selection", {}).get("status"), "all")
        self.assertEqual(empty["nodes"], [])
        self._seed(["lambda:isolated"])
        isolated = self._read("isolated")
        self.assertEqual([n["id"] for n in isolated["nodes"]], ["lambda:isolated"])
        self.assertEqual(isolated["edges"], [])
        self.assertEqual(isolated["selection"]["status"], "resolved")
        self.assertEqual(isolated["collection"]["status"], "unknown")
        self.assertIn("collection", isolated["warning"])
        self.assertEqual(self._read("absent")["selection"]["status"], "not_found")

    def test_scoped_inventory_availability_distinguishes_unknown_from_confirmed_empty(self):
        miss_warning = "Requested resource_id was not found in this host's selected graph class."
        collection_warning = (
            "Graph collection evidence is incomplete or stale; inspect collection before "
            "treating nodes or edges as current."
        )
        for cls in ("flow", "infra"):
            for mode, status, stale in (
                ("missing_relation", "unknown", True),
                ("missing_row", "unknown", True),
                ("successful_empty", "empty", False),
            ):
                with self.subTest(cls=cls, mode=mode):
                    self._psql("TRUNCATE public.topology_graph_state;")
                    if mode == "missing_relation":
                        self._psql("ALTER VIEW sql_reader.topology_graph_state "
                                   "RENAME TO topology_graph_state_unavailable;")
                    elif mode == "successful_empty":
                        source_id = "inventory:alb" if cls == "flow" else "inventory:vpc"
                        self._psql(f"""
                            WITH evidence AS (
                                SELECT jsonb_build_array(jsonb_build_object(
                                    'sourceId', '{source_id}', 'status', 'empty', 'scope', 'aggregate',
                                    'producerStatus', 'succeeded', 'itemCount', 0, 'capturedAtMs', NULL,
                                    'lastSuccessAtMs', (extract(epoch FROM now() - interval '1 minute') * 1000)::bigint,
                                    'reasons', '[]'::jsonb
                                )) AS sources
                            )
                            INSERT INTO public.topology_graph_state
                                (account_id, class, status, attempted_at, captured_at, details)
                            SELECT 'self', '{cls}', 'empty', now(), now(),
                                jsonb_build_object('sources', sources, 'publishedSources', sources,
                                                   'retainedPrevious', false)
                            FROM evidence;
                        """)
                    try:
                        body = self._read("absent", cls=cls)
                        self.assertEqual(body["class"], cls)
                        self.assertEqual(body["from"], "absent")
                        self.assertEqual(body["nodes"], [])
                        self.assertEqual(body["edges"], [])
                        self.assertEqual((body["node_count"], body["edge_count"]), (0, 0))
                        self.assertEqual(body["selection"], {
                            "status": "not_found", "requested_id": "absent", "resolved_id": None,
                        })
                        self.assertEqual(body["truncation"], {
                            "nodes": False, "edges": False, "node_limit": 500, "edge_limit": 1000,
                        })
                        self.assertEqual(body["collection"]["status"], status)
                        self.assertEqual(body["collection"]["stale"], stale)
                        self.assertEqual(body["captured_at"] is None, mode != "successful_empty")
                        self.assertEqual(body["warning"],
                                         f"{collection_warning} {miss_warning}" if stale else miss_warning)
                    finally:
                        if mode == "missing_relation":
                            self._psql("ALTER VIEW sql_reader.topology_graph_state_unavailable "
                                       "RENAME TO topology_graph_state;")

    def test_reader_boundary_hides_metadata_and_other_accounts_and_classes(self):
        self._seed(["lambda:host", "sg:foreign-endpoint"],
                   [("lambda:host", "sg:foreign-endpoint", "wrong-account")], account="222222222222")
        self._seed(["lambda:host", "sg:other-class"],
                   [("lambda:host", "sg:other-class", "wrong-class")], cls="flow")
        self._seed(["lambda:host"])
        body = self._read("host", target_account_id="222222222222")
        self.assertEqual([n["id"] for n in body["nodes"]], ["lambda:host"])
        self.assertEqual(body["nodes"][0]["meta"], {})
        self.assertEqual(body["edges"], [])
        self.assertEqual(body.get("selection", {}).get("status"), "resolved")
        self.assertEqual(self._psql("SHOW search_path;", reader=True), "sql_reader, pg_catalog")
        with self.assertRaisesRegex(AssertionError, "permission denied"):
            self._psql("SELECT meta FROM public.topology_nodes;", reader=True)


class TestTraceTopologyCollection(unittest.TestCase):
    NOW = 1_789_128_000  # 2026-09-11T12:00:00Z
    CAPTURED = "2026-09-11T11:55:00+00:00"
    ATTEMPTED = "2026-09-11T11:59:00+00:00"

    def tearDown(self):
        inv._execute_override = None

    def _read(self, state, nodes=None, edges=None, arguments=None,
              schema_present=True, edge_meta_present=True):
        calls = []
        if nodes is None:
            # Edge-evidence fixtures need their real endpoints; otherwise they test dangling
            # edge handling instead of confidence/legacy metadata compatibility.
            ids = sorted({e[key] for e in (edges or []) for key in ("source", "target")})
            nodes = [{"id": key, "kind": "service", "label": key, "meta": {}}
                     for key in (ids or ["svc:checkout"])]

        def fake(sql, params=None):
            calls.append((sql, params))
            if "to_regclass" in sql:
                return [{"state_relation": "sql_reader.topology_graph_state" if schema_present else None}]
            if "topology_graph_state" in sql:
                if not schema_present:
                    raise RuntimeError("relation topology_graph_state does not exist")
                return [state] if state is not None else []
            if sql.startswith("SELECT id FROM topology_nodes"):
                requested = next(p["value"]["stringValue"] for p in params if p["name"] == "rid")
                return [{"id": n["id"]} for n in nodes if n["id"] == requested]
            if "topology_nodes" in sql:
                return nodes
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
        cases = json.loads((Path(__file__).resolve().parents[2]
                           / "web/lib/fixtures/trace-queue-claims.json").read_text())
        for case in cases:
            for attrs in [
                {},
                {"accountId": "444455556666", "region": "us-west-2"},
                {"claimedAccountId": "777788889999", "claimedRegion": "eu-west-1"},
            ]:
                with self.subTest(case=case, attrs=attrs):
                    body, _ = self._read(self._state(), nodes=[{
                        "id": "queue:one", "kind": "queue", "label": "orders",
                        "meta": json.dumps({**attrs, "destination": case["destination"],
                                           "identityProvenance": "aws_verified", "infra_ref": "inventory:queue"}),
                    }])
                    self.assertEqual(body["nodes"][0]["meta"], {
                        "destination": case["destination"],
                        "claimedAccountId": case["account"], "claimedRegion": case["region"],
                        "identityProvenance": "telemetry_claim",
                    })
                    self.assertIn("not verified AWS", body["note"])

    def test_queue_without_destination_never_uses_legacy_reporter_claims(self):
        for attrs in [
            {"accountId": "111122223333", "region": "us-east-1"},
            {"claimedAccountId": "111122223333", "claimedRegion": "us-east-1"},
        ]:
            body, _ = self._read(self._state(), nodes=[{
                "id": "queue:one", "kind": "queue", "label": "orders",
                "meta": {**attrs, "identityProvenance": "aws_verified", "infra_ref": "inventory:queue"},
            }])
            self.assertEqual(body["nodes"][0]["meta"], {
                "claimedAccountId": None, "claimedRegion": None,
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

    def test_deployed_graph_cadence_agrees_with_real_web_reader(self):
        expressions = _graph_cadence_expressions()  # Missing binding fails even without optional tools.
        root = Path(__file__).resolve().parents[2]
        if not shutil.which("terraform") or not shutil.which("node"):
            self.skipTest("Cross-runtime contract requires Terraform and Node; binding contract still runs")
        if not (root / "web/node_modules/typescript/lib/typescript.js").is_file():
            self.skipTest("Cross-runtime contract requires the existing web TypeScript dependency")
        # Evaluate the actual HCL expressions in a provider-free, backend-free module.
        # No foundation state, provider initialization, AWS credentials or network is used.
        with tempfile.TemporaryDirectory(prefix="graph-cadence-") as directory:
            fixture = Path(directory)
            (fixture / "main.tf").write_text('variable "graph_rebuild_interval_mins" { type = number }\n')
            (fixture / "terraform.rc").write_text("")
            env = {k: v for k, v in os.environ.items() if not k.startswith("TF_")}
            env.update(TF_DATA_DIR=str(fixture / ".terraform"),
                       TF_CLI_CONFIG_FILE=str(fixture / "terraform.rc"), CHECKPOINT_DISABLE="1")
            for minutes in (0, 15, 30, 60):
                with self.subTest(minutes=minutes):
                    expression = "jsonencode({" + ",".join(
                        f"{key}=({value})" for key, value in expressions.items()) + "})\n"
                    evaluated = subprocess.run(
                        ["terraform", f"-chdir={directory}", "console", "-no-color",
                         f"-var=graph_rebuild_interval_mins={minutes}"],
                        input=expression, text=True, capture_output=True, env=env, timeout=20,
                    )
                    self.assertEqual(evaluated.returncode, 0, evaluated.stderr)
                    deployed = json.loads(json.loads(evaluated.stdout))
                    self.assertEqual(deployed, {"reader": str(minutes), "web": str(minutes)})
                    cases = [
                        (self._state(captured_at="2026-09-11T11:40:00Z"), minutes == 0),
                    ]
                    if minutes == 30:
                        cases += [
                            (self._state("empty", captured_at="2026-09-11T11:40:00Z"), False),
                            (self._state("partial", captured_at="2026-09-11T11:40:00Z"), False),
                            (self._state(captured_at="2026-09-11T11:00:00Z"), False),
                            (self._state(captured_at="2026-09-11T10:59:59Z"), True),
                            (self._state("error"), True), (self._state("unavailable"), True),
                            (self._state(details={"sources": [], "retainedPrevious": True}), True),
                            (self._state(captured_at=None), True), (None, True),
                        ]
                    # Execute graph-state.ts itself using the installed compiler, compatible with
                    # the CI's Node 20. Only SQL rows, environment and wall clock are controlled.
                    web = subprocess.run(["node", "-e", r"""
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const ts = require(path.join(input.root, 'web/node_modules/typescript'));
const source = fs.readFileSync(path.join(input.root, 'web/lib/graph-state.ts'), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
} }).outputText;
const context = { exports: {}, process: { env: input.environment },
  Date: class extends Date { static now() { return input.now; } } };
vm.runInNewContext(code, context);
Promise.all(input.rows.map(row => context.exports.readGraphState({
  query: async (sql, args) => {
    if (!sql.includes('FROM topology_graph_state') || args[0] !== 'self') throw Error('unexpected SQL');
    return { rows: row ? [row] : [] };
  },
}, 'self'))).then(rows => process.stdout.write(JSON.stringify(rows)))
  .catch(error => { console.error(error); process.exitCode = 1; });
"""], input=json.dumps({
                        "root": str(root), "now": self.NOW * 1000,
                        # The web omits this variable when the configured timer is disabled.
                        "environment": {"GRAPH_REBUILD_INTERVAL_MINS": deployed["web"]} if minutes else {},
                        "rows": [row for row, _ in cases],
                    }), text=True, capture_output=True, timeout=20)
                    self.assertEqual(web.returncode, 0, web.stderr)
                    web_collections = json.loads(web.stdout)
                    self.assertEqual(len(web_collections), len(cases))
                    for (state, stale), web_collection in zip(cases, web_collections):
                        with self.subTest(state=state):
                            with mock.patch.dict(os.environ, {
                                "GRAPH_REBUILD_INTERVAL_MINS": deployed["reader"],
                            }, clear=True):
                                body, _ = self._read(state)
                            self.assertEqual(body["collection"]["stale"], stale)
                            self.assertEqual(body["collection"], web_collection)
                            self.assertEqual("warning" in body,
                                             stale or body["collection"]["status"] == "partial")

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
        self.assertEqual(body["node_count"], 2)
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

    def test_collection_is_preserved_with_selected_graph_and_bound_reader_queries(self):
        body, calls = self._read(self._state(), nodes=[
            {"id": key, "kind": "service", "label": key, "meta": {}}
            for key in ("svc:checkout", "svc:orders")
        ], edges=[{
            "source": "svc:checkout", "target": "svc:orders", "rel": "calls",
            "confidence": "observed", "meta": {"spanCount": 2, "metricCount": 0},
        }], arguments={"resource_id": "svc:checkout", "target_account_id": "222222222222", "limit": 999999})
        self.assertEqual({n["id"] for n in body["nodes"]}, {"svc:checkout", "svc:orders"})
        self.assertEqual(body["from"], "svc:checkout")
        self.assertIn("collection", body)
        self.assertEqual(body["selection"]["resolved_id"], "svc:checkout")
        for sql, _ in calls:
            if "to_regclass" not in sql:
                self.assertIn("account_id = 'self'", sql)
            self.assertNotIn("222222222222", sql)
            self.assertNotIn("public.", sql)
            self.assertTrue(sql.lstrip().startswith("SELECT"))
        self.assertIn("LIMIT 1", next(sql for sql, _ in calls if "FROM topology_graph_state" in sql))
        self.assertEqual(body["truncation"]["node_limit"], 500)

    def test_inventory_fresh_publication_uses_oldest_original_source_clock(self):
        source = {"sourceId": "inventory:alb", "status": "ok", "scope": "aggregate", "itemCount": 1,
                  "capturedAtMs": 1789120800000, "lastSuccessAtMs": 1789127400000}
        for cls in ("flow", "infra"):
            body, _ = self._read(self._state(details={"sources": [source], "publishedSources": [source]}),
                                 arguments={"class": cls})
            self.assertTrue(body["collection"]["stale"])
            self.assertEqual(body["collection"]["publishedSources"][0]["capturedAtMs"], 1789120800000)
            self.assertEqual(body["collection"]["evidenceKind"], "inventory")

    def test_inventory_old_projection_cannot_certify_fresh_sources(self):
        body, _ = self._read(self._state(details={"sources": []}), arguments={"class": "infra"})
        self.assertTrue(body["collection"]["stale"])

    def test_inventory_successful_zero_is_fresh_without_a_row_capture(self):
        source = {"sourceId": "inventory:alb", "status": "empty", "scope": "aggregate",
                  "itemCount": 0, "lastSuccessAtMs": 1789127700000}
        body, _ = self._read(self._state("empty", details={
            "sources": [source], "publishedSources": [source],
        }), nodes=[], arguments={"class": "infra"})
        self.assertEqual(body["collection"]["status"], "empty")
        self.assertFalse(body["collection"]["stale"])
        self.assertNotIn("warning", body)

    def test_inventory_clock_aging_during_read_is_not_a_publication_change(self):
        before = {"status": "ok", "stale": False, "captured_at": self.CAPTURED}
        with mock.patch.object(inv, "_inventory_graph_collection", side_effect=[
            before, {**before, "stale": True},
        ]):
            body, _ = self._read(None, arguments={"class": "infra"})
        self.assertTrue(body["collection"]["stale"])
        self.assertNotIn("snapshotConsistent", body["collection"])

    def test_inventory_failed_verification_keeps_safe_failure_and_readable_graph(self):
        with mock.patch.object(inv, "_inventory_graph_collection", side_effect=[
            {"status": "ok", "stale": False, "captured_at": self.CAPTURED},
            {"status": "error", "stale": True, "captured_at": None,
             "failureReason": "state_read_failed"},
        ]):
            body, _ = self._read(None, arguments={"class": "infra"})
        self.assertEqual(body["collection"]["failureReason"], "state_read_failed")
        self.assertFalse(body["collection"]["snapshotConsistent"])
        self.assertEqual(body["node_count"], 1)

    def test_inventory_publication_change_cannot_certify_selected_nodes(self):
        with mock.patch.object(inv, "_inventory_graph_collection", side_effect=[
            {"status": "ok", "stale": False, "captured_at": self.CAPTURED},
            {"status": "empty", "stale": False, "captured_at": self.ATTEMPTED},
        ]):
            body, _ = self._read(None, arguments={"class": "infra"})
        self.assertTrue(body["collection"]["stale"])
        self.assertFalse(body["collection"]["snapshotConsistent"])
        self.assertEqual(body["collection"]["failureReason"], "publication_changed")
        self.assertEqual(body["selection"]["status"], "all")

    def test_inventory_classes_add_collection_without_changing_edge_contract(self):
        for cls in ("flow", "infra"):
            with self.subTest(cls=cls):
                body, calls = self._read(None, edges=[{
                    "source": "a", "target": "b", "rel": "routes", "confidence": "inferred",
                }], arguments={"class": cls})
                self.assertEqual(body["collection"]["status"], "unknown")
                self.assertIsNone(body["captured_at"])
                self.assertEqual(body["edges"][0], {
                    "source": "a", "target": "b", "rel": "routes", "confidence": "inferred",
                })
                self.assertTrue(any("topology_graph_state" in sql for sql, _ in calls))


if __name__ == "__main__":
    unittest.main()
