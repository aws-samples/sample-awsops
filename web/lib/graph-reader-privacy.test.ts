import { it, expect, vi } from 'vitest';
import { readGraphState } from './graph-state';

it('does not expose the internal scheduling clock or mutate stored details', async () => {
  const details = { sourceAttempted: false, lastSourceAttemptedAtMs: 1000, sources: [] };
  const query = vi.fn().mockResolvedValue({ rows: [{ status: 'unavailable', details }] });
  const state = await readGraphState({ query }, 'self', 'infra');
  expect(state).not.toHaveProperty('lastSourceAttemptedAtMs');
  expect(details.lastSourceAttemptedAtMs).toBe(1000);
});
