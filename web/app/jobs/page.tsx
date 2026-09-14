'use client';
import { useCallback, useEffect, useState } from 'react';
import PageHeader from '@/components/ui/PageHeader';
import RefreshButton from '@/components/ui/RefreshButton';
import DataTable from '@/components/ui/DataTable';
import { useI18n } from '@/components/shell/LanguageProvider';
import Card from '@/components/ui/Card';
import type { ObservedJob, jobTiming, summarizeJobs } from '@/lib/job-observability';

const COPY = {
  en: {
    title: 'Async workload observations', window: 'Window (hours)', type: 'Job type', all: 'All',
    target: 'Completion target (seconds)', apply: 'Apply', noTarget: 'No completion target selected',
    unknown: 'Unknown', partial: 'Incomplete observations — attainment withheld',
    note: 'Jobs accepted in this window. Wait includes queue and scheduling; worker lifecycle includes retries.',
    observed: 'Observed jobs', attainment: 'Completion attainment', latency: 'Terminal duration p95',
    wait: 'Wait + scheduling', worker: 'Worker lifecycle', total: 'End to end',
    attempts: 'Attempts', correlation: 'Correlation ID', loading: 'Loading…',
  },
  ko: {
    title: '비동기 워크로드 관측', window: '조회 범위(시간)', type: '작업 종류', all: '전체',
    target: '완료 목표(초)', apply: '적용', noTarget: '완료 목표 미설정',
    unknown: '미확인', partial: '관측 불완전 — 달성률 확정 불가',
    note: '선택한 기간에 접수된 작업입니다. 대기는 큐·스케줄링을, 워커 경과 시간은 재시도를 포함합니다.',
    observed: '관측 작업', attainment: '완료 목표 달성률', latency: '종료 작업 소요 시간 p95',
    wait: '대기·스케줄링', worker: '워커 경과 시간', total: '전체 소요 시간',
    attempts: '시도 횟수', correlation: '상관 식별자', loading: '불러오는 중…',
  },
  ja: {
    title: '非同期ワークロード観測', window: '対象期間（時間）', type: 'ジョブ種類', all: 'すべて',
    target: '完了目標（秒）', apply: '適用', noTarget: '完了目標は未設定',
    unknown: '不明', partial: '観測が不完全 — 達成率は未確定',
    note: '対象期間に受け付けたジョブです。待機にはキューとスケジュール、ワーカー経過時間には再試行を含みます。',
    observed: '観測ジョブ', attainment: '完了目標達成率', latency: '終了ジョブ所要時間 p95',
    wait: '待機・スケジュール', worker: 'ワーカー経過時間', total: '全体所要時間',
    attempts: '試行回数', correlation: '相関ID', loading: '読み込み中…',
  },
  zh: {
    title: '异步工作负载观测', window: '时间范围（小时）', type: '任务类型', all: '全部',
    target: '完成目标（秒）', apply: '应用', noTarget: '未设置完成目标',
    unknown: '未知', partial: '观测不完整 — 无法确定达成率',
    note: '显示选定期间接收的任务。等待包含队列和调度，工作程序经过时间包含重试。',
    observed: '观测任务', attainment: '完成目标达成率', latency: '已结束任务耗时 p95',
    wait: '等待与调度', worker: '工作程序经过时间', total: '总耗时',
    attempts: '尝试次数', correlation: '关联ID', loading: '加载中…',
  },
};
interface Observations {
  window?: { start: string; end: string };
  summary: ReturnType<typeof summarizeJobs>;
  jobs: (ObservedJob & { runtime?: string; error?: string; timing: ReturnType<typeof jobTiming> })[];
}

export default function JobsPage() {
  const { tt, lang } = useI18n();
  const copy = COPY[lang];
  const [data, setData] = useState<Observations | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [capturedAt, setCapturedAt] = useState<string | null>(null);
  const [hours, setHours] = useState('24');
  const [type, setType] = useState('');
  const [target, setTarget] = useState('');
  const [query, setQuery] = useState('windowHours=24');

  const load = useCallback(async () => {
    setBusy(true);
    setData(null);
    try {
      const r = await fetch(`/api/jobs/observability?${query}`);
      if (!r.ok) throw new Error(String(r.status));
      const d = await r.json();
      setData(d);
      setErr('');
      setCapturedAt(d.window?.end ?? new Date().toISOString());
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }, [query]);

  useEffect(() => { load(); }, [load]);
  const duration = (ms: number | null | undefined) => ms == null ? copy.unknown : `${(ms / 1000).toFixed(2)} s`;

  return (
    <div>
      <PageHeader
        title={copy.title}
        right={<RefreshButton busy={busy} onClick={load} capturedAt={capturedAt} />}
      />
      <div className="px-8 py-8 flex flex-col gap-4">
        <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => {
          event.preventDefault();
          const params = new URLSearchParams({ windowHours: hours });
          if (type) params.set('type', type);
          if (target) params.set('targetMs', String(Number(target) * 1000));
          const next = params.toString();
          if (next === query) void load(); else setQuery(next);
        }}>
          <label className="flex flex-col gap-1 text-xs">{copy.window}
            <select value={hours} onChange={(e) => setHours(e.target.value)}
              className="rounded border border-ink-200 bg-card px-2 py-2">
              {[1, 6, 24, 168].map((h) => <option key={h} value={h}>{h}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs">{copy.type}
            <select value={type} onChange={(e) => setType(e.target.value)}
              className="rounded border border-ink-200 bg-card px-2 py-2">
              <option value="">{copy.all}</option>
              {['report', 'compliance', 'datasource_index', 'finops_baseline', 'network_path', 'noop', 'noop-heavy']
                .map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs">{copy.target}
            <input type="number" min="1" max="86400" step="1" value={target}
              onChange={(e) => setTarget(e.target.value)}
              className="w-44 rounded border border-ink-200 bg-card px-2 py-2" />
          </label>
          <button type="submit" disabled={busy}
            className="rounded border border-ink-200 bg-card px-3 py-2 text-xs disabled:opacity-50">{copy.apply}</button>
        </form>
        <p className="text-xs text-ink-500">{copy.note}</p>
        {err && <div className="text-[13px] text-rose-600">{tt('로드 실패:')} {err}</div>}
        {busy && <div className="text-ink-400">{copy.loading}</div>}
        {data && (
          <>
          {data.summary.targetMs == null && <p className="text-xs text-ink-500">{copy.noTarget}</p>}
          {data.summary.coverage !== 'complete' && <p role="alert" className="text-xs text-amber-700">{copy.partial}</p>}
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              [copy.observed, `${data.summary.sampled} / ${data.summary.totalCount ?? copy.unknown}`],
              [copy.attainment, data.summary.attainment == null ? copy.unknown : `${(data.summary.attainment * 100).toFixed(1)}%`],
              [copy.latency, duration(data.summary.p95Ms)],
            ].map(([label, value]) => <Card key={label}><div className="p-4">
              <p className="text-xs text-ink-500">{label}</p><p className="mt-2 text-xl font-semibold">{value}</p>
            </div></Card>)}
          </div>
          <DataTable
            columns={[
              { key: 'job_id', label: copy.correlation },
              { key: 'type', label: 'Type' },
              { key: 'status', label: 'Status' },
              { key: 'runtime', label: 'Runtime' },
              { key: 'total', label: copy.total },
              { key: 'wait', label: copy.wait },
              { key: 'worker', label: copy.worker },
              { key: 'attempt', label: copy.attempts },
              { key: 'error', label: 'Error' },
              { key: 'created_at', label: 'Created' },
            ]}
            rows={data.jobs.map((job) => ({ ...job, total: duration(job.timing.totalMs),
              wait: duration(job.timing.waitMs), worker: duration(job.timing.workerLifecycleMs) }))}
          />
          </>
        )}
      </div>
    </div>
  );
}
