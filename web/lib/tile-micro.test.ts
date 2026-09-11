import { describe, it, expect } from 'vitest';
import { typeMicroLine, type TileSplits } from './tile-micro';

const SPLITS: TileSplits = {
  ec2Running: 7, ec2Stopped: 2, ebsUnencrypted: 1, iamUserNoMfa: 3, sgOpenIngress: 4,
  s3Public: 1, lambdaRuntimes: 5, lambdaLongTimeout: 2, ebsTotalGb: 1200,
  rdsMultiAz: 2, rdsUnencrypted: 1, ecrScanOnPush: 6, ecrImmutable: 4,
  s3VersioningOff: 9, cloudfrontEnabled: 3,
};
const COUNTS: Record<string, number> = {
  subnet: 12, nat_gateway: 2, transit_gateway: 1,
  ecs_service: 8, ecs_task: 21, waf_rule_group: 3, waf_ip_set: 5,
};
const countOf = (t: string) => COUNTS[t] ?? 0;

describe('typeMicroLine (gap L82 — shared dashboard/group sublines)', () => {
  it('renders v1-parity state decompositions', () => {
    expect(typeMicroLine('ec2', SPLITS, countOf)).toBe('7 running · 2 stopped');
    expect(typeMicroLine('lambda', SPLITS, countOf)).toBe('5 runtimes · 2 >300s');
    expect(typeMicroLine('ebs_volume', SPLITS, countOf)).toBe('1,200 GiB · 1 unencrypted');
    expect(typeMicroLine('s3', SPLITS, countOf)).toBe('1 public · 9 versioning off');
    expect(typeMicroLine('iam_user', SPLITS, countOf)).toBe('3 no MFA');
    expect(typeMicroLine('security_group', SPLITS, countOf)).toBe('4 open ingress');
  });
  it('composes cross-type byType counts (vpc, ecs_cluster, waf) with zero extra SQL', () => {
    expect(typeMicroLine('vpc', SPLITS, countOf)).toBe('12 subnets · 2 NAT · 1 TGW');
    expect(typeMicroLine('ecs_cluster', SPLITS, countOf)).toBe('8 services · 21 tasks');
    expect(typeMicroLine('waf', SPLITS, countOf)).toBe('3 rule groups · 5 IP sets');
  });
  it('drops the subline (null) when its split inputs are absent — rolling-deploy skew', () => {
    const partial: TileSplits = { ec2Running: 1, ec2Stopped: 0, ebsUnencrypted: 0, iamUserNoMfa: 0, sgOpenIngress: 0 };
    expect(typeMicroLine('lambda', partial, countOf)).toBeNull();
    expect(typeMicroLine('ebs_volume', partial, countOf)).toBeNull();
    expect(typeMicroLine('rds', partial, countOf)).toBeNull();
    expect(typeMicroLine('cloudfront', partial, countOf)).toBeNull();
    // splits present → the required fields still render
    expect(typeMicroLine('ec2', partial, countOf)).toBe('1 running · 0 stopped');
  });
  it('returns null while the summary is loading (no fabricated zeros) and for unmapped types', () => {
    expect(typeMicroLine('ec2', undefined, countOf)).toBeNull();
    expect(typeMicroLine(undefined, SPLITS, countOf)).toBeNull();
    expect(typeMicroLine('dynamodb', SPLITS, countOf)).toBeNull();
  });
});
