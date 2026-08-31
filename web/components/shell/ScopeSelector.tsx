'use client';
import { useEffect, useMemo, useState } from 'react';
import { Globe2 } from 'lucide-react';
import { ALL_ACCOUNTS, ALL_REGIONS, type ScopeSelection, useActiveScope } from '@/lib/account-context';
import { useI18n } from '@/components/shell/LanguageProvider';
import { cn } from '@/lib/cn';

interface AccountRow { accountId: string; alias: string; isHost: boolean }
interface RegionRow { accountId: string; region: string; enabled: boolean }

const accountValue = (a: AccountRow) => (a.isHost ? 'self' : a.accountId);

function uniq(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function toggleValue(values: string[], value: string): string[] {
  return values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
}

type T = (key: string, params?: Record<string, string | number>) => string;

function accountLabel(scope: ScopeSelection, accounts: AccountRow[], t: T): string {
  if (scope.accounts === ALL_ACCOUNTS) return t('scope.allAccounts');
  if (scope.accounts.length > 1) return t('scope.accountCount', { n: scope.accounts.length });
  const active = scope.accounts[0] || 'self';
  const row = accounts.find((a) => accountValue(a) === active);
  return row ? `${row.alias}${row.isHost ? ` (${t('scope.host')})` : ''}` : active;
}

function regionLabel(scope: ScopeSelection, t: T): string {
  if (scope.regions === ALL_REGIONS) return t('scope.allEnabledRegions');
  if (scope.regions.length > 1) return t('scope.regionCount', { n: scope.regions.length });
  return scope.regions[0] || t('scope.noRegions');
}

export default function ScopeSelector({ className = '' }: { className?: string }) {
  const { t } = useI18n();
  const [scope, setScope] = useActiveScope();
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [regions, setRegions] = useState<RegionRow[]>([]);

  useEffect(() => {
    let alive = true;
    Promise.all([
      fetch('/api/accounts').then((r) => (r.ok ? r.json() : { accounts: [] })).catch(() => ({ accounts: [] })),
      fetch('/api/accounts/regions').then((r) => (r.ok ? r.json() : { regions: [] })).catch(() => ({ regions: [] })),
    ]).then(([a, r]) => {
      if (!alive) return;
      setAccounts(Array.isArray(a.accounts) ? a.accounts : []);
      setRegions(Array.isArray(r.regions) ? r.regions : []);
    });
    return () => { alive = false; };
  }, []);

  const selectedAccounts = scope.accounts === ALL_ACCOUNTS ? accounts.map(accountValue) : scope.accounts;
  const hostAccountIds = useMemo(() => accounts.filter((a) => a.isHost).map((a) => a.accountId), [accounts]);
  const availableRegions = useMemo(() => {
    const accountSet = new Set(selectedAccounts);
    const includesHost = accountSet.has('self');
    return uniq(regions.filter((r) => (
      r.enabled && (accountSet.has(r.accountId) || (includesHost && hostAccountIds.includes(r.accountId)))
    )).map((r) => r.region));
  }, [regions, selectedAccounts, hostAccountIds]);

  const regionValues = scope.regions === ALL_REGIONS ? [] : scope.regions;
  const setAccountsValue = (accountsValue: ScopeSelection['accounts']) => setScope({ ...scope, accounts: accountsValue });
  const setRegionsValue = (regionsValue: ScopeSelection['regions']) => setScope({ ...scope, regions: regionsValue });

  if (accounts.length === 0) return null;

  return (
    <div className={cn('space-y-1 text-[11px] text-chrome-fg', className)}>
      <details className="rounded-md border border-chrome-border">
        <summary className="cursor-pointer list-none px-2 py-1.5 font-medium">
          {t('scope.accounts')}: <span className="text-chrome-fg-muted">{accountLabel(scope, accounts, t)}</span>
        </summary>
        <div className="space-y-1 border-t border-chrome-border p-2">
          {accounts.length > 1 && (
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={scope.accounts === ALL_ACCOUNTS}
                onChange={(e) => setAccountsValue(e.target.checked ? ALL_ACCOUNTS : ['self'])}
              />
              <span>{t('scope.allAccounts')}</span>
            </label>
          )}
          {accounts.map((a) => {
            const value = accountValue(a);
            const checked = scope.accounts === ALL_ACCOUNTS || selectedAccounts.includes(value);
            return (
              <label key={a.accountId} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={scope.accounts === ALL_ACCOUNTS}
                  onChange={() => {
                    const next = toggleValue(selectedAccounts, value);
                    setAccountsValue(next.length ? next : ['self']);
                  }}
                />
                <span>{a.alias}{a.isHost ? ` (${t('scope.host')})` : ''}</span>
              </label>
            );
          })}
        </div>
      </details>

      <details className="rounded-md border border-chrome-border">
        <summary className="cursor-pointer list-none px-2 py-1.5 font-medium">
          {t('scope.regions')}: <span className="text-chrome-fg-muted">{regionLabel(scope, t)}</span>
        </summary>
        <div className="space-y-1 border-t border-chrome-border p-2">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={scope.regions === ALL_REGIONS}
              onChange={(e) => setRegionsValue(e.target.checked ? ALL_REGIONS : availableRegions.slice(0, 1))}
            />
            <span>{t('scope.allEnabledRegions')}</span>
          </label>
          {availableRegions.map((region) => {
            const checked = scope.regions === ALL_REGIONS || regionValues.includes(region);
            return (
              <label key={region} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => {
                    // Every box renders checked=true while scope.regions === ALL_REGIONS, so a
                    // click there is always an uncheck gesture — exclude just this region from
                    // the full set (not narrow down to only it, which was the bug: it silently
                    // dropped every other region the user hadn't touched).
                    const next = scope.regions === ALL_REGIONS
                      ? availableRegions.filter((r) => r !== region)
                      : toggleValue(regionValues, region);
                    setRegionsValue(next.length ? next : availableRegions.slice(0, 1));
                  }}
                />
                <span>{region}</span>
              </label>
            );
          })}
        </div>
      </details>

      <label className="flex items-center gap-2 rounded-md border border-chrome-border px-2 py-1.5">
        <input
          type="checkbox"
          checked={scope.includeGlobal}
          onChange={(e) => setScope({ ...scope, includeGlobal: e.target.checked })}
        />
        <Globe2 size={13} strokeWidth={1.8} className="text-chrome-fg-muted" />
        <span>{t('scope.includeGlobal')}</span>
      </label>
    </div>
  );
}
