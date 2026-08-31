import { describe, it, expect } from 'vitest';
import { buildK8sMap, type K8sMapInput } from './k8s-map';
import { highlightClosure } from './infra-map';

const base = (): K8sMapInput => ({
  ingresses: [{ name: 'web', namespace: 'prod', className: 'alb', lbHostname: 'k8s-x.elb.amazonaws.com', backends: [{ service: 'web-svc', port: '8080' }], age: '1h' }],
  services: [
    { name: 'web-svc', namespace: 'prod', type: 'ClusterIP', clusterIP: '172.20.0.10', ports: '8080/TCP', age: '1h' },
    { name: 'web-svc', namespace: 'dev', type: 'ClusterIP', clusterIP: '172.20.9.9', ports: '8080/TCP', age: '1h' },
  ],
  pods: [
    { name: 'web-1', namespace: 'prod', status: 'Running', node: 'node-a', restarts: 0, age: '1h', cpuRequest: 0, memRequest: 0, diskRequest: 0, podIP: '10.0.2.10' },
    { name: 'lonely', namespace: 'prod', status: 'Pending', node: '', restarts: 0, age: '1m', cpuRequest: 0, memRequest: 0, diskRequest: 0 },
  ],
  nodes: [{ name: 'node-a', status: 'Ready', roles: '', version: 'v1.31', instanceType: 'm7g.large', zone: 'apne2-a', age: '9d', cpuCapacity: 4, cpuAllocatable: 4, memCapacity: 16384, memAllocatable: 15000, diskCapacity: 0, diskAllocatable: 0 }],
  endpoints: [{ name: 'web-svc', namespace: 'prod', ips: ['10.0.2.10'], targets: [{ ip: '10.0.2.10', pod: 'web-1' }] }],
});

describe('buildK8sMap', () => {
  it('assigns 4 columns and namespaced ids', () => {
    const g = buildK8sMap(base());
    const col = (id: string) => g.nodes.find((n) => n.id === id)?.column;
    expect(col('ing:prod/web')).toBe(0);
    expect(col('svc:prod/web-svc')).toBe(1);
    expect(col('pod:prod/web-1')).toBe(2);
    expect(col('node:node-a')).toBe(3);
  });

  it('draws ingress→service, service→pod (endpoints IP join), pod→node edges', () => {
    const g = buildK8sMap(base());
    const has = (s: string, t: string) => g.edges.some((e) => e.source === s && e.target === t);
    expect(has('ing:prod/web', 'svc:prod/web-svc')).toBe(true);
    expect(has('svc:prod/web-svc', 'pod:prod/web-1')).toBe(true);
    expect(has('pod:prod/web-1', 'node:node-a')).toBe(true);
  });

  it('does not cross-join same-name services in different namespaces', () => {
    const g = buildK8sMap(base());
    expect(g.edges.some((e) => e.source === 'ing:prod/web' && e.target === 'svc:dev/web-svc')).toBe(false);
    expect(g.edges.some((e) => e.source === 'svc:dev/web-svc')).toBe(false); // no prod-IP leakage
  });

  it('keeps pods with no service or node (rendered edge-less)', () => {
    const g = buildK8sMap(base());
    expect(g.nodes.some((n) => n.id === 'pod:prod/lonely')).toBe(true);
    expect(g.edges.some((e) => e.target === 'pod:prod/lonely' || e.source === 'pod:prod/lonely')).toBe(false);
  });

  it('closure highlight walks the full 4-column chain', () => {
    const g = buildK8sMap(base());
    const hl = highlightClosure(g, 'svc:prod/web-svc');
    for (const id of ['ing:prod/web', 'pod:prod/web-1', 'node:node-a']) expect(hl.has(id)).toBe(true);
    expect(hl.has('pod:prod/lonely')).toBe(false);
  });

  it('draws one ingress→service edge even for multi-port backends', () => {
    const input = base();
    input.ingresses[0].backends = [{ service: 'web-svc', port: '8080' }, { service: 'web-svc', port: '9090' }];
    const g = buildK8sMap(input);
    expect(g.edges.filter((e) => e.source === 'ing:prod/web' && e.target === 'svc:prod/web-svc')).toHaveLength(1);
  });

  it('joins service→pod by targetRef, not by shared IP', () => {
    const input = base();
    // two hostNetwork pods sharing one node IP; targetRef names only web-1
    input.pods.push({ name: 'host-2', namespace: 'prod', status: 'Running', node: 'node-a', restarts: 0, age: '1h', cpuRequest: 0, memRequest: 0, diskRequest: 0, podIP: '10.0.2.10' });
    const g = buildK8sMap(input);
    expect(g.edges.some((e) => e.source === 'svc:prod/web-svc' && e.target === 'pod:prod/web-1')).toBe(true);
    expect(g.edges.some((e) => e.target === 'pod:prod/host-2')).toBe(false);
    expect(g.nodes.find((n) => n.id === 'svc:prod/web-svc')?.badge).toContain('1 pod');
  });

  it('falls back to the IP join only when the IP maps to exactly one pod', () => {
    const input = base();
    input.endpoints = [{ name: 'web-svc', namespace: 'prod', ips: ['10.0.2.10'], targets: [{ ip: '10.0.2.10', pod: undefined }] }];
    const g = buildK8sMap(input);
    expect(g.edges.some((e) => e.source === 'svc:prod/web-svc' && e.target === 'pod:prod/web-1')).toBe(true);
    // ambiguous shared IP → no edge, no guess
    input.pods.push({ name: 'host-2', namespace: 'prod', status: 'Running', node: 'node-a', restarts: 0, age: '1h', cpuRequest: 0, memRequest: 0, diskRequest: 0, podIP: '10.0.2.10' });
    const g2 = buildK8sMap(input);
    expect(g2.edges.some((e) => e.source === 'svc:prod/web-svc' && e.target === 'pod:prod/web-1')).toBe(false);
    expect(g2.nodes.find((n) => n.id === 'svc:prod/web-svc')?.badge).toContain('0 pods');
  });

  it('carries useful card fields (status/badge/sub)', () => {
    const g = buildK8sMap(base());
    const node = (id: string) => g.nodes.find((n) => n.id === id)!;
    expect(node('ing:prod/web').sub).toContain('k8s-x.elb.amazonaws.com');
    expect(node('svc:prod/web-svc').sub).toContain('172.20.0.10');
    expect(node('svc:prod/web-svc').badge).toContain('1 pod'); // matched pod count (v1 parity)
    expect(node('pod:prod/web-1').status).toBe('ok'); // Running
    expect(node('pod:prod/lonely').status).toBe('warn'); // Pending
    expect(node('node:node-a').status).toBe('ok'); // Ready
    expect(node('node:node-a').badge).toContain('1 pod'); // pod count
  });
});
