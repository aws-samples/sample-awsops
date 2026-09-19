#!/usr/bin/env python3
"""Validate bounded reviewer image-coverage declarations, independently of verdicts."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys

REPORT_LIMIT = 1024 * 1024
MANIFEST_LIMIT = 32768


def read_bytes(path, limit):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            raise ValueError("unavailable_report")
        data = stream.read(limit + 1)
    if len(data) > limit:
        raise ValueError("unavailable_report")
    return data


def read_data(path, limit):
    return read_bytes(path, limit).decode("utf-8")


def load_manifest(context):
    manifest = json.loads(read_data(Path(context).with_name("manifest.json"), MANIFEST_LIMIT))
    if (not isinstance(manifest, dict) or type(manifest.get("schema")) is not int or manifest["schema"] != 1
            or manifest.get("status") not in ("complete", "incomplete")
            or not isinstance(manifest.get("images"), list)
            or any(not isinstance(image, dict) for image in manifest["images"])
            or not isinstance(manifest.get("unavailable", []), list)
            or type(manifest.get("omitted_entries", 0)) is not int
            or manifest.get("omitted_entries", 0) < 0):
        raise ValueError("invalid_manifest")
    unavailable = bool(manifest.get("unavailable") or manifest.get("omitted_entries"))
    if (manifest["status"] == "incomplete") != unavailable:
        raise ValueError("inconsistent_manifest")
    return manifest


def required_images(context):
    manifest = load_manifest(context)
    return bool(manifest["images"] or manifest["status"] == "incomplete")


def attachment_paths(context):
    manifest = load_manifest(context)
    root = Path(context).absolute().parent
    if root.is_symlink() or any(p.is_symlink() for p in root.parents):
        raise ValueError("invalid_attachment_root")
    root = root.resolve(strict=True)
    paths, total = [], 0
    file_limit = manifest.get("limits", {}).get("files", 32)
    if type(file_limit) is not int or not 0 < file_limit <= 32 or len(manifest["images"]) > file_limit:
        raise ValueError("attachment_count_limit")
    for image in manifest["images"]:
        name, size, digest = image.get("file"), image.get("bytes"), image.get("sha256")
        if (not isinstance(name, str) or not re.fullmatch(r"image-[0-9]{4}\.png", name)
                or type(size) is not int or not 0 < size <= 8 * 1024 * 1024
                or not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest)):
            raise ValueError("invalid_attachment")
        total += size
        if total > 32 * 1024 * 1024:
            raise ValueError("attachment_total_limit")
        path = root / name
        data = read_bytes(path, 8 * 1024 * 1024)
        if len(data) != size or hashlib.sha256(data).hexdigest() != digest or path in paths:
            raise ValueError("attachment_mismatch")
        paths.append(path)
    return paths


def report_lines(text):
    """Shared normalized report lines, excluding fenced examples."""
    # Same terminal controls stripped before public synthesis; only LF creates lines.
    text = re.sub(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[()][0-9A-Z]", "", text)
    text = re.sub(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]", "", text)
    fence = None
    for line in text.split("\n"):
        if fence:
            if re.fullmatch(r" {0,3}" + re.escape(fence[0]) + "{" + str(fence[1]) + r",}[ \t]*", line):
                fence = None
            continue
        opening = re.match(r" {0,3}(`{3,}|~{3,})", line)
        if opening:
            fence = (opening[1][0], len(opening[1]))
            continue
        yield line


def complete_lens_sections(text):
    """Require substantive unquoted content for every checklist; merge continuations."""
    sections, current, depth = {}, None, 0
    for line in report_lines(text):
        heading = re.fullmatch(r" {0,3}(#{1,6})[ \t]+(?:\*\*)?(L[2-5])\b(.*)", line, re.IGNORECASE)
        if heading:
            suffix = heading[3].replace("**", "")
            # Topic references are not replacement sections for a missing checklist.
            if (re.match(r"[-–—]related\b", suffix, re.IGNORECASE)
                    or re.match(r"[ \t]*(?:&|/|,|and)[ \t]*L[2-5]\b", suffix, re.IGNORECASE)):
                heading = None
        if heading:
            current = heading[2].upper()
            sections.setdefault(current, [])
            depth = len(heading[1])
        else:
            other_heading = re.match(r" {0,3}(#{1,6})[ \t]+", line)
            if current and other_heading:
                if len(other_heading[1]) <= depth:
                    current = None
            elif current and not re.match(r"^[ \t]*(?:>|LENS_COVERAGE:|IMAGE_COVERAGE:)", line):
                sections[current].append(line)
    bodies = [" ".join(lines) for lines in sections.values()]
    return (set(sections) == {"L2", "L3", "L4", "L5"}
            and all(len(re.sub(r"\s", "", body)) >= 40
                    and len(re.findall(r"[^\W\d_]+", body)) >= 6 for body in bodies))


def validate_report(text, required, lens=False):
    prefix = "LENS_COVERAGE:" if lens else "IMAGE_COVERAGE:"
    complete = "L2,L3,L4,L5" if lens else "COMPLETE"
    signals = []
    for line in report_lines(text):
        # Reserved prefixes declare outcomes. Decoration cannot turn failure into prose.
        candidate = re.sub(r"^ {0,3}(?:(?:#{1,6}|[-*+]|\d+[.)])[ \t]+)?(?:\*\*|__|\*|_)?(?=(?:IMAGE[_ ]|LENS_))", "", line)
        if not lens and candidate.startswith("IMAGE COVERAGE FAILURE"):
            return False
        if candidate.startswith(prefix):
            if lens:
                match = re.fullmatch(r"LENS_COVERAGE:[ \t]*(L[2-5](?:[ \t]*,[ \t]*L[2-5]){3})[ \t]*", line)
                if not match or set(re.split(r"[ \t]*,[ \t]*", match[1])) != {"L2", "L3", "L4", "L5"}:
                    return False
                signals.append(complete)
            else:
                match = re.fullmatch(re.escape(prefix) + r"[ \t]*(COMPLETE|FAILED|NOT_REQUIRED)[ \t]*", line)
                if not match:
                    return False
                signals.append(match[1])
    # Duplicate/contradictory declarations cannot override an earlier failure.
    if len(signals) > 1 or "FAILED" in signals:
        return False
    return (signals == [complete] and (not lens or complete_lens_sections(text))) if required else True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("required", "unavailable", "attachments", "report", "lenses"))
    parser.add_argument("path")
    parser.add_argument("required", nargs="?", choices=("0", "1"), default="0")
    args = parser.parse_args()
    try:
        if args.mode == "required":
            print(int(required_images(args.path)))
            return 0
        if args.mode == "unavailable":
            print(int(load_manifest(args.path)["status"] == "incomplete"))
            return 0
        if args.mode == "attachments":
            paths = attachment_paths(args.path)
            sys.stdout.buffer.write(b"".join(os.fsencode(path) + b"\0" for path in paths))
            return 0
        if validate_report(read_data(args.path, REPORT_LIMIT), args.required == "1" or args.mode == "lenses", lens=args.mode == "lenses"):
            return 0
    except (OSError, ValueError, UnicodeError):
        if args.mode in ("report", "lenses"):
            print("Review output unavailable: invalid encoding, type, size or read.", file=sys.stderr)
            return 2
    print("Review coverage unavailable: missing, invalid, failed or unreadable declaration/evidence.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
