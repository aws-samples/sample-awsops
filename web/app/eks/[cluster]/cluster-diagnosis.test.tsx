// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import EksClusterPage from './page';

const ID = 'arn:aws:eks:ap-northeast-2:222222222222:cluster/shared';
vi.mock('next/navigation', () => ({
  useParams: () => ({ cluster: 'arn%3Aaws%3Aeks%3Aap-northeast-2%3A222222222222%3Acluster%2Fshared' }),
}));
const response = (body: unknown, status = 200) => Response.json(body, { status });
function serve(diagnosis: Response | (() => Response | Promise<Response>)) {
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    if (input.endsWith('/k8sgpt')) return typeof diagnosis === 'function' ? diagnosis() : diagnosis;
    if (input === '/api/me') return response({ isAdmin: false });
    if (input.endsWith('/status')) return response({ installed: true, ready: true });
    return response({ rows: [], available: false });
  }));
}
beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function openDiagnosis() {
  render(<EksClusterPage />);
  fireEvent.click(screen.getByRole('tab', { name: 'Diagnosis' }));
}
function expectNotAbsentOrDisabled() {
  expect(screen.queryByText(/진단 비활성|operator 미감지|진단 결과 없음/)).toBeNull();
}
const failures = [
  { reason: 'denied', message: 'K8sGPT diagnosis is unavailable. Access denied; check read permissions.' },
  { reason: 'unreachable', message: 'K8sGPT diagnosis is unavailable. Endpoint unreachable; check network connectivity and DNS.' },
  { reason: 'upstream-error', message: 'K8sGPT diagnosis is unavailable.' },
  { reason: 'timeout', message: 'K8sGPT diagnosis is unavailable. Request timed out; check connectivity and retry.' },
];

it.each(failures)('shows the full safe $reason failure from a degraded HTTP 200 CRD result', async ({ reason, message }) => {
  serve(response({ enabled: true, operator_detected: false, operator_missing: false, stale: true, findings: [], errorReason: reason, message }));
  openDiagnosis();
  await waitFor(() => expect(screen.getByText(message, { exact: false })).toBeTruthy());
  expectNotAbsentOrDisabled();
  expect(vi.mocked(fetch).mock.calls.some(([url]) => url === `/api/eks/${encodeURIComponent(ID)}/k8sgpt`)).toBe(true);
});

it.each([
  { status: 503, body: { status: 'error', reason: 'denied', message: 'K8sGPT scope is unavailable.' } },
  { status: 503, body: { status: 'error', reason: 'upstream-error', message: 'K8sGPT diagnosis is unavailable.' } },
  { status: 503, body: { enabled: false, message: 'Backend temporarily unavailable.' } },
  { status: 503, body: { enabled: false } },
  { status: 403, body: { status: 'error', message: 'admin required' } },
])('keeps HTTP $status backend/auth failure distinct from the disabled flag: $body', async ({ status, body }) => {
  serve(response(body, status));
  openDiagnosis();
  await waitFor(() => expect(screen.getByText(/로드 실패:/)).toBeTruthy());
  if ('message' in body) expect(screen.getByText(body.message!, { exact: false })).toBeTruthy();
  expectNotAbsentOrDisabled();
});

it('only treats the exact disabled-flag 503 response as disabled', async () => {
  serve(response({ enabled: false, message: 'k8sgpt diagnosis disabled' }, 503));
  openDiagnosis();
  await waitFor(() => expect(screen.getByText(/진단 비활성/)).toBeTruthy());
  expect(screen.queryByText(/로드 실패:/)).toBeNull();
});

it('keeps a confirmed absent operator distinct from a read failure', async () => {
  serve(response({ enabled: true, operator_detected: false, operator_missing: true, stale: true, findings: [] }));
  openDiagnosis();
  await waitFor(() => expect(screen.getByText(/operator 미감지/)).toBeTruthy());
  expect(screen.queryByText(/로드 실패:/)).toBeNull();
});

it('does not infer an absent operator from an unclassified failed detection', async () => {
  serve(response({ enabled: true, operator_detected: false, operator_missing: false, stale: true, findings: [] }));
  openDiagnosis();
  await waitFor(() => expect(screen.getByText(/operator 상태를 확인할 수 없습니다/)).toBeTruthy());
  expectNotAbsentOrDisabled();
});

it('does not label a successful empty scan with a detected operator as disabled or absent', async () => {
  serve(response({ enabled: true, operator_detected: true, stale: false, findings: [] }));
  openDiagnosis();
  await waitFor(() => expect(screen.getByText(/진단 결과 없음/)).toBeTruthy());
  expect(screen.queryByText(/진단 비활성|operator 미감지|로드 실패:/)).toBeNull();
});

it('ignores failure classification whose JSON resolves after switching tabs', async () => {
  let resolve!: (body: unknown) => void;
  const json = vi.fn(() => new Promise((done) => { resolve = done; }));
  serve({ ok: false, status: 503, json } as unknown as Response);
  openDiagnosis();
  await waitFor(() => expect(json).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('tab', { name: 'Pods' }));
  await act(async () => resolve({ status: 'error', reason: 'denied', message: 'OLD_DIAGNOSIS_FAILURE' }));
  expect(screen.queryByText(/OLD_DIAGNOSIS_FAILURE|로드 실패:|진단 비활성/)).toBeNull();
});
