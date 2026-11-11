import { describe, expect, it } from 'vitest';
import { infraGraphPage } from './infra-graph-display';

const nodes = [
  { id: 'v1', kind: 'vpc', label: 'primary' },
  { id: 'v2', kind: 'vpc', label: 'secondary' },
  { id: 's1', kind: 'subnet', label: 'subnet' },
  { id: 'sg', kind: 'sg', label: 'shared' },
  ...Array.from({ length: 20 }, (_, i) => ({ id: `r${i}`, kind: 'ec2', label: `instance-${i}` })),
  { id: 'db', kind: 'rds', label: 'orders' },
];
const edges = [
  ...Array.from({ length: 20 }, (_, i) => [
    { source: `r${i}`, target: i < 16 ? 'v1' : 'v2', rel: 'infra:in_vpc' },
    { source: `r${i}`, target: 's1', rel: 'infra:in_subnet' },
    { source: `r${i}`, target: 'sg', rel: 'infra:uses_sg' },
  ]).flat(),
  { source: 'db', target: 'v1', rel: 'infra:in_vpc' },
];
const graph = { nodes, edges };

describe('readable infra graph pages', () => {
  it('shows four resources and their placement without expanding siblings through a shared SG or subnet', () => {
    const page = infraGraphPage(graph, { vpc: 'v1' });
    expect(page.totalResources).toBe(17);
    expect(page.resources).toHaveLength(4);
    expect(page.nodes).toHaveLength(6); // four resources + VPC + subnet; SG is opt-in
    expect(page.nodes.some(n => n.id === 'v2' || n.id === 'sg')).toBe(false);
    expect(page.edges.every(e => page.nodes.some(n => n.id === e.source) && page.nodes.some(n => n.id === e.target))).toBe(true);
  });
  it('paginates without duplicating or dropping eligible resources', () => {
    const pages = [0, 1, 2, 3, 4].map(page => infraGraphPage(graph, { vpc: 'v1', page }));
    expect(new Set(pages.flatMap(p => p.resources.map(n => n.id))).size).toBe(17);
    expect(pages.map(p => p.resources.length)).toEqual([4, 4, 4, 4, 1]);
    expect(infraGraphPage(graph, { vpc: 'v1', page: 999 }).page).toBe(4);
  });
  it('keeps narrow-screen pages complete and bounds an invalid requested size', () => {
    const pages = Array.from({ length: 17 }, (_, page) => infraGraphPage(graph, { vpc: 'v1', page, pageSize: 1 }));
    expect(new Set(pages.flatMap(p => p.resources.map(n => n.id))).size).toBe(17);
    expect(pages.every(p => p.resources.length === 1)).toBe(true);
    expect(infraGraphPage(graph, { pageSize: 500 }).resources).toHaveLength(4);
    expect(infraGraphPage(graph, { pageSize: 0 }).resources).toHaveLength(1);
    expect(infraGraphPage(graph, { pageSize: Number.NaN }).resources).toHaveLength(4);
  });
  it('searches before pagination and retains the matched resource context', () => {
    const page = infraGraphPage(graph, { vpc: 'v1', query: 'instance-15', showSecurityGroups: true });
    expect(page.resources.map(n => n.id)).toEqual(['r15']);
    expect(page.nodes.map(n => n.id).sort()).toEqual(['r15', 's1', 'sg', 'v1']);
    expect(page.edges).toHaveLength(3);
  });
  it('filters by subnet and resource type using saved relations', () => {
    expect(infraGraphPage(graph, { vpc: 'v1', subnet: 's1', kind: 'rds' }).resources).toEqual([]);
    expect(infraGraphPage(graph, { vpc: 'v1', kind: 'rds' }).resources.map(n => n.id)).toEqual(['db']);
  });
  it('keeps resources without a VPC available in the all-scopes view', () => {
    const missing = { nodes: [...nodes, { id: 'unknown', kind: 'ec2', label: 'unplaced' }], edges };
    expect(infraGraphPage(missing, { query: 'unplaced' }).resources.map(n => n.id)).toEqual(['unknown']);
  });
  it('does not change original nodes, edge metadata or collection evidence', () => {
    const evidence = { ...graph, collection: { status: 'partial' } };
    const before = JSON.stringify(evidence);
    const page = infraGraphPage(evidence, { showSecurityGroups: true });
    expect(page.nodes.every(n => nodes.includes(n))).toBe(true);
    expect(page.edges.every(e => edges.includes(e))).toBe(true);
    expect(JSON.stringify(evidence)).toBe(before);
  });
});
