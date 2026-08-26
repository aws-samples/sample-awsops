// Container image CVE findings from ECR image scanning (v1's Trivy CVE tab, v2-native source:
// scan-on-push / Inspector results via DescribeImageScanFindings — no scanner to deploy).
// STRICTLY read-only; every failure degrades to [] (a denied repo never blanks the tab).
import { ECRClient, DescribeImagesCommand, DescribeImageScanFindingsCommand } from '@aws-sdk/client-ecr';
import { getPool } from './db';
import { assumedClient } from './aws-assume';
import type { Finding } from './security-findings';

const REGION = process.env.AWS_REGION || 'ap-northeast-2';

const MAX_REPOS = 30; // one DescribeImages + one DescribeImageScanFindings per repo — bounded

export async function ecrCveFindings(accounts: string[] = ['self']): Promise<Finding[]> {
  // Repo list from the synced inventory (deployment region only — the ECR client is regional).
  // Member-account repos are read with STS-assumed creds (aws-assume); 'self' uses task-role creds.
  let repos: { name: string; region: string; account_id: string }[] = [];
  try {
    const r = await getPool().query<{ name: string; region: string; account_id: string }>(
      `SELECT resource_id AS name, region, account_id FROM inventory_resources
       WHERE resource_type='ecr' AND account_id = ANY($2) AND region=$1
       ORDER BY resource_id LIMIT ${MAX_REPOS}`,
      [REGION, accounts],
    );
    repos = r.rows;
  } catch {
    return [];
  }
  const clients = new Map<string, ECRClient>();
  const clientFor = async (account: string): Promise<ECRClient> => {
    let c = clients.get(account);
    if (!c) {
      c = await assumedClient(account === 'self' ? undefined : account, ECRClient, { region: REGION });
      clients.set(account, c);
    }
    return c;
  };
  const out: Finding[] = [];
  for (const repo of repos) {
    try {
      const ecr = await clientFor(repo.account_id);
      // Latest pushed image (scan results follow the newest artifact).
      const imgs = await ecr.send(new DescribeImagesCommand({
        repositoryName: repo.name, maxResults: 100,
      }));
      const latest = (imgs.imageDetails ?? [])
        .sort((a, b) => (b.imagePushedAt?.getTime() ?? 0) - (a.imagePushedAt?.getTime() ?? 0))[0];
      if (!latest?.imageDigest) continue;

      let sev: Record<string, number> = {};
      let status = 'UNKNOWN';
      let completedAt: string | null = null;
      // Prefer the summary already attached to the image (basic scanning);
      // fall back to DescribeImageScanFindings (enhanced/Inspector).
      if (latest.imageScanFindingsSummary?.findingSeverityCounts) {
        sev = latest.imageScanFindingsSummary.findingSeverityCounts as Record<string, number>;
        status = latest.imageScanStatus?.status ?? 'COMPLETE';
        completedAt = latest.imageScanFindingsSummary.imageScanCompletedAt?.toISOString() ?? null;
      } else {
        const scan = await (await clientFor(repo.account_id)).send(new DescribeImageScanFindingsCommand({
          repositoryName: repo.name, imageId: { imageDigest: latest.imageDigest }, maxResults: 1,
        }));
        sev = (scan.imageScanFindings?.findingSeverityCounts ?? {}) as Record<string, number>;
        status = scan.imageScanStatus?.status ?? 'UNKNOWN';
        completedAt = scan.imageScanFindings?.imageScanCompletedAt?.toISOString() ?? null;
      }

      const critical = sev.CRITICAL ?? 0;
      const high = sev.HIGH ?? 0;
      const medium = sev.MEDIUM ?? 0;
      const total = Object.values(sev).reduce((a, b) => a + Number(b || 0), 0);
      if (total === 0) continue; // clean (or unscanned) repos don't appear as findings
      out.push({
        check: 'ecr_cve',
        resource_id: repo.name,
        region: repo.region,
        account_id: repo.account_id,
        title: `${repo.name}: CVE ${total}건 (Critical ${critical} / High ${high})`,
        severity: critical > 0 ? 'high' : high > 0 ? 'medium' : 'low',
        detail: {
          image_tag: latest.imageTags?.[0] ?? '(untagged)',
          critical, high, medium,
          low: sev.LOW ?? 0,
          total,
          scan_status: status,
          scan_completed_at: completedAt,
          pushed_at: latest.imagePushedAt?.toISOString() ?? null,
        },
        remediation: 'Rebuild the image on a patched base; upgrade flagged packages; re-scan (scan-on-push).',
      });
    } catch {
      // per-repo denial/unscanned → skip silently
    }
  }
  return out.sort((a, b) => Number((b.detail as { total: number }).total) - Number((a.detail as { total: number }).total));
}
