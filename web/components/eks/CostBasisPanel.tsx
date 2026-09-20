'use client';
import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import Card from '@/components/ui/Card';
import { useI18n } from '@/components/shell/LanguageProvider';
import { ESTIMATE_UNIT_PRICES, estimateDailyCost } from '@/lib/cost-basis';

// Cost Calculation Basis (gap L217, v1 parity intent): a collapsible transparency panel on
// /eks/cost documenting HOW the numbers are made — the two methods, the estimate formula with
// the LIVE unit constants (single source: lib/cost-basis.ts — the documented numbers can
// never drift from the computed ones), a worked example, and the caveats. Deliberately NOT
// v1's per-instance EC2 price grid: v2 does not price by instance type.

const EXAMPLE = { vcpu: 0.5, memGb: 1 };

export default function CostBasisPanel() {
  const { tt } = useI18n();
  const [open, setOpen] = useState(false);
  const cpuPart = EXAMPLE.vcpu * ESTIMATE_UNIT_PRICES.vcpuHour * 24;
  const memPart = EXAMPLE.memGb * ESTIMATE_UNIT_PRICES.gbHour * 24;
  const exTotal = estimateDailyCost(EXAMPLE.vcpu, EXAMPLE.memGb);

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
            <table className="w-full min-w-[420px] text-left text-[12px]">
              <thead>
                <tr className="border-b border-ink-100 text-[11px] uppercase tracking-wide text-ink-400">
                  <th className="py-1.5 pr-3">{tt('비용 항목')}</th>
                  <th className="py-1.5 pr-3">OpenCost {tt('실측')}</th>
                  <th className="py-1.5">{tt('요청 기반 추정')}</th>
                </tr>
              </thead>
              <tbody>
                {([
                  ['CPU', true, true],
                  ['RAM', true, true],
                  ['Network', true, false],
                  ['PV (스토리지)', true, false],
                  ['GPU', true, false],
                ] as const).map(([item, oc, est]) => (
                  <tr key={item} className="border-b border-ink-50 last:border-0">
                    <td className="py-1.5 pr-3">{tt(item)}</td>
                    <td className="py-1.5 pr-3">{oc ? '✓' : '—'}</td>
                    <td className="py-1.5">{est ? '✓' : <span className="text-ink-400">{tt('추정 모드에선 미집계')}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-400">{tt('추정 수식 (Fargate형 온디맨드 단가, ap-northeast-2)')}</div>
            <pre className="overflow-x-auto rounded bg-ink-50 p-2 font-mono text-[11.5px] leading-relaxed text-ink-700">
{`daily = vCPU request × $${ESTIMATE_UNIT_PRICES.vcpuHour}/vCPU-h × 24h
      + memory(GB) × $${ESTIMATE_UNIT_PRICES.gbHour}/GB-h × 24h
monthly ≈ daily × 30  (실측/추정 공통)`}
            </pre>
          </div>

          <div>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-400">{tt('계산 예시')}</div>
            <p className="font-mono text-[11.5px] text-ink-600">
              {EXAMPLE.vcpu} vCPU + {EXAMPLE.memGb} GB → ${cpuPart.toFixed(3)} + ${memPart.toFixed(3)} = <b>${exTotal.toFixed(2)}/day</b>
            </p>
          </div>

          <div>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-400">{tt('주의사항')}</div>
            <ul className="list-disc space-y-1 pl-5 text-[12px] text-ink-600">
              <li>{tt('추정 단가는 Fargate형 온디맨드 기준 — 인스턴스 타입별 EC2 단가가 아닙니다.')}</li>
              <li>{tt('Spot / RI / Savings Plans 할인은 반영되지 않습니다.')}</li>
              <li>{tt('Succeeded(종료) 파드는 추정에서 제외됩니다.')}</li>
              <li>{tt('요청(request)은 실제 사용량이 아닙니다 — 과다/과소 요청은 추정을 왜곡합니다.')}</li>
              <li>{tt('할당 기준 Network/PV/GPU 비용은 OpenCost 설치 시에만 집계됩니다 — 표의 NFM Transfer/Day 컬럼은 별도의 네트워크 전송 실측입니다.')}</li>
            </ul>
          </div>
        </div>
      )}
    </Card>
  );
}
