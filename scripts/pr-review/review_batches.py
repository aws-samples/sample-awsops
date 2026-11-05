#!/usr/bin/env python3
"""Complete, bounded review batches for diffs over the single-call admission limit.

A diff that fits one call keeps the original single review path exactly: one work
directory (/tmp/pr-review), the original diff file and the shared checklists. A larger
diff is split at file boundaries into at most `max_batches` batches. Each batch is
admitted with the same checks as a single diff, reviewed by both panel models and the
chair, and the PR passes only when every batch passes. A single file whose diff exceeds
the per-batch budget, or a diff that needs more batches than allowed, is rejected before
any model call: nothing is truncated or skipped.

Subcommands (workflow use only):
  admit <diff> <image-context> <root>   write <root>/batch-works.tsv; print ready/reason/batches
  env <root>                            aggregate per-batch GITHUB_ENV files (fail flags OR-ed)
  responded <root>                      print the per-batch reviewer response summary
  combine <root> <out>                  write the combined review; PASS only if all batches PASS
  fit <file> <max-bytes>                truncate a comment body at a line boundary, with a notice
"""

import json
import os
import re
import shutil
import sys
from pathlib import Path

LIMITS = json.loads(Path(__file__).with_name("review-limits.json").read_text())
MAX_BYTES = LIMITS["diff_bytes"]
MAX_LINES = LIMITS["diff_lines"]
MAX_BATCHES = LIMITS["max_batches"]
# GitHub rejects issue comments over 65,536 characters; keep headroom for the comment header.
if not 0 < LIMITS["comment_bytes"] <= 64000 or not 1 <= MAX_BATCHES <= 16:
    raise ValueError("Invalid batched review limits")
# Headroom inside each batch for secret redaction expanding the scrubbed copy, which
# admission re-measures against the full limit.
BATCH_BYTES = MAX_BYTES * 7 // 8
BATCH_LINES = MAX_LINES * 7 // 8
WORKS = "batch-works.tsv"
FAIL_FLAGS = ("report_invalid", "chair_input_failed", "chair_failed", "panel_incomplete",
              "image_coverage_failed")
HEADER = re.compile(rb"^diff --git ", re.M)
# Files matching this literal list are reviewed together in batch 1. It is a prioritization of
# the main permission surfaces, not a claim that every security-relevant file is co-located;
# other cross-batch dependencies are reported by each batch as unverified.
# Path prefixes (anchored at a path start) plus source files whose own name marks an IAM,
# policy, auth, guard, cross-account or remediation surface. Markdown is classified by prefix
# only, so docs that merely mention these words do not crowd batch 1.
SENSITIVE_PREFIX = re.compile(
    r"^(\.github/|scripts/pr-review/|terraform/|edge-lambda/|agent/|scripts/v2/remediation/"
    r"|scripts/v2/workers/([^/]*dispatcher|remediation|handlers|action_catalog|connector_target)"
    r"|web/app/api/|web/lib/remediation|web/middleware)")
SENSITIVE_NAME = re.compile(
    r"(^|/)[^/]*(iam|polic|auth|guard|cross[-_]account|remediat|admin|connector|mutat|secret"
    r"|credential|rbac|redact)[^/]*$", re.I)

PATH_LINE = re.compile(rb"^(diff --git |rename (from|to) |copy (from|to) |--- |\+\+\+ )")


def is_sensitive(part):
    """Classify on every header path line (old and new ends); unparseable headers fail closed."""
    header = []
    for line in part.split(b"\n"):
        if line.startswith(b"@@") or line.startswith(b"Binary files"):
            break
        if PATH_LINE.match(line):
            header.append(line)
    text = b"\n".join(header).decode("utf-8", "replace")
    if not header or '"' in text or "\\" in text or "\ufffd" in text:
        return True  # C-quoted, escaped, non-UTF-8 or missing paths: treat as sensitive
    paths = _header_paths(text)
    if not paths:
        return True  # headers present but no parseable path: fail closed
    for path in paths:
        if SENSITIVE_PREFIX.search(path):
            return True
        if not path.endswith(".md") and SENSITIVE_NAME.search(path):
            return True
    return False


def _header_paths(text):
    """Every old/new path named by the header lines (a/ and b/ prefixes stripped)."""
    paths = []
    for line in text.split("\n"):
        if line.startswith("diff --git "):
            rest = line[len("diff --git "):]
            # Unquoted header: "a/<old> b/<new>"; try every " b/" split so spaces cannot hide a path.
            if rest.startswith("a/"):
                body = rest[2:]
                paths.append(body)
                for index in [m.start() for m in re.finditer(" b/", body)]:
                    paths.extend([body[:index], body[index + 3:]])
        else:
            for prefix in ("rename from ", "rename to ", "copy from ", "copy to ", "--- ", "+++ "):
                if line.startswith(prefix):
                    value = line[len(prefix):]
                    paths.append(value[2:] if value[:2] in ("a/", "b/") else value)
    return [path for path in paths if path and path != "/dev/null"]


def chunks(data):
    """Split a filtered diff into per-file chunks; text before the first header joins chunk 1."""
    starts = [m.start() for m in HEADER.finditer(data)]
    if not starts:
        return [data] if data else []
    if starts[0] != 0:
        starts[0] = 0
    return [data[s:e] for s, e in zip(starts, starts[1:] + [len(data)])]


def group_sensitive(parts):
    """Move security-sensitive file diffs first, keeping relative order. None if they overflow."""
    flags = [is_sensitive(part) for part in parts]
    sensitive = [p for p, flag in zip(parts, flags) if flag]
    if (sum(map(len, sensitive)) > BATCH_BYTES
            or sum(p.count(b"\n") for p in sensitive) > BATCH_LINES):
        return None
    return sensitive + [p for p, flag in zip(parts, flags) if not flag]


def pack(parts):
    """Greedy, order-preserving packing. Returns None when one file exceeds the batch budget."""
    batches, current, size, lines = [], [], 0, 0
    for part in parts:
        part_lines = part.count(b"\n")
        if len(part) > BATCH_BYTES or part_lines > BATCH_LINES:
            return None
        if current and (size + len(part) > BATCH_BYTES or lines + part_lines > BATCH_LINES):
            batches.append(current)
            current, size, lines = [], 0, 0
        current.append(part)
        size += len(part)
        lines += part_lines
    if current:
        batches.append(current)
    return batches


def _note(index, total):
    """Trusted batch scope note. It contains no PR-derived text: file names stay in the diff."""
    return (
        f"\n\nBATCHED REVIEW: this diff is batch {index} of {total} of ONE pull request. The full "
        "filtered diff exceeds the single-call limit, so it was split at file boundaries; every "
        "batch is reviewed separately with the same checklists and the PR passes only if every "
        "batch passes. Batch 1 holds every file under .github/, scripts/pr-review/, terraform/, "
        "agent/, web/app/api/, scripts/v2/remediation/ and the worker dispatcher, handler, "
        "action-catalog, connector-target, remediation and web middleware paths, plus source "
        "files whose names mark IAM, policy, auth, guard, cross-account, admin, connector, "
        "mutation, secret, credential, RBAC, redaction or remediation code. That list is a "
        "prioritization, not a guarantee that every security-relevant file is in batch 1. Review "
        "the files in this batch.\n"
        "Cross-batch rule: a non-security symbol, import, test or doc that this batch relies on "
        "may be added by a file in another batch; report it as an unverified cross-batch "
        "dependency rather than as missing. This rule never lowers the severity of a security, "
        "IAM, authentication, AWS-mutation or secret finding; those stay blocking.\n"
        "Image evidence: the HEAD image context covers the whole PR, not only this batch. Apply "
        "the image-coverage rules to every image listed there, even when this batch's diff "
        "touches no image file.\n"
        "The VERDICT and output-format rules stated above still apply unchanged.\n"
    )


def admit(diff, context, root):
    from input_scope import admission  # same checks as a single diff, per batch

    root = Path(root)
    for stale in root.glob("batch-[0-9]*"):
        shutil.rmtree(stale, ignore_errors=True)
    works = root / WORKS
    works.unlink(missing_ok=True)
    omitted = os.environ.get("omitted_source_paths", "")
    data = Path(diff).read_bytes()
    lenses = root / "lenses"
    if len(data) <= MAX_BYTES and data.count(b"\n") <= MAX_LINES:
        # The single path reuses <root>, which can persist on a self-hosted runner.
        for stale in ("review.md", "github.env", "batch-note.txt"):
            (root / stale).unlink(missing_ok=True)
        ready, reason = admission(diff, context, omitted)
        if ready:
            works.write_text(f"{root}\t{diff}\t{lenses}\n")
        return ready, reason, 1
    if omitted:
        return False, "source lines were omitted; reformat them into reviewable lines", 0
    parts = group_sensitive(chunks(data))
    if parts is None:
        return False, ("security-sensitive changes (workflows, review scripts, Terraform/IAM, "
                       "auth) exceed one review batch; split the change"), 0
    batches = pack(parts)
    if batches is None:
        return False, ("one file's diff exceeds the per-batch review budget; split that file's "
                       "change"), 0
    if len(batches) > MAX_BATCHES:
        return False, f"diff needs more than {MAX_BATCHES} review batches; split the change", 0
    common = (lenses / "COMMON.txt").read_text()
    rows = []
    for index, batch in enumerate(batches, 1):
        work = root / f"batch-{index:02d}"
        (work / "lenses").mkdir(parents=True)
        batch_diff = work / "diff.txt"
        batch_diff.write_bytes(b"".join(batch))
        ready, reason = admission(str(batch_diff), context, omitted)
        if not ready:
            return False, f"batch {index}/{len(batches)}: {reason}", 0
        note = _note(index, len(batches))
        for lens in lenses.iterdir():
            if lens.is_file():
                shutil.copyfile(lens, work / "lenses" / lens.name)
        (work / "lenses" / "COMMON.txt").write_text(common + note, encoding="utf-8")
        (work / "batch-note.txt").write_text(note, encoding="utf-8")
        rows.append(f"{work}\t{batch_diff}\t{work / 'lenses'}\n")
    works.write_text("".join(rows))
    return True, f"complete input admitted in {len(batches)} review batches", len(batches)


def work_dirs(root):
    path = Path(root) / WORKS
    if not path.exists():
        return [Path(root)]
    return [Path(line.split("\t", 1)[0]) for line in path.read_text().splitlines() if line]


def _last_values(path):
    values = {}
    try:
        text = path.read_text(errors="replace")
    except OSError:
        return values
    for line in text.splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            values[key] = value
    return values


def aggregate_env(root):
    """Per batch the last write wins (as in the single path); across batches any 1 wins."""
    merged, chairs = {}, []
    for work in work_dirs(root):
        values = _last_values(work / "github.env")
        for key in FAIL_FLAGS:
            if key == "chair_failed":
                # synthesize.sh omits the key when its chair produced a verdict: absent = succeeded.
                merged.setdefault(key, []).append(values.get(key) == "1")
            elif key in values:
                merged.setdefault(key, []).append(values[key] == "1")
        if values.get("chair_used") and values["chair_used"] not in chairs:
            chairs.append(values["chair_used"])
    # chair_failed=1 means "no chair verdict exists" (the comment then says it is not a code
    # problem), so it holds only if EVERY batch's chair failed; a failed chair still fails the
    # gate through its own VERDICT: FAIL. Every other flag blocks if any batch set it.
    lines = [f"{key}={int(all(merged[key]) if key == 'chair_failed' else any(merged[key]))}"
             for key in FAIL_FLAGS if key in merged]
    if chairs:
        lines.append("chair_used=" + ", ".join(re.sub(r"[^A-Za-z0-9 ._-]", "?", c) for c in chairs))
    return lines


def responded(root):
    works = work_dirs(root)
    parts = []
    for index, work in enumerate(works, 1):
        try:
            cells = " ".join(work.joinpath("responded.txt").read_text().split())
        except OSError:
            cells = ""
        cells = re.sub(r"[^A-Za-z0-9/ ._-]", "?", cells) or "none"
        parts.append(cells if len(works) == 1 else f"batch {index}/{len(works)}: {cells}")
    return "; ".join(parts)


def combine(root, out):
    works = work_dirs(root)
    if len(works) == 1:
        source = works[0] / "review.md"
        shutil.copyfile(source, out) if source.exists() else Path(out).write_text("VERDICT: FAIL\n")
        return
    if not works:
        Path(out).write_text("No admitted review batch.\nVERDICT: FAIL\n")
        return
    sections, passed = [], True
    for index, work in enumerate(works, 1):
        try:
            text = (work / "review.md").read_text(encoding="utf-8", errors="replace")
        except OSError:
            text = "Batch review unavailable.\nVERDICT: FAIL\n"
        # Same rule as synthesize.sh's chair validation: the verdict is the last non-blank line.
        lines = text.rstrip().split("\n")
        if not lines or lines[-1] != "VERDICT: PASS":
            passed = False
        if lines and lines[-1].startswith("VERDICT:"):
            verdict = lines.pop()
        else:
            verdict = "VERDICT: FAIL (no verdict line)"
        sections.append(f"## Batch {index}/{len(works)} — {verdict.removeprefix('VERDICT: ')}\n\n"
                        + "\n".join(lines).strip() + "\n")
    body = (f"Reviewed in {len(works)} complete batches split at file boundaries; every batch "
            "must pass.\n\n" + "\n".join(sections))
    Path(out).write_text(body + "\n" + ("VERDICT: PASS" if passed else "VERDICT: FAIL") + "\n",
                         encoding="utf-8")


def fit(path, limit=None):
    limit = LIMITS["comment_bytes"] if limit is None else limit
    data = Path(path).read_bytes()
    if len(data) <= limit:
        return
    notice = ("\n\n_Review text truncated to fit the comment size limit; the complete batch "
              "reports are in the workflow log (\"Batch review\" groups of the chair step). "
              "The verdict above covers every batch._\n").encode()
    if limit <= len(notice):
        raise ValueError("comment limit smaller than the truncation notice")
    cut = data[: limit - len(notice)]
    cut = cut[: cut.rfind(b"\n") + 1] if b"\n" in cut else cut
    Path(path).write_bytes(cut.decode("utf-8", "ignore").encode() + notice)


def main(argv):
    command = argv[1] if len(argv) > 1 else ""
    if command == "admit" and len(argv) == 5:
        try:
            ready, reason, count = admit(argv[2], argv[3], argv[4])
        except (OSError, ValueError, UnicodeError, KeyError):
            ready, reason, count = False, "review input unreadable or invalid", 0
        # Fixed messages only: paths, provider errors and PR data never become outputs.
        print(f"ready={str(ready).lower()}")
        print(f"reason={reason}")
        print(f"batches={count}")
    elif command == "env" and len(argv) == 3:
        lines = aggregate_env(argv[2])
        if lines:
            print("\n".join(lines))
    elif command == "responded" and len(argv) == 3:
        print(responded(argv[2]))
    elif command == "combine" and len(argv) == 4:
        combine(argv[2], argv[3])
    elif command == "fit" and len(argv) in (3, 4):
        fit(argv[2], int(argv[3]) if len(argv) == 4 else None)
    else:
        print(__doc__, file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
