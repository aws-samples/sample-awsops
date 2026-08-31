"""Helpers for v2 merge-gate invariant tests.

The checks intentionally avoid Terraform or HCL parser dependencies so they can
run in lightweight CI jobs before any infra tooling is initialized.
"""
import os
import re
import subprocess


_VARIABLE_RE = re.compile(r'(?m)^\s*variable\s+"([^"]+)"\s*\{')
_RESOURCE_RE = re.compile(r'(?m)^\s*resource\s+"([^"]+)"\s+"([^"]+)"\s*\{')
_GATE_RE = re.compile(r"(?m)^\s*(?:count|for_each)\s*=")


def tf_flag_defaults(tf_dir):
    """Return {variable_name: parsed_default} for every *_enabled Terraform var."""
    defaults = {}
    for filename in sorted(os.listdir(tf_dir)):
        if not filename.endswith(".tf"):
            continue
        path = os.path.join(tf_dir, filename)
        with open(path, encoding="utf-8") as f:
            text = f.read()
        for match, body in _iter_blocks(text, _VARIABLE_RE):
            name = match.group(1)
            if not name.endswith("_enabled"):
                continue
            default = _attribute_value(body, "default")
            defaults[name] = _parse_default(default) if default is not None else None
    return defaults


def ungated_resources(tf_file):
    """Return resource addresses whose body has no count or for_each gate line."""
    with open(tf_file, encoding="utf-8") as f:
        text = f.read()

    ungated = []
    for match, body in _iter_blocks(text, _RESOURCE_RE):
        if not _GATE_RE.search(body):
            ungated.append("%s.%s" % (match.group(1), match.group(2)))
    return ungated


def frozen_marker_present(variables_tf):
    """Check remediation_enabled's description still carries the freeze marker."""
    with open(variables_tf, encoding="utf-8") as f:
        text = f.read()

    for match, body in _iter_blocks(text, _VARIABLE_RE):
        if match.group(1) != "remediation_enabled":
            continue
        description = _attribute_value(body, "description")
        return description is not None and "DO NOT ENABLE" in description
    return False


def tracked_tfvars_enabling(root):
    """Return tracked tfvars entries that set any *_enabled flag to true."""
    proc = subprocess.run(
        [
            "git",
            "ls-files",
            "terraform/",
        ],
        cwd=root,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if proc.returncode != 0:
        return ["git ls-files failed: %s" % proc.stderr.strip()]

    offenders = []
    enabled_re = re.compile(r"^\s*([A-Za-z0-9_]+_enabled)\s*=\s*true\b", re.IGNORECASE)
    for relpath in proc.stdout.splitlines():
        if not (relpath.endswith(".tfvars") or relpath.endswith(".auto.tfvars")):
            continue
        path = os.path.join(root, relpath)
        with open(path, encoding="utf-8") as f:
            for line_no, line in enumerate(f, 1):
                line = _strip_inline_comment(line)
                match = enabled_re.match(line)
                if match:
                    offenders.append("%s:%d:%s" % (relpath, line_no, match.group(1)))
    return offenders


def _iter_blocks(text, header_re):
    for match in header_re.finditer(text):
        open_pos = match.end() - 1
        close_pos = _find_matching_brace(text, open_pos)
        yield match, text[open_pos + 1 : close_pos]


def _find_matching_brace(text, open_pos):
    depth = 0
    i = open_pos
    while i < len(text):
        if text.startswith("/*", i):
            i = _skip_until(text, i + 2, "*/")
            continue
        if text.startswith("//", i):
            i = _skip_line(text, i + 2)
            continue
        if text[i] == "#":
            i = _skip_line(text, i + 1)
            continue
        if text.startswith("<<", i):
            heredoc_end = _skip_heredoc(text, i)
            if heredoc_end != i:
                i = heredoc_end
                continue
        if text[i] == '"':
            i = _skip_string(text, i + 1)
            continue
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    raise ValueError("unclosed Terraform block")


def _attribute_value(body, name):
    attr_re = re.compile(r"(?m)^\s*%s\s*=\s*(.+)$" % re.escape(name))
    match = attr_re.search(body)
    if not match:
        return None
    return _strip_inline_comment(match.group(1)).strip()


def _parse_default(value):
    lowered = value.lower()
    if lowered == "false":
        return False
    if lowered == "true":
        return True
    return value


def _strip_inline_comment(line):
    in_string = False
    escaped = False
    for i, ch in enumerate(line):
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
            continue
        if ch == "#":
            return line[:i]
        if line.startswith("//", i):
            return line[:i]
    return line


def _skip_until(text, pos, token):
    end = text.find(token, pos)
    return len(text) if end == -1 else end + len(token)


def _skip_line(text, pos):
    end = text.find("\n", pos)
    return len(text) if end == -1 else end + 1


def _skip_string(text, pos):
    escaped = False
    while pos < len(text):
        ch = text[pos]
        if escaped:
            escaped = False
        elif ch == "\\":
            escaped = True
        elif ch == '"':
            return pos + 1
        pos += 1
    return pos


def _skip_heredoc(text, pos):
    line_end = text.find("\n", pos)
    if line_end == -1:
        return pos
    spec = text[pos + 2 : line_end].strip()
    if spec.startswith("-"):
        spec = spec[1:].strip()
    match = re.match(r"""["']?([A-Za-z_][A-Za-z0-9_-]*)["']?""", spec)
    if not match:
        return pos

    marker = match.group(1)
    scan = line_end + 1
    while scan < len(text):
        next_end = text.find("\n", scan)
        if next_end == -1:
            next_end = len(text)
        if text[scan:next_end].strip() == marker:
            return next_end + 1 if next_end < len(text) else next_end
        scan = next_end + 1
    return len(text)
