// Resolves managed-datastore hostnames (from workload config) to inventory resources.
// Reads only the endpoint fields of the inventory rows of a single account; nothing from
// workload config except the bare host is ever used or returned.
// Evidence contract (same checks as fetchType in app/topology/page.tsx): a host is bound to a
// resource only from a type whose pages each carry consistency=statement-snapshot and ONE
// succeeded ledger version. A type whose ledger is missing, running/partial/failed, malformed
// or changed between pages is `incomplete`; a type that still returns a full page at the page
// cap with a wanted host unresolved is `capped`. Either way that type's matches are withheld:
// no host is bound from a mixed, unknown or truncated generation. Read errors still throw.
import { readResources, type InventoryPage } from '@/lib/inventory';
import { extractManagedDbHosts, type DbKind } from '@/lib/db-endpoint';

export interface DbResource { type: string; id: string; region: string | null; accountId: string }

export interface DbHostResolution {
  /** Caller's host spelling -> matched inventory resource. */
  map: Map<string, DbResource>;
  /** A needed type still returned a full page at the page cap with a wanted host unresolved; its matches are withheld. */
  capped: boolean;
  /** A needed type had no stable succeeded statement-snapshot evidence; its matches are withheld. */
  incomplete: boolean;
}

const PAGE = 500;
const MAX_PAGES = 5;

type Row = Record<string, unknown>;

const str = (v: unknown): string[] => (typeof v === 'string' && v ? [v] : []);
const strMap = (v: unknown): string[] =>
  v && typeof v === 'object' && !Array.isArray(v) ? Object.values(v).flatMap(str) : [];

// Endpoint field names per inventory type (see scripts/v2/steampipe/sync_lambda.py + inventory-types.ts).
// ElastiCache: applications dial a replication group's primary/reader endpoint, stored on the
// `elasticache_replication_group` row (node_groups[].PrimaryEndpoint / ReaderEndpoint); per-node endpoints
// are on the `elasticache` cache-cluster row (cache_nodes[].Endpoint). A host is checked against the types of its kind (TYPE_KIND); an unclassifiable
// host against every type. Neither sync stores a configuration endpoint (cluster mode enabled, Memcached auto-discovery) and
// MSK stores no broker endpoint, so those hosts stay unresolved.
// Bound: MAX_PAGES x PAGE rows per type, so at most 6 x 5 = 30 sequential reads (15,000 rows) per
// call; a type whose kind no wanted host has is not read, and a type stops paging once nothing is
// left for it to resolve.
const ENDPOINT_FIELDS: Record<string, (d: Row) => string[]> = {
  rds: d => str(d.endpoint_address),
  rds_cluster: d => [...str(d.endpoint), ...str(d.reader_endpoint), ...(Array.isArray(d.custom_endpoints) ? d.custom_endpoints.flatMap(str) : [])],
  rds_proxy: d => str(d.endpoint),
  opensearch: d => [...str(d.endpoint), ...strMap(d.endpoints)],
  elasticache: d => (Array.isArray(d.cache_nodes) ? d.cache_nodes : []).flatMap(n => {
    const ep = (n as { Endpoint?: { Address?: unknown } } | null)?.Endpoint;
    return str(ep?.Address);
  }),
  elasticache_replication_group: d => (Array.isArray(d.node_groups) ? d.node_groups : []).flatMap(g => {
    const ng = g as { PrimaryEndpoint?: { Address?: unknown } | null; ReaderEndpoint?: { Address?: unknown } | null } | null;
    return [...str(ng?.PrimaryEndpoint?.Address), ...str(ng?.ReaderEndpoint?.Address)];
  }),
};

// Inventory type -> the host kind (db-endpoint.ts KIND_PATTERNS) its endpoints carry.
// MSK has no endpoint-bearing inventory type.
const TYPE_KIND: Record<string, DbKind> = {
  rds: 'rds', rds_cluster: 'rds', rds_proxy: 'rds', opensearch: 'opensearch',
  elasticache: 'elasticache', elasticache_replication_group: 'elasticache',
};

/** Kind by hostname suffix; undefined (not exactly one managed host) is checked against every type. */
function kindOf(host: string): DbKind | undefined {
  const [hit, ...rest] = extractManagedDbHosts(host);
  return hit && rest.length === 0 && hit.host === host.toLowerCase() ? hit.kind : undefined;
}

const nonempty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const validTime = (v: unknown): boolean => nonempty(v) && Number.isFinite(Date.parse(v));

/**
 * Ledger version of a page that proves a completed success under one statement snapshot, else
 * null (marker missing, no ledger, running/partial/failed, or a malformed success). Same checks
 * and version tuple as fetchType in app/topology/page.tsx.
 */
function ledgerVersion(page: InventoryPage): string | null {
  const run = page.run;
  if (page.consistency !== 'statement-snapshot' || !run || run.status !== 'succeeded'
    || !validTime(run.finished_at) || !validTime(run.last_success_at)
    || !Number.isSafeInteger(run.row_count) || (run.row_count as number) < 0) return null;
  return JSON.stringify([run.status, run.finished_at, run.last_success_at, run.row_count]);
}

export async function resolveDbHosts(
  hosts: string[],
  accountId: string,
  read: typeof readResources = readResources,
): Promise<DbHostResolution> {
  const wanted = new Map<string, { host: string; kind: DbKind | undefined }>(); // lower-cased -> caller's spelling + kind
  for (const h of hosts) wanted.set(h.toLowerCase(), { host: h, kind: kindOf(h) });
  const map = new Map<string, DbResource>();
  let capped = false;
  let incomplete = false;
  if (wanted.size === 0) return { map, capped, incomplete };

  for (const [type, endpoints] of Object.entries(ENDPOINT_FIELDS)) {
    const found = new Map<string, DbResource>(); // staged: merged only when this type's pages end cleanly
    // A wanted host this type could still resolve: unresolved, and of this type's kind (or unclassified).
    const pending = () => [...wanted.values()].some((w) =>
      !map.has(w.host) && !found.has(w.host) && (w.kind === undefined || w.kind === TYPE_KIND[type]));
    if (!pending()) continue; // nothing to look for in this type: no read, no flag
    let version: string | undefined;
    let stable = true;   // every page read carried the marker and one succeeded ledger version
    let settled = false; // ended on a short page, or nothing is left for this type to resolve
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await read(type, { limit: PAGE, offset: page * PAGE, accounts: [accountId] });
      const current = ledgerVersion(result);
      if (current === null || (version !== undefined && version !== current)) { stable = false; break; }
      version = current;
      for (const row of result.rows) {
        const data = (row.data && typeof row.data === 'object' ? row.data : row) as Row;
        for (const ep of endpoints(data)) {
          const w = wanted.get(ep.toLowerCase());
          if (!w || map.has(w.host) || found.has(w.host)) continue;
          found.set(w.host, {
            type,
            id: String(row.resource_id ?? ''),
            region: typeof row.region === 'string' ? row.region : null,
            accountId: typeof row.account_id === 'string' ? row.account_id : accountId,
          });
        }
      }
      if (result.rows.length < PAGE || !pending()) { settled = true; break; }
    }
    if (!stable) { incomplete = true; continue; } // missing, failed or changed evidence: withhold
    if (!settled) { capped = true; continue; }    // page cap with a host unresolved: withhold
    for (const [host, resource] of found) map.set(host, resource);
  }
  return { map, capped, incomplete };
}
