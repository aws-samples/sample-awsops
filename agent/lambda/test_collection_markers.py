"""Real producer-envelope contracts; only datasource HTTP and credential lookup are mocked."""
import copy
import importlib
import json
from pathlib import Path
import sys
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))
FIXTURES = Path(__file__).parents[1] / "fixtures"
MODULES = {name: importlib.import_module(f"{name}_mcp")
           for name in ("clickhouse", "tempo", "prometheus", "mimir")}
META = [{"name": "TraceId", "type": "String"}]
CREDS = {"endpoint": "https://fixture.example", "token": "fixture-only", "org_id": "fixture"}


def invoke(kind, upstream, args=None, status=200, tool=None):
    module = MODULES[kind]
    default = {"sql": "SELECT TraceId FROM traces"} if kind == "clickhouse" else {"query": "{}" if kind == "tempo" else "up"}
    with mock.patch.object(module, "load_datasource", return_value=CREDS), \
         mock.patch.object(module, "assert_host_allowed"), \
         mock.patch.object(module, "http_json", return_value=(status, copy.deepcopy(upstream))) as http:
        response = module.lambda_handler(
            {"tool_name": tool or f"{kind}_{'search' if kind == 'tempo' else 'query'}",
             "arguments": {**default, **(args or {})}}, None)
    return response["statusCode"], json.loads(response["body"]), http.call_args


class CollectionMarkers(unittest.TestCase):
    def test_clickhouse_metadata_and_count_checks_are_independent(self):
        for meta, count in (([], 0), ([{"name": "", "type": "String"}], 0),
                            ([{"name": "TraceId", "type": ""}], 0),
                            (META, None), (META, True), (META, 1)):
            with self.subTest(meta=meta, count=count):
                _, body, _ = invoke("clickhouse", {"data": [], "rows": count, "meta": meta})
                self.assertEqual(body["collectionStatus"], "unknown")
        _, body, _ = invoke("clickhouse", {"data": [], "meta": META})
        self.assertEqual(body["collectionStatus"], "unknown")

    def test_list_results_propagate_new_error_and_unknown_states(self):
        for kind in ("prometheus", "mimir"):
            for action, field in (("labels", "labels"), ("series", "series")):
                for extra, status, expected in [
                    ({}, 200, "empty"), ({}, 206, "partial"),
                    ({"error": "fixture failure"}, 200, "error"),
                    ({"warnings": None}, 200, "unknown"),
                    ({"warnings": [None]}, 200, "unknown"),
                    ({"infos": ["incomplete"]}, 200, "partial"),
                    ({"partial": True}, 200, "partial"),
                ]:
                    with self.subTest(kind=kind, action=action, extra=extra, status=status):
                        code, body, _ = invoke(kind, {"status": "success", "data": [], **extra},
                                               {"match": "up"}, status=status, tool=f"{kind}_{action}")
                        self.assertEqual(code, 200)
                        self.assertEqual(body[field], [])
                        self.assertEqual(body["collectionStatus"], expected)

    def test_new_non_object_error_paths_do_not_expose_upstream_text(self):
        for kind in ("clickhouse", "prometheus", "mimir"):
            for upstream in ("SYNTHETIC_CREDENTIAL", ["SYNTHETIC_CREDENTIAL"]):
                with self.subTest(kind=kind, upstream=upstream):
                    code, body, _ = invoke(kind, upstream, status=503)
                    self.assertEqual(code, 400)
                    self.assertEqual(body["collectionStatus"], "error")
                    self.assertNotIn("SYNTHETIC_CREDENTIAL", json.dumps(body))

    def test_query_shared_bodies_are_produced_from_actual_http_payloads(self):
        for case in json.loads((FIXTURES / "query-topology-contract.json").read_text()):
            for kind in case["kinds"]:
                with self.subTest(case=case["name"], kind=kind):
                    code, body, _ = invoke(kind, case["upstream"])
                    self.assertEqual(code, 200)
                    self.assertEqual(body, case["body"])

    def test_existing_tempo_adapter_fixtures_are_bound_to_real_producer(self):
        for case in json.loads((FIXTURES / "tempo-topology-contract.json").read_text()):
            with self.subTest(case=case["name"]):
                code, body, _ = invoke("tempo", case["upstream"])
                self.assertEqual(code, 200)
                self.assertEqual(body, case["body"])

    def test_http_errors_and_transport_failures_never_confirm_empty(self):
        for kind, module in MODULES.items():
            with self.subTest(kind=kind):
                code, body, _ = invoke(kind, {"error": "fixture failure"}, status=503)
                self.assertEqual(code, 400)
                self.assertEqual(body.get("collectionStatus"), "error")
                with mock.patch.object(module, "load_datasource", return_value=CREDS), \
                     mock.patch.object(module, "assert_host_allowed"), \
                     mock.patch.object(module, "http_json", side_effect=TimeoutError("fixture timeout")):
                    args = {"sql": "SELECT TraceId FROM traces"} if kind == "clickhouse" else {"query": "up"}
                    response = module.lambda_handler(
                        {"tool_name": f"{kind}_{'search' if kind == 'tempo' else 'query'}",
                         "arguments": args}, None)
                self.assertEqual(response["statusCode"], 400)
                self.assertEqual(json.loads(response["body"]).get("collectionStatus"), "error")

    def test_metrics_warnings_malformed_status_and_partial_flags(self):
        for kind in ("prometheus", "mimir"):
            for extra, expected in [
                ({"warnings": ["backend incomplete"]}, "partial"),
                ({"warnings": None}, "unknown"), ({"warnings": "bad shape"}, "unknown"),
                ({"infos": ["some samples omitted"]}, "partial"),
                ({"partial": True}, "partial"), ({"truncated": True}, "partial"),
                ({"partial": "false"}, "unknown"),
                ({"status": None}, "unknown"), ({"status": "error", "error": "failed"}, "error"),
                ({"error": "failed"}, "error"),
            ]:
                with self.subTest(kind=kind, extra=extra):
                    upstream = {"status": "success", "data": {"resultType": "vector", "result": []}, **extra}
                    _, body, _ = invoke(kind, upstream)
                    self.assertEqual(body.get("collectionStatus"), expected)

    def test_metrics_keep_rows_auth_tenant_and_range_bounds(self):
        for kind in ("prometheus", "mimir"):
            row = {"metric": {"client": "one"}, "value": [1, "2"]}
            _, body, call = invoke(kind, {"status": "success", "data": {"resultType": "vector", "result": [row]}})
            self.assertEqual(body["result"], [row])
            self.assertEqual(body.get("collectionStatus"), "ok")
            self.assertEqual(call.args[0], "GET")
            self.assertEqual(call.kwargs["headers"]["Authorization"], "Bearer fixture-only")
            if kind == "mimir":
                self.assertEqual(call.kwargs["headers"]["X-Scope-OrgID"], "fixture")
            values = [[n, "1"] for n in range(501)]
            _, body, _ = invoke(kind, {"status": "success", "data": {
                "resultType": "matrix", "result": [{"metric": {}, "values": values}]}},
                tool=f"{kind}_query_range")
            self.assertEqual(len(body["result"][0]["values"]), 500)
            self.assertTrue(body["truncated"])
            self.assertEqual(body.get("collectionStatus"), "partial")
            _, empty, _ = invoke(kind, {"status": "success", "data": {"resultType": "matrix", "result": []}},
                                 tool=f"{kind}_query_range")
            self.assertEqual(empty.get("collectionStatus"), "empty")

    def test_malformed_samples_and_metadata_are_not_complete(self):
        for kind in ("prometheus", "mimir"):
            for row in ({"metric": {}, "value": []}, {"metric": {}, "value": [None, "2"]},
                        {"metric": {}, "value": [1, {}]}, {"metric": [], "value": [1, "2"]}):
                with self.subTest(kind=kind, row=row):
                    _, body, _ = invoke(kind, {"status": "success", "data": {
                        "resultType": "vector", "result": [row]}})
                    self.assertEqual(body["result"], [row])
                    self.assertEqual(body.get("collectionStatus"), "unknown")
            _, body, _ = invoke(kind, {"status": "success", "warnings": [None],
                                      "data": {"resultType": "vector", "result": []}})
            self.assertEqual(body.get("collectionStatus"), "unknown")
        _, body, _ = invoke("clickhouse", {"data": [], "rows": 0, "meta": [None]})
        self.assertEqual(body.get("collectionStatus"), "unknown")
        _, body, _ = invoke("tempo", {"traces": [], "warnings": [None]})
        self.assertEqual(body.get("collectionStatus"), "unknown")

    def test_partial_http_success_is_not_confirmed_empty(self):
        for kind, upstream in [
            ("prometheus", {"status": "success", "data": {"resultType": "vector", "result": []}}),
            ("mimir", {"status": "success", "data": {"resultType": "vector", "result": []}}),
            ("tempo", {"traces": []}), ("clickhouse", {"data": [], "rows": 0, "meta": META}),
        ]:
            with self.subTest(kind=kind):
                _, body, _ = invoke(kind, upstream, status=206)
                self.assertEqual(body.get("collectionStatus"), "partial")

    def test_error_envelopes_cannot_override_well_formed_empty_rows(self):
        for kind, upstream in [
            ("tempo", {"traces": []}), ("clickhouse", {"data": [], "rows": 0, "meta": META}),
        ]:
            for failure in ({"status": "error"}, {"errorType": "query_failed"}):
                with self.subTest(kind=kind, failure=failure):
                    _, body, _ = invoke(kind, {**upstream, **failure})
                    self.assertEqual(body.get("collectionStatus"), "error")

    def test_tempo_job_progress_warning_and_requested_limit(self):
        trace = {"traceID": "0123456789abcdef"}
        for payload, expected in [
            ({"traces": [], "metrics": {"completedJobs": 2, "totalJobs": 2}}, "empty"),
            ({"traces": [], "metrics": {"completedJobs": 0, "totalJobs": 0}}, "unknown"),
            ({"traces": [], "metrics": {"completedJobs": True, "totalJobs": 1}}, "unknown"),
            ({"traces": [], "metrics": {"completedJobs": 3, "totalJobs": 2}}, "unknown"),
            ({"traces": [], "metrics": None}, "unknown"),
            ({"traces": [], "metrics": []}, "unknown"),
            ({"traces": [], "warnings": ["incomplete"],
              "metrics": {"completedJobs": 1, "totalJobs": 1}}, "partial"),
            ({"traces": [], "partial": True,
              "metrics": {"completedJobs": 1, "totalJobs": 1}}, "partial"),
            ({"traces": [], "error": "upstream failed",
              "metrics": {"completedJobs": 1, "totalJobs": 1}}, "error"),
            ({"traces": [trace], "metrics": {"completedJobs": 1, "totalJobs": 2}}, "partial"),
            ({"traces": [{}]}, "unknown"),
        ]:
            with self.subTest(payload=payload):
                _, body, _ = invoke("tempo", payload, {"limit": 20})
                self.assertEqual(body.get("collectionStatus"), expected)
        _, body, call = invoke("tempo", {"traces": [trace]}, {"limit": 1})
        self.assertEqual(body["traces"], [trace])
        self.assertEqual(body.get("collectionStatus"), "partial")
        self.assertIn("limit=1", call.args[1])
        self.assertEqual(call.kwargs["headers"]["X-Scope-OrgID"], "fixture")

    def test_tempo_bytes_never_look_complete(self):
        module = MODULES["tempo"]
        with mock.patch.object(module, "MAX_TOTAL_BYTES", 100):
            _, body, _ = invoke("tempo", {"traces": [{"traceID": "aa", "rootServiceName": "x" * 200}],
                                         "metrics": {"completedJobs": 1, "totalJobs": 1}})
        self.assertTrue(body["truncated"])
        self.assertEqual(body.get("collectionStatus"), "partial")

    def test_clickhouse_limit_error_and_counts_preserve_query_guards(self):
        rows = [{"TraceId": "9007199254740993"}, {"TraceId": "2"}]
        code, body, call = invoke("clickhouse", {"data": rows, "rows": 2, "meta": META}, {"max_rows": 1})
        self.assertEqual(code, 200)
        self.assertEqual(body["rows"], rows[:1])
        self.assertEqual(body["rowCount"], 1)
        self.assertEqual(body.get("collectionStatus"), "partial")
        self.assertIn("readonly=1", call.args[1])
        self.assertIn("max_result_rows=1", call.args[1])
        self.assertIn("max_execution_time=10", call.args[1])
        self.assertEqual(call.kwargs["body"], "SELECT TraceId FROM traces\nFORMAT JSON")
        for extra, expected in [({"rows": True}, "unknown"), ({"rows": 1}, "unknown"),
                                ({"exception": "failed"}, "error"), ({"warnings": ["incomplete"]}, "partial"),
                                ({"rows_before_limit_at_least": 3}, "partial")]:
            with self.subTest(extra=extra):
                _, body, _ = invoke("clickhouse", {"data": [], "rows": 0, "meta": META, **extra})
                self.assertEqual(body.get("collectionStatus"), expected)


if __name__ == "__main__":
    unittest.main()
