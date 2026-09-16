// Client-safe owner guidance: no server imports, credentials, or API calls.
export const MEMBER_EKS_GROUP = 'awsops:eks-readonly';

// JSON-form Kubernetes manifest, accepted by kubectl apply -f -. The managed
// AmazonEKSViewPolicy supplies the other supported reads; this adds only nodes.
// https://docs.aws.amazon.com/eks/latest/userguide/access-policy-permissions.html
export const MEMBER_EKS_NODES_MANIFEST = JSON.stringify({
  apiVersion: 'v1',
  kind: 'List',
  items: [
    {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'ClusterRole',
      metadata: { name: 'awsops-eks-nodes-readonly' },
      rules: [{ apiGroups: [''], resources: ['nodes'], verbs: ['get', 'list', 'watch'] }],
    },
    {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'ClusterRoleBinding',
      metadata: { name: 'awsops-eks-nodes-readonly' },
      subjects: [{ kind: 'Group', name: MEMBER_EKS_GROUP, apiGroup: 'rbac.authorization.k8s.io' }],
      roleRef: { kind: 'ClusterRole', name: 'awsops-eks-nodes-readonly', apiGroup: 'rbac.authorization.k8s.io' },
    },
  ],
}, null, 2);
