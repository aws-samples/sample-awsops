"""Tests for k8s_events — parse/aggregate notable Warning events (read-only, PII-redacted, never-raise).

The pure parse path (_parse_events) takes raw core/v1 Event JSON so it's testable without a cluster.
PII rule: the event `message` free-text is NEVER exported; only {cluster, namespace, kind, name}.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from insight import k8s_events as k8e  # noqa: E402


def _ev(reason, kind, name, ns, etype="Warning", count=1, msg="secret-token=abc leaked path /home/u"):
    return {"type": etype, "reason": reason, "count": count, "message": msg,
            "involvedObject": {"kind": kind, "name": name, "namespace": ns}}


class TestParse:
    def test_filters_notable_warning_reasons(self):
        events = [
            _ev("OOMKilling", "Pod", "api-7f", "prod"),
            _ev("FailedScheduling", "Pod", "worker-1", "batch"),
            _ev("Created", "Pod", "x", "prod"),        # not notable → dropped
            _ev("BackOff", "Pod", "db-0", "data", etype="Normal"),  # not Warning → dropped
        ]
        items = k8e._parse_events("prod-cluster", events)
        reasons = {i["refs"]["reason"] for i in items}
        assert reasons == {"OOMKilling", "FailedScheduling"}

    def test_aggregates_by_reason_kind_namespace(self):
        events = [_ev("CrashLoopBackOff", "Pod", "api-1", "prod", count=2),
                  _ev("CrashLoopBackOff", "Pod", "api-2", "prod", count=3)]
        items = k8e._parse_events("c1", events)
        # same (reason, kind, namespace) aggregates into one item with summed count
        assert len(items) == 1 and items[0]["refs"]["count"] == 5

    def test_message_freetext_is_never_exported(self):
        items = k8e._parse_events("c1", [_ev("OOMKilling", "Pod", "api", "prod", msg="secret-token=abc")])
        blob = str(items)
        assert "secret-token" not in blob and "abc" not in blob   # message redacted entirely
        # aggregate refs carry NO single object name (group over reason×kind×namespace)
        assert items[0]["refs"] == {"cluster": "c1", "namespace": "prod", "kind": "Pod",
                                    "reason": "OOMKilling", "count": 1}
        assert "name" not in items[0]["refs"]

    def test_aggregate_with_missing_name_does_not_leak_none(self):
        items = k8e._parse_events("c", [_ev("Failed", "Pod", None, "prod"), _ev("Failed", "Pod", None, "prod")])
        assert "None" not in items[0]["title"] and items[0]["refs"]["count"] == 2

    def test_oom_is_critical_others_warning(self):
        items = k8e._parse_events("c", [_ev("OOMKilling", "Pod", "a", "p"),
                                        _ev("FailedMount", "Pod", "b", "p")])
        sev = {i["refs"]["reason"]: i["severity"] for i in items}
        assert sev["OOMKilling"] == "critical" and sev["FailedMount"] == "warning"

    def test_bounded_per_cluster(self):
        many = [_ev("Failed", "Pod", f"p{i}", f"ns{i}") for i in range(100)]
        items = k8e._parse_events("c", many)
        assert len(items) <= k8e._MAX_PER_CLUSTER


class TestCollect:
    def test_collects_across_clusters_via_getter(self, monkeypatch):
        monkeypatch.setenv("ONBOARD_EKS_CLUSTERS", "c1,c2")
        def getter(cluster):
            return [_ev("OOMKilling", "Pod", "x", "prod")] if cluster == "c1" else []
        out = k8e.collect_k8s_events(getter=getter)
        assert out["source"] == "k8s" and len(out["items"]) == 1
        assert out["items"][0]["refs"]["cluster"] == "c1"

    def test_no_clusters_is_empty_skip(self, monkeypatch):
        monkeypatch.delenv("ONBOARD_EKS_CLUSTERS", raising=False)
        out = k8e.collect_k8s_events(getter=lambda c: [])
        assert out["items"] == [] and "no" in (out.get("notes") or "").lower()

    def test_per_cluster_error_is_graceful_skip(self, monkeypatch):
        monkeypatch.setenv("ONBOARD_EKS_CLUSTERS", "good,bad")
        def getter(cluster):
            if cluster == "bad":
                raise RuntimeError("403 access entry missing")
            return [_ev("FailedScheduling", "Pod", "x", "prod")]
        out = k8e.collect_k8s_events(getter=getter)   # bad cluster skipped, good still collected
        assert len(out["items"]) == 1 and "bad" in (out.get("notes") or "")
