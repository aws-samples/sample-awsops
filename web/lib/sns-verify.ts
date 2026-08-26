// web/lib/sns-verify.ts
// AWS SNS HTTP(S) message verification for the incident webhook (CloudWatch-via-SNS ingress).
// Read-only auth (W1): signature (SignatureVersion 1=RSA-SHA1, 2=RSA-SHA256) + Timestamp
// freshness (replay guard) + cert validity/issuer + SSRF-safe cert fetch. No mutation.
// Never logs Signature / SigningCertURL / TopicArn / tokens — callers log only the {ok} result.
import { verify as cryptoVerify, createPublicKey, X509Certificate } from 'crypto';

export interface SnsMessage {
  Type?: string; MessageId?: string; TopicArn?: string; Timestamp?: string;
  Signature?: string; SignatureVersion?: string; SigningCertURL?: string;
  Message?: string; Subject?: string; SubscribeURL?: string; Token?: string;
  [k: string]: unknown;
}

export const SNS_HOST_PATTERN = /^https:\/\/sns\.[a-z0-9-]+\.amazonaws\.com\//;

// AWS SNS canonical string: keys in this fixed order, each "<key>\n<value>\n"; a key whose value
// is absent (e.g. Subject) is omitted entirely. (Per AWS SNS message-signature docs.)
const CANON_KEYS: Record<string, string[]> = {
  Notification: ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'],
  SubscriptionConfirmation: ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'],
  UnsubscribeConfirmation: ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'],
};

export function buildCanonicalString(m: SnsMessage): string {
  const keys = CANON_KEYS[String(m.Type)] || [];
  let out = '';
  for (const k of keys) {
    const v = (m as Record<string, unknown>)[k];
    if (v === undefined || v === null) continue;
    out += `${k}\n${String(v)}\n`;
  }
  return out;
}

export function isSnsCertUrlSafe(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  if (!SNS_HOST_PATTERN.test(url)) return false;
  // AWS SNS signing-cert path; tolerate an optional query string (presigned variants).
  if (!/\/SimpleNotificationService-[A-Za-z0-9]+\.pem$/.test(u.pathname)) return false;
  return true;
}

export function checkFreshness(timestamp: string | undefined, now: number, windowMs: number): boolean {
  const t = Date.parse(String(timestamp));
  if (Number.isNaN(t)) return false;
  return Math.abs(now - t) <= windowMs;
}

// X509 validity window + Amazon subject/issuer. Defense-in-depth on top of the host allowlist.
export function validateCert(pem: string, now: number): boolean {
  try {
    const c = new X509Certificate(pem);
    const from = Date.parse(c.validFrom);
    const to = Date.parse(c.validTo);
    if (Number.isNaN(from) || Number.isNaN(to) || now < from || now > to) return false;
    const subjectIssuer = `${c.subject || ''} ${c.issuer || ''}`;
    return /amazon|amazonaws\.com/i.test(subjectIssuer);
  } catch {
    return false;
  }
}

const ALG: Record<string, string> = { '1': 'RSA-SHA1', '2': 'RSA-SHA256' };
const DEFAULT_WINDOW_MS = 15 * 60_000;
const CERT_TTL_MS = 60 * 60_000;
const CERT_MAX_BYTES = 16 * 1024;
const CERT_CACHE_MAX = 256;
const certCache = new Map<string, { pem: string; exp: number }>();

// Fetch an SNS signing cert with SSRF + DoS guards: HTTP-error and oversize bodies are NEVER
// cached, and ONLY a body that parses as an X509Certificate is cached (so an attacker spraying
// random /SimpleNotificationService-*.pem paths cannot fill the cache with 404/HTML). The cache
// is size-bounded. Exported for testing.
export async function fetchSnsCert(url: string): Promise<string> {
  const cached = certCache.get(url);
  if (cached && cached.exp > Date.now()) return cached.pem;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error('cert http error');
    const lenHdr = Number(res.headers?.get?.('content-length') ?? '');
    if (Number.isFinite(lenHdr) && lenHdr > CERT_MAX_BYTES) throw new Error('cert too large');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > CERT_MAX_BYTES) throw new Error('cert too large');
    const pem = buf.toString('utf8');
    new X509Certificate(pem); // throws unless it is a real cert — never cache non-certs
    if (certCache.size >= CERT_CACHE_MAX) certCache.clear(); // bound memory (coarse eviction)
    certCache.set(url, { pem, exp: Date.now() + CERT_TTL_MS });
    return pem;
  } finally {
    clearTimeout(timer);
  }
}

export interface VerifyOpts {
  now?: number;
  freshnessMs?: number;
  fetchCert?: (url: string) => Promise<string>;
  validateCertFn?: (pem: string, now: number) => boolean;
}

// Verify a parsed SNS envelope. Order: cheap rejections (version/url/freshness) before any fetch.
export async function verifySnsMessage(m: SnsMessage, opts: VerifyOpts = {}): Promise<{ ok: boolean; reason?: string }> {
  const now = opts.now ?? Date.now();
  const windowMs = opts.freshnessMs ?? DEFAULT_WINDOW_MS;
  const fetchCert = opts.fetchCert ?? fetchSnsCert;
  const validateCertFn = opts.validateCertFn ?? validateCert;

  const alg = ALG[String(m.SignatureVersion)];
  if (!alg) return { ok: false, reason: 'bad_signature_version' };
  if (typeof m.SigningCertURL !== 'string' || !isSnsCertUrlSafe(m.SigningCertURL)) return { ok: false, reason: 'bad_cert_url' };
  if (!checkFreshness(m.Timestamp, now, windowMs)) return { ok: false, reason: 'stale' };
  if (typeof m.Signature !== 'string') return { ok: false, reason: 'no_signature' };

  let pem: string;
  try { pem = await fetchCert(m.SigningCertURL); } catch { return { ok: false, reason: 'cert_fetch_failed' }; }
  if (!validateCertFn(pem, now)) return { ok: false, reason: 'bad_cert' };

  try {
    const pub = createPublicKey(pem); // accepts an X.509 cert PEM or a public-key PEM
    const ok = cryptoVerify(alg, Buffer.from(buildCanonicalString(m), 'utf8'), pub, Buffer.from(m.Signature, 'base64'));
    return ok ? { ok: true } : { ok: false, reason: 'bad_signature' };
  } catch {
    return { ok: false, reason: 'verify_error' };
  }
}
