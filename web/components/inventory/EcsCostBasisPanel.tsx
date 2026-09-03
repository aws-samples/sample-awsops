'use client';
import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import Card from '@/components/ui/Card';
import { useI18n } from '@/components/shell/LanguageProvider';
import { ESTIMATE_UNIT_PRICES, estimateDailyCost } from '@/lib/cost-basis';

// Cost Calculation Basis for the ECS Tasks page (gap L194, v1 container-cost parity): a
// collapsible transparency panel documenting HOW the Daily $/Monthly estimates on this page
// are made — the unit-price table, the deriver's own formula (cpu units/1024, MB/1024), a
// worked example, and the caveats. Single source: lib/cost-basis.ts — the ecs_task deriver
// computes from the SAME constants, so the documented numbers can never drift. Deliberate
// deviations from v1's panel: ephemeral storage is NOT priced (v2's estimator has no storage
// term) and v1's config.json price override does not exist in v2.

const EXAMPLE = { cpuUnits: 512, memMb: 1024 };

export default function EcsCostBasisPanel() {
  const { tt } = useI18n();
  const [open, setOpen] = useState(false);
  const exDaily = estimateDailyCost(EXAMPLE.cpuUnits / 1024, EXAMPLE.memMb / 1024);

  return (
    <Card padded={false}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-4 py-3 text-left text-[13px] font-semibold text-ink-800"
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {tt('비용 계산 근거')}
      </button>
      {open && (
        <div className="flex flex-col gap-4 border-t border-ink-100 px-4 py-4 text-[12.5px] text-ink-700">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[320px] text-left text-[12px]">
              <thead>
                <tr className="border-b border-ink-100 text-[11px] uppercase tracking-wide text-ink-400">
                  <th className="py-1.5 pr-3">{tt('리소스')}</th>
                  <th className="py-1.5">{tt('단가 (Fargate 온디맨드, ap-northeast-2)')}</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-ink-50">
                  <td className="py-1.5 pr-3">vCPU</td>
                  <td className="py-1.5 font-mono">${ESTIMATE_UNIT_PRICES.vcpuHour}/vCPU-h</td>
                </tr>
                <tr>
                  <td className="py-1.5 pr-3">{tt('메모리')}</td>
                  <td className="py-1.5 font-mono">${ESTIMATE_UNIT_PRICES.gbHour}/GB-h</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-400">{tt('추정 수식')}</div>
            <pre className="overflow-x-auto rounded bg-ink-50 p-2 font-mono text-[11.5px] leading-relaxed text-ink-700">
{`daily = (cpu units ÷ 1024) × $${ESTIMATE_UNIT_PRICES.vcpuHour}/vCPU-h × 24h
      + (memory MB ÷ 1024) × $${ESTIMATE_UNIT_PRICES.gbHour}/GB-h × 24h
monthly ≈ daily × 30`}
            </pre>
          </div>

          <div>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-400">{tt('계산 예시')}</div>
            <p className="font-mono text-[11.5px] text-ink-600">
              {EXAMPLE.cpuUnits} CPU units (0.5 vCPU) + {EXAMPLE.memMb} MB → <b>${exDaily.toFixed(2)}/day</b> ≈ ${(exDaily * 30).toFixed(2)}/mo
            </p>
          </div>

          <div>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-400">{tt('주의사항')}</div>
            <ul className="list-disc space-y-1 pl-5 text-[12px] text-ink-600">
              <li>{tt('FARGATE launch type 태스크만 추정합니다 — EC2 launch type 태스크는 인스턴스 비용에 포함되므로 추정하지 않습니다(빈 값).')}</li>
              <li>{tt('임시(ephemeral) 스토리지 비용은 반영되지 않습니다.')}</li>
              <li>{tt('단가는 고정 상수입니다 — Spot / Savings Plans 할인은 반영되지 않습니다.')}</li>
              <li>{tt('월 추정 = 일일 × 30 (태스크가 한 달 내내 실행된다고 가정).')}</li>
              <li>{tt('근사 추정치입니다 — 실제 청구액은 Cost 페이지에서 확인하세요.')}</li>
            </ul>
          </div>
        </div>
      )}
    </Card>
  );
}
