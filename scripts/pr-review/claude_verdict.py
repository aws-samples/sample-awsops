"""Enforce the official Action's structured finding and coverage result."""
import html
import json
import os
from pathlib import Path
import subprocess


def verify_reads(events, directory, index):
    """Match actual SDK tool results to full-page reads of the exact prepared files."""
    pages = {(directory / entry["page"]).resolve() for entry in index["pages"]}
    images = {(directory.parent / "images" / entry["file"]).resolve() for entry in index["images"]}
    pending = pages | images
    calls = {}
    for event in events:
        blocks = event.get("message", {}).get("content", [])
        if not isinstance(blocks, list):
            continue
        for block in blocks:
            if block.get("type") == "tool_use" and event["type"] == "assistant" and block.get("name") == "Read":
                args = block.get("input", {})
                if isinstance(args.get("file_path"), str) and args.get("offset", 1) in (0, 1):
                    path = Path(args["file_path"]).resolve()
                    if path in pending:
                        calls[block["id"]] = path
            if block.get("type") != "tool_result" or event["type"] != "user" or block.get("is_error"):
                continue
            path = calls.pop(block.get("tool_use_id"), None)
            if path not in pending:
                continue
            content = block.get("content", [])
            if isinstance(content, str):
                content = [{"type": "text", "text": content}]
            if path in images:
                complete = any(item.get("type") == "image" for item in content)
            else:
                output = "\n".join(item.get("text", "") for item in content if item.get("type") == "text")
                # Read prefixes each physical line with its line number. Require all
                # lines in order, including duplicates, in a successful tool result.
                cursor = 0
                complete = True
                for line in path.read_text().splitlines():
                    if not line:
                        continue
                    position = output.find(line, cursor)
                    if position < 0:
                        complete = False
                        break
                    cursor = position + len(line)
            if complete:
                pending.remove(path)
    if pending:
        raise ValueError(f"Claude did not receive complete Read results for {len(pending)} assigned files")


def validate(result, index, head):
    if (result.get("head") != head or index["head"] != head or result.get("complete") is not True
            or sorted(result.get("lenses", [])) != ["L2", "L3", "L4", "L5"]
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
    directory = Path("review-packet") / os.environ["GROUP"]
    index = json.loads((directory / "index.json").read_text())
    passed = validate(result, index, os.environ["HEAD"])
    verify_reads(json.loads(Path(os.environ["TRANSCRIPT"]).read_text()), directory, index)
    summary = subprocess.run(["bash", "-eo", "pipefail", "-c",
                              "source scripts/pr-review/lib.sh; strip_controls | scrub_secrets"],
                             input=result["summary"], capture_output=True, text=True, check=True).stdout
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as stream:
        stream.write("<pre>" + html.escape(summary[:30000]) + "</pre>\n")
    if not passed:
        raise SystemExit("Claude reported a blocking finding. See the job summary.")
