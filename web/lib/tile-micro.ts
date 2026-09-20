// Gap L82 (v1 parity): per-type tile micro-stat sublines — state decomposition rendered as a
// tile's subline on the dashboard (compact `micro`) and the group-overview pages (`trend`).
// ONE shared map so the two surfaces cannot drift. Contract (both callers): render only once
// the summary is loaded (no fabricated zeros while loading); an undefined split
// (rolling-deploy skew) drops just that subline (null). Technical terms stay English as v1
// rendered them.

export interface TileSplits {
  ec2Running: number; ec2Stopped: number; ebsUnencrypted: number; iamUserNoMfa: number; sgOpenIngress: number;
  s3Public?: number; cwAlarm?: number;
  // Gap L82 micro-stat sublines (optional — an older task during a rolling deploy may omit them).
  lambdaRuntimes?: number; lambdaLongTimeout?: number; ebsTotalGb?: number;
  rdsMultiAz?: number; rdsUnencrypted?: number; ecrScanOnPush?: number; ecrImmutable?: number;
  s3VersioningOff?: number; cloudfrontEnabled?: number;
}

type MicroFn = (s: TileSplits, countOf: (t: string) => number) => string | null;

const TYPE_MICRO: Record<string, MicroFn> = {
  ec2: (s) => `${s.ec2Running} running · ${s.ec2Stopped} stopped`,
  lambda: (s) => (s.lambdaRuntimes == null ? null : `${s.lambdaRuntimes} runtimes · ${s.lambdaLongTimeout ?? 0} >300s`),
  ebs_volume: (s) => (s.ebsTotalGb == null ? null : `${s.ebsTotalGb.toLocaleString()} GiB · ${s.ebsUnencrypted} unencrypted`),
  rds: (s) => (s.rdsMultiAz == null ? null : `${s.rdsMultiAz} Multi-AZ · ${s.rdsUnencrypted ?? 0} unencrypted`),
  ecr: (s) => (s.ecrScanOnPush == null ? null : `${s.ecrScanOnPush} scan-on-push · ${s.ecrImmutable ?? 0} immutable`),
  s3: (s) => (s.s3VersioningOff == null ? null : `${s.s3Public ?? 0} public · ${s.s3VersioningOff} versioning off`),
  iam_user: (s) => `${s.iamUserNoMfa} no MFA`,
  security_group: (s) => `${s.sgOpenIngress} open ingress`,
  // cloudwatch_alarm lives in the singleton Monitoring group (no /inventory/g page) — no entry.
  cloudfront: (s) => (s.cloudfrontEnabled == null ? null : `${s.cloudfrontEnabled} enabled`),
  // Cross-type compositions — the counts already ride byType, zero extra SQL.
  vpc: (_s, countOf) => `${countOf('subnet')} subnets · ${countOf('nat_gateway')} NAT · ${countOf('transit_gateway')} TGW`,
  ecs_cluster: (_s, countOf) => `${countOf('ecs_service')} services · ${countOf('ecs_task')} tasks`,
  waf: (_s, countOf) => `${countOf('waf_rule_group')} rule groups · ${countOf('waf_ip_set')} IP sets`,
};

/** The shared subline for one inventory type, or null when the type has none / its inputs
 * are not synced yet. `countOf` resolves a cross-type count from the caller's byType data. */
export function typeMicroLine(
  type: string | undefined,
  splits: TileSplits | undefined,
  countOf: (t: string) => number,
): string | null {
  if (!type || !splits) return null;
  return TYPE_MICRO[type]?.(splits, countOf) ?? null;
}
