import os
from pathlib import Path
import subprocess
import tempfile
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[2]
FAKE_CLI = r"""#!/usr/bin/python3
import os, pathlib, sys
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
lens = next((x for x in ['L2','L3','L4','L5'] if 'LENS: ' + x in ' '.join(args)), '?')
cell = name + '/' + lens
if sys.stdin.read() != 'diff-data\n':
    sys.exit(7)
if name == 'claude':
    for arg in ['--strict-mcp-config', '--tools', 'Read,Grep,Glob', '--allowedTools', '--setting-sources']:
        if arg not in args:
            sys.exit(8)
elif '-s' not in args or 'read-only' not in args:
    sys.exit(9)
count_path = pathlib.Path(os.environ['CALL_DIR']) / cell.replace('/', '-')
count = int(count_path.read_text()) + 1 if count_path.exists() else 1
count_path.write_text(str(count))
if os.environ.get('FAIL_CELL') in (cell, name + '/*'):
    print('API failure on stdout is NOT a completed review')
    sys.exit(1)
if os.environ.get('FAIL_ONCE') == cell and count == 1:
    print('Transient API failure')
    sys.exit(1)
print('Review ' + cell + ': no blocking findings.')
"""


class PanelTests(unittest.TestCase):
    def run_panel(self, missing=(), missing_lenses=(), expected_returncode=0, **overrides):
        directory = tempfile.TemporaryDirectory(prefix="panel-recovery-")
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        binaries = root / "bin"
        binaries.mkdir()
        for name in ("codex", "claude"):
            if name not in missing:
                exe = binaries / name
                exe.write_text(FAKE_CLI)
                exe.chmod(0o755)
        lenses = root / "lenses"
        lenses.mkdir()
        for lens in ("L2", "L3", "L4", "L5"):
            if lens not in missing_lenses:
                (lenses / f"{lens}.txt").write_text(f"LENS: {lens}\nReview data only.")
        diff = root / "diff"
        diff.write_text("diff-data\n")
        calls = root / "calls"
        calls.mkdir()
        output = root / "output"
        env = {
            **os.environ, "PATH": f"{binaries}:/usr/bin:/bin",
            "PANEL_TIMEOUT": "3", "PANEL_RETRIES": "2",
            "CALL_DIR": str(calls), **overrides,
        }
        process = subprocess.run(
            ["bash", str(ROOT / "scripts/pr-review/run-panel.sh"), str(diff), str(lenses), str(output)],
            env=env, capture_output=True, text=True, timeout=15,
        )
        self.assertEqual(process.returncode, expected_returncode, process.stderr)
        return output, calls

    def test_both_vendors_complete_all_four_lenses(self):
        out, _ = self.run_panel()
        self.assertEqual(set((out / "responded.txt").read_text().splitlines()),
                         {f"{model}/{lens}" for model in ("codex", "claude") for lens in ("L2", "L3", "L4", "L5")})
        self.assertFalse((out / "coverage-severe.flag").exists())

    def test_missing_claude_still_blocks(self):
        out, _ = self.run_panel(missing=("claude",))
        self.assertTrue((out / "coverage-severe.flag").exists())
        self.assertEqual((out / "degraded-models.txt").read_text().strip(), "claude")

    def test_missing_required_lens_stops_before_any_model_runs(self):
        out, calls = self.run_panel(missing_lenses=("L4",), expected_returncode=1)
        self.assertEqual(list(calls.iterdir()), [])
        self.assertEqual((out / "responded.txt").read_text(), "")

    def test_missing_codex_still_blocks(self):
        out, _ = self.run_panel(missing=("codex",))
        self.assertTrue((out / "coverage-severe.flag").exists())

    def test_failed_command_stdout_never_counts_as_a_review(self):
        out, _ = self.run_panel(FAIL_CELL="claude/*")
        self.assertTrue((out / "coverage-severe.flag").exists())
        self.assertNotIn("claude/", (out / "responded.txt").read_text())

    def test_one_lens_missing_one_vendor_still_blocks(self):
        out, _ = self.run_panel(FAIL_CELL="claude/L3")
        self.assertTrue((out / "coverage-severe.flag").exists())
        self.assertIn("L3", (out / "degraded-lenses.txt").read_text())

    def test_transient_failure_retries_without_retaining_failed_output(self):
        out, calls = self.run_panel(FAIL_ONCE="claude/L2")
        self.assertTrue((calls / "claude-L2").exists(), "Claude review was never invoked")
        self.assertEqual((calls / "claude-L2").read_text(), "2")
        self.assertFalse((out / "coverage-severe.flag").exists())
        self.assertNotIn("Transient", (out / "slot/claude-L2.md").read_text())


class LockfileMetadataTests(unittest.TestCase):
    def filter_diff(self, content, paths):
        workflow = (ROOT / ".github/workflows/pr-review.yml").read_text()
        program = workflow.split("          awk '\n", 1)[1].split(
            "\n          ' /tmp/pr-diff-raw.txt", 1)[0]
        program = textwrap.dedent(program)
        with tempfile.TemporaryDirectory(prefix="filter-recovery-") as directory:
            pathmap = Path(directory) / "paths.tsv"
            pathmap.write_text("".join(f"{old}\t{new}\n" for old, new in paths))
            program = program.replace("/tmp/pr-diff-pathmap.tsv", str(pathmap))
            result = subprocess.run(["awk", program], input=content, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def test_changed_lockfile_metadata_survives_content_filter(self):
        diff = (
            "diff --git a/web/package-lock.json b/web/package-lock.json\n"
            "index a..b 100644\n--- a/web/package-lock.json\n+++ b/web/package-lock.json\n"
            "@@ -1 +1 @@\n-generated-lock-before\n+generated-lock-after\n"
            "diff --git a/web/lib/a.ts b/web/lib/a.ts\n@@ -1 +1 @@\n+real-code-change\n"
        )
        output = self.filter_diff(diff, [("web/package-lock.json", "web/package-lock.json"),
                                         ("web/lib/a.ts", "web/lib/a.ts")])
        self.assertIn("+++ b/web/package-lock.json", output)
        self.assertIn("content omitted", output)
        self.assertNotIn("generated-lock-after", output)
        self.assertIn("+real-code-change", output)

    def test_deleted_lockfile_is_not_claimed_to_exist_at_head(self):
        diff = (
            "diff --git a/web/package-lock.json b/web/package-lock.json\n"
            "deleted file mode 100644\n--- a/web/package-lock.json\n+++ /dev/null\n"
            "@@ -1 +0 @@\n-old-lock-data\n"
        )
        output = self.filter_diff(diff, [("web/package-lock.json", "web/package-lock.json")])
        self.assertIn("deleted file mode", output)
        self.assertIn("+++ /dev/null", output)
        self.assertNotIn("old-lock-data", output)

    def test_absent_lockfile_gets_no_fabricated_marker(self):
        output = self.filter_diff(
            "diff --git a/web/package.json b/web/package.json\n@@ -1 +1 @@\n+dependency\n",
            [("web/package.json", "web/package.json")],
        )
        self.assertNotIn("lockfile", output)

    def test_rename_from_lockfile_to_source_preserves_code(self):
        output = self.filter_diff(
            "diff --git a/web/package-lock.json b/web/lib/a.ts\n"
            "rename from web/package-lock.json\nrename to web/lib/a.ts\n@@ -1 +1 @@\n+review-me\n",
            [("web/package-lock.json", "web/lib/a.ts")],
        )
        self.assertIn("+review-me", output)
        self.assertNotIn("content omitted", output)


if __name__ == "__main__":
    unittest.main()
