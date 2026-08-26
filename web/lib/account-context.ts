'use client';
// Client-side active-account context. Selection is per-tab (localStorage). BFF routes accept the
// active account as a `?account=<id>` query param (host/self → omitted → the task role's own creds).
import { useEffect, useState } from 'react';

const KEY = 'awsops:account';
const SCOPE_KEY = 'awsops:scope';
export const ALL_ACCOUNTS = '__all__';
export const ALL_REGIONS = '__all__';

export interface ScopeSelection {
  accounts: typeof ALL_ACCOUNTS | string[];
  regions: typeof ALL_REGIONS | string[];
  includeGlobal: boolean;
}

export const DEFAULT_SCOPE: ScopeSelection = {
  accounts: ['self'],
  regions: ALL_REGIONS,
  includeGlobal: true,
};

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && x.length > 0);
}

function normalizeScope(v: unknown): ScopeSelection {
  if (!v || typeof v !== 'object') return DEFAULT_SCOPE;
  const raw = v as Partial<ScopeSelection>;
  const accounts = raw.accounts === ALL_ACCOUNTS || isStringArray(raw.accounts) ? raw.accounts : DEFAULT_SCOPE.accounts;
  const regions = raw.regions === ALL_REGIONS || isStringArray(raw.regions) ? raw.regions : DEFAULT_SCOPE.regions;
  const includeGlobal = typeof raw.includeGlobal === 'boolean' ? raw.includeGlobal : DEFAULT_SCOPE.includeGlobal;
  return { accounts, regions, includeGlobal };
}

export function getActiveAccount(): string {
  if (typeof window === 'undefined') return 'self';
  try {
    const scope = getActiveScope();
    if (scope.accounts === ALL_ACCOUNTS) return ALL_ACCOUNTS;
    return scope.accounts[0] || window.localStorage.getItem(KEY) || 'self';
  } catch {
    return 'self';
  }
}

export function setActiveAccount(id: string): void {
  if (typeof window === 'undefined') return;
  const accounts = id === ALL_ACCOUNTS ? ALL_ACCOUNTS : [id || 'self'];
  setActiveScope({ ...getActiveScope(), accounts });
  try {
    window.localStorage.setItem(KEY, id);
  } catch {
    /* ignore quota/availability */
  }
  window.dispatchEvent(new CustomEvent('awsops:accountchange', { detail: { id } }));
}

/** Query-param fragment for the active account. '' for host/self (default creds); else `account=<id>`. */
export function accountParam(id: string): string {
  return !id || id === 'self' ? '' : `account=${encodeURIComponent(id)}`;
}

export function getActiveScope(): ScopeSelection {
  if (typeof window === 'undefined') return DEFAULT_SCOPE;
  try {
    const raw = window.localStorage.getItem(SCOPE_KEY);
    if (raw) return normalizeScope(JSON.parse(raw));
    const account = window.localStorage.getItem(KEY);
    if (account) return normalizeScope({ ...DEFAULT_SCOPE, accounts: account === ALL_ACCOUNTS ? ALL_ACCOUNTS : [account] });
  } catch {
    return DEFAULT_SCOPE;
  }
  return DEFAULT_SCOPE;
}

export function setActiveScope(scope: ScopeSelection): void {
  if (typeof window === 'undefined') return;
  const normalized = normalizeScope(scope);
  try {
    window.localStorage.setItem(SCOPE_KEY, JSON.stringify(normalized));
    const firstAccount = normalized.accounts === ALL_ACCOUNTS ? ALL_ACCOUNTS : normalized.accounts[0] || 'self';
    window.localStorage.setItem(KEY, firstAccount);
  } catch {
    /* ignore quota/availability */
  }
  window.dispatchEvent(new CustomEvent('awsops:scopechange', { detail: { scope: normalized } }));
}

export function scopeParams(scope: ScopeSelection): string {
  const normalized = normalizeScope(scope);
  const params = new URLSearchParams();
  if (normalized.accounts === ALL_ACCOUNTS) {
    params.set('accounts', ALL_ACCOUNTS);
  } else if (!(normalized.accounts.length === 1 && normalized.accounts[0] === 'self')) {
    params.set('accounts', normalized.accounts.join(','));
  }
  params.set('regions', normalized.regions === ALL_REGIONS ? ALL_REGIONS : normalized.regions.join(','));
  params.set('includeGlobal', normalized.includeGlobal ? '1' : '0');
  return params.toString();
}

/** React hook: current active account + setter (persists + broadcasts to other components). */
export function useActiveAccount(): [string, (id: string) => void] {
  const [id, setId] = useState('self');
  useEffect(() => {
    setId(getActiveAccount());
    const handler = () => setId(getActiveAccount());
    window.addEventListener('awsops:accountchange', handler);
    return () => window.removeEventListener('awsops:accountchange', handler);
  }, []);
  return [id, (v: string) => { setActiveAccount(v); setId(v); }];
}

export function useActiveScope(): [ScopeSelection, (scope: ScopeSelection) => void] {
  const [scope, setScope] = useState<ScopeSelection>(DEFAULT_SCOPE);
  useEffect(() => {
    setScope(getActiveScope());
    const handler = () => setScope(getActiveScope());
    window.addEventListener('awsops:scopechange', handler);
    return () => window.removeEventListener('awsops:scopechange', handler);
  }, []);
  return [scope, (v: ScopeSelection) => { setActiveScope(v); setScope(normalizeScope(v)); }];
}
