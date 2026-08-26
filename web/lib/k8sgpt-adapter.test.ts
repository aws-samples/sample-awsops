import { describe, it, expect } from 'vitest';
import { adaptResult, adaptResultList, fingerprint, ADAPTER_K8SGPT_VERSION } from './k8sgpt-adapter';

// H0 spike real shape (fsi-demo-cluster, K8s 1.36): kind,name,error,details,parentObject.
const otelCrd = {
  metadata: { name: 'otel-collector-result', namespace: 'observability' },
  spec: {
    kind: 'DaemonSet',
    name: 'observability/otel-collector',
    error: [{ text: 'DaemonSet observability/otel-collector has 5/8 ready pods' }],
    details: 'CrashLoopBackOff on container otel-collector',
    parentObject: 'DaemonSet/otel-collector',
    backend: '', // deterministic-only — NO amazonbedrock
  },
};

describe('adaptResult (Rule 7 versioned adapter)', () => {
  it('maps the H0 native Result shape to the stable AnalyzerResult contract', () => {
    const r = adaptResult(otelCrd);
    expect(r.analyzer).toBe('DaemonSet');
    expect(r.resourceName).toBe('observability/otel-collector');
    expect(r.namespace).toBe('observability');
    expect(r.errors).toEqual(['DaemonSet observability/otel-collector has 5/8 ready pods']);
    expect(r.details).toContain('CrashLoopBackOff');
    expect(r.parentObject).toBe('DaemonSet/otel-collector');
    expect(r.adapterVersion).toBe(ADAPTER_K8SGPT_VERSION);
    expect(r.fingerprint).toMatch(/^[0-9a-f]{32}$/);
  });

  it('tolerates missing namespace (derives from name) and unknown upstream fields', () => {
    const r = adaptResult({ spec: { kind: 'Pod', name: 'kube-system/x', error: [], extraNew: 1 } as never });
    expect(r.namespace).toBe('kube-system');
    expect(r.errors).toEqual([]);
  });

  it('fingerprint is stable across scans (timestamp-independent) and changes on error change', () => {
    const a = fingerprint({ analyzer: 'Pod', resourceName: 'ns/p', errors: ['b', 'a'] });
    const b = fingerprint({ analyzer: 'Pod', resourceName: 'ns/p', errors: ['a', 'b'] });
    const c = fingerprint({ analyzer: 'Pod', resourceName: 'ns/p', errors: ['a', 'changed'] });
    expect(a).toBe(b);          // order-independent → unchanged finding == same fingerprint
    expect(a).not.toBe(c);      // changed error → re-narrate
  });

  it('adaptResultList drops items with no analyzer/resource', () => {
    expect(adaptResultList([otelCrd, { spec: {} }, undefined as never])).toHaveLength(1);
  });
});
