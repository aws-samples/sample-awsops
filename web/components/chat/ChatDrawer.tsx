'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { Menu, Plus, X, Maximize2, Minimize2, ExternalLink } from 'lucide-react';
import PresetChips from './PresetChips';
import Composer from './Composer';
import MessageList from './MessageList';
import ThreadList from './ThreadList';
import { useChat } from './useChat';
import { useI18n } from '@/components/shell/LanguageProvider';

const THREADS_W = 240;
const DEFAULT_W = 420;
const MIN_W = 360;

// The detail panel (if open) docks to the chat's right via --detail-panel-w, so the
// drawer's usable span is the viewport minus that width — resize/clamp must subtract it.
function detailPanelW(): number {
  if (typeof window === 'undefined') return 0;
  const n = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--detail-panel-w'));
  return Number.isFinite(n) ? n : 0;
}

export default function ChatDrawer() {
  const { tt } = useI18n();
  const chat = useChat();
  const router = useRouter();
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const [seed, setSeed] = useState<{ text: string; n: number } | undefined>();
  const [maximized, setMaximized] = useState(false);
  const [width, setWidth] = useState(DEFAULT_W);
  // Below lg (1024px) the drawer is fullscreen: the inline width + resize handle are
  // suppressed. Default false so SSR + first client paint match (no window) → mobile
  // fullscreen; the effect below syncs to the real viewport on mount.
  const [isDesktop, setIsDesktop] = useState(false);
  const widthRef = useRef(DEFAULT_W);
  widthRef.current = width;

  // Track the lg breakpoint to gate the desktop-only inline width / resize behavior.
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const sync = () => setIsDesktop(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  // Restore persisted width / maximized, and wire the cross-app "open chat" event.
  useEffect(() => {
    const w = Number(localStorage.getItem('awsops_chat_width'));
    if (w >= MIN_W) setWidth(Math.min(w, window.innerWidth - 60)); // clamp a width saved on a wider screen
    if (localStorage.getItem('awsops_chat_maximized') === '1') setMaximized(true);
    // On /assistant the drawer is inert (renders null) — skip the restore fetch so it
    // doesn't duplicate AssistantClient's selectThread or race on shared localStorage keys.
    if (path !== '/assistant') {
      const tid = localStorage.getItem('awsops_chat_thread');
      if (tid) void chat.selectThread(tid);
    }
    function onOpenChat(e: Event) {
      setOpen(true);
      const d = (e as CustomEvent).detail ?? {};
      const wanted = d.threadId as string | undefined;
      if (wanted) void chat.selectThread(wanted); // selectThread only touches refs/setters — closure-safe
      const prompt = d.prompt as string | undefined;
      if (prompt) {
        // a seeded question (e.g. topology "ask AI about this resource") = a fresh ask →
        // start a clean chat so the user isn't looking at the previously-loaded thread.
        if (!wanted) chat.newChat();
        setSeed({ text: prompt, n: Date.now() }); // fill the composer; user reviews + sends
      }
    }
    window.addEventListener('awsops:open-chat', onOpenChat);
    return () => window.removeEventListener('awsops:open-chat', onOpenChat);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggleMax() {
    setMaximized((m) => { const next = !m; try { localStorage.setItem('awsops_chat_maximized', next ? '1' : '0'); } catch {} return next; });
  }

  // Drag the left edge to resize; persist on release. Disengages maximize.
  function startResize(e: React.MouseEvent) {
    e.preventDefault();
    setMaximized(false);
    try { localStorage.setItem('awsops_chat_maximized', '0'); } catch {}
    const onMove = (ev: MouseEvent) => {
      const avail = window.innerWidth - detailPanelW(); // drawer's right edge sits left of the detail panel
      const w = Math.min(Math.max(avail - ev.clientX, MIN_W), Math.max(MIN_W, avail - 60));
      setWidth(w);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
      try { localStorage.setItem('awsops_chat_width', String(Math.round(widthRef.current))); } catch {}
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.style.userSelect = 'none';
  }

  function popOut() {
    chat.abort();
    setOpen(false);
    router.push('/assistant' + (chat.threadId ? `?thread=${chat.threadId}` : ''));
  }

  // The /assistant page is the full-screen surface — no floating drawer there.
  if (path === '/assistant') return null;

  if (!open) {
    return (
      // FAB launcher: on mobile it floats ABOVE the fixed BottomTabBar (bottom-20)
      // so it no longer collides with it; standard bottom-right on desktop (lg:bottom-5).
      // Opens the chat drawer (fullscreen below lg).
      <button
        onClick={() => setOpen(true)}
        aria-label={tt('AI 어시스턴트 열기')}
        // lg: shift left of any open right-docked DetailPanel (--detail-panel-w, 0 when none)
        // so the FAB never sits on top of the panel. Mobile keeps right-5 (panel is fullscreen there).
        className="fixed bottom-20 right-5 z-50 flex h-12 w-12 items-center justify-center rounded-full bg-brand-500 text-white shadow-pop transition-colors hover:bg-brand-600 lg:bottom-5 lg:right-[calc(1.25rem+var(--detail-panel-w,0px))]"
      >
        <span aria-hidden className="text-[22px] leading-none">🤖</span>
      </button>
    );
  }

  // Cap to the span left of the detail panel (--detail-panel-w, 0 when none) so the drawer
  // never overflows past the screen's left edge — but floored at MIN_W so a wide detail panel
  // can never collapse the chat below its minimum (the detail panel is itself resizable, so the
  // user yields space from that side rather than losing the chat).
  const totalWidth = maximized
    ? `max(${MIN_W}px, calc(96vw - var(--detail-panel-w, 0px)))`
    : `max(${MIN_W}px, min(${width + (chat.showThreads ? THREADS_W : 0)}px, calc(100vw - var(--detail-panel-w, 0px) - 56px)))`;

  return (
    <div
      // <lg: fullscreen overlay (inset-0, full width/height). lg+: docked to the right
      // edge with the persisted/maximized width applied as an inline style.
      // lg: dock immediately left of any open right-docked DetailPanel (--detail-panel-w,
      // 0 when none → flush right edge) so the two panels sit side-by-side instead of overlapping.
      className="fixed inset-0 z-50 flex flex-col border-ink-100 bg-paper shadow-pop pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] lg:inset-y-0 lg:left-auto lg:right-[var(--detail-panel-w,0px)] lg:h-screen lg:border-l lg:p-0"
      style={isDesktop ? { width: totalWidth } : undefined}
    >
      {/* resize grip — desktop only, and hidden while maximized */}
      {!maximized && (
        <div
          onMouseDown={startResize}
          title={tt('드래그하여 폭 조절')}
          aria-label={tt('패널 폭 조절')}
          role="separator"
          className="group absolute left-0 top-0 z-10 hidden h-full w-1.5 cursor-col-resize lg:block"
        >
          <div className="absolute left-0 top-0 h-full w-px bg-ink-100 transition-colors group-hover:w-0.5 group-hover:bg-brand-400" />
        </div>
      )}

      {/* header */}
      <div className="flex items-center justify-between border-b border-ink-100 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <IconBtn onClick={chat.toggleThreads} title={tt('대화 목록')} label={tt('대화 목록')} active={chat.showThreads}><Menu size={16} /></IconBtn>
          <span className="flex items-center gap-1.5 text-[13px] font-semibold text-ink-800">
            <span aria-hidden className="text-[15px] leading-none">🤖</span> AWSops Assistant
          </span>
        </div>
        <div className="flex items-center gap-0.5">
          <IconBtn onClick={popOut} title={tt('전체화면으로 열기')} label={tt('전체화면으로 열기')}><ExternalLink size={15} /></IconBtn>
          <IconBtn onClick={toggleMax} title={tt(maximized ? '복원' : '최대화')} label={tt(maximized ? '복원' : '최대화')}>
            {maximized ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </IconBtn>
          <IconBtn onClick={chat.newChat} title={tt('새 대화')} label={tt('새 대화')}><Plus size={16} /></IconBtn>
          <IconBtn onClick={() => { chat.abort(); setOpen(false); }} title={tt('닫기')} label={tt('닫기')}><X size={16} /></IconBtn>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {chat.showThreads && (
          <div className="shrink-0 border-r border-ink-100" style={{ width: THREADS_W }}>
            <ThreadList threads={chat.threads} activeId={chat.threadId} onSelect={chat.selectThread} onDelete={chat.removeThread} onDeleteAll={chat.removeAllThreads} onNew={chat.newChat} onSearch={(q) => void chat.refreshThreads(q)} />
          </div>
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col">
            {chat.msgs.length === 0
              ? <PresetChips onPick={chat.send} />
              : <MessageList msgs={chat.msgs} onSwitch={chat.resendWith} onFollowUp={chat.followUp} />}
            <Composer disabled={chat.busy} onSend={chat.send} seed={seed} />
          </div>
        </div>
      </div>
    </div>
  );
}

function IconBtn({ onClick, title, label, active, children }: {
  onClick: () => void; title: string; label: string; active?: boolean; children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={label}
      className={
        'flex h-7 w-7 items-center justify-center rounded-md transition-colors ' +
        (active ? 'bg-brand-50 text-brand-600' : 'text-ink-400 hover:bg-ink-100 hover:text-ink-800')
      }
    >
      {children}
    </button>
  );
}
