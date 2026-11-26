"""Prepare complete, numbered Git patches for the official Claude review action."""
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys

from image_coverage import attachment_paths, load_manifest

# Each Action invocation has one Bedrock session. Ordinary PRs use one job.
JOB_BYTES = 120 * 1024
PAGE_BYTES = 16 * 1024
MAX_JOBS = 128


def git(*args):
    return subprocess.check_output(["git", "--literal-pathspecs", *args])


def pages(patch):
    # Bound even a generated one-line file. Split decoded characters, never UTF-8 bytes.
    text = patch.decode("utf-8")
    while text:
        end = min(len(text), PAGE_BYTES)
        while len(text[:end].encode()) > PAGE_BYTES:
            end = max(1, end * 3 // 4)
        if end < len(text):
            newline = text.rfind("\n", end // 2, end)
            if newline >= 0:
                end = newline + 1
        yield text[:end]
        text = text[end:]


def prepare(base, head, directory):
    manifest = load_manifest(directory / "images/context.txt")
    if manifest["status"] != "complete":
        raise ValueError("Incomplete HEAD image coverage")
    attachment_paths(directory / "images/context.txt")
    names = git("diff", "--no-renames", "--name-only", "-z", base, head, "--").split(b"\0")
    jobs = [[]]
    size = 0
    for raw_name in filter(None, names):
        path = os.fsdecode(raw_name)
        patch = git("diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color",
                    "--full-index", base, head, "--", path)
        if not patch:
            raise ValueError("Missing patch for a changed path")
        # Generated lockfiles are still identified by their complete Git object IDs.
        if Path(path).name in {"package-lock.json", "pnpm-lock.yaml", "yarn.lock", ".terraform.lock.hcl"}:
            patch = patch.split(b"\n@@ ", 1)[0] + b"\n[generated dependency lockfile; inspect dependency source and CI]\n"
        elif b"\nBinary files " in patch and Path(path).suffix.lower() not in {
            ".png", ".webp", ".ico", ".pptx", ".pdf", ".zip", ".vsix",
        }:
            raise ValueError("Unsupported binary change needs a reviewable representation")
        patch = subprocess.run(["bash", "-eo", "pipefail", "-c",
                                "source scripts/pr-review/lib.sh; strip_controls | scrub_secrets"],
                               input=patch, capture_output=True, check=True).stdout
        if not patch.strip():
            raise ValueError("Empty scrubbed patch")
        if size and size + len(patch) > JOB_BYTES:
            jobs.append([])
            size = 0
        for part, page in enumerate(pages(patch), 1):
            if (size and size + len(page.encode()) > JOB_BYTES) or len(jobs[-1]) >= 40:
                jobs.append([])
                size = 0
            if len(jobs) > MAX_JOBS:
                raise ValueError("Review exceeds the Actions job budget")
            group = directory / str(len(jobs))
            group.mkdir(exist_ok=True)
            name = f"page-{len(jobs[-1])+1:03}.txt"
            (group / name).write_text(page)
            jobs[-1].append({"path": path, "part": part, "page": name})
            size += len(page.encode())
    for index, entries in enumerate(jobs, 1):
        group = directory / str(index)
        group.mkdir(exist_ok=True)
        # Each page has an independent receipt. A missing or truncated read cannot pass
        # by echoing the index. The validator receives only the ordered digest.
        receipts = []
        for entry in entries:
            receipt = secrets.token_hex(8)
            with (group / entry["page"]).open("a") as stream:
                stream.write("\nEND OF REVIEW PAGE " + receipt + "\n")
            receipts.append(receipt)
        (group / "index.json").write_text(json.dumps({
            "head": head, "pages": entries, "images": manifest["images"] if index == 1 else [],
            "deleted_images": manifest["deleted"] if index == 1 else [],
        }, ensure_ascii=True))
        # Keep validation data out of the published packet and the model's workspace.
        digest = hashlib.sha256(" ".join(receipts).encode()).hexdigest()
        yield {"group": index, "digest": digest}


if __name__ == "__main__":
    print(json.dumps(list(prepare(sys.argv[1], sys.argv[2], Path(sys.argv[3])))))
