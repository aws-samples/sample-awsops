import type { FlowGraph } from './flow-topology';
import type { NfmCategory, NfmFlowRow, NfmMetric } from './nfm';
import type { GraphCollection } from '../components/topology/GraphCollectionStatus';

export type E2eEvidence = 'configuration' | 'service' | 'network' | 'identity' | 'context';
export type E2eLayer = 'configuration' | 'service' | 'network';
export interface E2eNode {
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
  /** Public graph collection metadata, validated by the loader; absence remains unknown. */
  collection?: GraphCollection;
}
export interface NetworkObservation {
  monitor: string;
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
  omittedNodes: number;
  omittedEdges: number;
  matchedNodes: number;
}
