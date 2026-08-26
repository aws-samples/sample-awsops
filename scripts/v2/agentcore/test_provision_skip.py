"""Regression: provision.ensure_targets must SKIP (not ERR) a target whose Lambda is
absent from the tf output — e.g. the flag-gated notion-mcp when integrations_enabled=false.

An ERR makes main() exit non-zero, so `make agentcore` would FAIL on a perfectly valid
flag-off config. A missing Lambda for a flag-gated target is expected, not an error.

Runs with `python3 -m unittest test_provision_skip` (no network/boto3 calls — the
absent-Lambda path returns before any control-plane call).
"""
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))
import provision  # noqa: E402

_TARGET = {
    "notion-mcp-target": {
        "gateway": "external-obs",
        "lambda_key": "notion-mcp",
        "description": "Notion read-only",
        "tools": [{"name": "notion_search", "inputSchema": {"type": "object", "properties": {}}}],
    }
}


class TestProvisionSkip(unittest.TestCase):
    def setUp(self):
        provision.report.clear()

    def test_absent_lambda_is_skip_not_err(self):
        ctrl = mock.Mock()
        with mock.patch.object(provision.catalog, "TARGETS", _TARGET):
            # gateway present, Lambda absent from tf output (flag off)
            provision.ensure_targets(ctrl, {"lambda_arns": {}}, {"external-obs": "gw-1"})
        statuses = {r[1] for r in provision.report}
        self.assertIn("SKIP", statuses)
        self.assertNotIn("ERR", statuses)
        # errs (what main() exits on) must be empty → make agentcore stays exit 0
        errs = [r for r in provision.report if r[1] == "ERR"]
        self.assertEqual(errs, [])
        # the absent-Lambda path returns BEFORE any control-plane call
        ctrl.create_gateway_target.assert_not_called()
        ctrl.list_gateway_targets.assert_not_called()

    def test_absent_gateway_still_errs(self):
        ctrl = mock.Mock()
        with mock.patch.object(provision.catalog, "TARGETS", _TARGET):
            provision.ensure_targets(ctrl, {"lambda_arns": {"notion-mcp": "arn:lambda"}}, {})  # gw missing
        self.assertIn("ERR", {r[1] for r in provision.report})


_MOVED_CATALOG = {
    "prometheus-mcp-target": {"gateway": "external-obs", "lambda_key": "prometheus-mcp", "description": "", "tools": []},
    "clickhouse-mcp-target": {"gateway": "external-obs", "lambda_key": "clickhouse-mcp", "description": "", "tools": []},
    "iam-mcp-target": {"gateway": "security", "lambda_key": "iam-mcp", "description": "", "tools": []},
}


class TestPruneMovedTargets(unittest.TestCase):
    def setUp(self):
        provision.report.clear()

    def test_prunes_only_orphans_from_a_gateway_move(self):
        # Live state: prometheus still on monitoring + clickhouse still on data (the stale copies),
        # both correctly present on external-obs, iam correct on security, plus a manual target.
        per_gw = {
            "gw-mon": [{"name": "prometheus-mcp-target", "targetId": "t-mon-prom"}],
            "gw-data": [{"name": "clickhouse-mcp-target", "targetId": "t-data-ch"}],
            "gw-obs": [{"name": "prometheus-mcp-target", "targetId": "t-obs-prom"},
                       {"name": "clickhouse-mcp-target", "targetId": "t-obs-ch"}],
            "gw-sec": [{"name": "iam-mcp-target", "targetId": "t-sec-iam"},
                       {"name": "hand-rolled-target", "targetId": "t-sec-manual"}],
        }
        gw_ids = {"monitoring": "gw-mon", "data": "gw-data", "external-obs": "gw-obs", "security": "gw-sec"}
        ctrl = mock.Mock()

        def fake_list_all(_fn, gatewayIdentifier=None, **_kw):
            return per_gw.get(gatewayIdentifier, [])

        with mock.patch.object(provision.catalog, "TARGETS", _MOVED_CATALOG), \
             mock.patch.object(provision, "_list_all", side_effect=fake_list_all):
            provision.prune_moved_targets(ctrl, gw_ids)

        # Exactly the two stale copies are deleted — on their OLD gateways.
        deleted = {(c.kwargs["gatewayIdentifier"], c.kwargs["targetId"])
                   for c in ctrl.delete_gateway_target.call_args_list}
        self.assertEqual(deleted, {("gw-mon", "t-mon-prom"), ("gw-data", "t-data-ch")})
        # Correct-home copies and the unknown manual target are NEVER deleted.
        self.assertNotIn(("gw-obs", "t-obs-prom"), deleted)
        self.assertNotIn(("gw-sec", "t-sec-iam"), deleted)
        self.assertNotIn(("gw-sec", "t-sec-manual"), deleted)
        # Unknown target is logged as KEEP (audit trail), not deleted.
        self.assertIn(("prune:hand-rolled-target", "KEEP"),
                      {(r[0], r[1]) for r in provision.report})

    def test_preserves_old_copy_when_new_home_target_is_missing(self):
        # M1 (review #86): flag-OFF / create-failed → external-obs has NO prometheus target.
        # Prune MUST NOT delete the stale monitoring copy (else the tool vanishes everywhere).
        per_gw = {
            "gw-mon": [{"name": "prometheus-mcp-target", "targetId": "t-mon-prom"}],
            "gw-obs": [],  # new home was SKIPped (integrations_enabled=false) — no target landed
        }
        gw_ids = {"monitoring": "gw-mon", "external-obs": "gw-obs"}
        ctrl = mock.Mock()

        def fake_list_all(_fn, gatewayIdentifier=None, **_kw):
            return per_gw.get(gatewayIdentifier, [])

        with mock.patch.object(provision.catalog, "TARGETS", _MOVED_CATALOG), \
             mock.patch.object(provision, "_list_all", side_effect=fake_list_all):
            provision.prune_moved_targets(ctrl, gw_ids)

        ctrl.delete_gateway_target.assert_not_called()  # last copy preserved
        self.assertIn(("prune:prometheus-mcp-target", "KEEP"),
                      {(r[0], r[1]) for r in provision.report})


if __name__ == "__main__":
    unittest.main()
