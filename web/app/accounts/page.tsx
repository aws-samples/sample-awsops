'use client';
import { useCallback, useEffect, useState } from 'react';
import PageHeader from '@/components/ui/PageHeader';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import { useI18n } from '@/components/shell/LanguageProvider';
import { localeOf } from '@/lib/i18n';
import AccountOnboarding from './AccountOnboarding';

// Admin-only multi-account registration. The /api/accounts route is the real admin gate
// (403 → denied here). Cross-account reads assume AWSopsReadOnlyRole in each target using its
// ExternalId (a confused-deputy guard, not a secret). See the onboarding guide below.

interface Account {
  accountId: string; alias: string; region: string; isHost: boolean;
  externalId: string | null; enabled: boolean; status: string; lastVerifiedAt: string | null;
}
interface AccountRegion { accountId: string; region: string; enabled: boolean }

const statusTone = (s: string): 'positive' | 'negative' | 'neutral' =>
  s === 'verified' ? 'positive' : s === 'error' ? 'negative' : 'neutral';

export default function AccountsPage() {
  const { tt, lang } = useI18n();
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [regions, setRegions] = useState<AccountRegion[]>([]);
  const [denied, setDenied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [regionForm, setRegionForm] = useState<Record<string, string>>({});
  const [testing, setTesting] = useState<string | null>(null); // v1-parity per-row connection re-test

  const load = useCallback(async () => {
    const [r, rr] = await Promise.all([fetch('/api/accounts'), fetch('/api/accounts/regions')]);
    if (r.status === 401 || r.status === 403) { setDenied(true); return; }
    if (!r.ok) throw new Error('Account lookup failed');
    const d = await r.json();
    if (!Array.isArray(d.accounts)) throw new Error('Invalid account response');
    setAccounts(d.accounts);
    const rd = rr.ok ? await rr.json().catch(() => ({ regions: [] })) : { regions: [] };
    setRegions(Array.isArray(rd.regions) ? rd.regions : []);
  }, []);

  useEffect(() => {
    void load().catch(() => setMsg('계정 목록을 불러오지 못했습니다. 페이지를 새로고침하세요.'));
  }, [load]);

  const reloadAfterAction = async () => {
    try {
      await load();
      return true;
    } catch {
      setMsg('계정 목록을 불러오지 못했습니다. 페이지를 새로고침하세요.');
      return false;
    }
  };

  const remove = async (id: string) => {
    if (!confirm(tt(`${id} 계정을 제거할까요?`))) return;
    setMsg('');
    try {
      const r = await fetch(`/api/accounts?accountId=${id}`, { method: 'DELETE' });
      if (!r.ok) { const d = await r.json().catch(() => ({})); setMsg(tt(`삭제 실패: ${d.message || r.status}`)); return; }
      await reloadAfterAction();
    } catch {
      setMsg('요청을 완료하지 못했습니다. 계정 목록과 네트워크를 확인한 뒤 다시 시도하세요.');
    }
  };

  // v1-parity connection test: re-assume the registered role and refresh status/lastVerifiedAt.
  const testConnection = async (accountId: string) => {
    setTesting(accountId); setMsg('');
    try {
      const r = await fetch('/api/accounts', {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accountId }),
      });
      const d = await r.json().catch(() => ({}));
      if (await reloadAfterAction()) {
        setMsg(tt(r.ok ? `${accountId} 연결 확인됨 (verified)` : `${accountId} 연결 실패: ${d.message || r.status}`));
      }
    } catch {
      setMsg('요청을 완료하지 못했습니다. 계정 목록과 네트워크를 확인한 뒤 다시 시도하세요.');
    } finally { setTesting(null); }
  };

  const addRegion = async (accountId: string) => {
    const region = (regionForm[accountId] || '').trim();
    if (!region) return;
    setBusy(true); setMsg('');
    try {
      const r = await fetch('/api/accounts/regions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accountId, region }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg(tt(`리전 추가 실패: ${d.message || r.status}`)); return; }
      setRegionForm((prev) => ({ ...prev, [accountId]: '' }));
      if (await reloadAfterAction()) setMsg(tt('리전 추가 완료'));
    } catch {
      setMsg('요청을 완료하지 못했습니다. 계정 목록과 네트워크를 확인한 뒤 다시 시도하세요.');
    } finally { setBusy(false); }
  };

  // account_regions is keyed by the concrete account id (the host included — its real 12-digit id,
  // not the 'self' alias), so match on it directly.
  const regionsFor = (accountId: string) =>
    regions.filter((r) => r.enabled && r.accountId === accountId).map((r) => r.region);

  if (denied) {
    return (
      <div className="p-6">
        <PageHeader title="계정 관리" subtitle="Multi-account registration" />
        <Card className="p-6 text-[13px] text-ink-500">{tt('관리자만 접근할 수 있습니다 (Cognito ADMIN_GROUP 또는 SSM allowlist).')}</Card>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 flex min-w-0 flex-col gap-4">
      <PageHeader title="계정 관리" subtitle="연결된 AWS 계정 (크로스계정 read-only via AWSopsReadOnlyRole)" />
      <AccountOnboarding onRegistered={load} accounts={accounts} />

      <Card className="p-4 min-w-0 overflow-x-auto">
        <div className="text-[13px] font-semibold text-ink-800 mb-3">{tt('등록된 계정')}</div>
        {accounts === null && <div className="text-[12px] text-ink-400">{tt('로딩 중…')}</div>}
        {accounts !== null && accounts.length === 0 && <div className="text-[12px] text-ink-400">{tt('등록된 계정이 없습니다.')}</div>}
        {accounts && accounts.length > 0 && (
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-ink-400">
                <th className="py-1">Alias</th><th>Account ID</th><th>Regions</th><th>{tt('상태')}</th><th></th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.accountId} className="border-t border-ink-100">
                  <td className="py-1.5">{a.alias}{a.isHost && <span className="ml-1 text-ink-400">(host)</span>}</td>
                  <td className="font-mono">{a.accountId}</td>
                  <td>
                    <div className="flex flex-wrap items-center gap-1">
                      {(regionsFor(a.accountId).length ? regionsFor(a.accountId) : [a.region]).map((region) => (
                        <span key={region} className="rounded border border-ink-100 px-1.5 py-0.5 font-mono text-[10px] text-ink-600">{region}</span>
                      ))}
                    </div>
                  </td>
                  <td title={tt(a.lastVerifiedAt ? `마지막 검증: ${new Date(a.lastVerifiedAt).toLocaleString(localeOf(lang))}` : '검증 이력 없음')}>
                    <Badge tone={statusTone(a.status)} variant="soft">{a.status}</Badge>
                  </td>
                  <td className="text-right">
                    <div className="flex justify-end gap-1">
                      <button
                        aria-label={tt(`${a.alias} 연결 테스트`)}
                        onClick={() => testConnection(a.accountId)}
                        disabled={testing !== null}
                        className="rounded border border-brand-200 bg-brand-50 px-2 py-1 text-[11px] text-brand-700 hover:bg-brand-100 disabled:opacity-50"
                      >
                        {tt(testing === a.accountId ? '테스트 중…' : '테스트')}
                      </button>
                      <input
                        aria-label={tt(`${a.alias} 추가 리전`)}
                        className="w-28 rounded border border-ink-200 bg-card px-1.5 py-1 text-[11px] text-ink-800"
                        placeholder="us-east-1"
                        value={regionForm[a.accountId] || ''}
                        onChange={(e) => setRegionForm({ ...regionForm, [a.accountId]: e.target.value.trim() })}
                      />
                      <button
                        aria-label={tt(`${a.alias} 리전 추가`)}
                        onClick={() => addRegion(a.accountId)}
                        disabled={busy}
                        className="rounded border border-ink-200 px-2 py-1 text-[11px] text-ink-600 hover:bg-ink-50 disabled:opacity-50"
                      >
                        {tt('리전 추가')}
                      </button>
                      {!a.isHost && (
                        <button onClick={() => remove(a.accountId)} className="text-[11px] text-negative-600 hover:underline">{tt('제거')}</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {msg && <p role="status" className="text-[12px] text-ink-500">{tt(msg)}</p>}
    </div>
  );
}
