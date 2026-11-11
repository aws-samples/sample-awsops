// Pure ENI → owning-resource resolution over synced inventory rows (no SDK, no I/O).
// Every private IP belongs to exactly one ENI, so a load-balancer IP target can be attributed
// to the resource behind that ENI. Rules never fabricate an owner: the owning resource must be
// present in the supplied inventory, otherwise the result is an explicit unresolved reason.
//
// Rows are flattened inventory rows ({ resource_id, region, ...data }) in Steampipe shape.

type Row = Record<string, unknown>;
const str = (v: unknown): string => (v == null ? '' : String(v));
const list = (v: unknown): unknown[] => {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.trim().startsWith('[')) {
    try { const parsed = JSON.parse(v); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
  }
  return [];
};

export type EniOwnerKind = 'ec2' | 'alb' | 'nlb' | 'lambda' | 'rds' | 'rds_cluster' | 'vpc_endpoint' | 'nat_gateway';
export type EniUnresolved =
  | 'ecs_managed'        // ECS task ENI — the ECS task map owns this attribution
  | 'secondary_ip'       // secondary IP on an instance ENI (e.g. VPC CNI pod IP) — not the instance
  | 'owner_not_synced'   // the ENI names an owner that is absent from inventory
  | 'owner_ambiguous'    // several inventory resources could own the ENI
  | 'owner_inventory_incomplete' // the owner lookup (or an inference guard) relies on an incomplete read
  | 'owner_unknown';     // no rule identifies the owner

export interface EniOwner {
  kind: EniOwnerKind;
  /** Inventory resource_id of the owner (LB name, function name, instance id, …). */
  resourceId: string;
  label: string;
  /** observed = the ENI names the owner; inferred = derived from placement (RDS by VPC/AZ) or
   *  from a creator name that the ENI may share (Lambda Hyperplane ENIs serve every function
   *  with the same subnet and security-group set). */
  confidence: 'observed' | 'inferred';
  eniId: string;
  /** Owner ARN when the inventory row carries one (LB node identity in the flow graph). */
  arn?: string;
}
export type EniResolution = { owner: EniOwner } | { reason: EniUnresolved; eniId: string | null };

export interface EniOwnerInput {
  eni?: Row[]; ec2?: Row[]; alb?: Row[]; nlb?: Row[]; lambda?: Row[];
  rds?: Row[]; rds_cluster?: Row[]; rds_proxy?: Row[]; vpc_endpoint?: Row[]; nat_gateway?: Row[];
}
/** Inventory types whose read is withheld, capped or failed: a miss there is not "not synced",
 *  and an inference guarded by them (RDS placement, RDS Proxy subnet sharing) is not made. */
export type IncompleteTypes = ReadonlySet<string>;

const scoped = (region: string, vpc: string, value: string) => JSON.stringify([region, vpc, value]);
const LAMBDA_PREFIX = 'AWS Lambda VPC ENI-';
const UUID_SUFFIX = /-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ELB_DESC = /^ELB (app|net)\/([^/\s]+)\/([0-9a-f]+)$/;

function privateIps(eni: Row): { ip: string; primary: boolean }[] {
  const primary = str(eni.private_ip_address);
  const out = new Map<string, boolean>();
  if (primary) out.set(primary, true);
  for (const entry of list(eni.private_ip_addresses)) {
    const o = (entry ?? {}) as Row;
    const ip = str(o.PrivateIpAddress ?? o.private_ip_address);
    if (!ip) continue;
    const isPrimary = o.Primary === true || o.primary === true || ip === primary;
    out.set(ip, (out.get(ip) ?? false) || isPrimary);
  }
  return [...out].map(([ip, isPrimary]) => ({ ip, primary: isPrimary }));
}

/** Build a resolver once per graph; `resolve` is called per IP target. */
export function eniOwnerResolver(input: EniOwnerInput, incomplete: IncompleteTypes = new Set()) {
  const gap = (...types: string[]) => types.some(type => incomplete.has(type));
  // IP → ENI, scoped by region and VPC (a private IP is unique inside one VPC). A duplicate key
  // means overlapping snapshots; it resolves to null (ambiguous) instead of the first match.
  const byIp = new Map<string, { eni: Row; primary: boolean } | null>();
  for (const eni of input.eni ?? []) {
    const region = str(eni.region), vpc = str(eni.vpc_id);
    if (!region || !vpc) continue;
    for (const { ip, primary } of privateIps(eni)) {
      const k = scoped(region, vpc, ip);
      byIp.set(k, byIp.has(k) ? null : { eni, primary });
    }
  }
  const byRegionId = (rows: Row[] | undefined) => {
    const m = new Map<string, Row>();
    for (const r of rows ?? []) m.set(JSON.stringify([str(r.region), str(r.resource_id)]), r);
    return m;
  };
  const ec2 = byRegionId(input.ec2), lambda = byRegionId(input.lambda);
  const vpce = byRegionId(input.vpc_endpoint), nat = byRegionId(input.nat_gateway);
  const clusters = byRegionId(input.rds_cluster);
  const lbs = [...(input.alb ?? []).map(r => ['alb', r] as const), ...(input.nlb ?? []).map(r => ['nlb', r] as const)];
  const label = (r: Row) => str(r.name) || str(r.resource_id);

  const owner = (kind: EniOwnerKind, row: Row, eniId: string, confidence: EniOwner['confidence'] = 'observed'): EniResolution =>
    ({ owner: { kind, resourceId: str(row.resource_id), label: label(row), confidence, eniId,
      ...(str(row.arn) ? { arn: str(row.arn) } : {}) } });
  const miss = (reason: EniUnresolved, eniId: string): EniResolution => ({ reason, eniId });
  /** An absent owner is only "not synced" when the owner's own read was complete. */
  const absent = (eniId: string, ...types: string[]): EniResolution =>
    miss(gap(...types) ? 'owner_inventory_incomplete' : 'owner_not_synced', eniId);

  function resolveEni(eni: Row, primary: boolean): EniResolution {
    const eniId = str(eni.resource_id);
    const region = str(eni.region), vpc = str(eni.vpc_id);
    const type = str(eni.interface_type), desc = str(eni.description).trim();
    const requester = str(eni.requester_id);
    const key = (id: string) => JSON.stringify([region, id]);

    if (desc.startsWith('arn:aws:ecs:')) return miss('ecs_managed', eniId);

    // VPC endpoint (interface / GWLB endpoint): the description carries the endpoint id.
    if (type === 'vpc_endpoint' || type === 'gateway_load_balancer_endpoint' || desc.startsWith('VPC Endpoint Interface')) {
      const id = /\b(vpce-[0-9a-f]{8,})\b/.exec(desc)?.[1];
      const row = id ? vpce.get(key(id)) : undefined;
      return row ? owner('vpc_endpoint', row, eniId) : id ? absent(eniId, 'vpc_endpoint') : miss('owner_unknown', eniId);
    }
    if (type === 'nat_gateway' || desc.startsWith('Interface for NAT Gateway')) {
      const id = /\b(nat-[0-9a-f]{8,})\b/.exec(desc)?.[1];
      const row = id ? nat.get(key(id)) : undefined;
      return row ? owner('nat_gateway', row, eniId) : id ? absent(eniId, 'nat_gateway') : miss('owner_unknown', eniId);
    }
    // ELB: `ELB app/<name>/<hash>` matches the LB ARN suffix exactly, never by name alone.
    const elb = ELB_DESC.exec(desc);
    if (elb) {
      const suffix = `:loadbalancer/${elb[1]}/${elb[2]}/${elb[3]}`;
      const hits = lbs.filter(([, r]) => str(r.region) === region && str(r.arn).endsWith(suffix));
      return hits.length === 1 ? owner(hits[0][0], hits[0][1], eniId)
        : hits.length ? miss('owner_ambiguous', eniId) : absent(eniId, 'alb', 'nlb');
    }
    if (type === 'lambda' || desc.startsWith(LAMBDA_PREFIX)) {
      const rest = desc.startsWith(LAMBDA_PREFIX) ? desc.slice(LAMBDA_PREFIX.length) : '';
      const name = UUID_SUFFIX.test(rest) ? rest.replace(UUID_SUFFIX, '') : '';
      const row = name ? lambda.get(key(name)) : undefined;
      return row ? owner('lambda', row, eniId, 'inferred') : name ? absent(eniId, 'lambda') : miss('owner_unknown', eniId);
    }
    // RDS ENIs carry no DB name: attribute only when one DB (or one cluster's members) sits in
    // this VPC/AZ, and never when an RDS Proxy shares the ENI's subnet (same ENI signature).
    if (requester === 'amazon-rds' || desc.startsWith('RDSNetworkInterface')) {
      // Placement inference is only sound over complete DB and proxy inventories.
      if (gap('rds', 'rds_proxy')) return miss('owner_inventory_incomplete', eniId);
      const zone = str(eni.availability_zone), subnet = str(eni.subnet_id);
      const proxyShare = (input.rds_proxy ?? []).some(p => str(p.region) === region && str(p.vpc_id) === vpc
        && list(p.vpc_subnet_ids).map(str).includes(subnet));
      if (proxyShare) return miss('owner_ambiguous', eniId);
      const dbs = (input.rds ?? []).filter(r => str(r.region) === region && str(r.vpc_id) === vpc
        && str(r.availability_zone) === zone);
      if (dbs.length === 1) return owner('rds', dbs[0], eniId, 'inferred');
      const ids = new Set(dbs.map(r => str(r.db_cluster_identifier)));
      const only = ids.size === 1 ? [...ids][0] : '';
      const cluster = only ? clusters.get(key(only)) : undefined;
      if (dbs.length > 1 && only && gap('rds_cluster')) return miss('owner_inventory_incomplete', eniId);
      if (dbs.length > 1 && cluster) return owner('rds_cluster', cluster, eniId, 'inferred');
      return miss(dbs.length ? 'owner_ambiguous' : 'owner_not_synced', eniId);
    }
    // A customer-attached instance ENI owns its primary IP. Secondary IPs (VPC CNI pod IPs,
    // container sidecars) are not the instance itself.
    const instance = str(eni.attached_instance_id);
    if (instance && eni.requester_managed !== true) {
      if (!primary) return miss('secondary_ip', eniId);
      const row = ec2.get(key(instance));
      return row ? owner('ec2', row, eniId) : absent(eniId, 'ec2');
    }
    return miss('owner_unknown', eniId);
  }

  return {
    /** null = no synced ENI holds this IP in that region/VPC (or the snapshot is contradictory). */
    resolve(region: string, vpc: string, ip: string): EniResolution | null {
      if (!region || !vpc || !ip) return null;
      // A cut or withheld ENI list cannot prove a single holder (duplicate claims may be missing).
      if (gap('eni')) return { reason: 'owner_inventory_incomplete', eniId: null };
      const hit = byIp.get(scoped(region, vpc, ip));
      return hit ? resolveEni(hit.eni, hit.primary) : null;
    },
  };
}
