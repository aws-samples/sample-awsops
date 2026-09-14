'use client';

import { useI18n } from '@/components/shell/LanguageProvider';

export interface GraphCollection {
  status: string;
  stale: boolean;
  retainedPrevious?: boolean;
  sources?: { sourceId: string; status: string; reasons?: string[]; itemCount?: number }[];
}

// Defensive compatibility with producers that supply collection metadata.
// Snapshot-only producers remain supported: absent metadata is neutral unknown,
// not evidence of a collector failure.
const COPY = {
  ko: {
    ok: '최근 수집 성공', empty: '조회한 시간 범위에 관측값 없음', partial: '부분 수집 — 전체 상태를 확정할 수 없음',
    unavailable: '데이터소스 미연결 또는 미가용', error: '수집 실패', unknown: '수집 상태 미확인',
    stale: '오래된 데이터', retained: '이전 그래프를 표시합니다. 현재 트래픽 상태를 의미하지 않습니다.',
    attempted: '최근 수집 시도', captured: '저장된 그래프 시각',
    sourceCapture: '원본 행 수집 시각', lastSuccess: '최근 성공한 수집', inventoryEmpty: '성공한 수집의 그래프가 비어 있음',
    savedSources: '저장된 그래프의 원본', refresh: '최근 그래프 갱신 시도',
    sourceDetails: '원본 상세', limited: '처리 한도 초과 — 이전 그래프를 유지합니다.',
  },
  en: {
    ok: 'Latest collection succeeded', empty: 'No observations in this window', partial: 'Partial collection — coverage is incomplete',
    unavailable: 'Datasource unavailable or not configured', error: 'Collection failed', unknown: 'Collection state unknown',
    stale: 'Stale data', retained: 'Showing the previous graph; it does not establish current traffic state.',
    attempted: 'Latest collection attempt', captured: 'Saved graph time',
    sourceCapture: 'Source capture', lastSuccess: 'Last successful sweep', inventoryEmpty: 'Successful collection produced an empty graph',
    savedSources: 'Sources used by saved graph', refresh: 'Latest graph refresh attempt',
    sourceDetails: 'Source details', limited: 'Processing limit reached — previous graph retained.',
  },
  ja: {
    ok: '最新の収集に成功', empty: '対象期間に観測値なし', partial: '部分収集 — 全体の状態は未確認',
    unavailable: 'データソース未設定または利用不可', error: '収集失敗', unknown: '収集状態不明',
    stale: '古いデータ', retained: '以前のグラフを表示しています。現在の通信状態を示すものではありません。',
    attempted: '最新の収集試行', captured: '保存されたグラフの時刻',
    sourceCapture: '元データの収集時刻', lastSuccess: '最後に成功した収集', inventoryEmpty: '成功した収集のグラフは空です',
    savedSources: '保存されたグラフの元データ', refresh: '最新のグラフ更新試行',
    sourceDetails: '元データの詳細', limited: '処理上限に到達 — 以前のグラフを保持します。',
  },
  zh: {
    ok: '最近一次采集成功', empty: '查询时间范围内无观测值', partial: '部分采集 — 覆盖范围不完整',
    unavailable: '数据源不可用或未配置', error: '采集失败', unknown: '采集状态未知',
    stale: '数据已过期', retained: '正在显示上一次的图，不能据此判断当前流量状态。',
    attempted: '最近一次采集尝试', captured: '已保存图的时间',
    sourceCapture: '源数据采集时间', lastSuccess: '最后成功采集', inventoryEmpty: '成功采集的图为空',
    savedSources: '已保存图使用的源数据', refresh: '最近一次图刷新尝试',
    sourceDetails: '源数据详情', limited: '达到处理上限 — 保留上一次的图。',
  },
};
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const STATUSES = ['ok', 'empty', 'partial', 'unavailable', 'error', 'unknown'] as const;
const statusOf = (value: unknown) => STATUSES.find(status => status === value) ?? 'unknown';

export default function GraphCollectionStatus({ collection }: { collection?: unknown }) {
  const { lang } = useI18n();
  const copy = COPY[lang];
  const data = record(collection);
  const status = statusOf(data.status);
  const retained = data.retainedPrevious === true;
  const warning = data.stale === true || retained || ['partial', 'unavailable', 'error'].includes(status);
  const sources = Array.isArray(data.sources) ? data.sources.map(record) : [];
  const published = retained && Array.isArray(data.publishedSources) ? data.publishedSources.map(record) : [];
  const counts = sources.reduce<Record<string, number>>((result, source) => {
    const key = statusOf(source.status);
    result[key] = (result[key] ?? 0) + 1;
    return result;
  }, {});
  const sourceTimes = (source: Record<string, unknown>) => (['capturedAtMs', 'lastSuccessAtMs'] as const).map(key => {
    const value = source[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 8640000000000000) return null;
    const iso = new Date(value).toISOString();
    return <span key={key} className="block">{key === 'capturedAtMs' ? copy.sourceCapture : copy.lastSuccess}
      {' · '}<time dateTime={iso}>{new Date(value).toLocaleString()}</time></span>;
  });
  return (
    <div role={warning ? 'alert' : 'status'}
      className={`my-2 max-h-[36vh] shrink-0 overflow-y-auto rounded-md border px-3 py-2 text-xs ${warning
        ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-ink-200 bg-card text-ink-600'}`}>
      <p className="font-medium">{status === 'empty' && data.evidenceKind === 'inventory' ? copy.inventoryEmpty : copy[status]}{data.stale === true ? ` · ${copy.stale}` : ''}</p>
      {retained && <p className="mt-1">{copy.retained}</p>}
      {(data.inputTruncated === true || data.graphTruncated === true) && <p>{copy.limited}</p>}
      {(['attempted_at', 'captured_at'] as const).map(key => {
        const value = data[key];
        return typeof value === 'string' && Number.isFinite(Date.parse(value))
          ? <p key={key}>{key === 'attempted_at' ? (data.evidenceKind === 'inventory' ? copy.refresh : copy.attempted) : copy.captured} · <time dateTime={value}>{new Date(value).toLocaleString()}</time></p>
          : null;
      })}
      {sources.length + published.length > 0 && <details className="mt-1">
        <summary className="cursor-pointer break-words font-medium">
          {copy.sourceDetails} ({sources.length})
          {STATUSES.filter(key => counts[key]).map(key => <span key={key}> · {counts[key]} {copy[key]}</span>)}
        </summary>
        <div data-source-details className="max-h-[18vh] overflow-y-auto overscroll-contain">
      {sources.length > 0 && <ul className="mt-1 space-y-1">
        {sources.map((source, i) => {
          const reasons = Array.isArray(source.reasons) ? source.reasons.filter(reason => typeof reason === 'string') : [];
          return <li key={i} className="break-words">
            <span className="font-mono">{typeof source.sourceId === 'string' ? source.sourceId : '—'}</span>: {copy[statusOf(source.status)]}
            {source.scope === 'aggregate' || source.scope === 'account' ? <span> · {source.scope}</span> : null}
            {reasons.length > 0 && <span> · {reasons.join(', ')}</span>}
            {sourceTimes(source)}
          </li>;
        })}
      </ul>}
      {published.length > 0 ? <div className="mt-2">
        <p>{copy.savedSources}</p>
        <ul>{published.map((source, i) => <li key={i}>
          {typeof source.sourceId === 'string' ? source.sourceId : '—'}{sourceTimes(source)}
        </li>)}</ul>
      </div> : null}
        </div>
      </details>}
    </div>
  );
}
