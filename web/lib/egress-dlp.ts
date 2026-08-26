// web/lib/egress-dlp.ts
// ADR-040 §2 exfiltration defense (RW-slice T2) — redact secrets/internal data from an outbound
// (egress-WRITE) payload before it can leave to an external SaaS, and enforce a destination
// (channel) allowlist. HONEST LIMIT: regex DLP is best-effort — the mandatory human 4-eyes review of
// the dry-run preview is the real backstop; this catches the obvious + a long-opaque-blob heuristic
// for encoded secrets, the allowlist bounds destinations, and the agent has no raw-secret-read tool.
// Applied at the web action gate AND re-applied in the Python executor (never trust the upstream).

const SIZE_CAP = 3000;
const TRUNC_MARKER = '…[truncated]';

// Specific secret/internal-data patterns → [REDACTED:<cat>].
const PATTERNS: { re: RegExp; cat: string }[] = [
  { re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, cat: 'aws-key' },
  { re: /arn:aws:[a-z0-9-]*:[a-z0-9-]*:\d{0,12}:[^\s"']+/gi, cat: 'arn' },
  { re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, cat: 'jwt' },
  { re: /\bBearer\s+[A-Za-z0-9._-]+/gi, cat: 'bearer' },
  { re: /aws_secret[a-z_]*\s*[=:]\s*\S+/gi, cat: 'aws-secret' },
  {
    re: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3})\b/g,
    cat: 'private-ip',
  },
];

// Long opaque base64/hex blob heuristic — catches RAW dumps / long encoded payloads. Entropy-gated:
// only a HIGH-VARIETY run is masked; a low-variety run (e.g. 'xxxx…') falls through to the size cap.
// HONEST LIMIT (P4 gate): this does NOT catch a SHORT encoded secret — a bare 20-char AWS key base64s
// to ~28 chars, below the 40-char floor, so it is NOT redacted. The regex is best-effort; the
// exfiltration backstop is the mandatory human 4-eyes review of the dry-run preview (ADR-040 §2), not
// this heuristic. (Lowering the floor would false-positive on legit tokens; the design relies on the
// human gate + propose-only + no raw-secret-read tool, not on perfect regex.)
const BLOB_RE = /[A-Za-z0-9+/]{40,}={0,2}|[0-9a-fA-F]{40,}/g;
const VARIETY_MIN = 12;

function redactString(input: string, cats: Set<string>): string {
  let s = input;
  for (const { re, cat } of PATTERNS) {
    s = s.replace(re, () => { cats.add(cat); return `[REDACTED:${cat}]`; });
  }
  s = s.replace(BLOB_RE, (m) => {
    if (new Set(m).size < VARIETY_MIN) return m; // low-entropy (repeat) → leave for the size cap
    cats.add('blob');
    return '[REDACTED:blob]';
  });
  if (s.length > SIZE_CAP) {
    cats.add('size-cap');
    s = s.slice(0, SIZE_CAP - TRUNC_MARKER.length) + TRUNC_MARKER;
  }
  return s;
}

function redactValue(v: unknown, cats: Set<string>): unknown {
  if (typeof v === 'string') return redactString(v, cats);
  if (Array.isArray(v)) return v.map((x) => redactValue(x, cats));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = redactValue(val, cats);
    return out;
  }
  return v;
}

/** Redact secrets/internal data from EVERY string field of an egress-write payload (recurses into
 *  nested blocks/attachments). Returns the redacted payload + the deduped list of redaction categories
 *  (NOT the secret values). Idempotent on already-clean text. */
export function redactEgress<T>(payload: T): { payload: T; redactions: string[] } {
  const cats = new Set<string>();
  const out = redactValue(payload, cats) as T;
  return { payload: out, redactions: [...cats] };
}

/** Throw unless `channel` is in `allowlist`. An empty/missing allowlist is DENY-ALL (fail-closed) —
 *  the destination must be explicitly admin-allowlisted on the integration (egress-write source_allowlist). */
export function assertChannelAllowed(channel: string, allowlist: string[]): void {
  if (!Array.isArray(allowlist) || allowlist.length === 0) {
    throw new Error('egress-dlp: channel allowlist is empty (deny-all, fail-closed)');
  }
  if (!allowlist.includes(channel)) {
    throw new Error(`egress-dlp: channel ${channel} is not in the allowlist`);
  }
}
