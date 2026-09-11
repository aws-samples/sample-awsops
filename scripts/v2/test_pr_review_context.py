"""Recovery labels pin the reviewed commit; automatic CI code comes from the default ref."""
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
    def run_context(self, event="pull_request_target", pr=None, label=None, action="labeled", api_pr=None, **overrides):
        with tempfile.TemporaryDirectory(prefix="review-context-") as directory:
            root = Path(directory)
            payload = pr if pr is not None else copy.deepcopy(PR)
            label = label if label is not None else f"ci-review:{payload['head']['sha']}"
            (root / "event.json").write_text(json.dumps(
                {"pull_request": payload, "label": {"name": label}, "action": action}))
            (root / "pr.json").write_text(json.dumps(api_pr if api_pr is not None else payload))
            fake = root / "gh"
            fake.write_text(
                "#!/usr/bin/python3\nimport os,pathlib,sys\n"
                "assert sys.argv[1:] == ['api','repos/example/repo/pulls/42']\n"
                "print(pathlib.Path(os.environ['TEST_PR_JSON']).read_text())\n"
            )
            fake.chmod(0o755)
            fake_git = root / "git"
            fake_git.write_text(
                "#!/usr/bin/python3\nimport os,sys\n"
                "assert sys.argv[1:] == ['rev-parse','HEAD']\n"
                "print(os.environ['TEST_CHECKOUT_SHA'])\n"
            )
            fake_git.chmod(0o755)
            env = {
                **os.environ, "PATH": f"{root}:/usr/bin:/bin",
                "GITHUB_EVENT_NAME": event, "GITHUB_REPOSITORY": "example/repo",
                "GITHUB_EVENT_PATH": str(root / "event.json"),
                "GITHUB_SHA": "c" * 40 if event == "pull_request" else BASE,
                "TEST_PR_JSON": str(root / "pr.json"), **overrides,
            }
            env.setdefault("TEST_CHECKOUT_SHA", payload["head"]["sha"] if event == "pull_request" else env["GITHUB_SHA"])
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

    def test_automatic_workflow_sha_may_differ_from_target_base_sha(self):
        result = self.run_context(GITHUB_SHA="d" * 40)
        self.assertEqual(result.returncode, 0, result.stderr)
        outputs = dict(line.split("=", 1) for line in result.stdout.splitlines())
        self.assertEqual(outputs["base_sha"], BASE)

    def test_explicit_recovery_label_reviews_its_selected_commit(self):
        result = self.run_context(event="pull_request")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"head_sha={HEAD}", result.stdout)

    def test_recovery_ref_must_match_pr_head(self):
        result = self.run_context(event="pull_request", TEST_CHECKOUT_SHA="d" * 40)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")

    def test_recovery_refuses_head_that_moved_after_operator_selection(self):
        api_pr = copy.deepcopy(PR)
        api_pr["head"]["sha"] = "d" * 40
        result = self.run_context(event="pull_request", api_pr=api_pr)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")

    def test_recovery_requires_explicit_matching_sha_label(self):
        for label in ("", "ci-review:", "ci-review:" + "d" * 40, "ci-review:" + HEAD + "\ninjected=1"):
            with self.subTest(label=label):
                result = self.run_context(event="pull_request", label=label)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, "")

    def test_recovery_requires_the_labeling_action(self):
        self.assertNotEqual(self.run_context(event="pull_request", action="synchronize").returncode, 0)

    def test_fork_or_foreign_base_is_rejected(self):
        for side in ("head", "base"):
            with self.subTest(side=side):
                pr = copy.deepcopy(PR)
                pr[side]["repo"]["full_name"] = "someone/else"
                self.assertNotEqual(self.run_context(pr=pr).returncode, 0)

    def test_recovery_only_targets_the_integration_branches(self):
        pr = copy.deepcopy(PR)
        pr["base"]["ref"] = "unreviewed-topic"
        self.assertNotEqual(self.run_context(event="pull_request", pr=pr).returncode, 0)

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
        self.assertNotEqual(self.run_context(event="pull_request", api_pr=pr).returncode, 0)

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
