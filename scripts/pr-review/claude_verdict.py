"""Enforce the official Action's structured finding and coverage result."""
import hashlib
import html
import json
import os
from pathlib import Path
import re
import subprocess


def validate(result, index, head, digest):
    receipts = result.get("receipts")
    if (result.get("head") != head or index["head"] != head or result.get("complete") is not True
            or not isinstance(receipts, list) or len(receipts) != len(index["pages"])
            or not all(isinstance(r, str) and re.fullmatch(r"[0-9a-f]{16}", r) for r in receipts)
            or hashlib.sha256(" ".join(receipts).encode()).hexdigest() != digest
            or result.get("images") != [image["file"] for image in index["images"]]):
        raise ValueError("Incomplete review or stale HEAD")
    if result.get("severity") not in {"NONE", "MINOR", "MAJOR", "CRITICAL"}:
        raise ValueError("Missing review severity")
    if not isinstance(result.get("summary"), str) or not result["summary"].strip():
        raise ValueError("Missing review summary")
    return result["severity"] in {"NONE", "MINOR"}


if __name__ == "__main__":
    if os.environ["CONCLUSION"] != "success":
        raise SystemExit("Claude did not complete the review")
    result = json.loads(os.environ["RESULT"])
    index = json.loads((Path("review-packet") / os.environ["GROUP"] / "index.json").read_text())
    passed = validate(result, index, os.environ["HEAD"], os.environ["DIGEST"])
    summary = subprocess.run(["bash", "-eo", "pipefail", "-c",
                              "source scripts/pr-review/lib.sh; strip_controls | scrub_secrets"],
                             input=result["summary"], capture_output=True, text=True, check=True).stdout
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as stream:
        stream.write("<pre>" + html.escape(summary[:30000]) + "</pre>\n")
    if not passed:
        raise SystemExit("Claude reported a blocking finding. See the job summary.")
