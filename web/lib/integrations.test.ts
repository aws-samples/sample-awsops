// web/lib/integrations.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

const query = vi.fn();
vi.mock('@/lib/db', () => ({ getPool: () => ({ query }) }));
vi.mock('@/lib/catalog', () => ({ writeAudit: vi.fn() }));

import { upsertIntegration, listIntegrations, setIntegrationEnabled, getEnabledIntegrations } from './integrations';

beforeEach(() => { query.mockReset(); delete process.env.AURORA_ENDPOINT; });

describe('integrations catalog', () => {
  it('upsertIntegration: custom-only ON CONFLICT, no version column, disabled-by-default', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 5 }] });
    const id = await upsertIntegration({ name: 'grafana-ro', kind: 'grafana', direction: 'egress', endpoint: 'https://g.example', transport: 'api_key', capability: 'read' });
    expect(id).toBe(5);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO integrations/i);
    expect(sql).toMatch(/ON CONFLICT \(name\) DO UPDATE/i);
    expect(sql).toMatch(/WHERE integrations\.tier = 'custom'/i);
    expect(sql).not.toMatch(/version/i);   // integrations has NO version column
    expect(sql).toMatch(/enabled=false/i);
    expect(params).toContain('grafana-ro');
    expect(params).toContain('grafana');
    expect(params).toContain('egress');
  });

  it('upsertIntegration throws on a built-in name collision (WHERE tier=custom matched nothing)', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await expect(upsertIntegration({ name: 'builtin-x', kind: 'slack', direction: 'egress' }))
      .rejects.toThrow(/built-in integration/);
  });

  it('listIntegrations maps egress + ingress rows (incl. ingress fields)', async () => {
    query.mockResolvedValueOnce({ rows: [
      { id: 1, name: 'pd-in', kind: 'pagerduty', direction: 'ingress', description: 'd', endpoint: null,
        transport: null, credentials_ref: null, private_connection_ref: null, capability: 'read',
        exposed_tools: [], provided_context: {}, write_action_refs: [], auth_mode: 'vendor_sig',
        receive_path: '/api/integrations/ingress/abc', inbound_auth_ref: null, source_allowlist: ['1.2.3.4'],
        trigger_target: 'incident', tier: 'custom', enabled: true },
    ]});
    const out = await listIntegrations();
    expect(out[0].direction).toBe('ingress');
    expect(out[0].receivePath).toBe('/api/integrations/ingress/abc');
    expect(out[0].sourceAllowlist).toEqual(['1.2.3.4']);
    expect(out[0].triggerTarget).toBe('incident');
  });

  it('setIntegrationEnabled is custom-only', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await setIntegrationEnabled(7, true);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/UPDATE integrations SET enabled/i);
    expect(sql).toMatch(/tier = 'custom'/i);
    expect(params).toEqual([true, 7]);
  });

  it('getEnabledIntegrations returns [] when AURORA off (never queries)', async () => {
    expect(await getEnabledIntegrations('self')).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('getEnabledIntegrations is per-space scoped (enabled=true AND space membership)', async () => {
    process.env.AURORA_ENDPOINT = 'aurora.example';
    query.mockResolvedValueOnce({ rows: [
      { id: 2, name: 'grafana-ro', kind: 'grafana', direction: 'egress', description: '', endpoint: 'https://g',
        transport: 'api_key', credentials_ref: null, private_connection_ref: null, capability: 'read',
        exposed_tools: ['grafana_query'], provided_context: {}, write_action_refs: [], auth_mode: null,
        receive_path: null, inbound_auth_ref: null, source_allowlist: [], trigger_target: null,
        tier: 'custom', enabled: true },
    ]});
    const out = await getEnabledIntegrations('123456789012');
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/i\.enabled = true/i);
    expect(sql).toMatch(/agent_spaces/i);
    expect(sql).toMatch(/enabled_integration_ids/i);
    expect(params).toEqual(['123456789012']);
    expect(out[0].exposedTools).toEqual(['grafana_query']);
  });

  it('getEnabledIntegrations degrades to [] on query error', async () => {
    process.env.AURORA_ENDPOINT = 'aurora.example';
    query.mockRejectedValueOnce(new Error('db down'));
    await expect(getEnabledIntegrations('self')).resolves.toEqual([]);
  });
});
