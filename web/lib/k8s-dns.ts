// Route53 → K8s gateway linking (optional data). A failed read yields no records with `failed`; a read
// that stops at a page/record cap keeps what it read with `truncated`. Evidence gate (same checks as
// fetchType in app/topology/page.tsx and db-ref-resolve.ts, via inventory-ledger.ts): every page must
// carry consistency=statement-snapshot and ONE succeeded ledger version; a missing, running/partial/
// failed, malformed or changed ledger yields no records with `incomplete`. The caller discloses all three.
// Field names mirror flow-topology.ts's route53 handling: row.data.{name, type, alias_target.DNSName, records[]}.
// Matching is EXACT host equality (case-/trailing-dot-insensitive) — never suffix/prefix/fuzzy, so a
// record is only ever attached to a gateway whose host it names verbatim.
import type { InventoryPage } from '@/lib/inventory';
import { ledgerVersion } from '@/lib/inventory-ledger';

export interface DnsRecord { name: string; target: string }

const MAX_PAGES = 5, PAGE_SIZE = 500, MAX_RECORDS = 2000, MAX_NAME = 253;
// DNS charset: LDH labels (plus '_' and a leading '*' wildcard label as Route53 allows).
const DNS_NAME = /^(\*\.)?[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*$/;

const bare = (v: unknown): string => (typeof v === 'string' ? v.trim().toLowerCase().replace(/\.+$/, '') : '');
const validName = (n: string): boolean => n.length > 0 && n.length <= MAX_NAME && DNS_NAME.test(n);
// Route 53 returns '*' in a record name as the octal escape `\052`. Only that escape is decoded, so a
// LEADING wildcard label can pass DNS_NAME. Every other escape denotes a character outside the accepted
// charset (decoding `\056` would turn a literal dot into a label separator), so such names still fail
// validation. A wildcard name is safe to keep: gateways are matched on the record TARGET, never the name.
const recordName = (v: unknown): string => bare(v).replace(/\\052/g, '*');
// `dualstack.` is an ELB alias-target convention. Strip it ONLY when the remainder is an ELB host
// (ALB `<name>.<region>.elb.amazonaws.com`, NLB `<name>.elb.<region>.amazonaws.com`); a literal
// `dualstack.`-prefixed non-ELB name is kept verbatim. Same guard as bareDns in flow-topology.ts —
// keep the two in step.
const isElbHost = (h: string): boolean => /\.elb\.(?:[a-z0-9-]+\.)?amazonaws\.com$/.test(h);
const aliasTarget = (v: unknown): string => {
  const d = bare(v);
  const stripped = d.replace(/^dualstack\./, '');
  return stripped !== d && isElbHost(stripped) ? stripped : d;
};

export function matchDnsToGateways(records: DnsRecord[], gatewayHosts: string[]): { record: DnsRecord; gatewayHost: string }[] {
  const out: { record: DnsRecord; gatewayHost: string }[] = [];
  for (const record of records) {
    const t = bare(record.target);
    if (!t) continue;
    for (const gatewayHost of gatewayHosts) if (bare(gatewayHost) === t) out.push({ record, gatewayHost });
  }
  return out;
}

const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Normalize one inventory row; only A/AAAA-alias and CNAME targets are kept (TXT etc. are dropped). */
function toRecord(row: unknown): DnsRecord | null {
  if (!isRec(row) || !isRec(row.data)) return null;
  const d = row.data;
  const type = typeof d.type === 'string' ? d.type.toUpperCase() : '';
  const name = recordName(d.name);
  if (!validName(name)) return null;
  let target = '';
  if (isRec(d.alias_target) && d.alias_target.DNSName) {
    target = aliasTarget(d.alias_target.DNSName);
  } else if (type === 'CNAME' && Array.isArray(d.records) && d.records.length) {
    const first = d.records[0];
    target = bare(typeof first === 'string' ? first : isRec(first) ? first.Value : '');
  }
  return validName(target) && target !== name ? { name, target } : null;
}

export interface DnsRead {
  records: DnsRecord[];
  /** A page or record cap was reached while more records may exist; `records` may be incomplete. */
  truncated: boolean;
  /** The read failed (non-OK status, malformed body, network error); `records` is empty. Never set for an aborted read. */
  failed: boolean;
  /** The Route 53 inventory had no stable succeeded statement-snapshot evidence (ledger missing,
   *  running/partial/failed, malformed, or changed between pages); `records` is withheld (empty). */
  incomplete: boolean;
}
const dnsRead = (failed: boolean): DnsRead => ({ records: [], truncated: false, failed, incomplete: false });
const incompleteRead = (): DnsRead => ({ records: [], truncated: false, failed: false, incomplete: true });

/** Browser-side read of the synced Route53 inventory (host: 'self'; members: the account id). Never throws. */
export async function fetchDnsRecords(accountId: string, signal?: AbortSignal): Promise<DnsRead> {
  const records: DnsRecord[] = [];
  let truncated = false;
  let version: string | undefined;
  try {
    for (let page = 0; page < MAX_PAGES && !truncated; page++) {
      if (signal?.aborted) return dnsRead(false);
      const qs = new URLSearchParams({ accounts: accountId || 'self', limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) });
      const r = await fetch(`/api/inventory/route53?${qs}`, { signal });
      if (!r.ok) return dnsRead(true);
      const d: unknown = await r.json();
      if (!isRec(d) || !Array.isArray(d.rows)) return dnsRead(true);
      const current = ledgerVersion(d as unknown as InventoryPage);
      if (current === null || (version !== undefined && version !== current)) return incompleteRead();
      version = current;
      for (const row of d.rows) {
        const rec = toRecord(row);
        if (!rec) continue;
        if (records.length >= MAX_RECORDS) { truncated = true; break; } // a valid record had to be dropped
        records.push(rec);
      }
      if (d.rows.length < PAGE_SIZE) break;          // short page: the inventory has no further rows
      if (page === MAX_PAGES - 1) truncated = true;  // page budget spent on a full page: more rows may exist
    }
    return { records, truncated, failed: false, incomplete: false };
  } catch {
    return dnsRead(!signal?.aborted);
  }
}
