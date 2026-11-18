// Route53 → K8s gateway linking (optional data: any failure yields no records, the DNS column hides).
// Field names mirror flow-topology.ts's route53 handling: row.data.{name, type, alias_target.DNSName, records[]}.
// Matching is EXACT host equality (case-/trailing-dot-insensitive) — never suffix/prefix/fuzzy, so a
// record is only ever attached to a gateway whose host it names verbatim.
export interface DnsRecord { name: string; target: string }

const MAX_PAGES = 5, PAGE_SIZE = 500, MAX_RECORDS = 2000, MAX_NAME = 253;
// DNS charset: LDH labels (plus '_' and a leading '*' wildcard label as Route53 allows).
const DNS_NAME = /^(\*\.)?[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*$/;

const bare = (v: unknown): string => (typeof v === 'string' ? v.trim().toLowerCase().replace(/\.+$/, '') : '');
const validName = (n: string): boolean => n.length > 0 && n.length <= MAX_NAME && DNS_NAME.test(n);

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
  const name = bare(d.name);
  if (!validName(name)) return null;
  let target = '';
  if (isRec(d.alias_target) && d.alias_target.DNSName) {
    target = bare(d.alias_target.DNSName).replace(/^dualstack\./, '');
  } else if (type === 'CNAME' && Array.isArray(d.records) && d.records.length) {
    const first = d.records[0];
    target = bare(typeof first === 'string' ? first : isRec(first) ? first.Value : '');
  }
  return validName(target) && target !== name ? { name, target } : null;
}

/** Browser-side read of the synced Route53 inventory (host: 'self'; members: the account id). Never throws. */
export async function fetchDnsRecords(accountId: string, signal?: AbortSignal): Promise<DnsRecord[]> {
  const out: DnsRecord[] = [];
  try {
    for (let page = 0; page < MAX_PAGES && out.length < MAX_RECORDS; page++) {
      if (signal?.aborted) return [];
      const qs = new URLSearchParams({ accounts: accountId || 'self', limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) });
      const r = await fetch(`/api/inventory/route53?${qs}`, { signal });
      if (!r.ok) return [];
      const d: unknown = await r.json();
      if (!isRec(d) || !Array.isArray(d.rows)) return [];
      for (const row of d.rows) {
        const rec = toRecord(row);
        if (rec && out.length < MAX_RECORDS) out.push(rec);
      }
      if (d.rows.length < PAGE_SIZE) break;
    }
    return out;
  } catch {
    return [];
  }
}
