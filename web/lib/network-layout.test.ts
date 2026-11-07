import { describe, expect, it } from 'vitest';
import { layoutNetwork, type Placed } from './network-layout';
import { buildNetworkTopology } from './network-topology';
import type { NetRow, NetworkTopology } from './network-topology-types';

const A = '111111111111', B = '222222222222', R = 'ap-northeast-2';
const row = (resource_type: string, account_id: string, resource_id: string, data: Record<string, unknown>): NetRow =>
  ({ resource_type, account_id, region: R, resource_id, data });
const rows: NetRow[] = [
  row('vpc', 'self', 'vpc-aaaaaaaa', { owner_id: A, name: 'hub' }),
  row('vpc', 'self', 'vpc-cccccccc', { owner_id: A, name: 'shared-svc' }),
  row('vpc', B, 'vpc-bbbbbbbb', { owner_id: B, name: 'spoke' }),
  row('transit_gateway', 'self', 'tgw-0123456789abcdef0', { owner_id: A }),
  row('transit_gateway_attachment', 'self', 'tgw-attach-0000000000000000a', { transit_gateway_id: 'tgw-0123456789abcdef0',
    transit_gateway_owner_id: A, attached_resource_type: 'vpc', attached_resource_id: 'vpc-aaaaaaaa', resource_owner_id: A, state: 'available' }),
  row('transit_gateway_attachment', 'self', 'tgw-attach-0000000000000000b', { transit_gateway_id: 'tgw-0123456789abcdef0',
    transit_gateway_owner_id: A, attached_resource_type: 'vpc', attached_resource_id: 'vpc-bbbbbbbb', resource_owner_id: B, state: 'available' }),
  ...['a', 'c'].flatMap((az) => [1, 2].map((n) => row('subnet', 'self', `subnet-${az}${n}`,
    { vpc_id: 'vpc-aaaaaaaa', availability_zone: `${R}${az}`, name: `${az}${n}` }))),
  ...Array.from({ length: 5 }, (_, i) => row('ec2', 'self', `i-${i}`, { vpc_id: 'vpc-aaaaaaaa', subnet_id: 'subnet-a1', name: `web-${i}` })),
  row('internet_gateway', 'self', 'igw-1', { attachments: [{ VpcId: 'vpc-aaaaaaaa' }] }),
];
const opts = (vpcs: string[], accounts: string[] | '__all__' = '__all__') =>
  ({ hostAccountId: A, aliases: {}, selection: { accounts, vpcs } });
const fleet = buildNetworkTopology(rows, opts([]));
const scoped = buildNetworkTopology(rows, opts([], [A]));
const detail = buildNetworkTopology(rows, opts([`${A}/${R}/vpc-aaaaaaaa`]));

function check(t: NetworkTopology) {
  const placed = layoutNetwork(t);
  return { placed, byId: new Map(placed.map((p) => [p.id, p])) };
}
const overlap = (a: Placed, b: Placed) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

describe('layoutNetwork', () => {
  for (const [name, t] of [['fleet', fleet], ['scoped', scoped], ['detail', detail]] as const) {
    it(`places every child inside its parent (${name})`, () => {
      const { placed, byId } = check(t);
      expect(placed.map((p) => p.id)).toEqual(t.nodes.map((n) => n.id));
      for (const p of placed) {
        if (!p.parentId) continue;
        const parent = byId.get(p.parentId)!;
        expect(p.x, p.id).toBeGreaterThanOrEqual(0);
        expect(p.y, p.id).toBeGreaterThanOrEqual(0);
        expect(p.x + p.width, p.id).toBeLessThanOrEqual(parent.width);
        expect(p.y + p.height, p.id).toBeLessThanOrEqual(parent.height);
      }
    });

    it(`does not overlap siblings (${name})`, () => {
      const { placed } = check(t);
      const groups = new Map<string, Placed[]>();
      for (const p of placed) groups.set(p.parentId ?? '', [...(groups.get(p.parentId ?? '') ?? []), p]);
      for (const siblings of groups.values()) {
        for (let i = 0; i < siblings.length; i++) {
          for (let j = i + 1; j < siblings.length; j++) {
            expect(overlap(siblings[i], siblings[j]), `${siblings[i].id} × ${siblings[j].id}`).toBe(false);
          }
        }
      }
    });
  }

  it('is deterministic', () => {
    expect(layoutNetwork(detail)).toEqual(layoutNetwork(detail));
  });

  it('puts out-of-scope stubs above account boxes', () => {
    const { placed } = check(scoped);
    const top = placed.filter((p) => !p.parentId);
    const stubs = top.filter((p) => p.id.startsWith('external:') || p.id.startsWith('tgw:'));
    const accounts = top.filter((p) => p.id.startsWith('account:'));
    expect(stubs.length).toBeGreaterThan(0);
    const bandBottom = Math.max(...stubs.map((p) => p.y + p.height));
    expect(bandBottom).toBeLessThanOrEqual(Math.min(...accounts.map((p) => p.y)));
  });

  it('lays AZ columns left to right inside a detail VPC', () => {
    const { byId } = check(detail);
    const a = byId.get(`az:${A}/${R}/vpc-aaaaaaaa/${R}a`)!, c = byId.get(`az:${A}/${R}/vpc-aaaaaaaa/${R}c`)!;
    expect(a.y).toBe(c.y);
    expect(a.x + a.width).toBeLessThanOrEqual(c.x);
  });
});
