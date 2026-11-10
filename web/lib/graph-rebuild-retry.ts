// One-shot follow-up for the in-process graph timer. The rebuild interval and the inventory sync
// share a cadence, so a restart can phase-lock rebuilds onto a running inventory producer: every
// tick then sees `running` and retains the previous graph. A cycle that reports `inventory_running`
// schedules a single retry after the producer normally finishes; a retry never schedules another,
// so the next regular tick remains the only follow-up.

export const INVENTORY_RETRY_REASON = 'inventory_running';

/** Retry delay: long enough for an inventory run to finalize, never more than half the interval. */
export function inventoryRetryDelayMs(intervalMins: number): number {
  return Math.max(60_000, Math.min(3 * 60_000, Math.floor((intervalMins * 60_000) / 2)));
}

/** True when any layer result says publication waited on a running inventory producer. */
export function needsInventoryRetry(results: ({ totals?: { reasons: string[] } } | undefined)[]): boolean {
  return results.some(result => result?.totals?.reasons.includes(INVENTORY_RETRY_REASON) === true);
}

/** Wraps a rebuild cycle so a regular tick can request at most one pending retry. */
export function withInventoryRetry(
  cycle: () => Promise<boolean>, delayMs: number,
  schedule: (callback: () => void, ms: number) => unknown = (callback, ms) => setTimeout(callback, ms),
): (retry?: boolean) => Promise<void> {
  let pending = false;
  const run = async (retry = false): Promise<void> => {
    if (retry) pending = false;
    const wantsRetry = await cycle();
    if (wantsRetry && !retry && !pending) {
      pending = true;
      schedule(() => { void run(true); }, delayMs);
    }
  };
  return run;
}
