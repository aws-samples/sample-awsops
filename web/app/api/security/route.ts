import { verifyUser } from '@/lib/auth';
import { getPool } from '@/lib/db';
import { FINDING_SQL, rowToFinding, CHECK_META, type CheckKey, type Finding } from '@/lib/security-findings';
import { ecrCveFindings } from '@/lib/ecr-cve';

export const dynamic = 'force-dynamic';

const CHECKS = Object.keys(CHECK_META) as CheckKey[];

// Resolve the `accounts` query param (absent → ['self'], '__all__' → 'self' + enabled member
// accounts, CSV → validated ids) into the concrete account_id list the finding SQL filters on.
async function resolveAccounts(raw: string | null): Promise<string[]> {
  const pool = getPool();
  if (!raw) return ['self'];
  if (raw === '__all__') {
    try {
      const r = await pool.query<{ account_id: string }>(
        `SELECT account_id FROM accounts WHERE enabled AND NOT is_host`,
      );
      return ['self', ...r.rows.map((x) => x.account_id)];
    } catch {
      return ['self']; // accounts table unavailable → honest host-only scope
    }
  }
  const ids = raw.split(',').map((x) => x.trim()).filter((x) => x === 'self' || /^\d{12}$/.test(x));
  return ids.length > 0 ? ids : ['self'];
}

export async function GET(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  try {
    const pool = getPool();
    const accounts = await resolveAccounts(new URL(request.url).searchParams.get('accounts'));
    // Presence probe: any rows for the security-relevant resource types? If none, the inventory
    // sync hasn't run (or steampipe_enabled is OFF) → report disabled so the page shows a notice.
    // NOTE (accepted, MINOR): this conflates "not yet synced" with "steampipe OFF", and a partial
    // sync (only some types present) reads as enabled with empty checks — acceptable for v1-parity.
    const probe = await pool.query<{ n: number }>(
      `SELECT count(*)::int n FROM inventory_resources
       WHERE account_id = ANY($1)
         AND resource_type IN ('s3_public_access','security_group','ebs_volume','iam_user')`,
      [accounts],
    );
    if (Number(probe.rows[0]?.n ?? 0) === 0) {
      return Response.json({ enabled: false, summary: {}, findings: {} });
    }
    const summary = {} as Record<CheckKey, number>;
    const findings = {} as Record<CheckKey, Finding[]>;
    for (const check of CHECKS) {
      if (!(check in FINDING_SQL)) continue; // live-SDK checks handled below
      const r = await pool.query<{ resource_id: string; region: string; account_id?: string; detail: unknown }>(
        FINDING_SQL[check as keyof typeof FINDING_SQL], [accounts],
      );
      findings[check] = r.rows.map((row) => rowToFinding(check, row));
      summary[check] = findings[check].length;
    }
    // Container CVEs: live ECR scan summaries — degrades to an empty tab, never fails the page.
    try {
      findings.ecr_cve = await ecrCveFindings(accounts);
    } catch {
      findings.ecr_cve = [];
    }
    summary.ecr_cve = findings.ecr_cve.length;
    return Response.json({ enabled: true, summary, findings, accounts });
  } catch (e) {
    return Response.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
