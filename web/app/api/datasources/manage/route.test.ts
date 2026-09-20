import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyUser = vi.fn();
const isAdmin = vi.fn();
const createDatasource = vi.fn();
const updateDatasource = vi.fn();
const getDatasource = vi.fn();
const setIntegrationCredentialById = vi.fn();
const getCredentialById = vi.fn();
const mirrorDefaultCredential = vi.fn();
const invokeMcpLambdaTool = vi.fn();
const upsertSchema = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/admin', () => ({ isAdmin: (...a: unknown[]) => isAdmin(...a) }));
vi.mock('@/lib/datasources', () => ({
  // REAL sanitizer (round-6: a pass-through stub hid the empty-sanitize 400 path and could
  // mask a regression letting raw body.settings reach the blob)
  sanitizeDsSettings: (x: unknown) => {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return {};
    const o = x as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    if (typeof o.timeoutS === 'number' && Number.isInteger(o.timeoutS) && o.timeoutS >= 1 && o.timeoutS <= 60) out.timeoutS = o.timeoutS;
    if (typeof o.database === 'string' && o.database.length <= 128 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(o.database)
        && !['system', 'information_schema'].includes(o.database.toLowerCase())) out.database = o.database;
    return out;
  },
  createDatasource: (...a: unknown[]) => createDatasource(...a),
  withDatasourceLock: (_id: number, fn: (c: unknown) => Promise<unknown>) => fn({ query: vi.fn() }),
  updateDatasource: (...a: unknown[]) => updateDatasource(...a),
  getDatasource: (...a: unknown[]) => getDatasource(...a),
}));
vi.mock('@/lib/integration-credentials', () => ({
  setIntegrationCredentialById: (...a: unknown[]) => setIntegrationCredentialById(...a),
  mirrorDefaultCredential: (...a: unknown[]) => mirrorDefaultCredential(...a),
  getCredentialById: (...a: unknown[]) => getCredentialById(...a),
}));
vi.mock('@/lib/mcp-lambda-invoke', () => ({ invokeMcpLambdaTool: (...a: unknown[]) => invokeMcpLambdaTool(...a) }));
vi.mock('@/lib/datasource-schema', () => ({ upsertSchema: (...a: unknown[]) => upsertSchema(...a) }));
vi.mock('@/lib/account', () => ({ currentAccountId: () => 'self' }));

function req(body: unknown, method = 'POST') {
  return new Request('http://x/api/datasources/manage', {
    method, headers: { 'content-type': 'application/json', cookie: 'awsops_token=t' }, body: JSON.stringify(body),
  });
}

beforeEach(() => {
  for (const m of [verifyUser, isAdmin, createDatasource, updateDatasource, getDatasource, setIntegrationCredentialById, getCredentialById, mirrorDefaultCredential, invokeMcpLambdaTool, upsertSchema]) m.mockReset();
  invokeMcpLambdaTool.mockResolvedValue({ version: '2.48.0', metrics: ['up'] });
  upsertSchema.mockResolvedValue(undefined);
  process.env.AURORA_ENDPOINT = 'aurora.example';
  verifyUser.mockResolvedValue({ sub: 'u' });
  isAdmin.mockResolvedValue(true);
  createDatasource.mockResolvedValue(7);
  getDatasource.mockResolvedValue({ id: 7, name: 'p', kind: 'prometheus', endpoint: 'http://p', authType: 'none', isDefault: true, enabled: true });
  setIntegrationCredentialById.mockResolvedValue(undefined);
  mirrorDefaultCredential.mockResolvedValue(undefined);
  updateDatasource.mockResolvedValue(undefined);
});

describe('POST create', () => {
  it('403 non-admin, no writes', async () => {
    isAdmin.mockResolvedValue(false);
    const { POST } = await import('./route');
    expect((await POST(req({ name: 'p', kind: 'prometheus', endpoint: 'http://10.0.0.5' }))).status).toBe(403);
    expect(createDatasource).not.toHaveBeenCalled();
  });

  it('creates the row, stores the id credential, mirrors when default, returns 201', async () => {
    const { POST } = await import('./route');
    const resp = await POST(req({ name: 'prod-prom', kind: 'prometheus', endpoint: 'http://10.0.0.5:9090', authType: 'bearer', creds: { token: 't' } }));
    expect(resp.status).toBe(201);
    expect(await resp.json()).toEqual({ id: 7 });
    expect(setIntegrationCredentialById).toHaveBeenCalledWith(7, { endpoint: 'http://10.0.0.5:9090', authType: 'bearer', token: 't' });
    expect(mirrorDefaultCredential).toHaveBeenCalledWith('prometheus', { endpoint: 'http://10.0.0.5:9090', authType: 'bearer', token: 't' });
  });

  it('fires a best-effort connect-time introspect (after the 201) and never lets it fail create', async () => {
    invokeMcpLambdaTool.mockRejectedValue(new Error('connector down'));
    const { POST } = await import('./route');
    const resp = await POST(req({ name: 'prod-prom', kind: 'prometheus', endpoint: 'http://10.0.0.5:9090', authType: 'none' }));
    expect(resp.status).toBe(201); // create succeeds regardless of introspection
    await new Promise((r) => setImmediate(r)); // let the fire-and-forget microtask run
    expect(invokeMcpLambdaTool).toHaveBeenCalledWith(expect.objectContaining({ kind: 'prometheus', tool: 'prometheus_schema' }));
    // upsertSchema not reached because invoke rejected — and no unhandled rejection escaped (test would fail otherwise)
    expect(upsertSchema).not.toHaveBeenCalled();
  });

  it('warms the schema cache on a successful create', async () => {
    const { POST } = await import('./route');
    const resp = await POST(req({ name: 'prod-prom', kind: 'prometheus', endpoint: 'http://10.0.0.5:9090', authType: 'none' }));
    expect(resp.status).toBe(201);
    await new Promise((r) => setImmediate(r));
    expect(upsertSchema).toHaveBeenCalledWith('self', 7, 'prometheus', expect.objectContaining({ version: '2.48.0' }));
  });

  it('SSRF-blocks the endpoint (400, no create)', async () => {
    const { POST } = await import('./route');
    expect((await POST(req({ name: 'x', kind: 'prometheus', endpoint: 'http://169.254.169.254' }))).status).toBe(400);
    expect(createDatasource).not.toHaveBeenCalled();
  });

  it('maps duplicate name to 409', async () => {
    createDatasource.mockRejectedValue(new Error('duplicate datasource name'));
    const { POST } = await import('./route');
    expect((await POST(req({ name: 'dupe', kind: 'loki', endpoint: 'http://10.0.0.5' }))).status).toBe(409);
  });

  it('rejects unknown kind / missing name', async () => {
    const { POST } = await import('./route');
    expect((await POST(req({ name: 'x', kind: 'notion', endpoint: 'http://10.0.0.5' }))).status).toBe(400);
    expect((await POST(req({ kind: 'loki', endpoint: 'http://10.0.0.5' }))).status).toBe(400);
  });

  it('gap L203: settings ride create into createDatasource', async () => {
    createDatasource.mockResolvedValue(11);
    getDatasource.mockResolvedValue({ id: 11, kind: 'clickhouse', isDefault: false });
    const { POST } = await import('./route');
    const res = await POST(req({ name: 'ch', kind: 'clickhouse', endpoint: 'http://10.0.0.5:8123', settings: { timeoutS: 30, database: 'metrics' } }));
    expect(res.status).toBe(201);
    expect(createDatasource.mock.calls[0][0].settings).toEqual({ timeoutS: 30, database: 'metrics' });
  });
});

describe('PATCH update', () => {
  it('404 when not found', async () => {
    getDatasource.mockResolvedValue(null);
    const { PATCH } = await import('./route');
    expect((await PATCH(req({ id: 99, name: 'x' }, 'PATCH'))).status).toBe(404);
  });

  it('updates the credential when a connection field changes, then updateDatasource', async () => {
    const { PATCH } = await import('./route');
    const resp = await PATCH(req({ id: 7, endpoint: 'http://10.0.0.9:9090', authType: 'none' }, 'PATCH'));
    expect(resp.status).toBe(200);
    expect(setIntegrationCredentialById).toHaveBeenCalledWith(7, { endpoint: 'http://10.0.0.9:9090', authType: 'none' }, expect.anything());
    expect(updateDatasource).toHaveBeenCalled();
  });

  it('a settings-only PATCH MERGES onto the existing credential — stored auth material survives', async () => {
    getCredentialById.mockResolvedValue({ endpoint: 'http://old:9090', authType: 'basic', username: 'u', password: 'pw' });
    getDatasource.mockResolvedValue({ id: 7, kind: 'prometheus', endpoint: 'http://old:9090', authType: 'basic', isDefault: false, settings: {} });
    const { PATCH } = await import('./route');
    const resp = await PATCH(req({ id: 7, settings: { timeoutS: 15 } }, 'PATCH'));
    expect(resp.status).toBe(200);
    const blob = setIntegrationCredentialById.mock.calls.at(-1)![1];
    expect(blob.username).toBe('u');    // NOT wiped by the settings-only rewrite
    expect(blob.password).toBe('pw');
    expect(blob.timeoutS).toBe(15);
  });

  it('settings:{} genuinely clears — stale blob settings keys are stripped, auth survives', async () => {
    getCredentialById.mockResolvedValue({ endpoint: 'http://old:9090', authType: 'basic', username: 'u', password: 'pw', timeoutS: 30, database: 'metrics' });
    getDatasource.mockResolvedValue({ id: 7, kind: 'clickhouse', endpoint: 'http://old:9090', authType: 'basic', isDefault: false, settings: { timeoutS: 30, database: 'metrics' } });
    const { PATCH } = await import('./route');
    await PATCH(req({ id: 7, settings: {} }, 'PATCH'));
    const blob = setIntegrationCredentialById.mock.calls.at(-1)![1];
    expect(blob.timeoutS).toBeUndefined();
    expect(blob.database).toBeUndefined();
    expect(blob.username).toBe('u');
  });

  it('auth material does NOT follow an endpoint HOST change unless creds are re-supplied', async () => {
    getCredentialById.mockResolvedValue({ endpoint: 'http://old:9090', authType: 'basic', username: 'u', password: 'pw' });
    getDatasource.mockResolvedValue({ id: 7, kind: 'prometheus', endpoint: 'http://old:9090', authType: 'basic', isDefault: false, settings: {} });
    const { PATCH } = await import('./route');
    await PATCH(req({ id: 7, endpoint: 'http://evil.internal:9090' }, 'PATCH'));
    const blob = setIntegrationCredentialById.mock.calls.at(-1)![1];
    expect(blob.username).toBeUndefined(); // write-only creds never transmit to a new host
    expect(blob.password).toBeUndefined();
    // same host (port path changes only) keeps them
    await PATCH(req({ id: 7, endpoint: 'http://old:9090/subpath' }, 'PATCH'));
    const blob2 = setIntegrationCredentialById.mock.calls.at(-1)![1];
    expect(blob2.username).toBe('u');
  });

  it("the UI's creds:{} does NOT defeat the host-change guard (round-4)", async () => {
    getCredentialById.mockResolvedValue({ endpoint: 'http://old:9090', authType: 'basic', username: 'u', password: 'pw' });
    getDatasource.mockResolvedValue({ id: 7, kind: 'prometheus', endpoint: 'http://old:9090', authType: 'basic', isDefault: false, settings: {} });
    const { PATCH } = await import('./route');
    // the shipped form always sends creds (possibly {}) — an endpoint host edit from the UI
    await PATCH(req({ id: 7, endpoint: 'http://evil.internal:9090', creds: {} }, 'PATCH'));
    const blob = setIntegrationCredentialById.mock.calls.at(-1)![1];
    expect(blob.username).toBeUndefined();
    expect(blob.password).toBeUndefined();
    // genuinely re-supplied creds DO follow the new host
    await PATCH(req({ id: 7, endpoint: 'http://new.internal:9090', creds: { username: 'n', password: 'npw' } }, 'PATCH'));
    const blob2 = setIntegrationCredentialById.mock.calls.at(-1)![1];
    expect(blob2.username).toBe('n');
  });

  it('a PARTIAL creds object on a host change carries only what was re-supplied (round-5)', async () => {
    getCredentialById.mockResolvedValue({ endpoint: 'http://old:9090', authType: 'basic', username: 'u', password: 'pw' });
    getDatasource.mockResolvedValue({ id: 7, kind: 'prometheus', endpoint: 'http://old:9090', authType: 'basic', isDefault: false, settings: {} });
    const { PATCH } = await import('./route');
    await PATCH(req({ id: 7, endpoint: 'http://new.internal:9090', creds: { username: 'x' } }, 'PATCH'));
    const blob = setIntegrationCredentialById.mock.calls.at(-1)![1];
    expect(blob.username).toBe('x');
    expect(blob.password).toBeUndefined(); // the STORED password never follows the new origin
  });

  it('creds cannot smuggle endpoint/database keys into the blob (key allowlist, round-5)', async () => {
    getCredentialById.mockResolvedValue({ endpoint: 'http://old:9090', authType: 'basic', username: 'u', password: 'pw' });
    getDatasource.mockResolvedValue({ id: 7, kind: 'prometheus', endpoint: 'http://old:9090', authType: 'basic', isDefault: false, settings: {} });
    const { PATCH } = await import('./route');
    await PATCH(req({ id: 7, creds: { endpoint: 'https://attacker.example', database: 'system', username: 'u2' } }, 'PATCH'));
    const blob = setIntegrationCredentialById.mock.calls.at(-1)![1];
    expect(blob.endpoint).toBe('http://old:9090'); // the validated row endpoint, not the smuggled one
    expect(blob.database).toBeUndefined();
    expect(blob.username).toBe('u2');
  });

  it('a duplicate-name 409 commits NOTHING (name preflight before any write)', async () => {
    getDatasource.mockResolvedValue({ id: 7, kind: 'prometheus', endpoint: 'http://old:9090', authType: 'basic', isDefault: false, settings: {} });
    updateDatasource.mockRejectedValueOnce(new Error('duplicate datasource name'));
    const { PATCH } = await import('./route');
    const res = await PATCH(req({ id: 7, name: 'dupe', endpoint: 'http://new:9090', settings: { timeoutS: 5 } }, 'PATCH'));
    expect(res.status).toBe(409);
    expect(setIntegrationCredentialById).not.toHaveBeenCalled();
  });

  it('an https→http downgrade counts as a host change (origin compare — no cleartext transmit)', async () => {
    getCredentialById.mockResolvedValue({ endpoint: 'https://prom:9090', authType: 'basic', username: 'u', password: 'pw' });
    getDatasource.mockResolvedValue({ id: 7, kind: 'prometheus', endpoint: 'https://prom:9090', authType: 'basic', isDefault: false, settings: {} });
    const { PATCH } = await import('./route');
    await PATCH(req({ id: 7, endpoint: 'http://prom:9090', creds: {} }, 'PATCH'));
    const blob = setIntegrationCredentialById.mock.calls.at(-1)![1];
    expect(blob.username).toBeUndefined();
  });

  it('a migrated DEFAULT instance merges from the kind mirror and re-mirrors the post-merge blob (round-4)', async () => {
    // credential lives ONLY under the kind mirror — the id-keyed entry is empty
    getCredentialById.mockImplementation(async (_id: number, kind?: string) => (kind ? { endpoint: 'http://p:9090', authType: 'bearer', token: 'tok' } : null));
    getDatasource.mockResolvedValue({ id: 7, kind: 'prometheus', endpoint: 'http://p:9090', authType: 'bearer', isDefault: true, settings: {} });
    const { PATCH } = await import('./route');
    await PATCH(req({ id: 7, settings: { timeoutS: 15 } }, 'PATCH'));
    const blob = setIntegrationCredentialById.mock.calls.at(-1)![1];
    expect(blob.token).toBe('tok');       // NOT de-authenticated
    expect(blob.timeoutS).toBe(15);
    // the kind mirror is refreshed with the POST-merge blob (not the stale pre-PATCH one)
    const mirrored = mirrorDefaultCredential.mock.calls.at(-1)!;
    expect(mirrored[0]).toBe('prometheus');
    expect(mirrored[1].token).toBe('tok');
    expect(mirrored[1].timeoutS).toBe(15);
  });

  it('a backslash endpoint is rejected on PATCH (URL-parser differential, round-6)', async () => {
    getCredentialById.mockResolvedValue({ endpoint: 'http://old:9090', authType: 'basic', username: 'u', password: 'pw' });
    getDatasource.mockResolvedValue({ id: 7, kind: 'prometheus', endpoint: 'http://old:9090', authType: 'basic', isDefault: false, settings: {} });
    const { PATCH } = await import('./route');
    const res = await PATCH(req({ id: 7, endpoint: 'http://old:9090\\@attacker.example:9091', creds: {} }, 'PATCH'));
    expect(res.status).toBe(400);
    expect(setIntegrationCredentialById).not.toHaveBeenCalled();
  });

  it('a non-empty settings object that sanitizes to EMPTY is a 400, never a silent clear (round-6)', async () => {
    getDatasource.mockResolvedValue({ id: 7, kind: 'clickhouse', endpoint: 'http://ch:8123', authType: 'none', isDefault: false, settings: { database: 'metrics' } });
    const { PATCH } = await import('./route');
    const res = await PATCH(req({ id: 7, settings: { timeoutS: 0 } }, 'PATCH'));
    expect(res.status).toBe(400);
    expect(updateDatasource).not.toHaveBeenCalled();
    expect(setIntegrationCredentialById).not.toHaveBeenCalled();
  });

  it('non-object settings shapes are a 400, never a silent clear (round-8)', async () => {
    getDatasource.mockResolvedValue({ id: 7, kind: 'clickhouse', endpoint: 'http://ch:8123', authType: 'none', isDefault: false, settings: { database: 'metrics' } });
    const { PATCH } = await import('./route');
    for (const bad of [null, [1], 'garbage', 5]) {
      const res = await PATCH(req({ id: 7, settings: bad }, 'PATCH'));
      expect(res.status).toBe(400);
    }
    expect(updateDatasource).not.toHaveBeenCalled();
    expect(setIntegrationCredentialById).not.toHaveBeenCalled();
  });

  it('an authType downgrade prunes residue auth keys from the blob', async () => {
    getCredentialById.mockResolvedValue({ endpoint: 'http://old:9090', authType: 'basic', username: 'u', password: 'pw' });
    getDatasource.mockResolvedValue({ id: 7, kind: 'prometheus', endpoint: 'http://old:9090', authType: 'basic', isDefault: false, settings: {} });
    const { PATCH } = await import('./route');
    await PATCH(req({ id: 7, authType: 'none' }, 'PATCH'));
    const blob = setIntegrationCredentialById.mock.calls.at(-1)![1];
    expect(blob.username).toBeUndefined();
    expect(blob.password).toBeUndefined();
    expect(blob.authType).toBe('none');
  });

  it('gap L203: settings pass on PATCH only when present (absent ≠ clear; {} clears)', async () => {
    const { PATCH } = await import('./route');
    await PATCH(req({ id: 7, settings: { timeoutS: 15 } }, 'PATCH'));
    expect(updateDatasource.mock.calls.at(-1)![1].settings).toEqual({ timeoutS: 15 });
    await PATCH(req({ id: 7, name: 'renamed' }, 'PATCH'));
    expect(updateDatasource.mock.calls.at(-1)![1].settings).toBeUndefined();
    await PATCH(req({ id: 7, settings: {} }, 'PATCH'));
    expect(updateDatasource.mock.calls.at(-1)![1].settings).toEqual({});
  });
});
