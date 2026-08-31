'use client';
import { useEffect, useState } from 'react';
import { useI18n } from '@/components/shell/LanguageProvider';

// Mailing list for diagnosis-completion email (v1 parity — manual + scheduled). Reads/writes
// /api/diagnosis/subscribers (SNS topic email subscriptions). Visible only when the feature is enabled
// (Terraform diagnosis_notify_enabled → topic ARN present). Add/remove controls are admin-only (canManage);
// non-admins see the read-only list. A new address is "확인 대기" until the recipient confirms the SNS email.
interface Subscriber {
  email: string;
  status: 'Confirmed' | 'PendingConfirmation';
  subscriptionArn: string | null;
}

export default function SubscribersPanel() {
  const { tt } = useI18n();
  const [enabled, setEnabled] = useState<boolean | null>(null); // null = still loading
  const [canManage, setCanManage] = useState(false);
  const [subs, setSubs] = useState<Subscriber[]>([]);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function load() {
    const r = await fetch('/api/diagnosis/subscribers');
    if (!r.ok) {
      setEnabled(false);
      return;
    }
    const d = await r.json();
    setEnabled(!!d.enabled);
    setCanManage(!!d.canManage);
    setSubs(Array.isArray(d.subscribers) ? d.subscribers : []);
  }

  useEffect(() => {
    load();
  }, []);

  async function add() {
    const e = email.trim().toLowerCase();
    if (!e) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch('/api/diagnosis/subscribers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: e }),
      });
      if (r.ok) {
        setEmail('');
        setMsg(tt('확인 메일을 보냈습니다. 수신자가 메일의 링크를 눌러야 구독이 활성화됩니다.'));
        await load();
      } else {
        const j = await r.json().catch(() => ({}));
        setMsg(j?.message === 'invalid email' ? tt('이메일 형식이 올바르지 않습니다.') : tt('구독 추가에 실패했습니다.'));
      }
    } finally {
      setBusy(false);
    }
  }

  async function remove(subscriptionArn: string) {
    if (!window.confirm(tt('이 구독자를 메일링 리스트에서 제거할까요?'))) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch('/api/diagnosis/subscribers', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subscriptionArn }),
      });
      if (r.ok) await load();
      else setMsg(tt('구독 제거에 실패했습니다.'));
    } finally {
      setBusy(false);
    }
  }

  // Feature off (no SNS topic) or still loading → render nothing.
  if (enabled !== true) return null;

  return (
    <fieldset className="rounded-md border border-ink-200 px-2 py-1.5 text-[13px]">
      <legend className="px-1 text-ink-400">{tt(`진단 결과 메일링 (${subs.length})`)}</legend>
      {subs.length === 0 ? (
        <p className="text-[12px] text-ink-400">{tt('구독자가 없습니다. 진단 완료 시 등록된 메일로 요약이 발송됩니다.')}</p>
      ) : (
        <ul className="space-y-1">
          {subs.map((s) => (
            <li key={s.email} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate">{s.email}</span>
              {s.status === 'Confirmed' ? (
                <span className="rounded-sm bg-green-50 px-1 text-[10px] text-green-700">{tt('구독중')}</span>
              ) : (
                <span className="rounded-sm bg-amber-50 px-1 text-[10px] text-amber-700">{tt('확인 대기')}</span>
              )}
              {canManage && s.subscriptionArn && (
                <button
                  onClick={() => remove(s.subscriptionArn!)}
                  disabled={busy}
                  aria-label={`${s.email} ${tt('제거')}`}
                  className="text-[11px] text-ink-400 hover:text-red-600 disabled:opacity-50"
                >
                  {tt('제거')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canManage && (
        <div className="mt-1.5 flex items-center gap-2">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') add();
            }}
            placeholder="email@example.com"
            aria-label={tt('구독 이메일 추가')}
            className="min-w-0 flex-1 rounded-md border border-ink-200 bg-card px-2 py-1 text-[13px] text-ink-800"
          />
          <button
            onClick={add}
            disabled={busy || !email.trim()}
            className="rounded-md bg-brand-500 px-2.5 py-1 text-[13px] font-medium text-white disabled:opacity-50"
          >
            {tt('추가')}
          </button>
        </div>
      )}
      {subs.some((s) => s.status === 'PendingConfirmation') && (
        // A pending subscription has no real ARN yet, so it cannot be unsubscribed via the SNS API (and
        // thus has no 제거 button). Tell admins it is self-clearing so it is not read as a stuck dead-end.
        <p className="mt-1 text-[11px] text-warning-text">
          {tt('확인 대기 항목은 수신자가 확인 메일의 링크를 눌러야 활성화됩니다. 미확인 시 약 3일 후 자동 만료됩니다.')}
        </p>
      )}
      {!canManage && <p className="mt-1 text-[11px] text-ink-400">{tt('구독자 추가/제거는 관리자만 가능합니다.')}</p>}
      {msg && <p className="mt-1 text-[11px] text-ink-500">{msg}</p>}
    </fieldset>
  );
}
