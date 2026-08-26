"""Tests for cw_anomalies — CloudWatch alarms in ALARM state (read-only, bounded, redacted)."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from insight import cw_anomalies as cw  # noqa: E402


class FakeCW:
    def __init__(self, pages):
        self._pages = pages
        self.calls = []
    def describe_alarms(self, **kw):
        self.calls.append(kw)
        return self._pages.pop(0) if self._pages else {"MetricAlarms": [], "CompositeAlarms": []}


def _alarm(name, ns="AWS/EC2", reason="Threshold Crossed", dims=None):
    return {"AlarmName": name, "StateValue": "ALARM", "Namespace": ns,
            "StateReason": reason, "Dimensions": dims or [{"Name": "InstanceId", "Value": "i-abc"}]}


class TestAlarms:
    def test_collects_alarm_state_alarms(self):
        c = FakeCW([{"MetricAlarms": [_alarm("rds-cpu-high", "AWS/RDS"), _alarm("ec2-status")],
                     "CompositeAlarms": []}])
        out = cw.collect_cw_anomalies(cw_client=c)
        assert out["source"] == "cloudwatch" and len(out["items"]) == 2
        names = {i["refs"]["alarm"] for i in out["items"]}
        assert names == {"rds-cpu-high", "ec2-status"}
        # only state=ALARM requested
        assert c.calls[0].get("StateValue") == "ALARM"

    def test_refs_are_non_pii_metadata_only(self):
        c = FakeCW([{"MetricAlarms": [_alarm("a", "AWS/RDS", dims=[{"Name": "DBInstanceIdentifier", "Value": "prod-db"}])],
                     "CompositeAlarms": []}])
        it = cw.collect_cw_anomalies(cw_client=c)["items"][0]
        # dimension NAMES kept (non-PII), the metadata identifies the alarm/namespace
        assert it["refs"]["namespace"] == "AWS/RDS"
        assert "DBInstanceIdentifier" in (it["refs"].get("dimensions") or [])

    def test_state_reason_values_not_exported(self):
        c = FakeCW([{"MetricAlarms": [_alarm("a", reason="Threshold Crossed: [85.0] > threshold (80.0)")],
                     "CompositeAlarms": []}])
        it = cw.collect_cw_anomalies(cw_client=c)["items"][0]
        blob = str(it)
        assert "85.0" not in blob and "80.0" not in blob   # datapoint/threshold values redacted (spec §5)

    def test_paginates_bounded(self):
        c = FakeCW([{"MetricAlarms": [_alarm("a1")], "CompositeAlarms": [], "NextToken": "t"},
                    {"MetricAlarms": [_alarm("a2")], "CompositeAlarms": []}])
        out = cw.collect_cw_anomalies(cw_client=c)
        assert len(out["items"]) == 2 and len(c.calls) == 2


class TestDefensive:
    def test_no_alarms_is_empty(self):
        out = cw.collect_cw_anomalies(cw_client=FakeCW([{"MetricAlarms": [], "CompositeAlarms": []}]))
        assert out["items"] == []

    def test_error_never_raises(self):
        class Boom:
            def describe_alarms(self, **kw):
                raise RuntimeError("cw down")
        out = cw.collect_cw_anomalies(cw_client=Boom())
        assert out["source"] == "cloudwatch" and out["items"] == [] and out.get("notes")
