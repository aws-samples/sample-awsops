import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/topology-config', async (orig) => ({
  ...(await orig<typeof import('@/lib/topology-config')>()),
  fetchEksIpMap: vi.fn(async () => ({ map: new Map(), blockedScopes: [], globalUnknown: false, coveredRegions: ['ap-northeast-2'], notConnected: 0 })),
}));
import { fetchEksIpMap } from '@/lib/topology-config';
import { CRITICAL_PAGES, ROW_CAP, fetchType, loadFlowInput, rowLimit } from '@/lib/flow-load';

const ACCOUNT = '123456789012';
const scope = new URLSearchParams({ accounts: ACCOUNT, regions: 'ap-northeast-2', includeGlobal: '1' }).toString();
const NOW = '2026-01-01T00:00:00.000Z';
const okRun = { status: 'succeeded', finished_at: NOW, last_success_at: NOW, row_count: 1 };
const row = (id: string, data: Record<string, unknown> = {}) => ({ account_id: ACCOUNT, region: 'ap-northeast-2',
  resource_id: id, captured_at: NOW, data: { host: `${id}.example.com`, ...data } });
const json = (body: unknown) => ({ ok: true, json: async () => body }) as Response;
const page = (rows: unknown[], over: Record<string, unknown> = {}) => json({ rows, run: okRun, consistency: 'statement-snapshot', ...over });

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('fetchType', () => {
  it('composes the scope query with limit/offset on the type URL', async () => {
    const f = vi.fn(async () => page([row('lb-1')]));
    vi.stubGlobal('fetch', f);
    const r = await fetchType('alb', scope, new AbortController().signal);
    const url = new URL(String((f.mock.calls[0] as unknown[])[0]), 'http://x');
    expect(url.pathname).toBe('/api/inventory/alb');
    expect(url.searchParams.get('accounts')).toBe(ACCOUNT);
    expect(url.searchParams.get('regions')).toBe('ap-northeast-2');
    expect(url.searchParams.get('includeGlobal')).toBe('1');
    expect(url.searchParams.get('limit')).toBe(String(ROW_CAP));
    expect(url.searchParams.get('offset')).toBe('0');
    expect(r.rows[0]).toMatchObject({ resource_id: 'lb-1', account_id: ACCOUNT, host: 'lb-1.example.com' });
    expect(r.capped).toBe(false);
  });

  it('pages critical types until a short page and does not page others', async () => {
    const full = Array.from({ length: ROW_CAP }, (_, i) => row(`s-${i}`));
    const f = vi.fn(async (u: string) => (new URL(u, 'http://x').searchParams.get('offset') === '0' ? page(full) : page([row('s-last')])));
    vi.stubGlobal('fetch', f);
    const r = await fetchType('subnet', scope, new AbortController().signal);
    expect(f).toHaveBeenCalledTimes(2);
    expect(r.rows).toHaveLength(ROW_CAP + 1);
    expect(r.capped).toBe(false);
    f.mockClear();
    f.mockImplementation(async () => page(full));
    const n = await fetchType('alb', scope, new AbortController().signal);
    expect(f).toHaveBeenCalledTimes(1);
    expect(n.capped).toBe(true); // non-critical: one full page is a cap, not end-of-data
    expect(rowLimit('subnet')).toBe(ROW_CAP * CRITICAL_PAGES);
    expect(rowLimit('alb')).toBe(ROW_CAP);
  });

  it('rejects a critical read that is not a statement snapshot', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => page([row('s-1')], { consistency: 'best-effort' })));
    await expect(fetchType('subnet', scope, new AbortController().signal)).rejects.toThrow('subnet: invalid inventory response');
  });

  it('rejects a critical read whose run did not succeed with proofs, but marks running/partial/failed incomplete', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => page([row('s-1')], { run: { ...okRun, last_success_at: null, status: 'succeeded' } })));
    await expect(fetchType('subnet', scope, new AbortController().signal)).rejects.toThrow();
    vi.stubGlobal('fetch', vi.fn(async () => page([row('s-1')], { run: { status: 'partial' } })));
    const r = await fetchType('subnet', scope, new AbortController().signal);
    expect(r.incomplete).toBe(true);
    expect(r.runSucceeded).toBe(false);
  });

  it('rejects a critical row outside the requested accounts and duplicates', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => page([{ ...row('s-1'), account_id: '210987654321' }])));
    await expect(fetchType('subnet', scope, new AbortController().signal)).rejects.toThrow();
    vi.stubGlobal('fetch', vi.fn(async () => page([row('s-1'), row('s-1')])));
    await expect(fetchType('subnet', scope, new AbortController().signal)).rejects.toThrow();
  });

  it('does not issue a request once aborted', async () => {
    const f = vi.fn(async () => page([]));
    vi.stubGlobal('fetch', f);
    const c = new AbortController(); c.abort();
    await expect(fetchType('alb', scope, c.signal)).rejects.toThrow('alb: invalid inventory response');
    expect(f).not.toHaveBeenCalled();
  });
});

describe('loadFlowInput', () => {
  it('aggregates every type and flags owner reads from a non-succeeded run', async () => {
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      const type = new URL(u, 'http://x').pathname.split('/').pop();
      if (type === 'eni') return page([], { run: { status: 'partial' } });
      return page([]);
    }));
    const r = await loadFlowInput(scope.replace(ACCOUNT, 'self'), new AbortController().signal);
    expect(r.results).toHaveLength(r.types.length);
    expect(r.types.slice(-2)).toEqual(['vpc', 'security_group']);
    expect(r.failed).toEqual([]);
    expect(r.incomplete).toBe(true);
    expect(r.input.ownershipRead?.ownerIncomplete).toEqual(expect.arrayContaining(['eni', 'rds', 'rds_cluster', 'rds_proxy']));
    expect(r.input.ownershipRead?.eksRegions).toEqual(['ap-northeast-2']);
    expect(fetchEksIpMap).toHaveBeenCalledTimes(1);
  });

  it('skips EKS resolution for non-self scopes and marks the read configuration-only', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => page([])));
    const r = await loadFlowInput(scope.replace(ACCOUNT, '__all__'), new AbortController().signal);
    expect(fetchEksIpMap).not.toHaveBeenCalled();
    expect(r.input.ownershipRead?.configurationOnly).toBe(true);
  });

  it('reports failed reads and allFailed when every type errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false }) as Response));
    const r = await loadFlowInput(scope, new AbortController().signal);
    expect(r.allFailed).toBe(true);
    expect(r.failed.length).toBe(r.types.length);
    expect(r.failed[0].error).toMatch(/invalid inventory response$/);
  });

  it('turns an aborted signal into failed reads without fetching', async () => {
    const f = vi.fn(async () => page([]));
    vi.stubGlobal('fetch', f);
    const c = new AbortController(); c.abort();
    const r = await loadFlowInput(scope, c.signal);
    expect(f).not.toHaveBeenCalled();
    expect(r.allFailed).toBe(true);
  });
});
