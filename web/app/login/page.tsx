'use client';
import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import AwsopsMark from '@/components/ui/AwsopsMark';
import LanguageToggle from '@/components/shell/LanguageToggle';
import { useI18n } from '@/components/shell/LanguageProvider';
import { safeNext } from '@/lib/login';

type ErrCode = 'invalid_credentials' | 'challenge' | 'unavailable';

/**
 * /login — in-app sign-in form (AgentCore teal theme, token-based so it follows the
 * active theme). Posts to the BFF (POST /api/auth/login), which sets the awsops_token
 * cookie; on success we replace() to the sanitized `next` so back doesn't return here.
 *
 * useSearchParams must sit behind a Suspense boundary (Next 14 requirement).
 */
function LoginForm() {
  const { t } = useI18n();
  const params = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrCode | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const next = safeNext(params.get('next') ?? '/');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, remember, next }),
      });
      if (res.ok) {
        window.location.replace(next);
        return; // keep the button busy through the navigation
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      const code = body.error;
      setError(
        code === 'invalid_credentials' || code === 'challenge' ? code : 'unavailable',
      );
    } catch {
      setError('unavailable');
    }
    setBusy(false);
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-paper px-4">
      <div className="absolute right-4 top-4 z-10 rounded-md bg-chrome-muted p-1">
        <LanguageToggle />
      </div>
      {/* teal · cobalt radial glows */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(circle at 16% 12%, rgba(1,168,141,.12), transparent 42%), radial-gradient(circle at 84% 88%, rgba(82,141,248,.10), transparent 42%)',
        }}
      />
      <div className="relative w-full max-w-[400px]">
        {/* brand lockup */}
        <div className="mb-3.5 flex flex-col items-center gap-3.5">
          <AwsopsMark size={52} />
          <div className="flex flex-col items-center gap-1">
            <span className="text-xl font-semibold text-ink-800">AWSops</span>
            <span className="text-sm text-ink-400">{t('login.subtitle')}</span>
          </div>
        </div>

        {/* card */}
        <form
          onSubmit={onSubmit}
          className="flex flex-col gap-4 rounded-xl border border-ink-100 bg-card p-7 shadow-card"
        >
          <div className="flex items-center justify-between">
            <h1 className="text-lg font-semibold text-ink-800">{t('login.title')}</h1>
            <span className="flex items-center gap-1.5 text-[11px] text-ink-400">
              <span className="h-1.5 w-1.5 rounded-full bg-positive" />
              {t('login.secure')}
            </span>
          </div>

          {error && (
            <div
              role="alert"
              className="rounded-md border border-negative-border bg-negative-surface px-3 py-2 text-[13px] text-negative-text"
            >
              {t(`login.error.${error}`)}
            </div>
          )}

          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-ink-400">{t('login.email')}</span>
            <input
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="h-[42px] rounded-md border border-ink-200 bg-card px-3 text-sm text-ink-800 outline-none transition-colors focus:border-brand focus:shadow-focus"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-ink-400">{t('login.password')}</span>
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="h-[42px] rounded-md border border-ink-200 bg-card px-3 text-sm text-ink-800 outline-none transition-colors focus:border-brand focus:shadow-focus"
            />
          </label>

          <label className="flex items-center gap-2 text-[13px] text-ink-600">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="h-4 w-4 accent-brand"
            />
            {t('login.remember')}
          </label>

          <button
            type="submit"
            disabled={busy}
            className="h-[42px] w-full rounded-md bg-brand-action text-sm font-semibold text-white transition-colors hover:bg-brand-action-hover disabled:opacity-70"
          >
            {busy ? t('login.busy') : t('login.submit')}
          </button>
        </form>

        <p className="mt-4 text-center text-[10px] text-ink-400">
          ap-northeast-2 · CloudFront → Lambda@Edge · RS256 JWT
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
