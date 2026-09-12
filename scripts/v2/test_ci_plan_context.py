"""Saved-plan apply must use successful, current, same-stack trusted CI."""
import copy
import json
from pathlib import Path
import subprocess
import sys
import unittest


SCRIPT = Path(__file__).with_name("ci_plan_context.py")
SHA = "a" * 40
RUN = {
    "path": ".github/workflows/terraform.yml",
    "event": "workflow_dispatch",
    "status": "completed",
    "conclusion": "success",
    "head_branch": "dev",
    "head_sha": SHA,
    "repository": {"full_name": "example/awsops"},
    "head_repository": {"full_name": "example/awsops"},
}


class SavedPlanContextTests(unittest.TestCase):
    def invoke(self, data, branch="dev", commit=SHA):
        return subprocess.run(
            [
                sys.executable, str(SCRIPT), "--repository", "example/awsops",
                "--branch", branch, "--commit", commit,
            ],
            input=json.dumps(data), text=True, capture_output=True,
        )

    def test_accepts_successful_current_branch_plan(self):
        for event in ("workflow_dispatch",):
            with self.subTest(event=event):
                data = {**RUN, "event": event}
                result = self.invoke(data)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(SHA, result.stdout)

    def test_rejects_foreign_or_pr_workflow_runs(self):
        cases = [
            ("event", "push", "event"),
            ("path", ".github/workflows/deploy-web.yml", "workflow"),
            ("event", "pull_request", "event"),
            ("event", "pull_request_target", "event"),
            ("repository", {"full_name": "foreign/awsops"}, "repository"),
            ("head_repository", {"full_name": "foreign/awsops"}, "repository"),
        ]
        for field, value, reason in cases:
            with self.subTest(field=field, value=value):
                data = copy.deepcopy(RUN)
                data[field] = value
                result = self.invoke(data)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(reason, result.stderr)

    def test_rejects_wrong_stack_stale_or_unfinished_plan(self):
        cases = [
            ("head_branch", "main", "branch"),
            ("head_sha", "b" * 40, "commit"),
            ("status", "in_progress", "complete"),
            ("conclusion", "failure", "successful"),
            ("conclusion", "cancelled", "successful"),
        ]
        for field, value, reason in cases:
            with self.subTest(field=field):
                result = self.invoke({**RUN, field: value})
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(reason, result.stderr)

    def test_rejects_unknown_deployment_branch(self):
        result = self.invoke({**RUN, "head_branch": "feature/pr"}, branch="feature/pr")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("branch", result.stderr)

    def test_rejects_missing_metadata_and_malformed_sha(self):
        result = self.invoke({})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("workflow", result.stderr)
        result = self.invoke(RUN, commit="dev")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("commit", result.stderr)


if __name__ == "__main__":
    unittest.main()
