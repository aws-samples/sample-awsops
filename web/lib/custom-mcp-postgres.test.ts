import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { Pool } from 'pg';
const db = vi.hoisted(() => ({ pool: null as unknown }));
const secret = vi.hoisted(() => ({ current: vi.fn() }));
vi.mock('@/lib/db', () => ({ getPool: () => db.pool }));
vi.mock('./custom-mcp-secret', () => ({ currentCustomMcpSecretVersion: secret.current }));
import { attestAndEnableMcp, getEnabledIntegrationSelection, getEnabledIntegrations, getIntegrationById, setIntegrationEnabled, upsertIntegration } from './integrations';
import { DATASOURCE_KINDS } from './integrations-category';
const socket = process.env.CUSTOM_MCP_TEST_POSTGRES_SOCKET;
describe.skipIf(!socket)('MCP governance on disposable PostgreSQL 17', () => {
  let pool: Pool;
  const input = { name: 'custom-ro', kind: 'custom_mcp', direction: 'egress' as const,
    capability: 'read' as const, endpoint: 'https://example.com/mcp', transport: 'api_key', exposedTools: ['query'] };
  beforeAll(async () => {
    expect(socket?.startsWith('/')).toBe(true);
    expect(statSync(`${socket}/.s.PGSQL.5432`).isSocket()).toBe(true);
    pool = new Pool({ host: socket, user: 'postgres', database: 'awsops_mcp_test', max: 3 });
    expect((await pool.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()")).rows[0].marker)
      .toBe('awsops-disposable-mcp-test');
    expect((await pool.query('SHOW server_version')).rows[0].server_version).toMatch(/^17\./);
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    for (const name of ['01KTY39P4SV1SQES36KCS8BESY_custom_agent_platform_p1.sql',
      '01KV0JKFF7Q28CMKQ2JGM2D1NK_integrations_p2.sql',
      '01KY1S49Q20DY16RM99Q1S73WR_datasource_kinds_jaeger_dynatrace.sql',
      '01M57KRRZG3CZ7YZ4M4N7KQH2N_custom_mcp_attestation_audit.sql']) {
      await pool.query(readFileSync(new URL(`../../terraform/foundation/migrations/${name}`, import.meta.url), 'utf8'));
    }
    db.pool = pool;
  });
  beforeEach(async () => {
    process.env.AURORA_ENDPOINT = 'fixture-only';
    process.env.CUSTOM_MCP_ENABLED = 'true';
    delete process.env.INTEGRATIONS_SECRET_NAME;
    secret.current.mockReset().mockResolvedValue('a'.repeat(32));
    await pool.query('TRUNCATE integrations, agent_spaces, customization_audit RESTART IDENTITY');
  });
  afterAll(async () => { await pool?.end(); delete process.env.AURORA_ENDPOINT; });
  async function enabled(kind = 'custom_mcp') {
    const id = await upsertIntegration({ ...input, kind });
    const i = await getIntegrationById(id);
    await attestAndEnableMcp(id, 'immutable-sub', true, i);
    return id;
  }
  async function selected(accountId: string, ids: number[]) {
    await pool.query('INSERT INTO agent_spaces(account_id,enabled_integration_ids) VALUES($1,$2::jsonb)',
      [accountId, JSON.stringify(ids)]);
  }
  it('requires explicit membership and never falls back to the global enabled catalog', async () => {
    const id = await enabled();
    expect(await getEnabledIntegrations('self')).toEqual([]);
    await selected('other', [id]);
    await selected('self', []);
    expect(await getEnabledIntegrations('self')).toEqual([]);
    expect((await getEnabledIntegrations('other')).map(i => Number(i.id))).toEqual([id]);
    await pool.query('UPDATE agent_spaces SET enabled_integration_ids=$1::jsonb WHERE account_id=$2', [JSON.stringify([id]), 'self']);
    expect((await getEnabledIntegrations('self')).map(i => Number(i.id))).toEqual([id]);
  });
  it('does not exempt vendor-labelled MCP connections from account or attestation controls', async () => {
    const id = await enabled('grafana');
    expect(await getEnabledIntegrations('self')).toEqual([]);
    await selected('self', [id]);
    expect(await getEnabledIntegrations('self')).toHaveLength(1);
  });
  it('keeps the existing global fallback for non-MCP bundled registrations', async () => {
    const id = await upsertIntegration({ ...input, kind: 'grafana', endpoint: undefined, exposedTools: [] });
    await setIntegrationEnabled(id, true);
    expect((await getEnabledIntegrations('self')).map(i => Number(i.id))).toEqual([id]);
  });
  it('cannot use the generic enable helper to bypass attestation', async () => {
    const id = await upsertIntegration(input);
    await expect(setIntegrationEnabled(id, true)).rejects.toThrow('generic helper');
    expect((await getIntegrationById(id))?.enabled).toBe(false);
  });
  it.each(DATASOURCE_KINDS)('can disable and re-enable a native %s datasource without MCP credentials', async kind => {
    // Same endpoint/read/custom shape as createDatasource; transport/reference are NULL.
    const { rows } = await pool.query(
      `INSERT INTO integrations(name,kind,direction,capability,endpoint,tier,enabled)
       VALUES($1,$2,'egress','read','https://example.com/query','custom',true) RETURNING id`,
      [`native-${kind}`, kind]);
    const id = Number(rows[0].id);
    delete process.env.CUSTOM_MCP_ENABLED;
    await setIntegrationEnabled(id, false);
    expect((await getIntegrationById(id))?.enabled).toBe(false);
    await setIntegrationEnabled(id, true);
    expect((await getEnabledIntegrations('self')).map(i => Number(i.id))).toEqual([id]);
    await pool.query("UPDATE integrations SET transport='api_key' WHERE id=$1", [id]);
    await setIntegrationEnabled(id, false);
    await expect(setIntegrationEnabled(id, true)).rejects.toThrow('generic helper');
  });
  it.each([{}, 'legacy', 7, null])('isolates malformed legacy tool JSON %j without blanking healthy catalog rows', async tools => {
    const healthy = await upsertIntegration({ ...input, name: 'context-only',
      kind: 'grafana', endpoint: undefined, exposedTools: [] });
    await setIntegrationEnabled(healthy, true);
    const broken = await upsertIntegration({ ...input, name: 'legacy-broken', kind: 'grafana',
      endpoint: undefined, exposedTools: [] });
    await pool.query('UPDATE integrations SET exposed_tools=$1::jsonb,enabled=true WHERE id=$2',
      [JSON.stringify(tools), broken]);
    await selected('self', [healthy, broken]);
    expect((await getEnabledIntegrations('self')).map(i => Number(i.id))).toEqual([healthy]);
    await expect(setIntegrationEnabled(broken, true)).rejects.toThrow('generic helper');
    await setIntegrationEnabled(broken, false);
    expect((await getIntegrationById(broken))?.enabled).toBe(false);
  });
  it('every edit disables the row and clears the attestation, including attacker-supplied context', async () => {
    const id = await enabled();
    await selected('self', [id]);
    const prior = await getIntegrationById(id);
    expect(await upsertIntegration({ ...input, endpoint: 'https://changed.example/mcp',
      providedContext: prior!.providedContext })).toBe(id);
    const current = await getIntegrationById(id);
    expect(current?.enabled).toBe(false);
    expect(current?.providedContext._customMcpAttestation).toBeUndefined();
    const audit = (await pool.query("SELECT actor,details FROM customization_audit WHERE action='attest_enable'")).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor: 'immutable-sub', details: {
      tools: ['query'], endpoint: input.endpoint, credentialVersionId: 'a'.repeat(32),
    } });
    await pool.query('UPDATE integrations SET enabled=true WHERE id=$1', [id]);
    expect(await getEnabledIntegrations('self')).toEqual([]);
  });
  it('rejects stale confirmations after an endpoint edit', async () => {
    const id = await upsertIntegration(input);
    const old = await getIntegrationById(id);
    await upsertIntegration({ ...input, endpoint: 'https://changed.example/mcp' });
    await expect(attestAndEnableMcp(id, 'sub', true, old)).rejects.toThrow('changed');
    expect(secret.current).not.toHaveBeenCalled();
  });
  it('serializes edits against enablement and leaves the edited row disabled', async () => {
    const id = await upsertIntegration(input);
    const i = await getIntegrationById(id);
    let release!: () => void, reached!: () => void;
    const blocked = new Promise<void>(r => { release = r; });
    const ready = new Promise<void>(r => { reached = r; });
    secret.current.mockImplementationOnce(async () => { reached(); await blocked; return 'a'.repeat(32); });
    const enable = attestAndEnableMcp(id, 'sub', true, i);
    await ready;
    const edit = upsertIntegration({ ...input, exposedTools: ['other'] });
    release();
    await Promise.all([enable, edit]);
    expect((await getIntegrationById(id))?.enabled).toBe(false);
    expect((await getIntegrationById(id))?.providedContext._customMcpAttestation).toBeUndefined();
  });
  it.each(['false', 'true'])('preserves suppressed selected MCP policy with gate=%s', async gate => {
    const id = await upsertIntegration(input);
    await selected('self', [id]);
    await pool.query('UPDATE integrations SET enabled=true WHERE id=$1', [id]);
    process.env.CUSTOM_MCP_ENABLED = gate;
    expect(await getEnabledIntegrationSelection('self')).toEqual({ integrations: [], mcpSelectionSuppressed: true });
  });
  it('keeps an explicitly selected disabled MCP row as a denied policy declaration', async () => {
    const id = await enabled();
    await selected('self', [id]);
    await setIntegrationEnabled(id, false);
    expect(await getEnabledIntegrationSelection('self')).toEqual({ integrations: [], mcpSelectionSuppressed: true });
  });
  it('does not mistake a suppressed global legacy row for an absent declaration', async () => {
    const id = await enabled();
    expect(await getEnabledIntegrationSelection('self')).toEqual({ integrations: [], mcpSelectionSuppressed: true });
    await selected('self', []);
    expect(await getEnabledIntegrationSelection('self')).toEqual({ integrations: [], mcpSelectionSuppressed: false });
    await pool.query('UPDATE agent_spaces SET enabled_integration_ids=$1::jsonb WHERE account_id=$2', [JSON.stringify([id]), 'self']);
    expect((await getEnabledIntegrationSelection('self')).integrations.map(i => Number(i.id))).toEqual([id]);
  });

});
