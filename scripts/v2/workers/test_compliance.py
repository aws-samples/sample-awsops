"""compliance.py — Powerpipe JSON parsing (pure), password scrub, and the _compliance handler
registration/dry_run. No subprocess/boto3/Aurora in these tests."""
import compliance
import handlers

# Top-level group rollup summary (v1 parity: run totals come from groups[].summary.control),
# plus leaf control results (for compliance_results detail rows).
SAMPLE = {
    "groups": [
        {
            "title": "1 IAM",
            "summary": {"control": {"total": 2, "ok": 1, "alarm": 1, "info": 0, "skip": 0, "error": 0}},
            "controls": [
                {"control_id": "1.1", "title": "MFA", "tags": {"severity": "high"}, "results": [
                    {"status": "ok", "reason": "ok", "resource": "arn:user/a",
                     "dimensions": [{"key": "region", "value": "us-east-1"}]},
                    {"status": "alarm", "reason": "no mfa", "resource": "arn:user/b",
                     "dimensions": [{"key": "region", "value": "us-east-1"}]},
                ]},
            ],
        },
    ],
}


def test_parse_totals_from_group_summaries():
    totals, controls = compliance.parse_powerpipe_json(SAMPLE)
    assert totals["total_controls"] == 2 and totals["ok"] == 1 and totals["alarm"] == 1
    assert round(totals["pass_rate"], 1) == 50.0  # ok / (ok+alarm+info+skip+error) * 100
    assert sorted(c["status"] for c in controls) == ["alarm", "ok"]
    assert all(c["region"] == "us-east-1" for c in controls)
    assert controls[0]["severity"] == "high"


def test_parse_empty_is_zero_not_crash():
    totals, controls = compliance.parse_powerpipe_json({"groups": []})
    assert totals["total_controls"] == 0 and totals["pass_rate"] == 0
    assert controls == []


def test_parse_falls_back_to_leaf_counts_when_no_summary():
    doc = {"groups": [{"title": "g", "controls": [
        {"control_id": "x", "results": [{"status": "ok"}, {"status": "alarm"}, {"status": "ok"}]}]}]}
    totals, controls = compliance.parse_powerpipe_json(doc)
    assert totals["total_controls"] == 3 and totals["ok"] == 2 and totals["alarm"] == 1
    assert len(controls) == 3


def test_scrub_redacts_steampipe_password():
    msg = "FATAL: connect postgres://steampipe:s3cr3tPW@host:9193/steampipe failed"
    scrubbed = compliance._scrub(msg)
    assert "s3cr3tPW" not in scrubbed
    assert "postgres://steampipe:***@host" in scrubbed


def test_compliance_handler_dry_run():
    out, art = handlers._compliance({"benchmark": "cis_v300", "run_id": 1}, True)
    assert out["dry_run"] is True and out["would_run"] == "cis_v300"
    assert art is None


def test_compliance_registered_as_fargate():
    assert handlers.REGISTRY["compliance"][1] == "fargate"
    assert handlers.is_allowed("compliance")
    assert handlers.runtime_for("compliance") == "fargate"


def test_run_powerpipe_scope_search_path(monkeypatch):
    """A 12-digit scope adds --search-path public,aws_<id>; 'all' keeps the aggregator default;
    a malformed scope raises before any subprocess call (defense vs forged payloads)."""
    import subprocess as sp
    import compliance
    seen = {}

    def fake_run(cmd, **kw):
        seen["cmd"] = cmd

        class P:
            returncode = 0
            stdout = "{}"
            stderr = ""
        return P()

    monkeypatch.setattr(sp, "run", fake_run)
    compliance.run_powerpipe("cis_v400", "postgres://x", "123456789012")
    assert "--search-path" in seen["cmd"]
    assert "public,aws_123456789012" in seen["cmd"]

    compliance.run_powerpipe("cis_v400", "postgres://x", "all")
    assert "--search-path" not in seen["cmd"]

    import pytest
    with pytest.raises(ValueError):
        compliance.run_powerpipe("cis_v400", "postgres://x", "123; DROP TABLE x")
