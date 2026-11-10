// Bounded follow-up for the in-process graph timer. The rebuild interval and the inventory sync
// share a cadence, so a restart can phase-lock rebuilds onto a running inventory producer: every
// tick then sees `running` and retains the previous graph. A regular tick that reports
// `inventory_running` starts a short retry chain that covers the producer's runtime budget; the
// chain stops at the first cycle that no longer waits, and never runs into the next regular tick.

export const INVENTORY_RETRY_REASON = 'inventory_running';

// steampipe.tf caps the inventory sync Lambda at 420 s, so a ledger row stays `running` for at most
// that long; the chain reaches one step past it.
const PRODUCER_BUDGET_MS = 420_000;
const RETRY_STEP_MS = 120_000;

export interface InventoryRetryPlan { delayMs: number; maxRetries: number }

/** Retry steps for an interval. Intervals under 5 minutes need none: regular ticks already land
 *  outside a producer pass within a few minutes. Otherwise 2-minute steps cover the producer budget
 *  plus one step, and the last retry still runs at least one step before the next regular tick. */
export function inventoryRetryPlan(intervalMins: number): InventoryRetryPlan {
  const intervalMs = intervalMins * 60_000;
  if (!Number.isFinite(intervalMs) || intervalMs < 5 * 60_000) return { delayMs: RETRY_STEP_MS, maxRetries: 0 };
  const window = Math.min(PRODUCER_BUDGET_MS + RETRY_STEP_MS, intervalMs - RETRY_STEP_MS);
  return { delayMs: RETRY_STEP_MS, maxRetries: Math.floor(window / RETRY_STEP_MS) };
}

/** True when any layer result says publication waited on a running inventory producer. */
export function needsInventoryRetry(results: ({ totals?: { reasons: string[] } } | undefined)[]): boolean {
  return results.some(result => result?.totals?.reasons.includes(INVENTORY_RETRY_REASON) === true);
}

/** Wraps a rebuild cycle: a waiting regular tick starts one retry chain of at most `maxRetries`
 *  steps, a waiting retry continues it, and nothing starts a second chain while one is pending. */
export function withInventoryRetry(
  cycle: () => Promise<boolean>, plan: InventoryRetryPlan,
  schedule: (callback: () => void, ms: number) => unknown = (callback, ms) => setTimeout(callback, ms),
): (retry?: number) => Promise<void> {
  let pending = false;
  const run = async (retry = 0): Promise<void> => {
    if (retry) pending = false;
    const waited = await cycle();
    if (!waited || pending || retry >= plan.maxRetries) return;
    pending = true;
    schedule(() => { void run(retry + 1); }, plan.delayMs);
  };
  return run;
}
