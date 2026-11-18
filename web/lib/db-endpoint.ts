// Pure extraction of AWS managed-datastore hostnames from config values.
// SECURITY: values may embed credentials (connection strings). Only the bare,
// lower-cased host is ever returned — never userinfo, port, path or raw value.

export type DbKind = 'rds' | 'elasticache' | 'opensearch' | 'msk';

const MAX_INPUT = 4096;
const MAX_HOSTS = 20;
const MAX_HOST_LENGTH = 253;

// Tokens are the runs between whitespace and URL/list/query delimiters ('&' included, so a host
// followed by `&sslmode=…` is found). ':' is NOT a delimiter: it is handled per token, so only a
// numeric port (or a known scheme prefix) is ever dropped from a token.
const TOKEN_RE = /[^\s,;"'=@/?#&<>()[\]{}\\|]+/g;
const CANDIDATE_RE = /^([a-z0-9]([a-z0-9.-]*[a-z0-9])?)(:\d{1,5})?$/;
// One DNS label: 1–63 chars, alphanumeric at both ends, hyphens inside.
const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
// Scheme-like prefixes written without '//' (e.g. `tcp:host:5432`, `rediss:host:6379`).
const SCHEME_PREFIX_RE = /^(tcp|udp|tls|ssl|redis|rediss|http|https|jdbc|postgres|postgresql|mysql|mariadb|mongodb|amqp|amqps|kafka|plaintext|sasl_ssl|sasl_plaintext):/;
// A credential-looking key immediately before the candidate: `password=`, `DB_PASSWORD: "`, `"secret": "`.
const KEY_BEFORE_RE = /([A-Za-z0-9_.-]+)["']?\s*[=:]\s*["']?$/;
const CREDENTIAL_WORDS = new Set(['password', 'passwd', 'pwd', 'secret', 'token', 'key']);

const KIND_PATTERNS: [DbKind, RegExp][] = [
  ['rds', /\.rds\.amazonaws\.com(\.cn)?$/],
  ['elasticache', /\.cache\.amazonaws\.com(\.cn)?$/],
  ['opensearch', /\.(es|aoss)\.amazonaws\.com(\.cn)?$/],
  ['msk', /\.kafka(-serverless)?\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/],
];

/** Every label is a valid DNS label (no empty, over-long or hyphen-edged labels) and the name fits 253 chars. */
const validHostname = (host: string) => host.length <= MAX_HOST_LENGTH && host.split('.').every((l) => LABEL_RE.test(l));

/** `password=`, `db_password: "`, `redis.auth-token =`, `apiKey=` … — any key segment is a credential word. */
function credentialKeyBefore(before: string): boolean {
  const m = KEY_BEFORE_RE.exec(before);
  if (!m) return false;
  // Segments split on punctuation and camelCase boundaries (`dbPassword`, `APIKey`), case-insensitive.
  // (No regex lookbehind: this module also ships in the client bundle.)
  return m[1].replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/).some((seg) => CREDENTIAL_WORDS.has(seg.toLowerCase()));
}

export function extractManagedDbHosts(value: string): { host: string; kind: DbKind }[] {
  if (typeof value !== 'string' || value.length === 0) return [];
  const input = value.slice(0, MAX_INPUT);
  const out: { host: string; kind: DbKind }[] = [];
  const seen = new Set<string>();
  for (const t of input.matchAll(TOKEN_RE)) {
    const start = t.index ?? 0;
    const end = start + t[0].length;
    // Userinfo is tokenized separately from the host: a token directly followed by '@' (user,
    // password, or a fragment of a password containing delimiters / several '@') is never a host.
    if (input[end] === '@') continue;
    // A host-shaped value assigned to a credential key (`password=abc.rds.amazonaws.com`) is a
    // credential, not a reference.
    if (credentialKeyBefore(input.slice(Math.max(0, start - 128), start))) continue;
    let token = t[0].toLowerCase();
    for (let i = 0; i < 3 && SCHEME_PREFIX_RE.test(token); i++) token = token.replace(SCHEME_PREFIX_RE, '');
    const m = CANDIDATE_RE.exec(token);
    if (!m) continue;
    const host = m[1];
    if (seen.has(host) || !validHostname(host)) continue;
    const kind = KIND_PATTERNS.find(([, re]) => re.test(host))?.[0];
    if (!kind) continue;
    seen.add(host);
    out.push({ host, kind });
    if (out.length >= MAX_HOSTS) break;
  }
  return out;
}
