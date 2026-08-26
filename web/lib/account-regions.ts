import { getPool } from '@/lib/db';

export interface AccountRegion {
  accountId: string;
  region: string;
  enabled: boolean;
}

const REGION_RE = /^[a-z]{2}-[a-z]+-\d+$/;

export function validateRegion(region: string): boolean {
  return REGION_RE.test(region);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function mapRow(r: any): AccountRegion {
  return {
    accountId: r.account_id,
    region: r.region,
    enabled: r.enabled,
  };
}

export async function listAccountRegions(accountId?: string): Promise<AccountRegion[]> {
  const args: string[] = [];
  let where = 'WHERE enabled = true';
  if (accountId) {
    args.push(accountId);
    where += ' AND account_id = $1';
  }
  const { rows } = await getPool().query(
    `SELECT account_id, region, enabled
       FROM account_regions
      ${where}
      ORDER BY account_id ASC, region ASC`,
    args,
  );
  return rows.map(mapRow);
}

export async function upsertAccountRegion(accountId: string, region: string): Promise<void> {
  await getPool().query(
    `INSERT INTO account_regions (account_id, region, enabled, updated_at)
     VALUES ($1, $2, true, now())
     ON CONFLICT (account_id, region) DO UPDATE SET enabled = true, updated_at = now()`,
    [accountId, region],
  );
}

export interface AccountScanScope {
  accountId: string;
  regions: string[]; // ["*"] = all regions (1st-class v1 parity); else explicit enabled regions
}

/**
 * Per-enabled-account scan scope for the inventory fan-out. `accounts.all_regions` → `["*"]`;
 * otherwise the account's explicit enabled `account_regions`. An account that is NOT all-regions
 * and has NO enabled regions is **skipped** (never expanded to `["*"]`). `all_regions` defaults to
 * false (M1) so existing explicit-region selections are preserved; it is an explicit opt-in.
 */
export async function listScanScope(): Promise<AccountScanScope[]> {
  const { rows } = await getPool().query(
    `SELECT a.account_id,
            a.all_regions,
            a.is_host,
            COALESCE(array_agg(r.region ORDER BY r.region) FILTER (WHERE r.enabled), '{}') AS regions
       FROM accounts a
       LEFT JOIN account_regions r ON r.account_id = a.account_id
      WHERE a.enabled = true
      GROUP BY a.account_id, a.all_regions, a.is_host
      ORDER BY a.account_id ASC`,
  );
  const out: AccountScanScope[] = [];
  for (const r of rows) {
    // The host always scans all regions (v1 parity) regardless of the flag — mirrors render_spc,
    // so an un-backfilled host row can never empty the inventory.
    if (r.all_regions || r.is_host) { out.push({ accountId: r.account_id, regions: ['*'] }); continue; }
    const regions = ((r.regions as string[]) || []).filter(Boolean);
    if (regions.length === 0) continue; // not all-regions and nothing enabled → skip
    out.push({ accountId: r.account_id, regions });
  }
  return out;
}

export async function disableAccountRegion(accountId: string, region: string): Promise<void> {
  await getPool().query(
    'UPDATE account_regions SET enabled = false, updated_at = now() WHERE account_id = $1 AND region = $2',
    [accountId, region],
  );
}
