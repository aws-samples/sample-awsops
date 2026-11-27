// Cross-account network topology projection over central inventory rows (pure, React-free).
// Identities use real account ids; cross-account links resolve by attachment / peering id,
// never by CIDR (overlapping CIDRs are common across accounts). Configuration only: an edge
// is a configured attachment or peering, not proof of routing or reachability.
import {
  MAX_TILES_PER_SUBNET, type NetEdge, type NetKind, type NetNode, type NetRow,
  type NetworkSelection, type NetworkTopology, type SubnetTier,
} from './network-topology-types';

const ACCOUNT = /^\d{12}$/;
const FLEET_TYPES = new Set(['vpc', 'transit_gateway', 'transit_gateway_attachment', 'vpc_peering_connection']);
const TILE_ORDER: NetKind[] = ['igw', 'nat', 'vpce', 'alb', 'nlb', 'ec2', 'lambda', 'rds'];

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
/** First present key — Steampipe JSON columns carry SDK PascalCase, older rows snake_case. */
const pick = (o: unknown, ...keys: string[]): unknown => {
  if (!o || typeof o !== 'object') return undefined;
  for (const k of keys) if ((o as Record<string, unknown>)[k] != null) return (o as Record<string, unknown>)[k];
  return undefined;
};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const nameOf = (data: Record<string, unknown>, fallback: string) =>
  str(data.name) || str(pick(data.tags, 'Name')) || str(data.description) || fallback;
/** captured_at → epoch ms (Date-safe); NaN when absent or unparsable. */
const ms = (v: unknown) => (v instanceof Date ? v.getTime() : typeof v === 'string' ? Date.parse(v) : NaN);
const ageMs = (v: unknown) => { const n = ms(v); return Number.isFinite(n) ? n : -Infinity; };

interface VpcInfo { key: string; accountId: string; region: string; vpcId: string; label: string; cidr: string }
interface Link { id: string; kind: 'tgw' | 'peering'; a: string; b: string; tgw?: { owner: string; region: string; id: string }; active: boolean; capturedMs?: number }

export function buildNetworkTopology(rows: NetRow[], opts: {
  hostAccountId: string | null; aliases: Record<string, string>;
  selection: NetworkSelection; truncated?: boolean;
}): NetworkTopology {
  const host = opts.hostAccountId && ACCOUNT.test(opts.hostAccountId) ? opts.hostAccountId : null;
  const acct = (raw: string) => (raw === 'self' ? host ?? 'self' : raw);
  const owner = (v: unknown, fallback: string) => (ACCOUNT.test(str(v)) ? str(v) : fallback);
  const byType = new Map<string, NetRow[]>();
  for (const r of rows) {
    if (!r || !r.region || !r.resource_id) continue;
    const list = byType.get(r.resource_type) ?? [];
    list.push(r); byType.set(r.resource_type, list);
  }
  const of = (type: string) => byType.get(type) ?? [];
  // Accounts that collected any fleet row (onboarded); others never get an account box.
  const collecting = new Set(rows.filter((r) => FLEET_TYPES.has(r.resource_type)).map((r) => acct(r.account_id)));

  // ── VPC identity: keyed by owner, reachable from every collecting account's scope ──
  const vpcs = new Map<string, VpcInfo>();
  const vpcByScope = new Map<string, string>(); // `${collector}|${region}|${vpcId}` → vpcKey
  for (const r of of('vpc')) {
    const collector = acct(r.account_id);
    const accountId = owner(r.data.owner_id, collector);
    const key = `${accountId}/${r.region}/${r.resource_id}`;
    if (!vpcs.has(key)) {
      vpcs.set(key, { key, accountId, region: r.region!, vpcId: r.resource_id,
        label: nameOf(r.data, r.resource_id), cidr: str(r.data.cidr_block) });
    }
    vpcByScope.set(`${collector}|${r.region}|${r.resource_id}`, key);
  }
  const tgwLabels = new Map<string, string>();
  for (const r of of('transit_gateway')) {
    tgwLabels.set(`${owner(r.data.owner_id, acct(r.account_id))}/${r.region}/${r.resource_id}`, nameOf(r.data, r.resource_id));
  }

  // ── Links: dedupe by record id; conflicting identities are withheld, never first-wins ──
  const omitted = { inactive: 0, conflicting: 0, resourcesCapped: 0 };
  const links = new Map<string, Link>();
  const conflicts = new Set<string>();
  const signature = (l: Link) => JSON.stringify([l.a, l.b, l.tgw]);
  function admit(link: Link) {
    if (conflicts.has(link.id)) return;
    const prior = links.get(link.id);
    if (!prior) { links.set(link.id, link); return; }
    if (signature(prior) !== signature(link)) { links.delete(link.id); conflicts.add(link.id); return; }
    // The freshest copy decides; equal-age copies (including both undated) must all be live.
    const priorMs = prior.capturedMs ?? -Infinity, linkMs = link.capturedMs ?? -Infinity;
    if (linkMs > priorMs) { prior.active = link.active; prior.capturedMs = linkMs; }
    else if (linkMs === priorMs) prior.active = prior.active && link.active;
  }
  for (const r of of('transit_gateway_attachment')) {
    if (str(r.data.attached_resource_type) !== 'vpc') continue;
    const collector = acct(r.account_id);
    const tgwId = str(r.data.transit_gateway_id), vpcId = str(r.data.attached_resource_id);
    if (!tgwId || !vpcId) continue;
    const tgw = { owner: owner(r.data.transit_gateway_owner_id, collector), region: r.region!, id: tgwId };
    admit({ id: r.resource_id, kind: 'tgw', a: `${owner(r.data.resource_owner_id, collector)}/${r.region}/${vpcId}`,
      b: `${tgw.owner}/${tgw.region}/${tgw.id}`, tgw, active: str(r.data.state) === 'available', capturedMs: ageMs(r.captured_at as unknown) });
  }
  for (const r of of('vpc_peering_connection')) {
    const collector = acct(r.account_id);
    const end = (side: 'requester' | 'accepter') => {
      const vpcId = str(r.data[`${side}_vpc_id`]);
      return vpcId ? `${owner(r.data[`${side}_owner_id`], collector)}/${str(r.data[`${side}_region`]) || r.region}/${vpcId}` : '';
    };
    const a = end('requester'), b = end('accepter');
    if (!a || !b || a === b) continue;
    admit({ id: r.resource_id, kind: 'peering', a, b, active: str(r.data.status_code) === 'active', capturedMs: ageMs(r.captured_at as unknown) });
  }
  omitted.conflicting = conflicts.size;
  const live: Link[] = [];
  for (const l of links.values()) { if (l.active) live.push(l); else omitted.inactive++; }

  // ── Scope ──
  const detail = opts.selection.vpcs.length > 0;
  const scopeAccounts = opts.selection.accounts === '__all__' ? null : new Set(opts.selection.accounts.map(acct));
  const expanded = new Set(opts.selection.vpcs.filter((k) => vpcs.has(k)));
  const accountInScope = (id: string) => scopeAccounts === null || scopeAccounts.has(id);
  const vpcVisible = (key: string) => (detail ? expanded.has(key)
    : vpcs.has(key) && accountInScope(vpcs.get(key)!.accountId) && collecting.has(vpcs.get(key)!.accountId));
  const anchoredTgws = new Set<string>();
  for (const l of live) {
    if (l.kind !== 'tgw') continue;
    if (detail ? expanded.has(l.a) : accountInScope(l.tgw!.owner) && collecting.has(l.tgw!.owner)) anchoredTgws.add(l.b);
  }

  const nodes = new Map<string, NetNode>();
  const put = (n: NetNode) => { if (!nodes.has(n.id)) nodes.set(n.id, n); return n.id; };
  const accountNode = (id: string) => put({ id: `account:${id}`, kind: 'account', parent: null,
    label: opts.aliases[id] || id, sub: opts.aliases[id] ? id : undefined, accountId: id, region: '' });
  const regionNode = (id: string, region: string) => put({ id: `region:${id}/${region}`, kind: 'region',
    parent: accountNode(id), label: region, accountId: id, region });
  const vpcNode = (v: VpcInfo) => put({ id: `vpc:${v.key}`, kind: 'vpc', parent: regionNode(v.accountId, v.region),
    label: v.label, sub: [v.cidr, v.vpcId].filter(Boolean).join(' · '), accountId: v.accountId, region: v.region,
    resourceId: v.vpcId, vpcKey: v.key });
  const endpoint = (key: string): string => {
    const v = vpcs.get(key);
    if (v && vpcVisible(key)) return vpcNode(v);
    const [accountId, region, vpcId] = key.split('/');
    return put({ id: `external:${key}`, kind: 'external', parent: null, label: v?.label ?? vpcId,
      sub: opts.aliases[accountId] || accountId, accountId, region, resourceId: vpcId, vpcKey: key, outOfScope: true, inInventory: !!v });
  };
  const tgwNode = (t: { owner: string; region: string; id: string }) => {
    const key = `${t.owner}/${t.region}/${t.id}`;
    const boxed = detail ? nodes.has(`region:${t.owner}/${t.region}`) : accountInScope(t.owner) && collecting.has(t.owner);
    return put({ id: `tgw:${key}`, kind: 'tgw', parent: boxed ? regionNode(t.owner, t.region) : null,
      label: tgwLabels.get(key) ?? t.id, sub: boxed ? undefined : opts.aliases[t.owner] || t.owner,
      accountId: t.owner, region: t.region, resourceId: t.id, outOfScope: boxed ? undefined : true });
  };

  for (const v of vpcs.values()) {
    if (vpcVisible(v.key)) vpcNode(v);
    else if (!detail && accountInScope(v.accountId) && !collecting.has(v.accountId)) endpoint(v.key);
  }
  if (!detail) {
    for (const r of of('transit_gateway')) {
      const t = { owner: owner(r.data.owner_id, acct(r.account_id)), region: r.region!, id: r.resource_id };
      if (accountInScope(t.owner)) tgwNode(t);
    }
  }

  const edges: NetEdge[] = [];
  const edge = (l: Link, source: string, target: string) => {
    const s = nodes.get(source)!, t = nodes.get(target)!;
    edges.push({ id: `edge:${l.kind === 'tgw' ? 'tgw' : 'pcx'}:${l.id}`, kind: l.kind, source, target,
      recordId: l.id, crossAccount: s.accountId !== t.accountId });
  };
  for (const l of [...live].sort((x, y) => x.id.localeCompare(y.id))) {
    if (l.kind === 'tgw') {
      if (!anchoredTgws.has(l.b) && !vpcVisible(l.a)) continue;
      edge(l, endpoint(l.a), tgwNode(l.tgw!));
    } else {
      if (!vpcVisible(l.a) && !vpcVisible(l.b)) continue;
      edge(l, endpoint(l.a), endpoint(l.b));
    }
  }

  if (detail) placeDetail();

  function placeDetail() {
    const scopeOf = (r: NetRow, vpcId: string) => vpcByScope.get(`${acct(r.account_id)}|${r.region}|${vpcId}`);
    // Subnets → AZ columns
    const subnetNode = new Map<string, string>(); // `${vpcKey}|${subnetId}` → node id
    const subnetsByVpc = new Map<string, string[]>();
    const tiers = routeTiers();
    for (const r of of('subnet')) {
      const key = scopeOf(r, str(r.data.vpc_id));
      if (!key || !expanded.has(key)) continue;
      const v = vpcs.get(key)!;
      const subnetId = `subnet:${v.accountId}/${v.region}/${r.resource_id}`;
      if (nodes.has(subnetId)) continue; // first collected copy of a shared subnet places it
      // AZ names map to physical AZs per account; the AZ id is stable across owner and participants.
      const azKey = str(r.data.availability_zone_id) || str(r.data.availability_zone) || 'unknown-az';
      const azLabel = str(r.data.availability_zone) || azKey;
      const azId = put({ id: `az:${key}/${azKey}`, kind: 'az', parent: `vpc:${key}`, label: azLabel, accountId: v.accountId, region: v.region, vpcKey: key });
      const id = put({ id: subnetId, kind: 'subnet', parent: azId,
        label: nameOf(r.data, r.resource_id), sub: str(r.data.cidr_block), accountId: v.accountId, region: v.region,
        resourceId: r.resource_id, tier: tiers.get(`${key}|${r.resource_id}`) ?? 'unknown', vpcKey: key });
      subnetNode.set(`${key}|${r.resource_id}`, id);
      subnetsByVpc.set(key, [...(subnetsByVpc.get(key) ?? []), r.resource_id]);
    }
    // Resource tiles → first sorted subnet they occupy, else the VPC itself
    const tiles = new Map<string, NetNode[]>();
    function tile(kind: NetKind, r: NetRow, key: string, subnets: string[], sub?: string, state?: string) {
      const v = vpcs.get(key)!;
      const owner = acct(r.account_id); // the collecting account owns the resource, not the VPC owner
      const placed = [...subnets].sort().map((s) => subnetNode.get(`${key}|${s}`)).find(Boolean);
      const parent = placed ?? `vpc:${key}`;
      const list = tiles.get(parent) ?? [];
      list.push({ id: `${kind}:${owner}/${v.region}/${r.resource_id}`, kind, parent, label: nameOf(r.data, r.resource_id),
        sub: sub || undefined, state: state || undefined, accountId: owner, region: v.region, resourceId: r.resource_id, vpcKey: key });
      tiles.set(parent, list);
    }
    const inVpc = (r: NetRow) => { const k = scopeOf(r, str(r.data.vpc_id)); return k && expanded.has(k) ? k : null; };
    for (const r of of('ec2')) { const k = inVpc(r); if (k) tile('ec2', r, k, [str(r.data.subnet_id)], str(r.data.instance_type), str(r.data.instance_state)); }
    for (const r of of('nat_gateway')) { const k = inVpc(r); if (k) tile('nat', r, k, [str(r.data.subnet_id)], r.resource_id, str(r.data.state)); }
    for (const kind of ['alb', 'nlb'] as const) {
      for (const r of of(kind)) {
        const k = inVpc(r);
        if (k) tile(kind, r, k, arr(r.data.availability_zones).map((a) => str(pick(a, 'SubnetId', 'subnet_id'))).filter(Boolean),
          str(r.data.scheme), str(r.data.state_code));
      }
    }
    for (const r of of('lambda')) { const k = inVpc(r); if (k) tile('lambda', r, k, arr(r.data.vpc_subnet_ids).map(str), str(r.data.runtime), str(r.data.state)); }
    for (const r of of('rds')) { const k = inVpc(r); if (k) tile('rds', r, k, [], str(r.data.engine), str(r.data.status)); }
    for (const r of of('vpc_endpoint')) {
      const k = inVpc(r);
      if (!k) continue;
      const iface = str(r.data.vpc_endpoint_type) !== 'Gateway';
      tile('vpce', r, k, iface ? arr(r.data.subnet_ids).map(str) : [], str(r.data.service_name).split('.').pop(), str(r.data.state));
    }
    for (const r of of('internet_gateway')) {
      for (const a of arr(r.data.attachments)) {
        const k = scopeOf(r, str(pick(a, 'VpcId', 'vpc_id')));
        if (k && expanded.has(k)) tile('igw', r, k, [], r.resource_id, str(pick(a, 'State', 'state')));
      }
    }
    for (const [parent, list] of tiles) {
      const sorted = list.sort((x, y) => TILE_ORDER.indexOf(x.kind) - TILE_ORDER.indexOf(y.kind) || x.label.localeCompare(y.label) || x.id.localeCompare(y.id));
      const seen = new Set<string>();
      const unique = sorted.filter((n) => !seen.has(n.id) && seen.add(n.id));
      unique.slice(0, MAX_TILES_PER_SUBNET).forEach(put);
      const extra = unique.length - MAX_TILES_PER_SUBNET;
      if (extra > 0) {
        omitted.resourcesCapped += extra;
        const p = nodes.get(parent)!;
        put({ id: `more:${parent}`, kind: 'more', parent, label: `+${extra}`, count: extra, accountId: p.accountId, region: p.region, vpcKey: p.vpcKey });
      }
    }
  }

  /** Subnet tier from its explicit route-table association, else the VPC's main table. */
  function routeTiers(): Map<string, SubnetTier> {
    const explicit = new Map<string, boolean>(), main = new Map<string, boolean>();
    for (const r of of('route_table')) {
      const key = vpcByScope.get(`${acct(r.account_id)}|${r.region}|${str(r.data.vpc_id)}`);
      if (!key) continue;
      const routes = arr(pick(r.data, 'routes', 'Routes'));
      const isPublic = routes.some((rt) => (str(pick(rt, 'DestinationCidrBlock', 'destination_cidr_block')) === '0.0.0.0/0' ||
          str(pick(rt, 'DestinationIpv6CidrBlock', 'destination_ipv6_cidr_block')) === '::/0') &&
        str(pick(rt, 'GatewayId', 'gateway_id')).startsWith('igw-') &&
        str(pick(rt, 'State', 'state')) !== 'blackhole');
      for (const a of arr(pick(r.data, 'associations', 'Associations'))) {
        const subnet = str(pick(a, 'SubnetId', 'subnet_id'));
        if (subnet) explicit.set(`${key}|${subnet}`, isPublic);
        if (pick(a, 'Main', 'main') === true) main.set(key, isPublic);
      }
    }
    const out = new Map<string, SubnetTier>();
    for (const r of of('subnet')) {
      const key = vpcByScope.get(`${acct(r.account_id)}|${r.region}|${str(r.data.vpc_id)}`);
      if (!key) continue;
      const k = `${key}|${r.resource_id}`;
      const pub = explicit.has(k) ? explicit.get(k) : main.get(key);
      out.set(k, pub === undefined ? 'unknown' : pub ? 'public' : 'private');
    }
    return out;
  }

  // Parents before children (depth order), siblings by label then id.
  const depth = (n: NetNode): number => (n.parent && nodes.get(n.parent) ? 1 + depth(nodes.get(n.parent)!) : 0);
  const ordered = [...nodes.values()].map((n) => ({ n, d: depth(n) }))
    .sort((x, y) => x.d - y.d || x.n.label.localeCompare(y.n.label) || x.n.id.localeCompare(y.n.id)).map((x) => x.n);

  // Oldest capture over contributing rows: fleet types in fleet mode, every row in detail mode
  // (the read path returns detail rows only for the selected VPCs). Numeric, Date-safe.
  const finite = rows.filter((r) => detail || FLEET_TYPES.has(r.resource_type))
    .map((r) => ms(r.captured_at as unknown)).filter((n) => Number.isFinite(n));
  const capturedAt = finite.length ? new Date(Math.min(...finite)).toISOString() : null;
  return { level: detail ? 'detail' : 'fleet', nodes: ordered, edges, omitted,
    truncated: opts.truncated === true, capturedAt };
}
