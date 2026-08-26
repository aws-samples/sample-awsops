// web/app/api/incidents/webhook/route.ts
// ADR-032 incident ingress — HMAC webhook (ADR-022 active/standby rotation), PORTED from
// src/app/api/alert-webhook/route.ts (verifySignature + rate-limit + extractClientIp + SNS
// subscription-confirm), ADAPTED to the v2 thin-BFF (root path, node-pg Triage, SSM secrets).
//
// SAFETY (autonomous incident lifecycle shipped OFF):
//   - The env flag is checked FIRST: when INCIDENT_LIFECYCLE_ENABLED !== 'true' this route
//     returns 503 and does NOT accept, HMAC-verify, normalize, triage, or enqueue ANYTHING.
//     There is NO autonomous trigger when off (BINDING). The Triage layer (Task 2) is a second
//     line of defense (it also returns {decision:'disabled'} when off).
//   - Alert payloads are attacker-controlled. We HMAC-verify (ADR-022) before any processing,
//     and only isolated/descriptive data (incident-normalize.isolatePayload) ever flows toward
//     the agent tier — nothing here influences tool perms / sub-agent roster / approval.
//   - This route NEVER executes a mutation. On accept it does Triage (DB write of the incident
//     row) + enqueue of the FIRST stage onto the P2 backbone — the heavy/long investigation runs
//     in the worker/SM tier, not the web tier (thin-BFF rule).
//   - The HMAC secret(s) come from SSM (read once, cached), NOT app-config.
import { NextResponse } from 'next/server';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { normalizeAlert, isolatePayload, bearsSelfWritebackMarker } from '@/lib/incident-normalize';
import { triageAndCreateOrLink, enqueueInitialStage } from '@/lib/incident';
import { verifySnsMessage } from '@/lib/sns-verify';
import { classifyEnvelope, isTopicAllowed, verifyBearer, verifyHmac, resolveSourceHint } from '@/lib/incident-ingress-auth';
import { readTextBounded, BodyTooLargeError } from '@/lib/http-body';
import { getPool } from '@/lib/db';

// Cap the inbound webhook body before parse — alert payloads are small; large bodies are DoS.
const MAX_BODY_BYTES = 512 * 1024;

export const dynamic = 'force-dynamic';

const REGION = process.env.AWS_REGION || 'ap-northeast-2';

// --- Rate limiting (PORTED): per-source IP, 60 requests/min, bounded map ---
const rateLimitMap: Map<string, { count: number; resetAt: number }> = new Map();
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;
const MAX_RATE_ENTRIES = 10_000;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  if (rateLimitMap.size > MAX_RATE_ENTRIES) {
    Array.from(rateLimitMap.entries()).forEach(([key, entry]) => {
      if (now > entry.resetAt) rateLimitMap.delete(key);
    });
  }
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_LIMIT;
}

// --- Client IP (PORTED): behind CloudFront + ALB, the real client is second-to-last ---
function extractClientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for') || '';
  const ips = forwarded.split(',').map((s) => s.trim()).filter(Boolean);
  return ips.length >= 2 ? ips[ips.length - 2] : ips[0] || 'unknown';
}

// HMAC verify (ADR-022 active/standby) now lives in @/lib/incident-ingress-auth as verifyHmac.

// --- HMAC secret(s) from SSM (read once, cached) — NOT app-config ---
const TTL_MS = 5 * 60 * 1000;
let ssm: SSMClient | null = null;
const secretCache: Record<string, { value: string | undefined; at: number }> = {};

async function readSsm(name: string | undefined): Promise<string | undefined> {
  if (!name) return undefined;
  const c = secretCache[name];
  if (c && Date.now() - c.at < TTL_MS) return c.value;
  if (!ssm) ssm = new SSMClient({ region: REGION });
  try {
    const r = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
    const value = r.Parameter?.Value || undefined;
    secretCache[name] = { value, at: Date.now() };
    return value;
  } catch {
    return undefined; // degrade-safe: an absent param means that secret is simply not configured
  }
}

async function hmacSecrets(): Promise<Array<string | undefined>> {
  const [active, standby] = await Promise.all([
    readSsm(process.env.SSM_INCIDENT_HMAC_SECRET_PARAM),
    readSsm(process.env.SSM_INCIDENT_HMAC_STANDBY_PARAM),
  ]);
  return [active, standby];
}

// Bearer token(s) for Alertmanager (Authorization: Bearer …). Active/standby like HMAC; absent
// param → undefined → degrade-safe (the direct path falls back to HMAC).
async function bearerSecrets(): Promise<Array<string | undefined>> {
  const [active, standby] = await Promise.all([
    readSsm(process.env.SSM_INCIDENT_BEARER_PARAM),
    readSsm(process.env.SSM_INCIDENT_BEARER_STANDBY_PARAM),
  ]);
  return [active, standby];
}

// --- SNS subscription confirmation: only reached AFTER signature + TopicArn allowlist pass.
// Re-check the SubscribeURL host immediately before fetch + bounded timeout (SSRF/hang guard). ---
const SNS_URL_PATTERN = /^https:\/\/sns\.[a-z0-9-]+\.amazonaws\.com\//;

async function confirmSnsSubscription(body: Record<string, unknown>): Promise<NextResponse> {
  const subscribeUrl = body.SubscribeURL;
  if (typeof subscribeUrl === 'string' && SNS_URL_PATTERN.test(subscribeUrl)) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const res = await fetch(subscribeUrl, { signal: ctrl.signal });
      if (!res.ok) throw new Error('confirm http error'); // non-2xx → fall to 400 so SNS retries
      console.log('[IncidentWebhook] SNS subscription confirmed'); // never log TopicArn/URL
      return NextResponse.json({ status: 'subscription_confirmed' });
    } catch {
      console.error('[IncidentWebhook] SNS subscription confirmation failed');
    } finally {
      clearTimeout(timer);
    }
  }
  return NextResponse.json({ error: 'Invalid subscription URL' }, { status: 400 });
}

// TopicArn allowlist source of truth: the source_allowlist JSONB of enabled ingress cloudwatch_sns
// integrations. (W4 populates these rows; until then the SNS path is correctly 401 fail-closed.)
async function topicAllowlistRows(): Promise<Array<{ source_allowlist?: unknown }>> {
  const r = await getPool().query(
    "SELECT source_allowlist FROM integrations WHERE direction = 'ingress' AND kind = 'cloudwatch_sns' AND enabled = true",
  );
  return r.rows as Array<{ source_allowlist?: unknown }>;
}

export async function POST(request: Request): Promise<NextResponse> {
  // BINDING #1 — flag check FIRST: no accept / HMAC / triage / enqueue when off.
  if (process.env.INCIDENT_LIFECYCLE_ENABLED !== 'true') {
    return NextResponse.json({ error: 'incident lifecycle disabled (flag off)' }, { status: 503 });
  }

  // 2 — rate limit (per real client IP)
  const ip = extractClientIp(request);
  if (!checkRateLimit(ip)) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
  }

  // 3 — bounded raw-body read (OOM/DoS guard) + parse. HMAC needs the exact raw bytes.
  let rawBody: string;
  let body: Record<string, unknown>;
  try {
    rawBody = await readTextBounded(request, MAX_BODY_BYTES);
    body = JSON.parse(rawBody);
  } catch (e) {
    if (e instanceof BodyTooLargeError) {
      return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
    }
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // 4 — envelope-first auth (auth NEVER trusts headers / x-alert-source — no scheme impersonation).
  //     SNS envelopes → signature + TopicArn allowlist; direct POSTs → HMAC (bearer added in Task 4).
  const INVALID_AUTH = () => NextResponse.json({ error: 'Invalid authentication' }, { status: 401 });
  if (classifyEnvelope(body) === 'sns') {
    const verified = await verifySnsMessage(body);
    const topicArn = typeof body.TopicArn === 'string' ? body.TopicArn : undefined;
    if (!verified.ok || !(await isTopicAllowed(topicArn, topicAllowlistRows))) {
      return INVALID_AUTH();
    }
    if (body.Type === 'SubscriptionConfirmation') return confirmSnsSubscription(body);
    if (body.Type === 'UnsubscribeConfirmation') {
      return NextResponse.json({ status: 'unsubscribe_ack' }, { status: 200 });
    }
    // Notification → fall through to the SAME shared post-auth pipeline as the direct path.
  } else {
    // Direct POST: bearer (Alertmanager) first, then HMAC (custom senders). Degrade-safe: an absent
    // bearer secret yields {ok:false} and falls through to HMAC.
    const authz = request.headers.get('authorization');
    const bearer = authz ? verifyBearer(authz, await bearerSecrets()) : { ok: false };
    if (!bearer.ok) {
      const signature = request.headers.get('x-webhook-signature') ||
        request.headers.get('x-hub-signature-256') ||
        request.headers.get('x-alertmanager-signature') || '';
      const result = verifyHmac(rawBody, signature, await hmacSecrets());
      if (!signature || !result.ok) return INVALID_AUTH();
      if (result.matched === 'standby') {
        console.log('[IncidentWebhook] HMAC matched standby secret (ADR-022 rotation; promote+retire)');
      }
    }
  }

  // 5 — resolve source (POST-auth; never the trusted header for auth) + normalize → AlertEvent[]
  const source = resolveSourceHint(body, request.headers.get('x-alert-source'));
  const alerts = normalizeAlert(body, source);
  if (alerts.length === 0) {
    return NextResponse.json({ error: 'No valid alerts found in payload' }, { status: 400 });
  }

  // ADR-034 feedback-loop breaker (ALWAYS-ON, independent of rca_writeback_enabled). Drop any event
  // that carries AWSops's own write-back marker so an OpsItem/IM enrichment can never re-trigger RCA.
  // Accepted-and-ignored (200) so the source does not retry. Harmless when nothing writes back.
  const live = alerts.filter((a) => !bearsSelfWritebackMarker(a));
  const droppedSelf = alerts.length - live.length;
  if (live.length === 0) {
    return NextResponse.json({ status: 'dropped_self_writeback', dropped: droppedSelf }, { status: 200 });
  }

  // 7 — Triage each (severity gate + dedup-race live INSIDE triageAndCreateOrLink). isolatePayload
  //     defangs the attacker-controlled text up front (defense in depth; the agent tier re-isolates).
  let newCount = 0;
  let linkedCount = 0;
  let skippedCount = 0;
  for (const alert of live) {
    isolatePayload(alert); // structured isolation — never trust raw alert text downstream
    const decision = await triageAndCreateOrLink(alert);
    if (decision.decision === 'New' && decision.incidentId) {
      // First-stage enqueue rides the P2 backbone (worker_jobs + SQS). No mutation here.
      await enqueueInitialStage(decision.incidentId);
      newCount++;
    } else if (decision.decision === 'Linked') {
      linkedCount++;
    } else {
      skippedCount++; // Skipped or disabled (defense-in-depth: triage also 503-equivalents)
    }
  }

  return NextResponse.json({
    status: 'accepted',
    source,
    alertsReceived: alerts.length,
    new: newCount,
    linked: linkedCount,
    skipped: skippedCount,
    droppedSelfWriteback: droppedSelf,
  }, { status: 202 });
}
