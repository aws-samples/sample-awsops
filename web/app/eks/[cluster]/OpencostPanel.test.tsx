// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
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

  it('degraded (reason set): expanded and surfaces the reason', async () => {
    stubFetch({ status: jsonRes({ installed: false, ready: false, deployment: null, reason: 'AccessDenied 403' }) });
    render(<OpencostPanel cluster="c1" />);
    await waitFor(() => expect(screen.getByText(/AccessDenied 403/)).toBeTruthy());
    expect(screen.getByText('values.yaml')).toBeTruthy();
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
    await waitFor(() => expect(screen.getByText('OpenCost')).toBeTruthy());
    expect(screen.getByText(/미설치|실패/)).toBeTruthy();
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
