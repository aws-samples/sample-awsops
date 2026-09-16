/** Configuration observations only. Shared TGW attachments do not establish reachability. */
export type VpcConnectivity = {
  /** accountId is the collecting/credential account; ownerId is disclosure only. */
  source: { vpcId: string; accountId: string; ownerId: string | null; region: string; name?: string; cidr?: string };
  checkedAt: string;
  peerings: Array<{
    id: string; state: string;
    peer: { vpcId: string | null; accountId: string | null; region: string | null; cidr: string | null };
  }>;
  transitGateways: Array<{
    id: string; attachmentId: string; state: string; routeTableId: string | null; associationState: string | null;
    peers: Array<{
      vpcId: string; accountId: string | null; state: string;
      attachmentId: string; routeTableId: string | null; associationState: string | null;
    }>;
  }>;
  /** Structural visibility limits may be cached, but cannot certify absence. */
  limitations: Array<'shared-vpc' | 'owner-unknown' | 'shared-tgw'>;
  /** Failed, truncated, invalid or conflicting reads; never cached. */
  incompleteSources: string[];
};
