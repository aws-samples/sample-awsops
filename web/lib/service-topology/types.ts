// Times are UTC epoch milliseconds. An address binding must cover the whole observed interval.
export interface TimeWindow {
  start: number;
  end: number;
}
export interface ScopeDomain {
  account: string | null;
  region: string | null;
  vpc: string | null;
}
export interface SourceEvidence extends ScopeDomain {
  id: string;
  status: 'ok' | 'empty' | 'partial' | 'unavailable' | 'error' | 'unknown';
  complete?: boolean;
  stale: boolean;
  retained: boolean;
  capturedAt: number | null;
  window: TimeWindow | null;
}
export interface EndpointClaim extends ScopeDomain {
  ip: string;
  window: TimeWindow | null;
}
export interface Binding extends EndpointClaim {
  kind: 'pod' | 'task' | 'instance' | 'resource';
  nativeId: string;
  authority: string; // cluster ARN or other trusted inventory authority
  label: string;
  evidence: SourceEvidence;
  confidence: 'observed' | 'inferred' | 'context';
}
export interface IdentityResolution {
  status: 'matched' | 'context' | 'ambiguous' | 'unmatched' | 'unsupported';
  entityId: string | null;
  reason: string | null;
  candidateIds: string[];
  evidenceIds: string[];
}
