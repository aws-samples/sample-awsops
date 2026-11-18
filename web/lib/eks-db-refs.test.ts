import { beforeEach, describe, expect, it, vi } from 'vitest';

// listDbRefs resolves the cluster connection and bearer ONCE and reuses them for every GET.
const get = vi.fn();
const clusterConn = vi.fn();
const eksToken = vi.fn();
const k8sGetPath = vi.fn();
const CONN = { endpoint: 'https://k8s.example', caPem: Buffer.from('ca') };
vi.mock('./eks-incluster', async () => {
  const actual = await vi.importActual<typeof import('./eks-incluster')>('./eks-incluster');
  return {
    ...actual,
    clusterConn: (...a: unknown[]) => clusterConn(...a),
    eksToken: (...a: unknown[]) => eksToken(...a),
    k8sGetWith: (...a: unknown[]) => get(...a),
    k8sGetPath: (...a: unknown[]) => k8sGetPath(...a),
  };
});
// The real extractor, wrapped so a test can count how many values were scanned.
const extractSpy = vi.fn();
vi.mock('./db-endpoint', async () => {
  const actual = await vi.importActual<typeof import('./db-endpoint')>('./db-endpoint');
  return {
    ...actual,
    extractManagedDbHosts: (v: string) => { extractSpy(v); return actual.extractManagedDbHosts(v); },
  };
});

import { EksKubernetesHttpError } from './eks-read-error';
import { listDbRefs } from './eks-db-refs';

const RDS = 'orders.abc123.ap-northeast-2.rds.amazonaws.com';
const REDIS = 'cache1.xyz.apne2.cache.amazonaws.com';
const PASSWORD = 'S3cr3tP@ssw0rd!';

function pod(name: string, ns: string, containers: unknown[], extra: Record<string, unknown> = {}) {
  return {
    metadata: { name, namespace: ns, ownerReferences: [{ kind: 'ReplicaSet', name: `${name.split('-')[0]}-5d9f8c7b6` }] },
    spec: { containers, ...extra },
  };
}
const list = (items: unknown[], cont?: string) => JSON.stringify({ items, metadata: cont ? { continue: cont } : {} });
const W = (ns: string, name: string) => ({ namespace: ns, name });

describe('listDbRefs', () => {
  beforeEach(() => {
    get.mockReset();
    extractSpy.mockReset();
    k8sGetPath.mockReset().mockRejectedValue(new Error('k8sGetPath must not be used'));
    clusterConn.mockReset().mockResolvedValue(CONN);
    eksToken.mockReset().mockResolvedValue('bearer-1');
  });

  it('extracts hosts from literal env and never leaks the credential', async () => {
    get.mockResolvedValueOnce(list([
      pod('api-1', 'shop', [{ env: [{ name: 'DB_URL', value: `postgres://u:${PASSWORD}@${RDS}:5432/db` }] }]),
    ]));
    const r = await listDbRefs('c1');
    expect(r.refs).toEqual([{ workload: W('shop', 'api'), via: 'env', host: RDS, kind: 'rds' }]);
    expect(JSON.stringify(r)).not.toContain(PASSWORD);
    expect(get.mock.calls[0][2]).toContain('/api/v1/pods?limit=2000');
  });

  it('reads each distinct configmap once and reports via configmap', async () => {
    get.mockResolvedValueOnce(list([
      pod('api-1', 'shop', [{ envFrom: [{ configMapRef: { name: 'cfg' } }] }]),
      pod('api-2', 'shop', [{ env: [{ name: 'H', valueFrom: { configMapKeyRef: { name: 'cfg', key: 'redis' } } }] }]),
      pod('web-1', 'shop', [{ envFrom: [{ configMapRef: { name: 'cfg' } }] }]),
    ]));
    get.mockResolvedValueOnce(JSON.stringify({ data: { db: `host=${RDS} password=${PASSWORD}`, redis: REDIS } }));
    const r = await listDbRefs('c1');
    expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls[1][2]).toBe('/api/v1/namespaces/shop/configmaps/cfg');
    expect(r.refs).toContainEqual({ workload: W('shop', 'web'), via: 'configmap', host: RDS, kind: 'rds' });
    expect(r.refs).toContainEqual({ workload: W('shop', 'web'), via: 'configmap', host: REDIS, kind: 'elasticache' });
    expect(r.refs).toContainEqual({ workload: W('shop', 'api'), via: 'configmap', host: RDS, kind: 'rds' });
    expect(r.refs.filter((x) => x.workload.name === 'api' && x.host === RDS)).toHaveLength(1);
    expect(JSON.stringify(r)).not.toContain(PASSWORD);
    for (const x of r.refs) expect(Object.keys(x).sort()).toEqual(['host', 'kind', 'via', 'workload']);
  });

  it('scans each ConfigMap key once however many workloads consume it via envFrom', async () => {
    const N = 50;
    get.mockResolvedValueOnce(list(Array.from({ length: N }, (_, i) =>
      pod(`w${i}-1`, 'shop', [{ envFrom: [{ configMapRef: { name: 'shared' } }] }]))));
    get.mockResolvedValueOnce(JSON.stringify({ data: { db: `host=${RDS} password=${PASSWORD}`, redis: REDIS, plain: 'hello' } }));
    const r = await listDbRefs('c1');
    expect(get).toHaveBeenCalledTimes(2);
    expect(extractSpy).toHaveBeenCalledTimes(3); // one scan per key, not per (workload, key)
    expect(r.refs).toHaveLength(N * 2);
    for (let i = 0; i < N; i++) {
      expect(r.refs).toContainEqual({ workload: W('shop', `w${i}`), via: 'configmap', host: RDS, kind: 'rds' });
      expect(r.refs).toContainEqual({ workload: W('shop', `w${i}`), via: 'configmap', host: REDIS, kind: 'elasticache' });
    }
    expect(JSON.stringify(r)).not.toContain(PASSWORD);
  });

  it('attributes precomputed ConfigMap hosts per user: configMapKeyRef gets only its key, envFrom gets all keys', async () => {
    get.mockResolvedValueOnce(list([
      pod('a-1', 'shop', [{ env: [{ name: 'D', valueFrom: { configMapKeyRef: { name: 'cfg', key: 'db' } } }] }]),
      pod('b-1', 'shop', [{ envFrom: [{ configMapRef: { name: 'cfg' } }] }]),
    ]));
    get.mockResolvedValueOnce(JSON.stringify({ data: { db: RDS, redis: REDIS } }));
    const r = await listDbRefs('c1');
    expect(extractSpy).toHaveBeenCalledTimes(2);
    expect(r.refs.filter((x) => x.workload.name === 'a')).toEqual([{ workload: W('shop', 'a'), via: 'configmap', host: RDS, kind: 'rds' }]);
    expect(r.refs.filter((x) => x.workload.name === 'b')).toEqual([
      { workload: W('shop', 'b'), via: 'configmap', host: RDS, kind: 'rds' },
      { workload: W('shop', 'b'), via: 'configmap', host: REDIS, kind: 'elasticache' },
    ]);
  });

  it('does not scan ConfigMap keys no consumer references', async () => {
    get.mockResolvedValueOnce(list([
      pod('a-1', 'shop', [{ env: [{ name: 'D', valueFrom: { configMapKeyRef: { name: 'cfg', key: 'db' } } }] }]),
    ]));
    get.mockResolvedValueOnce(JSON.stringify({ data: { db: RDS, redis: REDIS } }));
    const r = await listDbRefs('c1');
    expect(extractSpy).toHaveBeenCalledTimes(1);
    expect(r.refs).toEqual([{ workload: W('shop', 'a'), via: 'configmap', host: RDS, kind: 'rds' }]);
  });

  it.each([
    ['items is an object', JSON.stringify({ items: {} })],
    ['items is missing', JSON.stringify({})],
    ['items carries a value but is not an array', JSON.stringify({ items: { leaked: PASSWORD } })],
    ['the body is null', 'null'],
  ])('rejects an HTTP 200 pod list whose %s with the fixed message', async (_label, body) => {
    get.mockResolvedValueOnce(body);
    const err = await listDbRefs('c1').then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('Kubernetes API response could not be parsed.');
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('returns secret names only and never requests secrets', async () => {
    get.mockResolvedValueOnce(list([
      pod('api-1', 'shop', [{ env: [{ name: 'P', valueFrom: { secretKeyRef: { name: 'db-creds', key: 'pw' } } }], envFrom: [{ secretRef: { name: 'more' } }] }],
        { initContainers: [{ envFrom: [{ secretRef: { name: 'init-s' } }] }] }),
    ]));
    const r = await listDbRefs('c1');
    expect(r.secretRefs.map((s) => s.secret).sort()).toEqual(['db-creds', 'init-s', 'more']);
    expect(r.secretRefs[0].workload).toEqual(W('shop', 'api'));
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls.every((c) => !String(c[2]).includes('/secrets'))).toBe(true);
  });

  it('flags truncated on continue token and on pod cap', async () => {
    get.mockResolvedValueOnce(list([], 'tok'));
    expect((await listDbRefs('c1')).truncated).toBe(true);
    get.mockResolvedValueOnce(list([pod('a-1', 'n', []), pod('b-1', 'n', [])]));
    expect((await listDbRefs('c1', { pods: 1, configMaps: 10 })).truncated).toBe(true);
  });

  it('caps configmap reads and flags truncated', async () => {
    get.mockResolvedValueOnce(list([
      pod('a-1', 'n', [{ envFrom: [{ configMapRef: { name: 'c1' } }, { configMapRef: { name: 'c2' } }] }]),
    ]));
    get.mockResolvedValue(JSON.stringify({ data: { k: RDS } }));
    const r = await listDbRefs('c1', { pods: 10, configMaps: 1 });
    expect(r.truncated).toBe(true);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('marks partial on configmap 403 and keeps other refs', async () => {
    get.mockResolvedValueOnce(list([
      pod('a-1', 'n', [{ env: [{ name: 'D', value: RDS }], envFrom: [{ configMapRef: { name: 'denied' } }] }]),
    ]));
    get.mockRejectedValueOnce(new EksKubernetesHttpError(403));
    const r = await listDbRefs('c1');
    expect(r.partial).toBe(true);
    expect(r.refs).toEqual([{ workload: W('n', 'a'), via: 'env', host: RDS, kind: 'rds' }]);
  });

  it('throws a generic error on an unparsable pod list without echoing the body', async () => {
    get.mockResolvedValueOnce(`{"items": [${PASSWORD}`);
    await expect(listDbRefs('c1')).rejects.toThrow('Kubernetes API response could not be parsed.');
  });

  it('resolves the connection and bearer exactly once for a run with many ConfigMaps', async () => {
    const names = Array.from({ length: 30 }, (_, i) => `cm${i}`);
    get.mockResolvedValueOnce(list([pod('a-1', 'n', [{ envFrom: names.map((name) => ({ configMapRef: { name } })) }])]));
    get.mockResolvedValue(JSON.stringify({ data: { k: RDS } }));
    const r = await listDbRefs('arn:aws:eks:us-east-1:222222222222:cluster/c1');
    expect(get).toHaveBeenCalledTimes(31);
    expect(clusterConn).toHaveBeenCalledTimes(1);
    expect(clusterConn).toHaveBeenCalledWith('arn:aws:eks:us-east-1:222222222222:cluster/c1');
    expect(eksToken).toHaveBeenCalledTimes(1);
    expect(eksToken).toHaveBeenCalledWith('arn:aws:eks:us-east-1:222222222222:cluster/c1');
    expect(k8sGetPath).not.toHaveBeenCalled();
    for (const c of get.mock.calls) { expect(c[0]).toBe(CONN); expect(c[1]).toBe('bearer-1'); }
    expect(r).toMatchObject({ truncated: false, partial: false });
  });

  it('stops issuing reads at the overall deadline and returns partial+truncated with the refs gathered so far', async () => {
    let t = 0;
    const names = Array.from({ length: 20 }, (_, i) => `cm${String(i).padStart(2, '0')}`);
    get.mockResolvedValueOnce(list([pod('a-1', 'n', [{ envFrom: names.map((name) => ({ configMapRef: { name } })) }])]));
    // Each ConfigMap read takes 3 s of wall clock: the first batch of 8 ends at 24 s > 20 s.
    get.mockImplementation(async (_c: unknown, _t: unknown, path: string) => {
      await Promise.resolve(); // the time passes while the request is in flight
      t += 3000;
      const cm = path.split('/').pop();
      return JSON.stringify({ data: { k: `${cm}.abc.us-east-1.rds.amazonaws.com` } });
    });
    const r = await listDbRefs('c1', undefined, { deadlineMs: 20_000, now: () => t });
    expect(get).toHaveBeenCalledTimes(1 + 8);
    expect(r.partial).toBe(true);
    expect(r.truncated).toBe(true);
    expect(r.refs).toHaveLength(8);
    expect(r.refs.map((x) => x.host)).toContain('cm00.abc.us-east-1.rds.amazonaws.com');
  });

  it('does not issue the pod list when the connection cannot be resolved, and rethrows', async () => {
    clusterConn.mockRejectedValueOnce(new Error('EKS endpoint or certificate authority unavailable'));
    await expect(listDbRefs('c1')).rejects.toThrow('EKS endpoint or certificate authority unavailable');
    expect(get).not.toHaveBeenCalled();
  });

  it('returns an empty partial result when pod list is 403, and rethrows other errors', async () => {
    get.mockRejectedValueOnce(new EksKubernetesHttpError(403));
    expect(await listDbRefs('c1')).toEqual({ refs: [], secretRefs: [], truncated: false, partial: true });
    get.mockRejectedValueOnce(new EksKubernetesHttpError(500));
    await expect(listDbRefs('c1')).rejects.toBeInstanceOf(EksKubernetesHttpError);
  });

  it('does not mark partial for a referenced ConfigMap that does not exist (404)', async () => {
    get.mockResolvedValueOnce(list([
      pod('a-1', 'n', [{ env: [{ name: 'D', value: RDS }], envFrom: [{ configMapRef: { name: 'gone' } }] }]),
    ]));
    get.mockRejectedValueOnce(new EksKubernetesHttpError(404));
    expect(await listDbRefs('c1')).toEqual({
      refs: [{ workload: W('n', 'a'), via: 'env', host: RDS, kind: 'rds' }], secretRefs: [], truncated: false, partial: false,
    });
  });

  it.each([401, 500, 503])('marks partial on ConfigMap HTTP %s', async (status) => {
    get.mockResolvedValueOnce(list([pod('a-1', 'n', [{ envFrom: [{ configMapRef: { name: 'cfg' } }] }])]));
    get.mockRejectedValueOnce(new EksKubernetesHttpError(status));
    expect((await listDbRefs('c1')).partial).toBe(true);
  });

  it('marks partial on a ConfigMap timeout or unparsable body', async () => {
    get.mockResolvedValueOnce(list([pod('a-1', 'n', [{ envFrom: [{ configMapRef: { name: 'cfg' } }] }])]));
    get.mockRejectedValueOnce(Object.assign(new Error('Kubernetes API request timed out.'), { name: 'TimeoutError', code: 'ETIMEDOUT' }));
    expect((await listDbRefs('c1')).partial).toBe(true);
    get.mockResolvedValueOnce(list([pod('a-1', 'n', [{ envFrom: [{ configMapRef: { name: 'cfg' } }] }])]));
    get.mockResolvedValueOnce('{not json');
    expect((await listDbRefs('c1')).partial).toBe(true);
  });

  it.each([[10 * 60_000, 7000], [Number.NaN, 3000]])('clamps a run budget of %s ms below the 60 s bearer lifetime', async (deadlineMs, step) => {
    let t = 0;
    const names = Array.from({ length: 24 }, (_, i) => `cm${String(i).padStart(2, '0')}`);
    get.mockResolvedValueOnce(list([pod('a-1', 'n', [{ envFrom: names.map((name) => ({ configMapRef: { name } })) }])]));
    get.mockImplementation(async () => { await Promise.resolve(); t += step; return JSON.stringify({ data: {} }); });
    const r = await listDbRefs('c1', undefined, { deadlineMs, now: () => t });
    expect(get).toHaveBeenCalledTimes(1 + 8); // 8 x 7 s = 56 s > the 50 s ceiling; NaN falls back to 20 s (8 x 3 s = 24 s)
    expect(r).toMatchObject({ partial: true, truncated: true });
  });

  it('never sends limit=0 (unlimited in Kubernetes): the pod cap is a positive integer', async () => {
    get.mockResolvedValueOnce(list([pod('a-1', 'n', [{ env: [{ name: 'D', value: RDS }] }])]));
    const r = await listDbRefs('c1', { pods: 0, configMaps: 10 });
    expect(get.mock.calls[0][2]).toBe('/api/v1/pods?limit=1');
    expect(r.refs).toEqual([{ workload: W('n', 'a'), via: 'env', host: RDS, kind: 'rds' }]);
    expect(r.truncated).toBe(false);
    get.mockResolvedValueOnce(list([]));
    await listDbRefs('c1', { pods: 2.7, configMaps: 10 });
    expect(get.mock.calls[1][2]).toBe('/api/v1/pods?limit=2');
  });

  it('applies the ConfigMap cap in namespace/name order, not pod arrival order', async () => {
    get.mockResolvedValueOnce(list([
      pod('a-1', 'n', [{ envFrom: [{ configMapRef: { name: 'zeta' } }] }]),
      pod('b-1', 'n', [{ envFrom: [{ configMapRef: { name: 'alpha' } }] }]),
      pod('c-1', 'm', [{ envFrom: [{ configMapRef: { name: 'omega' } }] }]),
    ]));
    get.mockResolvedValue(JSON.stringify({ data: {} }));
    const r = await listDbRefs('c1', { pods: 10, configMaps: 2 });
    expect(get.mock.calls.slice(1).map((c) => c[2])).toEqual([
      '/api/v1/namespaces/m/configmaps/omega', '/api/v1/namespaces/n/configmaps/alpha',
    ]);
    expect(r.truncated).toBe(true);
  });
});
