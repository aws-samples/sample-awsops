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
_REGION = r"[a-z]{2}(?:-gov|-iso[a-z]?)?-[a-z]+-\d"

REDACTORS = [
    (re.compile(r"arn:aws(?:-cn|-us-gov|-iso(?:-[a-z])?|-eusc)?:[^\s\"']+"), "<arn>"),
    # email BEFORE acct: an email local-part with 12+ digits would otherwise be partially
    # clobbered by the acct rule first.
    (re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"), "<email>"),
    (re.compile(r"(?<!\d)\d{12}(?!\d)"), "<acct>"),
    (re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b"), "<ip>"),
    (re.compile(r"\b(AKIA|ASIA)[A-Z0-9]{16}\b"), "<akid>"),
    # Resource endpoints name account resources: a label after the region (RDS/ELB/EC2/VPCE:
    # orders.cluster-x.<region>.rds.amazonaws.com) or a resource label before a service label
    # (bucket.s3.<region>, abc.execute-api.<region>, bucket.s3-<region>). Regional *service*
    # endpoints (sts.<region>.amazonaws.com) and service principals (ec2.amazonaws.com) are kept,
    # so connectivity errors still say which service was unreachable.
    (re.compile(r"\b(?:(?:[A-Za-z0-9-]+\.)+" + _REGION + r"\.(?:[A-Za-z0-9-]+\.)+"
                r"|(?:[A-Za-z0-9-]+\.){2,}" + _REGION + r"\."
                r"|(?:[A-Za-z0-9-]+\.)+s3-" + _REGION + r"\.)"
                r"amazonaws\.com(?:\.cn)?\b", re.IGNORECASE), "<host>"),
]

# Validate candidates rather than treating clock strings or citation IDs as IPs.
# Run before IPv4 substitution so IPv4-mapped IPv6 is scrubbed as one address.
# Every quantifier is bounded: textual IPv6 is at most 45 characters plus a zone id, so a long
# ":"/"." run in prompt text costs linear work instead of quadratic backtracking and retries.
IPV6_CANDIDATES = re.compile(
    r"(?<![A-Za-z0-9_.])(?:[0-9A-Fa-f]{0,4}:){2,9}[0-9A-Fa-f:.]{0,45}"
    r"(?:%[A-Za-z0-9_.-]{1,64})?(?![A-Za-z0-9_])")


def _ipv6(match):
    value = match.group(0)
    # The longest uncompressed IPv6 spelling (with a dotted IPv4 suffix) is 45 characters, so
    # validation tries at most 44 prefixes regardless of the source text or punctuation, and the
    # longest valid prefix wins ("2001:db8::1.ec2", "peer 2001:db8::1.").
    address, zone, _ = value.partition("%")
    for end in range(min(len(address), 45), 1, -1):
        try:
            ipaddress.IPv6Address(address[:end])
        except ValueError:
            continue
        suffix = value[len(value.rstrip(".:")):] if zone and end == len(address) else value[end:]
        return "<ip>" + suffix
    return value


def redact(text):
    """Scrub ARNs/account-ids/emails/IPs/access-keys from `text` before it reaches an LLM."""
    text = IPV6_CANDIDATES.sub(_ipv6, text)
    for pat, repl in REDACTORS:
        text = pat.sub(repl, text)
    return text
