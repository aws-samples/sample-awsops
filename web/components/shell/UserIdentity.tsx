'use client';
import { useEffect, useState } from 'react';
import { LogOut } from 'lucide-react';
import { useI18n } from '@/components/shell/LanguageProvider';

interface Me {
  sub: string;
  email?: string;
  groups: string[];
}

// Footer identity block: fetches the real signed-in user from /api/me once (the awsops_token
// cookie is HttpOnly so the client can't read it directly), and wires the sign-out button to
// POST /api/auth/signout (cookie clear) → navigate to the returned redirect (/login). While
// loading or on 401 we keep the previous placeholder shape so the layout never jumps.
export default function UserIdentity() {
  const { t } = useI18n();
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    let live = true;
    fetch('/api/me')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (live && data && typeof data.sub === 'string') setMe(data as Me);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  async function signOut() {
    try {
      const res = await fetch('/api/auth/signout', { method: 'POST' });
      const { redirect } = await res.json();
      window.location.href = redirect ?? '/login';
    } catch {
      window.location.href = '/login';
    }
  }

  // Loading / 401: keep the previous placeholder shape (admin label + masked email).
  const avatarChar = (me?.email ?? t('sidebar.admin')).charAt(0).toUpperCase();
  const detail = me?.email ?? 'ad*****@awsops.io';

  return (
    <div className="flex items-center gap-2.5">
      <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full bg-ink-800 text-[13px] font-semibold text-paper">
        {avatarChar}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium leading-tight text-ink-800">{t('sidebar.admin')}</div>
        <div className="truncate font-mono text-[11px] text-ink-400">{detail}</div>
      </div>
      <button
        type="button"
        onClick={signOut}
        aria-label={t('sidebar.signOut')}
        className="rounded-md p-1 text-ink-400 transition-colors hover:bg-ink-100 hover:text-ink-800"
      >
        <LogOut size={16} strokeWidth={1.7} />
      </button>
    </div>
  );
}
