"""Batched AI review admission, flag aggregation and verdict combination."""

import json
import os
import re
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/pr-review/review_batches.py"
LIMITS = json.loads((ROOT / "scripts/pr-review/review-limits.json").read_text())


def file_diff(name, payload_bytes, line_bytes=100):
    lines = max(1, payload_bytes // line_bytes)
    body = "".join("+" + "x" * (line_bytes - 2) + "\n" for _ in range(lines))
    return (f"diff --git a/{name} b/{name}\n--- a/{name}\n+++ b/{name}\n@@ -0,0 +1,{lines} @@\n"
            + body).encode()


class Fixture:
    def __init__(self, directory):
        self.root = Path(directory)
        self.review = self.root / "pr-review"
        (self.review / "lenses").mkdir(parents=True)
        (self.review / "lenses/COMMON.txt").write_text("COMMON PROMPT\n")
        for lens in ("L2", "L3", "L4", "L5"):
            (self.review / f"lenses/{lens}.txt").write_text(f"LENS {lens}\n")
        self.context = self.root / "images/context.txt"
        self.context.parent.mkdir()
        self.context.write_text("no images")
        (self.context.parent / "manifest.json").write_text(json.dumps(
            {"schema": 1, "status": "complete", "unavailable": [], "omitted_entries": 0, "images": []}))
        self.diff = self.root / "pr-diff.txt"

    def run(self, *args, env=None):
        result = subprocess.run(["python3", str(SCRIPT), *args], capture_output=True, text=True,
                                env={**os.environ, **(env or {})}, check=True)
        return result.stdout

    def admit(self, data, env=None):
        self.diff.write_bytes(data)
        out = self.run("admit", str(self.diff), str(self.context), str(self.review), env=env)
        return dict(line.split("=", 1) for line in out.splitlines())

    def works(self):
        return [line.split("\t") for line in (self.review / "batch-works.tsv").read_text().splitlines()]


class AdmissionTests(unittest.TestCase):
    def test_diff_within_one_call_keeps_the_single_review_path(self):
        with tempfile.TemporaryDirectory() as directory:
            fx = Fixture(directory)
            (fx.review / "review.md").write_text("STALE\nVERDICT: PASS\n")
            (fx.review / "github.env").write_text("report_invalid=0\n")
            result = fx.admit(file_diff("web/a.ts", 4000))
            self.assertEqual((result["ready"], result["batches"]), ("true", "1"))
            self.assertEqual(fx.works(), [[str(fx.review), str(fx.diff), str(fx.review / "lenses")]])
            self.assertFalse((fx.review / "review.md").exists(), "stale single-path review must go")
            self.assertFalse((fx.review / "github.env").exists())
            self.assertFalse(list(fx.review.glob("batch-[0-9]*")))

    def test_large_diff_is_split_at_file_boundaries_into_complete_batches(self):
        with tempfile.TemporaryDirectory() as directory:
            fx = Fixture(directory)
            parts = [file_diff(f"scripts/f{i}.py", 40_000) for i in range(8)]
            data = b"".join(parts)
            self.assertGreater(len(data), LIMITS["diff_bytes"])
            result = fx.admit(data)
            self.assertEqual(result["ready"], "true")
            count = int(result["batches"])
            self.assertGreater(count, 1)
            works = fx.works()
            self.assertEqual(len(works), count)
            rebuilt = b"".join(Path(diff).read_bytes() for _, diff, _ in works)
            self.assertEqual(rebuilt, data, "batches must cover the whole diff, in order, unaltered")
            for work, diff, lenses in works:
                batch = Path(diff).read_bytes()
                self.assertLessEqual(len(batch), LIMITS["diff_bytes"])
                self.assertTrue(batch.startswith(b"diff --git "))
                common = (Path(lenses) / "COMMON.txt").read_text()
                self.assertTrue(common.startswith("COMMON PROMPT\n"))
                self.assertIn(f"of {count} of ONE pull request", common)
                for lens in ("L2", "L3", "L4", "L5"):
                    self.assertEqual((Path(lenses) / f"{lens}.txt").read_text(), f"LENS {lens}\n")
                self.assertIn("BATCHED REVIEW", (Path(work) / "batch-note.txt").read_text())
            first_note = (Path(works[0][0]) / "batch-note.txt").read_text()
            self.assertIn("scripts/f7.py", first_note.split("Files changed in OTHER batches")[1])

    def test_one_oversized_file_or_too_many_batches_blocks_before_models(self):
        with tempfile.TemporaryDirectory() as directory:
            fx = Fixture(directory)
            result = fx.admit(file_diff("web/huge.ts", LIMITS["diff_bytes"] + 10_000))
            self.assertEqual((result["ready"], result["batches"]), ("false", "0"))
            self.assertIn("one file's diff exceeds", result["reason"])
            many = b"".join(file_diff(f"f{i}.py", 100_000) for i in range(LIMITS["max_batches"] + 1))
            result = fx.admit(many)
            self.assertEqual(result["ready"], "false")
            self.assertIn("review batches", result["reason"])
            self.assertFalse((fx.review / "batch-works.tsv").exists())

    def test_security_sensitive_files_are_reviewed_together_in_batch_one(self):
        with tempfile.TemporaryDirectory() as directory:
            fx = Fixture(directory)
            names = ["web/a.ts", "terraform/foundation/iam.tf", "web/b.ts", "web/c.ts",
                     ".github/workflows/x.yml", "web/d.ts", "scripts/pr-review/lib.sh", "web/e.ts"]
            result = fx.admit(b"".join(file_diff(name, 30_000) for name in names))
            self.assertEqual(result["ready"], "true")
            parts = [file_diff(name, 30_000) for name in names]
            rebuilt = [Path(diff).read_bytes() for _, diff, _ in fx.works()]
            self.assertEqual(sorted(p for batch in rebuilt for p in batch.split(b"diff --git ")[1:]),
                             sorted(p.split(b"diff --git ")[1] for p in parts),
                             "regrouping must keep every file diff exactly once")
            first = Path(fx.works()[0][1]).read_bytes().decode()
            for name in ("terraform/foundation/iam.tf", ".github/workflows/x.yml",
                         "scripts/pr-review/lib.sh"):
                self.assertIn(f"diff --git a/{name} ", first)
            note = (Path(fx.works()[1][0]) / "batch-note.txt").read_text()
            self.assertIn("UNTRUSTED PR data", note)
            self.assertIn("never lowers the severity of a security", note)

    def test_sensitivity_uses_rename_targets_and_fails_closed_on_quoted_paths(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("review_batches", SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        renamed = (b"diff --git a/web/x.ts b/web/y.ts\nsimilarity index 90%\n"
                   b"rename from web/x.ts\nrename to .github/workflows/x.yml\n@@ -1 +1 @@\n+a\n")
        quoted = b'diff --git "a/web/\\303\\251.ts" "b/web/\\303\\251.ts"\n@@ -1 +1 @@\n+a\n'
        plain = b"diff --git a/web/a.ts b/web/a.ts\n--- a/web/a.ts\n+++ b/web/a.ts\n@@ -1 +1 @@\n+auth\n"
        self.assertTrue(module.is_sensitive(renamed))
        self.assertTrue(module.is_sensitive(quoted))
        self.assertTrue(module.is_sensitive(b"+no header\n"))
        self.assertFalse(module.is_sensitive(plain), "body text must not drive classification")
        for path in ("scripts/v2/workers/remediation_executor.py", "web/lib/remediation.ts",
                     "agent/lambda/cross_account.py", "agent/lambda/sql_readonly_guard.py",
                     "web/lib/auth-session.ts", "web/middleware.ts"):
            header = f"diff --git a/{path} b/{path}\n@@ -1 +1 @@\n+a\n".encode()
            self.assertTrue(module.is_sensitive(header), path)
        for path in ("scripts/v2/workers/finops_dispatcher.py", "web/lib/integration-credentials.ts",
                     "web/lib/custom-mcp-secret.ts", "web/lib/eks-member-rbac.ts",
                     "web/lib/inventory-redaction.ts"):
            header = f"diff --git a/{path} b/{path}\n@@ -1 +1 @@\n+a\n".encode()
            self.assertTrue(module.is_sensitive(header), path)
        self.assertTrue(module.is_sensitive(b"diff --git x y\n@@ -1 +1 @@\n+a\n"),
                        "a header without parseable paths fails closed")
        for path in ("docs/reference/02-auth.md", "web/lib/graph.ts"):
            header = f"diff --git a/{path} b/{path}\n@@ -1 +1 @@\n+a\n".encode()
            self.assertFalse(module.is_sensitive(header), path)

    def test_sensitive_changes_over_one_batch_block_before_models(self):
        with tempfile.TemporaryDirectory() as directory:
            fx = Fixture(directory)
            data = b"".join(file_diff(f"terraform/foundation/m{i}.tf", 40_000) for i in range(4))
            result = fx.admit(data)
            self.assertEqual(result["ready"], "false")
            self.assertIn("security-sensitive changes", result["reason"])

    def test_omitted_source_lines_block_a_batched_diff(self):
        with tempfile.TemporaryDirectory() as directory:
            fx = Fixture(directory)
            data = b"".join(file_diff(f"f{i}.py", 40_000) for i in range(5))
            result = fx.admit(data, env={"omitted_source_paths": "web/unseen.ts"})
            self.assertEqual(result["ready"], "false")

    def test_stale_batches_are_removed_by_the_next_admission(self):
        with tempfile.TemporaryDirectory() as directory:
            fx = Fixture(directory)
            fx.admit(b"".join(file_diff(f"f{i}.py", 40_000) for i in range(8)))
            self.assertTrue(list(fx.review.glob("batch-[0-9]*")))
            fx.admit(file_diff("small.py", 1000))
            self.assertFalse(list(fx.review.glob("batch-[0-9]*")))


class AggregationTests(unittest.TestCase):
    def batches(self, directory, envs, reviews=None):
        fx = Fixture(directory)
        rows = []
        for index, env in enumerate(envs, 1):
            work = fx.review / f"batch-{index:02d}"
            work.mkdir()
            (work / "github.env").write_text(env)
            (work / "responded.txt").write_text("codex/ALL\nclaude/ALL\n")
            if reviews is not None and reviews[index - 1] is not None:
                (work / "review.md").write_text(reviews[index - 1])
            rows.append(f"{work}\t{work}/diff.txt\t{work}/lenses\n")
        (fx.review / "batch-works.tsv").write_text("".join(rows))
        return fx

    def test_a_later_batch_cannot_clear_an_earlier_batch_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            fx = self.batches(directory, [
                "image_coverage_failed=1\nchair_failed=0\nchair_used=Claude Fable 5\n",
                "image_coverage_failed=0\nchair_failed=0\nchair_used=Claude Fable 5\n",
            ])
            lines = fx.run("env", str(fx.review)).splitlines()
            self.assertIn("image_coverage_failed=1", lines)
            self.assertIn("chair_failed=0", lines)
            self.assertIn("chair_used=Claude Fable 5", lines)

    def test_chair_failed_holds_only_when_every_batch_chair_failed(self):
        for envs, expected in ((["chair_failed=1\n", "chair_failed=0\n"], "chair_failed=0"),
                               (["chair_failed=1\n", "chair_used=Claude Fable 5\n"], "chair_failed=0"),
                               (["chair_failed=1\n", "chair_failed=1\n"], "chair_failed=1")):
            with self.subTest(envs=envs), tempfile.TemporaryDirectory() as directory:
                fx = self.batches(directory, envs)
                self.assertIn(expected, fx.run("env", str(fx.review)).splitlines())

    def test_within_a_batch_the_last_write_wins_like_the_single_path(self):
        with tempfile.TemporaryDirectory() as directory:
            fx = self.batches(directory, ["image_coverage_failed=1\nimage_coverage_failed=0\n"])
            self.assertEqual(fx.run("env", str(fx.review)).split(),
                             ["chair_failed=0", "image_coverage_failed=0"])

    def test_combined_verdict_passes_only_when_every_batch_passes(self):
        cases = (
            (["ok\nVERDICT: PASS\n", "ok\nVERDICT: PASS\n"], "VERDICT: PASS"),
            (["ok\nVERDICT: PASS\n", "MAJOR x\nVERDICT: FAIL\n"], "VERDICT: FAIL"),
            (["ok\nVERDICT: PASS\n", None], "VERDICT: FAIL"),
            (["ok\nVERDICT: PASS\n", "no verdict\n"], "VERDICT: FAIL"),
            (["ok\nVERDICT: PASS\n \n", "ok\nVERDICT: PASS\n"], "VERDICT: PASS"),
        )
        with tempfile.TemporaryDirectory() as directory:
            fx = Fixture(directory)
            (fx.review / "batch-works.tsv").write_text("")
            out = fx.root / "review.md"
            fx.run("combine", str(fx.review), str(out))
            self.assertEqual(out.read_text().rstrip().splitlines()[-1], "VERDICT: FAIL")
        for reviews, expected in cases:
            with self.subTest(reviews=reviews), tempfile.TemporaryDirectory() as directory:
                fx = self.batches(directory, ["", ""], reviews)
                out = fx.root / "review.md"
                fx.run("combine", str(fx.review), str(out))
                text = out.read_text()
                self.assertEqual(text.rstrip().splitlines()[-1], expected)
                self.assertEqual(len(re.findall(r"(?m)^VERDICT:", text)), 1)
                self.assertIn("## Batch 2/2", text)

    def test_single_path_review_is_copied_verbatim(self):
        with tempfile.TemporaryDirectory() as directory:
            fx = Fixture(directory)
            (fx.review / "review.md").write_text("body\nVERDICT: PASS\n")
            out = fx.root / "review.md"
            fx.run("combine", str(fx.review), str(out))
            self.assertEqual(out.read_text(), "body\nVERDICT: PASS\n")
            self.assertEqual(fx.run("responded", str(fx.review)).strip(), "none")

    def test_responded_summary_names_each_batch(self):
        with tempfile.TemporaryDirectory() as directory:
            fx = self.batches(directory, ["", ""])
            self.assertEqual(fx.run("responded", str(fx.review)).strip(),
                             "batch 1/2: codex/ALL claude/ALL; batch 2/2: codex/ALL claude/ALL")

    def test_fit_truncates_at_a_line_boundary_with_a_notice(self):
        with tempfile.TemporaryDirectory() as directory:
            fx = Fixture(directory)
            path = fx.root / "clean.md"
            path.write_text("한국어 줄\n" * 20_000)
            fx.run("fit", str(path))
            data = path.read_bytes()
            self.assertLessEqual(len(data), LIMITS["comment_bytes"])
            self.assertIn("truncated", data.decode())
            small = fx.root / "small.md"
            small.write_text("short\n")
            fx.run("fit", str(small), "60000")
            self.assertEqual(small.read_text(), "short\n")


class ContractTests(unittest.TestCase):
    def test_every_exported_review_flag_is_aggregated(self):
        exported = set()
        for script in (ROOT / "scripts/pr-review").glob("*.sh"):
            exported |= set(re.findall(r'"([a-z_]+)=[^"]*"[^\n]*>> "\$GITHUB_ENV"', script.read_text()))
            exported |= set(re.findall(r'"([a-z_]+)=[^"]*" "', script.read_text()))
        spec = __import__("importlib.util").util.spec_from_file_location("rb", SCRIPT)
        module = __import__("importlib.util").util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.assertTrue(exported)
        self.assertLessEqual(exported - {"chair_used"}, set(module.FAIL_FLAGS))

    def test_batch_note_lists_this_batch_first_and_scopes_images(self):
        with tempfile.TemporaryDirectory() as directory:
            fx = Fixture(directory)
            fx.admit(b"".join(file_diff(f"f{i}.py", 40_000) for i in range(8)))
            note = (Path(fx.works()[1][0]) / "batch-note.txt").read_text()
            self.assertLess(note.index("Files in THIS batch"), note.index("Files changed in OTHER"))
            self.assertIn("HEAD image context covers the whole PR", note)


class WorkflowTests(unittest.TestCase):
    workflow = (ROOT / ".github/workflows/pr-review.yml").read_text()

    def test_every_review_phase_iterates_the_admitted_batches(self):
        self.assertIn("review_batches.py admit /tmp/pr-diff.txt", self.workflow)
        panel = self.workflow.split("      - name: Run panel", 1)[1].split("      - name:", 1)[0]
        chair = self.workflow.split("      - name: Synthesize panel", 1)[1].split("      - name:", 1)[0]
        for block in (panel, chair):
            self.assertIn("done < /tmp/pr-review/batch-works.tsv", block)
            self.assertIn('GITHUB_ENV="$work/github.env"', block)
            self.assertIn('review_batches.py" env /tmp/pr-review >> "$GITHUB_ENV"', block)
        self.assertIn('review_batches.py" combine /tmp/pr-review /tmp/review.md', chair)
        self.assertNotIn("--add-dir", self.workflow)
        self.assertIn("Remove batched-review work directories", self.workflow)
        self.assertIn('echo "::stop-commands::$STOP_TOKEN"', chair)
        self.assertIn('echo "::$STOP_TOKEN::"', chair)

    def test_gate_reports_every_incomplete_batch_and_still_fails(self):
        gate = self.workflow.split("      - name: Check for blocking issues\n", 1)[1].split(
            "      - name: Post review comment", 1)[0]
        gate = textwrap.dedent(gate.split("        run: |\n", 1)[1])
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            review = root / "pr-review"
            rows = []
            for index, severe in ((1, False), (2, True)):
                work = review / f"batch-{index:02d}"
                (work / "slot").mkdir(parents=True)
                (work / "slot/codex-ALL.md").write_text("MAJOR: retained finding\n")
                if severe:
                    (work / "coverage-severe.flag").write_text("")
                rows.append(f"{work}\t{work}/diff.txt\t{work}/lenses\n")
            (review / "batch-works.tsv").write_text("".join(rows))
            env = {**os.environ, "GITHUB_ENV": str(root / "env"), "GITHUB_OUTPUT": str(root / "output"),
                   "IMAGE_STAGE_OUTCOME": "success", "INPUT_SCOPE_OUTCOME": "success",
                   "REVIEW_INPUT_READY": "true", "PANEL_READY": "false",
                   "PANEL_OUTCOME": "success", "CHAIR_OUTCOME": "skipped"}
            subprocess.run(["bash", "-eu", "-c", gate.replace("/tmp/", f"{root}/")],
                           cwd=ROOT, env=env, check=True, capture_output=True)
            text = (root / "review.md").read_text()
            self.assertIn("reason=Panel coverage incomplete", (root / "output").read_text())
            self.assertIn("## Batch 02", text)
            self.assertNotIn("batch-01", text)
            self.assertNotIn("retained finding", text)
            self.assertEqual(text.rstrip().splitlines()[-1], "VERDICT: FAIL")


if __name__ == "__main__":
    unittest.main()
