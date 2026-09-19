#!/usr/bin/env python3
"""Admit a complete, bounded diff and image manifest before paid model calls."""

import json
import os
import subprocess
from pathlib import Path
import sys

from image_coverage import attachment_paths, load_manifest


LIMITS = json.loads(Path(__file__).with_name("review-limits.json").read_text())
MAX_LINES = LIMITS["diff_lines"]
MAX_BYTES = LIMITS["diff_bytes"]
if (any(type(value) is not int or value <= 0 for value in LIMITS.values())
        or MAX_BYTES + LIMITS["panel_bytes"] + LIMITS["stdin_envelope_bytes"] > LIMITS["chair_stdin_bytes"]
        or 2 * LIMITS["report_bytes"] > LIMITS["panel_bytes"]):
    raise ValueError("Invalid review budget configuration")


def admission(diff, context, omitted_source=""):
    # Read one byte beyond the bound to distinguish exact-size from excess input.
    try:
        with Path(diff).open("rb") as stream:
            data = stream.read(MAX_BYTES + 1)
    except OSError:
        return False, "diff file unavailable; inspect input preparation"
    if len(data) > MAX_BYTES:
        return False, "diff exceeds 128 KiB; split the change or implement complete bounded review batches"
    # Preserve original bytes for the reviewer CLIs; do not silently replace them.
    if data.count(b"\n") > MAX_LINES:
        return False, "diff exceeds 6000 lines; split the change or implement complete bounded review batches"
    # Reserve from the actual scrubbed bytes too: redaction may expand short values.
    try:
        scrubbed = subprocess.run(
            ["bash", "-c", 'source "$1"; strip_controls | scrub_secrets', "review-scrub",
             str(Path(__file__).with_name("lib.sh"))], input=data, capture_output=True,
            timeout=10, check=True, env={"PATH": "/usr/bin:/bin", "LC_ALL": "C.UTF-8"},
        ).stdout
    except subprocess.TimeoutExpired:
        return False, "review sanitizer timed out; inspect runner tooling"
    except (OSError, subprocess.CalledProcessError):
        return False, "review sanitizer unavailable or failed; inspect runner tooling"
    if len(scrubbed) > MAX_BYTES:
        return False, "sanitized diff exceeds chair allocation; split the change"
    if omitted_source:
        return False, "source lines were omitted; reformat them into reviewable lines"
    try:
        manifest = load_manifest(context)
    except (OSError, ValueError, UnicodeError):
        return False, "HEAD image manifest unavailable or invalid; inspect staging"
    if manifest["status"] != "complete":
        return False, "HEAD image evidence incomplete; inspect staging diagnostics"
    # Recheck immutable attachments, not just the manifest's status string.
    try:
        attachment_paths(context)
    except (OSError, ValueError, UnicodeError):
        return False, "HEAD image attachment unavailable or invalid; inspect staging"
    return True, "complete input admitted"


def main():
    try:
        ready, reason = admission(sys.argv[1], sys.argv[2], os.environ.get("omitted_source_paths", ""))
    except (OSError, ValueError, UnicodeError, IndexError, subprocess.SubprocessError):
        ready, reason = False, "review input unreadable or invalid"
    # Fixed messages only: paths, provider errors and PR data never become outputs.
    print(f"ready={str(ready).lower()}")
    print(f"reason={reason}")


if __name__ == "__main__":
    main()
