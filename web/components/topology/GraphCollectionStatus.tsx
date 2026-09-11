'use client';

import { useI18n } from '@/components/shell/LanguageProvider';

export interface GraphCollection {
  status: string;
  stale: boolean;
  retainedPrevious?: boolean;
  sources?: { sourceId: string; status: string; reasons?: string[]; itemCount?: number }[];
}

const COPY = {
  ko: {
    ok: '최근 수집 성공', empty: '조회한 시간 범위에 관측값 없음', partial: '부분 수집 — 전체 상태를 확정할 수 없음',
    unavailable: '데이터소스 미연결 또는 미가용', error: '수집 실패', unknown: '수집 상태 미확인',
    stale: '오래된 데이터', retained: '이전 그래프를 표시합니다. 현재 트래픽 상태를 의미하지 않습니다.',
  },
  en: {
    ok: 'Latest collection succeeded', empty: 'No observations in this window', partial: 'Partial collection — coverage is incomplete',
    unavailable: 'Datasource unavailable or not configured', error: 'Collection failed', unknown: 'Collection state unknown',
    stale: 'Stale data', retained: 'Showing the previous graph; it does not establish current traffic state.',
  },
  ja: {
    ok: '最新の収集に成功', empty: '対象期間に観測値なし', partial: '部分収集 — 全体の状態は未確認',
    unavailable: 'データソース未設定または利用不可', error: '収集失敗', unknown: '収集状態不明',
    stale: '古いデータ', retained: '以前のグラフを表示しています。現在の通信状態を示すものではありません。',
  },
  zh: {
    ok: '最近一次采集成功', empty: '查询时间范围内无观测值', partial: '部分采集 — 覆盖范围不完整',
    unavailable: '数据源不可用或未配置', error: '采集失败', unknown: '采集状态未知',
    stale: '数据已过期', retained: '正在显示上一次的图，不能据此判断当前流量状态。',
  },
};

export default function GraphCollectionStatus({ collection }: { collection?: GraphCollection }) {
  const { lang } = useI18n();
  const copy = COPY[lang];
  const status = collection?.status ?? 'unknown';
  const message = copy[status as keyof typeof copy] ?? copy.unknown;
  const warning = !collection || collection.stale || !['ok', 'empty'].includes(status);
  return (
    <div role={warning ? 'alert' : 'status'}
      className={`mx-4 my-2 rounded-md border px-3 py-2 text-xs ${warning
        ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-ink-200 bg-card text-ink-600'}`}>
      <p className="font-medium">{message}{collection?.stale ? ` · ${copy.stale}` : ''}</p>
      {collection?.retainedPrevious && <p className="mt-1">{copy.retained}</p>}
      {!!collection?.sources?.length && (
        <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
          {collection.sources.map((source, i) => (
            <li key={`${source.sourceId}:${i}`} title={source.reasons?.join(', ')}>
              <span className="font-mono">{source.sourceId}</span>: {copy[source.status as keyof typeof copy] ?? copy.unknown}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
