import type { InvType } from './inventory-types';

// Spec-driven, grouped, typed rendering layer for the inventory DetailPanel.
// Pure (no React) so it unit-tests in node env and stays client-safe.

export type DetailKind = 'boolean' | 'state' | 'empty' | 'code' | 'text' | 'tags' | 'idlist';
export interface DetailListItem { id: string; name?: string; extra?: string; flag?: string }
export interface DetailValue {
  kind: DetailKind;
  text?: string;
  bool?: boolean;
  /** kind 'tags': key/value pairs, insertion-ordered. */
  entries?: [string, string][];
  /** kind 'idlist': structured rows (security groups / block devices / NICs — v1-parity lists). */
  items?: DetailListItem[];
}
export interface DetailItem { key: string; label: string; value: unknown; fmt: DetailValue }
export interface DetailGroup { label: string; items: DetailItem[] }

// Keys whose value is a lifecycle state (rendered as a StatePill). Superset of DataTable's set.
const STATE_KEYS = new Set([
  'state', 'status', 'instance_state', 'cache_cluster_status', 'state_value', 'table_status', 'state_code',
]);

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** v1-parity structured lists: map a known array-of-objects field to id/name/extra/flag rows.
 *  Returns null when the shape is unexpected → caller falls back to raw JSON. */
function structuredList(key: string, value: unknown): DetailListItem[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  // An array of plain strings (subnet ids, SG ids, aliases, ARNs, architectures…) reads far
  // better as one id per row than as a JSON array literal — applies to every type.
  if (value.every((el) => typeof el === 'string')) {
    return (value as string[]).map((id) => ({ id }));
  }
  const rows: DetailListItem[] = [];
  for (const el of value) {
    const o = asRecord(el);
    if (!o) return null;
    if (key === 'vpc_security_groups') {
      // RDS: [{ VpcSecurityGroupId, Status }]
      const id = o.VpcSecurityGroupId ?? o.vpc_security_group_id;
      if (typeof id !== 'string') return null;
      rows.push({ id, name: typeof o.Status === 'string' ? o.Status : undefined });
    } else if (key === 'attachments') {
      // EBS: [{ InstanceId, Device, State }]; IGW: [{ VpcId, State }] (ECS task attachments → JSON)
      const id = o.InstanceId ?? o.instance_id ?? o.VpcId ?? o.vpc_id;
      if (typeof id !== 'string') return null;
      rows.push({
        id,
        name: typeof (o.Device ?? o.device) === 'string' ? String(o.Device ?? o.device) : undefined,
        extra: typeof (o.State ?? o.state) === 'string' ? String(o.State ?? o.state) : undefined,
      });
    } else if (key === 'routes') {
      // Route table (v1 parity): destination → target, blackhole flagged.
      const dest = o.DestinationCidrBlock ?? o.destination_cidr_block ?? o.DestinationIpv6CidrBlock
        ?? o.destination_ipv6_cidr_block ?? o.DestinationPrefixListId ?? o.destination_prefix_list_id;
      if (typeof dest !== 'string') return null;
      const target = [o.GatewayId ?? o.gateway_id, o.NatGatewayId ?? o.nat_gateway_id,
        o.TransitGatewayId ?? o.transit_gateway_id, o.VpcPeeringConnectionId ?? o.vpc_peering_connection_id,
        o.NetworkInterfaceId ?? o.network_interface_id, o.InstanceId ?? o.instance_id]
        .find((x) => typeof x === 'string' && x !== '');
      const st = String(o.State ?? o.state ?? '');
      rows.push({
        id: dest,
        name: typeof target === 'string' ? target : undefined,
        flag: st.toLowerCase() === 'blackhole' ? 'BLACKHOLE' : undefined,
      });
    } else if (key === 'associations') {
      // Route table associations: subnet (or main) → association id.
      const aid = o.RouteTableAssociationId ?? o.route_table_association_id;
      const subnet = o.SubnetId ?? o.subnet_id;
      const main = (o.Main ?? o.main) === true;
      rows.push({
        id: typeof subnet === 'string' ? subnet : main ? '(main)' : String(aid ?? ''),
        name: typeof aid === 'string' ? aid : undefined,
        flag: main ? 'MAIN' : undefined,
      });
    } else if (key === 'nat_gateway_addresses') {
      const pub = o.PublicIp ?? o.public_ip;
      const priv = o.PrivateIp ?? o.private_ip;
      const eni = o.NetworkInterfaceId ?? o.network_interface_id;
      if (typeof pub !== 'string' && typeof priv !== 'string') return null;
      rows.push({
        id: String(pub ?? priv),
        name: typeof priv === 'string' && pub ? priv : undefined,
        extra: typeof eni === 'string' ? eni : undefined,
      });
    } else if (key === 'ip_permissions' || key === 'ip_permissions_egress') {
      // SG rules (v1 parity): one row per rule — "proto ports" + sources + open-world flag.
      const g = (obj: Record<string, unknown>, a: string, b: string) => obj[a] ?? obj[b];
      const proto = String(g(o, 'IpProtocol', 'ip_protocol') ?? '');
      const from = g(o, 'FromPort', 'from_port');
      const to = g(o, 'ToPort', 'to_port');
      const ports = proto === '-1' ? 'ALL' : from == null ? '' : from === to ? String(from) : `${from}-${to}`;
      const ranges = (Array.isArray(g(o, 'IpRanges', 'ip_ranges')) ? (g(o, 'IpRanges', 'ip_ranges') as Record<string, unknown>[]) : [])
        .map((x) => String(g(x, 'CidrIp', 'cidr_ip') ?? ''));
      const ranges6 = (Array.isArray(g(o, 'Ipv6Ranges', 'ipv6_ranges')) ? (g(o, 'Ipv6Ranges', 'ipv6_ranges') as Record<string, unknown>[]) : [])
        .map((x) => String(g(x, 'CidrIpv6', 'cidr_ipv6') ?? ''));
      const sgs = (Array.isArray(g(o, 'UserIdGroupPairs', 'user_id_group_pairs')) ? (g(o, 'UserIdGroupPairs', 'user_id_group_pairs') as Record<string, unknown>[]) : [])
        .map((x) => String(g(x, 'GroupId', 'group_id') ?? ''));
      const sources = [...ranges, ...ranges6, ...sgs].filter(Boolean);
      rows.push({
        id: `${proto === '-1' ? 'ALL' : proto.toUpperCase()}${ports ? ` ${ports}` : ''}`,
        name: sources.join(', ') || '(none)',
        flag: sources.some((x) => x === '0.0.0.0/0' || x === '::/0') ? 'OPEN' : undefined,
      });
    } else if (key === 'key_schema') {
      // DynamoDB: [{ AttributeName, KeyType }] → attr + HASH/RANGE
      const attr = o.AttributeName ?? o.attribute_name;
      if (typeof attr !== 'string') return null;
      rows.push({ id: attr, name: String(o.KeyType ?? o.key_type ?? '') });
    } else if (key === 'origins') {
      // CloudFront: [{ Id, DomainName }]
      const oid = o.Id ?? o.id;
      if (typeof oid !== 'string') return null;
      rows.push({ id: oid, name: String(o.DomainName ?? o.domain_name ?? '') });
    } else if (key === 'rules') {
      // WAF: [{ Name, Priority, Action: { <Allow|Block|Count>: {} } }]
      const rn = o.Name ?? o.name;
      if (typeof rn !== 'string') return null;
      const action = asRecord(o.Action ?? o.action);
      const act = action ? Object.keys(action)[0] : undefined;
      const prio = o.Priority ?? o.priority;
      rows.push({
        id: rn,
        name: prio != null ? `priority ${prio}` : undefined,
        extra: act,
        flag: act?.toLowerCase() === 'block' ? 'BLOCK' : undefined,
      });
    } else if (key === 'security_groups') {
      const id = o.GroupId ?? o.group_id;
      if (typeof id !== 'string') return null;
      rows.push({ id, name: typeof (o.GroupName ?? o.group_name) === 'string' ? String(o.GroupName ?? o.group_name) : undefined });
    } else if (key === 'block_device_mappings') {
      const id = o.DeviceName ?? o.device_name;
      if (typeof id !== 'string') return null;
      const ebs = asRecord(o.Ebs ?? o.ebs);
      rows.push({
        id,
        name: typeof ebs?.VolumeId === 'string' ? (ebs.VolumeId as string)
          : typeof ebs?.volume_id === 'string' ? (ebs.volume_id as string) : undefined,
        flag: (ebs?.DeleteOnTermination ?? ebs?.delete_on_termination) === true ? 'DeleteOnTermination' : undefined,
      });
    } else if (key === 'network_interfaces') {
      const id = o.NetworkInterfaceId ?? o.network_interface_id;
      if (typeof id !== 'string') return null;
      const assoc = asRecord(o.Association ?? o.association);
      rows.push({
        id,
        name: typeof (o.PrivateIpAddress ?? o.private_ip_address) === 'string'
          ? String(o.PrivateIpAddress ?? o.private_ip_address) : undefined,
        extra: typeof assoc?.PublicIp === 'string' ? (assoc.PublicIp as string) : undefined,
      });
    } else {
      return null;
    }
  }
  return rows;
}

/** Classify a single field value into a render descriptor. */
export function formatDetailValue(key: string, value: unknown): DetailValue {
  if (typeof value === 'boolean') return { kind: 'boolean', bool: value };
  if (value == null || value === '') return { kind: 'empty' };
  if (typeof value === 'object') {
    // Empty arrays read as "none" (e.g. an SG with no ingress rules), not a JSON literal.
    if (Array.isArray(value) && value.length === 0) return { kind: 'empty' };
    // v1-parity readable renderings for well-known structured fields; JSON only as fallback.
    if (key === 'tags') {
      const o = asRecord(value);
      if (o) {
        const entries = Object.entries(o)
          .filter(([, v]) => v != null)
          .map(([k, v]) => [k, String(v)] as [string, string]);
        if (entries.length === 0) return { kind: 'empty' };
        return { kind: 'tags', entries };
      }
    }
    const items = structuredList(key, value);
    if (items) return { kind: 'idlist', items };
    return { kind: 'code', text: JSON.stringify(value, null, 2) };
  }
  const s = String(value);
  if (STATE_KEYS.has(key) && s !== '') return { kind: 'state', text: s };
  return { kind: 'text', text: s };
}

// Friendly labels for detail-only keys (not in a type's table columns). Shared across types —
// these names are AWS-universal. Table columns still win (labelFor checks spec.columns first).
const VIRTUAL_LABELS: Record<string, string> = {
  resource_id: 'Resource ID', region: 'Region', name: 'Name', account_id: 'Account',
  image_id: 'Image (AMI)', architecture: 'Architecture', platform_details: 'Platform',
  virtualization_type: 'Virtualization', hypervisor: 'Hypervisor',
  ebs_optimized: 'EBS Optimized', ena_support: 'ENA Support', monitoring_state: 'Monitoring',
  placement_availability_zone: 'AZ', placement_tenancy: 'Tenancy',
  private_dns_name: 'Private DNS', public_dns_name: 'Public DNS',
  cpu_options_core_count: 'Cores', cpu_options_threads_per_core: 'Threads/Core',
  memory_mib: 'Memory (MiB)', vcpus: 'vCPUs', network_performance: 'Network Perf',
  max_enis: 'Max ENIs', instance_storage_supported: 'Instance Storage',
  root_device_name: 'Root Device', root_device_type: 'Root Device Type',
  iam_instance_profile_arn: 'IAM Role', key_name: 'Key Pair',
  launch_time: 'Launch Time', state_transition_time: 'State Changed',
  security_groups: 'Security Groups', block_device_mappings: 'Block Devices',
  network_interfaces: 'Network Interfaces', tags: 'Tags',
  sse_h: 'SSE', pitr_h: 'PITR', key_schema: 'Key Schema',
  kafka_version: 'Kafka Version', broker_nodes: 'Broker Nodes',
  broker_instance_type: 'Broker Instance', broker_ebs_gb: 'Broker EBS (GB)',
};

// Acronyms kept uppercase when humanizing a snake_case key into a friendly label.
const ACRONYMS = new Set([
  'id', 'arn', 'az', 'vpc', 'ip', 'dns', 'cpu', 'iam', 'kms', 'sg', 'ebs', 'ena',
  'api', 'url', 'uri', 'ttl', 'iops', 'mfa', 'acl', 'ssl', 'tls', 'waf', 'cidr', 'db',
]);
function humanize(key: string): string {
  return key
    .split('_')
    .map((w) => (ACRONYMS.has(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

function labelFor(key: string, spec?: InvType): string {
  return spec?.columns.find((c) => c.key === key)?.label ?? VIRTUAL_LABELS[key] ?? humanize(key);
}

/**
 * Group a resource row for the DetailPanel.
 * - With a spec carrying `sections`: ordered labelled sections (only keys present in the
 *   row), then an `Other` group for any leftover keys. Field labels come from the type spec.
 * - Without a spec (or no sections): a single unlabelled group with every field in insertion
 *   order and dt = raw key — byte-for-byte the legacy flat behavior.
 */
export function buildDetailGroups(row: Record<string, unknown>, spec?: InvType): DetailGroup[] {
  const entries = Object.entries(row);
  const mk = (key: string, value: unknown, friendly: boolean): DetailItem => ({
    key, label: friendly ? labelFor(key, spec) : key, value, fmt: formatDetailValue(key, value),
  });

  if (!spec?.sections || spec.sections.length === 0) {
    return [{ label: '', items: entries.map(([k, v]) => mk(k, v, false)) }];
  }

  const present = new Map(entries);
  const used = new Set<string>();
  const groups: DetailGroup[] = [];
  for (const sec of spec.sections) {
    const items: DetailItem[] = [];
    for (const k of sec.keys) {
      if (present.has(k)) { items.push(mk(k, present.get(k), true)); used.add(k); }
    }
    if (items.length) groups.push({ label: sec.label, items });
  }
  const other = entries.filter(([k]) => !used.has(k));
  if (other.length) groups.push({ label: 'Other', items: other.map(([k, v]) => mk(k, v, true)) });
  return groups;
}
