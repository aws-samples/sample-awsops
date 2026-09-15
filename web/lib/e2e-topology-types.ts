import type { FlowGraph } from './flow-topology';
import type { NetworkObservation } from './topology-observations';
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
  nodes: { id: string; kind: string; label: string; meta?: Record<string, unknown> }[];
  edges: { source: string; target: string; rel: string; confidence?: string }[];
  captured_at: string | null;
}
export interface E2eInput {
  account: string;
  configured: FlowGraph;
  services: ServiceSnapshot | null;
  network: NetworkObservation[];
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
