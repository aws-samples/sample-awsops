'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import type { FlowGraph } from '@/lib/flow-topology';
import type { ServiceSnapshot } from '@/lib/e2e-topology-types';
import type { NfmCategory, NfmMetric } from '@/lib/nfm';
import { buildE2eGraph } from '@/lib/e2e-topology';
import {
  loadNetworkObservations, TOPOLOGY_CATEGORIES, TOPOLOGY_METRICS, TOPOLOGY_RANGES,
  type NetworkBatch, type NetworkFilters, type TopologyMonitor,
} from '@/lib/topology-observations';
import { useI18n } from '@/components/shell/LanguageProvider';
import { GraphFetchError, type GraphFetchFailure } from '@/lib/graph-fetch';
import PageHeader from '@/components/ui/PageHeader';
import Button from '@/components/ui/Button';
import E2eGraphCanvas from './E2eGraphCanvas';
import GraphCollectionStatus from './GraphCollectionStatus';
import GraphReadError from './GraphReadError';

export interface ConfigurationStatus {
  loading: boolean;
  capturedAt: string | null;
  error: string;
  cappedTypes: string[];
  failedTypes: string[];
}
interface Props {
  configured: FlowGraph;
  account: string;
  configuration: ConfigurationStatus;
  onBack: () => void;
  onRefresh?: () => void;
}

interface MonitorStatus { monitors: TopologyMonitor[]; scopeCount: number }
interface Source<T> { loading: boolean; data: T | null; error: string; checkedAt: string | null; authReason?: GraphFetchFailure }
interface ObservedServices extends ServiceSnapshot { collection?: unknown }
interface QueryState {
  batch: NetworkBatch | null;
  loading: boolean;
  error: string;
  completed: number;
  total: number;
  generation: number;
}
const DEFAULT_FILTERS: NetworkFilters = { monitor: '', metric: 'DATA_TRANSFERRED', category: 'ALL', rangeSec: 900 };
const IDLE_QUERY: QueryState = { batch: null, loading: false, error: '', completed: 0, total: 0, generation: 0 };
const METRIC_LABELS: Record<NfmMetric, string> = {
  DATA_TRANSFERRED: '전송량', ROUND_TRIP_TIME: 'RTT', RETRANSMISSIONS: '재전송', TIMEOUTS: '타임아웃',
};
const RANGE_LABELS: Record<number, string> = { 900: '15분', 1800: '30분', 3600: '1시간' };
const NETWORK_ERRORS: Record<string, string> = {
  query_failed: '조회 실패', malformed_payload: '올바르지 않은 조회 응답',
  malformed_rows: '올바르지 않은 관측 데이터', invalid_request: '조회 조건과 응답이 일치하지 않습니다.',
};
const SELECT_STYLE = 'h-9 w-full min-w-0 rounded-md border border-ink-100 bg-card px-2 text-[12px] text-ink-800 disabled:opacity-50';
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const validTime = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const emptySource = <T,>(loading: boolean): Source<T> => ({ loading, data: null, error: '', checkedAt: null });
class SourceReadError extends Error {}
const errorText = (error: unknown): string => error instanceof SourceReadError ? error.message : '소스를 불러오지 못했습니다.';
const failedSource = <T,>(error: unknown): Source<T> => ({
  ...emptySource<T>(false), error: errorText(error),
  ...(error instanceof GraphFetchError ? { authReason: error.reason } : {}),
});

async function readSource(url: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetch(url, { signal });
  if (response.status === 401 || (response.redirected && new URL(response.url).pathname === '/login')) {
    throw new GraphFetchError('unauthenticated');
  }
  if (response.status === 403) throw new GraphFetchError('forbidden');
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new SourceReadError('소스를 불러오지 못했습니다.');
  if (!object(body)) throw new SourceReadError('올바르지 않은 소스 응답입니다.');
  if (body.status === 'error' || body.error != null) {
    throw new SourceReadError('소스를 불러오지 못했습니다.');
  }
  return body;
}

function readMonitors(body: Record<string, unknown>): MonitorStatus {
  if (!Array.isArray(body.monitors) || !body.monitors.every((monitor) =>
    object(monitor) && nonempty(monitor.name) && nonempty(monitor.status)
      && (monitor.cluster === null || typeof monitor.cluster === 'string'))
    || typeof body.scopeCount !== 'number' || !Number.isInteger(body.scopeCount) || body.scopeCount < 0) {
    throw new SourceReadError('올바르지 않은 NFM 상태 응답입니다.');
  }
  return { monitors: body.monitors as TopologyMonitor[], scopeCount: body.scopeCount };
}

function readServices(body: Record<string, unknown>): ObservedServices {
  if (body.class !== 'trace' || body.account !== 'self'
    || !Array.isArray(body.nodes) || !body.nodes.every((node) =>
      object(node) && nonempty(node.id) && nonempty(node.kind) && typeof node.label === 'string'
        && (node.meta == null || object(node.meta)))
    || !Array.isArray(body.edges) || !body.edges.every((edge) =>
      object(edge) && nonempty(edge.source) && nonempty(edge.target) && nonempty(edge.rel)
        && (edge.confidence == null || typeof edge.confidence === 'string'))
    || (body.captured_at != null && !validTime(body.captured_at))) {
    throw new SourceReadError('올바르지 않은 서비스 스냅샷 응답입니다.');
  }
  return {
    nodes: body.nodes.map((node) => ({ id: node.id, kind: node.kind, label: node.label, ...(node.meta ? { meta: node.meta } : {}) })),
    edges: body.edges.map((edge) => ({
      source: edge.source, target: edge.target, rel: edge.rel,
      ...(edge.confidence != null ? { confidence: edge.confidence } : {}),
    })),
    captured_at: validTime(body.captured_at) ? body.captured_at : null,
    collection: body.collection,
  };
}

function initialFilters(): NetworkFilters {
  // Read after mount so the server and first client render have the same controls.
  try {
    const params = new URLSearchParams(window.location.search);
    const metric = params.get('metric'), category = params.get('category'), range = Number(params.get('range'));
    return {
      monitor: params.get('monitor') ?? '',
      metric: TOPOLOGY_METRICS.find((value) => value === metric) ?? DEFAULT_FILTERS.metric,
      category: TOPOLOGY_CATEGORIES.find((value) => value === category) ?? 'ALL',
      rangeSec: TOPOLOGY_RANGES.includes(range) ? range : DEFAULT_FILTERS.rangeSec,
    };
  } catch { return { ...DEFAULT_FILTERS }; }
}

export default function ServiceNetworkTopology(props: Props) {
  // Discard host-only controls, sources and canvas selection in the account-changing render,
  // including self → member → self; cleanup still aborts any old HTTP work.
  return <ScopedServiceNetworkTopology key={props.account} {...props} />;
}

function ScopedServiceNetworkTopology({ configured, account, configuration, onBack, onRefresh }: Props) {
  const { tt } = useI18n();
  const host = account === 'self';
  const [monitors, setMonitors] = useState<Source<MonitorStatus>>(() => emptySource(host));
  const [services, setServices] = useState<Source<ObservedServices>>(() => emptySource(host));
  const [filters, setFilters] = useState<NetworkFilters>(DEFAULT_FILTERS);
  const [sourceVersion, setSourceVersion] = useState(0);
  const [network, setNetwork] = useState<QueryState>(IDLE_QUERY);
  const sourceController = useRef<AbortController | null>(null);
  const queryController = useRef<AbortController | null>(null);
  const queryGeneration = useRef(0);

  useEffect(() => { if (host) setFilters(initialFilters()); }, [host]);
  useEffect(() => {
    if (!host) return;
    const controller = new AbortController();
    sourceController.current = controller;
    const { signal } = controller;
    // Each source settles independently, so a slow or failed snapshot never gates NFM.
    void Promise.all([
      readSource('/api/nfm', signal).then(readMonitors).then((data) => {
        if (signal.aborted) return;
        setMonitors({ loading: false, data, error: '', checkedAt: new Date().toISOString() });
        const active = data.monitors.filter((monitor) => monitor.status === 'ACTIVE');
        setFilters((current) => ({
          ...current,
          monitor: active.find((monitor) => monitor.name === current.monitor)?.name
            ?? active.find((monitor) => monitor.name === 'nfm-vpc-all')?.name ?? active[0]?.name ?? '',
        }));
      }).catch((error: unknown) => {
        if (!signal.aborted) setMonitors(failedSource<MonitorStatus>(error));
      }),
      readSource('/api/graph?class=trace', signal).then(readServices).then((data) => {
        if (!signal.aborted) setServices({ loading: false, data, error: '', checkedAt: new Date().toISOString() });
      }).catch((error: unknown) => {
        if (!signal.aborted) setServices(failedSource<ObservedServices>(error));
      }),
    ]);
    return () => {
      controller.abort();
      queryController.current?.abort();
      queryGeneration.current += 1;
    };
  }, [host, sourceVersion]);

  const clearNetwork = () => {
    queryController.current?.abort();
    const generation = ++queryGeneration.current;
    setNetwork({ ...IDLE_QUERY, generation });
    return generation;
  };
  const refresh = () => {
    sourceController.current?.abort();
    clearNetwork();
    setMonitors(emptySource(host));
    setServices(emptySource(host));
    setSourceVersion((current) => current + 1);
    onRefresh?.();
  };
  const activeMonitors = monitors.data?.monitors.filter((monitor) => monitor.status === 'ACTIVE') ?? [];
  const selectedMonitor = activeMonitors.find((monitor) => monitor.name === filters.monitor);
  const query = async () => {
    if (!host || monitors.loading || !selectedMonitor) return;
    const generation = clearNetwork();
    const controller = new AbortController();
    queryController.current = controller;
    const current = () => !controller.signal.aborted && queryGeneration.current === generation;
    setNetwork({
      ...IDLE_QUERY, generation, loading: true,
      total: filters.category === 'ALL' ? TOPOLOGY_CATEGORIES.length : 1,
    });
    try {
      const batch = await loadNetworkObservations({ ...filters }, selectedMonitor, {
        signal: controller.signal,
        onProgress: (completed, total) => {
          if (current()) setNetwork((state) => ({ ...state, completed, total }));
        },
      });
      if (current()) setNetwork((state) => ({ ...state, loading: false, batch }));
    } catch (error) {
      if (current()) setNetwork((state) => ({ ...state, loading: false, error: errorText(error) }));
    }
  };

  const batch = host ? network.batch : null;
  const graph = useMemo(() => buildE2eGraph({
    account, configured, services: host ? services.data : null, network: batch?.observations ?? [],
  }), [account, configured, host, services.data, batch]);
  const changed = batch !== null && (filters.monitor !== batch.filters.monitor || filters.metric !== batch.filters.metric
    || filters.category !== batch.filters.category || filters.rangeSec !== batch.filters.rangeSec);
  const rows = batch?.observations.reduce((count, observation) => count + observation.rows.length, 0) ?? 0;
  const captured = services.data?.captured_at;
  const mismatchedCategories = batch?.observations.filter((observation) => {
    if (!validTime(captured) || !validTime(observation.startTime) || !validTime(observation.endTime)) return false;
    return Date.parse(captured) < Date.parse(observation.startTime) || Date.parse(captured) > Date.parse(observation.endTime);
  }).map((observation) => observation.category) ?? [];
  const time = (value: string | null | undefined) => validTime(value)
    ? <time dateTime={value}>{new Date(value).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time> : tt('시각 알 수 없음');
  const controlsDisabled = network.loading || monitors.loading || !selectedMonitor;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <PageHeader title={tt('서비스 + 네트워크')} subtitle={tt('구성 흐름, 저장된 서비스 호출과 네트워크 관측을 함께 살펴봅니다.')}
        right={<div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={onBack}><ArrowLeft size={14} aria-hidden />{tt('구성 흐름으로 돌아가기')}</Button>
          <Button variant="secondary" size="sm" onClick={refresh}><RefreshCw size={14} aria-hidden />{tt('새로고침')}</Button>
        </div>} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-auto p-4 md:p-6">
        {!host && <p role="status" className="rounded-lg border border-ink-100 bg-card p-3 text-[12px] text-ink-600">
          {tt('서비스·NFM 통합 관측은 호스트 계정(self)에서만 지원합니다. 현재 계정의 구성 흐름을 표시합니다.')}
        </p>}
        <div className="flex min-w-0 flex-wrap gap-3 rounded-xl border border-ink-100 bg-card p-3 text-[11px] text-ink-500">
          <section aria-label={tt('구성 소스')} className="min-w-0 flex-1 basis-56 space-y-1 break-words">
            <h2 className="font-semibold text-ink-800">{tt('구성')}</h2>
            <p>{configuration.loading ? tt('구성을 불러오는 중…') : `${tt('노드')} ${configured.nodes.length} · ${tt('관계')} ${configured.edges.length}`}</p>
            <p>{tt('구성 수집 시각')} · {time(configuration.capturedAt)}</p>
            {configuration.error && <p role="alert" className="text-negative">{tt(configuration.error)}</p>}
            {configuration.failedTypes.length > 0 && <p role="alert" className="text-negative">{tt('구성 수집 실패:')} {configuration.failedTypes.join(', ')}</p>}
            {configuration.cappedTypes.length > 0 && <p>{tt('구성 수집 상한:')} {configuration.cappedTypes.join(', ')}</p>}
          </section>
          <section aria-label={tt('서비스 소스')} className="min-w-0 flex-1 basis-56 space-y-1 break-words">
            <h2 className="font-semibold text-ink-800">{tt('저장된 서비스 스냅샷')}</h2>
            {!host ? <p>{tt('이 계정에서 서비스 관측을 사용할 수 없습니다.')}</p>
              : services.loading ? <p>{tt('서비스 스냅샷을 불러오는 중…')}</p>
                : services.error ? services.authReason ? <GraphReadError reason={services.authReason} />
                    : <p role="alert" className="text-negative">{tt(services.error)}</p>
                  : !services.data?.nodes.length ? <p>{tt('저장된 서비스 스냅샷이 없습니다.')}</p>
                    : <><p>{tt('노드')} {services.data.nodes.length} · {tt('관계')} {services.data.edges.length}</p>
                      <p>{tt('스냅샷 시각')} · {time(services.data.captured_at)}</p></>}
            {host && services.data && <GraphCollectionStatus collection={services.data.collection} />}
          </section>
          <section aria-label={tt('NFM 소스')} className="min-w-0 flex-1 basis-56 space-y-1 break-words">
            <h2 className="font-semibold text-ink-800">{tt('NFM · 호스트 기본 리전')}</h2>
            {!host ? <p>{tt('이 계정에서 네트워크 관측을 사용할 수 없습니다.')}</p>
              : monitors.loading ? <p>{tt('NFM 상태를 불러오는 중…')}</p>
                : monitors.error ? monitors.authReason ? <GraphReadError reason={monitors.authReason} />
                    : <p role="alert" className="text-negative">{tt(monitors.error)}</p>
                  : !monitors.data?.monitors.length ? <p>{tt('설정된 NFM 모니터가 없습니다.')}</p>
                    : <><p>{activeMonitors.length ? `${tt('활성 모니터')} ${activeMonitors.length}` : tt('활성 NFM 모니터가 없습니다.')} · {tt('범위')} {monitors.data.scopeCount}</p>
                      <p>{tt('상태 확인 시각')} · {time(monitors.checkedAt)}</p></>}
            {host && <p>{batch ? `${tt('관측 분류')} ${batch.observations.length} · ${tt('상위 기여자')} ${rows}`
              : network.loading ? tt('네트워크 조회 중…') : tt('아직 네트워크를 조회하지 않았습니다.')}</p>}
          </section>
        </div>
        {host && <>
          <div className="flex min-w-0 flex-wrap items-end gap-3">
            <label className="min-w-0 flex-1 basis-48 space-y-1 text-[11px] text-ink-500">
              <span>{tt('모니터')}</span>
              <select aria-label={tt('모니터')} value={filters.monitor} disabled={controlsDisabled} className={SELECT_STYLE}
                onChange={(event) => setFilters((current) => ({ ...current, monitor: event.target.value }))}>
                {!selectedMonitor && <option value={filters.monitor}>{tt('선택 가능한 모니터 없음')}</option>}
                {activeMonitors.map((monitor) => <option key={monitor.name} value={monitor.name}>{monitor.name}</option>)}
              </select>
            </label>
            <label className="min-w-0 flex-1 basis-32 space-y-1 text-[11px] text-ink-500">
              <span>{tt('메트릭')}</span>
              <select aria-label={tt('메트릭')} value={filters.metric} disabled={controlsDisabled} className={SELECT_STYLE}
                onChange={(event) => setFilters((current) => ({ ...current, metric: event.target.value as NfmMetric }))}>
                {TOPOLOGY_METRICS.map((metric) => <option key={metric} value={metric}>{tt(METRIC_LABELS[metric])}</option>)}
              </select>
            </label>
            <label className="min-w-0 flex-1 basis-40 space-y-1 text-[11px] text-ink-500">
              <span>{tt('목적지 분류')}</span>
              <select aria-label={tt('목적지 분류')} value={filters.category} disabled={controlsDisabled} className={SELECT_STYLE}
                onChange={(event) => setFilters((current) => ({ ...current, category: event.target.value as NfmCategory | 'ALL' }))}>
                <option value="ALL">{tt('전체 분류')}</option>
                {TOPOLOGY_CATEGORIES.map((category) => <option key={category} value={category}>{category}</option>)}
              </select>
            </label>
            <label className="min-w-0 flex-1 basis-24 space-y-1 text-[11px] text-ink-500">
              <span>{tt('조회 범위')}</span>
              <select aria-label={tt('조회 범위')} value={filters.rangeSec} disabled={controlsDisabled} className={SELECT_STYLE}
                onChange={(event) => setFilters((current) => ({ ...current, rangeSec: Number(event.target.value) }))}>
                {TOPOLOGY_RANGES.map((range) => <option key={range} value={range}>{tt(RANGE_LABELS[range])}</option>)}
              </select>
            </label>
            <Button onClick={() => { void query(); }} disabled={controlsDisabled}>{tt('네트워크 조회')}</Button>
            {network.loading && <Button variant="secondary" onClick={clearNetwork}>{tt('조회 취소')}</Button>}
          </div>
          {network.loading && <p role="status" aria-label={tt('네트워크 조회 진행')} className="text-[12px] text-ink-600">
            {tt('네트워크 조회')} {network.completed} / {network.total} · {tt('관측 결과를 수집하고 있습니다.')}
          </p>}
          {network.error && <p role="alert" className="text-[12px] text-negative">{tt(network.error)}</p>}
          {changed && <p role="status" className="text-[12px] text-ink-600">{tt('조회 조건이 변경되었습니다. 조회를 눌러 적용하세요.')}</p>}
          {batch && <section aria-label={tt('적용된 네트워크 조회')} className="space-y-2 rounded-lg border border-ink-100 bg-card p-3 text-[11px] text-ink-600">
            <h2 className="break-words font-semibold text-ink-800">
              {tt('적용된 조회')} · {batch.filters.monitor} · {tt(METRIC_LABELS[batch.filters.metric])} · {batch.filters.category === 'ALL' ? tt('전체 분류') : batch.filters.category} · {tt(RANGE_LABELS[batch.filters.rangeSec])}
            </h2>
            <p>{batch.failedCategories.length && !batch.observations.length ? tt('네트워크 조회 실패')
              : batch.status === 'partial' ? tt('부분 성공') : tt('조회 완료')} · {tt('성공한 분류')} {batch.observations.length} · {tt('상위 기여자')} {rows}</p>
            {batch.failedCategories.length > 0 && <div role="alert" className="text-negative">
              <p>{tt('실패한 분류는 트래픽 유무를 판단할 수 없습니다.')}</p>
              <ul>{batch.failedCategories.map((category) => <li key={category} className="break-words">{category} · {tt(NETWORK_ERRORS[batch.errors[category] ?? 'query_failed'] ?? '조회 실패')}</li>)}</ul>
            </div>}
            {batch.cappedCategories.length > 0 && <p>{tt('상위 기여자 상한 도달:')} {batch.cappedCategories.join(', ')}</p>}
            {batch.observations.length > 0 && rows === 0 && <p>{tt('성공한 분류에서 조건에 맞는 상위 기여자가 없습니다. 전체 트래픽의 부재를 의미하지 않습니다.')}</p>}
            <details>
              <summary className="cursor-pointer">{tt('분류별 관측 구간')}</summary>
              <ul aria-label={tt('분류별 실제 관측 구간')} className="mt-2 flex flex-wrap gap-x-5 gap-y-1">
                {batch.observations.map((observation) => <li key={observation.category}>
                  {observation.category} · {observation.startTime || observation.endTime
                    ? <>{time(observation.startTime)} → {time(observation.endTime)}</> : tt('관측 시각 알 수 없음')}
                </li>)}
              </ul>
            </details>
            {mismatchedCategories.length > 0 && <p role="alert">
              {tt('서비스 스냅샷과 NFM 관측 시각이 일치하지 않습니다:')} {mismatchedCategories.join(', ')}
            </p>}
          </section>}
        </>}
        <details className="text-[11px] text-ink-500">
          <summary className="cursor-pointer">{tt('관측 범위 안내')}</summary>
          <div className="mt-2 space-y-1">
            <p>{tt('수집된 구성 관계이며 실제 트래픽의 증거는 아닙니다.')}</p>
            <p>{tt('저장된 표본이며 현재의 모든 서비스 호출을 나타내지 않습니다.')}</p>
            <p>{tt('NFM은 호스트 계정의 설정된 AWS 리전에서만 조회합니다.')}</p>
            <p>{tt('NFM은 상위 기여자의 부분 관측입니다. 분류별 관측 구간은 서로 다를 수 있으며, 독립적인 관측을 하나의 추적된 요청이나 E2E 합계로 해석하지 않습니다.')}</p>
          </div>
        </details>
        <E2eGraphCanvas graph={graph} />
      </div>
    </div>
  );
}
