"""egress_dlp.py — Python parity of web/lib/egress-dlp.ts (ADR-040 §2 exfiltration defense).

Re-applied inside the executor (never trust the web layer). Pure (no I/O). Same patterns + entropy-gated
long-blob heuristic + size cap + channel allowlist as the TS version — the executor is the LAST hop, so
its redaction is the final guarantee before a message leaves to an external SaaS. Best-effort by design;
the human 4-eyes review of the dry-run preview is the real backstop.
"""
import re

_SIZE_CAP = 3000
_TRUNC = "…[truncated]"
_VARIETY_MIN = 12

_PATTERNS = [
    (re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"), "aws-key"),
    (re.compile(r"arn:aws:[a-z0-9-]*:[a-z0-9-]*:\d{0,12}:[^\s\"']+", re.I), "arn"),
    (re.compile(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+"), "jwt"),
    (re.compile(r"\bBearer\s+[A-Za-z0-9._-]+", re.I), "bearer"),
    (re.compile(r"aws_secret[a-z_]*\s*[=:]\s*\S+", re.I), "aws-secret"),
    (re.compile(
        r"\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}"
        r"|192\.168\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3})\b"), "private-ip"),
]
_BLOB = re.compile(r"[A-Za-z0-9+/]{40,}={0,2}|[0-9a-fA-F]{40,}")


def _redact_str(s, cats):
    for rx, cat in _PATTERNS:
        s, n = rx.subn(f"[REDACTED:{cat}]", s)
        if n:
            cats.add(cat)

    def _blob(m):
        t = m.group(0)
        if len(set(t)) < _VARIETY_MIN:   # low-entropy repeat → leave for the size cap (not a secret)
            return t
        cats.add("blob")
        return "[REDACTED:blob]"

    s = _BLOB.sub(_blob, s)
    if len(s) > _SIZE_CAP:
        cats.add("size-cap")
        s = s[: _SIZE_CAP - len(_TRUNC)] + _TRUNC
    return s


def _redact_val(v, cats):
    if isinstance(v, str):
        return _redact_str(v, cats)
    if isinstance(v, list):
        return [_redact_val(x, cats) for x in v]
    if isinstance(v, dict):
        return {k: _redact_val(val, cats) for k, val in v.items()}
    return v


def redact_egress(payload):
    """Redact secrets/internal data from EVERY string field (recurses). Returns (payload, sorted categories)."""
    cats = set()
    out = _redact_val(payload, cats)
    return out, sorted(cats)


class ChannelNotAllowed(Exception):
    pass


def assert_channel_allowed(channel, allowlist):
    """Raise unless `channel` is in `allowlist`. Empty/non-list allowlist = deny-all (fail-closed)."""
    if not isinstance(allowlist, list) or len(allowlist) == 0:
        raise ChannelNotAllowed("channel allowlist is empty (deny-all, fail-closed)")
    if channel not in allowlist:
        raise ChannelNotAllowed("channel %s is not in the allowlist" % channel)
