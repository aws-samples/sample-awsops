// web/lib/trace.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
const query = vi.fn();
vi.mock('@/lib/db', () => ({ getPool: () => ({ query }) }));
import { recordCustomAgentTrace } from './trace';

beforeEach(() => { query.mockReset(); delete process.env.AURORA_ENDPOINT; });

describe('recordCustomAgentTrace', () => {
  it('no-ops when Aurora unconfigured', async () => {
    await recordCustomAgentTrace({ gateway: 'security', userSub: 'u', agentName: 'compliance', tier: 'custom', skillHashes: ['h1'] });
    expect(query).not.toHaveBeenCalled();
  });
  it('inserts into agentcore_stats with traceability payload', async () => {
    process.env.AURORA_ENDPOINT = 'h';
    query.mockResolvedValue({ rows: [] });
    await recordCustomAgentTrace({ gateway: 'security', userSub: 'u', agentName: 'compliance', agentVersion: 3, tier: 'custom', skillHashes: ['h1', 'h2'] });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO agentcore_stats/i);
    expect(params).toContain('custom_agent_invoke');
    const payload = JSON.parse(params[params.length - 1]);
    expect(payload.agentName).toBe('compliance');
    expect(payload.skillHashes).toEqual(['h1', 'h2']);
  });
  it('carries spaceVersion into the payload (ADR-031 Phase 2)', async () => {
    process.env.AURORA_ENDPOINT = 'h';
    query.mockResolvedValue({ rows: [] });
    await recordCustomAgentTrace({ gateway: 'security', userSub: 'u', agentName: 'compliance', agentVersion: 3, tier: 'custom', skillHashes: ['h1'], spaceVersion: 7 });
    const params = query.mock.calls[0][1];
    const payload = JSON.parse(params[params.length - 1]);
    expect(payload.spaceVersion).toBe(7);
  });
  it('never throws on DB error', async () => {
    process.env.AURORA_ENDPOINT = 'h';
    query.mockRejectedValue(new Error('down'));
    await expect(recordCustomAgentTrace({ gateway: 'g', userSub: 'u', agentName: 'a', tier: 'custom', skillHashes: [] })).resolves.toBeUndefined();
  });
});
