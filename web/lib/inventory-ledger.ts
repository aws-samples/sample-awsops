// Inventory page evidence gate (pure, client-safe: type-only import, no server modules).
// Shared by db-ref-resolve.ts (server) and k8s-dns.ts (browser) so both consumers of
// InventoryPage apply the same checks as fetchType in app/topology/page.tsx.
import type { InventoryPage } from '@/lib/inventory';

const nonempty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const validTime = (v: unknown): boolean => nonempty(v) && Number.isFinite(Date.parse(v));

/**
 * Ledger version of a page that proves a completed success under one statement snapshot, else
 * null (marker missing, no ledger, running/partial/failed, or a malformed success). Same checks
 * and version tuple as fetchType in app/topology/page.tsx.
 */
export function ledgerVersion(page: InventoryPage): string | null {
  const run = page.run;
  if (page.consistency !== 'statement-snapshot' || !run || run.status !== 'succeeded'
    || !validTime(run.finished_at) || !validTime(run.last_success_at)
    || !Number.isSafeInteger(run.row_count) || (run.row_count as number) < 0) return null;
  return JSON.stringify([run.status, run.finished_at, run.last_success_at, run.row_count]);
}
