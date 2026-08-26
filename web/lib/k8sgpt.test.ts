import { describe, it, expect, vi, beforeEach } from 'vitest';

const invokeAgent = vi.fn();
const listK8sgptResults = vi.fn();
const query = vi.fn();
const triageAndCreateOrLink = vi.fn();
const enqueueInitialStage = vi.fn();
vi.mock('@/lib/agentcore', () => ({ invokeAgent }));
vi.mock('@/lib/eks-incluster', () => ({ listK8sgptResults }));
vi.mock('@/lib/db', () => ({ getPool: () => ({ query }) }));
vi.mock('@/lib/incident', () => ({ triageAndCreateOrLink, enqueueInitialStage }));

const crd = (over = {}) => ({
  spec: { kind: 'DaemonSet', name: 'observability/otel-collector',
    error: [{ text: '5/8 ready pods' }], details: 'CrashLoopBackOff', parentObject: 'DaemonSet/otel-collector' },
  ...over,
});

async function load() { return await import('./k8sgpt'); }

beforeEach(() => {
  vi.resetModules();
  invokeAgent.mockReset(); listK8sgptResults.mockReset(); query.mockReset();
  triageAndCreateOrLink.mockReset(); enqueueInitialStage.mockReset();
  process.env.AURORA_ENDPOINT = 'aurora.local';
  process.env.K8SGPT_ENABLED = 'true';
  query.mockResolvedValue({ rows: [] }); // default: no existing finding, inserts return nothing
});

describe('getDiagnosis gate (BINDING flag-off behavior)', () => {
  it('flag OFF → no cluster read, no narration, enabled:false', async () => {
    process.env.K8SGPT_ENABLED = 'false';
    const { getDiagnosis } = await load();
    const r = await getDiagnosis('fsi-demo-cluster');
    expect(r.enabled).toBe(false);
    expect(listK8sgptResults).not.toHaveBeenCalled();   // NO STS presign / NO cluster read
    expect(invokeAgent).not.toHaveBeenCalled();          // NO Bedrock call
  });
});

describe('fact/hypothesis separation (Rule 8)', () => {
  it('returns deterministic analyzer_result distinctly from the Haiku llm_explanation', async () => {
    listK8sgptResults.mockResolvedValue([crd()]);
    invokeAgent.mockResolvedValue('Likely a bad readiness probe; check container logs. (hypothesis)');
    query.mockImplementation((sql: string) => {
      if (sql.includes('SELECT scanned_at')) return Promise.resolve({ rows: [{ scanned_at: new Date().toISOString() }] });
      if (sql.startsWith('INSERT INTO k8s_findings')) return Promise.resolve({ rows: [{ first_seen: 'x', last_seen: 'x', llm_explanation: null, llm_model: null }] });
      return Promise.resolve({ rows: [] });
    });
    const { getDiagnosis } = await load();
    const r = await getDiagnosis('fsi-demo-cluster');
    const f = r.findings[0];
    expect(f.analyzer_result.analyzer).toBe('DaemonSet');                 // FACT
    expect(f.analyzer_result.errors).toEqual(['5/8 ready pods']);          // FACT untouched
    expect(f.llm_explanation).toContain('hypothesis');                     // HYPOTHESIS, separate field
    expect(f.analyzer_result).not.toHaveProperty('llm_explanation');       // structurally separate
  });
});

describe('dedup (Rule 11) — do not re-narrate an unchanged finding', () => {
  it('reuses the persisted narration when the fingerprint already exists', async () => {
    listK8sgptResults.mockResolvedValue([crd()]);
    query.mockImplementation((sql: string) => {
      if (sql.startsWith('SELECT llm_explanation')) return Promise.resolve({ rows: [{ llm_explanation: 'cached', llm_model: 'haiku-4.5', first_seen: 'a', last_seen: 'b' }] });
      if (sql.includes('SELECT scanned_at')) return Promise.resolve({ rows: [{ scanned_at: new Date().toISOString() }] });
      return Promise.resolve({ rows: [{ first_seen: 'a', last_seen: 'b', llm_explanation: 'cached', llm_model: 'haiku-4.5' }] });
    });
    const { getDiagnosis } = await load();
    const r = await getDiagnosis('fsi-demo-cluster');
    expect(invokeAgent).not.toHaveBeenCalled();          // no re-narrate
    expect(r.findings[0].llm_explanation).toBe('cached');
  });
});

describe('stale-scan degrade (Rule 9)', () => {
  it('operator unreachable → operator_detected:false, stale:true, still returns (no throw)', async () => {
    listK8sgptResults.mockRejectedValue(new Error('connect ETIMEDOUT'));
    query.mockResolvedValue({ rows: [] });
    const { getDiagnosis } = await load();
    const r = await getDiagnosis('fsi-demo-cluster');
    expect(r.operator_detected).toBe(false);
    expect(r.stale).toBe(true);
    expect(r.findings).toEqual([]);
  });

  it('last scan older than STALE_MS → stale:true', async () => {
    listK8sgptResults.mockResolvedValue([]);
    const old = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    query.mockImplementation((sql: string) =>
      sql.includes('SELECT scanned_at') ? Promise.resolve({ rows: [{ scanned_at: old }] }) : Promise.resolve({ rows: [] }));
    const { getDiagnosis } = await load();
    const r = await getDiagnosis('fsi-demo-cluster');
    expect(r.stale).toBe(true);
  });
});

describe('H3a seam (twice-gated, NOT auto-invoked)', () => {
  const finding = {
    analyzer: 'DaemonSet', resourceName: 'observability/otel-collector', namespace: 'observability',
    errors: ['5/8 ready pods'], details: 'CrashLoopBackOff', parentObject: 'DaemonSet/otel-collector',
    fingerprint: 'abc123', adapterVersion: '0.4.x/result.core.k8sgpt.ai/v1',
  };

  it('K8SGPT flag OFF → {decision:"disabled"}, NO incident triage call (gate #1)', async () => {
    process.env.K8SGPT_ENABLED = 'false';
    const { raiseIncidentFromFinding } = await load();
    const r = await raiseIncidentFromFinding('fsi-demo-cluster', finding);
    expect(r.decision).toBe('disabled');
    expect(triageAndCreateOrLink).not.toHaveBeenCalled();   // gate #1 short-circuits before triage
    expect(enqueueInitialStage).not.toHaveBeenCalled();
  });

  it('flags ON: carries ONLY deterministic facts, enqueues stage only on a New incident (no auto-apply)', async () => {
    triageAndCreateOrLink.mockResolvedValue({ decision: 'New', incidentId: 'inc-1' });
    const { raiseIncidentFromFinding } = await load();
    const r = await raiseIncidentFromFinding('fsi-demo-cluster', finding);
    expect(r.decision).toBe('New');
    expect(triageAndCreateOrLink).toHaveBeenCalledTimes(1);
    const event = triageAndCreateOrLink.mock.calls[0][0];
    expect(event.message).toBe('5/8 ready pods');                          // deterministic FACT only
    expect(event.resources).toEqual(['eks:fsi-demo-cluster/observability/otel-collector']); // Rule 6 anchor
    expect(JSON.stringify(event)).not.toContain('llm_explanation');        // NO LLM hypothesis crosses (Rule 8)
    expect(enqueueInitialStage).toHaveBeenCalledWith('inc-1');
  });

  it('flags ON but triage gate OFF inside ⇒ {decision:"disabled"}, no stage enqueued (gate #2)', async () => {
    triageAndCreateOrLink.mockResolvedValue({ decision: 'disabled' });
    const { raiseIncidentFromFinding } = await load();
    const r = await raiseIncidentFromFinding('fsi-demo-cluster', finding);
    expect(r.decision).toBe('disabled');
    expect(enqueueInitialStage).not.toHaveBeenCalled();   // PROPOSAL/no-auto-apply: no work created
  });
});
