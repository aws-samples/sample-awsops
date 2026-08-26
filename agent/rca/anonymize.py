"""Mask identifiers before LLM calls (ADR: FSI anonymization, k8sgpt --anonymize pattern).
Stage-3 scope: resource IDs, pod names, IPs, ARNs, emails. Reversible via the returned mapping."""
import re

_IPV6_PATTERN = re.compile(
    r"(?<![0-9A-Fa-f:])(?:"
    r"(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}|"
    r"(?:[0-9A-Fa-f]{1,4}:){1,7}:|"
    r"(?:[0-9A-Fa-f]{1,4}:){1,6}:[0-9A-Fa-f]{1,4}|"
    r"(?:[0-9A-Fa-f]{1,4}:){1,5}(?::[0-9A-Fa-f]{1,4}){1,2}|"
    r"(?:[0-9A-Fa-f]{1,4}:){1,4}(?::[0-9A-Fa-f]{1,4}){1,3}|"
    r"(?:[0-9A-Fa-f]{1,4}:){1,3}(?::[0-9A-Fa-f]{1,4}){1,4}|"
    r"(?:[0-9A-Fa-f]{1,4}:){1,2}(?::[0-9A-Fa-f]{1,4}){1,5}|"
    r"[0-9A-Fa-f]{1,4}:(?:(?::[0-9A-Fa-f]{1,4}){1,6})|"
    r":(?:(?::[0-9A-Fa-f]{1,4}){1,7}|:)"
    r")(?![0-9A-Fa-f:])"
)

_PATTERNS = [
    re.compile(r"arn:aws:[^\s\"']+"),                       # ARNs
    re.compile(r"\b(?:i|vol|eni|vpc|subnet|sg|ami|igw|nat|rtb|acl)-[0-9a-z]{8,17}\b", re.IGNORECASE),  # AWS resource IDs
    _IPV6_PATTERN,                                           # IPv6
    re.compile(r"\b[a-z0-9-]+-[a-f0-9]{8,10}-[a-z0-9]{4,5}\b"),  # k8s pod hash suffix
    re.compile(r"\b\d{1,3}(?:\.\d{1,3}){3}\b"),             # IPv4
    re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b"),            # email
]

def anonymize(text):
    mapping, counter, masked = {}, {"n": 0}, text
    seen = {}
    def repl(m):
        orig = m.group(0)
        if orig not in seen:
            counter["n"] += 1
            tok = f"ENT_{counter['n']}"
            seen[orig] = tok
            mapping[tok] = orig
        return seen[orig]
    for pat in _PATTERNS:
        masked = pat.sub(repl, masked)
    return masked, mapping

def deanonymize(text, mapping):
    if not mapping:
        return text
    tokens = sorted(mapping, key=len, reverse=True)
    pattern = re.compile(r"\b(?:" + "|".join(re.escape(tok) for tok in tokens) + r")\b")
    return pattern.sub(lambda m: mapping[m.group(0)], text)
