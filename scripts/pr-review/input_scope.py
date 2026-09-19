#!/usr/bin/env python3
"""Admit a complete, bounded diff and image manifest before paid model calls."""

import os
from pathlib import Path
import sys

from image_coverage import attachment_paths, load_manifest


MAX_LINES = 6000
MAX_BYTES = 128 * 1024


def admission(diff, context, omitted_source=""):
    # Read one byte beyond the bound to distinguish exact-size from excess input.
    with Path(diff).open("rb") as stream:
        data = stream.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        return False, "diff exceeds 128 KiB; split the change or implement complete bounded review batches"
    data.decode("utf-8", errors="strict")
    if len(data.splitlines()) > MAX_LINES:
        return False, "diff exceeds 6000 lines; split the change or implement complete bounded review batches"
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
    except (OSError, ValueError, UnicodeError, IndexError):
        ready, reason = False, "review input unreadable or invalid"
    # Fixed messages only: paths, provider errors and PR data never become outputs.
    print(f"ready={str(ready).lower()}")
    print(f"reason={reason}")


if __name__ == "__main__":
    main()
