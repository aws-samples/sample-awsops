import { describe, expect, it } from 'vitest';
import { MEMBER_EKS_GROUP, MEMBER_EKS_NODES_MANIFEST } from './eks-member-rbac';

describe('member EKS nodes-only RBAC', () => {
  it('binds only core nodes get/list/watch to the fixed AWSops group', () => {
    const manifest = JSON.parse(MEMBER_EKS_NODES_MANIFEST);
    expect(MEMBER_EKS_GROUP).toBe('awsops:eks-readonly');
    expect(manifest.apiVersion).toBe('v1');
    expect(manifest.kind).toBe('List');
    expect(manifest.items).toHaveLength(2);
    const [role, binding] = manifest.items;
    expect(role).toEqual({
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'ClusterRole',
      metadata: { name: 'awsops-eks-nodes-readonly' },
      rules: [{ apiGroups: [''], resources: ['nodes'], verbs: ['get', 'list', 'watch'] }],
    });
    expect(binding).toEqual({
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'ClusterRoleBinding',
      metadata: { name: 'awsops-eks-nodes-readonly' },
      subjects: [{ kind: 'Group', name: 'awsops:eks-readonly', apiGroup: 'rbac.authorization.k8s.io' }],
      roleRef: { kind: 'ClusterRole', name: 'awsops-eks-nodes-readonly', apiGroup: 'rbac.authorization.k8s.io' },
    });
    expect(role.rules.flatMap((rule: { resources: string[] }) => rule.resources)).not.toContain('services/proxy');
    expect(MEMBER_EKS_NODES_MANIFEST).not.toMatch(/secrets|nonResourceURLs|aggregationRule|"[*]"|"create"|"update"|"patch"|"delete"/);
  });
});
