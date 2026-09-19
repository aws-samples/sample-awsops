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
assert MAX_BYTES + LIMITS["panel_bytes"] + LIMITS["envelope_bytes"] <= LIMITS["chair_bytes"]
assert 2 * LIMITS["report_bytes"] <= LIMITS["panel_bytes"]


def admission(diff, context, omitted_source=""):
    # Read one byte beyond the bound to distinguish exact-size from excess input.
    with Path(diff).open("rb") as stream:
        data = stream.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        return False, "diff exceeds 128 KiB; split the change or implement complete bounded review batches"
    data.decode("utf-8", errors="strict")
    if len(data.splitlines()) > MAX_LINES:
        return False, "diff exceeds 6000 lines; split the change or implement complete bounded review batches"
    # Reserve from the actual scrubbed bytes too: redaction may expand short values.
    scrubbed = subprocess.run(
        ["bash", "-c", 'source "$1"; strip_controls | scrub_secrets', "review-scrub",
         str(Path(__file__).with_name("lib.sh"))], input=data, capture_output=True,
        timeout=10, check=True, env={"PATH": "/usr/bin:/bin", "LC_ALL": "C.UTF-8"},
    ).stdout
    if len(scrubbed) > MAX_BYTES:
        return False, "sanitized diff exceeds chair allocation; split the change"
    if omitted_source:
        return False, "source lines were omitted; reformat them into reviewable lines"
    manifest = load_manifest(context)
    if manifest["status"] != "complete":
        return False, "HEAD image evidence incomplete; inspect staging diagnostics"
    # Recheck immutable attachments, not just the manifest's status string.
    attachment_paths(context)
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
