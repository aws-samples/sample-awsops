import { describe, it, expect, vi, beforeEach } from 'vitest';

const query = vi.fn();
vi.mock('@/lib/db', () => ({ getPool: () => ({ query }) }));
const getCredentialById = vi.fn();
const mirrorDefaultCredential = vi.fn();
const deleteCredentialKeys = vi.fn();
vi.mock('@/lib/integration-credentials', () => ({
  getCredentialById: (...a: unknown[]) => getCredentialById(...a),
  mirrorDefaultCredential: (...a: unknown[]) => mirrorDefaultCredential(...a),
  deleteCredentialKeys: (...a: unknown[]) => deleteCredentialKeys(...a),
}));

import {
  createDatasource, listDatasources, getDatasource, updateDatasource, getDefaultDatasource, resolveConnConfig,
} from './datasources';

beforeEach(() => {
  query.mockReset();
  getCredentialById.mockReset();
  mirrorDefaultCredential.mockReset();
  deleteCredentialKeys.mockReset();
});

describe('createDatasource', () => {
  it('inserts an egress+read integrations row with enabled=true and returns the id', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 7 }] });
    const id = await createDatasource({ name: 'prod-prom', kind: 'prometheus', endpoint: 'http://p:9090', authType: 'none' });
    expect(id).toBe(7);
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toMatch(/INSERT INTO integrations/i);
    expect(sql).toMatch(/'egress'/);
    expect(sql).toMatch(/enabled/);
    // is_default derived as "first of kind" via NOT EXISTS
    expect(sql).toMatch(/NOT EXISTS/i);
  });

  it('coerces a node-pg string BIGSERIAL id to a number (else the credential write breaks)', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: '42' }] }); // node-pg returns BIGINT as a STRING
    const id = await createDatasource({ name: 'p', kind: 'prometheus', endpoint: 'http://p:9090', authType: 'none' });
    expect(id).toBe(42);
    expect(typeof id).toBe('number'); // not the string '42' — assertPositiveId would have thrown
  });

  it('rejects a non-datasource kind with no DB call', async () => {
    await expect(createDatasource({ name: 'x', kind: 'notion', endpoint: 'http://n', authType: 'none' })).rejects.toThrow(/kind/i);
    expect(query).not.toHaveBeenCalled();
  });

  it('maps a unique-violation to a duplicate-name error', async () => {
    query.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }));
    await expect(createDatasource({ name: 'dupe', kind: 'loki', endpoint: 'http://l', authType: 'none' })).rejects.toThrow(/duplicate/i);
  });
});

describe('listDatasources', () => {
  it('selects only egress+read datasource-kind rows', async () => {
    query.mockResolvedValueOnce({ rows: [
      { id: 1, name: 'a', kind: 'prometheus', endpoint: 'http://p', ds_auth_type: 'none', is_default: true, enabled: true },
      { id: 2, name: 'b', kind: 'loki', endpoint: 'http://l', ds_auth_type: 'bearer', is_default: false, enabled: true },
    ] });
    const rows = await listDatasources();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: 1, name: 'a', kind: 'prometheus', authType: 'none', isDefault: true });
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toMatch(/direction = 'egress'/);
    expect(sql).toMatch(/capability = 'read'/);
  });
});

describe('getDefaultDatasource', () => {
  it('returns the is_default row for a kind, or null', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 3, name: 'd', kind: 'tempo', endpoint: 'http://t', ds_auth_type: 'none', is_default: true, enabled: true }] });
    expect(await getDefaultDatasource('tempo')).toMatchObject({ id: 3, isDefault: true });
    query.mockResolvedValueOnce({ rows: [] });
    expect(await getDefaultDatasource('mimir')).toBeNull();
  });
});

describe('updateDatasource', () => {
  it('re-mirrors the kind credential when the updated row is the current default', async () => {
    query.mockResolvedValueOnce({ rows: [] }); // UPDATE
    query.mockResolvedValueOnce({ rows: [{ id: 9, name: 'n', kind: 'prometheus', endpoint: 'http://p', ds_auth_type: 'none', is_default: true, enabled: true }] }); // re-read
    getCredentialById.mockResolvedValueOnce({ endpoint: 'http://p', authType: 'none' });
    await updateDatasource(9, { endpoint: 'http://p' });
    expect(mirrorDefaultCredential).toHaveBeenCalledWith('prometheus', { endpoint: 'http://p', authType: 'none' });
  });

  it('does NOT mirror when the updated row is not the default', async () => {
    query.mockResolvedValueOnce({ rows: [] }); // UPDATE
    query.mockResolvedValueOnce({ rows: [{ id: 9, name: 'n', kind: 'prometheus', endpoint: 'http://p', ds_auth_type: 'none', is_default: false, enabled: true }] });
    await updateDatasource(9, { endpoint: 'http://p' });
    expect(mirrorDefaultCredential).not.toHaveBeenCalled();
  });
});

describe('getDatasource', () => {
  it('returns the row by id or null', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 4, name: 'x', kind: 'clickhouse', endpoint: 'http://c', ds_auth_type: 'basic', is_default: false, enabled: true }] });
    expect(await getDatasource(4)).toMatchObject({ id: 4, kind: 'clickhouse', authType: 'basic' });
    query.mockResolvedValueOnce({ rows: [] });
    expect(await getDatasource(404)).toBeNull();
  });
});

describe('resolveConnConfig', () => {
  const row = { id: 1, name: 'p', kind: 'prometheus', endpoint: 'http://p:9090', authType: 'none' as const, isDefault: true, enabled: true };

  it('uses the ROW endpoint + authType when no SM credential exists (auth=none heal path)', async () => {
    getCredentialById.mockResolvedValueOnce(null); // no stored cred (auth=none, or never written)
    expect(await resolveConnConfig(row)).toEqual({ endpoint: 'http://p:9090', authType: 'none' });
  });

  it('resolves the credential by id ONLY — no kind-mirror fallback (no default-cred leak to another instance)', async () => {
    getCredentialById.mockResolvedValueOnce(null);
    await resolveConnConfig(row);
    expect(getCredentialById).toHaveBeenCalledWith(1);           // id only
    expect(getCredentialById).not.toHaveBeenCalledWith(1, 'prometheus'); // never the kind fallback
  });

  it('takes auth material from the SM credential but keeps the ROW authoritative for endpoint+authType', async () => {
    // cred carries a DIFFERENT (stale) endpoint + authType — the row must win so a stale secret can't
    // redirect the query; only the auth material (username/password) is taken from the cred.
    getCredentialById.mockResolvedValueOnce({ endpoint: 'http://STALE:9090', authType: 'bearer', username: 'u', password: 'pw' });
    const cc = await resolveConnConfig({ ...row, endpoint: 'http://p:9090', authType: 'basic' as const });
    expect(cc).toMatchObject({ endpoint: 'http://p:9090', authType: 'basic', username: 'u', password: 'pw' });
    expect(cc.endpoint).not.toBe('http://STALE:9090'); // row endpoint wins over the stale secret
  });
});
