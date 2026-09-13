/** Account-wide collection ledger, independent of the dashboard's region-filtered counts. */
interface LedgerReader {
  query(sql: string, values: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
const integer = (v: unknown): number | null => Number.isSafeInteger(v) && Number(v) >= 0 ? Number(v) : null;
const timestamp = (v: unknown): string | null => {
  if (!(v instanceof Date) && typeof v !== 'string') return null;
  const date = new Date(v);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};
export async function readCollectionStatus(pool: LedgerReader, accounts: '__all__' | string[]) {
  const configured = Boolean(process.env.INV_SYNC_FUNCTION?.trim());
  try {
    const scoped = accounts === '__all__' ? null : accounts.filter(a => a === 'self' || /^[0-9]{12}$/.test(a));
    const { rows } = await pool.query(
      `SELECT resource_type, account_id, status, started_at, finished_at, last_success_at,
              row_count, unknown_attribute_count FROM inventory_sync_runs
       WHERE ($1::text[] IS NULL OR account_id = ANY($1::text[])) ORDER BY account_id, resource_type`,
      [scoped],
    );
    const runs = rows.filter(row => typeof row.resource_type === 'string'
      && /^[a-z][a-z0-9_]{0,63}$/.test(row.resource_type)
      && typeof row.account_id === 'string' && /^(self|[0-9]{12})$/.test(row.account_id))
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
    return { configured, readOk: true, runs };
  } catch {
    return { configured, readOk: false, runs: [] };
  }
}
