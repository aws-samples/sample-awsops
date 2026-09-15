// Registered-accounts registry (Aurora). Read by the BFF; written only via the admin
// /api/accounts route. The host row is seeded from HOST_ACCOUNT_ID (no AssumeRole for host).
import { getPool } from '@/lib/db';
import { currentAccountId } from '@/lib/account';
import type { PoolClient } from 'pg';

export interface Account {
  accountId: string;
  alias: string;
  region: string;
  isHost: boolean;
  roleName: string;
  externalId: string | null;
  enabled: boolean;
  status: string;
  lastVerifiedAt: string | null;
}

const ACCOUNT_ID_RE = /^\d{12}$/;
export function validateAccountId(id: string): boolean {
  return ACCOUNT_ID_RE.test(id);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function mapRow(r: any): Account {
  return {
    accountId: r.account_id,
    alias: r.alias,
    region: r.region,
    isHost: r.is_host,
    roleName: r.role_name,
    externalId: r.external_id ?? null,
    enabled: r.enabled,
    status: r.status,
    lastVerifiedAt: r.last_verified_at ?? null,
  };
}

export async function listAccounts(): Promise<Account[]> {
  const { rows } = await getPool().query(
    'SELECT * FROM accounts ORDER BY is_host DESC, alias ASC',
  );
  return rows.map(mapRow);
}

export async function getAccount(id: string, signal?: AbortSignal): Promise<Account | undefined> {
  const text = 'SELECT * FROM accounts WHERE account_id = $1';
  if (!signal) {
    const { rows } = await getPool().query(text, [id]);
    return rows[0] ? mapRow(rows[0]) : undefined;
  }
  if (signal.aborted) throw new Error('Account lookup cancelled');
  let client: PoolClient | undefined;
  let discard = false;
  let cancel!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    cancel = () => {
      discard = true;
      reject(new Error('Account lookup cancelled'));
    };
  });
  signal.addEventListener('abort', cancel, { once: true });
  const lookup = async () => {
    const acquired = await getPool().connect();
    // A checkout can settle after cancellation; never start abandoned SQL.
    if (signal.aborted) {
      acquired.release(false);
      throw new Error('Account lookup cancelled');
    }
    client = acquired;
    client.on('error', cancel);
    const { rows } = await client.query(text, [id]);
    return rows[0] ? mapRow(rows[0]) : undefined;
  };
  try {
    return await Promise.race([lookup(), cancelled]);
  } finally {
    signal.removeEventListener('abort', cancel);
    if (client) {
      // Discard a timed-out socket instead of stranding a shared-pool slot.
      try { client.release(discard); }
      finally { client.removeListener('error', cancel); }
    }
  }
}

export async function getHostAccount(): Promise<Account | undefined> {
  const { rows } = await getPool().query('SELECT * FROM accounts WHERE is_host LIMIT 1');
  return rows[0] ? mapRow(rows[0]) : undefined;
}

export async function isMultiAccount(): Promise<boolean> {
  const { rows } = await getPool().query('SELECT COUNT(*)::int AS n FROM accounts WHERE enabled');
  return Number(rows[0]?.n ?? 0) > 1;
}

/** Idempotently ensure the host row exists (seeded from HOST_ACCOUNT_ID). Never throws into callers. */
export async function ensureHostRow(): Promise<void> {
  const id = currentAccountId();
  if (!id || id === 'self') return;
  const region = process.env.AWS_REGION || 'ap-northeast-2';
  try {
    await getPool().query(
      `INSERT INTO accounts (account_id, alias, region, is_host, all_regions, status, last_verified_at)
       VALUES ($1, $2, $3, true, true, 'verified', now())
       ON CONFLICT (account_id) DO NOTHING`,
      [id, 'Host account', region],
    );
    await getPool().query(
      `INSERT INTO account_regions (account_id, region, enabled, updated_at)
       VALUES ($1, $2, true, now())
       ON CONFLICT (account_id, region) DO UPDATE SET enabled = true, updated_at = now()`,
      [id, region],
    );
  } catch {
    /* seeding is best-effort; the BFF degrades to single-account if the table is absent */
  }
}
