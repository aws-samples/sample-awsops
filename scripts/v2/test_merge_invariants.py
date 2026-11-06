"""S1 merge invariants — terraform gate posture (BASELINE.md §2, ADR-005/006/007).

Red until scripts/v2/merge_invariants.py implements the parsing helpers.
Run: python3 -m pytest scripts/v2/test_merge_invariants.py -q
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
TF_DIR = os.path.join(ROOT, "terraform", "foundation")

import merge_invariants as mi  # noqa: E402

# The 10 flag-gated feature files — every resource block must carry count/for_each.
GATED_FILES = [
    "incidents.tf",
    "remediation.tf",
    "writeback.tf",
    "k8sgpt.tf",
    "notify.tf",
    "steampipe.tf",
    "workers.tf",
    "ai.tf",
    "eks.tf",
    "secret-rotation.tf",
]


def test_all_enabled_flags_default_false():
    flags = mi.tf_flag_defaults(TF_DIR)
    # anti-silent-parse-failure: the parser must actually find the flag family
    assert len(flags) >= 10, f"suspiciously few *_enabled variables parsed: {flags}"
    for known in (
        "remediation_enabled",
        "workers_enabled",
        "steampipe_enabled",
        "incident_lifecycle_enabled",
        "rca_writeback_enabled",
        "integrations_write_enabled",
    ):
        assert known in flags, f"known flag {known} not parsed"
    non_false = {k: v for k, v in flags.items() if v is not False}
    assert not non_false, f"*_enabled variables with non-false default: {non_false}"


def test_gated_files_have_no_ungated_resources():
    for fname in GATED_FILES:
        path = os.path.join(TF_DIR, fname)
        assert os.path.isfile(path), f"gated file missing: {fname}"
        ungated = mi.ungated_resources(path)
        assert ungated == [], f"{fname}: resource blocks without count/for_each gate: {ungated}"


def test_gate_parser_detects_ungated_resource():
    # anti-false-negative self-check: a fixture with an ungated resource MUST be flagged
    fixture = 'resource "aws_sns_topic" "x" {\n  name = "t"\n}\n'
    import tempfile

    with tempfile.NamedTemporaryFile("w", suffix=".tf", delete=False) as f:
        f.write(fixture)
        p = f.name
    try:
        assert mi.ungated_resources(p), "parser failed to flag an obviously ungated resource"
    finally:
        os.unlink(p)


def test_frozen_marker_present():
    assert mi.frozen_marker_present(os.path.join(TF_DIR, "variables.tf")), (
        "remediation_enabled description lost its 'DO NOT ENABLE' freeze marker (ADR-005)"
    )


def test_pinned_selectors_keep_their_default():
    defaults = mi.tf_selector_defaults(TF_DIR)
    assert defaults == mi.PINNED_SELECTORS, f"pinned selector defaults changed: {defaults}"


def test_tracked_tfvars_scan_flags_a_non_default_selector(tmp_path, monkeypatch):
    import subprocess
    (tmp_path / "terraform").mkdir()
    (tmp_path / "terraform" / "x.tfvars").write_text('model_provider = "anthropic_api"\nmodel_provider = "mixed"\n')
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: subprocess.CompletedProcess(a, 0, "terraform/x.tfvars\n", ""))
    assert mi.tracked_tfvars_enabling(str(tmp_path)) == ["terraform/x.tfvars:1:model_provider"]


def test_no_tracked_tfvars_enable_flags():
    offenders = mi.tracked_tfvars_enabling(ROOT)
    assert offenders == [], f"tracked tfvars enable gated/frozen flags: {offenders}"
