import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'crypto';

// --- mock the Triage layer (Task 2) — assert it is NEVER called when the flag is off ---
const triageAndCreateOrLink = vi.fn();
const enqueueInitialStage = vi.fn();
vi.mock('@/lib/incident', () => ({
  triageAndCreateOrLink: (...a: unknown[]) => triageAndCreateOrLink(...a),
  enqueueInitialStage: (...a: unknown[]) => enqueueInitialStage(...a),
}));

// --- mock SSM: the HMAC secret(s) come from SSM (read once, cached), NOT app-config ---
const ssmSend = vi.fn();
vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: class { send = ssmSend; },
  GetParameterCommand: class { constructor(public input: unknown) {} },
}));

// --- mock SNS signature verification (real crypto lives in sns-verify.test.ts) ---
const verifySnsMessage = vi.fn();
vi.mock('@/lib/sns-verify', () => ({ verifySnsMessage: (...a: unknown[]) => verifySnsMessage(...a) }));

// --- mock the Aurora pool for the TopicArn source_allowlist query ---
const dbQuery = vi.fn();
vi.mock('@/lib/db', () => ({ getPool: () => ({ query: (...a: unknown[]) => dbQuery(...a) }) }));

const ACTIVE_SECRET = 'active-secret-key';

function post(rawBody: string, headers: Record<string, string> = {}) {
  return new Request('http://x/api/incidents/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.5, 198.51.100.7', ...headers },
    body: rawBody,
  }) as any;
}

function sign(body: string, secret = ACTIVE_SECRET): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

// A generic alert that normalizes to severity=critical (passes the gate).
const ALERT = JSON.stringify({ title: 'HighCPU', severity: 'critical', source: 'generic', message: 'cpu high', labels: { service: 'api', instance: 'i-1' } });

beforeEach(() => {
  vi.resetModules();
  triageAndCreateOrLink.mockReset();
  enqueueInitialStage.mockReset();
  ssmSend.mockReset();
  verifySnsMessage.mockReset();
  verifySnsMessage.mockResolvedValue({ ok: false }); // default: reject SNS unless a test opts in
  dbQuery.mockReset();
  dbQuery.mockResolvedValue({ rows: [] }); // default: empty allowlist (fail-closed)
  // SSM returns the active HMAC secret for the configured param.
  ssmSend.mockResolvedValue({ Parameter: { Value: ACTIVE_SECRET } });
  process.env.INCIDENT_LIFECYCLE_ENABLED = 'true';
  process.env.SSM_INCIDENT_HMAC_SECRET_PARAM = '/ops/awsops-v2/incident/webhook-hmac-secret';
  delete process.env.SSM_INCIDENT_HMAC_STANDBY_PARAM;
});

describe('POST /api/incidents/webhook — flag OFF (BINDING: no autonomous accept)', () => {
  it('503 when INCIDENT_LIFECYCLE_ENABLED !== "true" and NEVER calls triage', async () => {
    process.env.INCIDENT_LIFECYCLE_ENABLED = 'false';
    const { POST } = await import('./route');
    const res = await POST(post(ALERT, { 'x-webhook-signature': sign(ALERT) }));
    expect(res.status).toBe(503);
    expect(triageAndCreateOrLink).not.toHaveBeenCalled();
    expect(enqueueInitialStage).not.toHaveBeenCalled();
    expect(ssmSend).not.toHaveBeenCalled(); // not even an HMAC read — short-circuits first
  });

  it('503 when the flag env var is unset', async () => {
    delete process.env.INCIDENT_LIFECYCLE_ENABLED;
    const { POST } = await import('./route');
    const res = await POST(post(ALERT, { 'x-webhook-signature': sign(ALERT) }));
    expect(res.status).toBe(503);
    expect(triageAndCreateOrLink).not.toHaveBeenCalled();
  });
});

describe('POST /api/incidents/webhook — HMAC (ADR-022 active/standby)', () => {
  it('401 on a bad signature (flag on)', async () => {
    const { POST } = await import('./route');
    const res = await POST(post(ALERT, { 'x-webhook-signature': 'sha256=deadbeef' }));
    expect(res.status).toBe(401);
    expect(triageAndCreateOrLink).not.toHaveBeenCalled();
  });

  it('401 when the signature header is missing', async () => {
    const { POST } = await import('./route');
    const res = await POST(post(ALERT));
    expect(res.status).toBe(401);
    expect(triageAndCreateOrLink).not.toHaveBeenCalled();
  });

  it('202 on a good signature → calls triageAndCreateOrLink then enqueueInitialStage (on New)', async () => {
    triageAndCreateOrLink.mockResolvedValue({ decision: 'New', incidentId: 'inc-1' });
    enqueueInitialStage.mockResolvedValue({ jobId: 'job-1' });
    const { POST } = await import('./route');
    const res = await POST(post(ALERT, { 'x-webhook-signature': sign(ALERT) }));
    expect(res.status).toBe(202);
    expect(triageAndCreateOrLink).toHaveBeenCalledTimes(1);
    expect(enqueueInitialStage).toHaveBeenCalledWith('inc-1');
  });

  it('accepts the standby secret (ADR-022 rotation) — 202', async () => {
    const STANDBY = 'standby-secret-key';
    process.env.SSM_INCIDENT_HMAC_STANDBY_PARAM = '/ops/awsops-v2/incident/webhook-hmac-standby';
    ssmSend.mockImplementation((cmd: { input?: { Name?: string } }) => {
      const name = cmd?.input?.Name || '';
      if (name.includes('standby')) return Promise.resolve({ Parameter: { Value: STANDBY } });
      return Promise.resolve({ Parameter: { Value: ACTIVE_SECRET } });
    });
    triageAndCreateOrLink.mockResolvedValue({ decision: 'New', incidentId: 'inc-2' });
    enqueueInitialStage.mockResolvedValue({ jobId: 'job-2' });
    const { POST } = await import('./route');
    const res = await POST(post(ALERT, { 'x-webhook-signature': sign(ALERT, STANDBY) }));
    expect(res.status).toBe(202);
    expect(triageAndCreateOrLink).toHaveBeenCalledTimes(1);
  });

  it('Linked decision does NOT enqueue a new initial stage (rides the existing incident)', async () => {
    triageAndCreateOrLink.mockResolvedValue({ decision: 'Linked', incidentId: 'inc-1' });
    const { POST } = await import('./route');
    const res = await POST(post(ALERT, { 'x-webhook-signature': sign(ALERT) }));
    expect(res.status).toBe(202);
    expect(enqueueInitialStage).not.toHaveBeenCalled();
  });
});

describe('POST /api/incidents/webhook — ADR-034 marker-drop (ALWAYS-ON, independent of write-back flag)', () => {
  // A self-write-back-marked generic alert (CreatedBy=AWSops-AIOps in labels).
  const SELF = JSON.stringify({ title: 'HighCPU', severity: 'critical', source: 'generic', message: 'cpu high', labels: { service: 'api', CreatedBy: 'AWSops-AIOps' } });

  it('200 dropped_self_writeback when the only alert carries our own marker — NEVER triages', async () => {
    const { POST } = await import('./route');
    const res = await POST(post(SELF, { 'x-webhook-signature': sign(SELF) }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('dropped_self_writeback');
    expect(body.dropped).toBe(1);
    // The feedback-loop breaker must run BEFORE triage/enqueue — neither may fire.
    expect(triageAndCreateOrLink).not.toHaveBeenCalled();
    expect(enqueueInitialStage).not.toHaveBeenCalled();
  });

  it('marker-drop is ALWAYS-ON — fires even with rca_writeback_enabled unset/off', async () => {
    delete process.env.RCA_WRITEBACK_ENABLED;
    const { POST } = await import('./route');
    const res = await POST(post(SELF, { 'x-webhook-signature': sign(SELF) }));
    expect(res.status).toBe(200);
    expect(triageAndCreateOrLink).not.toHaveBeenCalled();
  });

  it('mixed batch → drops only the marked alert, triages the live one, reports droppedSelfWriteback', async () => {
    // Alertmanager batch: one carries the marker, one is clean.
    const batch = JSON.stringify({
      receiver: 'team-x',
      groupLabels: { alertname: 'X' },
      alerts: [
        { status: 'firing', labels: { alertname: 'Mine', severity: 'critical', service: 'api', CreatedBy: 'AWSops-AIOps' }, annotations: {}, startsAt: '2026-06-10T00:00:00Z' },
        { status: 'firing', labels: { alertname: 'Real', severity: 'critical', service: 'db' }, annotations: {}, startsAt: '2026-06-10T00:00:01Z' },
      ],
    });
    triageAndCreateOrLink.mockResolvedValue({ decision: 'New', incidentId: 'inc-9' });
    enqueueInitialStage.mockResolvedValue({ jobId: 'job-9' });
    const { POST } = await import('./route');
    const res = await POST(post(batch, { 'x-webhook-signature': sign(batch), 'x-forwarded-for': '10.0.0.77, 198.51.100.7' }));
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.droppedSelfWriteback).toBe(1);
    expect(triageAndCreateOrLink).toHaveBeenCalledTimes(1); // only the live alert
  });
});

describe('POST /api/incidents/webhook — rate limit + SNS confirm', () => {
  it('429 once over the per-IP cap', async () => {
    triageAndCreateOrLink.mockResolvedValue({ decision: 'Skipped' });
    const { POST } = await import('./route');
    let last = 200;
    // Drive far past the cap from a single IP.
    for (let i = 0; i < 130; i++) {
      const res = await POST(post(ALERT, { 'x-webhook-signature': sign(ALERT), 'x-forwarded-for': '10.0.0.9, 198.51.100.7' }));
      last = res.status;
      if (last === 429) break;
    }
    expect(last).toBe(429);
  });

  it('SubscriptionConfirmation → confirm ONLY after SNS signature + TopicArn allowlist pass', async () => {
    verifySnsMessage.mockResolvedValue({ ok: true });
    dbQuery.mockResolvedValue({ rows: [{ source_allowlist: ['arn:aws:sns:ap-northeast-2:1:t'] }] });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
    const body = JSON.stringify({ Type: 'SubscriptionConfirmation', TopicArn: 'arn:aws:sns:ap-northeast-2:1:t', SubscribeURL: 'https://sns.ap-northeast-2.amazonaws.com/?Action=ConfirmSubscription' });
    const { POST } = await import('./route');
    const res = await POST(post(body, { 'x-forwarded-for': '10.0.0.50, 198.51.100.7' }));
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(triageAndCreateOrLink).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('SubscriptionConfirmation with a FORGED signature → 401, never fetches SubscribeURL', async () => {
    verifySnsMessage.mockResolvedValue({ ok: false });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
    const body = JSON.stringify({ Type: 'SubscriptionConfirmation', TopicArn: 'arn:aws:sns:ap-northeast-2:1:t', SubscribeURL: 'https://sns.ap-northeast-2.amazonaws.com/?Action=ConfirmSubscription' });
    const { POST } = await import('./route');
    const res = await POST(post(body, { 'x-forwarded-for': '10.0.0.51, 198.51.100.7' }));
    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe('POST /api/incidents/webhook — direct path: bearer (Alertmanager) + HMAC + reject SNS-shaped', () => {
  it('accepts a valid Bearer token (Alertmanager) → 202', async () => {
    process.env.SSM_INCIDENT_BEARER_PARAM = '/ops/awsops-v2/incident/webhook-bearer';
    // ssmSend default returns ACTIVE_SECRET; use it as the bearer token.
    triageAndCreateOrLink.mockResolvedValue({ decision: 'New', incidentId: 'inc-b' });
    enqueueInitialStage.mockResolvedValue({ jobId: 'j' });
    const { POST } = await import('./route');
    const res = await POST(post(ALERT, { authorization: `Bearer ${ACTIVE_SECRET}`, 'x-forwarded-for': '10.2.0.1, 198.51.100.7' }));
    expect(res.status).toBe(202);
    expect(triageAndCreateOrLink).toHaveBeenCalledTimes(1);
  });

  it('rejects an SNS-shaped body on the direct path (no scheme impersonation) → 401', async () => {
    // Type:Notification ⇒ classified as SNS ⇒ must pass SNS verify (default mocked false) ⇒ 401,
    // even with a Bearer header. The bearer/HMAC path can never accept an SNS-shaped payload.
    verifySnsMessage.mockResolvedValue({ ok: false });
    const body = JSON.stringify({ Type: 'Notification', TopicArn: 'arn:x', Message: '{}' });
    const { POST } = await import('./route');
    const res = await POST(post(body, { authorization: 'Bearer anything', 'x-forwarded-for': '10.2.0.2, 198.51.100.7' }));
    expect(res.status).toBe(401);
    expect(triageAndCreateOrLink).not.toHaveBeenCalled();
  });

  it('degrades to HMAC when no bearer param is configured → 202', async () => {
    delete process.env.SSM_INCIDENT_BEARER_PARAM;
    triageAndCreateOrLink.mockResolvedValue({ decision: 'New', incidentId: 'inc-h' });
    enqueueInitialStage.mockResolvedValue({ jobId: 'j' });
    const { POST } = await import('./route');
    const res = await POST(post(ALERT, { 'x-webhook-signature': sign(ALERT), 'x-forwarded-for': '10.2.0.3, 198.51.100.7' }));
    expect(res.status).toBe(202);
  });

  it('neither bearer nor HMAC → 401', async () => {
    delete process.env.SSM_INCIDENT_BEARER_PARAM;
    const { POST } = await import('./route');
    const res = await POST(post(ALERT, { 'x-forwarded-for': '10.2.0.4, 198.51.100.7' }));
    expect(res.status).toBe(401);
    expect(triageAndCreateOrLink).not.toHaveBeenCalled();
  });
});

describe('POST /api/incidents/webhook — body size cap (DoS guard)', () => {
  it('413 on an over-cap body before parse/triage', async () => {
    const huge = JSON.stringify({ pad: 'x'.repeat(600 * 1024) });
    const { POST } = await import('./route');
    const res = await POST(post(huge, { 'x-webhook-signature': 'sha256=deadbeef' }));
    expect(res.status).toBe(413);
    expect(triageAndCreateOrLink).not.toHaveBeenCalled();
  });
});

describe('POST /api/incidents/webhook — SNS Notification (CloudWatch) path', () => {
  const CW_TOPIC = 'arn:aws:sns:ap-northeast-2:123456789012:alarms';
  function cwNotification(extraDims: Array<{ name: string; value: string }> = []) {
    const message = JSON.stringify({
      AlarmName: 'HighCPU', NewStateValue: 'ALARM', NewStateReason: 'cpu high',
      Region: 'ap-northeast-2', AWSAccountId: '123456789012', StateChangeTime: new Date(0).toISOString(),
      Trigger: { MetricName: 'CPUUtilization', Namespace: 'AWS/EC2', Dimensions: [{ name: 'InstanceId', value: 'i-1' }, ...extraDims] },
    });
    return JSON.stringify({
      Type: 'Notification', TopicArn: CW_TOPIC, MessageId: 'm', Timestamp: new Date().toISOString(),
      Signature: 'sig', SignatureVersion: '2',
      SigningCertURL: 'https://sns.ap-northeast-2.amazonaws.com/SimpleNotificationService-abc.pem',
      Message: message,
    });
  }
  it('verified + allowlisted → flows into the shared pipeline → triages → 202', async () => {
    verifySnsMessage.mockResolvedValue({ ok: true });
    dbQuery.mockResolvedValue({ rows: [{ source_allowlist: [CW_TOPIC] }] });
    triageAndCreateOrLink.mockResolvedValue({ decision: 'New', incidentId: 'inc-cw' });
    enqueueInitialStage.mockResolvedValue({ jobId: 'j' });
    const { POST } = await import('./route');
    const res = await POST(post(cwNotification(), { 'x-forwarded-for': '10.1.0.1, 198.51.100.7' }));
    expect(res.status).toBe(202);
    expect(triageAndCreateOrLink).toHaveBeenCalledTimes(1);
  });
  it('valid signature but TopicArn NOT allowlisted → 401', async () => {
    verifySnsMessage.mockResolvedValue({ ok: true });
    dbQuery.mockResolvedValue({ rows: [{ source_allowlist: ['arn:other'] }] });
    const { POST } = await import('./route');
    const res = await POST(post(cwNotification(), { 'x-forwarded-for': '10.1.0.2, 198.51.100.7' }));
    expect(res.status).toBe(401);
    expect(triageAndCreateOrLink).not.toHaveBeenCalled();
  });
  it('forged signature → 401 even if allowlisted', async () => {
    verifySnsMessage.mockResolvedValue({ ok: false });
    dbQuery.mockResolvedValue({ rows: [{ source_allowlist: [CW_TOPIC] }] });
    const { POST } = await import('./route');
    const res = await POST(post(cwNotification(), { 'x-forwarded-for': '10.1.0.3, 198.51.100.7' }));
    expect(res.status).toBe(401);
  });
  it('SNS Notification carrying our self-writeback marker is DROPPED 200 (shared breaker, not bypassed)', async () => {
    verifySnsMessage.mockResolvedValue({ ok: true });
    dbQuery.mockResolvedValue({ rows: [{ source_allowlist: [CW_TOPIC] }] });
    const { POST } = await import('./route');
    const res = await POST(post(cwNotification([{ name: 'CreatedBy', value: 'AWSops-AIOps' }]), { 'x-forwarded-for': '10.1.0.4, 198.51.100.7' }));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('dropped_self_writeback');
    expect(triageAndCreateOrLink).not.toHaveBeenCalled();
  });
  it('UnsubscribeConfirmation (verified+allowlisted) → 200 ack, no confirm fetch, no triage', async () => {
    verifySnsMessage.mockResolvedValue({ ok: true });
    dbQuery.mockResolvedValue({ rows: [{ source_allowlist: [CW_TOPIC] }] });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
    const body = JSON.stringify({ Type: 'UnsubscribeConfirmation', TopicArn: CW_TOPIC, SubscribeURL: 'https://sns.ap-northeast-2.amazonaws.com/?Action=Unsub', Timestamp: new Date().toISOString() });
    const { POST } = await import('./route');
    const res = await POST(post(body, { 'x-forwarded-for': '10.1.0.5, 198.51.100.7' }));
    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(triageAndCreateOrLink).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
