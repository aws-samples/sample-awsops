// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import OpencostPanel from './OpencostPanel';

afterEach(cleanup);
beforeEach(() => {
  vi.unstubAllGlobals();
  // jsdom lacks these — the download path uses them.
  vi.stubGlobal('URL', Object.assign(globalThis.URL, {
    createObjectURL: vi.fn(() => 'blob:x'),
    revokeObjectURL: vi.fn(),
  }));
  // anchor.click() is a no-op in jsdom; stub to avoid navigation noise.
  HTMLAnchorElement.prototype.click = vi.fn();
});

function jsonRes(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

interface Routes {
  me?: Response;
  status?: Response;
  config?: Response;
  bundle?: Response;
  put?: Response;
}
function stubFetch(routes: Routes = {}) {
  const fn = vi.fn(async (url: string, opts?: { method?: string }) => {
    const u = String(url);
    const method = opts?.method ?? 'GET';
    if (u.endsWith('/api/me')) return routes.me ?? jsonRes({ sub: 'u', groups: [], isAdmin: false });
    if (u.includes('/status')) return routes.status ?? jsonRes({ installed: false, ready: false, deployment: null });
    if (u.includes('/bundle')) return routes.bundle ?? jsonRes({ valuesYaml: 'v', installSh: 's', chartVersion: '' });
    if (/\/api\/opencost\/[^/]+$/.test(u)) {
      if (method === 'PUT') return routes.put ?? jsonRes({ saved: true });
      return routes.config ?? jsonRes({ cluster: 'c1', config: null });
    }
    return jsonRes({}, 404);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('OpencostPanel', () => {
  it('ignores late host config after switching to the same-name member', async () => {
    const member = 'arn:aws:eks:us-west-2:222222222222:cluster/shared';
    let resolveHost!: (response: Response) => void;
    const hostConfig = new Promise<Response>(resolve => { resolveHost = resolve; });
    const fn = vi.fn(async (url: string) => {
      if (url === '/api/me') return jsonRes({ isAdmin: true });
      if (url.endsWith('/status')) return jsonRes({ installed: false, ready: false });
      if (url === '/api/opencost/shared') return hostConfig;
      return jsonRes({ config: { chartVersion: 'member-version', config: {} } });
    });
    vi.stubGlobal('fetch', fn);
    const { rerender } = render(<OpencostPanel cluster="shared" />);
    await waitFor(() => expect(fn).toHaveBeenCalledWith('/api/opencost/shared'));
    rerender(<OpencostPanel cluster={member} />);
    await screen.findByDisplayValue('member-version');
    await act(async () => { resolveHost(jsonRes({ config: { chartVersion: 'host-version', config: {} } })); });
    expect(screen.queryByDisplayValue('host-version')).toBeNull();
    expect(screen.getByDisplayValue('member-version')).toBeTruthy();
  });

  it('shows a loading line before status resolves', () => {
    // never-resolving status → stays loading
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    render(<OpencostPanel cluster="c1" />);
    expect(screen.getByText(/조회 중/)).toBeTruthy();
  });

  it('404 (not onboarded): shows the onboarding note, no download buttons', async () => {
    stubFetch({ status: jsonRes({ status: 'error', message: 'unknown cluster' }, 404) });
    render(<OpencostPanel cluster="c1" />);
    await waitFor(() => expect(screen.getByText(/Access Entry 또는 인증 등록 필요/)).toBeTruthy());
    expect(screen.queryByText('values.yaml')).toBeNull();
    expect(screen.queryByText('install.sh')).toBeNull();
  });

  it('not installed: auto-expands the guide with both download buttons', async () => {
    stubFetch({ status: jsonRes({ installed: false, ready: false, deployment: null }) });
    render(<OpencostPanel cluster="c1" />);
    await waitFor(() => expect(screen.getByText('values.yaml')).toBeTruthy());
    expect(screen.getByText('install.sh')).toBeTruthy();
    expect(screen.getByText(/미설치/)).toBeTruthy();
  });

  it.each([
    { reason: 'denied', message: 'OpenCost status is unavailable. Access denied; check read permissions.' },
    { reason: 'unreachable', message: 'OpenCost status is unavailable. Endpoint unreachable; check network connectivity and DNS.' },
    { reason: 'upstream-error', message: 'OpenCost status is unavailable.' },
    { reason: 'timeout', message: 'OpenCost status is unavailable. Request timed out; check connectivity and retry.' },
  ])('degraded $reason shows the full safe message without installation guidance', async ({ reason, message }) => {
    const fn = stubFetch({
      me: jsonRes({ isAdmin: true }),
      status: jsonRes({ installed: false, ready: false, deployment: null, failureReason: reason, reason: message }),
    });
    render(<OpencostPanel cluster="c1" />);
    await waitFor(() => expect(screen.getByText(message)).toBeTruthy());
    expect(screen.queryByText('미설치')).toBeNull();
    expect(screen.queryByText(/직접 설치|재설치\/업그레이드/)).toBeNull();
    expect(screen.queryByText('values.yaml')).toBeNull();
    expect(screen.queryByText('install.sh')).toBeNull();
    expect(screen.queryByText(/고급 설정/)).toBeNull();
    expect(fn.mock.calls.some(([url]) => url === '/api/opencost/c1')).toBe(false);
  });

  it.each([403, 404, 503])('HTTP %s read failure is not an absent installation or onboarding state', async (status) => {
    const message = 'OpenCost status is unavailable. Access denied; check read permissions.';
    stubFetch({ status: jsonRes({ status: 'error', message, reason: 'denied' }, status) });
    render(<OpencostPanel cluster="c1" />);
    await waitFor(() => expect(screen.getByText(message)).toBeTruthy());
    expect(screen.queryByText(/미설치|미온보딩|직접 설치/)).toBeNull();
    expect(screen.queryByText('install.sh')).toBeNull();
  });
  it('installed + ready: positive badge, collapsed (no download visible until expand)', async () => {
    stubFetch({ status: jsonRes({ installed: true, ready: true, deployment: { name: 'opencost', ready: '1/1', available: 1 } }) });
    render(<OpencostPanel cluster="c1" />);
    await waitFor(() => expect(screen.getByText(/Ready/)).toBeTruthy());
    expect(screen.queryByText('values.yaml')).toBeNull();
    // expanding reveals the re-download bundle
    fireEvent.click(screen.getByRole('button', { name: /OpenCost/i }));
    await waitFor(() => expect(screen.getByText('values.yaml')).toBeTruthy());
  });

  it('installed + not ready: brand "Not Ready" badge', async () => {
    stubFetch({ status: jsonRes({ installed: true, ready: false, deployment: { name: 'opencost', ready: '0/1', available: 0 } }) });
    render(<OpencostPanel cluster="c1" />);
    await waitFor(() => expect(screen.getByText(/Not Ready/)).toBeTruthy());
  });

  it('admin gate: advanced save shown to admins, hidden from non-admins', async () => {
    stubFetch({ me: jsonRes({ sub: 'u', groups: ['admins'], isAdmin: true }), status: jsonRes({ installed: false, ready: false, deployment: null }) });
    render(<OpencostPanel cluster="c1" />);
    await waitFor(() => expect(screen.getByText(/저장/)).toBeTruthy());
    cleanup();
    stubFetch({ me: jsonRes({ sub: 'u', groups: [], isAdmin: false }), status: jsonRes({ installed: false, ready: false, deployment: null }) });
    render(<OpencostPanel cluster="c1" />);
    await waitFor(() => expect(screen.getByText('values.yaml')).toBeTruthy());
    expect(screen.queryByText(/저장/)).toBeNull();
  });

  it('admin: lazy-loads config and PUT-saves; surfaces 403/503', async () => {
    const fn = stubFetch({
      me: jsonRes({ sub: 'u', groups: ['admins'], isAdmin: true }),
      status: jsonRes({ installed: false, ready: false, deployment: null }),
      put: jsonRes({ status: 'error', message: 'admin only' }, 403),
    });
    render(<OpencostPanel cluster="c1" />);
    await waitFor(() => expect(screen.getByText(/저장/)).toBeTruthy());
    // lazy config GET fired for the cluster
    expect(fn.mock.calls.some((c) => /\/api\/opencost\/c1$/.test(String(c[0])))).toBe(true);
    fireEvent.click(screen.getByText(/저장/));
    await waitFor(() => expect(screen.getByText(/관리자 전용/)).toBeTruthy());
  });

  it('download button triggers the bundle fetch', async () => {
    const fn = stubFetch({ status: jsonRes({ installed: false, ready: false, deployment: null }) });
    render(<OpencostPanel cluster="c1" />);
    await waitFor(() => expect(screen.getByText('values.yaml')).toBeTruthy());
    fireEvent.click(screen.getByText('values.yaml'));
    await waitFor(() => expect(fn.mock.calls.some((c) => String(c[0]).includes('/bundle'))).toBe(true));
  });

  it('status fetch rejection degrades without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).endsWith('/api/me')) return jsonRes({ sub: 'u', groups: [], isAdmin: false });
      throw new Error('network down');
    }));
    render(<OpencostPanel cluster="c1" />);
    await waitFor(() => expect(screen.getByText(/Endpoint unreachable; check network connectivity and DNS/)).toBeTruthy());
    expect(screen.queryByText(/미설치|직접 설치/)).toBeNull();
    expect(screen.queryByText('install.sh')).toBeNull();
  });

  it('ignores a late host read failure after a qualified member status succeeds', async () => {
    const member = 'arn:aws:eks:us-west-2:222222222222:cluster/shared';
    let resolveHost!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/me') return jsonRes({ isAdmin: false });
      if (url === '/api/opencost/shared/status') return new Promise<Response>(resolve => { resolveHost = resolve; });
      return jsonRes({ installed: true, ready: true });
    }));
    const { rerender } = render(<OpencostPanel cluster="shared" />);
    rerender(<OpencostPanel cluster={member} />);
    await screen.findByText('설치됨 · Ready');
    await act(async () => { resolveHost(jsonRes({ installed: false, ready: false, failureReason: 'denied', reason: 'OLD_HOST_FAILURE' })); });
    expect(screen.queryByText('OLD_HOST_FAILURE')).toBeNull();
    expect(screen.queryByText(/미설치|조회 실패/)).toBeNull();
    expect(vi.mocked(fetch).mock.calls.some(([url]) => url === `/api/opencost/${encodeURIComponent(member)}/status`)).toBe(true);
  });

  it('race: a late stale response does not overwrite the current cluster', async () => {
    let resolveC1: (r: Response) => void = () => {};
    const c1 = new Promise<Response>((r) => { resolveC1 = r; });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.endsWith('/api/me')) return jsonRes({ sub: 'u', groups: [], isAdmin: false });
      if (u.includes('/c1/') && u.includes('/status')) return c1; // pending
      if (u.includes('/c2/') && u.includes('/status')) return jsonRes({ installed: false, ready: false, deployment: null });
      return jsonRes({}, 404);
    }));
    const { rerender } = render(<OpencostPanel cluster="c1" />);
    rerender(<OpencostPanel cluster="c2" />);
    await waitFor(() => expect(screen.getByText(/미설치/)).toBeTruthy());
    // resolve the superseded c1 request as installed/ready — must be ignored
    resolveC1(jsonRes({ installed: true, ready: true, deployment: { name: 'opencost', ready: '1/1', available: 1 } }));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText(/· Ready/)).toBeNull();
  });
});
