"""B2 — the reaper must also reconcile diagnosis_reports (not just worker_jobs): a report whose
worker job failed, or that has gone stale (no progress heartbeat), is marked 'failed' so the UI
never shows an eternal 'running'. V1 had a 30-min stale guard; this is its V2 edition."""


class FakeConn:
    def __init__(self, report_rows=None):
        self.calls = []
        self.report_rows = report_rows or []

    def run(self, sql, **kw):
        self.calls.append((sql, kw))
        if "diagnosis_reports" in sql:
            return self.report_rows
        return []  # worker_jobs / remediation reaps: nothing stale

    def close(self):
        pass


def _diag_call(conn):
    return next(c for c in conn.calls if "diagnosis_reports" in c[0])


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
