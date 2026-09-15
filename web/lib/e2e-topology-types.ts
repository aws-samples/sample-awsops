import type { FlowGraph } from './flow-topology';
import type { NetworkBatch, NetworkObservation } from './topology-observations';
export type { NetworkObservation } from './topology-observations';

export type E2eEvidence = 'configuration' | 'service' | 'network' | 'identity' | 'context';
export type E2eLayer = 'configuration' | 'service' | 'network';
/** Endpoint meta.correlationReason explains withholding; correlated endpoints have no reason. */
export type E2eCorrelationReason = 'configuration_conflict' | 'configuration_unverified'
  | 'workload_conflict' | 'workload_scope_unverified' | 'pod_identity_conflict' | 'context_only' | 'no_match';
export interface E2eNode {
  /** Stable source/content identity; network IDs are opaque to substring search. */
  id: string;
  kind: string;
  label: string;
  layer: E2eLayer;
  meta: Record<string, unknown>;
}
export interface E2eEdge {
  id: string;
  source: string;
  target: string;
  /** Configured record equality is distinct from a corroborated pod tuple; neither proves current/exclusive ownership. */
  relation: string;
  evidence: E2eEvidence;
  directed: boolean;
  label?: string;
  meta?: Record<string, unknown>;
}
export interface ServiceSnapshot {
  /** Workload identity requires accountId/region claims here or on incoming runs_on services. */
  nodes: { id: string; kind: string; label: string; meta?: Record<string, unknown>; captured_at?: string | null }[];
  edges: { source: string; target: string; rel: string; confidence?: string }[];
  /** Legacy envelope display clock, not per-node or edge capture. */
  captured_at: string | null;
  /** Actual /api/graph fields; collector partial/stale is distinct from read truncation. */
  collection?: { status?: string; stale?: boolean; readStatus?: string;
    readTruncated?: boolean; metadataTruncated?: boolean;
    nodeDrops?: number; edgeDrops?: number; inputTruncated?: boolean; graphTruncated?: boolean };
  from?: string;
  capped?: boolean;
}
export type E2eSourceStatus = 'complete' | 'partial' | 'unavailable' | 'unknown';
export interface E2eServiceQuality {
  status: string;
  stale: boolean | null;
  readStatus: 'ok' | 'partial' | 'unavailable' | 'unknown';
  readTruncated: boolean | null;
  metadataTruncated: boolean | null;
  nodeDrops: number | null;
  edgeDrops: number | null;
  inputTruncated: boolean | null;
  graphTruncated: boolean | null;
}
export interface E2eNetworkQuality {
  status: E2eSourceStatus;
  failedCategories: NetworkBatch['failedCategories'] | null;
  cappedCategories: NetworkBatch['cappedCategories'] | null;
  windowQuality: NetworkBatch['windowQuality'] | null;
}
export interface E2eInput {
  account: string;
  configured: FlowGraph;
  services: ServiceSnapshot | null;
  network: NetworkObservation[];
  /** Configuration census completeness, including instance-target-bearing reads. Missing means unknown. */
  quality?: { configuration?: E2eSourceStatus; network?: Partial<E2eNetworkQuality> | null };
}
export interface E2eGraph {
  nodes: E2eNode[];
  edges: E2eEdge[];
  summary: {
    configuredNodes: number;
    serviceNodes: number;
    networkFlows: number;
    /** Per-row endpoint observations with identity evidence, not distinct endpoints or ownership. */
    correlatedEndpoints: number;
    unmatchedEndpoints: number;
    ambiguousEndpoints: number;
    observationsUnsupported: boolean;
    quality: { configuration: E2eSourceStatus; services: E2eServiceQuality;
      network: E2eNetworkQuality; unresolvedTargetGroups: number };
  };
}
export interface E2eSelection {
  query?: string;
  focusId?: string | null;
  evidence?: E2eEvidence[];
  maxNodes?: number;
  maxEdges?: number;
}
export interface E2eView {
  nodes: E2eNode[];
  edges: E2eEdge[];
  /** Display-budget omissions after eligibility and focus/query reachability. */
  omittedNodes: number;
  omittedEdges: number;
  /** Hidden or incomplete connection observations by category after filters/caps, not endpoint/edge counts. */
  omittedCategories: Record<string, number>;
  /** Eligible query hits before caps, or the selected node count without a query. */
  matchedNodes: number;
}
