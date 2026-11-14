import { describe, it, expect } from 'vitest';
import { resourceSection, stripResources } from './route-resources';
import { sectionByKey } from './sections';

describe('resourceSection', () => {
  it('routes a named ENI to network', () => {
    expect(resourceSection('ENI <eni-058d44a138cb9f099>의 보안 그룹 …')).toBe('network');
  });
  it.each([
    'sg-0123456789abcdef0', 'acl-0a1b2c3d', 'rtb-0a1b2c3d4e5f60718', 'subnet-0a1b2c3d',
    'vpc-0a1b2c3d', 'vpce-0a1b2c3d', 'tgw-attach-0a1b2c3d4e5f60718', 'nat-0a1b2c3d',
    'igw-0a1b2c3d', 'pcx-0a1b2c3d',
  ])('routes %s to network', (id) => {
    expect(resourceSection(`${id} 확인`)).toBe('network');
  });
  it('routes an instance ID to ops', () => {
    expect(resourceSection('i-0a1b2c3d4e5f60718 점검')).toBe('ops');
  });
  it('routes ARNs by service', () => {
    expect(resourceSection('arn:aws:iam::123456789012:role/x')).toBe('security');
    expect(resourceSection('arn:aws:eks:ap-northeast-2:123456789012:cluster/c')).toBe('container');
    expect(resourceSection('arn:aws:ecs:ap-northeast-2:123456789012:service/c/s')).toBe('container');
    expect(resourceSection('arn:aws:rds:ap-northeast-2:123456789012:db:d')).toBe('data');
    expect(resourceSection('arn:aws:elasticloadbalancing:ap-northeast-2:123456789012:loadbalancer/app/a/1')).toBe('ops');
    expect(resourceSection('arn:aws:cloudformation:ap-northeast-2:123456789012:stack/s/1')).toBe('iac');
  });
  it('first named resource wins', () => {
    expect(resourceSection('i-0a1b2c3d4e5f60718 의 eni-0a1b2c3d')).toBe('ops');
  });
  it('returns undefined when no resource is named', () => {
    expect(resourceSection('sg-name-prod 규칙')).toBeUndefined();
    expect(resourceSection('vpc-endpoint 설명')).toBeUndefined();
    expect(resourceSection('안녕하세요')).toBeUndefined();
  });
  it('every resource rule targets a known section', () => {
    for (const x of ['eni-0a1b2c3d', 'i-0123456789abcdef0', 'arn:aws:iam::1:role/x', 'arn:aws:eks:r:1:cluster/c',
      'arn:aws:rds:r:1:db:d', 'arn:aws:cloudfront::1:distribution/E1', 'arn:aws:cloudformation:r:1:stack/s/1']) {
      const key = resourceSection(x);
      expect(key).toBeDefined();
      expect(sectionByKey(key as string)).toBeTruthy();
    }
  });
  it('comma-joined ARNs are reduced to their own service names', () => {
    const stripped = stripResources('arn:aws:rds:ap-northeast-2:123456789012:db:mydb,arn:aws:iam::123456789012:role/x');
    expect(stripped).toContain(' rds ');
    expect(stripped).toContain(' iam ');
  });
});
