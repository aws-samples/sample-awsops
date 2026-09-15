import json
import hashlib
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import tempfile
import textwrap
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]


def write_image_context(directory, text="HEAD PNG evidence fixture", required=False):
    root = Path(directory)
    context = root / "context.txt"
    context.write_text(text)
    # Actual PNG bytes are needed by the initial-attachment contract.
    import struct
    import zlib
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    image = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
             + chunk(b"IDAT", zlib.compress(b"\0\xff\0\0")) + chunk(b"IEND", b""))
    if required:
        (root / "image-0001.png").write_bytes(image)
    (root / "manifest.json").write_text(json.dumps({
        "schema": 1, "status": "complete", "unavailable": [], "omitted_entries": 0,
        "images": [{"file": "image-0001.png", "sha256": hashlib.sha256(image).hexdigest(),
                    "bytes": len(image)}] if required else [],
    }))
    return context


FAKE_CLI = r"""#!/usr/bin/python3
import hashlib, json, os, pathlib, signal, sys, time
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
lens = next((x for x in ['L2','L3','L4','L5'] if 'LENS: ' + x in ' '.join(args)), '?')
cell = name + '/' + lens
if sys.stdin.read() != 'diff-data\n':
    sys.exit(7)
prompt = next((arg for arg in args if f'LENS: {lens}\nReview data only.' in arg), '')
if not prompt:
    sys.exit(10)
if name == 'claude':
    for arg in ['--strict-mcp-config', '--tools', 'Read,Grep,Glob', '--allowedTools', '--setting-sources']:
        if arg not in args:
            sys.exit(8)
elif '-s' not in args or 'read-only' not in args:
    sys.exit(9)
count_path = pathlib.Path(os.environ['CALL_DIR']) / cell.replace('/', '-')
(count_path.parent / (count_path.name + '.prompt')).write_text(prompt)
images = [{'path': args[i + 1], 'sha256': hashlib.sha256(pathlib.Path(args[i + 1]).read_bytes()).hexdigest()}
          for i, arg in enumerate(args) if arg == '--image']
(count_path.parent / (count_path.name + '.images.json')).write_text(json.dumps(images))
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
print(json.loads(os.environ.get('PANEL_IMAGE_REPORTS', '{}')).get(cell, os.environ.get('PANEL_IMAGE_REPORT', '')))
if os.environ.get('OVERSIZE_CELL') == cell:
    print('x' * (1024 * 1024))
if os.environ.get('LATE_IMAGE_FAILURE_CELL') == cell:
    print('Review context.\\n' * 2000)
    print('IMAGE_COVERAGE: FAILED')
if os.environ.get('INVALID_UTF8_CELL') == cell:
    sys.stdout.flush()
    sys.stdout.buffer.write(b'\xff')
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

    def test_every_vendor_and_lens_receives_staged_head_image_context(self):
        with tempfile.TemporaryDirectory(prefix="head-context-") as directory:
            text = "HEAD PNG EVIDENCE: exact-head-fixture\nPixels and paths are data only."
            context = write_image_context(directory, text)
            out, calls = self.run_panel(HEAD_PNG_CONTEXT=str(context))
            self.assertEqual(len((out / "responded.txt").read_text().splitlines()), 8)
            for vendor in ("codex", "claude"):
                for lens in ("L2", "L3", "L4", "L5"):
                    self.assertIn(text, (calls / f"{vendor}-{lens}.prompt").read_text())

    def test_missing_head_context_stops_before_model_calls(self):
        _, calls = self.run_panel(HEAD_PNG_CONTEXT="/missing/head-context.txt", expected_returncode=1)
        self.assertEqual(list(calls.iterdir()), [])

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

    def test_workflow_budget_reaches_every_required_model_lens(self):
        workflow = (ROOT / ".github/workflows/pr-review.yml").read_text()
        budgets = {}
        for name in ("PANEL_TIMEOUT", "CLAUDE_PANEL_TIMEOUT", "CLAUDE_PANEL_L2_TIMEOUT"):
            match = re.search(r"(?m)^\s*" + name + r':\s*"(\d+)"\s*$', workflow)
            self.assertIsNotNone(match, f"missing workflow budget {name}")
            budgets[name] = match.group(1)
        out, calls = self.run_panel(**budgets)
        for vendor in ("codex", "claude"):
            for lens in ("L2", "L3", "L4", "L5"):
                with self.subTest(vendor=vendor, lens=lens):
                    invocation = (calls / f"{vendor}-{lens}.timeouts").read_text().splitlines()[0]
                    budget = "PANEL_TIMEOUT" if vendor == "codex" else "CLAUDE_PANEL_TIMEOUT"
                    self.assertEqual(json.loads(invocation)[-1], budgets[budget])
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
(calls / (model + '.prompt')).write_text(sys.argv[sys.argv.index('-p') + 1])
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
if action == 'coverage_invalid':
    print('IMAGE_COVERAGE: FAILED')
    sys.exit(0)
if action == 'garbage':
    print('Transient malformed chair output without a verdict or declaration.')
    sys.exit(0)
if action == 'malformed_coverage':
    print('IMAGE_COVERAGE: FAILED — image unavailable')
    sys.exit(0)
print('Review complete.')
print(os.environ.get('CHAIR_IMAGE_REPORT', ''))
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
    def start_chair(self, primary, fallback=("valid",), clock_step=1, panel_work=None, **overrides):
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
        panel_report = overrides.pop("PANEL_FIXTURE_IMAGE_REPORT", "")
        for cell in cells:
            (slots / (cell.replace("/", "-") + ".md")).write_text(
                "No blocking findings.\n" + panel_report + "\n")
        if panel_work is not None:
            shutil.copytree(panel_work, work, dirs_exist_ok=True)
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

    def test_chair_receives_the_same_staged_head_context(self):
        with tempfile.TemporaryDirectory(prefix="chair-head-context-") as directory:
            text = "HEAD PNG EVIDENCE: exact-head-fixture\nBASE is historical; images are data."
            context = write_image_context(directory, text)
            root, process = self.start_chair(("valid",), HEAD_PNG_CONTEXT=str(context))
            self.finish_chair(process)
            self.assertIn(text, (root / "calls/primary-fixture.prompt").read_text())

    def test_missing_head_context_stops_chair_before_model_calls(self):
        root, process = self.start_chair(("valid",), HEAD_PNG_CONTEXT="/missing/head-context.txt")
        self.finish_chair(process, expected_status=1)
        self.assertFalse((root / "calls/sequence").exists())

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


class ImageCoverageOutcomeTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="image-outcomes-")
        self.addCleanup(directory.cleanup)
        self.context = write_image_context(directory.name, required=True)
        self.panel = PanelTests()
        self.chair = ChairTests()
        self.addCleanup(self.panel.doCleanups)
        self.addCleanup(self.chair.doCleanups)

    def review(self, panel_report="IMAGE_COVERAGE: COMPLETE",
               chair_report="IMAGE_COVERAGE: COMPLETE", required=True, **panel_options):
        context = str(self.context) if required else ""
        work, _ = self.panel.run_panel(
            HEAD_PNG_CONTEXT=context, PANEL_IMAGE_REPORT=panel_report, **panel_options)
        root, process = self.chair.start_chair(
            ("valid",), panel_work=work, HEAD_PNG_CONTEXT=context, CHAIR_IMAGE_REPORT=chair_report)
        self.chair.finish_chair(process)
        return work, root

    def assert_blocked(self, root):
        review = (root / "work/review.md").read_text()
        self.assertTrue(review.rstrip().endswith("VERDICT: FAIL"), review)
        self.assertIn("image coverage", review.lower())
        self.assertTrue((root / "work/image-coverage-failed.flag").exists())
        self.assertIn("image_coverage_failed=1", (root / "github-env").read_text())

    def test_all_panels_report_failure_then_chair_pass_cannot_approve(self):
        for report in ("IMAGE_COVERAGE: FAILED", "IMAGE COVERAGE FAILURE: cannot inspect pixels"):
            with self.subTest(report=report):
                work, root = self.review(panel_report=report)
                self.assertEqual(len((work / "responded.txt").read_text().splitlines()), 8)
                self.assertEqual((work / "degraded-models.txt").read_text(), "")
                self.assertEqual((work / "degraded-lenses.txt").read_text(), "")
                self.assertNotIn("had no response", (root / "work/review.md").read_text())
                self.assertTrue((work / "coverage-severe.flag").exists())
                self.assert_blocked(root)

    def test_chair_failure_overrides_later_pass_even_without_required_images(self):
        for required in (True, False):
            for report in ("IMAGE_COVERAGE: FAILED", "IMAGE COVERAGE FAILURE: renderer unavailable"):
                with self.subTest(required=required, report=report):
                    _, root = self.review(chair_report=report, required=required)
                    self.assert_blocked(root)

    def test_missing_or_not_required_signal_from_one_required_cell_blocks(self):
        for signal in ("", "IMAGE_COVERAGE: NOT_REQUIRED"):
            with self.subTest(signal=signal):
                work, root = self.review(PANEL_IMAGE_REPORTS=json.dumps({"claude/L5": signal}))
                self.assertEqual(len((work / "responded.txt").read_text().splitlines()), 8)
                self.assertIn("claude/L5", (work / "responded.txt").read_text())
                self.assert_blocked(root)

    def test_chair_must_explicitly_complete_required_images(self):
        for signal in ("", "IMAGE_COVERAGE: NOT_REQUIRED",
                       "IMAGE_COVERAGE: COMPLETE\nIMAGE_COVERAGE: FAILED",
                       "IMAGE_COVERAGE: FAILED\nIMAGE_COVERAGE: COMPLETE"):
            with self.subTest(signal=signal):
                _, root = self.review(chair_report=signal)
                self.assert_blocked(root)

    def test_quoted_fenced_and_prose_mentions_are_not_failure_declarations(self):
        report = ('The IMAGE_COVERAGE: FAILED rule is discussed here.\n'
                  'Example: IMAGE_COVERAGE: FAILED is not this review outcome.\n'
                  '> IMAGE_COVERAGE: FAILED\n`IMAGE_COVERAGE: FAILED`\n'
                  '"IMAGE_COVERAGE: FAILED"\n    IMAGE_COVERAGE: FAILED\n'
                  '```text\nIMAGE COVERAGE FAILURE\nIMAGE_COVERAGE: FAILED\n```\n'
                  '~~~\nIMAGE_COVERAGE: FAILED\n~~~\n'
                  'IMAGE_COVERAGE: COMPLETE\n')
        work, root = self.review(panel_report=report, chair_report=report)
        self.assertEqual(len((work / "responded.txt").read_text().splitlines()), 8)
        self.assertFalse((root / "work/image-coverage-failed.flag").exists())
        self.assertTrue((root / "work/review.md").read_text().rstrip().endswith("VERDICT: PASS"))

    def test_no_image_legacy_reviews_remain_marker_optional_but_explicit_failure_blocks(self):
        _, root = self.review(panel_report="", chair_report="", required=False)
        self.assertTrue((root / "work/review.md").read_text().rstrip().endswith("VERDICT: PASS"))
        _, root = self.review(panel_report="IMAGE_COVERAGE: FAILED", required=False)
        self.assert_blocked(root)

    def test_chair_revalidates_cells_instead_of_trusting_responded_list(self):
        root, process = self.chair.start_chair(
            ("valid",), HEAD_PNG_CONTEXT=str(self.context), CHAIR_IMAGE_REPORT="IMAGE_COVERAGE: COMPLETE",
            PANEL_FIXTURE_IMAGE_REPORT="IMAGE_COVERAGE: FAILED")
        self.chair.finish_chair(process)
        self.assert_blocked(root)

    def test_oversized_report_is_unavailable_not_a_truncated_complete(self):
        _, root = self.review(OVERSIZE_CELL="codex/L2")
        self.assertTrue((root / "work/review.md").read_text().rstrip().endswith("VERDICT: FAIL"))
        self.assertTrue((root / "work/report-invalid.flag").exists())
        self.assertFalse((root / "work/image-coverage-failed.flag").exists())
        self.assertIn("review output", (root / "work/review.md").read_text().lower())

    def test_failure_beyond_chair_cell_truncation_is_not_hidden(self):
        work, root = self.review(LATE_IMAGE_FAILURE_CELL="codex/L2")
        self.assertGreater((work / "slot/codex-L2.md").stat().st_size, 20000)
        self.assertIn("codex/L2", (work / "responded.txt").read_text())
        self.assert_blocked(root)

    def test_decorated_failure_cannot_be_overridden_by_complete(self):
        for signal in ("IMAGE_COVERAGE:FAILED — decoder failed",
                       "IMAGE_COVERAGE: FAILED: unreadable image",
                       "IMAGE COVERAGE FAILURE — unreadable image",
                       "**IMAGE_COVERAGE: FAILED** — unreadable image",
                       "### IMAGE_COVERAGE: FAILED — unreadable image",
                       "  IMAGE COVERAGE FAILURE — unreadable image"):
            for required in (True, False):
                with self.subTest(signal=signal, required=required):
                    _, root = self.review(panel_report=signal + "\nIMAGE_COVERAGE: COMPLETE",
                                          chair_report="IMAGE_COVERAGE: COMPLETE", required=required)
                    self.assert_blocked(root)
                    _, root = self.review(chair_report=signal + "\nIMAGE_COVERAGE: COMPLETE",
                                          required=required)
                    self.assert_blocked(root)

    def test_control_stripped_complete_is_valid_and_presence_is_retained(self):
        complete = "\x1b[32mIMAGE_COVERAGE: COMPLETE\x1b[0m\r\n"
        work, root = self.review(panel_report=complete, chair_report=complete)
        self.assertEqual(len((work / "responded.txt").read_text().splitlines()), 8)
        self.assertTrue((root / "work/review.md").read_text().rstrip().endswith("VERDICT: PASS"))
        self.assertFalse((root / "work/image-coverage-failed.flag").exists())

    def test_missing_cli_response_is_not_an_image_failure(self):
        work, root = self.review(FAIL_CELL="claude/L2")
        self.assertEqual(len((work / "responded.txt").read_text().splitlines()), 7)
        self.assertFalse((work / "image-coverage-failed.flag").exists())
        self.assertFalse((root / "work/image-coverage-failed.flag").exists())
        self.assertTrue((root / "work/review.md").read_text().rstrip().endswith("VERDICT: FAIL"))

    def test_invalid_utf8_is_a_report_failure_not_missing_response_or_image_failure(self):
        work, root = self.review(INVALID_UTF8_CELL="codex/L2")
        self.assertEqual(len((work / "responded.txt").read_text().splitlines()), 8)
        self.assertTrue((root / "work/report-invalid.flag").exists())
        self.assertFalse((root / "work/image-coverage-failed.flag").exists())
        self.assertTrue((root / "work/review.md").read_text().rstrip().endswith("VERDICT: FAIL"))

    def test_stale_image_flags_do_not_poison_a_new_synthesis(self):
        work, _ = self.panel.run_panel(HEAD_PNG_CONTEXT=str(self.context),
                                      PANEL_IMAGE_REPORT="IMAGE_COVERAGE: COMPLETE")
        (work / "image-coverage-failed.flag").touch()
        (work / "coverage-severe.flag").touch()
        root, process = self.chair.start_chair(
            ("valid",), panel_work=work, HEAD_PNG_CONTEXT=str(self.context),
            CHAIR_IMAGE_REPORT="IMAGE_COVERAGE: COMPLETE")
        self.chair.finish_chair(process)
        self.assertFalse((root / "work/image-coverage-failed.flag").exists())
        self.assertTrue((root / "work/review.md").read_text().rstrip().endswith("VERDICT: PASS"))

    def test_a_later_successful_chair_retry_cannot_clear_declared_failure(self):
        for action in ("coverage_invalid", "malformed_coverage"):
            with self.subTest(action=action):
                root, process = self.chair.start_chair(
                    (action, "valid"), HEAD_PNG_CONTEXT=str(self.context),
                    CHAIR_IMAGE_REPORT="IMAGE_COVERAGE: COMPLETE",
                    PANEL_FIXTURE_IMAGE_REPORT="IMAGE_COVERAGE: COMPLETE")
                self.chair.finish_chair(process)
                self.assertEqual(self.chair.sequence(root),
                                 [f"primary-fixture:{action}", "primary-fixture:valid"])
                self.assert_blocked(root)

    def test_discarded_garbage_without_marker_does_not_poison_valid_fallback(self):
        root, process = self.chair.start_chair(
            ("garbage",), clock_step=120, HEAD_PNG_CONTEXT=str(self.context),
            CHAIR_IMAGE_REPORT="IMAGE_COVERAGE: COMPLETE",
            PANEL_FIXTURE_IMAGE_REPORT="IMAGE_COVERAGE: COMPLETE")
        self.chair.finish_chair(process)
        self.assertEqual(self.chair.sequence(root),
                         ["primary-fixture:garbage", "fallback-fixture:valid"])
        self.assertFalse((root / "work/image-coverage-failed.flag").exists())
        self.assertTrue((root / "work/review.md").read_text().rstrip().endswith("VERDICT: PASS"))

    def test_valid_fallback_does_not_clear_panel_image_failure(self):
        root, process = self.chair.start_chair(
            ("garbage",), clock_step=120, HEAD_PNG_CONTEXT=str(self.context),
            CHAIR_IMAGE_REPORT="IMAGE_COVERAGE: COMPLETE",
            PANEL_FIXTURE_IMAGE_REPORT="IMAGE_COVERAGE: FAILED")
        self.chair.finish_chair(process)
        self.assert_blocked(root)

    def test_fail_step_treats_gate_reason_as_data_not_shell_code(self):
        workflow = (ROOT / ".github/workflows/pr-review.yml").read_text()
        step = workflow.split("      - name: Fail if CRITICAL or MAJOR\n", 1)[1].split(
            "      - name: Remove current-run", 1)[0]
        script = textwrap.dedent(step.split("        run: |\n", 1)[1])
        with tempfile.TemporaryDirectory(prefix="gate-reason-") as directory:
            first, second = Path(directory) / "first", Path(directory) / "second"
            reason = f'$(touch "{first}") `touch "{second}"`'
            rendered = script.replace("${{ steps.gate.outputs.reason }}", reason)
            result = subprocess.run(["bash", "-c", rendered],
                                    env={**os.environ, "GATE_REASON": reason},
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertFalse(first.exists())
            self.assertFalse(second.exists())
            self.assertIn(reason, result.stdout)

    def test_workflow_gate_prioritizes_image_failure_over_a_pass_file(self):
        workflow = (ROOT / ".github/workflows/pr-review.yml").read_text()
        step = workflow.split("      - name: Check for blocking issues\n", 1)[1].split(
            "      - name: Post review comment", 1)[0]
        script = textwrap.dedent(step.split("        run: |\n", 1)[1])
        with tempfile.TemporaryDirectory(prefix="image-gate-") as directory:
            root = Path(directory)
            review, output = root / "review.md", root / "output"
            review.write_text("VERDICT: PASS\n")
            script = script.replace("/tmp/review.md", str(review))
            for failed, expected in (("1", "fail"), ("0", "pass")):
                output.write_text("")
                result = subprocess.run(["bash", "-eu", "-c", script], env={
                    **os.environ, "image_coverage_failed": failed, "omitted_source_paths": "",
                    "IMAGE_STAGE_OUTCOME": "success", "PANEL_OUTCOME": "success", "CHAIR_OUTCOME": "success",
                    "GITHUB_OUTPUT": str(output)}, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("result=" + expected, output.read_text())
                if failed == "1":
                    self.assertIn("not an application finding", output.read_text())

    def test_stage_or_preparation_failure_produces_a_publishable_fail_without_stale_pass(self):
        workflow = (ROOT / ".github/workflows/pr-review.yml").read_text()
        step = workflow.split("      - name: Check for blocking issues\n", 1)[1].split(
            "      - name: Post review comment", 1)[0]
        script = textwrap.dedent(step.split("        run: |\n", 1)[1])
        self.assertIn("always()", step)
        post = workflow.split("      - name: Post review comment (upsert)\n", 1)[1].split("        env:", 1)[0]
        self.assertIn("always()", post)
        with tempfile.TemporaryDirectory(prefix="stage-gate-") as directory:
            root = Path(directory)
            review, output = root / "review.md", root / "output"
            script = script.replace("/tmp/review.md", str(review))
            for stage, panel, chair in (("failure", "skipped", "skipped"),
                                        ("success", "failure", "skipped"), ("success", "success", "failure")):
                review.write_text("STALE PASS\nVERDICT: PASS\n")
                output.write_text("")
                result = subprocess.run(["bash", "-eu", "-c", script], env={
                    **os.environ, "IMAGE_STAGE_OUTCOME": stage, "PANEL_OUTCOME": panel, "CHAIR_OUTCOME": chair,
                    "GITHUB_OUTPUT": str(output), "GITHUB_ENV": str(root / "env")},
                    capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("result=fail", output.read_text())
                self.assertTrue(review.read_text().rstrip().endswith("VERDICT: FAIL"))
                self.assertNotIn("STALE", review.read_text())


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

    def test_each_model_phase_mints_fresh_credentials_immediately_before_execution(self):
        for credentials, phase in (("panel_credentials", "panel_review"),
                                   ("chair_credentials", "chair_review")):
            with self.subTest(phase=phase):
                credentials_index, credentials_block = self.step(credentials)
                phase_index, _ = self.step(phase)
                self.assertEqual(credentials_index + 1, phase_index,
                                 "slow setup must not consume model-phase credential lifetime")
                self.assertEqual(self.field(credentials_block, "unset-current-credentials"), "true")
                self.assertEqual(self.field(credentials_block, "use-existing-credentials"), "false")

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
        self.assertEqual(int(self.field(panel, "CLAUDE_PANEL_TIMEOUT")), 1200)
        self.assertEqual(int(self.field(panel, "PANEL_TIMEOUT")), 1200)
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
    def test_omitted_path_exports_keep_adversarial_filenames_as_data(self):
        workflow = (ROOT / ".github/workflows/pr-review.yml").read_text()
        fragment = workflow.split("          python3 - <<'PYEOF'\n", 1)[1].split(
            "\n      - uses: actions/setup-python", 1)[0]
        fragment = textwrap.dedent("          python3 - <<'PYEOF'\n" + fragment)
        gate = workflow.split("      - name: Check for blocking issues\n", 1)[1].split(
            "      - name: Post review comment", 1)[0]
        gate = textwrap.dedent(gate.split("        run: |\n", 1)[1])
        for control in ("\rFORGED=1\r", "\nFAKE=2\t", "\t"):
            with self.subTest(control=repr(control)), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                marker = root / "must-not-exist"
                name = f'web/{control}$(touch {marker})`touch {marker}`.ts'
                long_name = "scripts/" + "a" * 210 + ".ts"
                # Real NUL-delimited name-status shape; headers are never path authority.
                (root / "pr-diff-namestatus.nul").write_bytes(
                    f"M\0{name}\0M\0{long_name}\0".encode())
                (root / "pr-diff-raw.txt").write_text(
                    ("diff --git quoted-header-not-parsed\n+" + "x" * 50001 + "\n") * 2)
                env_file, output = root / "env", root / "output"
                env = {**os.environ, "GITHUB_ENV": str(env_file), "GITHUB_OUTPUT": str(output)}
                result = subprocess.run(["bash", "-eu", "-c", fragment.replace("/tmp/", f"{root}/")],
                                        env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                values = dict(line.split("=", 1) for line in env_file.read_text().splitlines())
                self.assertEqual(set(values), {"total_lines", "omitted_paths", "omitted_source_paths"})
                labels = values["omitted_source_paths"].split()
                self.assertEqual(len(labels), 2)
                for label in labels:
                    self.assertRegex(label, r"^[A-Za-z0-9._/?-]{1,200}$")
                (root / "review.md").write_text("VERDICT: PASS\n")
                result = subprocess.run(["bash", "-eu", "-c", gate.replace("/tmp/", f"{root}/")],
                                        env={**env, **values, "IMAGE_STAGE_OUTCOME": "success",
                                             "PANEL_OUTCOME": "success", "CHAIR_OUTCOME": "success"},
                                        capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                outputs = dict(line.split("=", 1) for line in output.read_text().splitlines())
                self.assertEqual(set(outputs), {"result", "reason"})
                self.assertEqual(outputs["result"], "fail")
                self.assertIn("oversized line", outputs["reason"])
                self.assertFalse(marker.exists())

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
