import { describe, it, expect } from 'vitest';
import { renderValuesYaml, renderInstallSh, assertSafeName, assertSafeYamlKeys, DEFAULT_CHART_VERSION, type OpencostConfig } from './opencost';

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

  // pentest-remediation P1-2 (Finding 4): a literal newline in an override KEY used to rewrite YAML
  // structure — toYaml() interpolated keys raw, and scalar() only quotes *values*. These reproduce
  // the exact pentest repro steps and must now throw instead of silently emitting injected YAML.
  it('rejects a newline-injected top-level key (Finding 4 Step 2)', () => {
    expect(() =>
      renderValuesYaml({ ...baseCfg, override: { 'key\nmalicious_key: injected_value': 'test' } }),
    ).toThrow(/unsafe config key/);
  });
  it('rejects the escalated multi-block injection (Finding 4 Step 4: imageRegistry/extraEnv/nodeSelector)', () => {
    const evilKey = "global:\n  imageRegistry: 'attacker.registry.io'\nopencost:\n  exporter:\n    extraEnv:\n      - name: MALICIOUS_INJECTION\n        value: 'CONFIRMED'\n    nodeSelector:\n      compromised: 'true'\n# ";
    expect(() => renderValuesYaml({ ...baseCfg, override: { [evilKey]: 'end' } })).toThrow(/unsafe config key/);
  });
  it('rejects a colon-injected nested key, not just top-level', () => {
    expect(() =>
      renderValuesYaml({ ...baseCfg, override: { opencost: { 'ui\nglobal': { imageRegistry: 'evil' } } } }),
    ).toThrow(/unsafe config key/);
  });
  it('still accepts a normal override with dots/underscores/hyphens in keys', () => {
    expect(() =>
      renderValuesYaml({ ...baseCfg, override: { 'my-key.v2_ok': 'fine' } }),
    ).not.toThrow();
  });
  // real Helm/K8s keys routinely contain '/' (IRSA annotations, nodeSelector, podAnnotations) —
  // '/' doesn't break bare-scalar YAML key syntax, so the key validator must accept it (was
  // wrongly reusing the shell-safety assertSafeName charset, which rejects '/').
  it('accepts IRSA-style annotation keys containing a slash', () => {
    expect(() =>
      renderValuesYaml({
        ...baseCfg,
        override: {
          serviceAccount: { annotations: { 'eks.amazonaws.com/role-arn': 'arn:aws:iam::123:role/x' } },
          nodeSelector: { 'kubernetes.io/os': 'linux' },
          podAnnotations: { 'prometheus.io/scrape': 'true' },
        },
      }),
    ).not.toThrow();
  });
  it('still rejects the original Finding 4 newline/colon injection payloads', () => {
    expect(() =>
      renderValuesYaml({ ...baseCfg, override: { 'key\nmalicious_key: injected_value': 'test' } }),
    ).toThrow(/unsafe config key/);
  });
  it('rejects __proto__/constructor/prototype override keys at validation time', () => {
    // computed key forces a real own property (a literal `{ __proto__: ... }` sets the prototype instead)
    expect(() => assertSafeYamlKeys({ ['__proto__']: { polluted: true } } as any)).toThrow(/unsafe config key/);
  });
});

describe('assertSafeYamlKeys', () => {
  it('passes a clean nested tree (objects + arrays)', () => {
    expect(() => assertSafeYamlKeys({ a: { b: [{ c: 1 }, { d: 'ok' }] } } as any)).not.toThrow();
  });
  it('throws on an unsafe key at any depth', () => {
    expect(() => assertSafeYamlKeys({ a: { 'b\nc': 1 } } as any)).toThrow(/unsafe config key/);
  });
  it('accepts a slash in keys (IRSA/K8s annotation style)', () => {
    expect(() => assertSafeYamlKeys({ 'eks.amazonaws.com/role-arn': 'x' } as any)).not.toThrow();
  });
  it('rejects a leading dash (YAML sequence indicator)', () => {
    expect(() => assertSafeYamlKeys({ '-foo': 1 } as any)).toThrow(/unsafe config key/);
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
