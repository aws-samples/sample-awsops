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
from claude_verdict import validate


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
                {"status": "complete", "schema": 1, "images": [], "deleted": []}))
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
                receipts = []
                for page in index["pages"]:
                    paths.add(page["path"])
                    receipts.append((directory / page["page"]).read_text().split()[-1])
                result = dict(head=head, complete=True, severity="NONE", summary="No findings.", receipts=receipts, images=[])
                self.assertTrue(validate(result, index, head, group["digest"]))
                self.assertFalse(validate(dict(result, severity="MAJOR"), index, head, group["digest"]))
                for change in [dict(receipts=[]), dict(head=base), dict(complete=False), dict(images=["missing.png"]), dict(severity=None)]:
                    with self.assertRaises(ValueError):
                        validate(dict(result, **change), index, head, group["digest"])
            self.assertEqual(paths, {"plain.ts", ":(glob)*.ts", "spaced ü.ts"})

    def test_action_uses_bedrock_and_all_results_gate_the_protected_check(self):
        jobs = yaml.safe_load((ROOT / ".github/workflows/pr-review.yml").read_text())["jobs"]
        model = jobs["claude"]
        action = next(step for step in model["steps"] if step.get("uses") == "anthropics/claude-code-action@v1")
        self.assertEqual(action["with"]["use_bedrock"], "true")
        self.assertEqual(model["permissions"]["pull-requests"], "read")
        self.assertIn("ci-review-recovery", model["environment"])
        self.assertEqual(set(jobs["gate"]["needs"]), {"prepare", "claude"})
        self.assertIn("AI Code Review", jobs["gate"]["name"])


if __name__ == "__main__":
    unittest.main()
