import { describe, expect, it } from 'vitest';
import { selectableVpcKey, toFlowElements } from './NetworkDiagram';
import { buildNetworkTopology } from '@/lib/network-topology';
import type { NetRow } from '@/lib/network-topology-types';

const A = '111111111111', B = '222222222222', R = 'ap-northeast-2';
const row = (resource_type: string, account_id: string, resource_id: string, data: Record<string, unknown>): NetRow =>
  ({ resource_type, account_id, region: R, resource_id, data });
const rows = [
  row('vpc', 'self', 'vpc-aaaaaaaa', { owner_id: A, name: 'hub' }),
  row('vpc', B, 'vpc-bbbbbbbb', { owner_id: B, name: 'spoke' }),
  row('vpc', B, 'vpc-dddddddd', { owner_id: B, name: 'peer' }),
  row('transit_gateway_attachment', 'self', 'tgw-attach-0000000000000000a', { transit_gateway_id: 'tgw-0123456789abcdef0',
    transit_gateway_owner_id: A, resource_type: 'vpc', resource_id: 'vpc-aaaaaaaa', resource_owner_id: A, state: 'available' }),
  row('transit_gateway_attachment', 'self', 'tgw-attach-0000000000000000b', { transit_gateway_id: 'tgw-0123456789abcdef0',
    transit_gateway_owner_id: A, resource_type: 'vpc', resource_id: 'vpc-bbbbbbbb', resource_owner_id: B, state: 'available' }),
  row('vpc_peering_connection', B, 'pcx-11111111', { status_code: 'active', requester_owner_id: B, requester_region: R,
    requester_vpc_id: 'vpc-bbbbbbbb', accepter_owner_id: B, accepter_region: R, accepter_vpc_id: 'vpc-dddddddd' }),
];
const topology = buildNetworkTopology(rows, { hostAccountId: A, aliases: {}, selection: { accounts: [A], vpcs: [] } });

describe('NetworkDiagram elements', () => {
  const { nodes, edges } = toFlowElements(topology, 'light');

  it('nests children under their parent boxes and keeps parents first', () => {
    const vpc = nodes.find((n) => n.id === `vpc:${A}/${R}/vpc-aaaaaaaa`)!;
    expect(vpc.parentId).toBe(`region:${A}/${R}`);
    expect(vpc.extent).toBe('parent');
    const index = new Map(nodes.map((n, i) => [n.id, i]));
    for (const n of nodes) if (n.parentId) expect(index.get(n.parentId)!).toBeLessThan(index.get(n.id)!);
    expect(nodes.find((n) => n.id === `account:${A}`)!.type).toBe('netGroup');
  });

  it('styles cross-account TGW edges thicker and peering edges dashed', () => {
    const cross = edges.find((e) => e.id === 'edge:tgw:tgw-attach-0000000000000000b')!;
    const local = edges.find((e) => e.id === 'edge:tgw:tgw-attach-0000000000000000a')!;
    expect(cross.style?.strokeWidth).toBe(2.5);
    expect(local.style?.strokeWidth).toBe(1.5);
    expect(cross.style?.stroke).toBe('#8C4FFF');
    expect(edges.some((e) => e.id === 'edge:pcx:pcx-11111111')).toBe(false); // both ends out of scope
  });

  it('maps clicks on VPCs and external stubs to their vpcKey, and ignores other kinds', () => {
    const external = nodes.find((n) => n.id.startsWith('external:'))!;
    expect(selectableVpcKey(external)).toBe(`${B}/${R}/vpc-bbbbbbbb`);
    expect(selectableVpcKey(nodes.find((n) => n.id === `vpc:${A}/${R}/vpc-aaaaaaaa`)!)).toBe(`${A}/${R}/vpc-aaaaaaaa`);
    expect(selectableVpcKey(nodes.find((n) => n.id.startsWith('tgw:'))!)).toBeNull();
  });

  it('renders dashed peering edges when a peering end is in scope', () => {
    const all = buildNetworkTopology(rows, { hostAccountId: A, aliases: {}, selection: { accounts: '__all__', vpcs: [] } });
    const pcx = toFlowElements(all, 'dark').edges.find((e) => e.id === 'edge:pcx:pcx-11111111')!;
    expect(pcx.style?.strokeDasharray).toBe('6 4');
    expect(pcx.style?.stroke).toBe('#00A4A6');
  });
});
