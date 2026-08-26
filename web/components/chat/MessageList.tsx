'use client';
import { memo, useEffect, useRef, useState } from 'react';
import { sectionByKey } from '@/lib/sections';
import Markdown from './Markdown';

// 스트리밍 중에도 마크다운을 렌더하되(owner: "렌더링이 늦게 됩니다"), 토큰마다 전체
// 재파싱하는 O(n²)를 피하기 위해 파싱 입력을 ~180ms로 스로틀한다. 미완성 코드펜스는
// 짝을 맞춰 닫아 절반 파싱 플래시를 줄인다 (트레일링 업데이트 보장: 마지막 값 반영).
function useThrottled<T>(value: T, ms = 180): T {
  const [v, setV] = useState(value);
  const last = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const now = Date.now();
    const due = last.current + ms - now;
    if (due <= 0) {
      last.current = now;
      setV(value);
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { last.current = Date.now(); setV(value); }, due);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [value, ms]);
  return v;
}

/** 홀수 개의 ``` 는 파서가 이후 전체를 코드로 삼켜버림 — 스트리밍 중에만 임시로 닫는다. */
function balanceFences(md: string): string {
  const fences = (md.match(/```/g) ?? []).length;
  return fences % 2 === 1 ? `${md}\n\`\`\`` : md;
}

const StreamingMarkdown = memo(function StreamingMarkdown({ content }: { content: string }) {
  const throttled = useThrottled(content);
  return <Markdown>{balanceFences(throttled)}</Markdown>;
});

export interface RankedChip { key: string; score: number; active: boolean }
export interface QueryPreview { tool: string; query: string }
export interface Msg {
  role: 'user' | 'assistant'; content: string; gateway?: string; streaming?: boolean;
  ranked?: RankedChip[]; method?: string; // ADR-038 meta
  via?: string; // ADR-044 meta: 'multi:network+data' when the answer is a cross-domain synthesis
  status?: { phase: string; elapsedMs?: number; tool?: string; query?: string };
  // Answer-provenance footer (design handoff 개선안 ③): known only after the invoke resolves,
  // so these arrive on a second `meta` frame — absent against a legacy agent image.
  tools?: string[]; model?: string; elapsedMs?: number;
  // v1-parity footer extras (2026-07-19): per-answer token usage + estimated USD (agent must
  // report usage AND a priced model), and the generated queries surfaced during the run.
  usage?: { inputTokens: number; outputTokens: number }; costUsd?: number;
  queries?: QueryPreview[];
}

function fmtCost(usd: number): string {
  if (usd <= 0) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(3)}`;
}

function statusLabel(s: { phase: string; elapsedMs?: number }): string {
  const secs = s.elapsedMs !== undefined ? ` ${Math.floor(s.elapsedMs / 1000)}초` : '';
  switch (s.phase) {
    case 'code-generating': return `💻 코드 생성 중…${secs}`;
    case 'code-executing': return `⚡ 코드 실행 중…${secs}`;
    case 'querying': return `🔎 쿼리 실행 중…${secs}`;
    case 'sql-unavailable': return '🗃️ 라이브 SQL 미가용 — 일반 라우팅으로 전환…';
    case 'sql-fallback': return `🗃️ SQL 실행 실패 — 일반 지식으로 답변 중…${secs}`;
    case 'collect-fallback': return `📡 데이터 수집 실패 — 일반 지식으로 답변 중…${secs}`;
    case 'working': return `🔎 분석 중…${secs}`;
    default: return '🔎 분석 중…';
  }
}

// Mirrors agent.py's MODEL_ID label for the (rare) legacy-image case where the stream carries
// no `{"model": ...}` provenance frame — never shown once a redeployed agent reports its own.
const FALLBACK_MODEL_LABEL = 'Claude Sonnet 4.6';

export default function MessageList({ msgs, onSwitch, onFollowUp }: { msgs: Msg[]; onSwitch?: (key: string) => void; onFollowUp?: (q: string) => void }) {
  return (
    <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
      {msgs.map((m, i) => {
        const sec = m.gateway ? sectionByKey(m.gateway) : null;
        const me = m.role === 'user';
        // ADR-044: a cross-domain synthesis answer — the keys merged into this one answer.
        const viaKeys = (!me && m.via?.startsWith('multi:')) ? m.via.slice(6).split('+').filter(Boolean) : null;
        const viaSet = new Set(viaKeys ?? []);
        // ADR-038/044: active alternates the answer did NOT already cover — a SECONDARY manual aid
        // (cross-domain is handled automatically by synthesis), shown once streaming ends.
        const alts = (!me && !m.streaming && m.ranked)
          ? m.ranked.filter((r) => r.active && r.key !== m.gateway && !viaSet.has(r.key)).slice(0, 2)
          : [];
        return (
          <div
            key={i}
            className={
              'rounded-lg px-3 py-2.5 ' +
              (me
                ? 'max-w-[85%] self-end border border-brand-100 bg-brand-50 text-ink-800'
                : 'max-w-[92%] self-start border border-ink-100 bg-card text-ink-700 shadow-sm')
            }
          >
            {viaKeys && viaKeys.length > 1 ? (
              <div className="mb-1.5 flex flex-wrap items-center gap-1.5 text-[11px] font-semibold text-ink-500" aria-label="통합 분석">
                {viaKeys.map((k, idx) => {
                  const s = sectionByKey(k);
                  return s ? (
                    <span key={k} className="flex items-center gap-1">
                      {idx > 0 && <span className="text-ink-300">+</span>}
                      <span className="inline-block h-[7px] w-[7px] rounded-full" style={{ background: s.color }} />
                      <span style={{ color: s.color }}>{s.label}</span>
                    </span>
                  ) : null;
                })}
                <span className="ml-1 font-normal text-ink-400">· 통합 분석</span>
              </div>
            ) : sec && (
              <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold text-ink-500">
                <span className="inline-block h-[7px] w-[7px] rounded-full" style={{ background: sec.color }} />
                {sec.label}
              </div>
            )}
            {/* User messages stay plain text. Assistant messages render Markdown even WHILE
                streaming (throttled parse + balanced fences — see StreamingMarkdown), so the
                formatting doesn't "arrive late" after the stream ends. */}
            {me
              ? <div className="whitespace-pre-wrap text-[13px] leading-relaxed">{m.content}</div>
              : m.streaming && !m.content
                ? (m.status
                  ? <div className="text-[13px] leading-relaxed text-ink-500">
                      <div className="whitespace-pre-wrap">{statusLabel(m.status)}</div>
                      {/* v1-parity: show the generated query (SQL/PromQL/...) as it runs */}
                      {m.status.query && (
                        <pre className="mt-1.5 max-h-32 overflow-auto rounded border border-ink-100 bg-paper-muted px-2 py-1 font-mono text-[11px] text-ink-600">{m.status.query}</pre>
                      )}
                    </div>
                  : null)
                : m.streaming
                  ? <StreamingMarkdown content={m.content} />
                  : <Markdown>{m.content}</Markdown>}
            {m.streaming && (!m.content && m.status ? null : <span className="ml-0.5 inline-block h-3 w-[6px] translate-y-0.5 animate-pulse bg-brand-500 align-middle" />)}
            {!me && !m.streaming && sec && (
              <div className="mt-3 border-t border-ink-100 pt-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-md border border-brand-200 bg-brand-50 px-2 py-0.5 font-mono text-[11px] font-semibold text-brand-700">
                    AgentCore → {sec.label} Gateway
                  </span>
                  <span className="font-mono text-[11px] text-ink-500">{m.model ?? FALLBACK_MODEL_LABEL}</span>
                  {m.elapsedMs !== undefined && (
                    <span className="tabular-nums text-[11px] text-ink-300">{(m.elapsedMs / 1000).toFixed(1)}s</span>
                  )}
                  {/* v1-parity per-answer cost feedback: tokens + estimated USD */}
                  {m.usage && (
                    <span className="tabular-nums text-[11px] text-ink-400" title={`in ${m.usage.inputTokens.toLocaleString()} · out ${m.usage.outputTokens.toLocaleString()} tokens`}>
                      {(m.usage.inputTokens + m.usage.outputTokens).toLocaleString()} tok
                      {m.costUsd !== undefined && <span className="text-ink-300"> · ~{fmtCost(m.costUsd)}</span>}
                    </span>
                  )}
                  <button
                    onClick={() => void navigator.clipboard?.writeText(m.content)}
                    aria-label="답변 복사"
                    className="ml-auto text-ink-400 hover:text-ink-800"
                  >
                    ⧉ 복사
                  </button>
                </div>
                {m.tools && m.tools.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <span className="text-[10px] text-ink-400">Tools</span>
                    {m.tools.slice(0, 4).map((t) => (
                      <span key={t} className="rounded border border-ink-100 bg-paper-muted px-1.5 py-0.5 font-mono text-[10.5px] text-ink-500">
                        {t}
                      </span>
                    ))}
                    {m.tools.length > 4 && <span className="text-[10.5px] text-ink-300">+{m.tools.length - 4}</span>}
                  </div>
                )}
              </div>
            )}
            {/* v1-parity followUpMap: post-answer deepening suggestions for the answered section. */}
            {!me && !m.streaming && sec?.followUps && sec.followUps.length > 0 && onFollowUp && (
              <div className="mt-2">
                <div className="mb-1 text-[10px] text-ink-400">이어서 물어보기</div>
                <div className="flex flex-wrap gap-1.5">
                  {sec.followUps.slice(0, 3).map((q) => (
                    <button
                      key={q}
                      onClick={() => onFollowUp(q)}
                      className="rounded-md border border-ink-100 bg-paper-muted px-2 py-1 text-left text-[11px] text-ink-600 transition-colors hover:border-brand-200 hover:text-brand-700"
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {alts.length > 0 && (
              <div className="mt-2">
                {/* ADR-044: chips are a SECONDARY manual aid (cross-domain is auto-synthesized). */}
                <div className="mb-1 text-[10px] text-ink-400">다른 도메인으로 더 보기</div>
                <div className="flex flex-wrap gap-1.5">
                {alts.map((r) => {
                  const s = sectionByKey(r.key);
                  if (!s) return null;
                  return (
                    <button
                      key={r.key}
                      onClick={() => onSwitch?.(r.key)}
                      aria-label={`${s.label}로 다시`}
                      className="rounded-md border px-2 py-1 text-[11px] font-medium transition-colors"
                      style={{
                        // s.color is a CSS var — alpha via color-mix, not hex-suffix concat
                        background: `color-mix(in srgb, ${s.color} 7%, transparent)`,
                        borderColor: `color-mix(in srgb, ${s.color} 25%, transparent)`,
                        color: s.color,
                      }}
                    >
                      → {s.label}로 다시
                    </button>
                  );
                })}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
