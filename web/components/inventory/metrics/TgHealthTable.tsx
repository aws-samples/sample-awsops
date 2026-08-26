'use client';
import { useMemo } from 'react';
import { useI18n } from '@/components/shell/LanguageProvider';
import MetricTable, { type MetricCol } from './MetricTable';

// 타깃 그룹 헬스 테이블 (ALB/NLB 공용) — Healthy/UnHealthyHostCount는 TG 차원이어야 의미.
// Healthy = 선택 기간 최소값(순간 이탈 감지), UnHealthy = 선택 기간 최대값.
// 정렬/검색/facet/문제만 필터는 MetricTable이 제공.
export interface TgHealthRow { tg: string; tgName: string; lbDim: string; healthy: number | null; unhealthy: number | null }

type Item = TgHealthRow & { lbName: string };

const buildColumns = (tt: (s: string) => string): MetricCol<Item>[] => [
  { key: 'tgName', label: 'Target Group', mono: true, value: (it) => it.tgName },
  { key: 'lb', label: 'Load Balancer', mono: true, facet: true, value: (it) => it.lbName },
  {
    key: 'healthy', label: 'Healthy (min)', type: 'num',
    title: tt('HealthyHostCount — 0이면 가용 타깃 없음 (ALB는 503 발생)'),
    value: (it) => it.healthy,
    render: (it) => (it.healthy == null ? null : Math.round(it.healthy)),
    danger: (it) => it.healthy != null && it.healthy <= 0,
  },
  {
    key: 'unhealthy', label: 'UnHealthy (max)', type: 'num',
    title: tt('UnHealthyHostCount — >0이면 헬스체크 실패 원인 조사'),
    value: (it) => it.unhealthy,
    render: (it) => (it.unhealthy == null ? null : Math.round(it.unhealthy)),
    danger: (it) => it.unhealthy != null && it.unhealthy > 0,
  },
];

export default function TgHealthTable({ health, lbDims }: { health: TgHealthRow[]; lbDims: Record<string, string> }) {
  const { tt } = useI18n();
  const columns = useMemo(() => buildColumns(tt), [tt]);
  const items: Item[] = useMemo(
    () => health.map((hRow) => ({
      ...hRow,
      lbName: Object.entries(lbDims).find(([, d]) => d === hRow.lbDim)?.[0] ?? hRow.lbDim,
    })),
    [health, lbDims],
  );
  if (health.length === 0) return null;
  return (
    <div className="border-t border-ink-100">
      <div className="px-4 pt-3 text-[12.5px] font-semibold text-ink-700">{tt('타깃 그룹 헬스 (Healthy 최소값 / UnHealthy 최대값, 선택 기간)')}</div>
      <MetricTable columns={columns} items={items} rowKey={(it, i) => `${it.tg}|${it.lbDim}|${i}`} />
    </div>
  );
}
