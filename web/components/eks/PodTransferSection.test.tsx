// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import PodTransferSection from './PodTransferSection';

vi.mock('@/components/charts/DonutBreakdown', () => ({ default: () => null }));
vi.mock('@/components/ui/DetailPanel', () => ({ default: () => null }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const ARN = 'arn:aws:eks:us-west-2:222222222222:cluster/shared';
const MESSAGE = 'Pod transfer metrics are available only for the host account in the default region.';

it('renders the unsupported-scope explanation and readable label for a qualified member', async () => {
  const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ available: false, message: MESSAGE }) }));
  vi.stubGlobal('fetch', fetcher);
  render(<PodTransferSection clusters={[ARN]} />);
  await screen.findByText(MESSAGE);
  expect(fetcher).toHaveBeenCalledWith(`/api/eks/${encodeURIComponent(ARN)}/pod-transfer?range=3600`);
  expect(screen.getByRole('option').textContent).toBe('shared (222222222222 / us-west-2)');
  expect(screen.queryByText(/nfm-eks-arn:/)).toBeNull();
});

it('clears host transfer results when the same-name member becomes selected', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({
    available: true, pods: [{
      key: 'host-pod', podName: 'host-pod', namespace: 'default', serviceName: null,
      bytes: 10, billableBytes: 0, estUsd: 0, byCategory: {},
    }],
    totals: { bytes: 10, billableBytes: 0, estUsd: 0, byCategory: {} }, failedCategories: [],
  }) }).mockImplementation(() => new Promise(() => {}));
  vi.stubGlobal('fetch', fetcher);
  const { rerender } = render(<PodTransferSection clusters={['shared']} />);
  await screen.findByText('default/host-pod');
  rerender(<PodTransferSection clusters={[ARN]} />);
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith(`/api/eks/${encodeURIComponent(ARN)}/pod-transfer?range=3600`));
  expect(screen.queryByText('default/host-pod')).toBeNull();
});
