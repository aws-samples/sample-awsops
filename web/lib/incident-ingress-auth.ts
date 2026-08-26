// web/lib/incident-ingress-auth.ts
// Envelope-first ingress auth for the incident webhook (W1). Auth NEVER trusts headers/source
// hints. SNS envelopes (Type) go through SNS signature verification; direct POSTs use a bearer
// token (Alertmanager) or HMAC (custom senders). TopicArn allowlist comes from the integrations
// table's `source_allowlist` JSONB (ingress cloudwatch_sns rows), fail-closed.
import { createHmac, createHash, timingSafeEqual } from 'crypto';
import { detectAlertSource, type AlertSource } from './incident-normalize';

const SNS_TYPES = new Set(['Notification', 'SubscriptionConfirmation', 'UnsubscribeConfirmation']);

export type Envelope = 'sns' | 'direct';

/** Classify by `body.Type` ONLY — never by headers (no scheme impersonation). */
export function classifyEnvelope(body: Record<string, unknown>): Envelope {
  return SNS_TYPES.has(String(body?.Type)) ? 'sns' : 'direct';
}

export type AllowlistQuery = () => Promise<Array<{ source_allowlist?: unknown }>>;

/** True iff `topicArn` is a member of the `source_allowlist` of some enabled ingress
 *  cloudwatch_sns integration. Fail-closed on empty/error (no row ⇒ reject). */
export async function isTopicAllowed(topicArn: string | undefined, queryFn: AllowlistQuery): Promise<boolean> {
  if (!topicArn) return false;
  try {
    const rows = await queryFn();
    for (const r of rows || []) {
      const a = r?.source_allowlist;
      if (Array.isArray(a) && a.includes(topicArn)) return true;
    }
    return false;
  } catch {
    return false; // fail-closed
  }
}

type AuthResult = { ok: boolean; matched?: 'active' | 'standby' };

// Length-safe constant-time token compare: hash both to fixed 32 bytes so timingSafeEqual never
// throws on unequal lengths and no length is leaked.
function tokenEquals(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

export function verifyBearer(authHeader: string | null | undefined, secrets: Array<string | undefined>): AuthResult {
  const m = /^Bearer\s+(.+)$/.exec(authHeader || '');
  if (!m) return { ok: false };
  const token = m[1];
  const labels: Array<'active' | 'standby'> = ['active', 'standby'];
  for (let i = 0; i < secrets.length; i++) {
    const s = secrets[i];
    if (!s) continue;
    if (tokenEquals(token, s)) return { ok: true, matched: labels[i] };
  }
  return { ok: false };
}

// HMAC-SHA256 (ADR-022 active/standby) — moved verbatim from the route for the direct-custom path.
export function verifyHmac(body: string, signature: string, secrets: Array<string | undefined>): AuthResult {
  const sig = (signature || '').replace(/^sha256=/, '');
  let sigBuf: Buffer;
  try { sigBuf = Buffer.from(sig, 'hex'); } catch { return { ok: false }; }
  const labels: Array<'active' | 'standby'> = ['active', 'standby'];
  for (let i = 0; i < secrets.length; i++) {
    const s = secrets[i];
    if (!s) continue;
    try {
      const expected = createHmac('sha256', s).update(body).digest('hex');
      const expBuf = Buffer.from(expected, 'hex');
      if (sigBuf.length === expBuf.length && timingSafeEqual(sigBuf, expBuf)) return { ok: true, matched: labels[i] };
    } catch {
      // try next
    }
  }
  return { ok: false };
}

const ALLOWED_SOURCES: readonly string[] = ['cloudwatch', 'alertmanager', 'grafana', 'sqs', 'generic'];

/** Post-auth normalization source. SNS ⇒ always 'cloudwatch'. Otherwise honor an explicit header
 *  hint ONLY if it is a valid AlertSource, else detect from the body. Never affects auth. */
export function resolveSourceHint(body: Record<string, unknown>, headerHint?: string | null): AlertSource {
  if (classifyEnvelope(body) === 'sns') return 'cloudwatch';
  if (headerHint && ALLOWED_SOURCES.includes(headerHint)) return headerHint as AlertSource;
  return detectAlertSource(body);
}
