"""Exercise review data and the blocking verdict locally, without AWS or GitHub."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts/pr-review"))
import claude_scope
from claude_verdict import validate, verify_reads


class ClaudeReviewTests(unittest.TestCase):
    def test_complete_git_scope_and_gate(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            subprocess.run(["git", "init", "-q", tmp], check=True)
            def git(*args):
                return subprocess.check_output(["git", "-C", tmp, "-c", "user.name=Test", "-c",
                                                "user.email=test@example.org", *args], text=True).strip()
            git("commit", "--allow-empty", "-qm", "base")
            base = git("rev-parse", "HEAD")
            for name in ("plain.ts", ":(glob)*.ts", "spaced ü.ts"):
                (root / name).write_text("first line\n" * 9000)
            git("add", ".")
            git("commit", "-qm", "head")
            head = git("rev-parse", "HEAD")
            (root / "scripts").symlink_to(ROOT / "scripts")
            dest = root / "packet"
            (dest / "images").mkdir(parents=True)
            (dest / "images/manifest.json").write_text(json.dumps(
                {"head": head, "merge_base": base, "status": "complete", "schema": 1, "images": [], "deleted": []}))
            previous = Path.cwd()
            try:
                os.chdir(root)
                groups = list(claude_scope.prepare(base, head, dest))
            finally:
                os.chdir(previous)
            self.assertGreater(len(groups), 1)
            paths = set()
            for group in groups:
                directory = dest / str(group["group"])
                index = json.loads((directory / "index.json").read_text())
                events = []
                group_paths = {page["path"] for page in index["pages"]}
                self.assertFalse(group_paths & paths, "one file must stay in one review")
                paths.update(group_paths)
                for page in index["pages"]:
                    path = directory / page["page"]
                    events.extend([
                        {"type": "assistant", "message": {"content": [
                            {"type": "tool_use", "name": "Read", "id": path.name, "input": {"file_path": str(path)}}]}},
                        {"type": "user", "message": {"content": [
                            {"type": "tool_result", "tool_use_id": path.name, "content": path.read_text()}]}},
                    ])
                lenses = {key: {"severity": "NONE", "analysis": "Checked the exact Git changes against the base and found no defect."}
                          for key in ["L2", "L3", "L4", "L5"]}
                result = dict(head=head, complete=True, lenses=lenses, images=[])
                verify_reads(events, directory, index)
                with self.assertRaises(ValueError):
                    verify_reads(events[:-1], directory, index)
                events[-1]["message"]["content"][0]["content"] = "END OF REVIEW PAGE"
                with self.assertRaises(ValueError):
                    verify_reads(events, directory, index)
                self.assertTrue(validate(result, index, head))
                self.assertFalse(validate(dict(result, lenses=dict(lenses, L3=dict(lenses["L3"], severity="MAJOR"))), index, head))
                for change in [dict(lenses=[]), dict(head=base), dict(complete=False), dict(images=["missing.png"]), dict(lenses=dict(lenses, L2={"analysis": "ok", "severity": "NONE"}))]:
                    with self.assertRaises(ValueError):
                        validate(dict(result, **change), index, head)
            self.assertEqual(paths, {"plain.ts", ":(glob)*.ts", "spaced ü.ts"})

    def test_action_uses_bedrock_and_all_results_gate_the_protected_check(self):
        jobs = yaml.safe_load((ROOT / ".github/workflows/pr-review.yml").read_text())["jobs"]
        model = jobs["claude"]
        action = next(step for step in model["steps"] if step.get("uses") == "anthropics/claude-code-action@v1")
        self.assertEqual(action["with"]["use_bedrock"], "true")
        self.assertEqual(model["permissions"]["pull-requests"], "read")
        self.assertIn("ci-review-recovery", model["environment"])
        self.assertNotIn("Bash", action["with"]["claude_args"])
        self.assertIn('--tools "Read"', action["with"]["claude_args"])
        self.assertIn("--strict-mcp-config", action["with"]["claude_args"])
        self.assertIn("--setting-sources user", action["with"]["claude_args"])
        for step in model["steps"]:
            if "run" in step:
                self.assertNotIn("${{", step["run"])
            if step.get("uses", "").startswith("actions/checkout@"):
                self.assertFalse(step["with"]["persist-credentials"])
        self.assertEqual(set(jobs["gate"]["needs"]), {"prepare", "claude"})
        self.assertIn("AI Code Review", jobs["gate"]["name"])


if __name__ == "__main__":
    unittest.main()
