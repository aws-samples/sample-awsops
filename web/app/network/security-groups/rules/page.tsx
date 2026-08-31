'use client';
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Download, RefreshCw, Settings2, Waypoints } from 'lucide-react';
import PageHeader from '@/components/ui/PageHeader';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import DataTable from '@/components/ui/DataTable';
import DetailPanel from '@/components/ui/DetailPanel';
import PolicyGraph from '@/components/graph/PolicyGraph';
import { useI18n } from '@/components/shell/LanguageProvider';
import { buildSgRuleGraph } from '@/lib/sg-usage-graph';
import type { RuleRow, RuleStatus } from '@/lib/sg-rules';

// /network/security-groups/rules — SG Rules screen (docs/superpowers/specs/
// 2026-08-13-security-group-rules-usage-design.md "Rules page contents"). Reads GET /api/sg/rules
// (the sg_rule_inventory + sg_rule_activity_daily read model). The "VPC" column/filter (gap 5) reads
// sg_rule_inventory.vpc_id, populated by the daily worker from the ENI-membership snapshot it
// already takes — a rule snapshotted before that fix, or whose SG currently has no attached ENI,
// legitimately has no known VPC yet and renders as a dash rather than a fabricated value.

const STATUSES: RuleStatus[] = ['observed_compatible', 'overlapping', 'no_observed_evidence', 'unassessable', 'not_configured'];
const WINDOWS = [30, 90, 180] as const;

const STATUS_LABEL: Record<RuleStatus, string> = {
  observed_compatible: '관측된 호환 트래픽',
  overlapping: '중첩 매칭 (귀속 불확실)',
  no_observed_evidence: '관측된 증거 없음',
  unassessable: '평가 불가',
  not_configured: '소스 미설정',
};
const STATUS_TONE: Record<RuleStatus, 'positive' | 'brand' | 'neutral' | 'negative'> = {
  observed_compatible: 'positive',
  overlapping: 'brand',
  no_observed_evidence: 'neutral',
  unassessable: 'negative',
  not_configured: 'neutral',
};

function StatusBadge({ status }: { status: RuleStatus }) {
  const { tt } = useI18n();
  return <Badge tone={STATUS_TONE[status]} variant="soft" dot>{tt(STATUS_LABEL[status])}</Badge>;
}

interface Filters {
  accountId: string; region: string; vpcId: string; sgId: string; direction: '' | 'ingress' | 'egress';
  status: '' | RuleStatus; q: string; days: 30 | 90 | 180;
}

function toCsvUrl(f: Filters): string {
  const sp = new URLSearchParams();
  if (f.accountId) sp.set('accountId', f.accountId);
  if (f.region) sp.set('region', f.region);
  if (f.vpcId) sp.set('vpcId', f.vpcId);
  if (f.sgId) sp.set('sgId', f.sgId);
  if (f.direction) sp.set('direction', f.direction);
  if (f.status) sp.set('status', f.status);
  if (f.q) sp.set('q', f.q);
  sp.set('days', String(f.days));
  sp.set('pageSize', '500');
  sp.set('format', 'csv');
  return `/api/sg/rules?${sp.toString()}`;
}

function toApiUrl(f: Filters, page: number): string {
  const sp = new URLSearchParams();
  if (f.accountId) sp.set('accountId', f.accountId);
  if (f.region) sp.set('region', f.region);
  if (f.vpcId) sp.set('vpcId', f.vpcId);
  if (f.sgId) sp.set('sgId', f.sgId);
  if (f.direction) sp.set('direction', f.direction);
  if (f.status) sp.set('status', f.status);
  if (f.q) sp.set('q', f.q);
  sp.set('days', String(f.days));
  sp.set('page', String(page));
  sp.set('pageSize', '50');
  return `/api/sg/rules?${sp.toString()}`;
}

function downloadJson(rows: RuleRow[]) {
  const blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'sg-rules.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Admin-only "Flow Log settings" mini-form (PUT /api/sg/flow-sources) — matches the register/edit
// shape lib/sg-rules.ts's FlowSourceInput expects. Kept intentionally minimal (this page's job is
// the rule table; the full source-management surface is out of scope for this pass).
function FlowSourceForm({ onDone }: { onDone: () => void }) {
  const { tt } = useI18n();
  const [form, setForm] = useState({ accountId: '', region: '', workgroup: '', databaseName: '', tableName: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const submit = async () => {
    setBusy(true); setMsg('');
    try {
      const r = await fetch('/api/sg/flow-sources', {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...form, enabled: true }),
      });
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error(d?.message ?? `HTTP ${r.status}`);
      setMsg(tt('저장됨'));
      onDone();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  return (
    <div className="flex flex-col gap-2 p-3">
      {(['accountId', 'region', 'workgroup', 'databaseName', 'tableName'] as const).map((k) => (
        <input
          key={k}
          placeholder={k}
          value={form[k]}
          onChange={(e) => setForm((p) => ({ ...p, [k]: e.target.value }))}
          className="rounded-md border border-ink-200 bg-card px-2 py-1 text-[12px]"
        />
      ))}
      <div className="flex items-center gap-2">
        <button type="button" disabled={busy} onClick={submit} className="rounded-md bg-brand-500 px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-50">
          {tt('저장')}
        </button>
        {msg && <span className="text-[12px] text-ink-500">{msg}</span>}
      </div>
    </div>
  );
}

// useSearchParams() opts the page into client-side rendering for the part that reads the query
// string (?sg=<id> deep link from Usage) — Next.js requires that read to be wrapped in its own
// Suspense boundary or the whole page fails static prerendering (missing-suspense-with-csr-bailout).
export default function SecurityGroupRulesPage() {
  return (
    <Suspense fallback={null}>
      <SecurityGroupRulesPageInner />
    </Suspense>
  );
}

function SecurityGroupRulesPageInner() {
  const { tt } = useI18n();
  const searchParams = useSearchParams();
  const [filters, setFilters] = useState<Filters>({ accountId: '', region: '', vpcId: '', sgId: '', direction: '', status: '', q: '', days: 90 });
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<RuleRow[]>([]);
  const [total, setTotal] = useState(0);
  const [err, setErr] = useState('');
  const [selected, setSelected] = useState<RuleRow | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [flowFormOpen, setFlowFormOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState('');

  // Deep link from the Usage page (`?sg=<id>`) — degrades client-side into the sgId filter rather
  // than adding a new query param to GET /api/sg/rules (that route already accepts `sgId=`, which
  // this maps onto).
  useEffect(() => {
    const sg = searchParams?.get('sg');
    if (sg) setFilters((f) => ({ ...f, sgId: sg }));
  }, [searchParams]);

  useEffect(() => {
    fetch('/api/me').then((r) => (r.ok ? r.json() : null)).then((d) => { if (d) setIsAdmin(!!d.isAdmin); }).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await fetch(toApiUrl(filters, page));
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error(d?.message ?? `HTTP ${r.status}`);
      setRows(d.rows ?? []);
      setTotal(d.total ?? 0);
      setErr('');
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }, [filters, page]);
  useEffect(() => { load(); }, [load]);

  const doRefreshScan = async () => {
    setRefreshing(true); setRefreshMsg('');
    try {
      const r = await fetch('/api/sg/rules/refresh', { method: 'POST' });
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error(d?.message ?? `HTTP ${r.status}`);
      setRefreshMsg(tt(`스캔 요청됨 (${d.jobs?.length ?? 0}건)`));
    } catch (e) { setRefreshMsg(e instanceof Error ? e.message : String(e)); } finally { setRefreshing(false); }
  };

  const columns = useMemo(() => [
    { key: 'group_id', label: 'SG' },
    { key: 'account_id', label: tt('계정') },
    { key: 'region', label: tt('리전') },
    { key: 'vpc', label: 'VPC' },
    { key: 'direction', label: tt('방향') },
    { key: 'protocol', label: 'Protocol' },
    { key: 'ports', label: 'Ports' },
    { key: 'peer', label: tt('피어') },
    { key: 'description', label: tt('설명') },
    { key: 'status', label: tt('상태') },
    { key: 'compatible_match_count', label: tt('호환 매칭') },
    { key: 'overlap_match_count', label: tt('중첩 매칭') },
    { key: 'last_observed_at', label: tt('마지막 관측') },
    { key: 'coverage', label: tt('평가 윈도우') },
  ], [tt]);

  const tableRows = useMemo(() => rows.map((r) => ({
    group_id: r.group_id,
    account_id: r.account_id,
    region: r.region,
    // vpc_id can legitimately be unknown (a rule snapshotted before the gap-5 fix, or an SG with no
    // currently attached ENI) — rendered as a dash rather than fabricated in that case.
    vpc: r.vpc_id ?? '—',
    direction: r.is_egress ? 'egress' : 'ingress',
    protocol: r.protocol,
    ports: r.from_port == null ? 'all' : r.from_port === r.to_port ? String(r.from_port) : `${r.from_port}-${r.to_port}`,
    peer: r.peer_value,
    description: r.description ?? '',
    status: <StatusBadge status={r.status} />,
    compatible_match_count: r.compatible_match_count,
    overlap_match_count: r.overlap_match_count,
    last_observed_at: r.last_observed_at ?? '—',
    coverage: `${filters.days}d`,
    __rule: r,
  })), [rows, filters.days]);

  const graph = useMemo(() => (selected ? buildSgRuleGraph(selected) : null), [selected]);

  return (
    <>
      <PageHeader
        title={tt('보안 그룹 규칙')}
        subtitle={tt('룰 인벤토리 + 트래픽 증거 상태 — SG/계정/리전/방향/상태/텍스트 필터, 30/90/180일 윈도우')}
        right={
          <div className="flex items-center gap-2">
            <a href={toCsvUrl(filters)} className="inline-flex items-center gap-1.5 rounded-md border border-ink-200 px-3 py-1.5 text-[12px] font-medium text-ink-700 hover:bg-ink-50">
              <Download size={13} />CSV
            </a>
            <button type="button" onClick={() => downloadJson(rows)} className="inline-flex items-center gap-1.5 rounded-md border border-ink-200 px-3 py-1.5 text-[12px] font-medium text-ink-700 hover:bg-ink-50">
              <Download size={13} />JSON
            </button>
            <button
              type="button"
              disabled={!isAdmin || refreshing}
              title={isAdmin ? undefined : tt('관리자만 사용 가능')}
              onClick={doRefreshScan}
              className="inline-flex items-center gap-1.5 rounded-md border border-ink-200 px-3 py-1.5 text-[12px] font-medium text-ink-700 hover:bg-ink-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <RefreshCw size={13} />{tt('스캔 새로고침')}
            </button>
            <button
              type="button"
              disabled={!isAdmin}
              title={isAdmin ? undefined : tt('관리자만 사용 가능')}
              onClick={() => setFlowFormOpen((v) => !v)}
              className="inline-flex items-center gap-1.5 rounded-md border border-ink-200 px-3 py-1.5 text-[12px] font-medium text-ink-700 hover:bg-ink-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Settings2 size={13} />{tt('Flow Log 설정')}
            </button>
          </div>
        }
      />
      <div className="px-8 py-8 flex flex-col gap-4">
        {err && <div className="text-[13px] text-rose-600">{err}</div>}
        {refreshMsg && <div className="text-[12px] text-ink-500">{refreshMsg}</div>}
        {isAdmin && flowFormOpen && (
          <Card title={tt('Flow Log 설정')} padded={false}>
            <FlowSourceForm onDone={() => setFlowFormOpen(false)} />
          </Card>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <input placeholder={tt('계정 ID')} value={filters.accountId} onChange={(e) => setFilters((f) => ({ ...f, accountId: e.target.value }))} className="rounded-md border border-ink-200 bg-card px-2 py-1 text-[12px]" />
          <input placeholder={tt('리전')} value={filters.region} onChange={(e) => setFilters((f) => ({ ...f, region: e.target.value }))} className="rounded-md border border-ink-200 bg-card px-2 py-1 text-[12px]" />
          <input placeholder="VPC ID" value={filters.vpcId} onChange={(e) => setFilters((f) => ({ ...f, vpcId: e.target.value }))} className="rounded-md border border-ink-200 bg-card px-2 py-1 text-[12px]" />
          <input placeholder="SG ID" value={filters.sgId} onChange={(e) => setFilters((f) => ({ ...f, sgId: e.target.value }))} className="rounded-md border border-ink-200 bg-card px-2 py-1 text-[12px]" />
          <select value={filters.direction} onChange={(e) => setFilters((f) => ({ ...f, direction: e.target.value as Filters['direction'] }))} className="rounded-md border border-ink-200 bg-card px-2 py-1 text-[12px]">
            <option value="">{tt('전체 방향')}</option>
            <option value="ingress">ingress</option>
            <option value="egress">egress</option>
          </select>
          <select value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value as Filters['status'] }))} className="rounded-md border border-ink-200 bg-card px-2 py-1 text-[12px]">
            <option value="">{tt('전체 상태')}</option>
            {STATUSES.map((s) => <option key={s} value={s}>{tt(STATUS_LABEL[s])}</option>)}
          </select>
          <input placeholder={tt('검색…')} value={filters.q} onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))} className="rounded-md border border-ink-200 bg-card px-2 py-1 text-[12px]" />
          <div className="flex items-center gap-1 rounded-md border border-ink-200 p-0.5">
            {WINDOWS.map((w) => (
              <button
                key={w}
                type="button"
                onClick={() => setFilters((f) => ({ ...f, days: w }))}
                className={`rounded px-2 py-1 text-[12px] ${filters.days === w ? 'bg-brand-500 text-white' : 'text-ink-600'}`}
              >
                {w}d
              </button>
            ))}
          </div>
          <span className="ml-auto text-[12px] text-ink-400">{rows.length.toLocaleString()} / {total.toLocaleString()}</span>
        </div>

        <DataTable
          columns={columns}
          rows={tableRows}
          onRowClick={(r) => setSelected((r as unknown as { __rule: RuleRow }).__rule)}
        />
      </div>

      {selected && (
        <DetailPanel
          title={selected.rule_id}
          data={selected as unknown as Record<string, unknown>}
          onClose={() => setSelected(null)}
        >
          {graph && (
            <section className="rounded-lg border border-ink-100 bg-paper-muted/40 p-3">
              <h3 className="mb-2 text-[11px] font-semibold text-ink-700">{tt('관계 그래프')}</h3>
              <div className="h-[280px]">
                <PolicyGraph graph={graph} compact />
              </div>
            </section>
          )}
          <section className="flex flex-col gap-2 rounded-lg border border-ink-100 bg-paper-muted/40 p-3">
            <Link
              href={`/network-paths?prefill=${encodeURIComponent(JSON.stringify({ source_account_id: selected.account_id, region: selected.region, sg: selected.group_id, peer: selected.peer_value, direction: selected.is_egress ? 'egress' : 'ingress', protocol: selected.protocol, port: selected.from_port }))}`}
              className="inline-flex items-center gap-1.5 text-[12px] font-medium text-brand-700 hover:underline"
            >
              <Waypoints size={13} />{tt('이 경로 점검하기')}
            </Link>
            <Link href={`/network/security-groups/usage`} className="inline-flex items-center gap-1.5 text-[12px] font-medium text-brand-700 hover:underline">
              {tt('이 SG의 사용 현황 보기')} — {selected.group_id}
            </Link>
          </section>
        </DetailPanel>
      )}
    </>
  );
}
