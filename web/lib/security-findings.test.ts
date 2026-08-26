import { describe, it, expect } from 'vitest';
import { CHECK_META, FINDING_SQL, rowToFinding } from './security-findings';

describe('security-findings', () => {
  it('has metadata + SQL for all four checks', () => {
    for (const k of ['public_s3', 'open_sg', 'unencrypted_ebs', 'iam_no_mfa'] as const) {
      expect(CHECK_META[k].severity).toMatch(/high|medium|low/);
      expect(CHECK_META[k].remediation.length).toBeGreaterThan(0);
      expect(FINDING_SQL[k]).toContain("account_id = ANY($1)");
    }
  });
  it('open_sg SQL anchors cidr to the cidr key (ipv4+ipv6, both casings) and reads security_group', () => {
    const sql = FINDING_SQL.open_sg;
    expect(sql).toContain('security_group');
    expect(sql).toMatch(/cidr_ip\|CidrIp/);
    expect(sql).toMatch(/0\\.0\\.0\\.0\/0/);
    expect(sql).toMatch(/::\/0/);
  });
  it('rowToFinding stamps check/severity/remediation and passes detail through', () => {
    const f = rowToFinding('unencrypted_ebs', { resource_id: 'vol-1', region: 'ap-northeast-2', detail: { size: 8 } });
    expect(f).toMatchObject({ check: 'unencrypted_ebs', resource_id: 'vol-1', region: 'ap-northeast-2', severity: 'medium' });
    expect(f.remediation).toBe(CHECK_META.unencrypted_ebs.remediation);
    expect(f.detail).toEqual({ size: 8 });
  });
  it('rowToFinding coerces non-object detail to {}', () => {
    const f = rowToFinding('open_sg', { resource_id: 'sg-1', region: 'ap-northeast-2', detail: null });
    expect(f.detail).toEqual({});
  });
});
