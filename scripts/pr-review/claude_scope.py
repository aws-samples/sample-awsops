"""Prepare complete, numbered Git patches for the official Claude review action."""
import json
import os
from pathlib import Path
import subprocess
import sys

from image_coverage import attachment_paths, load_manifest

# Each Action invocation has one Bedrock session. Ordinary PRs use one job.
JOB_BYTES = 120 * 1024
PAGE_BYTES = 16 * 1024
MAX_FILE_BYTES = 192 * 1024
MAX_JOBS = 128


def git(*args):
    return subprocess.check_output(["git", "--literal-pathspecs", *args])


def pages(patch):
    # Bound even a generated one-line file. Split decoded characters, never UTF-8 bytes.
    # Display non-UTF-8 bytes explicitly and keep long lines inside the Read tool's
    # per-line display limit. Every segment of a continued source line is retained.
    text = patch.decode("utf-8", errors="backslashreplace")
    text = "\n".join("\n[continued] ".join(line[i:i + 1000] for i in range(0, len(line), 1000))
                     for line in text.split("\n"))
    while text:
        end = min(len(text), PAGE_BYTES)
        while len(text[:end].encode()) > PAGE_BYTES:
            end = max(1, end * 3 // 4)
        lines = text[:end].splitlines(keepends=True)
        if len(lines) > 600:
            end = sum(map(len, lines[:600]))
        elif end < len(text):
            newline = text.rfind("\n", end // 2, end)
            if newline >= 0:
                end = newline + 1
        yield text[:end]
        text = text[end:]


def prepare(base, head, directory):
    manifest = load_manifest(directory / "images/context.txt")
    if manifest["status"] != "complete" or manifest["head"] != head or manifest["merge_base"] != base:
        raise ValueError("Incomplete HEAD image coverage")
    attachment_paths(directory / "images/context.txt")
    names = git("diff", "--no-renames", "--name-only", "-z", base, head, "--").split(b"\0")
    jobs = [[]]
    size = 0
    for raw_name in filter(None, names):
        path = os.fsdecode(raw_name)
        filename = Path(path)
        generated = filename.name in {"package-lock.json", "pnpm-lock.yaml", "yarn.lock", ".terraform.lock.hcl"}
        generated |= any(part in {"node_modules", "dist", "out", "build"} for part in filename.parts[:-1])
        if generated:
            patch = git("diff", "--raw", "--no-abbrev", "--no-renames", base, head, "--", path)
            patch += b"[generated content; Git object IDs retained]\n"
        else:
            patch = git("diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color",
                        "--full-index", base, head, "--", path)
        if not patch:
            raise ValueError("Missing patch for a changed path")
        if b"\nBinary files " in patch and filename.suffix.lower() not in {
            ".png", ".webp", ".ico", ".jpg", ".jpeg", ".gif", ".pptx", ".pdf", ".zip", ".vsix",
        }:
            raise ValueError("Unsupported binary change needs a reviewable representation")
        patch = subprocess.run(["bash", "-eo", "pipefail", "-c",
                                "source scripts/pr-review/lib.sh; strip_controls | scrub_secrets"],
                               input=patch, capture_output=True, check=True).stdout
        if not patch.strip():
            raise ValueError("Empty scrubbed patch")
        parts = list(pages(patch))
        length = sum(len(page.encode()) for page in parts)
        if length > MAX_FILE_BYTES or len(parts) > 40:
            raise ValueError("A change to a single file exceeds 192 KiB or 40 pages")
        if jobs[-1] and (size + length > JOB_BYTES or len(jobs[-1]) + len(parts) > 40):
            jobs.append([])
            size = 0
        if len(jobs) > MAX_JOBS:
            raise ValueError("Review exceeds the Actions job budget")
        for part, page in enumerate(parts, 1):
            group = directory / str(len(jobs))
            group.mkdir(exist_ok=True)
            name = f"page-{len(jobs[-1])+1:03}.txt"
            (group / name).write_text(page)
            jobs[-1].append({"path": path, "part": part, "page": name})
            size += len(page.encode())
    for index, entries in enumerate(jobs, 1):
        group = directory / str(index)
        group.mkdir(exist_ok=True)
        (group / "index.json").write_text(json.dumps({
            "head": head, "pages": entries, "images": manifest["images"],
            "deleted_images": manifest["deleted"],
        }, ensure_ascii=True))
        yield {"group": index}


if __name__ == "__main__":
    print(json.dumps(list(prepare(sys.argv[1], sys.argv[2], Path(sys.argv[3])))))
