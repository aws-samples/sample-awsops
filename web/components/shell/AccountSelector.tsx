'use client';
import { useEffect, useState } from 'react';
import { useActiveAccount, ALL_ACCOUNTS } from '@/lib/account-context';

// Global account selector. Renders only when more than one account is registered (single-account
// deployments are unchanged). Host option carries value 'self' so it uses the task role's own creds.
interface Acct { accountId: string; alias: string; isHost: boolean }

export default function AccountSelector({ className = '' }: { className?: string }) {
  const [accounts, setAccounts] = useState<Acct[]>([]);
  const [active, setActive] = useActiveAccount();

  useEffect(() => {
    fetch('/api/accounts')
      .then((r) => (r.ok ? r.json() : { accounts: [] }))
      .then((d) => setAccounts(Array.isArray(d.accounts) ? d.accounts : []))
      .catch(() => setAccounts([]));
  }, []);

  if (accounts.length <= 1) return null;

  return (
    <select
      aria-label="Active account"
      value={active}
      onChange={(e) => setActive(e.target.value)}
      className={`w-full rounded-md border border-chrome-border bg-transparent px-2 py-1 text-[11px] text-chrome-fg ${className}`}
    >
      {accounts.map((a) => (
        <option key={a.accountId} value={a.isHost ? 'self' : a.accountId}>
          {a.alias}{a.isHost ? ' (host)' : ''}
        </option>
      ))}
      <option value={ALL_ACCOUNTS}>All accounts</option>
    </select>
  );
}
