// Cost Explorer availability probe + last-good response snapshot (v1 parity).
// In-memory per task: the probe caches 1h; the snapshot survives CE outages until redeploy.
import { CostExplorerClient, GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer';

export type CeReason = 'ok' | 'access_denied' | 'not_enabled' | 'error';
export interface CeAvailability { available: boolean; reason: CeReason; message?: string; checkedAt: string }

let probe: { value: CeAvailability; at: number } | null = null;
const PROBE_TTL_MS = 60 * 60 * 1000;

export async function checkCostAvailability(force = false): Promise<CeAvailability> {
  if (!force && probe && Date.now() - probe.at < PROBE_TTL_MS) return probe.value;
  const now = new Date();
  const start = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
  const end = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10);
  let value: CeAvailability;
  try {
    const c = new CostExplorerClient({ region: 'us-east-1' });
    await c.send(new GetCostAndUsageCommand({
      TimePeriod: { Start: start, End: end }, Granularity: 'DAILY', Metrics: ['UnblendedCost'],
    }));
    value = { available: true, reason: 'ok', checkedAt: new Date().toISOString() };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const name = e instanceof Error ? e.name : '';
    const reason: CeReason =
      name === 'AccessDeniedException' || /not authorized|AccessDenied/i.test(msg) ? 'access_denied'
        : /not enabled|DataUnavailable|historical data/i.test(msg) ? 'not_enabled'
          : 'error';
    value = { available: false, reason, message: msg.slice(0, 200), checkedAt: new Date().toISOString() };
  }
  probe = { value, at: Date.now() };
  return value;
}

// Last-good /api/cost response per cache key (account+months) — served when CE fails.
const snapshots = new Map<string, { body: unknown; at: string }>();
export function saveCostSnapshot(key: string, body: unknown): void {
  snapshots.set(key, { body, at: new Date().toISOString() });
}
export function getCostSnapshot(key: string): { body: unknown; at: string } | null {
  return snapshots.get(key) ?? null;
}

export function _clearCostSnapshotsForTests(): void { snapshots.clear(); probe = null; }
