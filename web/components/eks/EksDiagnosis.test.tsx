// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import EksDiagnosis from './EksDiagnosis';

vi.mock('@/components/inventory/metrics/DiagnosisGuide', () => ({ default: () => null }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('clears host metrics and Kubernetes rows when changing to a namesake member', async () => {
  const ARN = 'arn:aws:eks:us-west-2:222222222222:cluster/shared';
  const fetcher = vi.fn(async (url: string) => {
    if (url.includes(encodeURIComponent(ARN))) return new Promise(() => {});
    return { ok: true, json: async () => url.includes('/metrics')
      ? { controlPlane: {}, cluster: {}, nodes: { 'host-metric-node': {} } }
      : { rows: url.includes('kind=nodes') ? [{ name: 'host-kube-node', status: 'Ready' }] : [] } };
  });
  vi.stubGlobal('fetch', fetcher);
  const { rerender } = render(<EksDiagnosis cluster="shared" />);
  await screen.findByText('host-metric-node');
  await screen.findByText('host-kube-node');
  rerender(<EksDiagnosis cluster={ARN} />);
  await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url.includes(encodeURIComponent(ARN)))).toHaveLength(4));
  expect(screen.queryByText('host-metric-node')).toBeNull();
  expect(screen.queryByText('host-kube-node')).toBeNull();
});
