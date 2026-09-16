// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import NodeEniSection from './NodeEniSection';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const ARN = 'arn:aws:eks:us-west-2:222222222222:cluster/shared';

it('includes the cluster ID and re-fetches when only the account changes', async () => {
  const fetcher = vi.fn(async (_url: string) => ({ ok: true, json: async () => ({ found: false }) }));
  vi.stubGlobal('fetch', fetcher);
  const { rerender } = render(<NodeEniSection nodeName="same.internal" cluster="shared" />);
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  rerender(<NodeEniSection nodeName="same.internal" cluster={ARN} />);
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  const url = new URL(fetcher.mock.calls[1][0], 'http://local');
  expect(url.searchParams.get('cluster')).toBe(ARN);
  expect(url.searchParams.get('node')).toBe('same.internal');
});

it('clears previous host ENIs while waiting for same-DNS member data', async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ found: true, instanceId: 'i-host', enis: [] }) })
    .mockImplementation(() => new Promise(() => {}));
  vi.stubGlobal('fetch', fetcher);
  const { rerender } = render(<NodeEniSection nodeName="same.internal" cluster="shared" />);
  await screen.findByText('i-host');
  rerender(<NodeEniSection nodeName="same.internal" cluster={ARN} />);
  expect(screen.queryByText('i-host')).toBeNull();
});

it('keeps the node-only legacy request supported', async () => {
  const fetcher = vi.fn(async (_url: string) => ({ ok: true, json: async () => ({ found: false }) }));
  vi.stubGlobal('fetch', fetcher);
  render(<NodeEniSection nodeName="same.internal" />);
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  expect(new URL(fetcher.mock.calls[0][0], 'http://local').searchParams.has('cluster')).toBe(false);
});
