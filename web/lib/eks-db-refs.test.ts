import { beforeEach, describe, expect, it, vi } from 'vitest';

const k8sGetPath = vi.fn();
vi.mock('./eks-incluster', async () => {
  const actual = await vi.importActual<typeof import('./eks-incluster')>('./eks-incluster');
  return { ...actual, k8sGetPath: (...a: unknown[]) => k8sGetPath(...a) };
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
  beforeEach(() => k8sGetPath.mockReset());

  it('extracts hosts from literal env and never leaks the credential', async () => {
    k8sGetPath.mockResolvedValueOnce(list([
      pod('api-1', 'shop', [{ env: [{ name: 'DB_URL', value: `postgres://u:${PASSWORD}@${RDS}:5432/db` }] }]),
    ]));
    const r = await listDbRefs('c1');
    expect(r.refs).toEqual([{ workload: W('shop', 'api'), via: 'env', host: RDS, kind: 'rds' }]);
    expect(JSON.stringify(r)).not.toContain(PASSWORD);
    expect(k8sGetPath.mock.calls[0][1]).toContain('/api/v1/pods?limit=2000');
  });

  it('reads each distinct configmap once and reports via configmap', async () => {
    k8sGetPath.mockResolvedValueOnce(list([
      pod('api-1', 'shop', [{ envFrom: [{ configMapRef: { name: 'cfg' } }] }]),
      pod('api-2', 'shop', [{ env: [{ name: 'H', valueFrom: { configMapKeyRef: { name: 'cfg', key: 'redis' } } }] }]),
      pod('web-1', 'shop', [{ envFrom: [{ configMapRef: { name: 'cfg' } }] }]),
    ]));
    k8sGetPath.mockResolvedValueOnce(JSON.stringify({ data: { db: `host=${RDS} password=${PASSWORD}`, redis: REDIS } }));
    const r = await listDbRefs('c1');
    expect(k8sGetPath).toHaveBeenCalledTimes(2);
    expect(k8sGetPath.mock.calls[1][1]).toBe('/api/v1/namespaces/shop/configmaps/cfg');
    expect(r.refs).toContainEqual({ workload: W('shop', 'web'), via: 'configmap', host: RDS, kind: 'rds' });
    expect(r.refs).toContainEqual({ workload: W('shop', 'web'), via: 'configmap', host: REDIS, kind: 'elasticache' });
    expect(r.refs).toContainEqual({ workload: W('shop', 'api'), via: 'configmap', host: RDS, kind: 'rds' });
    expect(r.refs.filter((x) => x.workload.name === 'api' && x.host === RDS)).toHaveLength(1);
    expect(JSON.stringify(r)).not.toContain(PASSWORD);
    for (const x of r.refs) expect(Object.keys(x).sort()).toEqual(['host', 'kind', 'via', 'workload']);
  });

  it('returns secret names only and never requests secrets', async () => {
    k8sGetPath.mockResolvedValueOnce(list([
      pod('api-1', 'shop', [{ env: [{ name: 'P', valueFrom: { secretKeyRef: { name: 'db-creds', key: 'pw' } } }], envFrom: [{ secretRef: { name: 'more' } }] }],
        { initContainers: [{ envFrom: [{ secretRef: { name: 'init-s' } }] }] }),
    ]));
    const r = await listDbRefs('c1');
    expect(r.secretRefs.map((s) => s.secret).sort()).toEqual(['db-creds', 'init-s', 'more']);
    expect(r.secretRefs[0].workload).toEqual(W('shop', 'api'));
    expect(k8sGetPath).toHaveBeenCalledTimes(1);
    expect(k8sGetPath.mock.calls.every((c) => !String(c[1]).includes('/secrets'))).toBe(true);
  });

  it('flags truncated on continue token and on pod cap', async () => {
    k8sGetPath.mockResolvedValueOnce(list([], 'tok'));
    expect((await listDbRefs('c1')).truncated).toBe(true);
    k8sGetPath.mockResolvedValueOnce(list([pod('a-1', 'n', []), pod('b-1', 'n', [])]));
    expect((await listDbRefs('c1', { pods: 1, configMaps: 10 })).truncated).toBe(true);
  });

  it('caps configmap reads and flags truncated', async () => {
    k8sGetPath.mockResolvedValueOnce(list([
      pod('a-1', 'n', [{ envFrom: [{ configMapRef: { name: 'c1' } }, { configMapRef: { name: 'c2' } }] }]),
    ]));
    k8sGetPath.mockResolvedValue(JSON.stringify({ data: { k: RDS } }));
    const r = await listDbRefs('c1', { pods: 10, configMaps: 1 });
    expect(r.truncated).toBe(true);
    expect(k8sGetPath).toHaveBeenCalledTimes(2);
  });

  it('marks partial on configmap 403 and keeps other refs', async () => {
    k8sGetPath.mockResolvedValueOnce(list([
      pod('a-1', 'n', [{ env: [{ name: 'D', value: RDS }], envFrom: [{ configMapRef: { name: 'denied' } }] }]),
    ]));
    k8sGetPath.mockRejectedValueOnce(new EksKubernetesHttpError(403));
    const r = await listDbRefs('c1');
    expect(r.partial).toBe(true);
    expect(r.refs).toEqual([{ workload: W('n', 'a'), via: 'env', host: RDS, kind: 'rds' }]);
  });

  it('throws a generic error on an unparsable pod list without echoing the body', async () => {
    k8sGetPath.mockResolvedValueOnce(`{"items": [${PASSWORD}`);
    await expect(listDbRefs('c1')).rejects.toThrow('Kubernetes API response could not be parsed.');
  });

  it('returns an empty partial result when pod list is 403, and rethrows other errors', async () => {
    k8sGetPath.mockRejectedValueOnce(new EksKubernetesHttpError(403));
    expect(await listDbRefs('c1')).toEqual({ refs: [], secretRefs: [], truncated: false, partial: true });
    k8sGetPath.mockRejectedValueOnce(new EksKubernetesHttpError(500));
    await expect(listDbRefs('c1')).rejects.toBeInstanceOf(EksKubernetesHttpError);
  });
});
