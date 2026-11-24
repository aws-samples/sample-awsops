'use client';

// Site view (`/topology?view=site&host=&path=`): one host's request flow from DNS to datastores.
// Data loading lives in useSiteFlowData.ts; this component owns URL state, the host/path inputs, the two-stage
// composition and the disclosures:
//  - stage 1 (inventory + pod bindings) only finds the clusters the host's flow binds; their trace overlays and
//    db-refs are then read per cluster ARN and the final flow is built once they all land. While they load, the
//    `trace_unavailable` / `db_refs_partial` gaps stage 1 necessarily carries are not shown (evidence pending).
//  - the composed SiteFlow is memoized on its real inputs, so typing in the host box, opening a detail panel or a
//    theme switch never hands the canvas a new flow. A path change hands it a flow with the same structure (the
//    canvas only re-highlights in place); evidence landing changes the structure (the canvas re-lays out from the
//    known positions). The canvas is keyed by host: a new host starts a fresh instance and layout.
//  - the path box updates `?path=` with a debounced history replace while typing and pushes on Enter.
//  - every SiteGap has one notice; withheld pod bindings add a notice per reason.
//  - the refresh button re-runs every load (useSiteInventory `reload`), keeping the current flow on screen meanwhile.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import PageHeader from '@/components/ui/PageHeader';
import DetailPanel from '@/components/ui/DetailPanel';
import SiteFlowCanvas from '@/components/topology/SiteFlowCanvas';
import { useClusterEvidence, useSiteInventory, type SiteInventory } from '@/components/topology/useSiteFlowData';
import type { Fleet } from '@/lib/eks-fleet';
import { buildSiteFlow, normalizeHost, siteHosts, type SiteFlow, type SiteGap, type SiteKind, type SiteNode } from '@/lib/site-flow';
import { INVENTORY_TYPES } from '@/lib/inventory-types';
import { isComposingKey } from '@/lib/ime';
import { useTheme } from '@/lib/use-theme';
import { useI18n } from '@/components/shell/LanguageProvider';
import { eksClusterLabel } from '@/lib/eks-cluster-id';

/** One notice per SiteGap (Korean source, translated via tt(); lockstep-tested). `host_not_found` is followed by the
 *  searched host, like `binding_scope_blocked` by its cluster labels. */
export const GAP_NOTICE: Record<SiteGap, string> = {
  inventory_incomplete: '일부 인벤토리를 조회하지 못했거나 동기화가 끝나지 않아 흐름이 일부만 표시될 수 있습니다.',
  pods_unresolved: '일부 대상의 Pod를 확인하지 못해 워크로드 대신 대상으로 표시합니다. 조회 범위 밖의 클러스터이거나, 클러스터 네트워크(VPC)를 알 수 없거나, Pod 식별 근거가 부족한 경우입니다.',
  trace_unavailable: '트레이스를 읽지 못해 서비스 간 호출을 표시하지 않습니다.',
  ambiguous_cluster: '같은 이름의 클러스터가 여러 개라 트레이스 호출을 클러스터에 연결할 수 없습니다.',
  incomplete_listing: '클러스터 목록이 일부만 조회되어 트레이스 호출을 연결하지 않습니다.',
  partial_snapshot: '트레이스 스냅샷이 일부만 수집되어 트레이스 호출을 표시하지 않습니다.',
  route_unavailable: '경로별 트레이스 집계를 읽지 못해 경로 강조가 이름 기반 추론에 머뭅니다.',
  db_refs_partial: '일부 워크로드의 데이터 저장소 참조를 읽지 못해 데이터 저장소 연결이 일부만 표시됩니다.',
  host_not_found: '인벤토리에서 다음 호스트를 찾지 못했습니다:',
  behaviors_unavailable: 'CloudFront 캐시 동작을 읽지 못해 경로별 동작을 표시하지 않습니다.',
  route_ambiguous: '요청 경로에 맞는 API 경로가 여러 개라 하나로 강조하지 않습니다.',
  trace_unmapped: '일부 트레이스 호출을 워크로드나 데이터 저장소에 연결하지 못해 생략했습니다.',
  private_zone_only: '프라이빗 호스팅 영역에만 있는 호스트라 공개 요청 경로를 강조하지 않습니다.',
  rule_unresolved: '로드 밸런서 리스너 규칙을 확인하지 못해 경로 강조가 일부에서 멈춥니다.',
  path_unmatched: '요청 경로에 맞는 캐시 동작이나 리스너 규칙이 없습니다.',
};

/** Why pod bindings were withheld or narrowed (fetchEksIpMap bindingRead reasons; Korean source, lockstep-tested).
 *  `binding_scope_blocked` (status `partial`) is followed by the blocked cluster labels. */
export const BINDING_NOTICE: Record<string, string> = {
  binding_scope_partial: '선택한 범위에 연결된 EKS 클러스터가 없어 전체 리전 EKS 목록만 확인했습니다. 이 목록은 일부 리전만 포함하므로 Pod 식별 근거를 사용하지 않습니다.',
  binding_read_incomplete: '일부 EKS 클러스터를 읽지 못했거나 연결되지 않아 Pod 식별 근거를 사용하지 않습니다.',
  binding_clock_unknown: 'Pod 조회 시각을 확인할 수 없어 Pod 식별 근거를 사용하지 않습니다.',
  binding_rows_invalid: 'Pod 조회 결과 형식이 올바르지 않아 Pod 식별 근거를 사용하지 않습니다.',
  binding_limit: 'Pod 수가 상한을 넘어 Pod 식별 근거를 사용하지 않습니다.',
  binding_authority_unverified: '클러스터 ARN을 확인할 수 없어 Pod 식별 근거를 사용하지 않습니다.',
  cluster_unreadable: 'EKS 클러스터 목록을 읽지 못했거나 클러스터 정보(VPC 등)가 없어 Pod 식별 근거를 사용하지 않습니다.',
  cluster_limit_possible: 'EKS 클러스터 목록이 상한에 도달해 Pod 식별 근거를 사용하지 않습니다.',
  binding_fleet_incomplete: 'EKS 클러스터 전체 목록을 확인하지 못해 조회할 리전을 정할 수 없으므로 Pod 식별 근거를 사용하지 않습니다.',
  binding_scope_blocked: '연결되지 않았거나 읽지 못한 EKS 클러스터가 있어 그 클러스터의 네트워크(VPC)에 있는 Pod는 확인하지 않습니다:',
  binding_deadline: 'EKS 조회가 제한 시간(30초) 안에 끝나지 않아 Pod 식별 근거를 사용하지 않습니다. 새로고침으로 다시 시도하세요.',
};
const BINDING_FALLBACK = 'Pod 식별 근거를 확인할 수 없습니다.';

/** Gaps stage 1 always carries for bound clusters until their evidence lands. */
const PENDING_ARTIFACTS = new Set<SiteGap>(['trace_unavailable', 'db_refs_partial']);
const KIND_ORDER: SiteKind[] = ['dns', 'cdn', 'behavior', 'rule', 'origin', 'lb', 'tg', 'target', 'workload', 'service', 'datastore'];
// Technical kind labels stay English (FLOW_KIND_LABELS precedent).
const KIND_LABEL: Record<SiteKind, string> = {
  dns: 'DNS', cdn: 'CloudFront', behavior: 'Behavior', rule: 'Rule', origin: 'Origin', lb: 'LB', tg: 'Target Group',
  target: 'Target', workload: 'Workload', service: 'Service', datastore: 'Datastore',
};
const HOST_LIST_CAP = 50;
const PATH_DEBOUNCE_MS = 400;
const inputCls = 'rounded-md border border-ink-200 bg-card px-2 py-1 text-[12px] text-ink-700 outline-none';

/** Listed id for K8s links: bare name for host default-region clusters, else the ARN. */
const listedId = (arn: string, fleet: Fleet | null) => fleet?.clusters.find((c) => c.arn === arn)?.id ?? arn;

function detailOf(node: SiteNode, inv: SiteInventory | null): { title: string; data: Record<string, unknown>; spec?: (typeof INVENTORY_TYPES)[string] } {
  if (node.kind === 'workload' || node.kind === 'service') {
    return { title: node.label, data: { kind: node.kind, cluster: node.ref?.cluster, namespace: node.ref?.namespace, workload: node.ref?.workload,
      account: node.account, region: node.region } };
  }
  if (node.kind === 'datastore') {
    return { title: node.label, data: { resource_id: node.label, type: node.group?.replace(/^datastore:/, ''), account: node.account, region: node.region } };
  }
  const flowNode = inv?.flow.nodes.find((n) => n.id === node.ref?.flowNodeId);
  if (node.kind === 'behavior' || (node.kind === 'origin' && flowNode?.kind === 'cloudfront')) {
    return { title: node.label, data: { kind: node.kind, [node.kind === 'behavior' ? 'path_pattern' : 'origin_id']: node.label,
      distribution: flowNode?.label ?? node.ref?.flowNodeId } };
  }
  const meta = (flowNode?.meta ?? {}) as Record<string, unknown>;
  if (meta.row && typeof meta.row === 'object') {
    const row = meta.row as Record<string, unknown>;
    return { title: String(row.resource_id ?? node.label), data: row, spec: meta.invType ? INVENTORY_TYPES[String(meta.invType)] : undefined };
  }
  const data: Record<string, unknown> = { resource_id: String(meta.id ?? node.label), kind: flowNode?.kind ?? node.kind };
  for (const k of ['target_type', 'targetType', 'health', 'port', 'resolved', 'cluster', 'namespace', 'workload', 'pod', 'ambiguity', 'ownership_reason', 'count', 'members']) {
    if (meta[k] != null && meta[k] !== '') data[k] = meta[k];
  }
  return { title: node.label, data };
}

/** The highlighted chain as a text list (accessible / narrow-screen fallback), in request order; inferred hops labelled. */
export function HighlightChain({ flow }: { flow: SiteFlow }) {
  const { tt } = useI18n();
  const chain = useMemo(() => {
    if (!flow.highlight) return [];
    const byId = new Map(flow.nodes.map((n) => [n.id, n]));
    const inferred = new Set(flow.highlight.inferred);
    return [...flow.highlight.nodes, ...flow.highlight.inferred].flatMap((id) => {
      const n = byId.get(id);
      return n ? [{ node: n, inferred: inferred.has(id) }] : [];
    }).sort((a, b) => KIND_ORDER.indexOf(a.node.kind) - KIND_ORDER.indexOf(b.node.kind) || a.node.label.localeCompare(b.node.label));
  }, [flow]);
  if (!chain.length) return <p className="text-[12px] text-ink-500">{tt('이 경로로 강조할 요청 흐름이 없습니다.')}</p>;
  return (
    <section aria-label={tt('강조된 요청 경로')} className="text-[12px] text-ink-600">
      <h2 className="mb-1 font-semibold">{`${tt('강조된 요청 경로')}: ${flow.path ?? ''}`}</h2>
      <ol className="list-decimal space-y-0.5 pl-5">
        {chain.map(({ node, inferred }) => (
          <li key={node.id}>
            <span className="text-ink-400">{KIND_LABEL[node.kind]}</span> {node.label}
            {inferred && <span className="ml-1 text-warning-text">{`(${tt('추론')})`}</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}

export default function SiteFlowView({ inventoryScope }: { inventoryScope: string }) {
  const { tt } = useI18n();
  const rawTheme = useTheme();
  const theme = rawTheme === 'dark' ? 'dark' as const : 'light' as const;
  const router = useRouter();
  const params = useSearchParams() ?? new URLSearchParams();
  const host = normalizeHost(params.get('host') ?? '');
  const urlPath = params.get('path') ?? '';
  const paramsKey = params.toString();

  const [reload, setReload] = useState(0);
  const inv = useSiteInventory(inventoryScope, reload);
  const data = inv.data;
  const hosts = useMemo(() => (data ? siteHosts(data.flow) : []), [data]);
  const baseGaps = useMemo<SiteGap[]>(() => (data?.issues.length ? ['inventory_incomplete'] : []), [data]);

  // Stage 1: which clusters does this host bind? (path-independent)
  const stage1 = useMemo(() => (data && host ? buildSiteFlow({ host, flow: data.flow, cloudfrontRows: data.cloudfrontRows,
    bindings: data.bindings, traces: [], dbRefs: [], gaps: baseGaps }) : null), [data, host, baseGaps]);
  const arns = useMemo(() => [...new Set((stage1?.nodes ?? []).flatMap((n) => (n.kind === 'workload' && n.ref?.cluster ? [n.ref.cluster] : [])))].sort(),
    [stage1]);
  const ev = useClusterEvidence(arns, inv.fleet);

  const flow = useMemo<SiteFlow | null>(() => (data && host ? buildSiteFlow({ host, path: urlPath, flow: data.flow,
    cloudfrontRows: data.cloudfrontRows, bindings: data.bindings, traces: ev.traces, dbRefs: ev.dbRefs, gaps: baseGaps }) : null),
  [data, host, urlPath, ev.traces, ev.dbRefs, baseGaps]);

  // ---- URL state ----
  const hrefWith = useCallback((next: { host?: string; path?: string }) => {
    const q = new URLSearchParams(paramsKey);
    q.set('view', 'site');
    for (const k of ['host', 'path'] as const) {
      const v = next[k];
      if (v === undefined) continue;
      if (v) q.set(k, v); else q.delete(k);
    }
    return `/topology?${q}`;
  }, [paramsKey]);

  const pathTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hostDraft, setHostDraft] = useState(host);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  useEffect(() => { setHostDraft(host); }, [host]);
  const hostMatches = useMemo(() => {
    const q = hostDraft.trim().toLowerCase();
    return (q && q !== host ? hosts.filter((h) => h.host.includes(q)) : hosts).slice(0, HOST_LIST_CAP);
  }, [hosts, hostDraft, host]);
  const chooseHost = (h: string) => {
    const next = normalizeHost(h);
    if (pathTimer.current) clearTimeout(pathTimer.current); // a pending path replace must not navigate back
    setOpen(false); setActive(-1); setHostDraft(next);
    if (next !== host) router.push(hrefWith({ host: next }), { scroll: false });
  };
  const onHostKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((i) => Math.min(i + 1, hostMatches.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Escape') { setOpen(false); setActive(-1); }
    else if (e.key === 'Enter' && !isComposingKey(e)) {
      e.preventDefault();
      const pick = open && active >= 0 ? hostMatches[active]?.host : hostDraft;
      if (pick?.trim()) chooseHost(pick);
    }
  };

  const [pathDraft, setPathDraft] = useState(urlPath);
  useEffect(() => { setPathDraft(urlPath); }, [urlPath]);
  useEffect(() => () => { if (pathTimer.current) clearTimeout(pathTimer.current); }, []);
  const onPathChange = (value: string) => {
    setPathDraft(value);
    if (pathTimer.current) clearTimeout(pathTimer.current);
    pathTimer.current = setTimeout(() => router.replace(hrefWith({ path: value.trim() }), { scroll: false }), PATH_DEBOUNCE_MS);
  };
  const onPathKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || isComposingKey(e)) return;
    e.preventDefault();
    if (pathTimer.current) clearTimeout(pathTimer.current);
    router.push(hrefWith({ path: pathDraft.trim() }), { scroll: false });
  };

  // ---- detail panel ----
  const [selected, setSelected] = useState<SiteNode | null>(null);
  const onSelect = useCallback((node: SiteNode) => setSelected(node), []);
  // A rebuilt flow (e.g. evidence landing) keeps the panel open while the selected node still exists.
  useEffect(() => { setSelected((cur) => (cur && flow?.nodes.find((n) => n.id === cur.id)) || null); }, [flow]);
  const detail = selected ? detailOf(selected, data) : null;
  const k8sHref = selected && (selected.kind === 'workload' || selected.kind === 'service') && selected.ref?.cluster
    ? `/topology/infra?${new URLSearchParams({ view: 'k8s', cluster: listedId(selected.ref.cluster, inv.fleet) })}` : null;

  // ---- disclosures ----
  const evidencePending = inv.pending || (!!host && ev.pending);
  const notices: string[] = [];
  for (const g of flow?.gaps ?? []) {
    if (ev.pending && PENDING_ARTIFACTS.has(g)) continue;
    if (g === 'inventory_incomplete' && data?.issues.length) {
      notices.push(`${tt(GAP_NOTICE[g])} (${data.issues.map((i) => `${i.type}: ${i.issue}`).join(', ')})`);
    } else if (g === 'db_refs_partial' && ev.failedDbRefs.length) {
      notices.push(`${tt(GAP_NOTICE[g])} (${ev.failedDbRefs.map(eksClusterLabel).join(', ')})`);
    } else if (g === 'host_not_found') {
      notices.push(`${tt(GAP_NOTICE[g])} ${flow?.host ?? host}`); // the searched (normalized) host follows the colon
    } else notices.push(tt(GAP_NOTICE[g]));
  }
  // Inventory read issues are disclosed even without a host flow (host index).
  if (data?.issues.length && !flow?.gaps.includes('inventory_incomplete')) {
    notices.unshift(`${tt(GAP_NOTICE.inventory_incomplete)} (${data.issues.map((i) => `${i.type}: ${i.issue}`).join(', ')})`);
  }
  const bindingRead = data?.eks?.bindingRead;
  if (flow?.gaps.includes('pods_unresolved') && bindingRead?.status === 'withheld') {
    const reasons = bindingRead.reasons.length ? bindingRead.reasons : ['cluster_unreadable'];
    for (const r of reasons) notices.push(BINDING_NOTICE[r] ? tt(BINDING_NOTICE[r]) : `${tt(BINDING_FALLBACK)} (${r})`);
  }
  if (bindingRead?.status === 'partial') {
    notices.push(`${tt(BINDING_NOTICE.binding_scope_blocked)} ${(bindingRead.blockedClusters ?? []).map(eksClusterLabel).join(', ')}`);
  }

  const listId = 'site-host-options';
  return (
    <div className="flex h-full min-w-0 flex-col overflow-y-auto">
      <PageHeader
        title={tt('사이트 흐름')}
        subtitle={tt('호스트 하나의 요청 흐름 (DNS → CloudFront → LB → 워크로드 → 데이터 저장소)')}
        className="lg:flex-col lg:items-stretch"
        right={
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <div className="relative">
              <input
                role="combobox"
                aria-label={tt('사이트 호스트')}
                aria-expanded={open && hostMatches.length > 0}
                aria-controls={listId}
                aria-autocomplete="list"
                aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
                value={hostDraft}
                onChange={(e) => { setHostDraft(e.target.value); setOpen(true); setActive(-1); }}
                onFocus={() => setOpen(true)}
                onBlur={() => setOpen(false)}
                onKeyDown={onHostKey}
                placeholder={tt('호스트 검색…')}
                className={`w-64 ${inputCls}`}
              />
              {open && hostMatches.length > 0 && (
                <ul id={listId} role="listbox" aria-label={tt('사이트 호스트')}
                  className="absolute left-0 z-20 mt-1 max-h-72 w-80 overflow-auto rounded-md border border-ink-200 bg-card py-1 shadow-pop">
                  {hostMatches.map((h, i) => (
                    <li key={h.host} id={`${listId}-${i}`} role="option" aria-selected={i === active}
                      onMouseDown={(e) => { e.preventDefault(); chooseHost(h.host); }}
                      className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[12px] text-ink-700 ${i === active ? 'bg-ink-50' : 'hover:bg-ink-50'}`}>
                      <span className="truncate">{h.host}</span>
                      <span className="ml-auto shrink-0 text-[10px] text-ink-400">{`${tt('홉')} ${h.hops}`}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <input
              aria-label={tt('요청 경로')}
              value={pathDraft}
              onChange={(e) => onPathChange(e.target.value)}
              onKeyDown={onPathKey}
              placeholder={tt('요청 경로 (예: /products/1)')}
              className={`w-48 ${inputCls}`}
            />
            <button type="button" onClick={() => setReload((r) => r + 1)} disabled={inv.pending}
              className="rounded-md border border-ink-200 bg-card px-2 py-1 text-[12px] text-ink-600 hover:bg-ink-50 disabled:opacity-50">
              {tt('새로고침')}
            </button>
            <Link href="/topology" className="rounded-md border border-ink-200 bg-card px-2 py-1 text-[12px] text-ink-600 hover:bg-ink-50">
              {tt('요청 흐름 그래프 →')}
            </Link>
          </div>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col gap-3 px-8 py-6">
        {evidencePending && <div role="status" className="text-[12px] text-ink-500">{tt('연결 근거(인벤토리·EKS·트레이스·데이터 저장소)를 불러오는 중…')}</div>}
        {inv.error && <div className="text-[13px] text-rose-600">{tt('로드 실패:')} {inv.error}</div>}
        {notices.length > 0 && (
          <div role="status" aria-label={tt('사이트 흐름 근거 상태')} className="flex flex-col gap-0.5 text-[12px] text-warning-text">
            {notices.map((n) => <span key={n}>{n}</span>)}
          </div>
        )}
        {data && !host && (
          <div className="flex flex-col gap-2">
            <p className="text-[13px] text-ink-500">{tt('호스트를 선택하면 해당 사이트의 요청 흐름을 표시합니다.')}</p>
            {hosts.length === 0 ? <p className="text-[13px] text-ink-400">{tt('인벤토리에 표시할 호스트가 없습니다.')}</p> : (
              <ul aria-label={tt('호스트 목록')} className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {hosts.slice(0, HOST_LIST_CAP).map((h) => (
                  <li key={h.host}>
                    <button type="button" onClick={() => chooseHost(h.host)}
                      className="flex w-full min-w-0 items-center gap-2 rounded-lg border border-ink-200 bg-card px-3 py-2 text-left text-[12px] hover:border-brand-400">
                      <span className="truncate font-medium">{h.host}</span>
                      <span className="ml-auto shrink-0 text-[10px] text-ink-400">{`${tt('홉')} ${h.hops}`}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {hosts.length > HOST_LIST_CAP && <p className="text-[12px] text-ink-400">{`+${hosts.length - HOST_LIST_CAP} · ${tt('검색으로 나머지 호스트를 찾으세요.')}`}</p>}
          </div>
        )}
        {flow && flow.nodes.length > 0 && (
          <>
            <SiteFlowCanvas key={flow.host} flow={flow} theme={theme} themeKey={rawTheme} onSelect={onSelect} />
            {flow.path && <HighlightChain flow={flow} />}
          </>
        )}
      </div>
      {detail && (
        <DetailPanel title={detail.title} data={detail.data} spec={detail.spec} modal={false} onClose={() => setSelected(null)}
          actions={k8sHref ? (
            <Link href={k8sHref} className="inline-flex items-center gap-1 rounded-md border border-ink-200 bg-card px-2 py-1 text-[11px] text-ink-600 hover:bg-ink-50">
              {tt('K8s 맵에서 보기 →')}
            </Link>
          ) : undefined} />
      )}
    </div>
  );
}
