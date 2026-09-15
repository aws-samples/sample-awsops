'use client';
import { useCallback, useEffect, useMemo, useRef, useState, Suspense, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import ServiceNetworkTopology from '@/components/topology/ServiceNetworkTopology';
import { Globe, Cloud, Network, Target as TargetIcon, Shield, CircleHelp, MoreHorizontal, Server, Zap, Hexagon, Boxes, Circle, Copy, Sparkles, Search, Webhook, Archive, type LucideIcon } from 'lucide-react';
import { Background, Controls, MiniMap, Position, type Node, type Edge, type ReactFlowInstance } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import PageHeader from '@/components/ui/PageHeader';
import RefreshButton from '@/components/ui/RefreshButton';
import DetailPanel from '@/components/ui/DetailPanel';
import { INVENTORY_TYPES } from '@/lib/inventory-types';
import { buildFlowGraph, filterFromEntry, type FlowInput, type FlowKind, type FlowNode } from '@/lib/flow-topology';
import { layoutFlow } from '@/lib/flow-layout';
import { fetchEksIpMap, inventoryEvidence, type EksIpResolution, type InventoryEvidence, type AggregateRunStatus } from '@/lib/topology-config';
import { useTheme } from '@/lib/use-theme';
import { useActiveScope } from '@/lib/account-context';
import { useI18n } from '@/components/shell/LanguageProvider';

// ReactFlow touches the DOM on mount — load it client-only to avoid SSR mismatch.
const ReactFlow = dynamic(() => import('@xyflow/react').then((m) => m.ReactFlow), { ssr: false });

const TYPES = ['route53', 'cloudfront', 'alb', 'nlb', 'target_group', 'waf', 'ec2', 'lambda', 'ecs_task', 's3', 'subnet',
  'apigatewayv2_api', 'apigatewayv2_integration', 'cloudfront_vpc_origin', 'apigatewayv2_route', 'alb_listener_rule'] as const;
type InvType = (typeof TYPES)[number];
type Row = Record<string, unknown>;

// InvType → FlowInput key (target_group→tg, ecs_task→ecsTask). ec2/lambda/ecs enrich target labels.
// s3 resolves CloudFront S3 origins; apigatewayv2_* resolve execute-api origins → API GW → Lambda/LB;
// cloudfront_vpc_origin resolves CloudFront VPC origins → internal ALB/NLB.
type RowKey = 'route53' | 'cloudfront' | 'alb' | 'nlb' | 'tg' | 'waf' | 'ec2' | 'lambda' | 'ecsTask' | 's3' | 'subnet'
  | 'apigatewayv2_api' | 'apigatewayv2_integration' | 'cloudfront_vpc_origin' | 'apigatewayv2_route' | 'alb_listener_rule';
const FLOW_KEY: Record<InvType, RowKey> = {
  route53: 'route53', cloudfront: 'cloudfront', alb: 'alb', nlb: 'nlb', target_group: 'tg', waf: 'waf',
  ec2: 'ec2', lambda: 'lambda', ecs_task: 'ecsTask', s3: 's3', subnet: 'subnet',
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

// Legend labels per kind (gap L248 — the MapLegend precedent: English technical labels).
const FLOW_KIND_LABELS: Record<FlowKind, string> = {
  route53: 'Route53', cloudfront: 'CloudFront', alb: 'ALB', nlb: 'NLB', tg: 'Target Group',
  waf: 'WAF', apigw: 'API Gateway', lambda: 'Lambda', target: 'Target', origin: 'Origin', more: 'More',
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
const RESOLVED_ICON: Record<string, IconC> = { eks: Hexagon, ecs: Boxes, ec2: Server, lambda: Zap, ambiguous: CircleHelp };

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
const INVENTORY_LANES = 2; // Shared max:3 PG pool also serves authentication and other reads.
const CRITICAL_PAGES = 20;
const CRITICAL_TYPES = new Set<string>(['target_group', 'ecs_task', 'subnet']);
const rowLimit = (type: string) => ROW_CAP * (CRITICAL_TYPES.has(type) ? CRITICAL_PAGES : 1);
const ISSUE_STATUSES = ['failed', 'partial'] as const;
type InventoryIssue = { type: string; status: typeof ISSUE_STATUSES[number] };
const EVIDENCE_COPY = {
  en: {
    capture: 'Capture range (last-success fallback):', unknown: 'unknown', missingCapture: 'Some capture times unknown',
    healthUnknown: 'Run health unknown for this account scope',
    inventoryScope: 'Inventory uses account selection; region filters are not applied here.',
    eksScope: 'EKS ownership scope: configured region', eksOtherRegions: 'other regions are not assessed',
    eksNotConnected: 'Not-connected clusters not queried',
    limit: 'Response limit reached; coverage may be incomplete',
    failures: { failed: 'failed', partial: 'partial' },
    runs: 'Aggregate sync runs:', issues: 'Aggregate sync issues:', reads: 'Inventory read failures:',
    statuses: { succeeded: 'succeeded', running: 'running', partial: 'partial', failed: 'failed', unknown: 'unknown' },
    eks: { failed: 'EKS ownership read failed', partial: 'EKS ownership evidence is partial',
      not_attempted: 'EKS ownership was not attempted for this account scope' },
  },
  ko: {
    capture: '수집 시각 범위 (최근 성공 시각으로 보완):', unknown: '미확인', missingCapture: '일부 수집 시각 미확인',
    healthUnknown: '이 계정 범위의 수집 실행 상태는 미확인',
    inventoryScope: '인벤토리는 계정 선택을 사용하며 리전 필터는 여기에서 적용하지 않습니다.',
    eksScope: 'EKS 소유 근거 범위: 설정된 리전', eksOtherRegions: '다른 리전은 평가하지 않음',
    eksNotConnected: '연결되지 않아 조회하지 않은 클러스터',
    limit: '응답 상한 도달 — 일부 정보가 누락될 수 있음',
    failures: { failed: '실패', partial: '부분 수집' },
    runs: '전체 계정 집계 수집:', issues: '집계 수집 문제:', reads: '인벤토리 조회 실패:',
    statuses: { succeeded: '성공', running: '진행 중', partial: '부분 수집', failed: '실패', unknown: '미확인' },
    eks: { failed: 'EKS 소유 근거 조회 실패', partial: 'EKS 소유 근거가 일부만 확인됨',
      not_attempted: '이 계정 범위에서는 EKS 소유 근거를 조회하지 않음' },
  },
  ja: {
    capture: '取得時刻の範囲（最終成功時刻で補完）:', unknown: '不明', missingCapture: '一部の取得時刻が不明',
    healthUnknown: 'このアカウント範囲の収集実行状態は不明',
    inventoryScope: 'インベントリは選択したアカウントを使用し、ここではリージョンフィルターを適用しません。',
    eksScope: 'EKS所有情報の範囲: 設定リージョン', eksOtherRegions: '他のリージョンは未評価',
    eksNotConnected: '未接続のため取得していないクラスター',
    limit: '応答上限に到達 — 情報が不足している可能性があります',
    failures: { failed: '失敗', partial: '部分収集' },
    runs: '全アカウント集計の収集:', issues: '集計収集の問題:', reads: 'インベントリ取得失敗:',
    statuses: { succeeded: '成功', running: '実行中', partial: '部分収集', failed: '失敗', unknown: '不明' },
    eks: { failed: 'EKS所有情報の取得に失敗', partial: 'EKS所有情報は一部のみ確認済み',
      not_attempted: 'このアカウント範囲ではEKS所有情報を取得していません' },
  },
  zh: {
    capture: '采集时间范围（最近成功时间作为回退）:', unknown: '未知', missingCapture: '部分采集时间未知',
    healthUnknown: '此账户范围的采集运行状态未知',
    inventoryScope: '资产清单使用所选账户，此处不应用区域筛选。',
    eksScope: 'EKS归属范围：配置区域', eksOtherRegions: '其他区域未评估',
    eksNotConnected: '未连接且未查询的集群',
    limit: '已达到响应上限 — 覆盖范围可能不完整',
    failures: { failed: '失败', partial: '部分采集' },
    runs: '所有账户汇总采集:', issues: '汇总采集问题:', reads: '资产清单读取失败:',
    statuses: { succeeded: '成功', running: '运行中', partial: '部分采集', failed: '失败', unknown: '未知' },
    eks: { failed: 'EKS归属信息读取失败', partial: 'EKS归属证据不完整',
      not_attempted: '此账户范围未尝试读取EKS归属信息' },
  },
};

const record = (v: unknown): v is Row => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonempty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

async function fetchType(t: InvType | 'vpc' | 'security_group', account: string, signal: AbortSignal): Promise<InventoryEvidence & { rows: Row[]; finishedAt: string | null; capped: boolean; incomplete?: boolean }> {
  const critical = CRITICAL_TYPES.has(t);
  const rows: Row[] = [], seen = new Set<string>();
  let version: string | undefined, finishedAt: string | null = null;
  let firstRun: Row | null = null;
  const result = (capped: boolean, incomplete = false) => ({ rows, finishedAt, capped, incomplete, ...inventoryEvidence(rows, firstRun, account === 'self') });
  try {
    for (let page = 0; page < (critical ? CRITICAL_PAGES : 1); page++) {
      if (signal.aborted) throw new Error();
      const qs = new URLSearchParams({ limit: String(ROW_CAP), offset: String(page * ROW_CAP), accounts: account });
      const r = await fetch(`/api/inventory/${t}?${qs}`, { signal });
      if (!r.ok) throw new Error();
      const d: unknown = await r.json();
      if (signal.aborted || !record(d) || d.error || d.status === 'error'
        || !Array.isArray(d.rows) || d.rows.length > ROW_CAP) throw new Error();
      const run = record(d.run) ? d.run : null;
      const incomplete = critical && ['running', 'partial', 'failed'].includes(String(run?.status));
      if (critical) {
        if (d.consistency !== 'statement-snapshot') throw new Error();
        // The global type sweep covers every account. Only a stable success permits ownership.
        if (!run || (!incomplete && (run.status !== 'succeeded' || !nonempty(run.finished_at) || !Number.isFinite(Date.parse(run.finished_at))
          || !nonempty(run.last_success_at) || !Number.isFinite(Date.parse(run.last_success_at))
          || !Number.isSafeInteger(run.row_count) || (run.row_count as number) < 0))) throw new Error();
        const current = JSON.stringify([run.status, run.finished_at, run.last_success_at, run.row_count]);
        if (version !== undefined && version !== current) return result(false, true);
        version = current;

      }
      if (page === 0) firstRun = run;
      for (const row of d.rows) {
        if (!record(row) || !record(row.data)) throw new Error();
        if (critical) {
          if (!nonempty(row.account_id) || !nonempty(row.region) || !nonempty(row.resource_id)
            || (account !== '__all__' && !account.split(',').includes(row.account_id))) throw new Error();
          const key = JSON.stringify([row.account_id, row.region, row.resource_id]);
          if (seen.has(key)) throw new Error();
          seen.add(key);
        }
        rows.push({ ...row.data, account_id: row.account_id, resource_id: row.resource_id, region: row.region, captured_at: row.captured_at });
      }
      finishedAt = run && typeof run.finished_at === 'string' ? run.finished_at : null;
      // Keep a bounded cached page during a sweep, without mixing mutable pages or proving absence.
      if (incomplete || d.rows.length < ROW_CAP) return result(false, incomplete);
    }
    return result(true); // 10,000 critical rows still need an end-of-data proof.
  } catch {
    // Fetch/JSON errors can contain response fragments; expose only the fixed type-scoped reason.
    throw new Error(`${t}: invalid inventory response`);
  }
}

// ---- VPC / subnet / security-group id → name resolution (for the detail panel) ----
type NetMaps = { vpc: Map<string, string>; subnet: Map<string, string>; sg: Map<string, string> };
const emptyNetMaps = (): NetMaps => ({ vpc: new Map(), subnet: new Map(), sg: new Map() });

// inventory row {resource_id, data:{...}} → a human name (Name tag / group_name), else the id.
function invName(row: Row): string {
  const tags = (row.tags ?? {}) as Record<string, unknown>;
  return String(tags.Name ?? row.group_name ?? row.title ?? row.name ?? row.resource_id ?? '');
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
  return <Suspense fallback={null}><TopologyScope /></Suspense>;
}

function TopologyScope() {
  const [scope, , ready] = useActiveScope();
  // Remount all graph/detail/evidence state on selection changes. A saved member/all scope
  // must be known before the first load; the hook's hydration default is not a host selection.
  if (!ready) return null;
  const account = Array.isArray(scope.accounts) ? scope.accounts.join(',') : scope.accounts;
  return <ScopedTopologyPage key={account} activeAccount={account} />;
}

function ScopedTopologyPage({ activeAccount }: { activeAccount: string }) {
  const { tt, lang } = useI18n();
  const params = useSearchParams();
  const e2e = params.get('view') === 'e2e';
  const copy = EVIDENCE_COPY[lang];
  const [data, setData] = useState<FlowInput | null>(null);
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [captureThrough, setCaptureThrough] = useState<string | null>(null);
  const [unknownCapture, setUnknownCapture] = useState(false);
  const [collectionIssues, setCollectionIssues] = useState<InventoryIssue[]>([]);
  const [readFailures, setReadFailures] = useState<string[]>([]);
  const [aggregateRuns, setAggregateRuns] = useState<[AggregateRunStatus, number][]>([]);
  const [runHealthUnknown, setRunHealthUnknown] = useState(false);
  const [eksCoverage, setEksCoverage] = useState<{ region: string | null; notConnected: number } | null>(null);
  const [eksStatus, setEksStatus] = useState<'ok' | 'partial' | 'failed' | 'not_attempted'>('not_attempted');
  const [cappedTypes, setCappedTypes] = useState<string[]>([]);
  const [syncIncomplete, setSyncIncomplete] = useState(false);
  const [entryId, setEntryId] = useState<string>('');
  const [clusterFilter, setClusterFilter] = useState<string>('');
  const [selected, setSelected] = useState<FlowNode | null>(null);
  const [query, setQuery] = useState('');
  const [netMaps, setNetMaps] = useState<NetMaps>(emptyNetMaps);
  const loadGeneration = useRef(0);
  const loadAbort = useRef<AbortController | null>(null);
  const displayedAccount = useRef<string | null>(null);
  const displayedHasNodes = useRef(false);
  const [retained, setRetained] = useState(false);
  const [eksResolution, setEksResolution] = useState<EksIpResolution | null>(null);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    const current = () => loadGeneration.current === generation;
    const account = activeAccount || 'self';
    loadAbort.current?.abort();
    const controller = new AbortController();
    loadAbort.current = controller;
    const deadline = setTimeout(() => controller.abort(), 30000);
    setBusy(true);
    if (displayedAccount.current !== account) {
      displayedAccount.current = null;
      displayedHasNodes.current = false;
      setData(null);
      setSelected(null);
      setNetMaps(emptyNetMaps());
      setSyncedAt(null);
      setCappedTypes([]);
      setSyncIncomplete(false);
      setRetained(false);
      setErr('');
      setEksResolution(null);
    }
    try {
      const NET = ['vpc', 'security_group'] as const;
      const read = async (type: InvType | typeof NET[number]) => {
        try { return { ...await fetchType(type, account, controller.signal), readFailed: false, error: '' }; }
        catch { return { rows: [] as Row[], finishedAt: null, capped: false, incomplete: false,
          ...inventoryEvidence([], null, false), readFailed: true, error: `${type}: invalid inventory response` }; }
      };
      const types = [...TYPES, ...NET];
      const results: Awaited<ReturnType<typeof read>>[] = new Array(types.length);
      let next = 0;
      const lane = async () => {
        for (;;) {
          const index = next++;
          if (index >= types.length) return;
          // fetchType stops before issuing a request when aborted; fill every result slot
          // so queued/unread types cannot be mistaken for successful empty inventories.
          results[index] = await read(types[index]);
        }
      };
      const [, eks] = await Promise.all([
        Promise.all(Array.from({ length: INVENTORY_LANES }, lane)),
        account === 'self' ? fetchEksIpMap(controller.signal) : Promise.resolve(null),
      ]);
      if (!current()) return;
      const res = results.slice(0, TYPES.length), net = results.slice(TYPES.length);
      const failed = results.filter(result => result.readFailed);
      setErr(failed.map(result => result.error).join('; '));
      if (res.every(result => result.readFailed)) {
        setRetained(displayedAccount.current === account && displayedHasNodes.current);
        return;
      }
      const readIssue = (type: InvType): 'failed' | 'capped' | undefined => {
        const result = res[TYPES.indexOf(type)];
        return result.readFailed || result.incomplete ? 'failed' : result.capped ? 'capped' : undefined;
      };
      const out: FlowInput = { ipResolved: eks?.map, ownershipRead: {
        targetGroup: readIssue('target_group'), ecsTask: readIssue('ecs_task'), subnet: readIssue('subnet'),
        eksScopes: eks?.blockedScopes, eksUnknown: eks?.globalUnknown,
        ...(account === 'self' ? { eksRegions: eks?.coveredRegions } : { configurationOnly: true }),
      } };
      TYPES.forEach((t, i) => { out[FLOW_KEY[t]] = res[i].rows; });
      const nextHasNodes = buildFlowGraph(out).nodes.length > 0;
      const incomplete = res.some(result => result.incomplete);
      if (!nextHasNodes && (failed.length > 0 || incomplete)
        && displayedAccount.current === account && displayedHasNodes.current) {
        setRetained(true);
        return;
      }
      const mk = (rows: Row[]) => new Map(rows.map(row => [String(row.resource_id), invName(row)]));
      setNetMaps({ vpc: mk(net[0].rows), sg: mk(net[1].rows), subnet: mk(res[TYPES.indexOf('subnet')].rows) });
      let oldest: string | null = null, newest: string | null = null;
      const capped: string[] = [];
      results.forEach((r, i) => {
        if (r.capturedAt && (!oldest || Date.parse(r.capturedAt) < Date.parse(oldest))) oldest = r.capturedAt;
        if (r.capturedThrough && (!newest || Date.parse(r.capturedThrough) > Date.parse(newest))) newest = r.capturedThrough;
        if (r.capped) capped.push(types[i]);
      });
      setData(out);
      setSyncIncomplete(incomplete);
      setEksResolution(eks);
      displayedAccount.current = account;
      displayedHasNodes.current = nextHasNodes;
      setCaptureThrough(newest);
      setUnknownCapture(results.some(r => r.rows.length > 0 && r.unknownCapture));
      setRunHealthUnknown(account !== 'self' || results.some(r => !r.readFailed && r.aggregateStatus === 'unknown'));
      setEksStatus(!eks ? 'not_attempted' : eks.globalUnknown ? 'failed' : eks.blockedScopes.length ? 'partial' : 'ok');
      setEksCoverage(eks ? { region: eks.coveredRegions[0] ?? null, notConnected: eks.notConnected ?? 0 } : null);
      const counts = new Map<AggregateRunStatus, number>();
      results.filter(r => !r.readFailed).forEach(r => counts.set(r.aggregateStatus, (counts.get(r.aggregateStatus) ?? 0) + 1));
      setAggregateRuns([...counts]);
      setReadFailures(results.flatMap((r, i) => r.readFailed ? [types[i]] : []));
      setCollectionIssues(results.flatMap((r, i) => {
        const status = ISSUE_STATUSES.find(value => value === r.aggregateStatus);
        return status ? [{ type: types[i], status }] : [];
      }));
      setSelected(null);
      setRetained(false);
      setSyncedAt(oldest);
      setCappedTypes(capped);
    } catch {
      if (current()) {
        setErr('topology: invalid inventory response');
        setRetained(displayedAccount.current === account && displayedHasNodes.current);
      }
    } finally {
      clearTimeout(deadline);
      if (current()) setBusy(false);
    }
  }, [activeAccount]);

  useEffect(() => { void load(); return () => { loadGeneration.current += 1; loadAbort.current?.abort(); }; }, [load]);

  const urlCluster = params.get('cluster') ?? '';
  useEffect(() => { setClusterFilter(urlCluster); setSelected(null); }, [urlCluster]);

  const dark = useTheme() === 'dark';

  const full = useMemo(() => (data ? buildFlowGraph(data) : { nodes: [], edges: [] }), [data]);

  // Color legend (gap L248): kind chips for the kinds present in the loaded graph. Target nodes
  // are colored by HEALTH (not kind), so targets contribute health chips instead of a kind chip;
  // an unknown health falls back to the neutral target kind chip (same as nodeColors).
  const legend = useMemo(() => {
    const kinds = new Set<FlowKind>();
    const healths = new Set<string>();
    for (const n of full.nodes) {
      const h = n.kind === 'target' ? String(n.meta?.health ?? 'unknown') : '';
      if (n.kind === 'target' && h in HEALTH_LIGHT) healths.add(h);
      else kinds.add(n.kind);
    }
    return { kinds: [...kinds], healths: [...healths] };
  }, [full]);

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

  const scopedGraph = useMemo(() => {
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

    return gFull;
  }, [full, entryId, clusterFilter]);

  const { nodes, edges } = useMemo(() => {
    if (e2e) return { nodes: [], edges: [] };
    const gFull = scopedGraph;
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
  }, [scopedGraph, dark, selected, e2e]);

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
      for (const k of ['cluster', 'namespace', 'service', 'workload', 'ecsService', 'task', 'pod', 'ambiguity', 'ownership_evidence', 'ownership_reason', 'candidate', 'targetCapturedAt'] as const) {
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

  // Keep the same collection evidence in both views. Retained/in-flight inventory remains
  // visible context, but must not promote an observed endpoint to a configured identity.
  const identityBlocked = busy || retained || !!err || syncIncomplete || readFailures.length > 0
    || cappedTypes.length > 0 || collectionIssues.length > 0;
  const correlationGraph = useMemo(() => identityBlocked ? {
    ...scopedGraph, nodes: scopedGraph.nodes.map(node => node.kind === 'target'
      ? { ...node, meta: { ...node.meta, e2e_correlation_blocked: true } } : node),
  } : scopedGraph, [scopedGraph, identityBlocked]);
  const inventoryEvidencePanel = <>
        {err && <div className="text-[13px] text-rose-600">{tt('로드 실패:')} {err}</div>}
        {full.nodes.some(n => n.meta?.ambiguity === 'eks_not_enumerated') && <div role="status" className="text-[13px] text-warning">
          {tt('EKS 조회 범위 밖의 대상은 소유권 미확인입니다. 조회 리전:')} {eksResolution?.coveredRegions.join(', ')}
        </div>}
        {(eksResolution?.status === 'unavailable' || eksResolution?.status === 'partial') && <div role="alert" aria-label={tt('EKS 식별 상태')} className="text-[13px] text-warning">
          {eksResolution.reasons.length > 0 && eksResolution.reasons.every(reason => reason === 'cluster_not_connected')
            ? copy.eksNotConnected : tt('EKS 조회 실패 또는 수집 범위 제한으로 IP 소유자를 확인할 수 없습니다.')} ({eksResolution.reasons.join(', ')})
        </div>}
        {(data?.ownershipRead?.targetGroup || data?.ownershipRead?.ecsTask || data?.ownershipRead?.subnet) && <div role="status" className="text-[13px] text-warning">
          {tt(syncIncomplete ? '인벤토리 동기화가 완료되지 않아 IP 소유권을 확인할 수 없습니다.' : '인벤토리 조회 실패 또는 행 수 제한으로 IP 소유권을 확인할 수 없습니다.')}
        </div>}
        {retained && <div role="status" className="text-[13px] text-warning">{tt('조회 실패로 이전 결과를 표시합니다.')}</div>}
        {!data && !err && <div className="text-ink-400">{tt('로딩 중…')}</div>}
        {data && <div aria-label="Inventory collection evidence" className="text-[12px] text-ink-400">
          <div>{copy.inventoryScope}</div>
          <span>{copy.capture} {syncedAt ? new Date(syncedAt).toLocaleString() : copy.unknown}</span>
          {captureThrough && captureThrough !== syncedAt && <span> – {new Date(captureThrough).toLocaleString()}</span>}
          {unknownCapture && <span> · {copy.missingCapture}</span>}
          {aggregateRuns.length > 0 && <div>{copy.runs} {aggregateRuns.map(([status, count]) => `${copy.statuses[status]} (${count})`).join(', ')}</div>}
          {readFailures.length > 0 && <div role="status">{copy.reads} {readFailures.map(type => `${type}: ${copy.failures.failed}`).join(', ')}</div>}
          {collectionIssues.length > 0 && <div role="status">{copy.issues} {collectionIssues.map(issue => `${issue.type}: ${copy.failures[issue.status]}`).join(', ')}</div>}
          {runHealthUnknown && <div>{copy.healthUnknown}</div>}
          {eksCoverage && <div>{copy.eksScope} {eksCoverage.region ?? copy.unknown}; {copy.eksOtherRegions}</div>}
          {!!eksCoverage?.notConnected && <div>{copy.eksNotConnected}: {eksCoverage.notConnected}</div>}
          {eksStatus !== 'ok' && <div>{copy.eks[eksStatus]}</div>}
          {cappedTypes.length > 0 && <div className="text-warning">{copy.limit}: {cappedTypes.map(type => `${type} (${rowLimit(type)})`).join(', ')}</div>}
        </div>}
  </>;
  const viewHref = (view: boolean) => {
    const next = new URLSearchParams(params.toString());
    if (view) next.set('view', 'e2e'); else next.delete('view');
    return `/topology${next.size ? `?${next}` : ''}`;
  };
  if (e2e) return <ServiceNetworkTopology configured={correlationGraph} account={activeAccount}
    configuration={{ loading: busy || (!data && !err), capturedAt: syncedAt, error: '',
      failedTypes: [], cappedTypes: [] }} evidence={inventoryEvidencePanel}
    backHref={viewHref(false)} onRefresh={() => void load()} />;

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
            <RefreshButton busy={busy} onClick={load} capturedAt={captureThrough} />
            <Link href={viewHref(true)} className="rounded-md border border-ink-200 bg-card px-2 py-1 text-[12px] text-ink-600 hover:bg-ink-50">
              {tt('서비스 + 네트워크 →')}
            </Link>
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
        {inventoryEvidencePanel}
        {data && (
          full.nodes.length === 0 ? (
            !err && <div className="rounded-md border border-ink-100 bg-ink-50 px-3 py-3 text-[13px] text-ink-400">
              {tt('그래프로 그릴 리소스가 없습니다. (cloudfront/alb/nlb/target_group sync 확인 — target_group은 steampipe 동기화 후 채워집니다.)')}
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-400">
                <span>{tt(`노드 ${nodes.length} · 엣지 ${edges.length}`)}</span>
                {syncedAt && <span>{tt('인벤토리 동기화:')} {new Date(syncedAt).toLocaleString()}</span>}

                {/* kind/health color legend (gap L248) — the same fills the nodes render. */}
                {legend.kinds.map((k) => {
                  const [bg, border] = (dark ? KIND_DARK : KIND_LIGHT)[k];
                  return (
                    <span key={k} className="inline-flex items-center gap-1">
                      <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: bg, border: `1px solid ${border}` }} />
                      {FLOW_KIND_LABELS[k]}
                    </span>
                  );
                })}
                {legend.healths.map((h) => {
                  const [bg, border] = (dark ? HEALTH_DARK : HEALTH_LIGHT)[h];
                  return (
                    <span key={h} className="inline-flex items-center gap-1">
                      <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: bg, border: `1px solid ${border}` }} />
                      {`Target · ${h}`}
                    </span>
                  );
                })}
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
