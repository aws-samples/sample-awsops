// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
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
  expect(screen.queryByRole('alert')).toBeNull();
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

it.each([
  [403, 'denied', 'Pod transfer metrics are unavailable. Access denied; check read permissions.'],
  [504, 'timeout', 'Pod transfer metrics are unavailable. Request timed out; check connectivity and retry.'],
  [502, 'unreachable', 'Pod transfer metrics are unavailable. Endpoint unreachable; check network connectivity and DNS.'],
])('preserves the safe %s/%s API explanation without showing unsupported or absent-monitor guidance', async (status, reason, message) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: false, status, json: async () => ({ status: 'error', reason, message }),
  }));
  render(<PodTransferSection clusters={[ARN]} />);
  expect((await screen.findByRole('alert')).textContent).toContain(message);
  expect(screen.queryByText(MESSAGE)).toBeNull();
  expect(screen.queryByText(/해당 클러스터에 NFM 모니터가 온보딩되지 않았습니다/)).toBeNull();
  expect(screen.queryByText('데이터 없음')).toBeNull();
  expect(screen.queryByText(/NFM 쿼리 실행 중/)).toBeNull();
});

it('keeps valid available:false without a custom message as absent-monitor guidance', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ available: false }) }));
  render(<PodTransferSection clusters={['shared']} />);
  await screen.findByText(/해당 클러스터에 NFM 모니터가 온보딩되지 않았습니다/);
  expect(screen.queryByRole('alert')).toBeNull();
});

it.each(['transport', 'json', 'missing-message'])('suppresses raw %s exception details and renders a fixed request failure', async failure => {
  const privateDetail = 'credential=private-value; endpoint=private.internal';
  const fetcher = vi.fn();
  if (failure === 'transport') fetcher.mockRejectedValue(new Error(privateDetail));
  else fetcher.mockResolvedValue({
    ok: false, status: 502,
    json: failure === 'json'
      ? async () => { throw new SyntaxError(privateDetail); }
      : async () => ({ reason: 'upstream-error' }),
  });
  vi.stubGlobal('fetch', fetcher);
  render(<PodTransferSection clusters={[ARN]} />);
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('조회 실패');
  expect(alert.textContent).not.toContain(privateDetail);
  expect(screen.queryByText(/해당 클러스터에 NFM 모니터가 온보딩되지 않았습니다/)).toBeNull();
});

it('renders an API error containing markup as plain text', async () => {
  const message = 'Access denied: <img src=x onerror="unexpected()">.';
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({ reason: 'denied', message }) }));
  const { container } = render(<PodTransferSection clusters={[ARN]} />);
  expect((await screen.findByRole('alert')).textContent).toContain(message);
  expect(container.querySelector('img')).toBeNull();
});

it('keeps the new unsupported-scope result when the previous cluster error body finishes late', async () => {
  let finishBody!: (body: unknown) => void;
  const body = new Promise(resolve => { finishBody = resolve; });
  const readErrorBody = vi.fn(() => body);
  const fetcher = vi.fn()
    .mockResolvedValueOnce({ ok: false, status: 504, json: readErrorBody })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ available: false, message: MESSAGE }) });
  vi.stubGlobal('fetch', fetcher);
  const { rerender } = render(<PodTransferSection clusters={['shared']} />);
  await waitFor(() => expect(readErrorBody).toHaveBeenCalled());
  rerender(<PodTransferSection clusters={[ARN]} />);
  await screen.findByText(MESSAGE);
  await act(async () => { finishBody({ message: 'Old host request timed out.', reason: 'timeout' }); });
  expect(screen.getByText(MESSAGE)).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByText(/Old host request timed out/)).toBeNull();
});
