'use client';
import { useEffect, useRef, useState } from 'react';
import type { Msg } from './MessageList';
import { sectionByKey } from '@/lib/sections';
import type { ThreadSummary, ThreadMessage } from '@/lib/chat-store';
import { getActiveAccount } from '@/lib/account-context';

export function newSessionId(): string {
  const s = (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.round(Math.random() * 1e9)}`);
  return s.length >= 33 ? s : s.padEnd(36, '0');
}

export function parseFrame(frame: string): {
  kind: 'meta' | 'status' | 'delta' | 'error' | 'done' | 'ignore';
  threadId?: string;
  gateway?: string;
  ranked?: any;
  method?: string;
  via?: string;
  tools?: string[];
  model?: string;
  phase?: string;
  elapsedMs?: number;
  delta?: string;
  error?: string;
  usage?: { inputTokens: number; outputTokens: number };
  costUsd?: number;
  tool?: string;
  query?: string;
} {
  const isMeta = frame.startsWith('event: meta');
  const isStatus = frame.startsWith('event: status');
  const line = frame.split('\n').find((l) => l.startsWith('data:'));
  if (!line) return { kind: 'ignore' };
  const data = line.slice(5).trim();
  if (data === '[DONE]') return { kind: 'done' };
  try {
    const obj = JSON.parse(data);
    // spread obj FIRST so a server payload field named `kind`/`delta`/`error` can never
    // override the classifier's discriminant (fail-closed).
    if (isMeta) return { ...obj, kind: 'meta' };
    if (isStatus) return { ...obj, kind: 'status' };
    if (obj.delta !== undefined) return { kind: 'delta', delta: obj.delta };
    if (obj.error) return { kind: 'error', error: obj.error };
  } catch {
    // heartbeat / non-JSON
  }
  return { kind: 'ignore' };
}


/**
 * Shared chat engine for the drawer (ChatDrawer) and the /assistant page.
 * Owns conversation state, SSE streaming, and thread CRUD against the same
 * Aurora-backed endpoints — so both surfaces share one history.
 *
 * UI-specific concerns (drawer open/resize, page query restore, the
 * `awsops:open-chat` event) live in the consumers, not here. Every action only
 * touches refs/setters, so a consumer may capture them once in a mount effect
 * without stale-closure hazards.
 */
export function useChat() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [busy, setBusy] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [showThreads, setShowThreads] = useState(false);
  const sessionRef = useRef<string>('');
  const abortRef = useRef<AbortController | null>(null);
  const threadIdRef = useRef<string | null>(null); // mirrors threadId for use inside send()
  const showThreadsRef = useRef(false);            // mirrors showThreads for post-send refresh

  function setThread(id: string | null) {
    threadIdRef.current = id;
    setThreadId(id);
    if (id) localStorage.setItem('awsops_chat_thread', id);
    else localStorage.removeItem('awsops_chat_thread');
  }

  useEffect(() => {
    let sid = localStorage.getItem('awsops_chat_session');
    if (!sid) { sid = newSessionId(); localStorage.setItem('awsops_chat_session', sid); }
    sessionRef.current = sid;
  }, []);

  function newChat() {
    abortRef.current?.abort();
    const sid = newSessionId();
    localStorage.setItem('awsops_chat_session', sid);
    sessionRef.current = sid;
    setThread(null); // previous conversation stays on the server — switching, not wiping
    setMsgs([]); setBusy(false);
  }

  async function refreshThreads(query?: string) {
    try {
      // v1-parity history search: ?q= filters the caller's own threads by message content.
      const url = query?.trim() ? `/api/chat/threads?q=${encodeURIComponent(query.trim())}` : '/api/chat/threads';
      const res = await fetch(url);
      const data = res.ok ? await res.json() : { threads: [] };
      setThreads(Array.isArray(data.threads) ? data.threads : []);
    } catch {
      setThreads([]);
    }
  }

  function toggleThreads() {
    const next = !showThreadsRef.current;
    showThreadsRef.current = next;
    setShowThreads(next);
    if (next) void refreshThreads();
  }

  async function selectThread(id: string) {
    abortRef.current?.abort(); // an in-flight stream must not patch into the restored thread
    setBusy(false);
    try {
      const res = await fetch(`/api/chat/threads/${id}`);
      if (!res.ok) { // stale/foreign thread — clear so it doesn't stick as blank history
        if (threadIdRef.current === id || localStorage.getItem('awsops_chat_thread') === id) setThread(null);
        return;
      }
      const data: { thread: ThreadSummary; messages: ThreadMessage[] } = await res.json();
      setMsgs(data.messages.map((m) => {
        const meta = (m.meta ?? {}) as { ranked?: Msg['ranked']; method?: string; via?: string; tools?: string[]; model?: string; elapsedMs?: number; usage?: Msg['usage']; costUsd?: number };
        return {
          role: m.role, content: m.content, gateway: m.gateway ?? undefined,
          ranked: meta.ranked, method: meta.method, via: meta.via,
          tools: meta.tools, model: meta.model, elapsedMs: meta.elapsedMs,
          usage: meta.usage, costUsd: meta.costUsd,
        };
      }));
      sessionRef.current = data.thread.sessionId;
      localStorage.setItem('awsops_chat_session', data.thread.sessionId);
      setThread(id);
    } catch { /* degrade: keep current view */ }
  }

  async function removeThread(id: string) {
    try { await fetch(`/api/chat/threads/${id}`, { method: 'DELETE' }); } catch { /* best-effort */ }
    if (threadIdRef.current === id) newChat();
    void refreshThreads();
  }

  async function removeAllThreads() {
    try { await fetch('/api/chat/threads', { method: 'DELETE' }); } catch { /* best-effort */ }
    newChat();
    void refreshThreads();
  }

  function patchLast(fn: (m: Msg) => Msg) {
    setMsgs((arr) => arr.map((m, i) => (i === arr.length - 1 && m.role === 'assistant' ? fn(m) : m)));
  }

  // v1식 자연스러운 타자기 렌더(owner: "렌더링은 v1이 더 자연스럽다"): 실스트리밍 델타를
  // 버퍼에 모아 24ms마다 백로그 비례(최소 3자)로 방출 — 버스트 청크가 일정한 타이핑으로
  // 보이면서도 백로그가 크면 가속해 절대 뒤처지지 않는다. 종결 시 flushSmoothed()로 즉시 배출.
  const smoothBufRef = useRef('');
  const smoothTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  function appendSmoothed(delta: string) {
    smoothBufRef.current += delta;
    if (smoothTimerRef.current) return;
    smoothTimerRef.current = setInterval(() => {
      const buf = smoothBufRef.current;
      if (!buf) {
        if (smoothTimerRef.current) { clearInterval(smoothTimerRef.current); smoothTimerRef.current = null; }
        return;
      }
      const n = Math.max(3, Math.ceil(buf.length / 15));
      smoothBufRef.current = buf.slice(n);
      const chunk = buf.slice(0, n);
      patchLast((m) => ({ ...m, content: m.content + chunk, status: undefined }));
    }, 24);
  }
  function flushSmoothed() {
    if (smoothTimerRef.current) { clearInterval(smoothTimerRef.current); smoothTimerRef.current = null; }
    const rest = smoothBufRef.current;
    smoothBufRef.current = '';
    if (rest) patchLast((m) => ({ ...m, content: m.content + rest, status: undefined }));
  }

  function handleFrame(frame: string) {
    const parsed = parseFrame(frame);
    if (parsed.kind === 'meta') {
      if (parsed.threadId) setThread(parsed.threadId);
      if (parsed.gateway) {
        patchLast((m) => ({ ...m, gateway: parsed.gateway, ranked: parsed.ranked, method: parsed.method, via: parsed.via }));
      }
      // Answer-provenance footer: a second, later `meta` frame (no `gateway`) carries the
      // server-measured elapsed total + tools/model + token usage/cost, known only after resolve.
      if (parsed.tools || parsed.model || parsed.elapsedMs !== undefined || parsed.usage) {
        patchLast((m) => ({
          ...m,
          tools: parsed.tools ?? m.tools,
          model: parsed.model ?? m.model,
          elapsedMs: parsed.elapsedMs ?? m.elapsedMs,
          usage: parsed.usage ?? m.usage,
          costUsd: parsed.costUsd ?? m.costUsd,
        }));
      }
    } else if (parsed.kind === 'status') {
      // v1-parity: accumulate the generated query previews (SQL/PromQL/...) surfaced mid-run.
      patchLast((m) => ({
        ...m,
        status: { phase: parsed.phase ?? 'analyzing', elapsedMs: parsed.elapsedMs, tool: parsed.tool, query: parsed.query },
        queries: parsed.query && parsed.tool
          ? [...(m.queries ?? []), { tool: parsed.tool, query: parsed.query }]
          : m.queries,
      }));
    } else if (parsed.kind === 'delta') {
      appendSmoothed(parsed.delta!);
    } else if (parsed.kind === 'error') {
      flushSmoothed();
      patchLast((m) => ({ ...m, content: `⚠️ ${parsed.error!}`, status: undefined, streaming: false }));
    }
  }

  async function send(prompt: string, overrideSection?: string | null, switchedFrom?: string) {
    if (busy) return;
    const history = msgs.map((m) => ({ role: m.role, content: m.content }));
    setMsgs((m) => [...m, { role: 'user', content: prompt }, { role: 'assistant', content: '', streaming: true }]);
    setBusy(true);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      // v1-parity: carry the UI language (LanguageProvider persists 'awsops-lang') and the shell's
      // active account (existing account-context, key 'awsops:account') so the server forces the
      // response language and scopes multi-account queries. Both optional — server defaults apply.
      // getActiveAccount() returns 'self'/'__all__' for the host default (not a 12-digit id), which
      // the server's validateAccountId() rejects → host creds, exactly the pre-port behavior.
      let lang: string | undefined;
      let accountId: string | undefined;
      try {
        lang = localStorage.getItem('awsops-lang') || undefined;
        const a = getActiveAccount();
        accountId = a && a !== 'self' && a !== '__all__' ? a : undefined;
      } catch { /* SSR / no storage — server defaults apply */ }
      const res = await fetch('/api/chat', {
        method: 'POST', signal: ac.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt, messages: history, section: overrideSection ?? null, switchedFrom, sessionId: sessionRef.current, threadId: threadIdRef.current ?? undefined, lang, accountId }),
      });
      if (!res.ok || !res.body) {
        patchLast((m) => ({ ...m, content: res.status === 401 ? '세션이 만료되었습니다. 새로고침해 주세요.' : 'AI 응답을 받지 못했습니다.', streaming: false }));
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const frames = buf.split('\n\n');
        buf = frames.pop() ?? '';
        for (const f of frames) handleFrame(f);
      }
    } catch {
      patchLast((m) => ({ ...m, streaming: false, status: undefined }));
    } finally {
      flushSmoothed();
      patchLast((m) => ({ ...m, streaming: false, status: undefined }));
      setBusy(false);
      if (showThreadsRef.current) void refreshThreads(); // new title/order shows up immediately
    }
  }

  function resendWith(sectionKey: string) {
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
    const lastAssistant = [...msgs].reverse().find((m) => m.role === 'assistant');
    // Only a misroute candidate if the previous answer came from a LIVE agent —
    // switching away from an inactive-section guidance bubble is not a misroute (ADR-038 §5).
    const prevGateway = lastAssistant?.gateway;
    const switchedFrom = prevGateway && sectionByKey(prevGateway)?.active ? prevGateway : undefined;
    if (lastUser) void send(lastUser.content, sectionKey, switchedFrom);
  }

  function abort() { abortRef.current?.abort(); }

  // v1-parity follow-up: seed a fresh question (auto-routed, not a misroute resend).
  function followUp(q: string) { void send(q); }

  // v1-parity session stats bar: aggregate THIS session's assistant answers (client-side, no
  // server call) — query count, avg latency, success rate, per-gateway distribution.
  function sessionStats() {
    const answers = msgs.filter((m) => m.role === 'assistant' && !m.streaming && m.content);
    const count = answers.length;
    const timed = answers.filter((m) => m.elapsedMs !== undefined);
    const avgMs = timed.length ? Math.round(timed.reduce((s, m) => s + (m.elapsedMs ?? 0), 0) / timed.length) : null;
    const errors = answers.filter((m) => m.content.startsWith('⚠️')).length;
    const successRate = count ? (count - errors) / count : null;
    const byGateway: Record<string, number> = {};
    for (const m of answers) if (m.gateway) byGateway[m.gateway] = (byGateway[m.gateway] ?? 0) + 1;
    const topGateways = Object.entries(byGateway).sort((a, b) => b[1] - a[1]).slice(0, 4)
      .map(([gateway, n]) => ({ gateway, count: n }));
    return { count, avgMs, successRate, topGateways };
  }

  return {
    // state
    msgs, busy, threadId, threads, showThreads,
    // actions
    send, selectThread, newChat, refreshThreads, removeThread, removeAllThreads, toggleThreads, resendWith, followUp, abort,
    // derived
    sessionStats,
  };
}

export type SessionStats = ReturnType<UseChat['sessionStats']>;

export type UseChat = ReturnType<typeof useChat>;
