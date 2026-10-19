import { describe, it, expect, vi, beforeEach } from 'vitest';

const clientQuery = vi.fn();
const clientRelease = vi.fn();
const poolConnect = vi.fn();
vi.mock('@/lib/db', () => ({ getPool: () => ({ connect: poolConnect, query: clientQuery }) }));
const getCredentialById = vi.fn();
const mirrorDefaultCredential = vi.fn();
vi.mock('@/lib/integration-credentials', () => ({
  getCredentialById: (...a: unknown[]) => getCredentialById(...a),
  mirrorDefaultCredential: (...a: unknown[]) => mirrorDefaultCredential(...a),
}));

import { setDefaultDatasource } from './datasources';

beforeEach(() => {
  clientQuery.mockReset().mockResolvedValue({ rows: [] });
  clientRelease.mockReset();
  poolConnect.mockReset().mockResolvedValue({ query: clientQuery, release: clientRelease });
  getCredentialById.mockReset();
  mirrorDefaultCredential.mockReset();
});

describe('setDefaultDatasource', () => {
  it('unsets other defaults of the kind then sets this one, in a transaction, and re-mirrors', async () => {
    // BEGIN, SELECT kind, UPDATE others false, UPDATE this true, COMMIT
    clientQuery
      .mockResolvedValueOnce({ rows: [] })                         // BEGIN
      .mockResolvedValueOnce({ rows: [{ kind: 'prometheus' }] })   // SELECT kind
      .mockResolvedValueOnce({ rows: [] })                         // UPDATE others=false
      .mockResolvedValueOnce({ rows: [] })                         // UPDATE this=true
      .mockResolvedValueOnce({ rows: [] });                        // COMMIT
    getCredentialById.mockResolvedValueOnce({ endpoint: 'http://p', authType: 'none' });

    await setDefaultDatasource(12);

    const stmts = clientQuery.mock.calls.map((c) => String(c[0]));
    expect(stmts[0]).toMatch(/BEGIN/i);
    expect(stmts.some((s) => /is_default\s*=\s*false/i.test(s) && /kind/.test(s))).toBe(true);
    expect(stmts.some((s) => /is_default\s*=\s*true/i.test(s) && /id\s*=\s*\$1/.test(s))).toBe(true);
    expect(stmts.some((s) => /COMMIT/i.test(s))).toBe(true);
    expect(clientRelease).toHaveBeenCalled();
    expect(mirrorDefaultCredential).toHaveBeenCalledWith('prometheus', { endpoint: 'http://p', authType: 'none' });
  });

  it('rolls back and throws when the datasource does not exist', async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [] })   // BEGIN
      .mockResolvedValueOnce({ rows: [] });  // SELECT kind → none
    await expect(setDefaultDatasource(404)).rejects.toThrow(/not found/i);
    expect(clientQuery.mock.calls.some((c) => /ROLLBACK/i.test(String(c[0])))).toBe(true);
    expect(mirrorDefaultCredential).not.toHaveBeenCalled();
  });
});
