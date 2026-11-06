"""Shared PII/secret redaction — deterministic scrub of ARNs/account-ids/emails/IPs/access-keys
before ANY Bedrock call. Extracted from diagnosis/report.py's original [GATE-FIX CRITICAL]
comment ("PII/secret redaction BEFORE any Bedrock call — spec §9 mandatory") so every LLM caller
in this worker tier shares the exact same patterns instead of each re-deriving a slightly
different regex set (a PR review caught finops/llm.py sending unredacted ARNs/account-ids to
Bedrock because it never called this at all).
CloudTrail Username and other identity fields are stripped at the collector (sources.py) —
this module only scrubs the assembled prompt text itself."""
import ipaddress
import re

# The account-id pattern uses negative lookarounds so it only matches a STANDALONE 12-digit run
# (an account id), not a slice of a longer/embedded number.
REDACTORS = [
    (re.compile(r"arn:aws(?:-cn|-us-gov|-iso(?:-[a-z])?|-eusc)?:[^\s\"']+"), "<arn>"),
    # email BEFORE acct: an email local-part with 12+ digits would otherwise be partially
    # clobbered by the acct rule first.
    (re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"), "<email>"),
    (re.compile(r"(?<!\d)\d{12}(?!\d)"), "<acct>"),
    (re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b"), "<ip>"),
    (re.compile(r"\b(AKIA|ASIA)[A-Z0-9]{16}\b"), "<akid>"),
]

# Validate candidates rather than treating clock strings or citation IDs as IPs.
# Run before IPv4 substitution so IPv4-mapped IPv6 is scrubbed as one address.
IPV6_CANDIDATES = re.compile(
    r"(?<![A-Za-z0-9_.])(?:[0-9A-Fa-f]{0,4}:){2,}[0-9A-Fa-f:.]*"
    r"(?:%[A-Za-z0-9_.-]+)?(?![A-Za-z0-9_])")


def _ipv6(match):
    value = match.group(0)
    # Sentence punctuation ("peer 2001:db8::1.") is eaten by the greedy body: retry without
    # trailing [.:] characters and re-emit them after the placeholder.
    for end in range(len(value.rstrip(".:")), len(value) + 1):
        try:
            ipaddress.IPv6Address(value[:end])
        except ValueError:
            continue
        return "<ip>" + value[end:]
    return value


def redact(text):
    """Scrub ARNs/account-ids/emails/IPs/access-keys from `text` before it reaches an LLM."""
    text = IPV6_CANDIDATES.sub(_ipv6, text)
    for pat, repl in REDACTORS:
        text = pat.sub(repl, text)
    return text
