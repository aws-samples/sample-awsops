'use client';
import { useState } from 'react';
import { Plus, Trash2, Search } from 'lucide-react';
import type { ThreadSummary } from '@/lib/chat-store';

// Claude-app-style left sidebar: "+ new chat" on top, a v1-parity history SEARCH box, thread list
// below, active thread highlighted, switching is a single click and keeps the panel open.
export default function ThreadList({ threads, activeId, onSelect, onDelete, onDeleteAll, onNew, onSearch }: {
  threads: (ThreadSummary & { snippet?: string })[]; activeId: string | null;
  onSelect: (id: string) => void; onDelete: (id: string) => void;
  onDeleteAll?: () => void; onNew: () => void;
  onSearch?: (q: string) => void;
}) {
  const [q, setQ] = useState('');
  const [confirmAll, setConfirmAll] = useState(false);
  return (
    <div className="flex h-full w-full flex-col bg-paper-muted/60">
      <div className="p-2">
        <button
          onClick={onNew}
          aria-label="새 대화"
          className="flex w-full items-center gap-1.5 rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-left text-[13px] font-medium text-brand-700 transition-colors hover:bg-brand-100"
        >
          <Plus size={15} /> 새 대화
        </button>
      </div>
      {onSearch && (
        <div className="px-2 pb-1.5">
          <div className="flex items-center gap-1.5 rounded-md border border-ink-100 bg-card px-2 py-1.5">
            <Search size={13} className="shrink-0 text-ink-400" />
            <input
              value={q}
              onChange={(e) => { setQ(e.target.value); onSearch(e.target.value); }}
              placeholder="대화 내용 검색"
              aria-label="대화 내용 검색"
              className="min-w-0 flex-1 bg-transparent text-[12px] text-ink-800 placeholder:text-ink-400 focus:outline-none"
            />
          </div>
        </div>
      )}
      {onDeleteAll && threads.length > 0 && (
        <div className="px-2 pb-1.5">
          <button
            onClick={() => {
              if (!confirmAll) { setConfirmAll(true); setTimeout(() => setConfirmAll(false), 4000); return; }
              setConfirmAll(false);
              onDeleteAll();
            }}
            aria-label="대화 전체 삭제"
            className={
              'flex w-full items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-[11.5px] transition-colors ' +
              (confirmAll
                ? 'border-rose-300 bg-rose-500/10 font-semibold text-rose-700'
                : 'border-ink-100 text-ink-400 hover:bg-rose-50 hover:text-rose-600')
            }
          >
            <Trash2 size={13} /> {confirmAll ? '다시 누르면 전체 삭제됩니다' : '대화 전체 삭제'}
          </button>
        </div>
      )}
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {threads.length === 0 && (
          <div className="px-1.5 py-2 text-[12px] text-ink-400">{q.trim() ? '검색 결과가 없습니다.' : '저장된 대화가 없습니다.'}</div>
        )}
        {threads.map((t) => {
          const active = t.id === activeId;
          return (
            <div
              key={t.id}
              onClick={() => onSelect(t.id)}
              className={
                'group mb-0.5 flex cursor-pointer items-center justify-between gap-1.5 rounded-md px-2 py-2 transition-colors ' +
                (active ? 'bg-card shadow-sm' : 'hover:bg-ink-100/70')
              }
            >
              <div className="min-w-0">
                <div className={'truncate text-[12.5px] ' + (active ? 'font-medium text-ink-800' : 'text-ink-600')}>{t.title}</div>
                {t.snippet
                  ? <div className="truncate text-[10px] text-ink-400">…{t.snippet}…</div>
                  : <div className="text-[10px] text-ink-400">{new Date(t.updatedAt).toLocaleString()}</div>}
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); onDelete(t.id); }}
                aria-label={`${t.title} 삭제`}
                className="shrink-0 rounded p-1 text-ink-300 opacity-60 transition-colors hover:bg-rose-50 hover:text-rose-500 group-hover:opacity-100"
              >
                <Trash2 size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
