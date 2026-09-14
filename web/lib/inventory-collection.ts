/** The producer's self row describes an aggregate type sweep, not per-account health.
 * Dashboard account/region selections affect resource counts, never this job ledger. */
interface LedgerReader {
  query(sql: string, values: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
const integer = (v: unknown): number | null => Number.isSafeInteger(v) && Number(v) >= 0 ? Number(v) : null;
const timestamp = (v: unknown): string | null => {
  if (!(v instanceof Date) && typeof v !== 'string') return null;
  const date = new Date(v);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};
export async function readCollectionStatus(pool: LedgerReader) {
  const configured = Boolean(process.env.INV_SYNC_FUNCTION?.trim());
  const scope = 'aggregate' as const;
  try {
    const { rows } = await pool.query(
      `SELECT resource_type, account_id, status, started_at, finished_at, last_success_at,
              row_count, unknown_attribute_count FROM inventory_sync_runs
       WHERE account_id = $1 ORDER BY resource_type`,
      ['self'],
    );
    const runs = rows.filter(row => typeof row.resource_type === 'string'
      && /^[a-z][a-z0-9_]{0,63}$/.test(row.resource_type)
      && row.account_id === 'self')
      .map(row => {
        const unknown = integer(row.unknown_attribute_count);
        return {
          type: row.resource_type, accountId: row.account_id,
          status: ['running', 'succeeded', 'partial', 'failed'].includes(String(row.status)) ? row.status : 'unknown',
          started_at: timestamp(row.started_at), finished_at: timestamp(row.finished_at),
          last_success_at: timestamp(row.last_success_at), row_count: integer(row.row_count),
          unknown_attribute_count: unknown, unknown_attributes: unknown === null ? null : unknown > 0,
        };
      });
    return { scope, configured, readOk: true, runs };
  } catch {
    return { scope, configured, readOk: false, runs: [] };
  }
}
