import { describe, it, expect, vi, beforeEach } from 'vitest';

const query = vi.fn();
vi.mock('@/lib/db', () => ({ getPool: () => ({ query: (...a: unknown[]) => query(...a) }) }));

const sqsSend = vi.fn();
vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: class { send = sqsSend; },
  SendMessageCommand: class { constructor(public input: unknown) {} },
}));

const ssmSend = vi.fn();
vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: class { send = ssmSend; },
  GetParameterCommand: class { constructor(public input: unknown) {} },
}));

import type { AlertEvent } from './incident-normalize';

function ev(over: Partial<AlertEvent> = {}): AlertEvent {
  return {
    id: 'a1', source: 'generic', alertName: 'HighCPU', severity: 'critical', status: 'firing',
    message: 'cpu high', timestamp: '2026-06-10T00:00:00Z', labels: {}, annotations: {},
    services: ['api'], resources: ['i-1'], rawPayload: {}, ...over,
  };
}

beforeEach(() => {
  vi.resetModules();
  query.mockReset();
  sqsSend.mockReset();
  ssmSend.mockReset();
  process.env.AURORA_ENDPOINT = 'h';
  process.env.INCIDENT_LIFECYCLE_ENABLED = 'true';
  delete process.env.JOBS_QUEUE_URL;
});

describe('triageAndCreateOrLink — dedup race (Addendum (a))', () => {
  it('fresh correlation_key → New (INSERT … ON CONFLICT) then a trigger_event snapshot UPDATE', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'inc-1' }] }); // INSERT RETURNING id (won)
    query.mockResolvedValueOnce({ rows: [] });                // trigger_event UPDATE
    const { triageAndCreateOrLink } = await import('./incident');
    const r = await triageAndCreateOrLink(ev({ source: 'cloudwatch', labels: { account_id: '123456789012' }, alarmArn: 'arn:aws:cloudwatch:::alarm:X' }));
    expect(r.decision).toBe('New');
    expect(r.incidentId).toBeTruthy();
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toMatch(/INSERT INTO incidents/);
    expect(sql).toMatch(/ON CONFLICT \(correlation_key\) DO NOTHING/);
    expect(sql).toMatch(/RETURNING id/);
    expect(query).toHaveBeenCalledTimes(2); // INSERT + trigger_event snapshot (New path only)
    const upd = String(query.mock.calls[1][0]);
    expect(upd).toMatch(/UPDATE incidents SET trigger_event/);
    const snap = JSON.parse((query.mock.calls[1][1] as unknown[])[0] as string);
    expect(snap.id).toBe('a1');
    expect(snap.source).toBe('cloudwatch');
    expect(snap.account).toBe('123456789012');
    expect(snap.alarmArn).toBe('arn:aws:cloudwatch:::alarm:X');
    expect(snap.services).toEqual(['api']);
  });

  it('New path is degrade-safe: a missing trigger_event column does NOT fail triage', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'inc-1' }] });                                   // INSERT won
    query.mockRejectedValueOnce(new Error('column "trigger_event" does not exist'));             // UPDATE throws
    const { triageAndCreateOrLink } = await import('./incident');
    const r = await triageAndCreateOrLink(ev());
    expect(r.decision).toBe('New'); // snapshot is best-effort; triage still succeeds
    expect(r.incidentId).toBeTruthy();
  });

  it('SAME correlation_key (lost race) → Linked: ON CONFLICT returns 0 rows, then link + bump last_event_at', async () => {
    query
      .mockResolvedValueOnce({ rows: [] })              // INSERT ON CONFLICT DO NOTHING → 0 rows (lost)
      .mockResolvedValueOnce({ rows: [{ id: 'inc-1' }] }) // UPDATE … RETURNING id (existing active)
      .mockResolvedValueOnce({ rows: [] });             // INSERT incident_links
    const { triageAndCreateOrLink } = await import('./incident');
    const r = await triageAndCreateOrLink(ev());
    expect(r.decision).toBe('Linked');
    expect(r.incidentId).toBe('inc-1');
    expect(String(query.mock.calls[1][0])).toMatch(/UPDATE incidents SET last_event_at = now\(\)/);
    expect(String(query.mock.calls[1][0])).toMatch(/status IN \('triaged','investigating'\)/);
    expect(String(query.mock.calls[2][0])).toMatch(/INSERT INTO incident_links/);
  });

  it('below min-severity → Skipped, performs NO writes', async () => {
    ssmSend.mockResolvedValue({ Parameter: { Value: 'critical' } }); // min-severity = critical
    const { triageAndCreateOrLink } = await import('./incident');
    const r = await triageAndCreateOrLink(ev({ severity: 'warning' }));
    expect(r.decision).toBe('Skipped');
    expect(query).not.toHaveBeenCalled();
  });

  it('flag OFF → {decision:"disabled"}, NO writes (no autonomous accept)', async () => {
    process.env.INCIDENT_LIFECYCLE_ENABLED = 'false';
    const { triageAndCreateOrLink } = await import('./incident');
    const r = await triageAndCreateOrLink(ev());
    expect(r.decision).toBe('disabled');
    expect(query).not.toHaveBeenCalled();
    expect(sqsSend).not.toHaveBeenCalled();
  });

  it('AURORA unconfigured → disabled, NO writes (degrade-safe)', async () => {
    delete process.env.AURORA_ENDPOINT;
    const { triageAndCreateOrLink } = await import('./incident');
    const r = await triageAndCreateOrLink(ev());
    expect(r.decision).toBe('disabled');
    expect(query).not.toHaveBeenCalled();
  });
});

describe('enqueueInitialStage — rides the P2 ledger (worker_jobs + SQS)', () => {
  it('inserts a queued incident_stage worker_jobs row and sends to JOBS_QUEUE_URL', async () => {
    process.env.JOBS_QUEUE_URL = 'https://sqs/q';
    query.mockResolvedValue({ rows: [] });
    const { enqueueInitialStage } = await import('./incident');
    await enqueueInitialStage('inc-1');
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toMatch(/INSERT INTO worker_jobs/);
    expect(sql).toMatch(/'incident_stage'/);
    expect(sql).toMatch(/'queued'/);
    expect(sqsSend).toHaveBeenCalledTimes(1);
    const body = JSON.parse((sqsSend.mock.calls[0][0] as { input: { MessageBody: string } }).input.MessageBody);
    expect(body.type).toBe('incident_stage');
    expect(body.job_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.payload.incident_id).toBe('inc-1');
  });

  it('does NOT send to SQS when JOBS_QUEUE_URL is unset (still ledgers)', async () => {
    query.mockResolvedValue({ rows: [] });
    const { enqueueInitialStage } = await import('./incident');
    await enqueueInitialStage('inc-1');
    expect(query).toHaveBeenCalledTimes(1);
    expect(sqsSend).not.toHaveBeenCalled();
  });
});

describe('reads — listIncidents / getIncident (degrade-safe)', () => {
  it('listIncidents returns [] when AURORA unconfigured', async () => {
    delete process.env.AURORA_ENDPOINT;
    const { listIncidents } = await import('./incident');
    expect(await listIncidents()).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('getIncident returns row + stages/findings/writeback (one query each)', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'inc-1', status: 'triaged' }] })
      .mockResolvedValueOnce({ rows: [{ stage: 'triage' }] })
      .mockResolvedValueOnce({ rows: [{ sub_agent: 'network' }] })
      .mockResolvedValueOnce({ rows: [{ target_system: 'opscenter', status: 'succeeded' }] });
    const { getIncident } = await import('./incident');
    const inc = await getIncident('inc-1');
    expect(inc?.id).toBe('inc-1');
    expect(inc?.stages).toEqual([{ stage: 'triage' }]);
    expect(inc?.findings).toEqual([{ sub_agent: 'network' }]);
    expect(inc?.writeback).toEqual([{ target_system: 'opscenter', status: 'succeeded' }]);
  });

  it('getIncident write-back read is degrade-safe — [] when incident_writeback table/flag absent', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'inc-2', status: 'triaged' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error('relation "incident_writeback" does not exist'));
    const { getIncident } = await import('./incident');
    const inc = await getIncident('inc-2');
    expect(inc?.id).toBe('inc-2');
    expect(inc?.writeback).toEqual([]); // table absent → degrades, never throws
  });
});

describe('SSM config readers — cached, with defaults (Addendum #4/#7)', () => {
  it('readWindowMinutes hits SSM once then caches', async () => {
    ssmSend.mockResolvedValue({ Parameter: { Value: '30' } });
    const { readWindowMinutes } = await import('./incident');
    expect(await readWindowMinutes()).toBe(30);
    expect(await readWindowMinutes()).toBe(30);
    expect(ssmSend).toHaveBeenCalledTimes(1);
  });

  it('readMinSeverity falls back to default when SSM throws', async () => {
    ssmSend.mockRejectedValue(new Error('no param'));
    const { readMinSeverity } = await import('./incident');
    expect(await readMinSeverity()).toBe('warning');
  });
});
