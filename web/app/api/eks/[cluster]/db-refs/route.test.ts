import { describe, it, expect, vi, beforeEach } from 'vitest';

const { verify, resolve, allowed, listDbRefs, resolveDbHosts } = vi.hoisted(() => ({
  verify: vi.fn(), resolve: vi.fn(), allowed: vi.fn(), listDbRefs: vi.fn(), resolveDbHosts: vi.fn(),
}));
vi.mock('@/lib/auth', () => ({ verifyUser: verify }));
vi.mock('@/lib/eks-registry', () => ({ isAllowed: allowed }));
vi.mock('@/lib/eks-context', () => ({
  resolveEksCluster: resolve,
  EksScopeError: class extends Error { constructor(message: string, public status: number) { super(message); } },
}));
vi.mock('@/lib/eks-db-refs', () => ({ listDbRefs }));
vi.mock('@/lib/db-ref-resolve', () => ({ resolveDbHosts }));

const HOST = { id: 'fsi', name: 'fsi', accountId: 'self', region: 'ap-northeast-2' };
const req = (qs = '', cookie = 'awsops_token=t') => new Request(`http://x/api/eks/fsi/db-refs${qs}`, { headers: { cookie } });
const ctx = (cluster = 'fsi') => ({ params: Promise.resolve({ cluster }) });
const PASSWORD = 'S3cr3t-P@ssw0rd-XYZ';

beforeEach(() => {
  vi.clearAllMocks();
  verify.mockResolvedValue({ sub: 'u' });
  allowed.mockResolvedValue(true);
  resolve.mockReset().mockResolvedValue(HOST);
  listDbRefs.mockReset().mockResolvedValue({ refs: [], secretRefs: [], truncated: false, partial: false });
  resolveDbHosts.mockReset().mockResolvedValue({ map: new Map(), capped: false, incomplete: false });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('GET /api/eks/[cluster]/db-refs', () => {
  it('401 unauthenticated', async () => {
    verify.mockResolvedValue(null);
    const { GET } = await import('./route');
    expect((await GET(req(), ctx())).status).toBe(401);
    expect(listDbRefs).not.toHaveBeenCalled();
  });

  it('404 when the cluster is not registered', async () => {
    allowed.mockResolvedValue(false);
    const { GET } = await import('./route');
    expect((await GET(req(), ctx())).status).toBe(404);
    expect(listDbRefs).not.toHaveBeenCalled();
  });

  it.each(['?kind=pods', '?namespace=default', '?account=self&foo=1', '?accounts=1'])('400 on unexpected query %s', async qs => {
    const { GET } = await import('./route');
    expect((await GET(req(qs), ctx())).status).toBe(400);
    expect(listDbRefs).not.toHaveBeenCalled();
  });

  it('accepts the scope params and passes them to the resolver', async () => {
    const { GET } = await import('./route');
    const res = await GET(req('?account=222222222222&region=us-west-2'), ctx());
    expect(res.status).toBe(200);
    expect(resolve).toHaveBeenCalledWith('fsi', new URL(req('?account=222222222222&region=us-west-2').url).searchParams);
  });

  it('200 joins refs with inventory resources, scoped to the cluster account', async () => {
    const host = 'db-1.abc.ap-northeast-2.rds.amazonaws.com';
    const w = { namespace: 'shop', name: 'api' };
    listDbRefs.mockResolvedValue({
      refs: [{ workload: w, via: 'env', host, kind: 'rds' }, { workload: w, via: 'configmap', host: 'x.cache.amazonaws.com', kind: 'elasticache' }],
      secretRefs: [{ workload: w, secret: 'db-creds' }], truncated: true, partial: true,
    });
    const resource = { type: 'rds', id: 'db-1', region: 'ap-northeast-2', accountId: 'self' };
    resolveDbHosts.mockResolvedValue({ map: new Map([[host, resource]]), capped: false, incomplete: false });
    resolve.mockResolvedValue({ ...HOST, accountId: '111111111111' });
    const { GET } = await import('./route');
    const res = await GET(req(), ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.json()).toEqual({
      refs: [
        { workload: w, via: 'env', host, kind: 'rds', resource },
        { workload: w, via: 'configmap', host: 'x.cache.amazonaws.com', kind: 'elasticache', resource: null },
      ],
      secretRefs: [{ workload: w, secret: 'db-creds' }], truncated: true, partial: true,
      inventoryCapped: false, inventoryIncomplete: false,
    });
    expect(listDbRefs).toHaveBeenCalledWith('fsi');
    expect(resolveDbHosts).toHaveBeenCalledWith([host, 'x.cache.amazonaws.com'], '111111111111');
  });

  it('never serializes values smuggled into extractor output', async () => {
    const host = 'db-1.abc.ap-northeast-2.rds.amazonaws.com';
    const w = { namespace: 'shop', name: 'api' };
    listDbRefs.mockResolvedValue({
      refs: [{ workload: w, via: 'env', host, kind: 'rds', value: `postgres://u:${PASSWORD}@${host}/db`, env: { DB_PASSWORD: PASSWORD } }],
      secretRefs: [{ workload: w, secret: 'db-creds', value: PASSWORD, data: { password: PASSWORD } }],
      truncated: false, partial: false, raw: PASSWORD,
    });
    resolveDbHosts.mockResolvedValue({
      map: new Map([[host, { type: 'rds', id: 'db-1', region: null, accountId: 'self', password: PASSWORD }]]),
      capped: PASSWORD, incomplete: { detail: PASSWORD }, raw: PASSWORD,
    });
    const { GET } = await import('./route');
    const res = await GET(req(), ctx());
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain(PASSWORD);
    expect(text).toContain('db-creds');
    const body = JSON.parse(text);
    expect(body.inventoryCapped).toBe(false);
    expect(body.inventoryIncomplete).toBe(false);
    expect(Object.keys(body).sort()).toEqual(['inventoryCapped', 'inventoryIncomplete', 'partial', 'refs', 'secretRefs', 'truncated']);
  });

  it('discloses a capped or unconfirmed inventory match as explicit booleans', async () => {
    resolveDbHosts.mockResolvedValue({ map: new Map(), capped: true, incomplete: true });
    const { GET } = await import('./route');
    const body = await (await GET(req(), ctx())).json();
    expect(body.inventoryCapped).toBe(true);
    expect(body.inventoryIncomplete).toBe(true);
  });

  it('502 with a generic body when the extractor throws', async () => {
    listDbRefs.mockRejectedValue(new Error(`boom ${PASSWORD}`));
    const { GET } = await import('./route');
    const res = await GET(req(), ctx());
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain(PASSWORD);
  });

  it('502 when inventory resolution throws', async () => {
    listDbRefs.mockResolvedValue({ refs: [{ workload: { namespace: 'a', name: 'b' }, via: 'env', host: 'h.rds.amazonaws.com', kind: 'rds' }], secretRefs: [], truncated: false, partial: false });
    resolveDbHosts.mockRejectedValue(new Error(`pg ${PASSWORD}`));
    const { GET } = await import('./route');
    const res = await GET(req(), ctx());
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain(PASSWORD);
  });
});
