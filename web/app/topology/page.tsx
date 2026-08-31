'use client';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { Globe, Cloud, Network, Target as TargetIcon, Shield, CircleHelp, MoreHorizontal, Server, Zap, Hexagon, Boxes, Circle, Copy, Sparkles, Search, Webhook, Archive, type LucideIcon } from 'lucide-react';
import { Background, Controls, MiniMap, Position, type Node, type Edge, type ReactFlowInstance } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import PageHeader from '@/components/ui/PageHeader';
import RefreshButton from '@/components/ui/RefreshButton';
import DetailPanel from '@/components/ui/DetailPanel';
import { INVENTORY_TYPES } from '@/lib/inventory-types';
import { buildFlowGraph, filterFromEntry, type FlowInput, type FlowKind, type FlowNode } from '@/lib/flow-topology';
import { layoutFlow } from '@/lib/flow-layout';
import { useTheme } from '@/lib/use-theme';
import { useActiveAccount } from '@/lib/account-context';
import { useI18n } from '@/components/shell/LanguageProvider';

// ReactFlow touches the DOM on mount — load it client-only to avoid SSR mismatch.
const ReactFlow = dynamic(() => import('@xyflow/react').then((m) => m.ReactFlow), { ssr: false });

const TYPES = ['route53', 'cloudfront', 'alb', 'nlb', 'target_group', 'waf', 'ec2', 'lambda', 'ecs_task', 's3',
  'apigatewayv2_api', 'apigatewayv2_integration', 'cloudfront_vpc_origin', 'apigatewayv2_route', 'alb_listener_rule'] as const;
type InvType = (typeof TYPES)[number];
type Row = Record<string, unknown>;

// InvType → FlowInput key (target_group→tg, ecs_task→ecsTask). ec2/lambda/ecs enrich target labels.
// s3 resolves CloudFront S3 origins; apigatewayv2_* resolve execute-api origins → API GW → Lambda/LB;
// cloudfront_vpc_origin resolves CloudFront VPC origins → internal ALB/NLB.
type RowKey = 'route53' | 'cloudfront' | 'alb' | 'nlb' | 'tg' | 'waf' | 'ec2' | 'lambda' | 'ecsTask' | 's3'
  | 'apigatewayv2_api' | 'apigatewayv2_integration' | 'cloudfront_vpc_origin' | 'apigatewayv2_route' | 'alb_listener_rule';
const FLOW_KEY: Record<InvType, RowKey> = {
  route53: 'route53', cloudfront: 'cloudfront', alb: 'alb', nlb: 'nlb', target_group: 'tg', waf: 'waf',
  ec2: 'ec2', lambda: 'lambda', ecs_task: 'ecsTask', s3: 's3',
  apigatewayv2_api: 'apigatewayv2_api', apigatewayv2_integration: 'apigatewayv2_integration',
  cloudfront_vpc_origin: 'cloudfront_vpc_origin',
  apigatewayv2_route: 'apigatewayv2_route', alb_listener_rule: 'alb_listener_rule',
};

// Node fill/border per FlowKind. Light + dark variants (ReactFlow dark colorMode flips default
// node text to light, so dark nodes get explicit dark fills + light text). Target nodes are
// colored by health instead (see HEALTH).
const KIND_LIGHT: Record<FlowKind, [string, string]> = {
  route53: ['#E6F6EC', '#2E9E5B'], cloudfront: ['#E6EEFE', '#3D6FB5'], alb: ['#FEF3E2', '#C8902F'], nlb: ['#FEF3E2', '#C8902F'],
  tg: ['#F1E9FF', '#8A5BD0'], waf: ['#FDECE8', '#C85A45'], target: ['#EBEFF2', '#AFBAC3'],
  origin: ['#EBEFF2', '#AFBAC3'], more: ['#EBEFF2', '#AFBAC3'],
  apigw: ['#E6EEFE', '#3D6FB5'], lambda: ['#FEF3E2', '#C8902F'],
};
const KIND_DARK: Record<FlowKind, [string, string]> = {
  route53: ['#0E2E1C', '#2E9E5B'], cloudfront: ['#16243E', '#3D6FB5'], alb: ['#33260C', '#C8902F'], nlb: ['#33260C', '#C8902F'],
  tg: ['#241A3E', '#8A5BD0'], waf: ['#331410', '#C85A45'], target: ['#1F262D', '#586773'],
  origin: ['#1F262D', '#586773'], more: ['#1F262D', '#586773'],
  apigw: ['#16243E', '#3D6FB5'], lambda: ['#33260C', '#C8902F'],
};
const HEALTH_LIGHT: Record<string, [string, string]> = {
  healthy: ['#E6F6F2', '#01A88D'], unhealthy: ['#FDECE8', '#D13212'],
  draining: ['#FEF3E2', '#F59E0B'], initial: ['#FEF3E2', '#F59E0B'],
};
const HEALTH_DARK: Record<string, [string, string]> = {
  healthy: ['#0E2E2A', '#2CC9AE'], unhealthy: ['#3A1712', '#F26B4D'],
  draining: ['#33260C', '#F5B53C'], initial: ['#33260C', '#F5B53C'],
};

function nodeColors(n: FlowNode, dark: boolean): [string, string] {
  if (n.kind === 'target') {
    const h = String(n.meta?.health ?? 'unknown');
    const map = dark ? HEALTH_DARK : HEALTH_LIGHT;
    return map[h] ?? (dark ? KIND_DARK.target : KIND_LIGHT.target);
  }
  return (dark ? KIND_DARK : KIND_LIGHT)[n.kind];
}

type IconC = LucideIcon;
const KIND_ICON: Record<FlowKind, IconC> = {
  route53: Globe, cloudfront: Cloud, alb: Network, nlb: Network, tg: TargetIcon,
  waf: Shield, target: Circle, origin: CircleHelp, more: MoreHorizontal,
  apigw: Webhook, lambda: Zap,
};
// target sub-icon by resolved backend: EKS pod / EC2 / Lambda, else a generic dot.
const RESOLVED_ICON: Record<string, IconC> = { eks: Hexagon, ecs: Boxes, ec2: Server, lambda: Zap };

function iconFor(n: FlowNode): IconC {
  if (n.kind === 'target') return RESOLVED_ICON[String(n.meta?.resolved ?? '')] ?? Circle;
  if (n.kind === 'origin' && n.meta?.service === 's3') return Archive; // S3 origin = bucket (matches Sidebar s3 icon)
  return KIND_ICON[n.kind];
}

// Preset AI questions per resource kind. Each pins the RIGHT section-agent (`section`) so the
// composer routes via `/section` — e.g. SG checks go to `network` (which has describe-security-
// groups / describe-network-interfaces-by-ip), NOT `security` (IAM-only) which the '보안' keyword
// would otherwise first-match.
interface Chip { q: string; section: string }
function chipsFor(n: FlowNode): Chip[] {
  const net = (q: string): Chip => ({ q, section: 'network' });
  const sec = (q: string): Chip => ({ q, section: 'security' });
  const mon = (q: string): Chip => ({ q, section: 'monitoring' });
  const con = (q: string): Chip => ({ q, section: 'container' });
  switch (n.kind) {
    case 'cloudfront': return [net('이 배포가 오리진과 TLS로 통신하나?'), net('WAF 연결 점검'), net('캐시/TLS 정책 점검')];
    case 'alb': case 'nlb': return [net('CloudFront→이 LB 통신이 TLS인가?'), net('리스너/타깃 health 원인'), net('이 LB 보안그룹(인바운드) 점검')];
    case 'tg': return [net('unhealthy 타깃 원인 진단'), net('헬스체크 설정 점검')];
    case 'target': {
      const r = String(n.meta?.resolved ?? '');
      if (r === 'eks') return [con('이 deployment 상태/이벤트 진단'), mon('관련 pod 로그 필터'), sec('IAM/RBAC 권한 점검')];
      if (r === 'ecs') return [con('이 서비스 task 상태/배포 진단'), mon('컨테이너 로그 필터'), sec('task role 권한 점검')];
      if (r === 'lambda') return [mon('이 함수 최근 에러 로그'), sec('IAM 권한 점검'), con('동시성/타임아웃 점검')];
      return [net('이 IP의 보안그룹 점검'), net('이 IP가 속한 인스턴스/ENI 확인'), mon('관련 로그 필터')];
    }
    case 'waf': return [sec('이 WAF 룰 점검'), mon('차단 로그 추이')];
    case 'route53': return [net('이 레코드 대상 도달성 점검')];
    default: return [net('이 리소스 네트워크/보안그룹 점검'), mon('관련 로그 필터')];
  }
}

function nodeLabel(n: FlowNode): ReactNode {
  const Icon = iconFor(n);
  const health = n.kind === 'target' && n.meta?.health ? ` (${n.meta.health})` : '';
  return (
    <span className="flex items-center gap-1.5">
      <Icon size={13} className="shrink-0 opacity-80" />
      <span className="truncate">{n.label}{health}</span>
    </span>
  );
}

const ROW_CAP = 500; // /api/inventory caps limit at 500

async function fetchType(t: InvType, account: string): Promise<{ rows: Row[]; finishedAt: string | null; capped: boolean }> {
  // account scope: 'self' | 12-digit | '__all__' — the inventory read route's `accounts` param.
  const r = await fetch(`/api/inventory/${t}?limit=${ROW_CAP}&accounts=${encodeURIComponent(account)}`);
  if (!r.ok) return { rows: [], finishedAt: null, capped: false };
  const d = await r.json();
  const rows = (d.rows ?? []) as { resource_id: unknown; region: unknown; data?: object }[];
  return {
    rows: rows.map((x) => ({ resource_id: x.resource_id, region: x.region, ...(x.data ?? {}) })),
    finishedAt: d.run?.finished_at ?? null,
    capped: rows.length >= ROW_CAP, // hit the cap → more rows exist, surfaced below (no silent truncation)
  };
}

// Resolve ALB/NLB ip targets to EKS workloads: for each connected cluster, map pod IP →
// "namespace/workload" (Deployment). Best-effort — failures per cluster are skipped.
async function fetchEksIpMap(): Promise<NonNullable<FlowInput['ipResolved']>> {
  const map: NonNullable<FlowInput['ipResolved']> = {};
  try {
    const list = await fetch('/api/eks').then((r) => (r.ok ? r.json() : null));
    // NOTE: /api/eks returns { clusters: [...] } (matches the EKS page + fleet). Reading `rows` here
    // silently yielded [] → EKS pod resolution never ran (every EKS ip-target showed as a raw IP).
    const clusters: string[] = (list?.clusters ?? [])
      .filter((c: { access?: string }) => c.access === 'connected')
      .map((c: { name?: string }) => c.name)
      .filter(Boolean);
    await Promise.all(clusters.map(async (name) => {
      try {
        const get = (kind: string) => fetch(`/api/eks/${name}/incluster?kind=${kind}`).then((x) => (x.ok ? x.json() : null));
        const [eps, pods] = await Promise.all([get('endpoints'), get('pods')]);
        // pod IP → owning workload (fallback when an IP isn't fronted by a Service)
        const podByIp = new Map<string, { podIP?: string; namespace?: string; name?: string; workload?: string }>();
        for (const p of (pods?.rows ?? []) as { podIP?: string; namespace?: string; name?: string; workload?: string }[]) {
          if (p.podIP) podByIp.set(p.podIP, p);
        }
        // Service mapping (preferred): an Endpoints object's name == the Service name; its addresses
        // are the backing pod IPs. More stable than the pod/workload — a TG ip-target fronts a Service.
        for (const e of (eps?.rows ?? []) as { name?: string; namespace?: string; ips?: string[] }[]) {
          for (const ip of e.ips ?? []) {
            const pod = podByIp.get(ip);
            map[ip] = {
              label: `${e.namespace ?? ''}/${e.name ?? ''}`,
              resolved: 'eks',
              meta: { cluster: name, namespace: e.namespace, service: e.name, pod: pod?.name, workload: pod?.workload },
            };
          }
        }
        for (const [ip, p] of podByIp) {
          if (!map[ip]) map[ip] = {
            label: `${p.namespace ?? ''}/${p.workload || p.name || ''}`,
            resolved: 'eks',
            meta: { cluster: name, namespace: p.namespace, workload: p.workload, pod: p.name },
          };
        }
      } catch { /* skip this cluster */ }
    }));
  } catch { /* no EKS resolution */ }
  return map;
}

// ---- VPC / subnet / security-group id → name resolution (for the detail panel) ----
type NetMaps = { vpc: Map<string, string>; subnet: Map<string, string>; sg: Map<string, string> };
const emptyNetMaps = (): NetMaps => ({ vpc: new Map(), subnet: new Map(), sg: new Map() });

// inventory row {resource_id, data:{...}} → a human name (Name tag / group_name), else the id.
function invName(invRow: { resource_id?: unknown; data?: Record<string, unknown> }): string {
  const d = invRow.data ?? {};
  const tags = (d.tags ?? {}) as Record<string, unknown>;
  return String(tags.Name ?? d.group_name ?? d.title ?? d.name ?? invRow.resource_id ?? '');
}
// pull ids from the many shapes a row uses: 'sg-x' | {GroupId} | {SubnetId} | {Id} | availability_zones[].SubnetId
function idsFrom(v: unknown): string[] {
  if (v == null) return [];
  return (Array.isArray(v) ? v : [v])
    .map((x) => {
      if (typeof x === 'string') return x;
      const o = (x ?? {}) as Record<string, unknown>;
      return String(o.GroupId ?? o.group_id ?? o.SubnetId ?? o.subnet_id ?? o.Id ?? '');
    })
    .filter(Boolean);
}
const withName = (id: string, m: Map<string, string>): string => {
  const n = m.get(id);
  return n && n !== id ? `${n} (${id})` : id;
};
// resolved VPC/subnet/SG names for a resource row (added alongside the raw ids in the detail panel)
function networkNames(row: Record<string, unknown>, nm: NetMaps): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const vpcId = String(row.vpc_id ?? '');
  if (vpcId) out.vpc_name = withName(vpcId, nm.vpc);
  const subnetIds = [...new Set([...idsFrom(row.subnet_id), ...idsFrom(row.subnet_ids), ...idsFrom(row.subnets), ...idsFrom(row.availability_zones)])];
  if (subnetIds.length) out.subnet_names = subnetIds.map((id) => withName(id, nm.subnet));
  const sgIds = [...new Set([...idsFrom(row.security_groups), ...idsFrom(row.security_group_ids), ...idsFrom(row.vpc_security_group_ids)])];
  if (sgIds.length) out.security_group_names = sgIds.map((id) => withName(id, nm.sg));
  return out;
}

export default function TopologyPage() {
  const { tt } = useI18n();
  const [activeAccount] = useActiveAccount();
  const [data, setData] = useState<FlowInput | null>(null);
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [capturedAt, setCapturedAt] = useState<string | null>(null);
  const [cappedTypes, setCappedTypes] = useState<string[]>([]);
  const [entryId, setEntryId] = useState<string>('');
  const [clusterFilter, setClusterFilter] = useState<string>('');
  const [selected, setSelected] = useState<FlowNode | null>(null);
  const [query, setQuery] = useState('');
  const [netMaps, setNetMaps] = useState<NetMaps>(emptyNetMaps);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const account = activeAccount || 'self';
      const NET = ['vpc', 'subnet', 'security_group'] as const;
      const [res, ipResolved, net] = await Promise.all([
        Promise.all(TYPES.map((t) => fetchType(t, account))),
        fetchEksIpMap(),
        // VPC/subnet/SG inventory → id→name maps for the detail panel (lookup only, not graph nodes)
        Promise.all(NET.map((t) => fetch(`/api/inventory/${t}?limit=500&accounts=${encodeURIComponent(account)}`).then((r) => (r.ok ? r.json() : { rows: [] })).catch(() => ({ rows: [] })))),
      ]);
      const mk = (rows: { resource_id?: unknown; data?: Record<string, unknown> }[]) =>
        new Map((rows ?? []).map((r) => [String(r.resource_id), invName(r)]));
      setNetMaps({ vpc: mk(net[0]?.rows), subnet: mk(net[1]?.rows), sg: mk(net[2]?.rows) });
      const out: FlowInput = { ipResolved };
      let newest: string | null = null;
      const capped: string[] = [];
      TYPES.forEach((t, i) => {
        out[FLOW_KEY[t]] = res[i].rows;
        const f = res[i].finishedAt;
        if (f && (!newest || f > newest)) newest = f;
        if (res[i].capped) capped.push(t);
      });
      setData(out);
      setSyncedAt(newest);
      setCappedTypes(capped);
      setErr('');
      setCapturedAt(new Date().toISOString());
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }, [activeAccount]);

  useEffect(() => { load(); }, [load]);

  // Deep-link from the service map (/topology/services): ?cluster=<resolved:name> seeds the cluster
  // filter so a trace workload click lands on this cluster's request path. Reads directly from
  // window.location (no useSearchParams → no Suspense boundary needed for the standalone build).
  // Also re-reads on popstate so browser back/forward after the filter changes tracks the URL.
  useEffect(() => {
    const read = () => setClusterFilter(new URLSearchParams(window.location.search).get('cluster') ?? '');
    read();
    window.addEventListener('popstate', read);
    return () => window.removeEventListener('popstate', read);
  }, []);

  const dark = useTheme() === 'dark';

  const full = useMemo(() => (data ? buildFlowGraph(data) : { nodes: [], edges: [] }), [data]);

  // Resource-name search: match nodes by label or id (case-insensitive); selecting one focuses it
  // (reuses the focus collapse + re-center). Capped so the dropdown stays usable on big graphs.
  const searchMatches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [] as FlowNode[];
    return full.nodes.filter((n) => n.label.toLowerCase().includes(q) || n.id.toLowerCase().includes(q)).slice(0, 10);
  }, [full, query]);

  // Entry-point options (CloudFront distributions, then load balancers).
  const entryOptions = useMemo(() => ({
    cf: full.nodes.filter((n) => n.kind === 'cloudfront'),
    lb: full.nodes.filter((n) => n.kind === 'alb' || n.kind === 'nlb'),
  }), [full]);

  // EKS/ECS cluster names, read off the same target-node meta.cluster the detail panel already
  // shows (set by fetchEksIpMap / ecsIpMap) — one option per distinct cluster, labeled by backend kind.
  const clusterOptions = useMemo(() => {
    // Keyed by `${resolved}:${cluster}`, not cluster name alone — an EKS and an ECS cluster can
    // share the same name, and a name-only key would merge them into one option/filter value.
    const seen = new Map<string, { cluster: string; resolved: string }>();
    for (const n of full.nodes) {
      if (n.kind !== 'target') continue;
      const cluster = n.meta?.cluster;
      if (typeof cluster === 'string' && cluster) {
        const resolved = String(n.meta?.resolved ?? '');
        const key = `${resolved}:${cluster}`;
        if (!seen.has(key)) seen.set(key, { cluster, resolved });
      }
    }
    return [...seen.entries()].map(([key, v]) => ({ key, ...v }));
  }, [full]);

  const { nodes, edges } = useMemo(() => {
    let gFull = filterFromEntry(full, entryId || null);

    // Cluster filter: keep target nodes belonging to the selected cluster + every upstream
    // ancestor (route53→cloudfront→lb→tg→target), so the request path into the cluster stays
    // legible. Ancestors are found by walking edges backward (target→source) from the matches.
    if (clusterFilter) {
      const matches = gFull.nodes.filter((n) => n.kind === 'target' && `${n.meta?.resolved ?? ''}:${n.meta?.cluster ?? ''}` === clusterFilter);
      const incoming = new Map<string, string[]>();
      for (const e of gFull.edges) {
        (incoming.get(e.target) ?? incoming.set(e.target, []).get(e.target)!).push(e.source);
      }
      const keep = new Set(matches.map((n) => n.id));
      const queue = matches.map((n) => n.id);
      while (queue.length) {
        const cur = queue.shift()!;
        for (const src of incoming.get(cur) ?? []) if (!keep.has(src)) { keep.add(src); queue.push(src); }
      }
      gFull = { nodes: gFull.nodes.filter((n) => keep.has(n.id)), edges: gFull.edges.filter((e) => keep.has(e.source) && keep.has(e.target)) };
    }

    // Focus: clicking a node collapses the view to ITS connected path (up + downstream), then
    // re-lays-out and re-centers (imperative fitView in the effect below) so the active subgraph
    // fills the screen — instead of dimming the rest and letting it overflow/clip off one screen.
    const focusId = selected?.id ?? null;
    let g = gFull;
    if (focusId && gFull.nodes.some((n) => n.id === focusId)) {
      const adj = new Map<string, string[]>();
      for (const e of gFull.edges) {
        (adj.get(e.source) ?? adj.set(e.source, []).get(e.source)!).push(e.target);
        (adj.get(e.target) ?? adj.set(e.target, []).get(e.target)!).push(e.source);
      }
      const connected = new Set([focusId]);
      const q = [focusId];
      while (q.length) { const c = q.shift()!; for (const nb of adj.get(c) ?? []) if (!connected.has(nb)) { connected.add(nb); q.push(nb); } }
      g = {
        nodes: gFull.nodes.filter((n) => connected.has(n.id)),
        edges: gFull.edges.filter((e) => connected.has(e.source) && connected.has(e.target)),
      };
    }
    // In focus mode lay out top→bottom (TB): the active path is a thin chain that fits the tall,
    // narrow column left of the docked detail panel far better than a wide LR row. Full graph = LR.
    const rankdir: 'LR' | 'TB' = focusId ? 'TB' : 'LR';
    const pos = Object.fromEntries(layoutFlow(g, { rankdir }).map((p) => [p.id, p]));

    const nodes: Node[] = g.nodes.map((n) => {
      const [bg, border] = nodeColors(n, dark);
      const p = pos[n.id] ?? { x: 0, y: 0 };
      return {
        id: n.id,
        position: { x: p.x, y: p.y },
        data: { label: nodeLabel(n), fnode: n },
        // handles must follow rankdir: LR → left/right, TB → top/bottom, or edges leave the wrong
        // sides and the smoothstep routing loops back ugly.
        sourcePosition: rankdir === 'TB' ? Position.Bottom : Position.Right,
        targetPosition: rankdir === 'TB' ? Position.Top : Position.Left,
        style: {
          background: bg,
          border: `${n.id === focusId ? '2px solid' : n.kind === 'origin' && n.meta?.unresolved ? '1px dashed' : '1px solid'} ${border}`,
          color: dark ? '#E3E9EE' : '#16202A',
          borderRadius: 8, fontSize: 11, padding: 6, width: 220,
        },
      };
    });
    const edges: Edge[] = g.edges.map((e) => ({
      id: e.id, source: e.source, target: e.target,
      animated: focusId != null, // in focus mode every shown edge is on the active path
      // L7 routing detail (ALB path/host :port, API GW route_key) shown as the edge label.
      ...(e.label ? { label: e.label, labelStyle: { fontSize: 9, fill: '#586773' } } : {}),
      // confidence convention: observed = solid, inferred (Spec 2) = dashed.
      style: e.confidence === 'inferred' ? { strokeDasharray: '4 4' } : {},
    }));
    return { nodes, edges };
  }, [full, entryId, clusterFilter, dark, selected]);

  // Re-center imperatively (NOT by remounting — a remount destroys the user's pan/zoom and makes
  // dragging feel broken). Keep one mounted instance; refit when the entry filter or focus changes.
  // rAF defers the fit until after the detail panel has docked and the layout has settled.
  const rfRef = useRef<ReactFlowInstance<Node, Edge> | null>(null);
  useEffect(() => {
    const id = requestAnimationFrame(() => rfRef.current?.fitView({ padding: 0.2, duration: 300, maxZoom: 1.2 }));
    return () => cancelAnimationFrame(id);
  }, [entryId, clusterFilter, selected?.id]);

  // Detail for the clicked node: resource nodes show their full inventory row (every field —
  // vpc, subnet, tags …); target/origin nodes synthesize a small detail from their meta.
  const detail = useMemo(() => {
    if (!selected) return null;
    const m = (selected.meta ?? {}) as Record<string, unknown>;
    if (m.row) {
      const row = m.row as Record<string, unknown>;
      // enrich with resolved VPC/subnet/SG names (added next to the raw ids already in the row)
      return { title: String(row.resource_id ?? selected.label), data: { ...row, ...networkNames(row, netMaps) }, spec: m.invType ? INVENTORY_TYPES[m.invType as string] : undefined };
    }
    const syn: Record<string, unknown> = { resource_id: String(m.id ?? selected.label), kind: selected.kind };
    if (selected.kind === 'target') {
      syn.target_type = m.targetType; syn.health = m.health; syn.port = m.port;
      if (m.resolved) syn.resolved_as = m.resolved;
      // EKS/ECS resolution detail (cluster / namespace / service / workload), when present
      for (const k of ['cluster', 'namespace', 'service', 'workload', 'ecsService', 'task', 'pod'] as const) {
        if (m[k] != null && m[k] !== '') syn[k] = m[k];
      }
      // grouped node (ASG/replicas/tasks): show the member count + health summary + the IP list
      if (m.count != null) {
        syn.targets = m.count;
        if (m.healthSummary) syn.health = m.healthSummary;
        if (Array.isArray(m.members)) syn.member_ips = m.members;
        if (m.membersTruncated) syn.more_members = m.membersTruncated;
      }
    }
    return { title: selected.label, data: syn, spec: undefined };
  }, [selected, netMaps]);

  const onEntry = (e: React.ChangeEvent<HTMLSelectElement>) => setEntryId(e.target.value);
  const onCluster = (e: React.ChangeEvent<HTMLSelectElement>) => { setClusterFilter(e.target.value); setSelected(null); };
  // max-w bounds the select so a long CloudFront/LB option label can't blow the toolbar width out
  // and crush the PageHeader title/subtitle (which would wrap the subtitle one char per line).
  const selectCls = 'max-w-[170px] rounded-md border border-ink-200 bg-card px-2 py-1 text-[12px] text-ink-700';

  // "Ask AI about this resource" bridge → seeds the chat composer (user reviews + sends).
  const resourceArn = (n: FlowNode): string => {
    const m = (n.meta ?? {}) as Record<string, unknown>;
    const row = m.row as Record<string, unknown> | undefined;
    // route53 has no ARN → clean record name; targets (ec2/lambda/ip) → meta.id; everything
    // else → the real `arn` field (CF/ALB/NLB/TG/WAF all carry one), not the resource_id/name.
    if (n.kind === 'route53') return String(row?.name ?? n.label).replace(/\.$/, '');
    return String(row?.arn ?? m.id ?? row?.resource_id ?? n.label);
  };
  const askAI = (q: string, section?: string) => {
    if (!selected) return;
    const m = (selected.meta ?? {}) as Record<string, unknown>;
    const row = (m.row ?? {}) as Record<string, unknown>;
    // ground the agent with known facts so it doesn't have to guess the target.
    const facts = [
      row.vpc_id ? `vpc: ${row.vpc_id}` : '',
      row.subnet_id ? `subnet: ${row.subnet_id}` : '',
      row.private_ip_address ? `private_ip: ${row.private_ip_address}` : '',
      m.cluster ? `cluster: ${m.cluster}` : '',
    ].filter(Boolean).join(' · ');
    // pin the section (/network etc.) so routing isn't hijacked by keyword first-match.
    const prefix = section ? `/${section} ` : '';
    const ctx = `${prefix}[토폴로지 리소스] ${selected.kind} · ${selected.label}\nID/ARN: ${resourceArn(selected)}${facts ? `\n${facts}` : ''}\n\n질문: ${q}`;
    window.dispatchEvent(new CustomEvent('awsops:open-chat', { detail: { prompt: ctx } }));
  };
  const copyArn = () => { if (selected) navigator.clipboard?.writeText(resourceArn(selected)); };

  // resource-relationship graph link — only for network-placed resource types (have vpc/subnet/sg).
  const NET_CAPABLE = new Set(['alb', 'nlb', 'target_group', 'ec2', 'lambda', 'ecs_task']);
  const sm = (selected?.meta ?? {}) as Record<string, unknown>;
  const smRow = (sm.row ?? {}) as Record<string, unknown>;
  const rgId = sm.invType && NET_CAPABLE.has(String(sm.invType)) && smRow.resource_id
    ? `${sm.invType}:${smRow.resource_id}` : null;
  const detailActions = selected ? (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <button type="button" onClick={copyArn}
          className="inline-flex items-center gap-1 rounded-md border border-ink-200 bg-card px-2 py-1 text-[11px] text-ink-600 hover:bg-ink-50">
          <Copy size={12} /> {tt('ARN 복사')}
        </button>
        <button type="button" onClick={() => askAI('')}
          className="inline-flex items-center gap-1 rounded-md bg-brand-action px-2.5 py-1 text-[11px] font-medium text-white hover:bg-brand-action-hover">
          <Sparkles size={12} /> {tt('AI에 질문')}
        </button>
        {rgId && (
          <a href={`/topology/resource/${encodeURIComponent(rgId)}`}
            className="inline-flex items-center gap-1 rounded-md border border-ink-200 bg-card px-2 py-1 text-[11px] text-ink-600 hover:bg-ink-50">
            <Network size={12} /> {tt('관계 그래프')}
          </a>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {chipsFor(selected).map((c) => (
          <button type="button" key={c.q} onClick={() => askAI(c.q, c.section)}
            className="rounded-full border border-brand-200 bg-brand-50 px-2.5 py-1 text-[11px] text-brand-700 hover:bg-brand-100">
            {tt(c.q)}
          </button>
        ))}
      </div>
    </div>
  ) : undefined;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Topology"
        subtitle="요청 흐름 그래프 (Route53 → CloudFront → LB → Target Group → 타깃)"
        right={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <div className="relative">
              <div className="flex items-center gap-1 rounded-md border border-ink-200 bg-card px-2 py-1">
                <Search size={13} className="text-ink-400" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && searchMatches[0]) { setSelected(searchMatches[0]); setQuery(''); }
                    if (e.key === 'Escape') setQuery('');
                  }}
                  placeholder={tt('리소스 이름 검색…')}
                  className="w-44 bg-transparent text-[12px] text-ink-700 outline-none placeholder:text-ink-300"
                />
              </div>
              {searchMatches.length > 0 && (
                <ul className="absolute right-0 z-20 mt-1 max-h-72 w-72 overflow-auto rounded-md border border-ink-200 bg-card py-1 shadow-pop">
                  {searchMatches.map((n) => (
                    <li key={n.id}>
                      <button
                        type="button"
                        onClick={() => { setSelected(n); setQuery(''); }}
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-ink-700 hover:bg-ink-50"
                      >
                        <span className="truncate">{n.label}</span>
                        <span className="ml-auto shrink-0 text-[10px] uppercase text-ink-400">{n.kind}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <select className={selectCls} value={entryOptions.cf.some((n) => n.id === entryId) ? entryId : ''} onChange={onEntry}>
              <option value="">{tt('CloudFront: 전체')}</option>
              {entryOptions.cf.map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}
            </select>
            <select className={selectCls} value={entryOptions.lb.some((n) => n.id === entryId) ? entryId : ''} onChange={onEntry}>
              <option value="">{tt('LB: 전체')}</option>
              {entryOptions.lb.map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}
            </select>
            <select className={selectCls} value={clusterFilter} onChange={onCluster}>
              <option value="">{tt('Cluster: 전체')}</option>
              {clusterOptions.map((c) => (
                <option key={c.key} value={c.key}>{c.resolved ? `${c.resolved.toUpperCase()} · ${c.cluster}` : c.cluster}</option>
              ))}
            </select>
            <RefreshButton busy={busy} onClick={load} capturedAt={capturedAt} />
            <Link href="/topology/infra" className="rounded-md border border-ink-200 bg-card px-2 py-1 text-[12px] text-ink-600 hover:bg-ink-50">
              {tt('인프라 배치 →')}
            </Link>
            <Link href="/topology/services" className="rounded-md border border-ink-200 bg-card px-2 py-1 text-[12px] text-ink-600 hover:bg-ink-50">
              {tt('서비스 맵 →')}
            </Link>
          </div>
        }
      />
      <div className="flex-1 min-h-0 flex flex-col gap-4 px-8 py-6">
        {err && <div className="text-[13px] text-rose-600">{tt('로드 실패:')} {err}</div>}
        {!data && !err && <div className="text-ink-400">{tt('로딩 중…')}</div>}
        {data && !err && (
          full.nodes.length === 0 ? (
            <div className="rounded-md border border-ink-100 bg-ink-50 px-3 py-3 text-[13px] text-ink-400">
              {tt('그래프로 그릴 리소스가 없습니다. (cloudfront/alb/nlb/target_group sync 확인 — target_group은 steampipe 동기화 후 채워집니다.)')}
            </div>
          ) : (
            <>
              <div className="flex items-center gap-3 text-[12px] text-ink-400">
                <span>{tt(`노드 ${nodes.length} · 엣지 ${edges.length}`)}</span>
                {syncedAt && <span>{tt('인벤토리 동기화:')} {new Date(syncedAt).toLocaleString()}</span>}
                {cappedTypes.length > 0 && (
                  <span className="text-warning">{tt(`⚠ ${cappedTypes.join(', ')} ${ROW_CAP}개 초과 — 일부만 표시`)}</span>
                )}
              </div>
              <div className="flex-1 min-h-0 w-full rounded-lg border border-ink-100 bg-card">
                <ReactFlow nodes={nodes} edges={edges} fitView fitViewOptions={{ padding: 0.2 }} colorMode={dark ? 'dark' : 'light'} proOptions={{ hideAttribution: true }}
                  onInit={(inst) => { rfRef.current = inst; }}
                  onNodeClick={(_, node) => setSelected(((node.data as { fnode?: FlowNode })?.fnode) ?? null)}
                  onPaneClick={() => setSelected(null)}>
                  <Background />
                  <Controls />
                  <MiniMap pannable zoomable />
                </ReactFlow>
              </div>
            </>
          )
        )}
      </div>
      {detail && (
        <DetailPanel title={detail.title} data={detail.data} spec={detail.spec} actions={detailActions} onClose={() => setSelected(null)} modal={false} />
      )}
    </div>
  );
}
