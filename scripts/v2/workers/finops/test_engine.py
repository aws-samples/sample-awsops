from finops import engine, catalog, llm


class FakeConn:
    """Mimics the subset of pg8000's Connection.run() the engine needs, keeping real upsert/resolve
    semantics (ON CONFLICT DO UPDATE, resolve-not-seen) so the tests exercise the actual SQL intent,
    not just that some string was sent."""

    def __init__(self):
        self.runs = []
        self.findings = {}  # (rule_id, account_id, region, resource_id) -> dict
        self._next_finding_id = 1

    def run(self, sql, **kw):
        s = sql.strip()
        if s.startswith("INSERT INTO finops_runs"):
            self.runs.append({"status": "running"})
            return [[len(self.runs)]]
        if s.startswith("UPDATE finops_runs"):
            self.runs[kw["id"] - 1].update(status=kw["s"], rules_evaluated=kw["re"],
                                           findings_count=kw["fc"], ce_api_calls=kw["ce"], error=kw["e"])
            return []
        if s.startswith("INSERT INTO finops_findings"):
            key = (kw["rule_id"], kw["acct"], kw["region"], kw["rid"])
            row = self.findings.get(key)
            if row is None:
                row = {"id": self._next_finding_id, "explanation_ko": None}
                self._next_finding_id += 1
                self.findings[key] = row
            else:
                # Mirrors the real CASE in engine.py's ON CONFLICT DO UPDATE: the LLM prompt is
                # built from title/category/evidence/monthly_savings_usd together, so the stored
                # explanation is only still valid if NONE of those changed.
                changed = (row["monthly_savings_usd"] != kw["savings"] or row["title"] != kw["title"]
                           or row["category"] != kw["cat"] or row["evidence"] != kw["ev"])
                if changed:
                    row["explanation_ko"] = None
            row.update(title=kw["title"], category=kw["cat"], status=kw["status"],
                       monthly_savings_usd=kw["savings"], evidence=kw["ev"], guard_hits=kw["guards"],
                       resolved_at=None)
            return [[row["id"]]]
        if "SET status='resolved'" in s:
            rid, seen = kw["rid"], set(kw["seen"])
            for key, row in self.findings.items():
                scoped = f"{key[1]}\x1f{key[2]}\x1f{key[3]}"
                if key[0] == rid and row["status"] != "resolved" and scoped not in seen:
                    row["status"] = "resolved"
                    row["resolved_at"] = "now"
            return []
        if s.startswith("SELECT id, title, category, monthly_savings_usd, evidence"):
            return [
                (row["id"], row["title"], row["category"], row["monthly_savings_usd"], row["evidence"])
                for row in self.findings.values()
                if row["status"] != "resolved" and row.get("explanation_ko") is None
            ]
        if s.startswith("UPDATE finops_findings SET explanation_ko"):
            for row in self.findings.values():
                if row["id"] == kw["id"]:
                    row["explanation_ko"] = kw["t"]
            return []
        raise AssertionError(f"unexpected SQL in FakeConn: {s[:80]!r}")


def _rule(id_, items):
    def fn(conn, ce_calls):
        return items
    return {"id": id_, "title": id_, "category": "test", "status": "active", "fn": fn}


def _item(rid, savings=1.0, tags=None, lookback_days=None, account_id="self", region=""):
    return {"resource_id": rid, "account_id": account_id, "region": region, "title": f"finding {rid}",
            "category": "test", "monthly_savings_usd": savings, "evidence": {}, "tags": tags,
            "lookback_days": lookback_days}


def test_run_persists_findings_and_marks_run_succeeded(monkeypatch):
    conn = FakeConn()
    monkeypatch.setattr(catalog, "active_rules", lambda: [_rule("r1", [_item("res-a")])])
    monkeypatch.setattr(llm, "explain", lambda *a, **kw: None)
    out = engine.run({}, conn)
    assert out["rules_evaluated"] == 1
    assert out["findings_count"] == 1
    assert conn.findings[("r1", "self", "", "res-a")]["status"] == "active"
    assert conn.runs[0]["status"] == "succeeded"


def test_guard_hit_demotes_to_needs_review_but_still_persists(monkeypatch):
    conn = FakeConn()
    monkeypatch.setattr(catalog, "active_rules",
                         lambda: [_rule("r1", [_item("res-a", tags={"dr": "true"})])])
    monkeypatch.setattr(llm, "explain", lambda *a, **kw: None)
    engine.run({}, conn)
    row = conn.findings[("r1", "self", "", "res-a")]
    assert row["status"] == "needs_review"
    assert row["guard_hits"] == ["protected_tag:dr"]


def test_resolves_findings_not_reproduced_by_a_rule_that_ran_successfully(monkeypatch):
    conn = FakeConn()
    monkeypatch.setattr(llm, "explain", lambda *a, **kw: None)
    monkeypatch.setattr(catalog, "active_rules", lambda: [_rule("r1", [_item("res-a"), _item("res-b")])])
    engine.run({}, conn)
    assert set(conn.findings) == {("r1", "self", "", "res-a"), ("r1", "self", "", "res-b")}

    monkeypatch.setattr(catalog, "active_rules", lambda: [_rule("r1", [_item("res-a")])])
    engine.run({}, conn)
    assert conn.findings[("r1", "self", "", "res-a")]["status"] == "active"
    assert conn.findings[("r1", "self", "", "res-b")]["status"] == "resolved"


def test_resolve_stale_scopes_by_account_and_region_not_bare_resource_id(monkeypatch):
    # Two different accounts happen to share the same resource_id — a rule that stops reproducing
    # it for account A must not resolve account B's still-true finding for the identical id.
    conn = FakeConn()
    monkeypatch.setattr(llm, "explain", lambda *a, **kw: None)
    monkeypatch.setattr(catalog, "active_rules", lambda: [_rule(
        "r1", [_item("vol-1", account_id="111111111111"), _item("vol-1", account_id="222222222222")])])
    engine.run({}, conn)
    assert set(conn.findings) == {("r1", "111111111111", "", "vol-1"), ("r1", "222222222222", "", "vol-1")}

    monkeypatch.setattr(catalog, "active_rules",
                         lambda: [_rule("r1", [_item("vol-1", account_id="111111111111")])])
    engine.run({}, conn)
    assert conn.findings[("r1", "111111111111", "", "vol-1")]["status"] == "active"
    assert conn.findings[("r1", "222222222222", "", "vol-1")]["status"] == "resolved"


def test_a_failing_rule_does_not_resolve_its_own_prior_findings(monkeypatch):
    conn = FakeConn()
    monkeypatch.setattr(llm, "explain", lambda *a, **kw: None)
    monkeypatch.setattr(catalog, "active_rules", lambda: [_rule("r1", [_item("res-a")])])
    engine.run({}, conn)

    def _boom(conn, ce_calls):
        raise RuntimeError("AWS API down")
    monkeypatch.setattr(catalog, "active_rules", lambda: [{"id": "r1", "fn": _boom, "status": "active"}])
    out = engine.run({}, conn)
    assert out["findings_count"] == 0  # nothing NEW this run
    assert conn.findings[("r1", "self", "", "res-a")]["status"] == "active"  # untouched, not resolved
    assert conn.runs[1]["status"] == "partial"  # one rule failing doesn't fail the whole batch, but must be visible
    assert out["failed_rules"] == ["r1"]
    assert "r1: AWS API down" in conn.runs[1]["error"]


def test_top_level_exception_marks_run_failed_and_reraises(monkeypatch):
    conn = FakeConn()

    def _boom(*a, **kw):
        raise RuntimeError("catalog exploded")
    monkeypatch.setattr(catalog, "active_rules", _boom)
    try:
        engine.run({}, conn)
        assert False, "expected RuntimeError"
    except RuntimeError:
        pass
    assert conn.runs[0]["status"] == "failed"
    assert "catalog exploded" in conn.runs[0]["error"]


def test_explain_pending_attaches_llm_text_and_skips_contradicting_output(monkeypatch):
    conn = FakeConn()
    monkeypatch.setattr(catalog, "active_rules",
                         lambda: [_rule("r1", [_item("res-a", savings=10.0), _item("res-b", savings=20.0)])])
    calls = {"res-a": "설명 A", "res-b": None}  # None simulates llm.explain's own contradiction check

    def fake_explain(title, category, savings, evidence):
        return calls.get(title.rsplit(" ", 1)[-1])
    monkeypatch.setattr(llm, "explain", fake_explain)
    engine.run({}, conn)
    assert conn.findings[("r1", "self", "", "res-a")]["explanation_ko"] == "설명 A"
    assert conn.findings[("r1", "self", "", "res-b")]["explanation_ko"] is None


def test_explain_pending_stops_once_the_wall_clock_budget_is_exhausted(monkeypatch):
    # A review round caught this loop running unbounded, inside the run's critical section, before
    # _finish_run — up to 200 sequential Bedrock calls could burn the whole SFN task timeout AFTER
    # the deterministic findings were already upserted, landing the run 'failed' over a batch that
    # was otherwise materially successful. A budget must stop the loop and leave the run to finish
    # normally, with the remaining rows simply picked up next time.
    import time as time_module
    conn = FakeConn()
    monkeypatch.setattr(catalog, "active_rules", lambda: [_rule(
        "r1", [_item("res-a"), _item("res-b"), _item("res-c")])])
    calls = []

    def fake_explain(title, category, savings, evidence):
        calls.append(title)
        return f"설명 for {title}"
    monkeypatch.setattr(llm, "explain", fake_explain)

    # First call computes the deadline (t=0 -> deadline=BUDGET); every call after that reports
    # time already far past it, so the very first in-loop check trips — proving the check
    # actually gates the loop rather than merely existing.
    clock = iter([0.0] + [10_000_000.0] * 10)
    monkeypatch.setattr(time_module, "monotonic", lambda: next(clock))
    out = engine.run({}, conn)
    assert calls == []
    assert out["status"] == "succeeded"  # the batch itself is unaffected — only explanations skip
    for key in (("r1", "self", "", "res-a"), ("r1", "self", "", "res-b"), ("r1", "self", "", "res-c")):
        assert conn.findings[key]["explanation_ko"] is None


def test_explanation_survives_a_rerun_with_no_change(monkeypatch):
    conn = FakeConn()
    monkeypatch.setattr(catalog, "active_rules", lambda: [_rule("r1", [_item("res-a", savings=10.0)])])
    monkeypatch.setattr(llm, "explain", lambda *a, **kw: "설명 A")
    engine.run({}, conn)
    assert conn.findings[("r1", "self", "", "res-a")]["explanation_ko"] == "설명 A"

    # _explain_pending only re-prompts rows with explanation_ko IS NULL — if a rerun with an
    # identical finding wrongly cleared it, this second run would try to overwrite it and this
    # assertion would catch a regression back to the SQL checking amount alone.
    monkeypatch.setattr(llm, "explain", lambda *a, **kw: (_ for _ in ()).throw(
        AssertionError("should not re-prompt an unchanged finding")))
    engine.run({}, conn)
    assert conn.findings[("r1", "self", "", "res-a")]["explanation_ko"] == "설명 A"


def test_explanation_is_cleared_when_the_amount_changes(monkeypatch):
    conn = FakeConn()
    monkeypatch.setattr(catalog, "active_rules", lambda: [_rule("r1", [_item("res-a", savings=10.0)])])
    monkeypatch.setattr(llm, "explain", lambda *a, **kw: "설명 A (월 $10.00)")
    engine.run({}, conn)
    assert conn.findings[("r1", "self", "", "res-a")]["explanation_ko"] == "설명 A (월 $10.00)"

    monkeypatch.setattr(catalog, "active_rules", lambda: [_rule("r1", [_item("res-a", savings=25.0)])])
    monkeypatch.setattr(llm, "explain", lambda *a, **kw: None)  # simulate a Bedrock hiccup this run
    engine.run({}, conn)
    # The stale explanation, which now cites a wrong dollar figure, must not survive just because
    # this run's re-prompt happened to fail — leaving the wrong number would be worse than blank.
    assert conn.findings[("r1", "self", "", "res-a")]["explanation_ko"] is None


def test_explanation_is_cleared_when_evidence_changes_but_the_amount_does_not(monkeypatch):
    # A rule can revise its evidence/title (e.g. a different recommended instance type) while the
    # dollar figure coincidentally stays identical — checking amount alone would leave an
    # explanation that quotes the right number next to now-wrong specifics.
    conn = FakeConn()
    monkeypatch.setattr(catalog, "active_rules", lambda: [_rule(
        "r1", [{"resource_id": "res-a", "account_id": "self", "region": "", "title": "m5.xlarge -> m5.large",
                "category": "test", "monthly_savings_usd": 10.0, "evidence": {"to": "m5.large"}, "tags": None,
                "lookback_days": None}])])
    monkeypatch.setattr(llm, "explain", lambda *a, **kw: "m5.large로 축소 권장")
    engine.run({}, conn)
    assert conn.findings[("r1", "self", "", "res-a")]["explanation_ko"] == "m5.large로 축소 권장"

    monkeypatch.setattr(catalog, "active_rules", lambda: [_rule(
        "r1", [{"resource_id": "res-a", "account_id": "self", "region": "", "title": "m5.xlarge -> m5.medium",
                "category": "test", "monthly_savings_usd": 10.0, "evidence": {"to": "m5.medium"}, "tags": None,
                "lookback_days": None}])])
    monkeypatch.setattr(llm, "explain", lambda *a, **kw: None)  # simulate a Bedrock hiccup this run
    engine.run({}, conn)
    assert conn.findings[("r1", "self", "", "res-a")]["explanation_ko"] is None
