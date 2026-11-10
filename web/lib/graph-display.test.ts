import { describe, expect, it } from 'vitest';
import { selectGraphPaths, serviceOverview } from './graph-display';

describe('display paths', () => {
  const graph = {
    nodes: ['igw', 'vpc-a', 'subnet-a', 'app', 'vpc-b', 'other'].map(id => ({ id })),
    edges: [
      { source: 'igw', target: 'vpc-a' }, { source: 'vpc-a', target: 'subnet-a' },
      { source: 'subnet-a', target: 'app' }, { source: 'igw', target: 'vpc-b' },
      { source: 'vpc-b', target: 'other' },
    ],
  };
  it('keeps upstream and downstream paths without expanding siblings through a shared gateway', () => {
    expect(selectGraphPaths(graph, ['subnet-a']).nodes.map(n => n.id)).toEqual(['igw', 'vpc-a', 'subnet-a', 'app']);
  });
  it('does not create edges or invent a path for an unknown selection', () => {
    expect(selectGraphPaths(graph, ['missing'])).toEqual({ nodes: [], edges: [] });
    expect(selectGraphPaths(graph, ['app'], 1).nodes.map(n => n.id)).toEqual(['subnet-a', 'app']);
  });
  it('keeps source-owned metadata and independent identities with identical names', () => {
    const a = { id: 'a', kind: 'service', label: 'orders', meta: { sourceId: 'one' } };
    const b = { id: 'b', kind: 'service', label: 'orders', meta: { sourceId: 'two' } };
    const workload = { id: 'w', kind: 'workload', label: 'shop/orders', meta: {} };
    const input = { nodes: [a, b, workload], edges: [{ source: 'a', target: 'w', rel: 'runs_on' }] };
    expect(serviceOverview(input, false).nodes).toEqual([a, b]);
    expect(serviceOverview(input, true)).toBe(input);
    expect(input.nodes).toHaveLength(3);
  });
  it('keeps a workload that is an endpoint of an observed call', () => {
    const input = {
      nodes: [{ id: 'a', kind: 'service' }, { id: 'w', kind: 'workload' }],
      edges: [{ source: 'a', target: 'w', rel: 'calls' }],
    };
    expect(serviceOverview(input, false)).toEqual(input);
  });
});
