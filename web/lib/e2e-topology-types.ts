import type { FlowGraph } from './flow-topology';
import type { NfmCategory } from './nfm';
import type { GraphCollection } from '../components/topology/GraphCollectionStatus';
import type { NetworkBatch, NetworkReason, NetworkObservation } from './topology-observations';
export type { NetworkObservation } from './topology-observations';

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
  /** Loaders must validate public collection metadata; absence remains unknown. */
  collection?: GraphCollection;
}
export interface E2eInput {
  account: string;
  configured: FlowGraph;
  services: ServiceSnapshot | null;
  network: NetworkObservation[];
  /** Pass the batch even when every category failed and network is empty. */
  networkCoverage?: Pick<NetworkBatch, 'failedCategories' | 'cappedCategories' | 'errors'> & Partial<Pick<NetworkBatch, 'status' | 'windowQuality'>>;
}
export interface E2eGraph {
  nodes: E2eNode[];
  edges: E2eEdge[];
  coverage: {
    service: GraphCollection;
    network: {
      /** Complete describes only the supplied query batch, never all traffic. */
      status: 'unknown' | 'complete' | 'partial' | 'unsupported';
      successfulCategories: NfmCategory[];
      failedCategories: NfmCategory[] | null;
      cappedCategories: NfmCategory[];
      errors: Partial<Record<NfmCategory, NetworkReason>> | null;
      windowQuality: NetworkBatch['windowQuality'];
    };
  };
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
  coverage: E2eGraph['coverage'];
}
