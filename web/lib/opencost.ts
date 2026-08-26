// Pure OpenCost config render — values.yaml + install.sh string generators.
// READ-ONLY: AWSops generates these; the user runs them out-of-band on their own kubeconfig
// (ADR-035 operator-install precedent). Ported from v1 scripts/07-setup-opencost.sh:83-104.
// No yaml dependency — YAML is hand-built deterministically (stable key order).

export interface OpencostCuratedValues {
  defaultClusterId: string; // opencost.exporter.defaultClusterId
  awsRegion?: string; // opencost.exporter.aws.service_account_region
  prometheusServiceName?: string; // opencost.prometheus.internal.serviceName
  prometheusNamespace?: string; // opencost.prometheus.internal.namespaceName
  prometheusPort?: number; // opencost.prometheus.internal.port
}

export interface OpencostConfig {
  chartVersion?: string; // empty/undefined → latest (no --version), pin for reproducible bundles
  values: OpencostCuratedValues;
  override?: Record<string, unknown>; // free-form, deep-merged over the curated tree
}

export const OPENCOST_REPO_NAME = 'opencost';
export const OPENCOST_REPO_URL = 'https://opencost.github.io/opencost-helm-chart';
export const OPENCOST_CHART = 'opencost/opencost';
export const OPENCOST_NAMESPACE = 'opencost';
// '' = latest (v1 parity, no --version). Pin a specific opencost-helm-chart version here
// for reproducible bundles — recommended.
export const DEFAULT_CHART_VERSION = '';

export const DEFAULT_CURATED_VALUES: Omit<OpencostCuratedValues, 'defaultClusterId'> = {
  prometheusServiceName: 'prometheus-server',
  prometheusNamespace: 'opencost',
  prometheusPort: 80,
};

const SAFE = /^[A-Za-z0-9._-]+$/;
/** Reject shell metacharacters — these names flow into a generated install.sh the user runs. */
export function assertSafeName(label: string, v: string): string {
  if (!SAFE.test(v)) throw new Error(`unsafe ${label}: ${JSON.stringify(v)}`);
  return v;
}

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

function isPlainObject(v: unknown): v is { [k: string]: Json } {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep-merge `b` over `a` (b wins). Pure; returns a new object. */
function deepMerge(a: { [k: string]: Json }, b: { [k: string]: Json }): { [k: string]: Json } {
  const out: { [k: string]: Json } = { ...a };
  for (const k of Object.keys(b)) {
    const av = out[k];
    const bv = b[k];
    out[k] = isPlainObject(av) && isPlainObject(bv) ? deepMerge(av, bv) : bv;
  }
  return out;
}

/** Deterministic YAML emitter: keys SORTED, 2-space indent, scalars + nested maps + simple arrays. */
function toYaml(node: Json, indent = 0): string {
  const pad = '  '.repeat(indent);
  if (isPlainObject(node)) {
    const keys = Object.keys(node).sort();
    if (keys.length === 0) return `${pad}{}\n`;
    return keys
      .map((k) => {
        const v = node[k];
        if (isPlainObject(v) && Object.keys(v).length > 0) return `${pad}${k}:\n${toYaml(v, indent + 1)}`;
        if (Array.isArray(v)) return `${pad}${k}:\n${v.map((e) => `${pad}- ${scalar(e)}`).join('\n')}\n`;
        return `${pad}${k}: ${scalar(v)}\n`;
      })
      .join('');
  }
  return `${pad}${scalar(node)}\n`;
}

function scalar(v: Json): string {
  if (v === null) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (isPlainObject(v) || Array.isArray(v)) return JSON.stringify(v);
  // quote strings that could be misread as YAML scalars; keep simple ones bare
  return /^[A-Za-z0-9._/-]+$/.test(v) ? v : JSON.stringify(v);
}

/** Build the curated opencost values tree (deep-merged with any free-form override). Deterministic. */
export function renderValuesYaml(cfg: OpencostConfig): string {
  const v = cfg.values;
  const internal: { [k: string]: Json } = {
    serviceName: v.prometheusServiceName ?? DEFAULT_CURATED_VALUES.prometheusServiceName!,
    namespaceName: v.prometheusNamespace ?? DEFAULT_CURATED_VALUES.prometheusNamespace!,
    port: v.prometheusPort ?? DEFAULT_CURATED_VALUES.prometheusPort!,
  };
  const exporter: { [k: string]: Json } = { defaultClusterId: v.defaultClusterId };
  if (v.awsRegion) exporter.aws = { service_account_region: v.awsRegion };
  let tree: { [k: string]: Json } = { opencost: { exporter, prometheus: { internal } } };
  if (cfg.override && isPlainObject(cfg.override as Json)) tree = deepMerge(tree, cfg.override as { [k: string]: Json });
  return toYaml(tree);
}

/** Generate the out-of-band install script. Emits --version only when chartVersion is set. */
export function renderInstallSh(opts: { cluster: string; region: string; chartVersion?: string }): string {
  const cluster = assertSafeName('cluster', opts.cluster);
  const region = assertSafeName('region', opts.region);
  const versionFlag = opts.chartVersion ? ` --version ${assertSafeName('chartVersion', opts.chartVersion)}` : '';
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    `aws eks update-kubeconfig --name ${cluster} --region ${region}`,
    `helm repo add ${OPENCOST_REPO_NAME} ${OPENCOST_REPO_URL}`,
    'helm repo update',
    `helm upgrade --install opencost ${OPENCOST_CHART} -n ${OPENCOST_NAMESPACE} --create-namespace${versionFlag} -f values.yaml`,
    '',
  ].join('\n');
}
