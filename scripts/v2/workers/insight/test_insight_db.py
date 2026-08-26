"""Tests for ai_insights db helpers (pg8000 conn.run pattern)."""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import db  # noqa: E402


class FakeConn:
    def __init__(self, returns=None):
        self.calls = []
        self._returns = returns or []
    def run(self, sql, **params):
        self.calls.append((sql, params))
        return self._returns.pop(0) if self._returns else []


INSIGHTS = [{"severity": "critical", "title": "OOM", "detail": "api", "source": "k8s", "refs": {}}]


class TestInsert:
    def test_insert_binds_jsonb(self):
        c = FakeConn()
        db.insert_insight(c, status="succeeded", insights=INSIGHTS,
                          sources_used={"k8s": 1}, model="bedrock", error=None)
        sql, p = c.calls[0]
        assert "INSERT INTO ai_insights" in sql and "::jsonb" in sql
        assert p["st"] == "succeeded" and p["md"] == "bedrock"
        assert json.loads(p["ins"])[0]["title"] == "OOM"   # bound, json-encoded
        assert "OOM" not in sql                              # never inlined
        # NOTE: the read side is the BFF (web/lib/insights.ts, node-pg) — there is intentionally no
        # python get_latest_insight reader (the worker only ever INSERTs), so none is tested here.
