import { describe, it, expect, vi, beforeEach } from 'vitest';

// Delegates to eks-registry (env clusters + runtime registrations + Aurora auth) —
// the OpenCost gate must match what the fleet/allocation routes consider onboarded.
const isAllowed = vi.fn();
vi.mock('@/lib/eks-registry', () => ({ isAllowed: (...a: unknown[]) => isAllowed(...a) }));

import { isClusterOnboarded } from './opencost-allowlist';

beforeEach(() => { isAllowed.mockReset(); });

describe('isClusterOnboarded', () => {
  it('is true when the registry allows the cluster', async () => {
    isAllowed.mockResolvedValue(true);
    await expect(isClusterOnboarded('fsi-demo-cluster')).resolves.toBe(true);
    expect(isAllowed).toHaveBeenCalledWith('fsi-demo-cluster');
  });
  it('is false when the registry rejects the cluster', async () => {
    isAllowed.mockResolvedValue(false);
    await expect(isClusterOnboarded('nope')).resolves.toBe(false);
  });
});
