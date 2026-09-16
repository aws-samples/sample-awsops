import { describe, expect, it } from 'vitest';
import type { VpcConnectivity } from './vpc-connectivity-types';
import { buildVpcConnectionGraph, type VpcConnectionGraph } from './vpc-connection-graph';

const ACCOUNT = '111111111111', OTHER = '222222222222', REGION = 'us-east-1';
const source = { vpcId: 'vpc-source', accountId: ACCOUNT, ownerId: ACCOUNT, region: REGION, name: 'Selected VPC' };
type Peering = VpcConnectivity['peerings'][number];
type Gateway = VpcConnectivity['transitGateways'][number];
const pcx = (id: string, peer: Partial<Peering['peer']> = {}, state = 'active'): Peering => ({
  id, state, peer: { vpcId: 'vpc-peer', accountId: ACCOUNT, region: REGION, cidr: null, ...peer },
});
const attachment = (attachmentId: string, overrides: Partial<Gateway['peers'][number]> = {}): Gateway['peers'][number] => ({
  attachmentId, vpcId: `vpc-${attachmentId}`, accountId: ACCOUNT, state: 'available',
  routeTableId: 'tgw-rtb-peer', associationState: 'associating', ...overrides,
});
const tgw = (peers: Gateway['peers'] = [], overrides: Partial<Gateway> = {}): Gateway => ({
  id: 'tgw-1', attachmentId: 'attach-source', state: 'available',
  routeTableId: 'tgw-rtb-source', associationState: 'associated', peers, ...overrides,
});
const data = (peerings: Peering[] = [], transitGateways: Gateway[] = []): VpcConnectivity => ({
  source: { ...source }, checkedAt: '2026-09-16T00:00:00Z', peerings, transitGateways,
  limitations: [], incompleteSources: [],
});
function connected(graph: VpcConnectionGraph) {
  expect(graph.nodes.filter(n => n.source)).toHaveLength(1);
  const ids = new Set(graph.nodes.map(n => n.id));
  expect(ids.size).toBe(graph.nodes.length);
  expect(new Set(graph.edges.map(e => e.id)).size).toBe(graph.edges.length);
  const reached = new Set([graph.nodes[0].id]);
  for (const edge of graph.edges) {
    expect(ids.has(edge.source) && ids.has(edge.target)).toBe(true);
  }
  for (let i = 0; i < graph.nodes.length; i++) for (const edge of graph.edges) {
    if (reached.has(edge.source) || reached.has(edge.target)) {
      reached.add(edge.source); reached.add(edge.target);
    }
  }
  expect(reached.size).toBe(ids.size);
  for (const node of graph.nodes.filter(n => n.kind === 'peering')) {
    expect(graph.edges.filter(e => e.source === node.id || e.target === node.id)).toHaveLength(2);
  }
}

describe('buildVpcConnectionGraph configuration records', () => {
  it('always starts with the selected VPC, even without records', () => {
    const graph = buildVpcConnectionGraph(data());
    expect(graph.nodes).toEqual([expect.objectContaining({
      kind: 'vpc', label: 'Selected VPC', accountId: ACCOUNT, region: REGION, source: true,
      details: expect.objectContaining({ vpcId: 'vpc-source', ownerId: ACCOUNT }),
    })]);
    expect(graph.edges).toEqual([]);
    expect(graph.omitted).toEqual({ inactive: 0, unresolved: 0, capped: 0 });
  });

  it('builds exactly three VPCs, one TGW and three attachment edges without inventing TGW ownership', () => {
    const graph = buildVpcConnectionGraph(data([], [tgw([attachment('a'), attachment('b')])]));
    expect(graph.nodes.map(n => n.kind).sort()).toEqual(['tgw', 'vpc', 'vpc', 'vpc']);
    expect(graph.edges.map(e => [e.kind, e.recordId]).sort()).toEqual([
      ['tgw', 'a'], ['tgw', 'attach-source'], ['tgw', 'b'],
    ]);
    expect(graph.nodes.find(n => n.kind === 'tgw')).toMatchObject({
      accountId: null, region: REGION, details: {
        queryAccountId: ACCOUNT, transitGatewayId: 'tgw-1',
        'a.attachmentId': 'a',
        'a.routeTableId': 'tgw-rtb-peer', 'a.associationState': 'associating', 'a.state': 'available',
        'attach-source.routeTableId': 'tgw-rtb-source', 'attach-source.associationState': 'associated',
      },
    });
    connected(graph);
  });

  it('builds active peering through a PCX node and reuses a fully scoped VPC across TGWs', () => {
    const graph = buildVpcConnectionGraph(data([pcx('pcx-1')], [
      tgw([attachment('a', { vpcId: 'vpc-peer' })]),
      tgw([attachment('b', { vpcId: 'vpc-peer' })], { id: 'tgw-2', attachmentId: 'attach-source-2' }),
    ]));
    expect(graph.nodes.filter(n => n.kind === 'vpc')).toHaveLength(2);
    const peering = graph.nodes.find(n => n.kind === 'peering')!;
    const peer = graph.nodes.find(n => n.details.vpcId === 'vpc-peer')!;
    expect(peering.details).toMatchObject({ peeringId: 'pcx-1', state: 'active' });
    expect(graph.edges.filter(e => e.kind === 'peering')).toEqual([
      expect.objectContaining({ source: graph.nodes[0].id, target: peering.id, recordId: 'pcx-1' }),
      expect.objectContaining({ source: peering.id, target: peer.id, recordId: 'pcx-1' }),
    ]);
    connected(graph);
  });

  it('keeps identical VPC IDs in different accounts and regions distinct', () => {
    const graph = buildVpcConnectionGraph(data([
      pcx('pcx-a'), pcx('pcx-b', { accountId: OTHER }), pcx('pcx-c', { region: 'eu-west-1' }),
    ], [tgw([attachment('a', { vpcId: 'vpc-peer' }), attachment('b', { vpcId: 'vpc-peer', accountId: OTHER })])]));
    expect(graph.nodes.filter(n => !n.source && n.kind === 'vpc').map(n => [n.accountId, n.region])).toEqual([
      [ACCOUNT, REGION], [OTHER, REGION], [ACCOUNT, 'eu-west-1'],
    ]);
  });

  it('uses disclosed source ownership, but isolates an unknown-owner source from known peer identity', () => {
    const input = data([pcx('pcx-a', { vpcId: source.vpcId })]);
    input.source.ownerId = OTHER;
    const owned = buildVpcConnectionGraph(input);
    expect(owned.nodes[0].accountId).toBe(OTHER);
    expect(owned.nodes.filter(n => n.kind === 'vpc')).toHaveLength(2);
    input.source.ownerId = null;
    const unknown = buildVpcConnectionGraph(input);
    expect(unknown.nodes[0]).toMatchObject({ accountId: ACCOUNT, details: { ownerId: null } });
    expect(unknown.nodes.filter(n => n.kind === 'vpc')).toHaveLength(2);
    expect(new Set(unknown.nodes.map(n => n.id)).size).toBe(3);
  });

  it('shows incomplete peers as record-specific unknowns without merging by VPC ID', () => {
    const graph = buildVpcConnectionGraph(data([
      pcx('pcx-a', { accountId: null }), pcx('pcx-b', { region: null }),
      pcx('pcx-c', { vpcId: null }), pcx('pcx-d', { accountId: null }),
      pcx('pcx-known'),
    ], [tgw([attachment('a', { vpcId: 'vpc-peer', accountId: null }), attachment('b', { vpcId: 'vpc-peer', accountId: null })])]));
    expect(graph.nodes.filter(n => n.kind === 'unknown')).toHaveLength(6);
    expect(graph.nodes.find(n => n.kind === 'unknown' && n.details.vpcId === null)?.label).toBe('pcx-c');
    expect(graph.nodes.filter(n => n.kind === 'vpc')).toHaveLength(2);
    expect(graph.omitted.unresolved).toBe(6);
    connected(graph);
  });

  it('omits inactive peerings and entire unavailable TGW groups, and counts inactive peer attachments', () => {
    const graph = buildVpcConnectionGraph(data(
      ['pending-acceptance', 'deleted', 'rejected', 'failed'].map(state => pcx(`pcx-${state}`, {}, state)),
      [tgw([attachment('hidden')], { state: 'pending' }),
        tgw([attachment('inactive', { state: 'deleting' })], { id: 'tgw-2', attachmentId: 'source-2' })],
    ));
    expect(graph.nodes.map(n => n.kind)).toEqual(['vpc', 'tgw']);
    expect(graph.edges.map(e => e.recordId)).toEqual(['source-2']);
    expect(graph.omitted).toEqual({ inactive: 6, unresolved: 0, capped: 0 });
    connected(graph);
  });

  it('scopes TGW identity to the query account and region, independently of source owner disclosure', () => {
    const input = data([], [tgw()]);
    const first = buildVpcConnectionGraph(input).nodes[1];
    input.source.accountId = OTHER;
    const second = buildVpcConnectionGraph(input).nodes[1];
    input.source.region = 'eu-west-1';
    const third = buildVpcConnectionGraph(input).nodes[1];
    expect(new Set([first.id, second.id, third.id]).size).toBe(3);
    expect([first.accountId, second.accountId, third.accountId]).toEqual([null, null, null]);
  });

  it('withholds conflicting PCX claims even if a later duplicate repeats the original', () => {
    const graph = buildVpcConnectionGraph(data([
      pcx('pcx-bad'), pcx('pcx-bad', { accountId: OTHER }), pcx('pcx-bad'),
      pcx('pcx-state'), pcx('pcx-state', {}, 'deleted'), pcx('pcx-good'),
    ]));
    expect(graph.edges.map(e => e.recordId)).toEqual(['pcx-good', 'pcx-good']);
    expect(graph.omitted).toEqual({ inactive: 0, unresolved: 2, capped: 0 });
    connected(graph);
  });

  it.each([
    { vpcId: 'vpc-disputed' }, { accountId: OTHER }, { state: 'deleting' },
    { routeTableId: 'tgw-rtb-disputed' }, { associationState: 'disassociated' },
  ])('withholds an attachment with conflicting claims: %j', change => {
    const graph = buildVpcConnectionGraph(data([], [tgw([
      attachment('bad'), attachment('bad', change), attachment('bad'), attachment('good'),
    ])]));
    expect(graph.edges.map(e => e.recordId)).toEqual(['attach-source', 'good']);
    expect(graph.omitted.unresolved).toBe(1);
    connected(graph);
  });

  it('withholds an attachment claimed by different gateways', () => {
    const graph = buildVpcConnectionGraph(data([], [
      tgw([attachment('bad')]),
      tgw([attachment('bad')], { id: 'tgw-2', attachmentId: 'source-2' }),
    ]));
    expect(graph.edges.map(e => e.recordId)).toEqual(['attach-source', 'source-2']);
    expect(graph.omitted.unresolved).toBe(1);
  });

  it('suppresses an entire group when its source attachment conflicts with a peer claim', () => {
    const graph = buildVpcConnectionGraph(data([], [tgw([attachment('attach-source'), attachment('other')])]));
    expect(graph.nodes).toHaveLength(1);
    expect(graph.edges).toEqual([]);
    expect(graph.omitted.unresolved).toBe(1);
  });

  it('deduplicates records and omission counts while retaining peers from duplicate group rows', () => {
    const missing = pcx('pcx-missing', { accountId: null });
    const inactive = pcx('pcx-inactive', {}, 'pending');
    const graph = buildVpcConnectionGraph(data([missing, inactive, missing, inactive], [
      tgw([attachment('a', { accountId: null })]), tgw([attachment('b'), attachment('a', { accountId: null })]),
    ]));
    expect(graph.edges).toHaveLength(5);
    expect(graph.omitted).toEqual({ inactive: 1, unresolved: 2, capped: 0 });
    connected(graph);
  });

  it('caps nodes by complete paths and reserves small connections before large TGW expansions', () => {
    const input = data([pcx('pcx-small')], [tgw(Array.from({ length: 300 }, (_, i) => attachment(`a-${i}`)))]);
    const before = structuredClone(input);
    const graph = buildVpcConnectionGraph(input);
    expect(graph.nodes).toHaveLength(300);
    expect(graph.edges.filter(e => e.recordId === 'pcx-small')).toHaveLength(2);
    expect(graph.edges).toHaveLength(299);
    expect(graph.omitted.capped).toBe(4);
    expect(input).toEqual(before);
    connected(graph);
    const reversed = structuredClone(input);
    reversed.peerings.reverse(); reversed.transitGateways.reverse();
    reversed.transitGateways.forEach(g => g.peers.reverse());
    expect(buildVpcConnectionGraph(reversed)).toEqual(graph);
  });

  it('never leaves half a peering at the node cap, and keeps source TGW links', () => {
    const graph = buildVpcConnectionGraph(data(
      Array.from({ length: 200 }, (_, i) => pcx(`pcx-${i}`, { vpcId: `vpc-${i}` })), [tgw()],
    ));
    expect(graph.nodes).toHaveLength(300);
    expect(graph.edges).toHaveLength(299);
    expect(graph.edges.some(e => e.recordId === 'attach-source')).toBe(true);
    expect(graph.omitted.capped).toBe(51);
    connected(graph);
  });

  it('caps edges atomically and still admits a smaller path after larger paths no longer fit', () => {
    const input = data(Array.from({ length: 251 }, (_, i) => pcx(`pcx-${i}`)),
      [tgw([attachment('small', { vpcId: 'vpc-peer' })])]);
    const graph = buildVpcConnectionGraph(input);
    expect(graph.nodes).toHaveLength(252);
    expect(graph.edges).toHaveLength(500);
    expect(graph.edges.filter(e => e.kind === 'peering')).toHaveLength(498);
    expect(graph.edges.some(e => e.recordId === 'small')).toBe(true);
    expect(graph.omitted.capped).toBe(2);
    connected(graph);
    input.peerings.reverse();
    expect(buildVpcConnectionGraph(input)).toEqual(graph);
  });
});
