import { describe, expect, it, vi } from 'vitest';
import { inventoryRetryPlan, needsInventoryRetry, withInventoryRetry } from './graph-rebuild-retry';

describe('inventory-running retry', () => {
  it('covers the 420 s producer budget plus one step and stays clear of the next regular tick', () => {
    expect(inventoryRetryPlan(15)).toEqual({ delayMs: 120_000, maxRetries: 4 }); // 2..8 min, past 7 min
    expect(inventoryRetryPlan(60)).toEqual({ delayMs: 120_000, maxRetries: 4 });
    expect(inventoryRetryPlan(6)).toEqual({ delayMs: 120_000, maxRetries: 2 }); // last retry at 4 of 6 min
    for (const mins of [6, 15, 60]) {
      const plan = inventoryRetryPlan(mins);
      expect(plan.maxRetries * plan.delayMs).toBeLessThanOrEqual(mins * 60_000 - plan.delayMs);
    }
  });

  it('plans no retries for short or invalid intervals, whose regular ticks already recover', () => {
    for (const mins of [0.5, 1, 4, Number.NaN]) expect(inventoryRetryPlan(mins).maxRetries).toBe(0);
  });

  it('detects the reason on any layer result and ignores failed layers without totals', () => {
    expect(needsInventoryRetry([{ totals: { reasons: [] } }, { totals: { reasons: ['inventory_running'] } }])).toBe(true);
    expect(needsInventoryRetry([{ totals: { reasons: ['rebuild_busy'] } }, {}, undefined])).toBe(false);
  });

  it('runs one bounded chain while the producer keeps running and never a second concurrent chain', async () => {
    const callbacks: (() => void)[] = [];
    const schedule = vi.fn((callback: () => void, _ms: number) => { callbacks.push(callback); });
    const cycle = vi.fn(async () => true);
    const run = withInventoryRetry(cycle, { delayMs: 120_000, maxRetries: 3 }, schedule);
    await run();
    await run(); // a regular tick while the chain is pending does not start another chain
    expect(schedule).toHaveBeenCalledTimes(1);
    for (let step = 0; step < 3; step++) {
      callbacks[step]();
      await vi.waitFor(() => expect(cycle).toHaveBeenCalledTimes(3 + step));
    }
    // Three retries ran; the third was the last allowed step, so nothing more is scheduled.
    expect(schedule).toHaveBeenCalledTimes(3);
    expect(schedule.mock.calls.every(call => call[1] === 120_000)).toBe(true);
  });

  it('stops the chain at the first cycle that no longer waits', async () => {
    const callbacks: (() => void)[] = [];
    const schedule = vi.fn((callback: () => void) => { callbacks.push(callback); });
    const cycle = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    await withInventoryRetry(cycle, { delayMs: 120_000, maxRetries: 4 }, schedule)();
    callbacks[0]();
    await vi.waitFor(() => expect(cycle).toHaveBeenCalledTimes(2));
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it('schedules nothing when the cycle did not wait or the plan allows no retries', async () => {
    const schedule = vi.fn();
    await withInventoryRetry(async () => false, { delayMs: 120_000, maxRetries: 4 }, schedule)();
    await withInventoryRetry(async () => true, { delayMs: 120_000, maxRetries: 0 }, schedule)();
    expect(schedule).not.toHaveBeenCalled();
  });
});
