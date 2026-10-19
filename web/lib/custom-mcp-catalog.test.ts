import { beforeEach, describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn(), connect: vi.fn() }));
const secret = vi.hoisted(() => ({ current: vi.fn() }));
vi.mock('@/lib/db', () => ({ getPool: () => db }));
vi.mock('./custom-mcp-secret', () => ({ currentCustomMcpSecretVersion: secret.current }));
import { attestAndEnableMcp, getEnabledIntegrations, getEnabledIntegrationSelection, upsertIntegration } from './integrations';
import { resolveAgent } from './agent-resolver';
import type { AgentWithSkills } from './catalog';
const row = { id: '7', enabled: true, kind: 'custom_mcp', tier: 'custom', direction: 'egress', capability: 'read',
  endpoint: 'https://example.com/mcp', transport: 'api_key', credentials_ref: 'ops/awsops-v2/integrations/custom/7',
  exposed_tools: ['query'], provided_context: {} };
const shown = { endpoint: row.endpoint, transport: row.transport, credentialsRef: row.credentials_ref, exposedTools: row.exposed_tools };
beforeEach(() => {
  vi.clearAllMocks();
  process.env.CUSTOM_MCP_ENABLED = 'true';
  db.connect.mockResolvedValue(db);
  db.query.mockImplementation(async (sql: string) => ({ rows: sql.includes('SELECT *') ? [row] : sql.includes('RETURNING id') ? [{ id: '7' }] : [] }));
  secret.current.mockResolvedValue('a'.repeat(32));
});
it('isolates malformed legacy tools from a healthy selected catalog entry', async () => {
  process.env.AURORA_ENDPOINT = 'fixture-only';
  db.query.mockResolvedValue({ rows: [
    { id: 8, enabled: true, kind: 'grafana', direction: 'egress', capability: 'read', exposed_tools: [] },
    { id: 9, enabled: true, kind: 'grafana', direction: 'egress', capability: 'read', exposed_tools: { legacy: true } },
    { id: 10, enabled: true, kind: 'grafana', direction: 'egress', capability: 'read', exposed_tools: null },
  ] });
  const selection = await getEnabledIntegrationSelection('self');
  expect(selection.integrations.map(i => Number(i.id))).toEqual([8]);
  expect(selection.mcpSelectionSuppressed).toBe(false);
});
describe('MCP catalog controls', () => {
  it.each(['false', 'true'])('quarantines legacy write tools but retains proposal metadata when activation is %s', async (activation) => {
    vi.stubEnv('AURORA_ENDPOINT', 'test.invalid');
    vi.stubEnv('CUSTOM_MCP_ENABLED', activation);
    const proposal = {
      id: 8, name: 'notion', kind: 'notion', tier: 'custom', enabled: true,
      direction: 'egress', capability: 'read_write', endpoint: 'https://example.com/mcp',
      exposed_tools: [], provided_context: { purpose: 'proposal' },
      write_action_refs: ['notion.create_page'],
    };
    db.query.mockResolvedValue({ rows: [
      { ...proposal, id: 9, name: 'legacy-write-tools', exposed_tools: ['notion_write'] },
      proposal,
      { ...proposal, id: 10, name: 'custom-write', kind: 'custom_mcp' },
    ] });
    try {
      const enabled = await getEnabledIntegrations('111111111111');
      expect(enabled).toHaveLength(1);
      expect(enabled[0]).toMatchObject({
        id: 8, exposedTools: [], capability: 'read_write',
        providedContext: { purpose: 'proposal' }, writeActionRefs: ['notion.create_page'],
      });
      expect(secret.current).not.toHaveBeenCalled();
      expect(db.connect).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('blocks enablement before any database or secret access while activation is off', async () => {
    delete process.env.CUSTOM_MCP_ENABLED;
    await expect(attestAndEnableMcp(7, 'sub', true, shown)).rejects.toThrow('activation');
    expect(db.connect).not.toHaveBeenCalled();
    expect(secret.current).not.toHaveBeenCalled();
  });
  it('ignores supplied attestations and binds credentials to the returned ID atomically', async () => {
    expect(await upsertIntegration({ name: 'custom-ro', kind: 'custom_mcp', direction: 'egress',
      endpoint: row.endpoint, transport: 'api_key', exposedTools: ['query'],
      providedContext: { _customMcpAttestation: { actorSub: 'spoof' }, other: 'ok' } })).toBe(7);
    const insert = db.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO'))!;
    expect(JSON.parse(insert[1][10])).toEqual({ other: 'ok' });
    expect(insert[0]).toContain('enabled=false');
    expect(db.query).toHaveBeenCalledWith('UPDATE integrations SET credentials_ref=$1 WHERE id=$2',
      ['ops/awsops-v2/integrations/custom/7', 7]);
    expect(db.query.mock.calls.at(-1)![0]).toBe('COMMIT');
  });
  it('rolls back both row and reference on binding failure', async () => {
    db.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('UPDATE')) throw new Error('binding failed');
      return { rows: sql.includes('RETURNING') ? [{ id: 7 }] : [] };
    });
    await expect(upsertIntegration({ name: 'custom-ro', kind: 'custom_mcp', direction: 'egress',
      endpoint: row.endpoint, transport: 'api_key', exposedTools: ['query'] })).rejects.toThrow('binding failed');
    expect(db.query).toHaveBeenCalledWith('ROLLBACK');
  });
  it('records immutable identity, current config, server time and current secret version after row locking', async () => {
    await attestAndEnableMcp(7, 'immutable-sub', true, shown);
    const update = db.query.mock.calls.find(([sql]) => sql.startsWith('UPDATE'))!;
    const a = JSON.parse(update[1][0])._customMcpAttestation;
    expect(a).toMatchObject({ actorSub: 'immutable-sub', tools: ['query'], credentialVersionId: 'a'.repeat(32) });
    expect(Number.isFinite(Date.parse(a.attestedAt))).toBe(true);
    expect(db.query.mock.calls[1][0]).toContain('FOR UPDATE');
    expect(secret.current).toHaveBeenCalledWith(7);
    const audit = db.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO customization_audit'))!;
    expect(audit[1]).toEqual(['immutable-sub', '7', JSON.stringify(a)]);
    expect(db.query.mock.calls.indexOf(audit)).toBeLessThan(db.query.mock.calls.indexOf(update));
    expect(db.query.mock.calls.at(-1)![0]).toBe('COMMIT');
  });
  it('rejects a changed row before any credential lookup or enablement', async () => {
    await expect(attestAndEnableMcp(7, 'sub', true, { ...shown, exposedTools: ['old'] })).rejects.toThrow('changed');
    expect(secret.current).not.toHaveBeenCalled();
    expect(db.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE'))).toBe(false);
  });
  it('rejects missing confirmation before taking a connection', async () => {
    await expect(attestAndEnableMcp(7, 'sub', false, shown)).rejects.toThrow('attestation');
    expect(db.connect).not.toHaveBeenCalled();
  });
  it('never enables an absent or unreadable credential', async () => {
    secret.current.mockRejectedValue(new Error('not provisioned'));
    await expect(attestAndEnableMcp(7, 'sub', true, shown)).rejects.toThrow('not provisioned');
    expect(db.query).toHaveBeenCalledWith('ROLLBACK');
    expect(db.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE'))).toBe(false);
  });
  it('rolls back without enabling when the durable audit cannot be written', async () => {
    db.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO customization_audit')) throw new Error('audit unavailable');
      return { rows: sql.includes('SELECT *') ? [row] : [] };
    });
    await expect(attestAndEnableMcp(7, 'sub', true, shown)).rejects.toThrow('audit unavailable');
    expect(db.query).toHaveBeenCalledWith('ROLLBACK');
    expect(db.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE'))).toBe(false);
  });
  it('holds the locked transaction until metadata and durable audit succeed', async () => {
    let resume!: (value: string) => void;
    secret.current.mockImplementationOnce(() => new Promise<string>(resolve => { resume = resolve; }));
    const enable = attestAndEnableMcp(7, 'sub', true, shown);
    await vi.waitFor(() => expect(secret.current).toHaveBeenCalled());
    expect(db.query.mock.calls.some(([sql]) => sql.includes('FOR UPDATE'))).toBe(true);
    expect(db.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE') || sql === 'COMMIT')).toBe(false);
    resume('a'.repeat(32));
    await enable;
    expect(db.query.mock.calls.at(-1)![0]).toBe('COMMIT');
  });
});


describe('catalog to resolver MCP ceiling', () => {
  const custom = { id: 1, name: 'custom-ro', tier: 'custom', enabled: true, gateway: 'security',
    persona: 'Read-only diagnostics', skills: [], routingKeywords: [] } as unknown as AgentWithSkills;
  it.each(['false', 'true'])('does not grant gateway reads when a selected row is suppressed with gate=%s', async gate => {
    vi.stubEnv('AURORA_ENDPOINT', 'fixture-only');
    vi.stubEnv('CUSTOM_MCP_ENABLED', gate);
    db.query.mockResolvedValue({ rows: [{ ...row, account_selected: true }] });
    try {
      const selection = await getEnabledIntegrationSelection('self');
      expect(selection).toMatchObject({ integrations: [], mcpSelectionSuppressed: true });
      const spec = resolveAgent('custom-ro', [custom], null, [], [], selection);
      expect(spec.toolAllowlist).toEqual([]);
      expect(spec.integrations).toBeUndefined();
      expect(spec.systemPromptOverride).not.toContain(row.endpoint);
      expect(secret.current).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
  });
  it('retains a disabled selected MCP declaration without exposing tools or context', async () => {
    vi.stubEnv('AURORA_ENDPOINT', 'fixture-only');
    db.query.mockResolvedValue({ rows: [{ ...row, enabled: false, account_selected: true }] });
    try {
      const selection = await getEnabledIntegrationSelection('self');
      expect(selection).toMatchObject({ integrations: [], mcpSelectionSuppressed: true });
      const spec = resolveAgent('custom-ro', [custom], null, [], [], selection);
      expect(spec.toolAllowlist).toEqual([]);
      expect(spec.integrations).toBeUndefined();
      expect(spec.systemPromptOverride).not.toContain(row.endpoint);
    } finally { vi.unstubAllEnvs(); }
  });
  it('retains the denied declaration of a global legacy row without granting membership', async () => {
    vi.stubEnv('AURORA_ENDPOINT', 'fixture-only');
    db.query.mockResolvedValue({ rows: [{ ...row, account_selected: false }] });
    try {
      const selection = await getEnabledIntegrationSelection('self');
      const spec = resolveAgent('custom-ro', [custom], null, [], [], selection);
      expect(selection.integrations).toEqual([]);
      expect(spec.toolAllowlist).toEqual([]);
      expect(spec.integrations).toBeUndefined();
    } finally { vi.unstubAllEnvs(); }
  });
  it('cannot establish unrestricted gateway access when selection lookup fails', async () => {
    vi.stubEnv('AURORA_ENDPOINT', 'fixture-only');
    db.query.mockRejectedValueOnce(new Error('unavailable'));
    try {
      const selection = await getEnabledIntegrationSelection('self');
      expect(resolveAgent('custom-ro', [custom], null, [], [], selection).toolAllowlist).toEqual([]);
    } finally { vi.unstubAllEnvs(); }
  });
  it('keeps the legacy read behavior when there is no MCP declaration', async () => {
    vi.stubEnv('AURORA_ENDPOINT', 'fixture-only');
    db.query.mockResolvedValue({ rows: [] });
    try {
      const selection = await getEnabledIntegrationSelection('self');
      expect(selection.mcpSelectionSuppressed).toBe(false);
      expect(resolveAgent('custom-ro', [custom], null, [], [], selection).toolAllowlist).toBeUndefined();
    } finally { vi.unstubAllEnvs(); }
  });
});

describe('suppression diagnostics and legacy isolation', () => {
  it.each([
    { direction: 'ingress', capability: 'read', exposed_tools: ['query'] },
    { direction: 'egress', capability: 'read_write', exposed_tools: ['write'] },
    { direction: 'egress', capability: 'read', exposed_tools: { legacy: true } },
    { direction: 'egress', capability: 'read', exposed_tools: null },
  ])('quarantines non-declarations per row: %j', async shape => {
    vi.stubEnv('AURORA_ENDPOINT', 'fixture-only');
    db.query.mockResolvedValue({ rows: [{ ...row, kind: 'grafana', ...shape }] });
    try {
      const selection = await getEnabledIntegrationSelection('self');
      expect(selection.mcpSelectionSuppressed).toBe(false);
      expect(selection.mcpSuppressionReasons).toBeUndefined();
    } finally { vi.unstubAllEnvs(); }
  });
  it.each([
    ['denied', { ...row, account_selected: true }],
    ['disabled-selected', { ...row, enabled: false, account_selected: true }],
  ])('records a non-secret %s reason', async (reason, raw) => {
    vi.stubEnv('AURORA_ENDPOINT', 'fixture-only');
    db.query.mockResolvedValue({ rows: [raw] });
    try {
      expect((await getEnabledIntegrationSelection('self')).mcpSuppressionReasons).toEqual([reason]);
    } finally { vi.unstubAllEnvs(); }
  });
  it('distinguishes database lookup failure from policy denial', async () => {
    vi.stubEnv('AURORA_ENDPOINT', 'fixture-only');
    db.query.mockRejectedValueOnce(new Error('fixture failure'));
    try {
      expect((await getEnabledIntegrationSelection('self')).mcpSuppressionReasons).toEqual(['lookup-failed']);
    } finally { vi.unstubAllEnvs(); }
  });
});
