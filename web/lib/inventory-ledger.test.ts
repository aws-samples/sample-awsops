import { describe, expect, it } from 'vitest';
import type { InventoryPage } from './inventory';
import { ledgerVersion } from './inventory-ledger';

const RUN = { status: 'succeeded', finished_at: '2026-11-18T00:00:00.000Z', last_success_at: '2026-11-18T00:00:00.000Z', row_count: 3 };
const page = (run: unknown, consistency: unknown = 'statement-snapshot') =>
  ({ rows: [], run, consistency }) as unknown as InventoryPage;

describe('ledgerVersion', () => {
  it('returns the version tuple of a succeeded statement-snapshot ledger', () => {
    expect(ledgerVersion(page(RUN))).toBe(JSON.stringify(['succeeded', RUN.finished_at, RUN.last_success_at, 3]));
    expect(ledgerVersion(page({ ...RUN, row_count: 0 }))).not.toBeNull();
  });

  it('gives the same version for the same ledger and a different one when the ledger moves', () => {
    expect(ledgerVersion(page({ ...RUN }))).toBe(ledgerVersion(page(RUN)));
    expect(ledgerVersion(page({ ...RUN, finished_at: '2026-11-18T00:05:00.000Z' }))).not.toBe(ledgerVersion(page(RUN)));
    expect(ledgerVersion(page({ ...RUN, row_count: 4 }))).not.toBe(ledgerVersion(page(RUN)));
  });

  it.each([
    ['a missing marker', ({ rows: [], run: RUN }) as unknown as InventoryPage],
    ['another marker', page(RUN, 'unknown')],
    ['no ledger', page(null)],
    ['a running sweep', page({ ...RUN, status: 'running', finished_at: null })],
    ['a partial sweep', page({ ...RUN, status: 'partial' })],
    ['a failed sweep', page({ ...RUN, status: 'failed' })],
    ['no finish time', page({ ...RUN, finished_at: null })],
    ['a blank finish time', page({ ...RUN, finished_at: '  ' })],
    ['an unparsable finish time', page({ ...RUN, finished_at: 'nope' })],
    ['no last success', page({ ...RUN, last_success_at: undefined })],
    ['an unparsable last success', page({ ...RUN, last_success_at: 'nope' })],
    ['a missing row count', page({ ...RUN, row_count: null })],
    ['a negative row count', page({ ...RUN, row_count: -1 })],
    ['a fractional row count', page({ ...RUN, row_count: 1.5 })],
    ['a string row count', page({ ...RUN, row_count: '3' })],
  ])('returns null for %s', (_label, p) => {
    expect(ledgerVersion(p)).toBeNull();
  });
});
