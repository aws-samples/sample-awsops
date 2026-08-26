import { describe, it, expect } from 'vitest';
import { renderValuesYaml, renderInstallSh, assertSafeName, DEFAULT_CHART_VERSION, type OpencostConfig } from './opencost';

const baseCfg: OpencostConfig = {
  chartVersion: '',
  values: { defaultClusterId: 'fsi-demo-cluster', awsRegion: 'ap-northeast-2' },
};

describe('renderValuesYaml', () => {
  it('is deterministic (byte-identical on repeat)', () => {
    expect(renderValuesYaml(baseCfg)).toBe(renderValuesYaml(baseCfg));
  });
  it('emits the curated keys with correct nesting + injected cluster/region', () => {
    const y = renderValuesYaml(baseCfg);
    expect(y).toContain('opencost:');
    expect(y).toContain('defaultClusterId: fsi-demo-cluster');
    expect(y).toContain('service_account_region: ap-northeast-2');
    expect(y).toContain('serviceName: prometheus-server');
    expect(y).toContain('namespaceName: opencost');
    expect(y).toContain('port: 80');
  });
  it('uses stable (sorted) key order', () => {
    // exporter sorts before prometheus; within prometheus.internal: namespaceName < port < serviceName
    const y = renderValuesYaml(baseCfg);
    expect(y.indexOf('exporter:')).toBeLessThan(y.indexOf('prometheus:'));
    expect(y.indexOf('namespaceName:')).toBeLessThan(y.indexOf('port:'));
    expect(y.indexOf('port:')).toBeLessThan(y.indexOf('serviceName:'));
  });
  it('deep-merges a free-form override (override wins)', () => {
    const y = renderValuesYaml({ ...baseCfg, override: { opencost: { ui: { enabled: false } }, extra: { a: 1 } } });
    expect(y).toContain('enabled: false');
    expect(y).toContain('a: 1');
    expect(y).toContain('defaultClusterId: fsi-demo-cluster'); // curated preserved
  });
});

describe('renderInstallSh', () => {
  it('embeds the exact cluster + region in update-kubeconfig and the helm upgrade --install form', () => {
    const sh = renderInstallSh({ cluster: 'fsi-demo-cluster', region: 'ap-northeast-2' });
    expect(sh).toContain('set -euo pipefail');
    expect(sh).toContain('aws eks update-kubeconfig --name fsi-demo-cluster --region ap-northeast-2');
    expect(sh).toContain('helm repo add opencost https://opencost.github.io/opencost-helm-chart');
    expect(sh).toContain('helm upgrade --install opencost opencost/opencost -n opencost --create-namespace');
    expect(sh).toContain('-f values.yaml');
  });
  it('emits --version only when chartVersion is set (latest = no flag, v1 parity)', () => {
    expect(renderInstallSh({ cluster: 'c', region: 'r' })).not.toContain('--version');
    expect(renderInstallSh({ cluster: 'c', region: 'r', chartVersion: '1.42.0' })).toContain('--version 1.42.0');
  });
  it('never embeds a token or presigned URL (read-only-safe bundle)', () => {
    const sh = renderInstallSh({ cluster: 'c', region: 'r' });
    expect(sh).not.toMatch(/X-Amz-|Bearer |k8s-aws-v1\.|sts\..*Signature/);
  });
  it('rejects shell-injection in cluster/region/chartVersion', () => {
    expect(() => renderInstallSh({ cluster: 'c; rm -rf /', region: 'r' })).toThrow(/unsafe cluster/);
    expect(() => renderInstallSh({ cluster: 'c', region: 'r$(whoami)' })).toThrow(/unsafe region/);
    expect(() => renderInstallSh({ cluster: 'c', region: 'r', chartVersion: '1.0 && curl evil' })).toThrow(/unsafe chartVersion/);
  });
});

describe('constants + guard', () => {
  it('DEFAULT_CHART_VERSION is empty (latest by default; pin opt-in)', () => {
    expect(DEFAULT_CHART_VERSION).toBe('');
  });
  it('assertSafeName passes safe names and throws on metachars', () => {
    expect(assertSafeName('x', 'fsi-demo_cluster.1')).toBe('fsi-demo_cluster.1');
    expect(() => assertSafeName('x', 'a b')).toThrow();
  });
});
