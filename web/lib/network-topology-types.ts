// Client-safe types for the cross-account network topology projection
// (lib/network-topology.ts builds it; app/api/network-topology serves it).

export type NetKind = 'account' | 'region' | 'vpc' | 'az' | 'subnet' | 'tgw' | 'external'
  | 'igw' | 'nat' | 'vpce' | 'ec2' | 'alb' | 'nlb' | 'rds' | 'lambda' | 'more';
export type SubnetTier = 'public' | 'private' | 'unknown';

export interface NetNode {
  id: string; kind: NetKind; parent: string | null; label: string; sub?: string;
  accountId: string; region: string; resourceId?: string; tier?: SubnetTier;
  state?: string; count?: number; vpcKey?: string; outOfScope?: boolean;
}

/** Configuration relationships only; an edge never certifies routing or reachability. */
export interface NetEdge {
  id: string; kind: 'tgw' | 'peering'; source: string; target: string;
  recordId: string; crossAccount: boolean;
}

export interface NetworkTopology {
  level: 'fleet' | 'detail'; nodes: NetNode[]; edges: NetEdge[];
  omitted: { inactive: number; conflicting: number; resourcesCapped: number };
  truncated: boolean; capturedAt: string | null;
}

export interface NetRow {
  resource_type: string; account_id: string; region: string | null;
  resource_id: string; data: Record<string, unknown>; captured_at?: string | null;
}

export interface NetworkSelection { accounts: string[] | '__all__'; vpcs: string[] }

export const MAX_DETAIL_VPCS = 4;
export const MAX_TILES_PER_SUBNET = 12;
