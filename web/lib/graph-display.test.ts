import { describe, expect, it } from 'vitest';
import { selectGraphPaths, serviceOverview, boundGraphDisplay } from './graph-display';

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

it('bounds edges with endpoints before optional nodes and reports independent omissions', () => {
 const graph = { nodes: Array.from({length:400}, (_,i)=>({id:String(i),meta:{sourceId:'original'}})),
   edges: Array.from({length:399}, (_,i)=>({source:String(i),target:String(i+1)})) };
 const result = boundGraphDisplay(graph);
 expect(result.nodes).toHaveLength(350);
 expect(result.edges).toHaveLength(349);
 expect(result.omitted).toEqual({nodes:50,edges:50});
 const ids=new Set(result.nodes.map(n=>n.id));
 expect(result.edges.every(e=>ids.has(e.source)&&ids.has(e.target))).toBe(true);
 expect(result.nodes[0]).toBe(graph.nodes[0]);
 expect(graph.nodes).toHaveLength(400);
 const manyEdges={nodes:graph.nodes.slice(0,3),edges:Array.from({length:801},()=>({source:'0',target:'1'}))};
 expect(boundGraphDisplay(manyEdges).omitted).toEqual({nodes:0,edges:101});
});
