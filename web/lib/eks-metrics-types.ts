// Shared response types only; safe to import from client components.
export type EksMetricStatus = 'ok' | 'no-data' | 'denied' | 'unavailable' | 'partial';
export type EksMetricValues = Record<string, number | null>;
export interface EksMetricSourceOutcome {
  status: EksMetricStatus;
  /** Fixed, sanitized explanation. Never an SDK exception or CloudWatch message. */
  reason?: string;
}
export interface EksDiagnosisMetrics {
  controlPlane: EksMetricValues;
  cluster: EksMetricValues;
  nodes: Record<string, EksMetricValues>;
  sources: Record<'controlPlane' | 'cluster' | 'nodes', EksMetricSourceOutcome>;
}
export interface EksDiagnosisMetricsResponse extends EksDiagnosisMetrics {
  range: number;
  /** Resolved account; the host is normalized to "self". */
  accountId: string;
  region: string;
}
