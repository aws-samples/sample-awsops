'use client';
import { useEffect, useMemo, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { Search, Package, Activity } from 'lucide-react';
import DataTable from '@/components/ui/DataTable';
import DetailPanel from '@/components/ui/DetailPanel';
import RefreshButton from '@/components/ui/RefreshButton';
import PageHeader from '@/components/ui/PageHeader';
import StatTile from '@/components/ui/StatTile';
import SegmentedControl from '@/components/ui/SegmentedControl';
import Input from '@/components/ui/Input';
import DonutBreakdown from '@/components/charts/DonutBreakdown';
import BarDistribution from '@/components/charts/BarDistribution';
import RiskHero from '@/components/inventory/RiskHero';
import CloudTrailEvents from '@/components/inventory/CloudTrailEvents';
import EcsCostBasisPanel from '@/components/inventory/EcsCostBasisPanel';
import { EcsCostByService } from '@/components/inventory/metrics/EcsCostByService';
import { S3BucketMap } from '@/components/inventory/S3BucketMap';
import VpcResourceMap from '@/components/inventory/VpcResourceMap';
import { ElasticacheNodeMetrics, OpensearchDomainMetrics, MskBrokerNodes, RdsInstanceMetrics, DynamoTableMetrics, AlbMetrics, NlbMetrics, S3Metrics, EbsMetrics, Ec2Metrics, LambdaMetrics, TgwSection } from '@/components/inventory/NodeMetricsTables';
import { INVENTORY_TYPES, HIGHLIGHTS, computeHighlights, layoutOf, worstFirst } from '@/lib/inventory-types';
import { TYPE_ICON, GROUP_ICON, highlightIcon } from '@/lib/type-icons';
import { useActiveScope, scopeParams } from '@/lib/account-context';
import { useI18n } from '@/components/shell/LanguageProvider';
import { deriveRow, countFlags } from '@/lib/inventory-derived';

type Row = Record<string, unknown>;

// Lifecycle values treated as degraded → render their KPI tile in the danger variant.
// Fetch up to the route's max so highlight/RiskHero verdicts cover the full set for
// almost all accounts; >ROW_LIMIT resources → `capped` flags the verdict as a sample.
const ROW_LIMIT = 500;

const BAD_STATES = new Set([
  'stopped', 'stopping', 'failed', 'crashloopbackoff', 'alarm', 'impaired',
  'inactive', 'deleting', 'deleted', 'error', 'unhealthy', 'terminated',
]);

function stateVariant(value: string): 'default' | 'danger' {
  return BAD_STATES.has(value.trim().toLowerCase()) ? 'danger' : 'default';
}

// Labels for filterKeys that aren't table columns (row keys injected by the page or detail-only).
// Per-type column labels win (facetSpecs checks spec.columns first); these are the shared fallbacks.
const FACET_LABELS: Record<string, string> = {
  region: 'Region', account_id: 'Account', name: 'Name', vpc_id: 'VPC', api_id: 'API',
  storage_type: 'Storage Type', transit_encryption_enabled: 'Transit Enc', engine_type: 'Engine Type',
  default_for_az: 'Default for AZ', amazon_side_asn: 'ASN', private_zone: 'Private Zone',
  http_version: 'HTTP Version', is_ipv6_enabled: 'IPv6', role_last_used_region: 'Last Used Region',
  include_global_service_events: 'Global Service Events', statistic: 'Statistic',
  comparison_operator: 'Comparison', period: 'Period (s)',
  bucket_policy_is_public: 'Policy Public',
};

// Count rows by a column value (stringified), descending by count.
function countBy(rows: Row[], key: string): { name: string; value: number }[] {
  const m = new Map<string, number>();
  for (const r of rows) {
    const raw = r[key];
    const name = raw == null || raw === '' ? '(none)' : String(raw);
    m.set(name, (m.get(name) ?? 0) + 1);
  }
  return [...m.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
}

export default function InventoryTypePage() {
  const { tt } = useI18n();
  const params = useParams();
  const type = String(params.type);
  const spec = INVENTORY_TYPES[type];

  const [rows, setRows] = useState<Row[] | null>(null);
  const [captured, setCaptured] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [query, setQuery] = useState('');
  const [stateFilter, setStateFilter] = useState('전체');
  // v1-parity facet filters (spec.filterKeys): key → selected value ('전체' = no filter).
  const [facets, setFacets] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Row | null>(null);
  // VPC Resource Map (v1 parity): opened from the VPC detail panel's action button.
  const [mapVpc, setMapVpc] = useState<Row | null>(null);
  // Supplementary metric KPI cards (e.g. EC2 avg CPU + hourly cost). Degrade silently to [].
  const [metricCards, setMetricCards] = useState<{ label: string; value: string | number; accent?: boolean }[]>([]);
  // Optional server-computed ranking chart (gap L138, e.g. EC2 CPU Top 15) — generic: any type
  // whose metrics route returns `bar` renders it with no page changes.
  const [metricBar, setMetricBar] = useState<{ title: string; data: { label: string; value: number }[] } | null>(null);
  const [scope] = useActiveScope();

  // Full-fleet aggregates past the 500-row cap (gaps L110 + L102): ONE scoped server-side
  // aggregation supplies the true total AND the state/dist/facet buckets (v1 ran its
  // summary/statusCount/typeDistribution SQL fleet-wide; the sample-based client counts were
  // silently inaccurate above 500). Fetched only once the cap is actually hit; refreshTick
  // refetches after an on-demand sync. Failure degrades to the sample (donuts then carry the
  // 표본 qualifier).
  const [trueTotal, setTrueTotal] = useState<number | null>(null);
  const [aggs, setAggs] = useState<{
    total: number;
    state: { name: string; value: number }[] | null;
    dist: { name: string; value: number }[] | null;
    dist2: { name: string; value: number }[] | null;
    facets: Record<string, { name: string; value: number }[]>;
  } | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const atCap = (rows?.length ?? 0) >= ROW_LIMIT;
  useEffect(() => {
    setTrueTotal(null);
    setAggs(null);
    if (!spec || !atCap) return;
    let alive = true;
    fetch(`/api/inventory/${type}?view=agg&${scopeParams(scope)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive || !d) return;
        if (typeof d.total === 'number') setTrueTotal(d.total);
        setAggs(d);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [spec, type, scope, atCap, refreshTick]);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/inventory/${type}?limit=${ROW_LIMIT}&${scopeParams(scope)}`);
      if (r.status === 403) throw new Error((await r.json().catch(() => null))?.message ?? tt('접근 권한이 없습니다'));
      if (!r.ok) throw new Error(String(r.status));
      const d = await r.json();
      setRows((d.rows as Row[]).map((x) => deriveRow(type, { resource_id: x.resource_id, region: x.region, ...(x.data as object) })));
      setCaptured(d.run?.finished_at ?? null);
    } catch (e) { setErr(String(e)); }
  }, [type, scope]);
  useEffect(() => { if (spec) load(); }, [spec, load]);

  // Supplementary metric cards — fetch separately so a failure never affects the table/donut.
  // Scoped the same as the main table: otherwise avg CPU/hourly-cost would stay fleet-wide
  // while the table/donut narrow to the selected region, showing mismatched numbers.
  useEffect(() => {
    setMetricCards([]);
    setMetricBar(null);
    if (!spec) return;
    let alive = true;
    fetch(`/api/inventory/${type}/metrics?${scopeParams(scope)}`)
      .then((r) => (r.ok ? r.json() : { cards: [] }))
      .then((d) => { if (alive) { setMetricCards(d.cards || []); setMetricBar(d.bar && Array.isArray(d.bar.data) && d.bar.data.length ? d.bar : null); } })
      .catch(() => { if (alive) { setMetricCards([]); setMetricBar(null); } });
    return () => { alive = false; };
  }, [spec, type, scope]);

  const refresh = async () => {
    setBusy(true); setErr('');
    try {
      const r = await fetch(`/api/inventory/${type}/refresh`, { method: 'POST' });
      if (!r.ok) throw new Error(r.status === 401 ? tt('세션 만료 — 새로고침') : tt(`수집 실패 (${r.status})`));
      await load();
      setRefreshTick((c) => c + 1); // the true total must reflect the fresh sync too
    } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  };

  const allRows = useMemo(() => rows ?? [], [rows]);
  // Below the cap the row count is already exact; at the cap prefer the summary's true count
  // (never smaller than what is visibly loaded).
  const totalCount = allRows.length >= ROW_LIMIT && trueTotal != null
    ? Math.max(trueTotal, allRows.length) : allRows.length;
  // ONE truncation signal for every sample-based consumer: at the cap AND a confirmed-or-unknown
  // remainder exists. An exactly-at-cap fleet whose true total equals the rows scanned was fully
  // scanned — not a sample.
  const isTruncated = allRows.length >= ROW_LIMIT && (trueTotal == null || trueTotal > allRows.length);

  // KPI state breakdown — from the FULL row set (not filtered).
  // A 50-bucket agg list HIT THE CAP — completeness untrustworthy for option lists; fall
  // back to the sample for that dimension (donut remainders handle the cap via `total`).
  const aggListComplete = (b: { name: string; value: number }[] | null | undefined) =>
    (b && b.length < 50 ? b : null);
  const stateCounts = useMemo(
    () => (spec?.stateKey ? (aggListComplete(aggs?.state) ?? countBy(allRows, spec.stateKey)) : []),
    [allRows, spec?.stateKey, aggs],  // eslint-disable-line react-hooks/exhaustive-deps -- aggListComplete stable
  );

  // Per-type highlight cards (tailored top KPIs from synced columns). Empty → fall
  // back to the generic state tiles, so unconfigured types render as before.
  const highlightCards = useMemo(
    () => (HIGHLIGHTS[type]
      ? computeHighlights(allRows, HIGHLIGHTS[type], { capped: isTruncated })
      : []),
    [allRows, type, isTruncated],
  );

  // Distribution donut — top 6 + 기타, from the FULL row set.
  const top6 = (counts: { name: string; value: number }[]) => {
    if (counts.length <= 6) return counts;
    const head = counts.slice(0, 6);
    const rest = counts.slice(6).reduce((acc, c) => acc + c.value, 0);
    return rest > 0 ? [...head, { name: tt('기타'), value: rest }] : head;
  };
  // Full-fleet donut: top 6 + a REMAINDER computed against the fleet total (the server caps
  // buckets at 50 — summing only visible buckets would silently drop rank-51+ values, the
  // exact sample-inaccuracy failure this feature exists to fix).
  const top6Agg = (buckets: { name: string; value: number }[], total: number) => {
    const head = buckets.slice(0, 6);
    const rest = total - head.reduce((a, b) => a + b.value, 0);
    return rest > 0 ? [...head, { name: tt('기타'), value: rest }] : head;
  };
  const distData = useMemo(
    () => (spec?.distKey
      ? (aggs?.dist ? top6Agg(aggs.dist, aggs.total) : top6(countBy(allRows, spec.distKey)))
      : []),
    [allRows, spec?.distKey, aggs],  // eslint-disable-line react-hooks/exhaustive-deps -- top6/tt stable
  );
  const distData2 = useMemo(
    () => {
      if (!spec?.distKey2) return [];
      if (aggs?.dist2) {
        const filtered = aggs.dist2.filter((d) => !(spec.distKey2DropNone && d.name === '(none)'));
        // DropNone removes real rows from the denominator — the remainder must not re-add
        // them as 기타, so fall back to bucket-sum semantics for the dropped-none case.
        return spec.distKey2DropNone ? top6(filtered) : top6Agg(filtered, aggs.total);
      }
      return top6(countBy(allRows, spec.distKey2).filter((d) => !(spec.distKey2DropNone && d.name === '(none)')));
    },
    [allRows, spec?.distKey2, aggs],  // eslint-disable-line react-hooks/exhaustive-deps -- top6/tt stable
  );

  // Reset transient filters when switching resource type (a stale facet key would filter to zero).
  useEffect(() => { setFacets({}); setStateFilter('전체'); setQuery(''); }, [type]);

  // v1-parity facet options: each configured filterKey → its distinct values with live counts.
  const facetSpecs = useMemo(() => {
    const keys = spec?.filterKeys ?? [];
    return keys.map((key) => ({
      key,
      label: spec?.columns.find((c) => c.key === key)?.label ?? FACET_LABELS[key] ?? key,
      // full-fleet option list when available AND complete (<50 buckets — an at-cap list is
      // an arbitrary top-50 and can even MISS values visible in the loaded table); a value
      // that exists only beyond the cap now appears; selecting it filters the visible
      // 500-row sample — the shown/total counter keeps the sample scope explicit
      options: aggListComplete(aggs?.facets?.[key]) ?? countBy(allRows, key),
    }));
  }, [spec, allRows, aggs]);

  // Filters narrow ONLY the displayed table rows.
  const filteredRows = useMemo(() => {
    let out = allRows;
    if (spec?.stateKey && stateFilter !== '전체') {
      out = out.filter((r) => {
        const v = r[spec.stateKey as string];
        const name = v == null || v === '' ? '(none)' : String(v);
        return name === stateFilter;
      });
    }
    for (const [key, val] of Object.entries(facets)) {
      if (!val || val === '전체') continue;
      out = out.filter((r) => {
        const v = r[key];
        const name = v == null || v === '' ? '(none)' : String(v);
        return name === val;
      });
    }
    const q = query.trim().toLowerCase();
    if (q) {
      out = out.filter((r) => Object.values(r).some((v) => String(v ?? '').toLowerCase().includes(q)));
    }
    return out;
  }, [allRows, spec?.stateKey, stateFilter, facets, query]);

  // Value-distribution histogram (gap L135): counts per distinct numeric value of histKey.col,
  // top 10 by count, then numerically sorted (v1's memory-allocation bar). preserveOrder keeps
  // the numeric axis — BarDistribution's default re-sort is count-descending (rankings).
  // Hook — must sit ABOVE the !spec early return (rules of hooks; no ESLint here to catch it).
  const histData = useMemo(() => (spec?.histKey
    ? countBy(allRows, spec.histKey.col)
        .filter((d) => d.name !== '(none)')
        .slice(0, 10)
        .sort((a, b) => Number(a.name) - Number(b.name))
        .map((d) => ({ label: `${d.name}${spec.histKey!.suffix ?? ''}`, value: d.value }))
    : []), [allRows, spec?.histKey]);

  // Count-distribution bar data (gap L221) — hook ABOVE the !spec early return (rules of
  // hooks; the histData precedent), top-10 by count with '(none)' filtered.
  const countBarData = useMemo(
    () => (spec?.countBarKey
      ? countBy(allRows, spec.countBarKey.col).filter((d) => d.name !== '(none)').sort((a, b) => b.value - a.value).slice(0, 10)
      : []),
    [allRows, spec?.countBarKey],
  );

  // Independent flag-count bars (gap L240) — hook ABOVE the !spec early return (rules of
  // hooks). Declared order kept; zero bars kept (a zero Public bar is signal).
  const flagBarData = useMemo(
    () => (spec?.flagBarKey ? countFlags(allRows, spec.flagBarKey.flags) : []),
    [allRows, spec?.flagBarKey],
  );

  if (!spec) {
    return (
      <>
        <PageHeader title="Inventory" />
        <div className="px-8 py-8">
          <div className="text-[13px] text-rose-600">Unknown inventory type: {type}</div>
        </div>
      </>
    );
  }

  const multiAccount = scope.accounts === '__all__' || (Array.isArray(scope.accounts) && scope.accounts.length > 1);
  const columns = [
    { key: 'resource_id', label: 'ID' },
    ...(multiAccount ? [{ key: 'account_id', label: 'Account' }] : []),
    { key: 'region', label: 'Region' },
    ...spec.columns,
  ];
  const colLabel = (key?: string) =>
    (key && spec.columns.find((c) => c.key === key)?.label) || key || '';
  const distLabel = colLabel(spec.distKey);
  const stateOptions = ['전체', ...stateCounts.map((s) => s.name)];
  const arch = layoutOf(type);

  // Composable section blocks — arranged per archetype in the render below.
  // v1-parity: a lucide icon in each KPI tile's translucent top-right box (the "총 N" tile gets
  // the resource-type icon; state tiles get a health icon by variant) — v1 StatsCard style.
  const TypeIcon = TYPE_ICON[type] ?? GROUP_ICON[spec.group] ?? Package;
  // Label-semantic glyph per card (a bare variant Circle on default cards read as "no icon").
  const cardIcon = (label: string, v: 'default' | 'accent' | 'danger' | 'warn') => {
    const I = highlightIcon(label, v);
    return <I size={16} />;
  };
  const kpiRow = (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
      <StatTile label={`총 ${spec.label}`} value={totalCount} variant="accent" icon={<TypeIcon size={16} />} />
      {highlightCards.length > 0
        ? highlightCards.map((h) => <StatTile key={h.label} label={h.label} value={h.value} variant={h.variant} icon={cardIcon(h.label, h.variant)} />)
        : stateCounts.slice(0, 4).map((s) => <StatTile key={s.name} label={s.name} value={s.value} variant={stateVariant(s.name)} icon={cardIcon(s.name, stateVariant(s.name))} />)}
      {metricCards.map((c) => <StatTile key={c.label} label={c.label} value={c.value} variant="accent" icon={<Activity size={16} />} />)}
    </div>
  );
  // Donuts are full-fleet only when THEIR dimension's aggregate landed (client-derived keys
  // are server-excluded and stay sample-based) — each donut discloses its own fallback
  // (previously a capped donut was silently sample-based with no label).
  // The composed title stays FULLY KOREAN here: Card applies ONE tt() to the whole string
  // and the '<label> 분포( (표본 기준))?' RULE translates it — pre-translating the suffix
  // produced a mixed string no rule could match (PR #288 round-1).
  const sampleTag = (has: boolean) => (isTruncated && !has ? ' (표본 기준)' : '');
  const donut = spec.distKey && distData.length > 0
    ? <DonutBreakdown title={`${distLabel} 분포${sampleTag(Boolean(aggs?.dist))}`} data={distData} nameKey="name" valueKey="value" />
    : null;
  const donut2 = spec.distKey2 && spec.distKey2 !== spec.distKey && distData2.length > 0
    ? <DonutBreakdown title={`${spec.distKey2Label ?? colLabel(spec.distKey2)} 분포${sampleTag(Boolean(aggs?.dist2))}`} data={distData2} nameKey="name" valueKey="value" colors={spec.distKey2Colors} />
    : null;
  // Optional Top-N numeric bar (spec.barKey): rows ranked by the column, labelled by name/id.
  const hist = spec.histKey && histData.length > 0
    ? (
      <BarDistribution
        title={isTruncated ? `${spec.histKey.label} (표본 기준)` : spec.histKey.label}
        data={histData}
        xKey="label"
        yKey="value"
        preserveOrder
      />
    )
    : null;

  const barData = spec.barKey
    ? [...allRows]
        .map((r) => ({
          label: String(r.name ?? r.task_short ?? r.resource_id ?? ''),
          value: Number(r[spec.barKey!.col]) || 0,
        }))
        .filter((x) => x.label && x.value > 0)
        .sort((a, b) => b.value - a.value)
        .slice(0, 10)
    : [];
  const barChart = spec.barKey && barData.length > 0
    ? <BarDistribution title={`Top ${barData.length} — ${spec.barKey.label}`} data={barData} xKey="label" yKey="value" />
    : null;
  // Server-computed ranking chart (gap L138): the metrics route's optional `bar` payload.
  const serverBar = metricBar
    ? <BarDistribution title={metricBar.title} data={metricBar.data} xKey="label" yKey="value" decimals={1} />
    : null;
  // Count-distribution bar (gap L221): row counts per distinct value, count-desc (the
  // BarDistribution default) — distinct from barKey (numeric ranking) and hist (numeric axis).

  const countBar = spec.countBarKey && countBarData.length > 0
    ? <BarDistribution title={isTruncated ? `${spec.countBarKey.label} (${tt('표본 기준')})` : spec.countBarKey.label} data={countBarData} xKey="name" yKey="value" />
    : null;
  // Flag-count bars (gap L240): rendered only when at least one flag column has a known
  // value (countFlags drops all-unknown columns — a 0/0 must not read as all-clear);
  // preserveOrder keeps the declared semantic order instead of the count-desc re-sort.
  const flagBar = spec.flagBarKey && flagBarData.length > 0
    ? <BarDistribution title={isTruncated ? `${spec.flagBarKey.label} (${tt('표본 기준')})` : spec.flagBarKey.label} data={flagBarData} xKey="name" yKey="value" preserveOrder />
    : null;
  // Graph band: one full-width donut, or two side-by-side when the spec has a second dimension.
  const graphBand = donut && donut2
    ? <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">{donut}{donut2}</div>
    : donut;
  const facetsActive = Object.values(facets).some((v) => v && v !== '전체');
  const anyFilterActive = query.trim() !== '' || stateFilter !== '전체' || facetsActive;
  const clearAll = () => { setQuery(''); setStateFilter('전체'); setFacets({}); };
  const tableBlock = (
    <div className="flex flex-col gap-3">
      <Filters
        query={query}
        onQuery={setQuery}
        stateOptions={spec.stateKey ? stateOptions : undefined}
        stateFilter={stateFilter}
        onState={setStateFilter}
        facetSpecs={facetSpecs}
        facets={facets}
        onFacet={(key, val) => setFacets((prev) => ({ ...prev, [key]: val }))}
        shownCount={filteredRows.length}
        totalCount={totalCount}
        onClear={anyFilterActive ? clearAll : undefined}
      />
      <DataTable columns={columns} rows={spec.worstFirst ? worstFirst(filteredRows, spec.worstFirst) : filteredRows} onRowClick={setSelected} />
    </div>
  );

  return (
    <>
      <PageHeader
        title={spec.label}
        subtitle={`${spec.group} · ${totalCount.toLocaleString()}개 리소스`}
        right={<RefreshButton busy={busy} onClick={refresh} capturedAt={captured} />}
      />
      <div className="px-8 py-8 flex flex-col gap-6">
        {err && <div className="text-[13px] text-rose-600">{err}</div>}
        {!rows && !err && <div className="text-ink-400">{tt('로딩 중…')}</div>}

        {rows && (
          <>
            {/* Uniform page order (owner 지시): KPI band → distribution graph → detail table.
                Risk types keep their verdict hero as the KPI band; everything else uses kpiRow. */}
            {arch === 'risk' ? (
              <>
                <RiskHero
                  label={spec.label}
                  total={totalCount}
                  sampled={allRows.length}
                  totalIsExact={allRows.length < ROW_LIMIT || trueTotal != null}
                  cards={highlightCards}
                  capped={isTruncated}
                />
                {metricCards.length > 0 && (
                  <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                    {metricCards.map((c) => <StatTile key={c.label} label={c.label} value={c.value} variant="accent" icon={<Activity size={16} />} />)}
                  </div>
                )}
              </>
            ) : (
              kpiRow
            )}
            {graphBand}
            {(() => {
              const charts = [barChart, hist, countBar, flagBar, serverBar].filter(Boolean);
              if (charts.length === 0) return null;
              if (charts.length === 1) return charts[0];
              return <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">{charts.map((c, i) => <div key={i} className="min-w-0">{c}</div>)}</div>;
            })()}
            {/* Type-specific live sections (v1 parity): CloudTrail recent-events audit view. */}
            {type === 'cloudtrail' && <CloudTrailEvents />}
            {tableBlock}
            {/* v1-parity live metric tables (owner: 페이지 하단 배치): 노드/도메인/브로커 단위 */}
            {type === 'elasticache' && <ElasticacheNodeMetrics rows={filteredRows} />}
            {type === 'opensearch' && <OpensearchDomainMetrics rows={filteredRows} />}
            {type === 'msk' && <MskBrokerNodes rows={filteredRows} />}
            {type === 'rds' && <RdsInstanceMetrics rows={filteredRows} />}
            {type === 'dynamodb' && <DynamoTableMetrics rows={filteredRows} />}
            {type === 'alb' && <AlbMetrics rows={filteredRows} />}
            {type === 'nlb' && <NlbMetrics rows={filteredRows} />}
            {/* Bucket Map by Region (gap L241) — block click opens the same detail panel. */}
            {type === 's3' && <S3BucketMap rows={filteredRows} isTruncated={isTruncated} onSelect={setSelected} />}
            {type === 's3' && <S3Metrics rows={filteredRows} />}
            {type === 'ebs_volume' && <EbsMetrics rows={filteredRows} />}
            {/* Cost by Service grouped bar (gap L195) + Cost Calculation Basis (gap L194). */}
            {type === 'ecs_task' && <EcsCostByService rows={filteredRows} isTruncated={isTruncated} />}
            {type === 'ecs_task' && <EcsCostBasisPanel />}
            {type === 'ec2' && <Ec2Metrics rows={filteredRows} />}
            {type === 'lambda' && <LambdaMetrics rows={filteredRows} />}
            {type === 'transit_gateway' && <TgwSection rows={filteredRows} />}
            {/* SG usage analysis moved to /network/security-groups/usage (docs/superpowers/specs/
                2026-08-13-security-group-rules-usage-design.md) — see the "Security Group" sidebar
                submenu under Network. Not embedded here anymore. */}
          </>
        )}
      </div>
      <DetailPanel
        title={selected?.resource_id as string | undefined}
        data={selected}
        spec={spec}
        resourceType={type}
        onClose={() => setSelected(null)}
        actions={
          type === 'vpc' && selected ? (
            <button
              type="button"
              onClick={() => { setMapVpc(selected); setSelected(null); }}
              className="rounded-md border border-brand-300 bg-brand-500/10 px-3 py-1.5 text-[12px] font-medium text-brand-700 hover:bg-brand-500/20"
            >
              {tt('리소스 맵 열기')}
            </button>
          ) : undefined
        }
      />
      {type === 'vpc' && mapVpc && (
        <VpcResourceMap
          vpcId={String(mapVpc.resource_id)}
          vpcName={typeof mapVpc.name === 'string' ? mapVpc.name : undefined}
          cidr={typeof mapVpc.cidr_block === 'string' ? mapVpc.cidr_block : undefined}
          onClose={() => setMapVpc(null)}
        />
      )}
    </>
  );
}

interface FacetSpec { key: string; label: string; options: { name: string; value: number }[] }

// v1-parity filter bar: search + state SegmentedControl + per-facet dropdowns (with live counts) +
// a "N / M" shown count + "전체 해제". Narrows the table only.
function Filters({
  query,
  onQuery,
  stateOptions,
  stateFilter,
  onState,
  facetSpecs,
  facets,
  onFacet,
  shownCount,
  totalCount,
  onClear,
}: {
  query: string;
  onQuery: (v: string) => void;
  stateOptions?: string[];
  stateFilter: string;
  onState: (v: string) => void;
  facetSpecs: FacetSpec[];
  facets: Record<string, string>;
  onFacet: (key: string, val: string) => void;
  shownCount: number;
  totalCount: number;
  onClear?: () => void;
}) {
  const { tt } = useI18n();
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="w-full max-w-[280px]">
          <Input
            inputSize="sm"
            placeholder={tt('검색…')}
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            icon={<Search className="h-3.5 w-3.5" />}
          />
        </div>
        {stateOptions && stateOptions.length > 1 && (
          <div className="overflow-x-auto">
            <SegmentedControl options={stateOptions} value={stateFilter} onChange={onState} />
          </div>
        )}
      </div>
      {(facetSpecs.length > 0 || onClear) && (
        <div className="flex flex-wrap items-center gap-2">
          {facetSpecs.map((f) => (
            <select
              key={f.key}
              aria-label={tt(`${f.label} 필터`)}
              value={facets[f.key] ?? '전체'}
              onChange={(e) => onFacet(f.key, e.target.value)}
              className="rounded-md border border-ink-200 bg-card px-2 py-1 text-[12px] text-ink-700"
            >
              <option value="전체">{f.label}: {tt('전체')}</option>
              {f.options.map((o) => (
                <option key={o.name} value={o.name}>{o.name} ({o.value})</option>
              ))}
            </select>
          ))}
          {onClear && (
            <button onClick={onClear} className="text-[12px] text-ink-400 hover:text-ink-800">{tt('전체 해제')}</button>
          )}
          <span className="ml-auto tabular-nums text-[12px] text-ink-400">
            {shownCount.toLocaleString()} / {totalCount.toLocaleString()}
          </span>
        </div>
      )}
    </div>
  );
}
