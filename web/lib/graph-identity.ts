// Storage scope comes from inventory/account selection, never telemetry ownership claims.
export interface GraphSelection {
  status: 'resolved' | 'not_found' | 'ambiguous';
  requested_id: string;
  resolved_id?: string;
  account_id?: string;
  candidate_ids?: string[];
  candidates_truncated?: boolean;
}

export function infraNodeId(kind: string, resourceId: string, account: string, region?: string): string {
  return region ? `${kind}:@${account}:${region}:${resourceId}` : `${kind}:${resourceId}`;
}

// Read-time wrapping also isolates legacy saved IDs in an account union.
export function unionNodeId(account: string, id: string): string {
  return `@${account}/${id}`;
}

export function splitUnionNodeId(id: string): { account: string; id: string } | null {
  const match = /^@(self|\d{12})\/(.+)$/.exec(id);
  return match ? { account: match[1], id: match[2] } : null;
}
