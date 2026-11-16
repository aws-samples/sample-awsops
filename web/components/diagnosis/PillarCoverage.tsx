'use client';
import { useI18n } from '@/components/shell/LanguageProvider';

const PILLARS = [
  ['operational_excellence', '운영 우수성'],
  ['security', '보안'],
  ['reliability', '안정성'],
  ['performance_efficiency', '성능 효율성'],
  ['cost_optimization', '비용 최적화'],
  ['sustainability', '지속 가능성'],
] as const;

type Coverage = {
  status: 'completed' | 'partial' | 'failed';
  findings: number;
  rejected: number;
  downgraded?: number;
};
const LABELS = { completed: '후보 생성 완료', partial: '일부 후보 생성', failed: '분석 실패' };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function coverage(value: unknown): Coverage | null {
  const row = record(value);
  if (!row || typeof row.status !== 'string'
      || !['completed', 'partial', 'failed'].includes(row.status)) return null;
  if (![row.findings, row.rejected].every((n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)) return null;
  if (row.status === 'failed' && row.findings !== 0) return null;
  return row as Coverage;
}

export default function PillarCoverage({ value }: { value: unknown }) {
  const { tt } = useI18n();
  const raw = record(value);
  const rows = PILLARS.map(([key, label]) => ({ key, label, result: coverage(raw?.[key]) }));
  const allFailed = rows.every((row) => row.result?.status === 'failed');
  return (
    <section aria-label={tt('6-pillar 분석')} className="mb-4 rounded-lg border border-ink-200 bg-paper p-4">
      <h2 className="text-sm font-semibold text-ink-800">{tt('6-pillar 분석')}</h2>
      <p className="mt-1 text-xs text-ink-500">{tt('후보 생성 완료는 리소스가 정상임을 뜻하지 않습니다.')}</p>
      <p className="mt-1 text-xs text-ink-500">
        {tt('후보는 종합 검토에서 제외될 수 있습니다. 최종 반영 여부는 아래 보고서에서 확인하세요.')}
      </p>
      {allFailed && (
        <p role="alert" className="mt-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {tt('모든 pillar 분석이 실패했습니다. 이 보고서는 정상 여부를 평가한 결과가 아닙니다.')}
        </p>
      )}
      <ul className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {rows.map(({ key, label, result }) => (
          <li key={key} className="rounded-md border border-ink-100 p-3">
            <h3 className="text-sm font-medium text-ink-800">{tt(label)}</h3>
            <p className={`mt-1 text-xs ${result?.status === 'failed' ? 'text-red-700'
              : result?.status === 'partial' ? 'text-amber-700' : 'text-ink-600'}`}>
              {tt(result ? LABELS[result.status] : '기록 없음')}
            </p>
            {result && (
              <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-ink-500">
                {/* The worker records admissions before cross-pillar review.
                    Review withholdings can span passes, so they cannot be subtracted
                    from these counts to infer final published findings. */}
                <p>{tt('검토 전 후보')} {result.findings}</p>
                {result.rejected > 0 && <p>{tt('근거 검증 제외')} {result.rejected}</p>}
                {typeof result.downgraded === 'number' && Number.isSafeInteger(result.downgraded)
                  && result.downgraded > 0 && <p>{tt('가설로 조정')} {result.downgraded}</p>}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
