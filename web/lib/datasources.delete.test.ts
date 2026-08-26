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

import { deleteDatasource } from './datasources';

const row = (over: Record<string, unknown>) => ({
  id: 1, name: 'a', kind: 'prometheus', endpoint: 'http://p', ds_auth_type: 'none', is_default: false, enabled: true, ...over,
});

beforeEach(() => {
  query.mockReset().mockResolvedValue({ rows: [] });
  getCredentialById.mockReset();
  mirrorDefaultCredential.mockReset();
  deleteCredentialKeys.mockReset().mockResolvedValue(undefined);
});

describe('deleteDatasource', () => {
  it('is a no-op when the id does not exist', async () => {
    query.mockResolvedValueOnce({ rows: [] }); // getDatasource → none
    await deleteDatasource(404);
    expect(query.mock.calls.some((c) => /DELETE FROM integrations/i.test(String(c[0])))).toBe(false);
    expect(deleteCredentialKeys).not.toHaveBeenCalled();
  });

  it('cascades: schema cache → graph queries → credential id key → integrations row (non-default)', async () => {
    query.mockResolvedValueOnce({ rows: [row({ id: 5, is_default: false })] }); // getDatasource
    await deleteDatasource(5);
    const stmts = query.mock.calls.map((c) => String(c[0]));
    const iCache = stmts.findIndex((s) => /DELETE FROM datasource_schemas/i.test(s));
    const iGraph = stmts.findIndex((s) => /DELETE FROM datasource_graph_queries/i.test(s));
    const iRow = stmts.findIndex((s) => /DELETE FROM integrations/i.test(s));
    expect(iCache).toBeGreaterThanOrEqual(0);
    expect(iGraph).toBeGreaterThanOrEqual(0); // M3: pre-built graph-query rows swept too
    expect(iRow).toBeGreaterThan(iCache); // cache deleted before the row
    expect(iRow).toBeGreaterThan(iGraph); // graph queries deleted before the row
    expect(deleteCredentialKeys).toHaveBeenCalledWith(['5']); // id key only (not default)
  });

  it('re-picks a new default of the kind and re-mirrors when deleting the default', async () => {
    query
      .mockResolvedValueOnce({ rows: [row({ id: 5, is_default: true })] }) // getDatasource
      .mockResolvedValueOnce({ rows: [] })   // DELETE datasource_schemas
      .mockResolvedValueOnce({ rows: [] })   // DELETE datasource_diag_signals
      .mockResolvedValueOnce({ rows: [] })   // DELETE datasource_graph_queries
      .mockResolvedValueOnce({ rows: [] })   // DELETE integrations
      .mockResolvedValueOnce({ rows: [{ id: 8 }] }) // SELECT next default candidate
      .mockResolvedValueOnce({ rows: [] });  // UPDATE set new default
    getCredentialById.mockResolvedValueOnce({ endpoint: 'http://p8', authType: 'none' });
    await deleteDatasource(5);
    expect(mirrorDefaultCredential).toHaveBeenCalledWith('prometheus', { endpoint: 'http://p8', authType: 'none' });
  });

  it('clears the kind mirror when no instances of the kind remain', async () => {
    query
      .mockResolvedValueOnce({ rows: [row({ id: 5, is_default: true })] }) // getDatasource
      .mockResolvedValueOnce({ rows: [] })   // DELETE cache
      .mockResolvedValueOnce({ rows: [] })   // DELETE datasource_diag_signals
      .mockResolvedValueOnce({ rows: [] })   // DELETE datasource_graph_queries
      .mockResolvedValueOnce({ rows: [] })   // DELETE row
      .mockResolvedValueOnce({ rows: [] });  // SELECT next → none
    await deleteDatasource(5);
    expect(deleteCredentialKeys).toHaveBeenCalledWith(['5']);       // id key
    expect(deleteCredentialKeys).toHaveBeenCalledWith(['prometheus']); // kind mirror cleared
    expect(mirrorDefaultCredential).not.toHaveBeenCalled();
  });

  it('does not block row deletion when the Secrets Manager delete fails', async () => {
    query.mockResolvedValueOnce({ rows: [row({ id: 5, is_default: false })] }); // getDatasource
    deleteCredentialKeys.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await deleteDatasource(5); // must not throw
    expect(query.mock.calls.some((c) => /DELETE FROM integrations/i.test(String(c[0])))).toBe(true);
    warn.mockRestore();
  });
});
