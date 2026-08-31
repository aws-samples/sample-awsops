"""B2 — the reaper must also reconcile diagnosis_reports (not just worker_jobs): a report whose
worker job failed, or that has gone stale (no progress heartbeat), is marked 'failed' so the UI
never shows an eternal 'running'. V1 had a 30-min stale guard; this is its V2 edition."""


class FakeConn:
    def __init__(self, report_rows=None, finops_run_rows=None):
        self.calls = []
        self.report_rows = report_rows or []
        self.finops_run_rows = finops_run_rows or []

    def run(self, sql, **kw):
        self.calls.append((sql, kw))
        if "diagnosis_reports" in sql:
            return self.report_rows
        if "finops_runs" in sql:
            return self.finops_run_rows
        return []  # worker_jobs / remediation reaps: nothing stale

    def close(self):
        pass


def _diag_call(conn):
    return next(c for c in conn.calls if "diagnosis_reports" in c[0])


def _finops_run_call(conn):
    return next(c for c in conn.calls if "finops_runs" in c[0])


def test_reaper_reconciles_failed_and_stale_diagnosis_reports(monkeypatch):
    import reaper
    conn = FakeConn(report_rows=[[7], [9]])
    monkeypatch.setattr(reaper.db, "connect", lambda: conn)

    out = reaper.lambda_handler(None, None)

    assert out["reaped_reports"] == 2
    sql, kw = _diag_call(conn)
    assert "UPDATE diagnosis_reports" in sql
    assert "status='failed'" in sql and "status='running'" in sql   # only fail running rows
    assert "worker_job_id IN" in sql                                # linked-job-failed branch
    assert "make_interval" in sql                                   # C12: no string concat
    assert kw["m"] == reaper.R                                      # RUNNING_STALE_MIN threshold


def test_reaper_reports_zero_when_none_stale(monkeypatch):
    import reaper
    conn = FakeConn(report_rows=[])
    monkeypatch.setattr(reaper.db, "connect", lambda: conn)
    out = reaper.lambda_handler(None, None)
    assert out["reaped_reports"] == 0


def test_reaper_reconciles_stale_running_finops_runs(monkeypatch):
    # ADR-020: engine.run() writes finops_runs 'running' BEFORE evaluating anything, and only
    # reaches its own terminal-status write via a Python return/except — a hard kill (Fargate OOM)
    # leaves the row 'running' forever, since nothing else reconciles finops_runs (a review round
    # caught this: the reaper only touched worker_jobs).
    import reaper
    conn = FakeConn(finops_run_rows=[[3]])
    monkeypatch.setattr(reaper.db, "connect", lambda: conn)

    out = reaper.lambda_handler(None, None)

    assert out["reaped_finops_runs"] == 1
    sql, kw = _finops_run_call(conn)
    assert "UPDATE finops_runs" in sql
    assert "status='failed'" in sql and "status='running'" in sql
    assert "finished_at=now()" in sql
    assert "make_interval" in sql
    assert kw["m"] == reaper.R


class FakeConnWithNetworkPathRows:
    """Network Path Check reaper coverage (design spec "Error handling": "Stale run -> a dedicated
    reaper query added to scripts/v2/workers/reaper.py reconciles network_path_runs the same way it
    already does for worker_jobs/diagnosis_reports")."""

    def __init__(self, running_rows, queued_rows):
        self.calls = []
        self.running_rows = running_rows
        self.queued_rows = queued_rows

    def run(self, sql, **kw):
        self.calls.append((sql, kw))
        if "network_path_runs" in sql and "status='running'" in sql:
            return self.running_rows
        if "network_path_runs" in sql and "status='queued'" in sql:
            return self.queued_rows
        return []

    def close(self):
        pass


def test_reaper_reaps_stale_network_path_runs(monkeypatch):
    import reaper
    conn = FakeConnWithNetworkPathRows(running_rows=[["r1"], ["r2"]], queued_rows=[["r3"]])
    monkeypatch.setattr(reaper.db, "connect", lambda: conn)

    out = reaper.lambda_handler(None, None)

    assert out["reaped_network_path_runs_running"] == 2
    assert out["reaped_network_path_runs_queued"] == 1
    run_calls = [c for c in conn.calls if "network_path_runs" in c[0]]
    assert any("overall_status='failed'" in c[0] for c in run_calls)
    assert any("finished_at=now()" in c[0] for c in run_calls)
    assert any("make_interval" in c[0] for c in run_calls)


def test_reaper_skips_network_path_queued_reap_when_dispatch_disabled(monkeypatch):
    import reaper
    conn = FakeConnWithNetworkPathRows(running_rows=[], queued_rows=[["r4"]])
    monkeypatch.setattr(reaper.db, "connect", lambda: conn)
    monkeypatch.setattr(reaper, "_dispatch_enabled", lambda: False)

    out = reaper.lambda_handler(None, None)

    assert out["reaped_network_path_runs_queued"] == "skipped (dispatch ESM disabled)"
