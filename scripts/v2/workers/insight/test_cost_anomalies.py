"""Tests for cost_anomalies — day-over-day per-service cost spike detection (read-only, bounded).

A fake Cost Explorer client returns DAILY ResultsByTime grouped by SERVICE. Detection flags a service
only when BOTH the % jump and the absolute $ jump exceed the thresholds (noise suppression).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from insight import cost_anomalies as ca  # noqa: E402


def _day(date, groups):
    return {"TimePeriod": {"Start": date},
            "Groups": [{"Keys": [svc], "Metrics": {"UnblendedCost": {"Amount": str(amt), "Unit": "USD"}}}
                       for svc, amt in groups]}


class FakeCE:
    def __init__(self, results):
        self._results = results
        self.calls = []
    def get_cost_and_usage(self, **kw):
        self.calls.append(kw)
        return {"ResultsByTime": self._results}


class TestSpikeDetection:
    def test_flags_service_exceeding_both_thresholds(self):
        ce = FakeCE([_day("2026-06-22", [("Amazon EC2", 100.0)]),
                     _day("2026-06-23", [("Amazon EC2", 200.0)])])  # +100% and +$100
        out = ca.collect_cost_anomalies(ce=ce)
        assert out["source"] == "cost" and len(out["items"]) == 1
        it = out["items"][0]
        assert "EC2" in it["title"] and it["severity"] == "critical"  # >$100 abs increase
        assert it["refs"]["service"] == "Amazon EC2"

    def test_no_flag_when_pct_high_but_abs_tiny(self):
        ce = FakeCE([_day("2026-06-22", [("AWS KMS", 0.50)]),
                     _day("2026-06-23", [("AWS KMS", 2.00)])])  # +300% but only +$1.50 < $10 abs
        out = ca.collect_cost_anomalies(ce=ce)
        assert out["items"] == []

    def test_no_flag_when_abs_high_but_pct_small(self):
        ce = FakeCE([_day("2026-06-22", [("Amazon RDS", 1000.0)]),
                     _day("2026-06-23", [("Amazon RDS", 1040.0)])])  # +$40 abs but only +4% < 50%
        out = ca.collect_cost_anomalies(ce=ce)
        assert out["items"] == []

    def test_warning_severity_for_moderate_increase(self):
        ce = FakeCE([_day("2026-06-22", [("Amazon S3", 20.0)]),
                     _day("2026-06-23", [("Amazon S3", 50.0)])])  # +150%, +$30 (>$10, <$100)
        out = ca.collect_cost_anomalies(ce=ce)
        assert out["items"][0]["severity"] == "warning"


class TestDefensive:
    def test_ce_error_never_raises(self):
        class Boom:
            def get_cost_and_usage(self, **kw):
                raise RuntimeError("ce down")
        out = ca.collect_cost_anomalies(ce=Boom())
        assert out["source"] == "cost" and out["items"] == [] and out.get("notes")

    def test_single_day_no_baseline_is_empty(self):
        ce = FakeCE([_day("2026-06-23", [("Amazon EC2", 200.0)])])
        out = ca.collect_cost_anomalies(ce=ce)
        assert out["items"] == []

    def test_thresholds_are_named_constants(self):
        assert ca.SPIKE_PCT == 50 and ca.SPIKE_ABS_USD == 10 and ca.LOOKBACK_DAYS == 7

    def test_request_excludes_todays_partial_bucket(self):
        # MAJOR fix: CE End is exclusive and must equal TODAY (UTC) so the last compared bucket is
        # yesterday (complete), never today (partial/lagged → would suppress every spike).
        import datetime
        from datetime import timezone
        ce = FakeCE([_day("2026-06-22", []), _day("2026-06-23", [])])
        ca.collect_cost_anomalies(ce=ce)
        end = ce.calls[0]["TimePeriod"]["End"]
        assert end == datetime.datetime.now(timezone.utc).date().isoformat()
