// Client-safe identifiers: no AWS, environment, or database dependencies.
const NAME_RE = /^[0-9A-Za-z][A-Za-z0-9_-]{0,99}$/;
const ACCOUNT_RE = /^\d{12}$/;
const REGION_RE = /^[a-z]{2}(?:-[a-z]+)+-\d+$/;
const ARN_RE = /^arn:aws:eks:([^:]+):(\d{12}):cluster\/(.+)$/;

export function parseEksClusterId(id: string): { name: string; accountId?: string; region?: string } | null {
  // JS `$` also matches before a final newline; reject whitespace explicitly.
  if (typeof id !== 'string' || /\s/.test(id)) return null;
  if (NAME_RE.test(id)) return { name: id };
  const match = ARN_RE.exec(id);
  if (!match || !REGION_RE.test(match[1]) || !NAME_RE.test(match[3])) return null;
  return { name: match[3], accountId: match[2], region: match[1] };
}

export function eksClusterName(id: string): string {
  return parseEksClusterId(id)?.name ?? id;
}

export function eksClusterLabel(id: string): string {
  const cluster = parseEksClusterId(id);
  return cluster?.accountId
    ? `${cluster.name} (${cluster.accountId} / ${cluster.region})`
    : eksClusterName(id);
}

export function qualifiedEksClusterId(name: string, accountId: string, region: string): string {
  if (!NAME_RE.test(name) || !ACCOUNT_RE.test(accountId) || !REGION_RE.test(region) || /\s/.test(name + accountId + region)) {
    throw new Error('Invalid EKS cluster identity');
  }
  return `arn:aws:eks:${region}:${accountId}:cluster/${name}`;
}
