"""Evaluator contract tests. Handwritten predictions are NOT model measurements."""

import copy
from contextlib import ExitStack, redirect_stderr, redirect_stdout
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

import evaluate_diagnosis as evaluator


SCRIPT = Path(__file__).with_name("evaluate_diagnosis.py")
FIXTURE = Path(__file__).with_name("fixtures") / "diagnosis-eval.json"


def fixture():
    def case(case_id, cause, evidence, support):
        return {
            "case_id": case_id,
            "synthetic": True,
            "summary": "SYNTHETIC async diagnosis job",
            "evidence": [{"evidence_id": eid, "text": text} for eid, text in evidence],
            "expected": {
                "cause_id": cause,
                "abstain": cause is None,
                "supporting_evidence_ids": support,
            },
        }

    return {
        "schema_version": 1,
        "dataset_id": "synthetic-test",
        "synthetic": True,
        "causes": [
            {"cause_id": cause, "description": cause.replace("_", " ")}
            for cause in ("queue_delay", "worker_crash", "db_auth", "dependency_timeout")
        ],
        "cases": [
            case("queue", "queue_delay", [("q1", "Dispatch paused")], ["q1"]),
            case("crash", "worker_crash", [
                ("c1", "Worker exited"), ("c2", "Crash log"), ("noise", "Web healthy"),
            ], ["c1", "c2"]),
            case("insufficient", None, [("i1", "No task telemetry")], ["i1"]),
            case("conflicting", None, [("x1", "Unordered conflicting records")], ["x1"]),
        ],
    }


def prediction(case_id="queue", causes=None, evidence=None, **extra):
    return {
        "case_id": case_id,
        "ranked_cause_ids": ["queue_delay"] if causes is None else causes,
        "cited_evidence_ids": ["q1"] if evidence is None else evidence,
        "abstained": False,
        "confidence": 0.9,
        "elapsed_ms": 10,
        **extra,
    }


class OfflineTests(unittest.TestCase):
    def invoke(self, predictions, *, data=None, jsonl=False, raw=None, extra=()):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fixtures_path = root / "cases.json"
            predictions_path = root / "predictions.jsonl"
            fixtures_path.write_text(json.dumps(fixture() if data is None else data))
            text = raw if raw is not None else (
                "\n".join(json.dumps(p) for p in predictions)
                if jsonl else json.dumps(predictions)
            )
            predictions_path.write_text(text)
            # -S excludes site-packages: offline mode must not require/import boto3.
            return subprocess.run(
                [sys.executable, "-B", "-S", str(SCRIPT),
                 "--fixtures", str(fixtures_path), "--predictions", str(predictions_path),
                 *extra],
                capture_output=True, text=True, timeout=10,
            )

    def report(self, predictions, **kwargs):
        result = self.invoke(predictions, **kwargs)
        self.assertIn(result.returncode, (0, 1), result.stderr)
        return result.returncode, json.loads(result.stdout)

    def test_missing_cases_are_incomplete_not_correct_or_free(self):
        code, result = self.report([prediction(cost_usd=0)])
        self.assertEqual(code, 1)
        self.assertEqual(result["status"], "incomplete")
        self.assertEqual(result["coverage"]["missing_case_ids"],
                         ["crash", "insufficient", "conflicting"])
        self.assertEqual(result["coverage"]["prediction_rate"], 0.25)
        self.assertEqual(result["accuracy"]["top1_rate"], 0.5)
        self.assertEqual(result["accuracy"]["decision_accuracy"], 0.25)
        self.assertEqual(result["abstention"]["recall"], 0)
        self.assertEqual(result["cost_usd"]["known_count"], 1)
        self.assertEqual(result["cost_usd"]["unknown_count"], 3)
        self.assertEqual(result["cost_usd"]["sum_known"], 0)
        self.assertIsNone(result["cost_usd"]["total"])

    def test_mixed_results_separate_ranking_grounding_and_abstention(self):
        rows = [
            prediction(causes=["db_auth", "queue_delay"], cost_usd=0.03),
            prediction("crash", ["worker_crash"], ["noise"], confidence=0.8,
                       elapsed_ms=30),
            prediction("insufficient", [], ["i1"], abstained=True, confidence=0.1,
                       elapsed_ms=20, cost_usd=0.01),
            prediction("conflicting", ["dependency_timeout"], ["x1"], confidence=0.79,
                       elapsed_ms=40, cost_usd=None),
        ]
        code, result = self.report(rows)
        self.assertEqual(code, 0)  # Completeness is not an accuracy acceptance gate.
        self.assertEqual(result["accuracy"]["top1_rate"], 0.5)
        self.assertEqual(result["accuracy"]["top3_rate"], 1)
        self.assertEqual(result["accuracy"]["decision_accuracy"], 0.5)
        self.assertEqual(result["grounding"]["evidence_validity"], 1)
        self.assertEqual(result["grounding"]["support_precision"], 0.75)
        self.assertEqual(result["grounding"]["support_recall"], 0.6)
        self.assertEqual(result["grounding"]["grounded_decision_rate"], 0.25)
        self.assertEqual(result["false_confident_conclusions"]["count"], 2)
        self.assertEqual(result["false_confident_conclusions"]["rate"], 1)
        self.assertEqual(result["abstention"]["precision"], 1)
        self.assertEqual(result["abstention"]["recall"], 0.5)
        self.assertEqual(result["latency_ms"],
                         {"count": 4, "min": 10, "mean": 25, "p50": 20, "p95": 40, "max": 40})
        self.assertEqual(result["cost_usd"],
                         {"known_count": 2, "unknown_count": 2, "sum_known": 0.04,
                          "mean_known": 0.02, "total": None})
        self.assertEqual(result, self.report(rows, jsonl=True)[1])
        self.assertEqual(result, self.report(list(reversed(rows)))[1])

    def test_empty_predictions_have_no_latency_or_known_cost(self):
        code, result = self.report([])
        self.assertEqual(code, 1)
        self.assertEqual(result["accuracy"]["top1_rate"], 0)
        self.assertEqual(result["grounding"]["grounded_decision_rate"], 0)
        self.assertEqual(result["latency_ms"]["count"], 0)
        for key in ("min", "mean", "p50", "p95", "max"):
            self.assertIsNone(result["latency_ms"][key])
        self.assertIsNone(result["cost_usd"]["sum_known"])
        self.assertIsNone(result["cost_usd"]["mean_known"])
        self.assertIsNone(result["false_confident_conclusions"]["rate"])
        self.assertIsNone(result["grounding"]["evidence_validity"])
        self.assertIsNone(result["abstention"]["precision"])

    def test_all_required_evidence_needed_and_distractors_reduce_grounding(self):
        for cited in ([], ["c1"], ["c1", "c2", "noise"]):
            with self.subTest(cited=cited):
                _, result = self.report([
                    prediction("crash", ["worker_crash"], cited, confidence=1),
                ])
                self.assertEqual(result["accuracy"]["top1_rate"], 0.5)
                self.assertEqual(result["grounding"]["grounded_decisions"], 0)
                self.assertEqual(result["false_confident_conclusions"]["count"], 1)
        _, result = self.report([prediction("crash", ["worker_crash"], ["c2", "c1"])])
        self.assertEqual(result["grounding"]["grounded_decisions"], 1)
        self.assertEqual(result["false_confident_conclusions"]["count"], 0)

    def test_false_abstention_does_not_earn_cause_credit(self):
        _, result = self.report([prediction(causes=[], abstained=True)])
        self.assertEqual(result["accuracy"]["top1_rate"], 0)
        self.assertEqual(result["abstention"]["unnecessary_count"], 1)
        self.assertEqual(result["abstention"]["precision"], 0)

    def test_no_answerable_cases_has_undefined_topk(self):
        data = fixture()
        data["cases"] = data["cases"][2:]
        rows = [prediction(c["case_id"], [], c["expected"]["supporting_evidence_ids"],
                           abstained=True, cost_usd=0) for c in data["cases"]]
        code, result = self.report(rows, data=data)
        self.assertEqual(code, 0)
        self.assertIsNone(result["accuracy"]["top1_rate"])
        self.assertIsNone(result["accuracy"]["top3_rate"])
        self.assertEqual(result["abstention"]["recall"], 1)
        self.assertEqual(result["cost_usd"]["total"], 0)

    def test_single_json_object_is_a_prediction(self):
        self.assertEqual(self.report(prediction())[1], self.report([prediction()])[1])

    def test_rejects_duplicate_unknown_and_cross_case_ids(self):
        invalid = [
            [prediction(), prediction()],
            [prediction("unknown")],
            [prediction(causes=["unknown"])],
            [prediction(causes=["queue_delay", "queue_delay"])],
            [prediction(evidence=["unknown"])],
            [prediction(evidence=["q1", "q1"])],
            [prediction(evidence=["c1"])],
        ]
        for rows in invalid:
            with self.subTest(rows=rows):
                result = self.invoke(rows)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertEqual(result.stdout, "")

    def test_rejects_malformed_fields_instead_of_coercing_or_defaulting(self):
        changes = [
            {"abstained": "false"}, {"abstained": 0}, {"confidence": True},
            {"confidence": -0.1}, {"confidence": 1.1}, {"confidence": None},
            {"confidence": float("nan")}, {"confidence": float("inf")},
            {"elapsed_ms": -1}, {"elapsed_ms": True}, {"elapsed_ms": "10"},
            {"elapsed_ms": 86_400_001}, {"cost_usd": -1}, {"cost_usd": "0.01"},
            {"cost_usd": False}, {"cost_usd": float("inf")},
            {"ranked_cause_ids": []}, {"ranked_cause_ids": "queue_delay"},
            {"ranked_cause_ids": ["queue_delay", "worker_crash", "db_auth", "dependency_timeout"]},
            {"abstained": True}, {"cited_evidence_ids": None}, {"extra": "ignored?"},
            {"case_id": None}, {"case_id": " queue"},
        ]
        for change in changes:
            with self.subTest(change=change):
                result = self.invoke([prediction(**change)])
                self.assertEqual(result.returncode, 2, result.stderr)
        for key in prediction():
            row = prediction()
            del row[key]
            with self.subTest(missing=key):
                self.assertEqual(self.invoke([row]).returncode, 2)
        for raw in ('{"case_id":"queue","case_id":"crash"}', '[{}', 'null',
                    '[1]', '{"predictions":[]}', '{}\nnot-json'):
            with self.subTest(raw=raw):
                self.assertEqual(self.invoke([], raw=raw).returncode, 2)

    def test_fixture_validation_rejects_bad_gold_and_oversized_inputs(self):
        invalid = []
        data = fixture()
        data["cases"].append(copy.deepcopy(data["cases"][0]))
        invalid.append(data)
        data = fixture()
        data["causes"].append(copy.deepcopy(data["causes"][0]))
        invalid.append(data)
        for field, value in (("cause_id", "unknown"), ("abstain", True),
                             ("supporting_evidence_ids", ["unknown"]),
                             ("supporting_evidence_ids", []),
                             ("supporting_evidence_ids", ["q1", "q1"])):
            data = fixture()
            data["cases"][0]["expected"][field] = value
            invalid.append(data)
        data = fixture()
        data["cases"][0]["evidence"].append(data["cases"][0]["evidence"][0])
        invalid.append(data)
        data = fixture()
        data["cases"][1]["evidence"][0]["evidence_id"] = "q1"
        invalid.append(data)
        for field, value in (("cases", []), ("synthetic", False), ("schema_version", True)):
            data = fixture()
            data[field] = value
            invalid.append(data)
        data = fixture()
        data["cases"][0]["evidence"][0]["text"] = "x" * 2001
        invalid.append(data)
        for data in invalid:
            with self.subTest(data=data):
                self.assertEqual(self.invoke([], data=data).returncode, 2)
        self.assertEqual(self.invoke([], raw=" " * (1_048_576 + 1)).returncode, 2)

    def test_offline_rejects_live_options_and_missing_files(self):
        for extra in (("--model-id", "model"), ("--run-model",),
                      ("--region", "us-east-1"), ("--predictions-out", "/tmp/unused"),
                      ("--predictions", "/does-not-exist")):
            with self.subTest(extra=extra):
                self.assertEqual(self.invoke([], extra=extra).returncode, 2)

    def test_bundled_synthetic_cases_and_prompt_injection_scoring(self):
        self.assertTrue(FIXTURE.exists(), "the seven synthetic cases must be provided")
        data = json.loads(FIXTURE.read_text())
        self.assertEqual(len(data["cases"]), 7)
        self.assertEqual(sum(c["expected"]["abstain"] for c in data["cases"]), 2)
        code, result = self.report([], data=data)
        self.assertEqual(code, 1)
        self.assertEqual(result["coverage"]["required_cases"], 7)
        # A hand-written answer obeying the injected instruction is penalized.
        _, result = self.report([
            prediction("prompt-injection", ["db_auth"], ["injection-text"], confidence=1),
        ], data=data)
        self.assertEqual(result["accuracy"]["top1_correct"], 0)
        self.assertEqual(result["grounding"]["supporting_citations"], 0)
        self.assertEqual(result["false_confident_conclusions"]["count"], 1)


class BedrockStubberTests(unittest.TestCase):
    def setUp(self):
        try:
            import boto3
            from botocore.stub import Stubber
        except ImportError:
            self.skipTest("optional boto3/botocore unavailable; offline suite still runs")
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(mock.patch(
            "socket.socket.connect", side_effect=AssertionError("network forbidden in tests"),
        ))
        self.client = boto3.client(
            "bedrock-runtime", region_name="us-east-1",
            aws_access_key_id="testing", aws_secret_access_key="testing",
            aws_session_token="testing",
        )
        self.stubber = self.stack.enter_context(Stubber(self.client))
        self.factory = self.stack.enter_context(mock.patch("boto3.client", return_value=self.client))
        directory = self.stack.enter_context(tempfile.TemporaryDirectory())
        self.root = Path(directory)
        self.output = self.root / "predictions.jsonl"

    def params(self, case):
        return {
            "modelId": "test-model",
            "system": [{"text": evaluator.REFERENCE_PROMPT}],
            "messages": [{"role": "user", "content": [{"text": json.dumps({
                "case_id": case["case_id"], "summary": case["summary"],
                "candidate_causes": fixture()["causes"], "evidence": case["evidence"],
            }, sort_keys=True)}]}],
            "inferenceConfig": {"maxTokens": 512, "temperature": 0},
        }

    def response(self, row, stop="end_turn"):
        if isinstance(row, dict):
            row = {key: value for key, value in row.items() if key != "elapsed_ms"}
            row = json.dumps(row)
        return {
            "output": {"message": {"role": "assistant", "content": [{"text": row}]}},
            "stopReason": stop, "usage": {"inputTokens": 100, "outputTokens": 40,
                                        "totalTokens": 140},
            "metrics": {"latencyMs": 99},
        }

    def invoke_live(self, data=None):
        fixtures_path = self.root / "cases.json"
        fixtures_path.write_text(json.dumps(fixture() if data is None else data))
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            code = evaluator.main([
                "--fixtures", str(fixtures_path), "--run-model", "--model-id", "test-model",
                "--region", "us-east-1", "--predictions-out", str(self.output),
            ])
        return code, stdout.getvalue(), stderr.getvalue()

    def test_one_reused_client_no_tools_no_gold_and_unknown_cost(self):
        data = fixture()
        data["cases"] = data["cases"][:2]
        rows = [prediction(), prediction("crash", ["worker_crash"], ["c1", "c2"])]
        for case, row in zip(data["cases"], rows):
            self.stubber.add_response("converse", self.response(row), self.params(case))
        with mock.patch.object(evaluator.time, "perf_counter", side_effect=[1, 1.25, 2, 2.5]):
            code, stdout, stderr = self.invoke_live(data)
        self.assertEqual(code, 0, stderr)
        result = json.loads(stdout)
        self.assertEqual(result["coverage"]["predicted_cases"], 2)
        self.assertEqual(result["cost_usd"]["unknown_count"], 2)
        self.assertIsNone(result["cost_usd"]["total"])
        saved = [json.loads(line) for line in self.output.read_text().splitlines()]
        self.assertEqual([r["elapsed_ms"] for r in saved], [250, 500])
        self.assertTrue(all("cost_usd" not in r for r in saved))
        self.factory.assert_called_once()
        self.assertEqual(self.factory.call_args.args, ("bedrock-runtime",))
        config = self.factory.call_args.kwargs["config"]
        self.assertEqual(config.connect_timeout, 5)
        self.assertEqual(config.read_timeout, 30)
        self.assertEqual(config.retries, {"mode": "standard", "total_max_attempts": 1})
        self.stubber.assert_no_pending_responses()

    def test_service_error_preserves_partial_coverage_without_fabricated_abstention(self):
        data = fixture()
        self.stubber.add_response("converse", self.response(prediction()),
                                 self.params(data["cases"][0]))
        self.stubber.add_client_error(
            "converse", service_error_code="ThrottlingException",
            service_message="DO-NOT-ECHO confidential response", http_status_code=429,
            expected_params=self.params(data["cases"][1]),
        )
        code, stdout, stderr = self.invoke_live()
        self.assertEqual(code, 2)
        self.assertEqual(stdout, "")
        self.assertNotIn("DO-NOT-ECHO", stderr)
        saved = evaluator.read_predictions(self.output)
        self.assertEqual([r["case_id"] for r in saved], ["queue"])
        report = evaluator.evaluate(data, saved)
        self.assertEqual(report["status"], "incomplete")
        self.assertEqual(report["cost_usd"]["unknown_count"], 4)
        self.stubber.assert_no_pending_responses()

    def test_rejects_truncated_malformed_wrong_case_and_tool_responses(self):
        data = fixture()
        data["cases"] = data["cases"][:1]
        responses = [
            self.response(prediction(), "max_tokens"),
            self.response(prediction(), "guardrail_intervened"),
            self.response(prediction("crash")),
            self.response(prediction(evidence=["invented"])),
            self.response(prediction(cost_usd=0)),
            self.response('{"case_id":"queue","case_id":"queue"}'),
            self.response("DO-NOT-ECHO not JSON"),
            self.response("x" * 8193),
            {
                "output": {"message": {"role": "assistant", "content": [{
                    "toolUse": {"toolUseId": "test", "name": "mutate", "input": {}},
                }]}},
                "stopReason": "tool_use",
                "usage": {"inputTokens": 100, "outputTokens": 40, "totalTokens": 140},
                "metrics": {"latencyMs": 99},
            },
        ]
        for response in responses:
            with self.subTest(response=response["stopReason"]):
                self.stubber.add_response("converse", response, self.params(data["cases"][0]))
                code, stdout, stderr = self.invoke_live(data)
                self.assertEqual(code, 2)
                self.assertEqual(stdout, "")
                self.assertNotIn("DO-NOT-ECHO", stderr)
                self.assertEqual(self.output.read_text(), "")
                self.output.unlink()
        self.stubber.assert_no_pending_responses()

    def test_timeout_does_not_become_a_successful_prediction(self):
        from botocore.exceptions import ReadTimeoutError
        # Stubber models service errors; transport timeouts are injected at the SDK boundary.
        with mock.patch.object(self.client, "converse", side_effect=ReadTimeoutError(
            endpoint_url="https://example.invalid",
        )):
            code, stdout, _ = self.invoke_live()
        self.assertEqual(code, 2)
        self.assertEqual(stdout, "")
        self.assertEqual(self.output.read_text(), "")

    def test_preflight_rejects_large_batch_payload_and_existing_output_before_client(self):
        data = fixture()
        data["cases"] = []
        for index in range(9):
            case = copy.deepcopy(fixture()["cases"][0])
            case["case_id"] = f"case-{index}"
            case["evidence"][0]["evidence_id"] = f"e-{index}"
            case["expected"]["supporting_evidence_ids"] = [f"e-{index}"]
            data["cases"].append(case)
        self.assertEqual(self.invoke_live(data)[0], 2)
        data = fixture()
        data["cases"][0]["evidence"] = [
            {"evidence_id": f"e-{i}", "text": "x" * 2000} for i in range(16)
        ]
        data["cases"][0]["expected"]["supporting_evidence_ids"] = ["e-0"]
        self.assertEqual(self.invoke_live(data)[0], 2)
        self.output.write_text("keep existing artifact")
        self.assertEqual(self.invoke_live()[0], 2)
        self.assertEqual(self.output.read_text(), "keep existing artifact")
        self.factory.assert_not_called()


if __name__ == "__main__":
    unittest.main()
