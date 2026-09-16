// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
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

it.each([
  [403, 'denied', 'Node ENI details are unavailable. Access denied; check read permissions.'],
  [504, 'timeout', 'Node ENI details are unavailable. Request timed out; check connectivity and retry.'],
  [500, 'unreachable', 'Node ENI details are unavailable. Endpoint unreachable; check network connectivity and DNS.'],
])('renders the safe %s/%s API explanation without claiming the instance was not found', async (status, reason, message) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: false, status, json: async () => ({ status: 'error', reason, message }),
  }));
  render(<NodeEniSection nodeName="same.internal" cluster={ARN} />);
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain(message);
  expect(screen.queryByText('인벤토리에서 노드 인스턴스를 찾지 못했습니다')).toBeNull();
  expect(screen.queryByText('조회 중…')).toBeNull();
});

it('reserves the not-found explanation for a successful found:false response', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ found: false }) }));
  render(<NodeEniSection nodeName="missing.internal" cluster={ARN} />);
  await screen.findByText('인벤토리에서 노드 인스턴스를 찾지 못했습니다');
  expect(screen.queryByRole('alert')).toBeNull();
});

it.each(['transport', 'json', 'missing-message'])('uses a fixed request-failure explanation for %s failures', async failure => {
  const privateDetail = 'credential=private-value; endpoint=private.internal';
  const fetcher = vi.fn();
  if (failure === 'transport') fetcher.mockRejectedValue(new Error(privateDetail));
  else fetcher.mockResolvedValue({
    ok: false, status: 500,
    json: failure === 'json'
      ? async () => { throw new SyntaxError(privateDetail); }
      : async () => ({ reason: 'upstream-error' }),
  });
  vi.stubGlobal('fetch', fetcher);
  render(<NodeEniSection nodeName="same.internal" cluster={ARN} />);
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('조회 실패');
  expect(alert.textContent).not.toContain(privateDetail);
  expect(screen.queryByText('인벤토리에서 노드 인스턴스를 찾지 못했습니다')).toBeNull();
});

it('renders the trusted API message as literal text, never HTML', async () => {
  const message = 'Access denied: <img src=x onerror="unexpected()">.';
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({ reason: 'denied', message }) }));
  const { container } = render(<NodeEniSection nodeName="same.internal" cluster={ARN} />);
  expect((await screen.findByRole('alert')).textContent).toContain(message);
  expect(container.querySelector('img')).toBeNull();
});

it('ignores a late error body from the previous cluster after the member data arrives', async () => {
  let finishBody!: (body: unknown) => void;
  const body = new Promise(resolve => { finishBody = resolve; });
  const readErrorBody = vi.fn(() => body);
  const fetcher = vi.fn()
    .mockResolvedValueOnce({ ok: false, status: 403, json: readErrorBody })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ found: true, instanceId: 'i-member', enis: [] }) });
  vi.stubGlobal('fetch', fetcher);
  const { rerender } = render(<NodeEniSection nodeName="same.internal" cluster="shared" />);
  await waitFor(() => expect(readErrorBody).toHaveBeenCalled());
  rerender(<NodeEniSection nodeName="same.internal" cluster={ARN} />);
  await screen.findByText('i-member');
  await act(async () => { finishBody({ message: 'Old host access denied.', reason: 'denied' }); });
  expect(screen.getByText('i-member')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByText(/Old host access denied/)).toBeNull();
});

it.each([
  ['denied', 'Node traffic metrics are unavailable. Access denied; check read permissions.'],
  ['timeout', 'Node traffic metrics are unavailable. Request timed out; check connectivity and retry.'],
])('retains found ENIs and discloses partial traffic %s without healthy zero-valued tiles', async (trafficReason, trafficMessage) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({
    found: true, instanceId: 'i-member', eniCount: 1, totalIps: 1,
    enis: [{ id: 'eni-member', privateIp: '10.0.0.7', publicIp: null, subnet: null, ips: 1 }],
    traffic: { netIn: 0, netOut: 0, pktIn: 0, pktOut: 0 },
    trafficReason, trafficMessage,
  }) }));
  render(<NodeEniSection nodeName="same.internal" cluster={ARN} />);
  await screen.findByText('i-member');
  expect(screen.getByText('eni-member')).toBeTruthy();
  expect((await screen.findByRole('alert')).textContent).toContain(trafficMessage);
  expect(screen.queryByText('인벤토리에서 노드 인스턴스를 찾지 못했습니다')).toBeNull();
  expect(screen.queryByText('0.0 MB')).toBeNull();
  expect(screen.queryByText('Pkts In')).toBeNull();
});
