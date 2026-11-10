import { describe, expect, it, vi } from 'vitest';
import { inventoryRetryDelayMs, needsInventoryRetry, withInventoryRetry } from './graph-rebuild-retry';

describe('inventory-running retry', () => {
  it('waits long enough for an inventory run but never more than half the interval', () => {
    expect(inventoryRetryDelayMs(15)).toBe(180_000);
    expect(inventoryRetryDelayMs(4)).toBe(120_000);
    expect(inventoryRetryDelayMs(1)).toBe(60_000);
  });

  it('detects the reason on any layer result and ignores failed layers without totals', () => {
    expect(needsInventoryRetry([{ totals: { reasons: [] } }, { totals: { reasons: ['inventory_running'] } }])).toBe(true);
    expect(needsInventoryRetry([{ totals: { reasons: ['rebuild_busy'] } }, {}, undefined])).toBe(false);
  });

  it('schedules exactly one retry per regular tick, and a retry never schedules another', async () => {
    const schedule = vi.fn();
    const cycle = vi.fn(async () => true);
    const run = withInventoryRetry(cycle, 180_000, schedule);
    await run();
    await run(); // another tick while the first retry is still pending
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(schedule.mock.calls[0][1]).toBe(180_000);
    await schedule.mock.calls[0][0]();
    await vi.waitFor(() => expect(cycle).toHaveBeenCalledTimes(3));
    expect(schedule).toHaveBeenCalledTimes(1); // the retry itself still wanted a retry: none scheduled
    await run(); // after the retry ran, a new tick may request one again
    expect(schedule).toHaveBeenCalledTimes(2);
  });

  it('does not retry a cycle that published or failed for other reasons', async () => {
    const schedule = vi.fn();
    await withInventoryRetry(async () => false, 180_000, schedule)();
    expect(schedule).not.toHaveBeenCalled();
  });
});
