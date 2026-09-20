import { describe, expect, it } from 'vitest';
import { eksClusterLabel, eksClusterName, parseEksClusterId, qualifiedEksClusterId } from './eks-cluster-id';

const ARN = 'arn:aws:eks:us-east-1:222222222222:cluster/shared_name';

describe('EKS cluster identifiers', () => {
  it('parses legacy names and scoped ARNs without losing account or region', () => {
    expect(parseEksClusterId('shared_name')).toEqual({ name: 'shared_name' });
    expect(parseEksClusterId(ARN)).toEqual({
      name: 'shared_name', accountId: '222222222222', region: 'us-east-1',
    });
    expect(eksClusterName(ARN)).toBe('shared_name');
    expect(eksClusterLabel(ARN)).toBe('shared_name (222222222222 / us-east-1)');
    expect(eksClusterLabel('shared_name')).toBe('shared_name');
  });

  it.each([
    '', '-bad', 'a/b', 'a b', 'a\n', 'a'.repeat(101),
    'arn:aws:eks:us-east-1:123:cluster/name',
    'arn:aws:eks:not-region:222222222222:cluster/name',
    'arn:aws:eks:us-east-1:222222222222:cluster/name/extra',
    'arn:aws-cn:eks:cn-north-1:222222222222:cluster/name',
    'arn:aws:eks:us-east-1:222222222222:cluster/name\n',
  ])('rejects malformed identifier %j', id => {
    expect(parseEksClusterId(id)).toBeNull();
  });

  it('builds validated qualified IDs and prevents same-name collisions', () => {
    expect(qualifiedEksClusterId('shared_name', '222222222222', 'us-east-1')).toBe(ARN);
    expect(qualifiedEksClusterId('shared_name', '111111111111', 'us-east-1')).not.toBe(ARN);
    expect(qualifiedEksClusterId('shared_name', '222222222222', 'us-west-2')).not.toBe(ARN);
    expect(() => qualifiedEksClusterId('bad/name', '222222222222', 'us-east-1')).toThrow();
    expect(() => qualifiedEksClusterId('name', 'self', 'us-east-1')).toThrow();
    expect(() => qualifiedEksClusterId('name', '222222222222', 'bad')).toThrow();
  });
});
