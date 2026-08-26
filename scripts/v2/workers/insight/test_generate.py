"""Tests for generate.synthesize — signals → 3-5 prioritized bullets, with deterministic fallback."""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from insight import generate as gen  # noqa: E402


def _sig(source, items):
    return {"source": source, "items": items, "notes": ""}


SIGNALS = [
    _sig("k8s", [{"severity": "critical", "title": "K8s OOMKilling: Pod/api (prod)",
                  "detail": "prod-cluster: OOMKilling", "refs": {"reason": "OOMKilling"}}]),
    _sig("cost", [{"severity": "warning", "title": "비용 급증: Amazon EC2",
                   "detail": "+120%", "refs": {"service": "Amazon EC2"}}]),
]


class TestSynthesize:
    def test_parses_bedrock_bullets(self):
        def invoke(prompt):
            return json.dumps({"insights": [
                {"severity": "critical", "title": "OOM in prod", "detail": "api pod OOMKilled", "source": "k8s"},
                {"severity": "warning", "title": "EC2 cost up", "detail": "+120%", "source": "cost"},
            ]})
        out = gen.synthesize(SIGNALS, invoke=invoke)
        assert out["status"] == "succeeded"
        assert 1 <= len(out["insights"]) <= gen._MAX_BULLETS
        assert out["insights"][0]["severity"] == "critical"

    def test_caps_bullet_count_and_length(self):
        def invoke(prompt):
            return json.dumps({"insights": [
                {"severity": "info", "title": f"t{i}", "detail": "x" * 9999, "source": "cost"} for i in range(20)]})
        out = gen.synthesize(SIGNALS, invoke=invoke)
        assert len(out["insights"]) <= gen._MAX_BULLETS
        assert all(len(b["detail"]) <= gen._MAX_DETAIL for b in out["insights"])


class TestFallback:
    def test_bedrock_failure_falls_back_to_raw_signals(self):
        def invoke(prompt):
            raise RuntimeError("bedrock throttled")
        out = gen.synthesize(SIGNALS, invoke=invoke)
        assert out["status"] == "partial"
        assert out["insights"], "fallback must surface raw top signals, never blank"
        # critical signal surfaces first
        assert out["insights"][0]["severity"] == "critical"

    def test_unparseable_response_falls_back(self):
        out = gen.synthesize(SIGNALS, invoke=lambda p: "not json at all")
        assert out["status"] == "partial" and out["insights"]


class TestEmpty:
    def test_no_signals_returns_all_clear(self):
        out = gen.synthesize([_sig("k8s", []), _sig("cost", [])], invoke=lambda p: (_ for _ in ()).throw(AssertionError("should not call bedrock")))
        assert out["status"] == "succeeded"
        assert len(out["insights"]) == 1 and out["insights"][0]["severity"] == "info"
        assert "특이사항" in out["insights"][0]["title"]
