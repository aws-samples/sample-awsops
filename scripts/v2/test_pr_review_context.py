"""Recovery dispatch must review the explicitly selected PR commit, with safe metadata."""
import copy
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
HEAD = "a" * 40
BASE = "b" * 40
PR = {
    "number": 42, "state": "open", "title": "Review recovery",
    "head": {"sha": HEAD, "repo": {"full_name": "example/repo"}},
    "base": {"sha": BASE, "ref": "dev", "repo": {"full_name": "example/repo"}},
}


class ReviewContextTests(unittest.TestCase):
    def run_context(self, event="pull_request_target", pr=None, **overrides):
        with tempfile.TemporaryDirectory(prefix="review-context-") as directory:
            root = Path(directory)
            payload = pr if pr is not None else copy.deepcopy(PR)
            (root / "event.json").write_text(json.dumps({"pull_request": payload}))
            (root / "pr.json").write_text(json.dumps(payload))
            fake = root / "gh"
            fake.write_text(
                "#!/usr/bin/python3\nimport os,pathlib,sys\n"
                "assert sys.argv[1:] == ['api','repos/example/repo/pulls/42']\n"
                "print(pathlib.Path(os.environ['TEST_PR_JSON']).read_text())\n"
            )
            fake.chmod(0o755)
            env = {
                **os.environ, "PATH": f"{root}:/usr/bin:/bin",
                "GITHUB_EVENT_NAME": event, "GITHUB_REPOSITORY": "example/repo",
                "GITHUB_EVENT_PATH": str(root / "event.json"),
                "GITHUB_SHA": HEAD if event == "workflow_dispatch" else BASE,
                "PR_NUMBER_INPUT": "42", "EXPECTED_HEAD_INPUT": HEAD,
                "TEST_PR_JSON": str(root / "pr.json"), **overrides,
            }
            return subprocess.run(
                ["python3", str(ROOT / "scripts/pr-review/review_context.py")],
                env=env, text=True, capture_output=True, timeout=5,
            )

    def test_automatic_review_uses_immutable_event_head_and_base(self):
        result = self.run_context()
        self.assertEqual(result.returncode, 0, result.stderr)
        outputs = dict(line.split("=", 1) for line in result.stdout.splitlines())
        self.assertEqual(outputs["head_sha"], HEAD)
        self.assertEqual(outputs["base_sha"], BASE)
        self.assertEqual(outputs["number"], "42")

    def test_explicit_recovery_dispatch_reviews_its_own_selected_commit(self):
        result = self.run_context(event="workflow_dispatch")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"head_sha={HEAD}", result.stdout)

    def test_recovery_ref_must_match_pr_head(self):
        result = self.run_context(event="workflow_dispatch", GITHUB_SHA="c" * 40)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")

    def test_recovery_refuses_head_that_moved_after_operator_selection(self):
        result = self.run_context(event="workflow_dispatch", EXPECTED_HEAD_INPUT="c" * 40)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")

    def test_recovery_requires_explicit_sha_and_valid_pr_number(self):
        for overrides in ({"EXPECTED_HEAD_INPUT": ""}, {"PR_NUMBER_INPUT": "42/../43"},
                          {"EXPECTED_HEAD_INPUT": "a\nother_output=1"}):
            with self.subTest(overrides=overrides):
                result = self.run_context(event="workflow_dispatch", **overrides)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, "")

    def test_fork_or_foreign_base_is_rejected(self):
        for side in ("head", "base"):
            with self.subTest(side=side):
                pr = copy.deepcopy(PR)
                pr[side]["repo"]["full_name"] = "someone/else"
                self.assertNotEqual(self.run_context(pr=pr).returncode, 0)

    def test_recovery_only_targets_the_integration_branches(self):
        pr = copy.deepcopy(PR)
        pr["base"]["ref"] = "unreviewed-topic"
        self.assertNotEqual(self.run_context(event="workflow_dispatch", pr=pr).returncode, 0)

    def test_closed_pr_and_malformed_sha_are_rejected(self):
        for field in ("state", "sha"):
            with self.subTest(field=field):
                pr = copy.deepcopy(PR)
                if field == "state":
                    pr["state"] = "closed"
                else:
                    pr["base"]["sha"] = "bad"
                self.assertNotEqual(self.run_context(pr=pr).returncode, 0)

    def test_api_response_must_match_requested_pr_number(self):
        pr = copy.deepcopy(PR)
        pr["number"] = 43
        self.assertNotEqual(self.run_context(event="workflow_dispatch", pr=pr).returncode, 0)

    def test_title_cannot_inject_workflow_output_lines(self):
        pr = copy.deepcopy(PR)
        pr["title"] = 'test\nhead_sha=fake\n"quoted"'
        result = self.run_context(pr=pr)
        self.assertEqual(result.returncode, 0, result.stderr)
        outputs = dict(line.split("=", 1) for line in result.stdout.splitlines())
        self.assertEqual(outputs["head_sha"], HEAD)
        self.assertEqual(json.loads(outputs["title_json"]), pr["title"])

    def test_push_event_cannot_start_privileged_review(self):
        self.assertNotEqual(self.run_context(event="push").returncode, 0)


if __name__ == "__main__":
    unittest.main()
