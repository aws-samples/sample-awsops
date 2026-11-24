import { INTERACTIVE_FLOW_TYPES as TYPES, FLOW_INPUT_KEY as FLOW_KEY } from '@/lib/flow-inventory-types';
import type { FlowInput } from '@/lib/flow-topology';
import { fetchEksIpMap, inventoryEvidence, type EksIpResolution, type InventoryEvidence } from '@/lib/topology-config';

// Scope-aware inventory loader shared by the /topology flow graph and the site view.
// Moved out of app/topology/page.tsx without behavior change.

export type InvType = (typeof TYPES)[number];
// Every inventory read the ENI owner resolver consults (eni-owner.ts) that this page fetches.
export const OWNER_TYPES: InvType[] = ['eni', 'vpc_endpoint', 'nat_gateway', 'alb', 'nlb', 'lambda', 'ec2'];
// The page cannot prove freshness without comparing clocks, so RDS placement inference (which
// needs complete, current DB and proxy lists) is left to the materialized graph: these reads are
// not fetched and always count as incomplete.
export const SAVED_GRAPH_ONLY_OWNER_TYPES = ['rds', 'rds_cluster', 'rds_proxy'];
export type Row = Record<string, unknown>;

export const ROW_CAP = 500; // /api/inventory caps limit at 500
export const INVENTORY_LANES = 2; // Shared max:3 PG pool also serves authentication and other reads.
export const CRITICAL_PAGES = 20;
// Paged to completion: ownership reads that a cut list would turn into "unknown". ENIs run
// about 500 per account, so a single 500-row page would leave IP-target owners unresolved.
export const CRITICAL_TYPES = new Set<string>(['target_group', 'ecs_task', 'subnet', 'eni']);
export const rowLimit = (type: string) => ROW_CAP * (CRITICAL_TYPES.has(type) ? CRITICAL_PAGES : 1);

const record = (v: unknown): v is Row => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonempty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

export const NET_TYPES = ['vpc', 'security_group'] as const;
export type FetchedType = InvType | typeof NET_TYPES[number];
export type TypeResult = InventoryEvidence & { rows: Row[]; finishedAt: string | null; capped: boolean; incomplete?: boolean; runSucceeded?: boolean };
export type ReadResult = TypeResult & { readFailed: boolean; error: string };

export async function fetchType(t: FetchedType, inventoryScope: string, signal: AbortSignal): Promise<TypeResult> {
  const scopeQuery = new URLSearchParams(inventoryScope), account = scopeQuery.get('accounts') ?? 'self';
  const critical = CRITICAL_TYPES.has(t);
  const rows: Row[] = [], seen = new Set<string>();
  let version: string | undefined, finishedAt: string | null = null;
  let firstRun: Row | null = null;
  const result = (capped: boolean, incomplete = false) => ({ rows, finishedAt, capped, incomplete,
    runSucceeded: firstRun?.status === 'succeeded', ...inventoryEvidence(rows, firstRun, account === 'self') });
  try {
    for (let page = 0; page < (critical ? CRITICAL_PAGES : 1); page++) {
      if (signal.aborted) throw new Error();
      const qs = new URLSearchParams(scopeQuery);
      qs.set('limit', String(ROW_CAP)); qs.set('offset', String(page * ROW_CAP));
      const r = await fetch(`/api/inventory/${t}?${qs}`, { signal });
      if (!r.ok) throw new Error();
      const d: unknown = await r.json();
      if (signal.aborted || !record(d) || d.error || d.status === 'error'
        || !Array.isArray(d.rows) || d.rows.length > ROW_CAP) throw new Error();
      const run = record(d.run) ? d.run : null;
      const incomplete = critical && ['running', 'partial', 'failed'].includes(String(run?.status));
      if (critical) {
        if (d.consistency !== 'statement-snapshot') throw new Error();
        // The global type sweep covers every account. Only a stable success permits ownership.
        if (!run || (!incomplete && (run.status !== 'succeeded' || !nonempty(run.finished_at) || !Number.isFinite(Date.parse(run.finished_at))
          || !nonempty(run.last_success_at) || !Number.isFinite(Date.parse(run.last_success_at))
          || !Number.isSafeInteger(run.row_count) || (run.row_count as number) < 0))) throw new Error();
        const current = JSON.stringify([run.status, run.finished_at, run.last_success_at, run.row_count]);
        if (version !== undefined && version !== current) return result(false, true);
        version = current;

      }
      if (page === 0) firstRun = run;
      for (const row of d.rows) {
        if (!record(row) || !record(row.data)) throw new Error();
        if (critical) {
          if (!nonempty(row.account_id) || !nonempty(row.region) || !nonempty(row.resource_id)
            || (account !== '__all__' && !account.split(',').includes(row.account_id))) throw new Error();
          const key = JSON.stringify([row.account_id, row.region, row.resource_id]);
          if (seen.has(key)) throw new Error();
          seen.add(key);
        }
        rows.push({ ...row.data, account_id: row.account_id, resource_id: row.resource_id, region: row.region, captured_at: row.captured_at });
      }
      finishedAt = run && typeof run.finished_at === 'string' ? run.finished_at : null;
      // Keep a bounded cached page during a sweep, without mixing mutable pages or proving absence.
      if (incomplete || d.rows.length < ROW_CAP) return result(false, incomplete);
    }
    return result(true); // 10,000 critical rows still need an end-of-data proof.
  } catch {
    // Fetch/JSON errors can contain response fragments; expose only the fixed type-scoped reason.
    throw new Error(`${t}: invalid inventory response`);
  }
}

export type FlowLoad = {
  input: FlowInput;
  types: FetchedType[];            // order of `results`: interactive types, then NET_TYPES
  results: ReadResult[];
  res: ReadResult[];               // results for the interactive types
  net: ReadResult[];               // results for vpc / security_group
  eks: EksIpResolution | null;
  failed: ReadResult[];
  allFailed: boolean;              // every interactive type failed to read
  incomplete: boolean;             // any interactive type had an unstable sweep
};

// `entitiesEnabled` is forwarded to fetchEksIpMap (the page reads it from useEntityTopology).
export async function loadFlowInput(inventoryScope: string, signal: AbortSignal, entitiesEnabled = false): Promise<FlowLoad> {
  const account = new URLSearchParams(inventoryScope).get('accounts') || 'self';
  const read = async (type: FetchedType): Promise<ReadResult> => {
    try { return { ...await fetchType(type, inventoryScope, signal), readFailed: false, error: '' }; }
    catch { return { rows: [] as Row[], finishedAt: null, capped: false, incomplete: false,
      ...inventoryEvidence([], null, false), readFailed: true, error: `${type}: invalid inventory response` }; }
  };
  const types: FetchedType[] = [...TYPES, ...NET_TYPES];
  const results: ReadResult[] = new Array(types.length);
  let next = 0;
  const lane = async () => {
    for (;;) {
      const index = next++;
      if (index >= types.length) return;
      // fetchType stops before issuing a request when aborted; fill every result slot
      // so queued/unread types cannot be mistaken for successful empty inventories.
      results[index] = await read(types[index]);
    }
  };
  const [, eks] = await Promise.all([
    Promise.all(Array.from({ length: INVENTORY_LANES }, lane)),
    account === 'self' ? fetchEksIpMap(signal, entitiesEnabled) : Promise.resolve(null),
  ]);
  const res = results.slice(0, TYPES.length), net = results.slice(TYPES.length);
  const failed = results.filter(result => result.readFailed);
  const readIssue = (type: InvType): 'failed' | 'capped' | undefined => {
    const result = res[TYPES.indexOf(type)];
    return result.readFailed || result.incomplete ? 'failed' : result.capped ? 'capped' : undefined;
  };
  // Owner reads are usable only from a succeeded sweep.
  const ownerIssue = (type: InvType) => readIssue(type) !== undefined
    || !res[TYPES.indexOf(type)].runSucceeded;
  const input: FlowInput = { ipResolved: eks?.map, ownershipRead: {
    targetGroup: readIssue('target_group'), ecsTask: readIssue('ecs_task'), subnet: readIssue('subnet'),
    eksScopes: eks?.blockedScopes, eksUnknown: eks?.globalUnknown,
    ...(account === 'self' ? { eksRegions: eks?.coveredRegions } : { configurationOnly: true }),
    // Capped or failed owner reads: the ENI resolver refuses misses and inferences they guard.
    ownerIncomplete: [...OWNER_TYPES.filter(ownerIssue), ...SAVED_GRAPH_ONLY_OWNER_TYPES],
  } };
  TYPES.forEach((t, i) => { input[FLOW_KEY[t]] = res[i].rows; });
  return { input, types, results, res, net, eks, failed, allFailed: res.every(r => r.readFailed),
    incomplete: res.some(r => r.incomplete) };
}
