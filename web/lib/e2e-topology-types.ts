import type { FlowGraph } from './flow-topology';
import type { NetworkObservation } from './topology-observations';
export type { NetworkObservation } from './topology-observations';

export type E2eEvidence = 'configuration' | 'service' | 'network' | 'identity' | 'context';
export type E2eLayer = 'configuration' | 'service' | 'network';
/** UI-owned translation keys. Generated labels fall back to the code; source labels stay verbatim. */
export type E2eLabelKey = 'network_observation' | 'local_endpoint' | 'remote_endpoint'
  | 'configured_endpoint_record' | 'cached_configured_endpoint_record' | 'configured_pod_identity';
/** Endpoint meta.correlationReason explains withholding; correlated endpoints have no reason. */
export type E2eCorrelationReason = 'configuration_conflict' | 'configuration_unverified'
  | 'workload_conflict' | 'workload_scope_unverified' | 'service_source_unverified'
  | 'pod_identity_conflict' | 'context_only' | 'no_match';
export interface E2eNode {
  /** Stable source/content identity; network IDs are opaque to substring search. */
  id: string;
  kind: string;
  label: string;
  labelKey?: E2eLabelKey;
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
  labelKey?: E2eLabelKey;
  meta?: Record<string, unknown>;
}
export interface ServiceSnapshot {
  /** Workload identity requires accountId/region claims here or on incoming runs_on services. */
  nodes: { id: string; kind: string; label: string; meta?: Record<string, unknown>; captured_at?: string | null }[];
  edges: { source: string; target: string; rel: string; confidence?: string }[];
  captured_at: string | null;
}
export interface E2eNetworkRead {
  status: 'idle' | 'loading' | 'complete' | 'partial' | 'failed' | 'unknown' | 'unsupported';
  failedCategories?: readonly string[];
  unknownWindowCategories?: readonly string[];
}
export interface E2eInput {
  account: string;
  /** Trusted 12-digit ID from authenticated /api/accounts' unique isHost entry, never telemetry. */
  hostAccountId?: string;
  configured: FlowGraph;
  /** Caller-owned inventory read quality. Only true permits identity; absent/retained/incomplete fails closed. */
  configurationComplete?: boolean;
  services: ServiceSnapshot | null;
  /** Caller attests a fresh, complete service query scope; absent/retained/incomplete fails closed. */
  servicesComplete?: boolean;
  /** Positive observations remain evidence independently of batch read quality. */
  network: NetworkObservation[];
  networkRead?: E2eNetworkRead;
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
    configurationComplete: boolean;
    /** Explicit caller attestation plus a nonempty, parseable services.captured_at; no clock-based freshness check. */
    servicesComplete: boolean;
    /** Always includes both arrays; omitted input is unknown, non-self scope is unsupported. */
    networkRead: Required<E2eNetworkRead>;
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
  /** Sorted eligible categories with any dropped or incomplete connection group. */
  omittedCategories: string[];
  /** Eligible query hits before caps, or the selected node count without a query. */
  matchedNodes: number;
}
