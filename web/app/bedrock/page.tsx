'use client';
import { useCallback, useEffect, useState, useRef } from 'react';
import { DollarSign, Activity, ArrowDownToLine, ArrowUpFromLine, PiggyBank, Timer, AlertTriangle } from 'lucide-react';
import Card from '@/components/ui/Card';
import DetailPanel from '@/components/ui/DetailPanel';
import { getModelPricing } from '@/lib/bedrock';
import StatTile from '@/components/ui/StatTile';
import PageHeader from '@/components/ui/PageHeader';
import RefreshButton from '@/components/ui/RefreshButton';
import DataTable from '@/components/ui/DataTable';
import SegmentedControl from '@/components/ui/SegmentedControl';
import AreaTrend from '@/components/charts/AreaTrend';
import BarDistribution from '@/components/charts/BarDistribution';
import DonutBreakdown from '@/components/charts/DonutBreakdown';
import { useActiveAccount, accountParam, ALL_ACCOUNTS } from '@/lib/account-context';
import ChatOpsStatsCard from '@/components/chat/ChatOpsStatsCard';
import { useI18n } from '@/components/shell/LanguageProvider';

interface CostBreakdown { inputCost: number; outputCost: number; cacheReadCost: number; cacheWriteCost: number; total: number; cacheSavings: number }
interface ModelMetric {
  modelId: string; label: string; invocations: number; inputTokens: number; outputTokens: number;
  avgLatencyMs: number; clientErrors: number; serverErrors: number; cacheReadTokens: number; cacheWriteTokens: number; cost: CostBreakdown;
}
interface BedrockData { range: string; models: ModelMetric[]; totalCost: number; series: { t: string; tokens: number }[] }

const RANGES = ['1h', '6h', '24h', '7d', '30d'];
const DASH = '—';
const usd = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const compact = (n: number) => n.toLocaleString(undefined, { notation: 'compact', maximumFractionDigits: 1 });

const FANOUT = 6; // bounded parallel per-account fetches for "All accounts"
const EMPTY = (range: string): BedrockData => ({ range, models: [], totalCost: 0, series: [] });

async function fetchBedrock(range: string, accountId: string): Promise<BedrockData> {
  const p = accountParam(accountId);
  const r = await fetch(`/api/bedrock-metrics?range=${range}${p ? `&${p}` : ''}`);
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

/** Merge per-account BedrockData: sum per modelId (tokens/invocations/cost), invocation-weighted latency. */
function mergeBedrock(parts: BedrockData[]): BedrockData {
  const byModel = new Map<string, ModelMetric>();
  const lat = new Map<string, { lat: number; inv: number }>();
  let totalCost = 0;
  const seriesByT = new Map<string, number>();
  for (const p of parts) {
    totalCost += p.totalCost ?? 0;
    for (const m of p.models ?? []) {
      const la = lat.get(m.modelId) ?? { lat: 0, inv: 0 };
      la.lat += (m.avgLatencyMs || 0) * (m.invocations || 0); la.inv += m.invocations || 0;
      lat.set(m.modelId, la);
      const e = byModel.get(m.modelId);
      if (!e) { byModel.set(m.modelId, { ...m, cost: { ...m.cost } }); continue; }
      e.invocations += m.invocations; e.inputTokens += m.inputTokens; e.outputTokens += m.outputTokens;
      e.cacheReadTokens += m.cacheReadTokens; e.cacheWriteTokens += m.cacheWriteTokens;
      e.clientErrors += m.clientErrors; e.serverErrors += m.serverErrors;
      e.cost = {
        inputCost: e.cost.inputCost + m.cost.inputCost, outputCost: e.cost.outputCost + m.cost.outputCost,
        cacheReadCost: e.cost.cacheReadCost + m.cost.cacheReadCost, cacheWriteCost: e.cost.cacheWriteCost + m.cost.cacheWriteCost,
        total: e.cost.total + m.cost.total, cacheSavings: e.cost.cacheSavings + m.cost.cacheSavings,
      };
    }
    for (const s of p.series ?? []) seriesByT.set(s.t, (seriesByT.get(s.t) ?? 0) + s.tokens);
  }
  for (const [id, e] of byModel) { const la = lat.get(id)!; e.avgLatencyMs = la.inv ? la.lat / la.inv : 0; }
  const series = [...seriesByT.entries()].map(([t, tokens]) => ({ t, tokens })).sort((a, b) => (a.t < b.t ? -1 : 1));
  return { range: parts[0]?.range ?? '', models: [...byModel.values()], totalCost, series };
}

/** Client-side fan-out: fetch every enabled account in bounded parallel + aggregate (thin-BFF). */
async function loadAllAccounts(range: string): Promise<BedrockData> {
  const ar = await fetch('/api/accounts');
  const accts: Array<{ accountId: string; isHost: boolean; enabled: boolean }> =
    ar.ok ? ((await ar.json().catch(() => ({ accounts: [] }))).accounts ?? []) : [];
  const ids = accts.filter((a) => a.enabled).map((a) => (a.isHost ? 'self' : a.accountId));
  if (!ids.length) return await fetchBedrock(range, 'self');
  const parts: BedrockData[] = [];
  for (let i = 0; i < ids.length; i += FANOUT) {
    const chunk = await Promise.all(ids.slice(i, i + FANOUT).map((id) => fetchBedrock(range, id).catch(() => EMPTY(range))));
    parts.push(...chunk);
  }
  return mergeBedrock(parts);
}

export default function BedrockPage() {
  const { tt } = useI18n();
  const [range, setRange] = useState('24h');
  const [d, setD] = useState<BedrockData | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [capturedAt, setCapturedAt] = useState<string | null>(null);
  const [active] = useActiveAccount(); // 'self' (host) | <accountId> | '__all__'

  // Closes over the current `range`; the range-switch useEffect re-fires this on
  // change, and the RefreshButton re-runs it for the same range on demand.
  // Monotonic sequence — an older range's slow response must not overwrite the
  // currently-selected range (P4 gate: codex).
  const loadSeqRef = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    setD(null);
    setErr('');
    setBusy(true);
    try {
      const body = active === ALL_ACCOUNTS ? await loadAllAccounts(range) : await fetchBedrock(range, active);
      if (seq !== loadSeqRef.current) return; // superseded (range/account switched or re-refreshed)
      setD(body);
      setCapturedAt(new Date().toISOString());
    } catch (e) {
      if (seq === loadSeqRef.current) setErr(String(e));
    } finally {
      if (seq === loadSeqRef.current) setBusy(false);
    }
  }, [range, active]);

  useEffect(() => { load(); }, [load]);

  const [picked, setPicked] = useState<string | null>(null);
  const [appStats, setAppStats] = useState<{ totalCalls: number; successRate: number; avgElapsedMs: number } | null>(null);
  useEffect(() => {
    let alive = true;
    fetch('/api/chat/stats')
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => { if (alive && b) setAppStats(b); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const models = d?.models ?? [];
  const totalCost = d?.totalCost ?? 0;
  const totalInvocations = models.reduce((s, m) => s + m.invocations, 0);
  const totalInput = models.reduce((s, m) => s + m.inputTokens, 0);
  const totalOutput = models.reduce((s, m) => s + m.outputTokens, 0);
  const totalSavings = models.reduce((s, m) => s + m.cost.cacheSavings, 0);
  // v1-parity KPIs: invocation-weighted average latency + total 4xx/5xx errors.
  const avgLatencyMs = totalInvocations > 0
    ? models.reduce((s, m) => s + (m.avgLatencyMs || 0) * m.invocations, 0) / totalInvocations
    : 0;
  const totalErrors = models.reduce((s, m) => s + m.clientErrors + m.serverErrors, 0);
  // Prompt-caching rollup (v1 parity): cache read/write totals + hit rate = cacheRead/(input+cacheRead).
  const totalCacheRead = models.reduce((s, m) => s + m.cacheReadTokens, 0);
  const totalCacheWrite = models.reduce((s, m) => s + m.cacheWriteTokens, 0);
  const cacheHitRate = totalInput + totalCacheRead > 0 ? (totalCacheRead / (totalInput + totalCacheRead)) * 100 : 0;

  // Model drill-down (v1 parity): unit prices + cost breakdown + 4xx/5xx split, flat fields.
  const pickedModel = models.find((m) => m.label === picked) ?? null;
  const pickedDetail = pickedModel
    ? (() => {
        const pr = getModelPricing(pickedModel.modelId);
        const hit = pickedModel.inputTokens + pickedModel.cacheReadTokens > 0
          ? (pickedModel.cacheReadTokens / (pickedModel.inputTokens + pickedModel.cacheReadTokens)) * 100 : 0;
        return {
          resource_id: pickedModel.modelId,
          name: pickedModel.label,
          [tt('호출 수')]: pickedModel.invocations.toLocaleString(),
          [tt('평균 지연')]: pickedModel.avgLatencyMs ? `${pickedModel.avgLatencyMs} ms` : DASH,
          [tt('4xx 에러')]: pickedModel.clientErrors,
          [tt('5xx 에러')]: pickedModel.serverErrors,
          [tt('입력 토큰')]: pickedModel.inputTokens.toLocaleString(),
          [tt('출력 토큰')]: pickedModel.outputTokens.toLocaleString(),
          [tt('캐시 읽기 토큰')]: pickedModel.cacheReadTokens.toLocaleString(),
          [tt('캐시 쓰기 토큰')]: pickedModel.cacheWriteTokens.toLocaleString(),
          [tt('캐시 적중률')]: `${hit.toFixed(1)}%`,
          [tt('입력 비용')]: usd(pickedModel.cost.inputCost),
          [tt('출력 비용')]: usd(pickedModel.cost.outputCost),
          [tt('캐시 읽기 비용')]: usd(pickedModel.cost.cacheReadCost),
          [tt('캐시 쓰기 비용')]: usd(pickedModel.cost.cacheWriteCost),
          [tt('총 비용')]: usd(pickedModel.cost.total),
          [tt('캐시 절감')]: usd(pickedModel.cost.cacheSavings),
          [tt('단가 (입력/1M)')]: usd(pr.input),
          [tt('단가 (출력/1M)')]: usd(pr.output),
          [tt('단가 (캐시읽기/1M)')]: usd(pr.cacheRead),
          [tt('단가 (캐시쓰기/1M)')]: usd(pr.cacheWrite),
        } as Record<string, unknown>;
      })()
    : null;

  const costRows = models.map((m) => ({ label: m.label, cost: m.cost.total }));
  const invRows = models.map((m) => ({ label: m.label, invocations: m.invocations }));
  const tableRows = models.map((m) => ({
    model: m.label,
    invocations: m.invocations.toLocaleString(),
    inputTokens: compact(m.inputTokens),
    outputTokens: compact(m.outputTokens),
    avgLatencyMs: m.avgLatencyMs ? `${m.avgLatencyMs} ms` : DASH,
    cacheRead: compact(m.cacheReadTokens),
    errors: m.clientErrors + m.serverErrors,
    cost: usd(m.cost.total),
  }));

  return (
    <>
      <PageHeader
        title="Bedrock Usage"
        subtitle="AWS/Bedrock CloudWatch 메트릭 · 모델별 토큰·비용·캐시"
        right={<RefreshButton busy={busy} onClick={load} capturedAt={capturedAt} />}
      />
      <div className="px-4 lg:px-8 py-8 flex flex-col gap-6">
        <div className="overflow-x-auto">
          <SegmentedControl options={RANGES} value={range} onChange={setRange} />
        </div>

        {err && <div className="text-[13px] text-rose-600">{tt('로드 실패:')} {err} {tt('(CloudWatch 권한 또는 세션 만료 확인)')}</div>}
        {!d && !err && <div className="text-ink-400">{tt('로딩 중…')}</div>}

        {d && !err && (
          models.length === 0 ? (
            <div className="rounded-md border border-ink-100 bg-ink-50 px-3 py-3 text-[13px] text-ink-400">
              {tt('이 기간에 Bedrock 모델 호출 메트릭이 없습니다.')}
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-4">
                <StatTile label={`총 비용 (${range})`} value={usd(totalCost)} variant="accent" icon={<DollarSign size={16} />} />
                <StatTile label="호출 수" value={totalInvocations.toLocaleString()} icon={<Activity size={16} />} />
                <StatTile label="입력 토큰" value={compact(totalInput)} icon={<ArrowDownToLine size={16} />} />
                <StatTile label="출력 토큰" value={compact(totalOutput)} icon={<ArrowUpFromLine size={16} />} />
                <StatTile label="캐시 절감" value={usd(totalSavings)} hint="cache read 할인" variant="warn" icon={<PiggyBank size={16} />} />
                <StatTile label="평균 지연" value={avgLatencyMs ? `${(avgLatencyMs / 1000).toFixed(2)}s` : '—'} hint="호출 가중 평균" icon={<Timer size={16} />} />
                <StatTile label="에러" value={totalErrors.toLocaleString()} variant={totalErrors > 0 ? 'danger' : 'default'} hint="4xx + 5xx" icon={<AlertTriangle size={16} />} />
              </div>

              {d.series.length > 1 && (
                <AreaTrend title="토큰 추이 (입력+출력)" data={d.series} xKey="t" yKey="tokens" />
              )}

              <div className="grid grid-cols-1 lg:grid-cols-[1.5fr_1fr] gap-6">
                <BarDistribution title="모델별 호출 수" data={invRows} xKey="label" yKey="invocations" />
                <DonutBreakdown title="모델별 비용" data={costRows} nameKey="label" valueKey="cost" valuePrefix="$" />
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* v1 parity: prompt-caching rollup — hit rate + read/write volumes + savings */}
                <Card title="Prompt Caching 요약">
                  <dl className="grid grid-cols-2 gap-x-6 gap-y-3">
                    <div><dt className="text-[11px] uppercase tracking-[0.04em] text-ink-400">{tt('캐시 적중률')}</dt>
                      <dd className={`tabular mt-0.5 text-[22px] font-semibold ${cacheHitRate >= 50 ? 'text-positive-text' : 'text-ink-800'}`}>{cacheHitRate.toFixed(1)}%</dd></div>
                    <div><dt className="text-[11px] uppercase tracking-[0.04em] text-ink-400">{tt('캐시 절감')}</dt>
                      <dd className="tabular mt-0.5 text-[22px] font-semibold text-ink-800">{usd(totalSavings)}</dd></div>
                    <div><dt className="text-[11px] uppercase tracking-[0.04em] text-ink-400">{tt('캐시 읽기 토큰')}</dt>
                      <dd className="tabular mt-0.5 text-[15px] text-ink-700">{compact(totalCacheRead)}</dd></div>
                    <div><dt className="text-[11px] uppercase tracking-[0.04em] text-ink-400">{tt('캐시 쓰기 토큰')}</dt>
                      <dd className="tabular mt-0.5 text-[15px] text-ink-700">{compact(totalCacheWrite)}</dd></div>
                  </dl>
                  <p className="mt-3 text-[11px] text-ink-400">{tt('적중률 = 캐시 읽기 ÷ (입력 + 캐시 읽기). 읽기 단가는 입력의 10%.')}</p>
                </Card>
                {/* v1 parity: account-wide CloudWatch totals vs AWSops app-recorded usage */}
                <Card title="계정 전체 vs AWSops 앱 사용량">
                  <dl className="grid grid-cols-2 gap-x-6 gap-y-3">
                    <div><dt className="text-[11px] uppercase tracking-[0.04em] text-ink-400">{tt(`계정 전체 호출 (${range})`)}</dt>
                      <dd className="tabular mt-0.5 text-[22px] font-semibold text-ink-800">{totalInvocations.toLocaleString()}</dd></div>
                    <div><dt className="text-[11px] uppercase tracking-[0.04em] text-ink-400">{tt('AWSops 앱 호출 (기록 누계)')}</dt>
                      <dd className="tabular mt-0.5 text-[22px] font-semibold text-ink-800">{appStats ? appStats.totalCalls.toLocaleString() : DASH}</dd></div>
                    <div><dt className="text-[11px] uppercase tracking-[0.04em] text-ink-400">{tt('앱 성공률')}</dt>
                      <dd className="tabular mt-0.5 text-[15px] text-ink-700">{appStats ? `${(appStats.successRate * 100).toFixed(0)}%` : DASH}</dd></div>
                    <div><dt className="text-[11px] uppercase tracking-[0.04em] text-ink-400">{tt('앱 평균 응답')}</dt>
                      <dd className="tabular mt-0.5 text-[15px] text-ink-700">{appStats ? `${(appStats.avgElapsedMs / 1000).toFixed(1)}s` : DASH}</dd></div>
                  </dl>
                  <p className="mt-3 text-[11px] text-ink-400">{tt('계정 전체는 CloudWatch(선택 기간), 앱은 어시스턴트 호출 기록 — 집계 창이 다릅니다.')}</p>
                </Card>
              </div>

              <section className="flex flex-col gap-3">
                <h2 className="text-[13px] font-semibold text-ink-800">{tt('모델 상세')}</h2>
                <DataTable
                  columns={[
                    { key: 'model', label: '모델' },
                    { key: 'invocations', label: '호출' },
                    { key: 'inputTokens', label: '입력 토큰' },
                    { key: 'outputTokens', label: '출력 토큰' },
                    { key: 'cacheRead', label: '캐시 읽기' },
                    { key: 'avgLatencyMs', label: '평균 지연' },
                    { key: 'errors', label: '에러' },
                    { key: 'cost', label: '비용' },
                  ]}
                  rows={tableRows}
                  onRowClick={(row) => setPicked(String(row.model))}
                />
              </section>
            </>
          )
        )}

        {/* v1-parity AI-call ops stats — independent of the CloudWatch range/account above
            (own /api/chat/stats fetch); self-hides when nothing is recorded. */}
        <ChatOpsStatsCard />
        <DetailPanel title={picked ?? undefined} data={pickedDetail} onClose={() => setPicked(null)} />
      </div>
    </>
  );
}
