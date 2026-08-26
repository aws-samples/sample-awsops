import hashlib
import importlib
import sys
import types
import unittest

# Stub db so the module imports without pg8000/network.
db_stub = types.ModuleType("db")
db_stub.connect = lambda: None
sys.modules["db"] = db_stub
pl = importlib.import_module("prevention_loop")


class AggregateTest(unittest.TestCase):
    def _inc(self, iid, cat, svc, sev="warning"):
        return {"id": iid, "rca": {"category": cat}, "services": [svc], "severity": sev}

    def test_groups_by_category_and_service_with_threshold(self):
        incs = [
            self._inc("a", "deployment", "svc-foo"),
            self._inc("b", "deployment", "svc-foo"),
            self._inc("c", "deployment", "svc-bar"),  # only 1 → below threshold 2
            self._inc("d", "capacity", "svc-foo"),     # only 1
        ]
        insights = pl.aggregate(incs, threshold=2, window_days=30)
        # only deployment::svc-foo recurs (2x)
        self.assertEqual(len(insights), 1)
        ins = insights[0]
        self.assertEqual(ins["scope_ref"], "deployment::svc-foo")
        self.assertEqual(ins["recurrence_count"], 2)
        self.assertEqual(sorted(ins["source_incident_ids"]), ["a", "b"])
        self.assertEqual(ins["category"], "testing")  # deployment → testing (per the map)
        self.assertEqual(ins["dedup_key"], hashlib.sha256(b"deployment::svc-foo").hexdigest()[:40])

    def test_recommend_only_no_mutation_symbols(self):
        src = open(pl.__file__).read()
        for bad in ["create_ops_item", "start_execution", "put_parameter", "delete_", "runTask", "/api/actions", "kubectl"]:
            self.assertNotIn(bad, src, f"prevention_loop must be recommend-only (found {bad})")

    def test_unknown_category_degrades(self):
        insights = pl.aggregate([self._inc("a", None, "svc-x"), self._inc("b", "", "svc-x")], threshold=2, window_days=30)
        self.assertEqual(len(insights), 1)
        self.assertEqual(insights[0]["scope_ref"], "unknown::svc-x")


if __name__ == "__main__":
    unittest.main()
