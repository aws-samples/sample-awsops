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
});
