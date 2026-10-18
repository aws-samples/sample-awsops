import { beforeEach, describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn(), connect: vi.fn() }));
const secret = vi.hoisted(() => ({ current: vi.fn() }));
vi.mock('@/lib/db', () => ({ getPool: () => db }));
vi.mock('./custom-mcp-secret', () => ({ currentCustomMcpSecretVersion: secret.current }));
import { attestAndEnableMcp, getEnabledIntegrations, upsertIntegration } from './integrations';
const row = { id: '7', kind: 'custom_mcp', tier: 'custom', direction: 'egress', capability: 'read',
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
