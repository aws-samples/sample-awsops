import { verifyUser } from '@/lib/auth';
import { getPool } from '@/lib/db';

export const dynamic = 'force-dynamic';

// SG inbound-rule chaining (gap-audit L154, v1 parity): resolve a resource's attached security
// groups to their inbound rules — a pure cross-query over the already-synced security_group
// inventory rows, NO live AWS call (the ebs_volume/related precedent). Consumed by the RDS
// detail panel's RdsSgRulesSection; the response is generic (any SG-holding type can reuse it).

const SG_RE = /^sg-[0-9a-f]{8,32}$/;
const REGION_RE = /^[a-z0-9-]{1,32}$/;
const MAX_IDS = 20;

/** Host rows are stored under the 'self' sentinel (the documented self-vs-real-id trap). */
function normalizeAccount(account: string): string {
  const host = process.env.AWS_ACCOUNT_ID;
  return host && account === host ? 'self' : account;
}

export interface SgRuleSource {
  kind: 'cidr' | 'sg' | 'pl';
  value: string;
  description?: string;
}
export interface SgInboundRule {
  protocol: string;   // 'tcp' | 'udp' | 'icmp' | 'all'
  portRange: string;  // '5432' | '1024-65535' | 'all'
  sources: SgRuleSource[];
}
export interface SgInboundEntry {
  sgId: string;
  found: boolean;     // false = SG not in the synced inventory (render "not synced", never "no rules")
  groupName?: string;
  rules: SgInboundRule[];
}

// Steampipe's ip_permissions JSONB carries the raw AWS PascalCase shape — but plugin versions
// have flip-flopped casing before (the inventory-derived `walk` exists for the same reason),
// so all lookups here are case/underscore-insensitive.
const norm = (k: string) => k.toLowerCase().replace(/_/g, '');
function pick(o: unknown, key: string): unknown {
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return undefined;
  const want = norm(key);
  const hit = Object.keys(o as Record<string, unknown>).find((k) => norm(k) === want);
  return hit === undefined ? undefined : (o as Record<string, unknown>)[hit];
}
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const asStr = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

function parseRules(ipPermissions: unknown): SgInboundRule[] {
  let perms = ipPermissions;
  if (typeof perms === 'string') {
    try { perms = JSON.parse(perms); } catch { return []; }
  }
  // AWS returns numeric protocols verbatim when rules were created numerically — the same
  // normalization sg-analysis.ts's PROTO_NAME applies (without it, IpProtocol '1' would render
  // the garbled "8--1" ICMP range this route exists to avoid).
  const PROTO_NAME: Record<string, string> = { '6': 'tcp', '17': 'udp', '1': 'icmp', '58': 'icmpv6' };
  return asArray(perms).map((p) => {
    const rawProto = asStr(pick(p, 'ip_protocol')) ?? '-1';
    const proto = PROTO_NAME[rawProto] ?? rawProto;
    const from = pick(p, 'from_port');
    const to = pick(p, 'to_port');
    // ICMP puts type/code in From/ToPort (-1 = any) — a "8--1" port range would be garbled.
    const icmp = proto === 'icmp' || proto === 'icmpv6';
    const portRange = proto === '-1' || from == null
      ? 'all'
      : icmp
        ? (Number(from) === -1 ? 'all types' : `type ${from}${to != null && Number(to) !== -1 ? `/code ${to}` : ''}`)
        : from === to ? String(from) : `${from}-${to}`;
    const sources: SgRuleSource[] = [];
    for (const rng of asArray(pick(p, 'ip_ranges'))) {
      const cidr = asStr(pick(rng, 'cidr_ip'));
      if (cidr) sources.push({ kind: 'cidr', value: cidr, description: asStr(pick(rng, 'description')) });
    }
    for (const rng of asArray(pick(p, 'ipv6_ranges'))) {
      const cidr = asStr(pick(rng, 'cidr_ipv6'));
      if (cidr) sources.push({ kind: 'cidr', value: cidr, description: asStr(pick(rng, 'description')) });
    }
    for (const pair of asArray(pick(p, 'user_id_group_pairs'))) {
      const gid = asStr(pick(pair, 'group_id'));
      if (gid) sources.push({ kind: 'sg', value: gid, description: asStr(pick(pair, 'description')) });
    }
    for (const pl of asArray(pick(p, 'prefix_list_ids'))) {
      const pid = asStr(pick(pl, 'prefix_list_id'));
      if (pid) sources.push({ kind: 'pl', value: pid, description: asStr(pick(pl, 'description')) });
    }
    return { protocol: proto === '-1' ? 'all' : proto, portRange, sources };
  });
}

export async function GET(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  const url = new URL(request.url);
  const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean);
  if (!ids.length || ids.length > MAX_IDS || ids.some((id) => !SG_RE.test(id))) {
    return Response.json({ status: 'error', message: 'invalid ids' }, { status: 400 });
  }
  const accountParam = url.searchParams.get('account') ?? 'self';
  if (accountParam !== 'self' && !/^[0-9]{12}$/.test(accountParam)) {
    return Response.json({ status: 'error', message: 'invalid account' }, { status: 400 });
  }
  const account = normalizeAccount(accountParam);
  const regionParam = url.searchParams.get('region');
  if (regionParam !== null && !REGION_RE.test(regionParam)) {
    return Response.json({ status: 'error', message: 'invalid region' }, { status: 400 });
  }

  try {
    const params: unknown[] = [account, ids];
    let regionCond = '';
    if (regionParam) { params.push(regionParam); regionCond = ` AND region = $${params.length}`; }
    const r = await getPool().query<{ resource_id: string; data: Record<string, unknown> | null }>(
      `SELECT resource_id, data FROM inventory_resources
       WHERE resource_type = 'security_group' AND account_id = $1 AND resource_id = ANY($2)${regionCond}`,
      params,
    );
    const byId = new Map(r.rows.map((row) => [row.resource_id, row.data ?? {}]));
    const groups: SgInboundEntry[] = ids.map((sgId) => {
      const data = byId.get(sgId);
      if (!data) return { sgId, found: false, rules: [] };
      const nameRaw = data.group_name;
      return {
        sgId,
        found: true,
        groupName: typeof nameRaw === 'string' && nameRaw ? nameRaw : undefined,
        rules: parseRules(data.ip_permissions),
      };
    });
    return Response.json({ groups });
  } catch (e) {
    console.error('sg inbound: query failed:', e);
    return Response.json({ status: 'error', message: 'query failed' }, { status: 500 });
  }
}
