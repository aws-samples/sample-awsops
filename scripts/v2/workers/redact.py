"""Shared PII/secret redaction — deterministic scrub of ARNs/account-ids/emails/IPs/access-keys
before ANY Bedrock call. Extracted from diagnosis/report.py's original [GATE-FIX CRITICAL]
comment ("PII/secret redaction BEFORE any Bedrock call — spec §9 mandatory") so every LLM caller
in this worker tier shares the exact same patterns instead of each re-deriving a slightly
different regex set (a PR review caught finops/llm.py sending unredacted ARNs/account-ids to
Bedrock because it never called this at all).
CloudTrail Username and other identity fields are stripped at the collector (sources.py) —
this module only scrubs the assembled prompt text itself."""
import re

# The account-id pattern uses negative lookarounds so it only matches a STANDALONE 12-digit run
# (an account id), not a slice of a longer/embedded number.
REDACTORS = [
    (re.compile(r"arn:aws:[^\s\"']+"), "<arn>"),
    # email BEFORE acct: an email local-part with 12+ digits would otherwise be partially
    # clobbered by the acct rule first.
    (re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"), "<email>"),
    (re.compile(r"(?<!\d)\d{12}(?!\d)"), "<acct>"),
    (re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b"), "<ip>"),
    (re.compile(r"\b(AKIA|ASIA)[A-Z0-9]{16}\b"), "<akid>"),
]


def redact(text):
    """Scrub ARNs/account-ids/emails/IPs/access-keys from `text` before it reaches an LLM."""
    for pat, repl in REDACTORS:
        text = pat.sub(repl, text)
    return text
