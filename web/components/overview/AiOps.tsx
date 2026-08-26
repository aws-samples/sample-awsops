'use client';
import { useEffect, useState } from 'react';
import { useI18n } from '@/components/shell/LanguageProvider';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import SectionLabel from '@/components/ui/SectionLabel';
import { SECTIONS, activeSections } from '@/lib/sections';

// Overview AI section (v1-parity ask: "AI Chat / AI 분석이 보여야") —
// built on data that actually exists today: the global chat (threads in Aurora)
// and the section-agent fleet. Opens the ChatDrawer via a window event.

interface Thread { id: string; title: string; updatedAt: string }

export function openChat(threadId?: string) {
  window.dispatchEvent(new CustomEvent('awsops:open-chat', { detail: { threadId } }));
}

export default function AiOps() {
  const { tt } = useI18n();
  const [threads, setThreads] = useState<Thread[] | null>(null);
  // awsops-only Bedrock cost (30d). null = loading/unavailable → keep the plain "보기 →" affordance.
  const [cost, setCost] = useState<number | null>(null);

  useEffect(() => {
    fetch('/api/chat/threads')
      .then((r) => (r.ok ? r.json() : { threads: [] }))
      .then((d) => setThreads(Array.isArray(d.threads) ? d.threads : []))
      .catch(() => setThreads([]));
  }, []);

  useEffect(() => {
    fetch('/api/ai-usage?range=30d')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setCost(d && typeof d.totalCost === 'number' ? d.totalCost : null))
      .catch(() => setCost(null));
  }, []);

  const active = activeSections().length;

  return (
    <section className="flex flex-col gap-3">
      <SectionLabel>AI OPERATIONS</SectionLabel>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* AI Assistant — chat entry */}
        <Card className="p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div className="text-[13px] font-semibold text-ink-800">✦ AI Assistant</div>
            <Badge tone="brand" variant="soft">{active}/{SECTIONS.length} 에이전트</Badge>
          </div>
          <p className="text-[12px] text-ink-500">
            섹션 전문 에이전트가 질문을 자동 분류해 라이브 AWS 데이터로 답합니다.
          </p>
          <button
            onClick={() => openChat()}
            className="self-start rounded-md bg-brand-500 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-brand-600"
          >
            대화 시작
          </button>
        </Card>

        {/* Recent AI conversations — click restores the thread in the drawer */}
        <Card className="p-4 flex flex-col gap-2">
          <div className="text-[13px] font-semibold text-ink-800">{tt('최근 AI 대화')}</div>
          {threads === null && <div className="text-[12px] text-ink-400">{tt('로딩 중…')}</div>}
          {threads !== null && threads.length === 0 && (
            <div className="text-[12px] text-ink-400">{tt('저장된 대화가 없습니다 — 첫 질문을 해보세요.')}</div>
          )}
          {(threads ?? []).slice(0, 5).map((t) => (
            <button
              key={t.id}
              onClick={() => openChat(t.id)}
              className="text-left text-[12px] text-ink-600 hover:text-brand-700 truncate"
              title={t.title}
            >
              • {t.title}
            </button>
          ))}
        </Card>

        {/* AI analysis surfaces — every row navigates (v1 parity), honest about live vs gated */}
        <Card className="p-4 flex flex-col gap-2">
          <div className="text-[13px] font-semibold text-ink-800">AI 분석</div>
          <a href="/eks" className="flex items-center justify-between text-[12px] text-ink-600 hover:text-brand-700">
            <span>EKS 진단 (K8sGPT)</span><Badge tone="neutral" variant="soft">{tt('게이트 OFF')}</Badge>
          </a>
          <a href="/ai-diagnosis" className="flex items-center justify-between text-[12px] text-ink-600 hover:text-brand-700">
            <span>{tt('인시던트 자동 분석')}</span><Badge tone="neutral" variant="soft">{tt('분석-전용 대기')}</Badge>
          </a>
          <a
            href="/bedrock"
            title="ADR-038 게이트 벤치마크 — 라이브 측정은 후속(Bedrock invocation-log 텔레메트리)"
            className="flex items-center justify-between text-[12px] text-ink-600 hover:text-brand-700"
          >
            <span>{tt('하이브리드 라우팅')}</span><Badge tone="neutral" variant="soft">게이트 96.9%</Badge>
          </a>
          <a
            href="/bedrock"
            title="awsops가 사용한 Bedrock 토큰 비용 (최근 30일, invocation-log 기준)"
            className="flex items-center justify-between text-[12px] text-ink-600 hover:text-brand-700"
          >
            <span>Bedrock 토큰 비용 (30d)</span>
            <Badge tone="brand" variant="soft">{cost != null ? `$${cost.toFixed(2)}` : '보기 →'}</Badge>
          </a>
        </Card>
      </div>
    </section>
  );
}
