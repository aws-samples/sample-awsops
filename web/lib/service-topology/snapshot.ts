// Shared wire contract. All IDs are scoped to the trusted host storage partition.
export const SERVICE_SCOPE = 'self:all-regions:include-global';
export type Layer = 'trace' | 'flow' | 'infra' | 'inventory';
export interface Manifest {
  source: Layer;
  sourceId?: string;
  generation: string | null;
  status: string;
  capturedAt: string | null;
  attemptedAt: string | null;
  stale: boolean;
  retained: boolean;
  capped: boolean;
  reasons?: string[];
  window: { start: number; end: number } | null;
}
export interface Entity {
  id: string;
  kind: string;
  label: string;
  layers: Layer[];
  evidenceRefs: string[];
  claim: boolean;
  region: string | null;
  cluster: string | null;
  namespace: string | null;
  ownerReason: string | null;
  vpc: string | null;
  sourceId: string | null;
  spanCount: number | null;
  knownStatus: number | null;
  errors: number | null;
  durationSumMs: number | null;
}
export interface Relation {
  id: string;
  source: string;
  target: string;
  kind: string;
  layer: Layer;
  confidence: string;
  evidenceRefs: string[];
  spanCount?: number;
  metricCount?: number;
}
export interface ServiceSnapshot {
  sources: Manifest[];
  entities: Entity[];
  relations: Relation[];
  gaps: string[];
}
