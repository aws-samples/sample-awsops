import { describe, it, expect, vi } from 'vitest';

// Mock the node provider chain to static creds so the presign is deterministic + offline.
vi.mock('@aws-sdk/credential-providers', () => ({
  fromNodeProviderChain: () => async () => ({
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  }),
}));

import {
  eksToken,
  isKind,
  normalizeNode,
  normalizePod,
  normalizeDeployment,
  normalizeService,
  normalizeNamespace,
  normalizeEvent,
  normalizeEndpoint,
} from './eks-incluster';

describe('normalizeEndpoint', () => {
  it('flattens subsets[].addresses[].ip into the bucket of pod IPs backing the Service', () => {
    const r = normalizeEndpoint({
      metadata: { name: 'argocd-server', namespace: 'argocd' },
      subsets: [{ addresses: [{ ip: '10.2.37.47' }, { ip: '10.2.37.48' }] }, { addresses: [{ ip: '10.2.40.9' }] }],
    });
    expect(r).toEqual({ name: 'argocd-server', namespace: 'argocd', ips: ['10.2.37.47', '10.2.37.48', '10.2.40.9'] });
  });
  it('handles a headless/empty Endpoints object', () => {
    expect(normalizeEndpoint({ metadata: { name: 'svc', namespace: 'ns' } })).toEqual({ name: 'svc', namespace: 'ns', ips: [] });
  });
});

describe('eksToken', () => {
  it('produces a k8s-aws-v1. token whose payload is an STS presigned URL signing x-k8s-aws-id', async () => {
    const tok = await eksToken('fsi-demo-cluster', 'ap-northeast-2');
    expect(tok.startsWith('k8s-aws-v1.')).toBe(true);

    const payload = tok.slice('k8s-aws-v1.'.length);
    // base64url, no padding — must decode cleanly back to the URL.
    const url = Buffer.from(payload, 'base64url').toString('utf8');
    expect(url.startsWith('https://sts.ap-northeast-2.amazonaws.com/?')).toBe(true);

    const q = new URL(url).searchParams;
    expect(q.get('Action')).toBe('GetCallerIdentity');
    expect(q.get('Version')).toBe('2011-06-15');
    expect(q.get('X-Amz-Expires')).toBe('60');
    expect(q.get('X-Amz-Signature')).toBeTruthy();
    // x-k8s-aws-id MUST be a SIGNED header.
    expect((q.get('X-Amz-SignedHeaders') || '').split(';')).toContain('x-k8s-aws-id');
  });

  it('has no padding and is a single line', async () => {
    const tok = await eksToken('c', 'ap-northeast-2');
    expect(tok).not.toMatch(/=/);
    expect(tok).not.toMatch(/\s/);
  });
});

describe('isKind', () => {
  // ⚠️ PR #36: with AmazonEKSAdminViewPolicy (*/get,list,watch — Secrets readable) this
  // allow-list is the SINGLE line of defense. secrets rejection below is pinned (configmaps became
  // an allowed EXPLORER kind 2026-07-21 — METADATA-ONLY: the normalizer emits a key COUNT, never values)
  // intentionally — any new kind must extend this test + the eks.tf comment in the same PR.
  it('accepts the read-only kinds and rejects others', () => {
    for (const k of ['nodes', 'pods', 'deployments', 'services', 'namespaces']) expect(isKind(k)).toBe(true);
    for (const k of ['secrets', '', 'NODES', 'pods/exec']) expect(isKind(k)).toBe(false);
  });
});

describe('normalizers', () => {
  it('node: Ready condition + labels → flat row', () => {
    const row = normalizeNode({
      metadata: {
        name: 'ip-10-0-1-5',
        creationTimestamp: new Date(Date.now() - 3 * 86400_000).toISOString(),
        labels: {
          'node.kubernetes.io/instance-type': 'm6g.large',
          'topology.kubernetes.io/zone': 'ap-northeast-2a',
          'node-role.kubernetes.io/worker': '',
        },
      },
      status: {
        conditions: [{ type: 'MemoryPressure', status: 'False' }, { type: 'Ready', status: 'True' }],
        nodeInfo: { kubeletVersion: 'v1.30.0-eks-abc' },
      },
    });
    expect(row).toMatchObject({
      name: 'ip-10-0-1-5',
      status: 'Ready',
      roles: 'worker',
      version: 'v1.30.0-eks-abc',
      instanceType: 'm6g.large',
      zone: 'ap-northeast-2a',
      age: '3d',
    });
  });

  it('node: preserves labels, taints, and conditions for the node drilldown detail', () => {
    const row = normalizeNode({
      metadata: {
        name: 'ip-10-0-1-5',
        labels: {
          'node.kubernetes.io/instance-type': 'm6g.large',
          'topology.kubernetes.io/zone': 'ap-northeast-2a',
        },
      },
      spec: {
        taints: [{ key: 'dedicated', value: 'observability', effect: 'NoSchedule' }],
      },
      status: {
        conditions: [
          { type: 'MemoryPressure', status: 'False', reason: 'KubeletHasSufficientMemory' },
          { type: 'Ready', status: 'True', reason: 'KubeletReady', message: 'kubelet is posting ready status' },
        ],
      },
    });

    expect(row.labels).toEqual({
      'node.kubernetes.io/instance-type': 'm6g.large',
      'topology.kubernetes.io/zone': 'ap-northeast-2a',
    });
    expect(row.taints).toEqual([{ key: 'dedicated', value: 'observability', effect: 'NoSchedule' }]);
    expect(row.conditions).toEqual([
      { type: 'MemoryPressure', status: 'False', reason: 'KubeletHasSufficientMemory', message: '' },
      { type: 'Ready', status: 'True', reason: 'KubeletReady', message: 'kubelet is posting ready status' },
    ]);
  });

  it('node: missing Ready condition → NotReady, no labels at all → generic worker', () => {
    const row = normalizeNode({ metadata: { name: 'n', labels: {} }, status: { conditions: [] } });
    expect(row.status).toBe('NotReady');
    expect(row.roles).toBe('worker'); // EKS workers carry no node-role label — show a meaningful default
    // capacity/allocatable absent → 0
    expect(row.cpuAllocatable).toBe(0);
    expect(row.memAllocatable).toBe(0);
  });

  it('node roles fallback chain: nodegroup > karpenter > fargate (EKS signal instead of <none>)', () => {
    expect(normalizeNode({ metadata: { name: 'n', labels: { 'eks.amazonaws.com/nodegroup': 'ng-1' } }, status: { conditions: [] } }).roles).toBe('nodegroup:ng-1');
    expect(normalizeNode({ metadata: { name: 'n', labels: { 'karpenter.sh/nodepool': 'default' } }, status: { conditions: [] } }).roles).toBe('karpenter:default');
    expect(normalizeNode({ metadata: { name: 'n', labels: { 'eks.amazonaws.com/compute-type': 'fargate' } }, status: { conditions: [] } }).roles).toBe('fargate');
    // explicit node-role labels still win
    expect(normalizeNode({ metadata: { name: 'n', labels: { 'node-role.kubernetes.io/control-plane': '', 'eks.amazonaws.com/nodegroup': 'ng-1' } }, status: { conditions: [] } }).roles).toBe('control-plane');
  });

  it('node: parses capacity/allocatable cpu(cores) + memory(MiB)', () => {
    const row = normalizeNode({
      metadata: { name: 'n', labels: {} },
      status: { conditions: [{ type: 'Ready', status: 'True' }], capacity: { cpu: '4', memory: '8388608Ki' }, allocatable: { cpu: '3920m', memory: '7950Mi' } },
    });
    expect(row.cpuCapacity).toBe(4);
    expect(row.cpuAllocatable).toBeCloseTo(3.92);
    expect(row.memCapacity).toBe(8192); // 8388608Ki = 8192 MiB
    expect(row.memAllocatable).toBe(7950);
  });

  it('pod: sums container resource requests (cpu cores, mem MiB)', () => {
    const row = normalizePod({
      metadata: { name: 'p', namespace: 'd' },
      status: { phase: 'Running' },
      spec: { nodeName: 'n1', containers: [
        { resources: { requests: { cpu: '250m', memory: '256Mi' } } },
        { resources: { requests: { cpu: '500m', memory: '512Mi' } } },
      ] },
    });
    expect(row.cpuRequest).toBeCloseTo(0.75);
    expect(row.memRequest).toBe(768);
  });

  it('pod: phase + nodeName + summed restarts', () => {
    const row = normalizePod({
      metadata: { name: 'web-abc', namespace: 'default', creationTimestamp: new Date(Date.now() - 5 * 3600_000).toISOString() },
      status: { phase: 'Running', containerStatuses: [{ restartCount: 2 }, { restartCount: 3 }] },
      spec: { nodeName: 'ip-10-0-1-5' },
    });
    expect(row).toMatchObject({ name: 'web-abc', namespace: 'default', status: 'Running', node: 'ip-10-0-1-5', restarts: 5, age: '5h' });
  });

  it('deployment: ready as readyReplicas/spec.replicas + upToDate + available', () => {
    const row = normalizeDeployment({
      metadata: { name: 'api', namespace: 'prod' },
      spec: { replicas: 3 },
      status: { readyReplicas: 2, updatedReplicas: 3, availableReplicas: 2 },
    });
    expect(row).toMatchObject({ name: 'api', namespace: 'prod', ready: '2/3', upToDate: 3, available: 2 });
  });

  it('service: type + clusterIP + joined ports', () => {
    const row = normalizeService({
      metadata: { name: 'svc', namespace: 'default' },
      spec: { type: 'ClusterIP', clusterIP: '10.100.0.1', ports: [{ port: 80, protocol: 'TCP' }, { port: 443, protocol: 'TCP' }] },
    });
    expect(row).toMatchObject({ name: 'svc', namespace: 'default', type: 'ClusterIP', clusterIP: '10.100.0.1', ports: '80/TCP,443/TCP' });
  });

  it('namespace: name + phase', () => {
    const row = normalizeNamespace({ metadata: { name: 'kube-system' }, status: { phase: 'Active' } });
    expect(row).toMatchObject({ name: 'kube-system', status: 'Active' });
  });
});

describe('normalizeEvent', () => {
  it('maps a Warning event to EventRow with sortable timestamp', () => {
    const row = normalizeEvent({
      metadata: { namespace: 'default', creationTimestamp: '2026-06-11T00:00:00Z' },
      involvedObject: { kind: 'Pod', name: 'web-abc' },
      reason: 'BackOff', message: 'Back-off restarting failed container',
      count: 7, lastTimestamp: '2026-06-11T01:02:03Z', type: 'Warning',
    });
    expect(row.kind).toBe('Pod');
    expect(row.object).toBe('default/web-abc');
    expect(row.reason).toBe('BackOff');
    expect(row.count).toBe(7);
    expect(row.lastSeenTs).toBe(Date.parse('2026-06-11T01:02:03Z'));
    expect(row.lastSeen).toBeTruthy(); // compact age string
  });
  it('falls back count→1 and lastTimestamp→eventTime', () => {
    const row = normalizeEvent({
      metadata: { creationTimestamp: '2026-06-11T00:00:00Z' },
      involvedObject: { kind: 'Node', name: 'n1' },
      reason: 'X', message: 'm', eventTime: '2026-06-11T00:30:00Z',
    });
    expect(row.count).toBe(1);
    expect(row.object).toBe('n1'); // no namespace → name only
    expect(row.lastSeenTs).toBe(Date.parse('2026-06-11T00:30:00Z'));
  });
  it('prefers series.lastObservedTime over lastTimestamp (high-frequency events, P4: gemini)', () => {
    const row = normalizeEvent({
      metadata: { namespace: 'a', creationTimestamp: '2026-06-11T00:00:00Z' },
      involvedObject: { kind: 'Pod', name: 'p' }, reason: 'X', message: 'm',
      lastTimestamp: '2026-06-11T01:00:00Z',
      series: { lastObservedTime: '2026-06-11T02:00:00Z' },
    });
    expect(row.lastSeenTs).toBe(Date.parse('2026-06-11T02:00:00Z'));
  });
  it('pod: effective request = max(app sum, init max) + overhead (P4: codex)', () => {
    const row = normalizePod({
      metadata: { name: 'p', namespace: 'd' },
      status: { phase: 'Running' },
      spec: {
        nodeName: 'n1',
        containers: [{ resources: { requests: { cpu: '200m', memory: '256Mi' } } }],
        initContainers: [{ resources: { requests: { cpu: '1', memory: '128Mi' } } }],
        overhead: { cpu: '50m', memory: '64Mi' },
      },
    });
    expect(row.cpuRequest).toBeCloseTo(1.05); // max(0.2, 1) + 0.05
    expect(row.memRequest).toBe(320);         // max(256, 128) + 64
  });
  it('falls back to creationTimestamp when lastTimestamp/eventTime absent', () => {
    const row = normalizeEvent({
      metadata: { creationTimestamp: '2026-06-11T00:00:00Z' },
      involvedObject: { kind: 'Node', name: 'n1' }, reason: 'X', message: 'm',
    });
    expect(row.lastSeenTs).toBe(Date.parse('2026-06-11T00:00:00Z'));
  });
  it('events is a valid kind', () => { expect(isKind('events')).toBe(true); });
});
