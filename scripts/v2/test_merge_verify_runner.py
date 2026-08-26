"""S3 merge-verify runner acceptance — proves behavior with fixtures, not text inspection.

Red until scripts/v2/merge-verify.sh, .github/workflows/merge-verify.yml and
docs/v2-merge-verification.md exist.
Run: python3 -m pytest scripts/v2/test_merge_verify_runner.py -q
"""
import os
import stat
import subprocess
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
RUNNER = os.path.join(HERE, "merge-verify.sh")
WORKFLOW = os.path.join(ROOT, ".github", "workflows", "merge-verify.yml")
DOC = os.path.join(ROOT, "docs", "v2-merge-verification.md")


def _run(env_extra, cwd=ROOT):
    env = {**os.environ, **env_extra}
    return subprocess.run(
        ["bash", RUNNER], env=env, cwd=cwd, capture_output=True, text=True, timeout=300
    )


def test_runner_exists_and_is_executable():
    assert os.path.isfile(RUNNER), "scripts/v2/merge-verify.sh missing"
    assert os.stat(RUNNER).st_mode & stat.S_IXUSR, "merge-verify.sh not executable"


def test_runner_fails_on_failing_fixture_then_passes_when_removed():
    with tempfile.TemporaryDirectory() as d:
        ok = os.path.join(d, "test_ok.py")
        bad = os.path.join(d, "sub")  # prove recursion: failing file in a SUBDIR
        os.makedirs(bad)
        bad_file = os.path.join(bad, "test_bad.py")
        with open(ok, "w") as f:
            f.write("def test_ok():\n    assert True\n")
        with open(bad_file, "w") as f:
            f.write("def test_bad():\n    assert False\n")

        env = {"MERGE_VERIFY_PY_ROOT": d, "MERGE_VERIFY_SKIP_WEB": "1"}
        r = _run(env)
        assert r.returncode != 0, f"runner must exit non-zero on a failing test\n{r.stdout}\n{r.stderr}"
        assert "test_bad.py" in (r.stdout + r.stderr), "summary must name the failing file"

        os.unlink(bad_file)
        r2 = _run(env)
        assert r2.returncode == 0, f"runner must exit 0 when all tests pass\n{r2.stdout}\n{r2.stderr}"


def test_ci_workflow_gates_prs_to_main():
    assert os.path.isfile(WORKFLOW), ".github/workflows/merge-verify.yml missing"
    with open(WORKFLOW) as f:
        txt = f.read()
    assert "pull_request" in txt, "workflow must trigger on pull_request"
    assert "main" in txt, "workflow must target main"
    assert "merge-verify.sh" in txt, "workflow must invoke the runner"


def test_scenario_doc_covers_s1_s2_s3():
    assert os.path.isfile(DOC), "docs/v2-merge-verification.md missing"
    with open(DOC) as f:
        txt = f.read()
    for scenario in ("S1", "S2", "S3"):
        assert scenario in txt, f"scenario doc missing {scenario} section"
