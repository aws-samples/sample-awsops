import type { FlowGraph } from './flow-topology';
import type { NfmCategory, NfmFlowRow, NfmMetric } from './nfm';

export type E2eEvidence = 'configuration' | 'service' | 'network' | 'identity' | 'context';
export type E2eLayer = 'configuration' | 'service' | 'network';
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
  relation: string;
  evidence: E2eEvidence;
  directed: boolean;
  label?: string;
  meta?: Record<string, unknown>;
}
export interface ServiceSnapshot {
  nodes: { id: string; kind: string; label: string; meta?: Record<string, unknown> }[];
  edges: { source: string; target: string; rel: string; confidence?: string }[];
  captured_at: string | null;
}
export interface NetworkObservation {
  monitor: string;
  /** Name-derived display hint only; never proof of endpoint/workload membership. */
  cluster: string | null;
  metric: NfmMetric;
  category: NfmCategory;
  rangeSec: number;
  rows: NfmFlowRow[];
  unit: string;
  startTime?: string;
  endTime?: string;
  queriedAt?: string;
  capped: boolean;
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
  /** Eligible query hits before caps, or the selected node count without a query. */
  matchedNodes: number;
}
