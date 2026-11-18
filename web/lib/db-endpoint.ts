// Pure extraction of AWS managed-datastore hostnames from config values.
// SECURITY: values may embed credentials (connection strings). Only the bare,
// lower-cased host is ever returned — never userinfo, port, path or raw value.

export type DbKind = 'rds' | 'elasticache' | 'opensearch' | 'msk';

const MAX_INPUT = 4096;
const MAX_HOSTS = 20;

// Boundaries: whitespace and URL/list delimiters. '@' splits userinfo off so it
// is never a candidate; ':' is handled per-token to drop a numeric port only.
const SPLIT_RE = /[\s,;"'=@/?#<>()[\]{}\\|]+/;
const CANDIDATE_RE = /^([a-z0-9]([a-z0-9.-]*[a-z0-9])?)(:\d{1,5})?$/;

const KIND_PATTERNS: [DbKind, RegExp][] = [
  ['rds', /\.rds\.amazonaws\.com(\.cn)?$/],
  ['elasticache', /\.cache\.amazonaws\.com(\.cn)?$/],
  ['opensearch', /\.(es|aoss)\.amazonaws\.com(\.cn)?$/],
  ['msk', /\.kafka(-serverless)?\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/],
];

export function extractManagedDbHosts(value: string): { host: string; kind: DbKind }[] {
  if (typeof value !== 'string' || value.length === 0) return [];
  const out: { host: string; kind: DbKind }[] = [];
  const seen = new Set<string>();
  for (const raw of value.slice(0, MAX_INPUT).split(SPLIT_RE)) {
    const m = CANDIDATE_RE.exec(raw.toLowerCase());
    if (!m) continue;
    const host = m[1];
    if (seen.has(host)) continue;
    const kind = KIND_PATTERNS.find(([, re]) => re.test(host))?.[0];
    if (!kind) continue;
    seen.add(host);
    out.push({ host, kind });
    if (out.length >= MAX_HOSTS) break;
  }
  return out;
}
