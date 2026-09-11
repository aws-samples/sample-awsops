import json
import os
from pathlib import Path
import re
import signal
import subprocess
import tempfile
import textwrap
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
FAKE_CLI = r"""#!/usr/bin/python3
import os, pathlib, signal, sys, time
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
lens = next((x for x in ['L2','L3','L4','L5'] if 'LENS: ' + x in ' '.join(args)), '?')
cell = name + '/' + lens
if sys.stdin.read() != 'diff-data\n':
    sys.exit(7)
if f'LENS: {lens}\nReview data only.' not in args:
    sys.exit(10)
if name == 'claude':
    for arg in ['--strict-mcp-config', '--tools', 'Read,Grep,Glob', '--allowedTools', '--setting-sources']:
        if arg not in args:
            sys.exit(8)
elif '-s' not in args or 'read-only' not in args:
    sys.exit(9)
count_path = pathlib.Path(os.environ['CALL_DIR']) / cell.replace('/', '-')
count = int(count_path.read_text()) + 1 if count_path.exists() else 1
count_path.write_text(str(count))
if os.environ.get('HANG_CELL') == cell:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    time.sleep(4)
    (pathlib.Path(os.environ['CALL_DIR']) / 'survived-timeout').write_text('late work')
if os.environ.get('FAIL_CELL') in (cell, name + '/*'):
    print('API failure on stdout is NOT a completed review')
    sys.exit(1)
if os.environ.get('FAIL_ONCE') == cell and count == 1:
    print('Transient API failure')
    sys.exit(1)
print('Review ' + cell + ': no blocking findings.')
"""

RECORDING_TIMEOUT = r"""#!/usr/bin/python3
import json, os, pathlib, sys
args = sys.argv[1:]
vendor = next(name for name in ('codex', 'claude') if name in args)
lens = next((name for name in ('L2', 'L3', 'L4', 'L5') if 'LENS: ' + name in ' '.join(args)), None)
label = vendor + '-' + lens if lens else os.environ['ANTHROPIC_MODEL']
path = pathlib.Path(os.environ['CALL_DIR']) / (label + '.timeouts')
with path.open('a') as stream:
    stream.write(json.dumps(args[:args.index(vendor)]) + '\n')
os.execv('/usr/bin/timeout', ['/usr/bin/timeout', *args])
"""


class PanelTests(unittest.TestCase):
    def run_panel(self, missing=(), missing_lenses=(), expected_returncode=0, **overrides):
        directory = tempfile.TemporaryDirectory(prefix="panel-recovery-")
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        binaries = root / "bin"
        binaries.mkdir()
        recorder = binaries / "timeout"
        recorder.write_text(RECORDING_TIMEOUT)
        recorder.chmod(0o755)
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
            "PANEL_TIMEOUT": "3", "CLAUDE_PANEL_TIMEOUT": "3", "PANEL_RETRIES": "2",
            "CLAUDE_PANEL_L2_TIMEOUT": "",
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

    def test_claude_l2_timeout_inherits_general_claude_budget_when_unset(self):
        out, calls = self.run_panel(PANEL_TIMEOUT="4", CLAUDE_PANEL_TIMEOUT="5")
        for vendor in ("codex", "claude"):
            for lens in ("L2", "L3", "L4", "L5"):
                with self.subTest(vendor=vendor, lens=lens):
                    invocations = (calls / f"{vendor}-{lens}.timeouts").read_text().splitlines()
                    self.assertEqual(len(invocations), 1)
                    self.assertEqual(json.loads(invocations[0])[-1], "4" if vendor == "codex" else "5")
        self.assertEqual(len((out / "responded.txt").read_text().splitlines()), 8)
        self.assertFalse((out / "coverage-severe.flag").exists())

    def test_claude_l2_timeout_override_changes_only_that_cell(self):
        out, calls = self.run_panel(
            PANEL_TIMEOUT="4", CLAUDE_PANEL_TIMEOUT="5", CLAUDE_PANEL_L2_TIMEOUT="7",
        )
        for vendor in ("codex", "claude"):
            for lens in ("L2", "L3", "L4", "L5"):
                with self.subTest(vendor=vendor, lens=lens):
                    invocations = (calls / f"{vendor}-{lens}.timeouts").read_text().splitlines()
                    self.assertEqual(len(invocations), 1)
                    expected = "4" if vendor == "codex" else "7" if lens == "L2" else "5"
                    self.assertEqual(json.loads(invocations[0])[-1], expected)
        self.assertEqual(len((out / "responded.txt").read_text().splitlines()), 8)
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

    def test_timeout_kills_a_cell_that_ignores_termination(self):
        out, calls = self.run_panel(
            HANG_CELL="claude/L2", PANEL_TIMEOUT="1", CLAUDE_PANEL_TIMEOUT="1",
            PANEL_KILL_AFTER="1s", PANEL_RETRIES="1",
        )
        self.assertTrue((out / "coverage-severe.flag").exists())
        self.assertFalse((calls / "survived-timeout").exists())

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

    def test_l2_override_is_retained_on_retry_without_counting_failed_stdout(self):
        out, calls = self.run_panel(FAIL_ONCE="claude/L2", CLAUDE_PANEL_L2_TIMEOUT="7")
        invocations = (calls / "claude-L2.timeouts").read_text().splitlines()
        self.assertEqual([json.loads(call)[-1] for call in invocations], ["7", "7"])
        self.assertEqual((calls / "claude-L2").read_text(), "2")
        self.assertEqual(len((out / "responded.txt").read_text().splitlines()), 8)
        self.assertFalse((out / "coverage-severe.flag").exists())
        self.assertNotIn("Transient", (out / "slot/claude-L2.md").read_text())

    def test_l2_override_does_not_weaken_missing_cell_failure(self):
        out, calls = self.run_panel(FAIL_CELL="claude/L2", CLAUDE_PANEL_L2_TIMEOUT="7")
        self.assertEqual((calls / "claude-L2").read_text(), "2")
        self.assertEqual(len((out / "responded.txt").read_text().splitlines()), 7)
        self.assertNotIn("claude/L2", (out / "responded.txt").read_text())
        self.assertEqual((out / "slot/claude-L2.md").read_text(), "")
        self.assertIn("L2", (out / "degraded-lenses.txt").read_text().splitlines())
        self.assertTrue((out / "coverage-severe.flag").exists())


FAKE_CHAIR = r"""#!/usr/bin/python3
import json, os, pathlib, signal, sys, time
data = sys.stdin.read()
if '=== DIFF UNDER REVIEW ===' not in data or '=== PANEL REVIEWS ===' not in data:
    sys.exit(7)
if '--strict-mcp-config' not in sys.argv or '--allowedTools' not in sys.argv:
    sys.exit(8)
calls = pathlib.Path(os.environ['CALL_DIR'])
model = os.environ['ANTHROPIC_MODEL']
count_file = calls / (model + '.count')
count = int(count_file.read_text()) + 1 if count_file.exists() else 1
count_file.write_text(str(count))
actions = json.loads(os.environ['CHAIR_RESPONSES'])[model]
action = actions[min(count - 1, len(actions) - 1)]
with (calls / 'sequence').open('a') as stream:
    stream.write(model + ':' + action + '\n')
(calls / 'active.pid').write_text(str(os.getpid()))
(calls / (model + '.pid')).write_text(str(os.getpid()))
if action in ('hang', 'hang_verdict'):
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
if action in ('hang_verdict', 'failed_verdict'):
    print('Review complete.\nVERDICT: PASS', flush=True)
if action == 'failed_verdict':
    sys.exit(17)
if action == 'wait':
    def terminate(signum, frame):
        (calls / 'terminated').write_text('TERM received')
        sys.exit(0)
    signal.signal(signal.SIGTERM, terminate)
if action in ('hang', 'hang_verdict', 'wait'):
    (calls / 'ready').write_text('ready')
    time.sleep(30)
    (calls / 'survived-timeout').write_text('late work')
if action == 'invalid':
    print('Incomplete review, no verdict.')
    sys.exit(1)
print('Review complete.')
print('VERDICT: ' + ('FAIL' if action == 'finding' else 'PASS'))
"""

FAKE_CHAIR_CLOCK = r"""#!/usr/bin/python3
import os, pathlib, sys
if sys.argv[1:] != ['+%s']:
    os.execv('/bin/date', ['/bin/date', *sys.argv[1:]])
counter = pathlib.Path(os.environ['CALL_DIR']) / 'clock'
tick = int(counter.read_text()) if counter.exists() else 0
counter.write_text(str(tick + 1))
print(tick * int(os.environ['CHAIR_CLOCK_STEP']))
"""


class ChairTests(unittest.TestCase):
    def start_chair(self, primary, fallback=("valid",), clock_step=1, **overrides):
        directory = tempfile.TemporaryDirectory(prefix="chair-recovery-")
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        binaries = root / "bin"
        binaries.mkdir()
        for name, source in (
            ("claude", FAKE_CHAIR), ("date", FAKE_CHAIR_CLOCK), ("timeout", RECORDING_TIMEOUT),
        ):
            executable = binaries / name
            executable.write_text(source)
            executable.chmod(0o755)
        calls = root / "calls"
        calls.mkdir()
        work = root / "work"
        slots = work / "slot"
        slots.mkdir(parents=True)
        cells = [f"{vendor}/{lens}" for vendor in ("codex", "claude") for lens in ("L2", "L3", "L4", "L5")]
        (work / "responded.txt").write_text("\n".join(cells) + "\n")
        for cell in cells:
            (slots / (cell.replace("/", "-") + ".md")).write_text("No blocking findings.\n")
        diff = root / "diff"
        diff.write_text("diff --git a/example.ts b/example.ts\n+readOnly()\n")
        env = {
            **os.environ, "PATH": f"{binaries}:/usr/bin:/bin", "CALL_DIR": str(calls),
            "CHAIR_PRIMARY_MODEL": "primary-fixture", "CHAIR_FALLBACK_MODEL": "fallback-fixture",
            "CHAIR_TIMEOUT": "1s", "CHAIR_KILL_AFTER": "1s",
            "CHAIR_CLOCK_STEP": str(clock_step),
            "CHAIR_RESPONSES": json.dumps({"primary-fixture": primary, "fallback-fixture": fallback}),
            "GITHUB_ENV": str(root / "github-env"),
            "omitted_source_paths": "", **overrides,
        }
        process = subprocess.Popen(
            ["bash", str(ROOT / "scripts/pr-review/synthesize.sh"),
             str(diff), str(work), "42", "CI timeout fixture", str(work / "review.md")],
            env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            start_new_session=True,
        )
        self.addCleanup(self.stop_chair, process, root)
        return root, process

    @staticmethod
    def stop_chair(process, root):
        # GNU timeout may give the CLI its own process group. Clean up that
        # specific fixture child too, without a machine-wide pkill.
        marker = root / "calls/active.pid"
        if marker.exists():
            pid = int(marker.read_text())
            try:
                command = Path(f"/proc/{pid}/cmdline").read_bytes()
                if str(root).encode() in command:
                    os.kill(pid, signal.SIGKILL)
            except (FileNotFoundError, ProcessLookupError):
                pass
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
        process.communicate(timeout=3)

    def finish_chair(self, process, expected_status=0):
        try:
            stdout, stderr = process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            self.fail("chair did not finish within the fixture deadline; hard-kill/cleanup failed")
        self.assertEqual(process.returncode, expected_status, stdout + stderr)

    def sequence(self, root):
        return (root / "calls/sequence").read_text().splitlines()

    def test_chair_default_hard_kill_grace_is_passed_to_real_timeout(self):
        root, process = self.start_chair(("valid",), CHAIR_KILL_AFTER="")
        self.finish_chair(process)
        options = json.loads((root / "calls/primary-fixture.timeouts").read_text().splitlines()[0])
        self.assertIn("--kill-after=10s", options)

    def test_chair_hard_kills_ignored_term_and_falls_back_without_slow_retry(self):
        root, process = self.start_chair(("hang_verdict",), clock_step=900)
        self.finish_chair(process)
        self.assertEqual(self.sequence(root), ["primary-fixture:hang_verdict", "fallback-fixture:valid"])
        pid = int((root / "calls/primary-fixture.pid").read_text())
        try:
            command = Path(f"/proc/{pid}/cmdline").read_bytes()
        except FileNotFoundError:
            command = b""
        self.assertNotIn(str(root).encode(), command, "TERM-ignoring chair is still running")
        self.assertFalse((root / "calls/survived-timeout").exists())
        self.assertFalse((root / "work/chair-failed.flag").exists())
        self.assertTrue((root / "work/review.md").read_text().rstrip().endswith("VERDICT: PASS"))

    def test_nonzero_exit_cannot_supply_a_valid_looking_verdict(self):
        root, process = self.start_chair(("failed_verdict",))
        self.finish_chair(process)
        self.assertEqual(self.sequence(root), [
            "primary-fixture:failed_verdict", "primary-fixture:failed_verdict",
            "fallback-fixture:valid",
        ])
        self.assertFalse((root / "work/chair-failed.flag").exists())

    def test_chair_retries_each_fast_failure_once_then_fails_closed(self):
        root, process = self.start_chair(("invalid",), ("invalid",), clock_step=119)
        self.finish_chair(process)
        self.assertEqual(self.sequence(root), [
            "primary-fixture:invalid", "primary-fixture:invalid",
            "fallback-fixture:invalid", "fallback-fixture:invalid",
        ])
        self.assertTrue((root / "work/chair-failed.flag").exists())
        self.assertTrue((root / "work/review.md").read_text().rstrip().endswith("VERDICT: FAIL"))

    def test_chair_does_not_retry_at_fast_failure_boundary(self):
        root, process = self.start_chair(("invalid",), clock_step=120)
        self.finish_chair(process)
        self.assertEqual(self.sequence(root), ["primary-fixture:invalid", "fallback-fixture:valid"])

    def test_valid_blocking_verdict_is_not_retried_or_replaced(self):
        root, process = self.start_chair(("finding",))
        self.finish_chair(process)
        self.assertEqual(self.sequence(root), ["primary-fixture:finding"])
        self.assertFalse((root / "work/chair-failed.flag").exists())
        self.assertTrue((root / "work/review.md").read_text().rstrip().endswith("VERDICT: FAIL"))

    def test_cancellation_terminates_chair_without_starting_fallback(self):
        root, process = self.start_chair(("wait",), CHAIR_TIMEOUT="10s")
        deadline = time.monotonic() + 3
        while not (root / "calls/ready").exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertTrue((root / "calls/ready").exists(), "fixture chair did not start")
        process.send_signal(signal.SIGTERM)
        self.finish_chair(process, expected_status=143)
        self.assertEqual(self.sequence(root), ["primary-fixture:wait"])
        self.assertTrue((root / "calls/terminated").exists())
        self.assertFalse((root / "calls/survived-timeout").exists())


class WorkflowBudgetTests(unittest.TestCase):
    def setUp(self):
        self.workflow = (ROOT / ".github/workflows/pr-review.yml").read_text()
        starts = list(re.finditer(r"(?m)^      - .+$", self.workflow))
        self.steps = [
            self.workflow[start.start():starts[index + 1].start() if index + 1 < len(starts) else None]
            for index, start in enumerate(starts)
        ]

    def step(self, identifier):
        matches = [
            (index, block) for index, block in enumerate(self.steps)
            if re.search(r"(?m)^\s*(?:- )?id:\s*" + re.escape(identifier) + r"\s*$", block)
        ]
        self.assertEqual(len(matches), 1, f"expected one workflow step with id {identifier}")
        return matches[0]

    def field(self, block, name):
        match = re.search(r"(?m)^\s*(?:- )?" + re.escape(name) + r":\s*([^\n#]+)", block)
        self.assertIsNotNone(match, f"missing workflow field {name}")
        return match.group(1).strip().strip("'\"")

    def test_credentials_are_renewed_between_panel_and_chair_with_same_role(self):
        panel_index, _ = self.step("panel_review")
        renewal_index, renewal = self.step("chair_credentials")
        chair_index, _ = self.step("chair_review")
        self.assertLess(panel_index, renewal_index)
        self.assertLess(renewal_index, chair_index)
        self.assertRegex(self.field(renewal, "uses"), r"^aws-actions/configure-aws-credentials@")
        initial = [
            block for block in self.steps[:panel_index]
            if "uses: aws-actions/configure-aws-credentials@" in block
        ]
        self.assertEqual(len(initial), 1, "the panel must receive credentials before it starts")
        for key in ("role-to-assume", "aws-region", "mask-aws-account-id", "role-duration-seconds"):
            self.assertEqual(self.field(renewal, key), self.field(initial[0], key))
        self.assertEqual(self.field(renewal, "role-duration-seconds"), "3600")
        self.assertEqual(self.field(renewal, "unset-current-credentials"), "true")
        self.assertEqual(self.field(renewal, "use-existing-credentials"), "false")
        self.assertNotRegex(renewal, r"continue-on-error:\s*true")

    def test_each_review_phase_uses_pinned_base_worktree_and_cleanup(self):
        for identifier, script in (("panel_review", "run-panel.sh"), ("chair_review", "synthesize.sh")):
            with self.subTest(phase=identifier):
                _, block = self.step(identifier)
                self.assertIn("steps.review_context.outputs.base_sha", block)
                self.assertRegex(block, r'git worktree add --detach[^\n]*"\$BASE_SHA"')
                self.assertRegex(block, r"trap '[^\n]*worktree remove[^\n]*' EXIT")
                self.assertIn(script, block)

    def test_workflow_budget_keeps_cleanup_margin_after_all_model_attempts(self):
        _, panel = self.step("panel_review")
        # Independently checked contract: eight parallel cells, two attempts; the
        # primary and fallback chairs can each fast-fail once before a 900s retry.
        self.assertEqual(int(self.field(panel, "CLAUDE_PANEL_L2_TIMEOUT")), 1200)
        self.assertEqual(int(self.field(panel, "CLAUDE_PANEL_TIMEOUT")), 600)
        self.assertEqual(int(self.field(panel, "PANEL_TIMEOUT")), 300)
        longest_panel = 2 * (1200 + 10)
        longest_chair = 2 * (120 + 900 + 10)
        job_timeout = re.search(r"(?m)^    timeout-minutes:\s*(\d+)\s*$", self.workflow)
        self.assertIsNotNone(job_timeout)
        self.assertGreaterEqual(
            int(job_timeout.group(1)) * 60 - longest_panel - longest_chair,
            15 * 60,
            "job must leave at least fifteen minutes for setup, publication and cleanup",
        )


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
