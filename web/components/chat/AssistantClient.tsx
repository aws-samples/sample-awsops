'use client';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { PanelLeft, PanelLeftClose, X } from 'lucide-react';
import PresetChips from './PresetChips';
import Composer from './Composer';
import MessageList from './MessageList';
import ThreadList from './ThreadList';
import SessionStatsBar from './SessionStatsBar';
import { sectionByKey } from '@/lib/sections';
import { useChat } from './useChat';
import { useI18n } from '@/components/shell/LanguageProvider';
import { useSidebarPanel } from '@/components/ui/useSidebarPanel';
import SidebarResizeHandle from '@/components/ui/SidebarResizeHandle';
import { useModalFocus } from '@/components/ui/useModalFocus';

/**
 * Full-page assistant (/assistant). Same useChat engine + the same Aurora-backed
 * threads as the drawer, so a conversation started in either surface is visible
 * in the other. A `?thread=<id>` query (set by the drawer's "open full screen"
 * button) restores that conversation on entry.
 */
export default function AssistantClient() {
  const { tt } = useI18n();
  const chat = useChat();
  const params = useSearchParams();
  const wantedThread = params.get('thread');
  // gap-audit L204: deep-link prefill (e.g. the Datasources tab's "AI로 진단" row action) —
  // fills the composer for review only; never auto-sends.
  // First URL-controlled composer seed: accept ONLY the shape this feature emits — a single-line
  // section-pinned prompt (`/<section> …`, ≤500 chars). Anything else is ignored, closing the
  // crafted-link freeform-prefill vector while keeping the diagnose deep links working.
  const rawQ = (params.get('q') ?? '').slice(0, 500);
  const prefill = /^\/[a-z][a-z-]* [^\r\n]+$/.test(rawQ) ? rawQ : null;
  const inited = useRef(false);
  // Mobile uses an overlay; desktop sizing/collapse preferences apply only at lg+.
  const [mobileThreads, setMobileThreads] = useState(false);
  const mobilePanel = useModalFocus<HTMLDivElement>(mobileThreads, () => setMobileThreads(false));
  const sidebar = useSidebarPanel('awsops_assistant_threads');

  useEffect(() => {
    if (inited.current) return;
    inited.current = true;
    chat.toggleThreads(); // Load the list and keep it fresh even when its desktop panel is collapsed.
    if (prefill) {
      // A ?q= deep link is a genuinely FRESH conversation: newChat() rotates the persisted
      // AgentCore session id (server-side memory) and clears the thread — and it wins over a
      // crafted ?thread= in the same URL, which would otherwise seed an existing conversation.
      chat.newChat();
    } else {
      let tid = wantedThread;
      if (tid === null) {
        try { tid = localStorage.getItem('awsops_chat_thread'); } catch {}
      }
      if (tid) void chat.selectThread(tid);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeSec = chat.threadId && chat.msgs.length
    ? sectionByKey(chat.msgs.filter((m) => m.gateway).slice(-1)[0]?.gateway ?? '')
    : null;
  const title = chat.threads.find((t) => t.id === chat.threadId)?.title ?? tt('새 대화');

  return (
    <div className="flex h-full min-w-0">
      {/* The conversation stays mounted when the desktop thread panel is collapsed. */}
        <div id="assistant-desktop-threads" hidden={sidebar.collapsed}
          className={`relative hidden shrink-0 border-r border-ink-100 ${sidebar.collapsed ? '' : 'lg:block'}`} style={{ width: sidebar.width }}>
          <ThreadList threads={chat.threads} activeId={chat.threadId} onSelect={chat.selectThread} onDelete={chat.removeThread} onDeleteAll={chat.removeAllThreads} onNew={chat.newChat} onSearch={(q) => void chat.refreshThreads(q)} />
          <SidebarResizeHandle panel={sidebar} controls="assistant-desktop-threads"
            label={tt('대화 목록 너비 조절')} hint={tt('드래그하거나 방향키로 너비 조절')} />
        </div>

      {/* thread rail — mobile slide-in overlay (<lg), toggled from the header. */}
      {mobileThreads && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-ink-900/30" onClick={() => setMobileThreads(false)} aria-hidden />
          <div ref={mobilePanel} role="dialog" aria-modal="true" aria-label={tt('대화 목록')} tabIndex={-1}
            className="absolute inset-y-0 left-0 flex w-72 max-w-[80vw] flex-col border-r border-ink-100 bg-paper shadow-pop">
            <div className="flex items-center justify-between border-b border-ink-100 px-3 py-2.5">
              <span className="text-[13px] font-semibold text-ink-800">{tt('대화 목록')}</span>
              <button
                onClick={() => setMobileThreads(false)}
                aria-label={tt('대화 목록 닫기')}
                className="flex h-7 w-7 items-center justify-center rounded-md text-ink-400 transition-colors hover:bg-ink-100 hover:text-ink-800"
              >
                <X size={16} />
              </button>
            </div>
            <div className="min-h-0 flex-1">
              <ThreadList
                threads={chat.threads}
                activeId={chat.threadId}
                onSelect={(id) => { void chat.selectThread(id); setMobileThreads(false); }}
                onDelete={chat.removeThread} onDeleteAll={chat.removeAllThreads}
                onNew={() => { chat.newChat(); setMobileThreads(false); }}
                onSearch={(q) => void chat.refreshThreads(q)}
              />
            </div>
          </div>
        </div>
      )}

      {/* conversation */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-2 border-b border-ink-100 px-4 py-3.5 lg:px-6">
          <div className="flex min-w-0 items-center gap-2 text-[15px] font-semibold text-ink-800">
            <button
              onClick={sidebar.toggle}
              aria-label={tt(sidebar.collapsed ? '대화 목록 열기' : '대화 목록 닫기')}
              aria-expanded={!sidebar.collapsed}
              aria-controls="assistant-desktop-threads"
              title={tt(sidebar.collapsed ? '대화 목록 열기' : '대화 목록 닫기')}
              className="hidden h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-500 transition-colors hover:bg-ink-100 hover:text-ink-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500 lg:flex"
            >
              {sidebar.collapsed ? <PanelLeft size={18} /> : <PanelLeftClose size={18} />}
            </button>
            <button
              onClick={() => setMobileThreads(true)}
              aria-label={tt('대화 목록 열기')}
              aria-expanded={mobileThreads}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-400 transition-colors hover:bg-ink-100 hover:text-ink-800 lg:hidden"
            >
              <PanelLeft size={17} />
            </button>
            <span aria-hidden className="shrink-0 text-[17px] leading-none">🤖</span>
            <span className="truncate">{title}</span>
          </div>
          {activeSec && (
            <span className="flex shrink-0 items-center gap-1 text-[12px] font-medium" style={{ color: activeSec.color }}>
              {activeSec.icon} {activeSec.label}
            </span>
          )}
        </header>

        <div className="flex min-h-0 flex-1 flex-col">
          <div className="mx-auto flex min-h-0 w-full max-w-7xl flex-1 flex-col">
            {chat.msgs.length === 0
              ? <PresetChips onPick={chat.send} />
              : <MessageList msgs={chat.msgs} onSwitch={chat.resendWith} onFollowUp={chat.followUp} />}
            <SessionStatsBar stats={chat.sessionStats()} />
            <Composer disabled={chat.busy} onSend={chat.send} seed={prefill ? { text: prefill, n: 1 } : undefined} />
          </div>
        </div>
      </div>
    </div>
  );
}
