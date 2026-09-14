import type { NfmCategory, NfmFlowRow, NfmMetric } from './nfm';
import type { NetworkObservation } from './e2e-topology-types';

// Client-safe mirrors of the existing NFM API allowlists; never import its AWS client at runtime.
export const TOPOLOGY_METRICS: NfmMetric[] = ['DATA_TRANSFERRED', 'ROUND_TRIP_TIME', 'RETRANSMISSIONS', 'TIMEOUTS'];
export const TOPOLOGY_CATEGORIES: NfmCategory[] = [
  'INTRA_AZ', 'INTER_AZ', 'INTER_VPC', 'INTER_REGION', 'AMAZON_S3', 'AMAZON_DYNAMODB', 'UNCLASSIFIED',
];
export const TOPOLOGY_RANGES = [900, 1800, 3600];

export interface TopologyMonitor { name: string; status: string; cluster: string | null }
export interface NetworkFilters {
  monitor: string;
  metric: NfmMetric;
  category: NfmCategory | 'ALL';
  rangeSec: number;
}
export interface NetworkBatch {
  filters: NetworkFilters;
  observations: NetworkObservation[];
  failedCategories: NfmCategory[];
  cappedCategories: NfmCategory[];
  errors: Partial<Record<NfmCategory, string>>;
}
interface LoadOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  onProgress?: (completed: number, total: number) => void;
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((s) => typeof s === 'string');
const timestamp = (value: unknown): string | undefined =>
  typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined;

function validRow(value: unknown, category: NfmCategory): value is NfmFlowRow {
  if (!record(value) || !record(value.local) || !record(value.remote)) return false;
  if (typeof value.value !== 'number' || !Number.isFinite(value.value) || value.value < 0) return false;
  return value.category === category && typeof value.unit === 'string'
    && strings(value.traversed) && strings(value.traversedIds)
    && [value.local, value.remote].every((endpoint) =>
      Object.values(endpoint).every((v) => v == null || typeof v === 'string'));
}

/** Query existing authenticated NFM endpoints with a bounded category fan-out.
 * Each result keeps its original observation window (including cached responses). */
export async function loadNetworkObservations(
  filters: NetworkFilters, monitor: TopologyMonitor, options: LoadOptions = {},
): Promise<NetworkBatch> {
  if (!TOPOLOGY_RANGES.includes(filters.rangeSec)) throw new Error('Unsupported NFM range');
  if (!filters.monitor || filters.monitor !== monitor.name || monitor.status !== 'ACTIVE') throw new Error('Invalid NFM monitor');
  if (!TOPOLOGY_METRICS.includes(filters.metric)) throw new Error('Unsupported NFM metric');
  if (filters.category !== 'ALL' && !TOPOLOGY_CATEGORIES.includes(filters.category)) throw new Error('Unsupported NFM category');
  const applied = { ...filters };
  const categories = applied.category === 'ALL' ? [...TOPOLOGY_CATEGORIES] : [applied.category];
  const request = options.fetch ?? fetch;
  const observations = new Map<NfmCategory, NetworkObservation>();
  const errors: Partial<Record<NfmCategory, string>> = {};
  let next = 0;
  let completed = 0;
  const checkAbort = () => {
    if (options.signal?.aborted) throw new DOMException('Observation query canceled', 'AbortError');
  };
  const worker = async () => {
    while (next < categories.length) {
      checkAbort();
      const category = categories[next++];
      const qs = new URLSearchParams({
        monitor: applied.monitor, metric: applied.metric, category, range: String(applied.rangeSec),
      });
      try {
        const response = await request(`/api/nfm/query?${qs}`, { signal: options.signal });
        const body: unknown = await response.json();
        checkAbort();
        if (!response.ok) {
          const message = record(body) ? body.message ?? body.error : undefined;
          throw new Error(typeof message === 'string' ? message : `HTTP ${response.status}`);
        }
        if (!record(body) || body.monitor !== applied.monitor || body.metric !== applied.metric
          || body.category !== category || body.range !== applied.rangeSec) {
          throw new Error('NFM response scope mismatch');
        }
        if (!Array.isArray(body.rows) || !body.rows.every((row) => validRow(row, category))
          || typeof body.unit !== 'string' || !body.unit) {
          throw new Error('Invalid NFM observation response');
        }
        observations.set(category, {
          monitor: applied.monitor, cluster: monitor.cluster,
          category, metric: applied.metric, rangeSec: applied.rangeSec,
          rows: body.rows.slice(0, 50) as NfmFlowRow[], unit: body.unit,
          startTime: timestamp(body.startTime), endTime: timestamp(body.endTime),
          queriedAt: timestamp(body.queriedAt),
          capped: body.capped === true || body.rows.length >= 50,
        });
      } catch (error) {
        checkAbort();
        errors[category] = error instanceof Error ? error.message : 'NFM query failed';
      }
      checkAbort();
      completed += 1;
      options.onProgress?.(completed, categories.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, categories.length) }, () => worker()));
  checkAbort();
  return {
    filters: applied,
    observations: categories.flatMap((category) => {
      const observation = observations.get(category);
      return observation ? [observation] : [];
    }),
    failedCategories: categories.filter((category) => errors[category] !== undefined),
    cappedCategories: categories.filter((category) => observations.get(category)?.capped),
    errors,
  };
}
