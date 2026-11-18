// Resolves managed-datastore hostnames (from workload config) to inventory resources.
// Reads only the endpoint fields of the inventory rows of a single account; nothing from
// workload config except the bare host is ever used or returned.
import { readResources } from '@/lib/inventory';

export interface DbResource { type: string; id: string; region: string | null; accountId: string }

const PAGE = 500;
const MAX_PAGES = 5;

type Row = Record<string, unknown>;

const str = (v: unknown): string[] => (typeof v === 'string' && v ? [v] : []);
const strMap = (v: unknown): string[] =>
  v && typeof v === 'object' && !Array.isArray(v) ? Object.values(v).flatMap(str) : [];

// Endpoint field names per inventory type (see scripts/v2/steampipe/sync_lambda.py + inventory-types.ts).
// MSK and ElastiCache replication groups store no endpoint, so those hosts stay unresolved.
const ENDPOINT_FIELDS: Record<string, (d: Row) => string[]> = {
  rds: d => str(d.endpoint_address),
  rds_cluster: d => [...str(d.endpoint), ...str(d.reader_endpoint), ...(Array.isArray(d.custom_endpoints) ? d.custom_endpoints.flatMap(str) : [])],
  rds_proxy: d => str(d.endpoint),
  opensearch: d => [...str(d.endpoint), ...strMap(d.endpoints)],
  elasticache: d => (Array.isArray(d.cache_nodes) ? d.cache_nodes : []).flatMap(n => {
    const ep = (n as { Endpoint?: { Address?: unknown } } | null)?.Endpoint;
    return str(ep?.Address);
  }),
};

export async function resolveDbHosts(
  hosts: string[],
  accountId: string,
  read: typeof readResources = readResources,
): Promise<Map<string, DbResource>> {
  const wanted = new Map<string, string>(); // lower-cased -> caller's spelling
  for (const h of hosts) wanted.set(h.toLowerCase(), h);
  const out = new Map<string, DbResource>();
  if (wanted.size === 0) return out;

  for (const [type, endpoints] of Object.entries(ENDPOINT_FIELDS)) {
    for (let page = 0; page < MAX_PAGES; page++) {
      const { rows } = await read(type, { limit: PAGE, offset: page * PAGE, accounts: [accountId] });
      for (const row of rows) {
        const data = (row.data && typeof row.data === 'object' ? row.data : row) as Row;
        for (const ep of endpoints(data)) {
          const host = wanted.get(ep.toLowerCase());
          if (!host || out.has(host)) continue;
          out.set(host, {
            type,
            id: String(row.resource_id ?? ''),
            region: typeof row.region === 'string' ? row.region : null,
            accountId: typeof row.account_id === 'string' ? row.account_id : accountId,
          });
        }
      }
      if (rows.length < PAGE) break;
    }
  }
  return out;
}
