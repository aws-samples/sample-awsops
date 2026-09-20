'use client';
import { useState } from 'react';
import { RotateCw, CloudDownload } from 'lucide-react';
import { useI18n } from '@/components/shell/LanguageProvider';
import { localeOf } from '@/lib/i18n';
import Button from './Button';
import { cn } from '@/lib/cn';

/** Outcome of an on-demand sync dispatch (gap L79). The caller owns the fetch. */
export type ForceSyncOutcome = 'queued' | 'forbidden' | 'unconfigured' | 'error';

// Async-semantics disclosure: v2's collection is a batch sync, so a force refresh ENQUEUES
// a run — it does not synchronously requery live AWS (v1's ?bustCache did). The note says so.
const SYNC_NOTES: Record<ForceSyncOutcome, string> = {
  queued: '동기화가 큐에 등록되었습니다 — 완료 보장은 아니며(실행 중인 타입은 건너뜀), 반영까지 수 분 걸릴 수 있습니다.',
  forbidden: '전체 동기화는 관리자 전용입니다.',
  unconfigured: '인벤토리 sync가 비활성화되어 있습니다.',
  error: '동기화 요청에 실패했습니다.',
};

export default function RefreshButton({
  busy,
  onClick,
  capturedAt,
  onForceSync,
}: {
  busy: boolean;
  onClick: () => void;
  capturedAt?: string | null;
  /** Optional on-demand sync dispatcher (admin-gated server-side). Absent → unchanged render. */
  onForceSync?: () => Promise<ForceSyncOutcome>;
}) {
  const { tt, lang } = useI18n();
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncNote, setSyncNote] = useState<ForceSyncOutcome | null>(null);
  const age = capturedAt ? `${tt('업데이트')}: ${new Date(capturedAt).toLocaleString(localeOf(lang))}` : tt('미수집');
  const stale = capturedAt ? Date.now() - new Date(capturedAt).getTime() > 30 * 60 * 1000 : false;
  const forceSync = async () => {
    if (!onForceSync) return;
    setSyncBusy(true);
    setSyncNote(null);
    try {
      setSyncNote(await onForceSync());
    } catch {
      setSyncNote('error');
    }
    setSyncBusy(false);
  };
  return (
    <div className="flex items-center gap-2.5">
      {onForceSync && (
        <Button variant="secondary" size="sm" onClick={forceSync} disabled={syncBusy || syncNote === 'forbidden' || syncNote === 'unconfigured'}>
          <CloudDownload className={cn('h-3.5 w-3.5', syncBusy && 'animate-pulse')} />
          {syncBusy ? tt('요청 중…') : tt('전체 동기화')}
        </Button>
      )}
      <Button variant="secondary" size="sm" onClick={() => { setSyncNote((n) => (n === 'queued' || n === 'error' ? null : n)); onClick(); }} disabled={busy}>
        <RotateCw className={cn('h-3.5 w-3.5', busy && 'animate-spin')} />
        {busy ? tt('수집 중…') : 'Refresh'}
      </Button>
      <span className={cn('text-[11px]', stale ? 'text-brand-700' : 'text-ink-400')}>
        {syncNote ? <>{tt(SYNC_NOTES[syncNote])} · </> : null}
        {age}
        {stale ? ` ${tt('(오래됨)')}` : ''}
      </span>
    </div>
  );
}
