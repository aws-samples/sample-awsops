import type { DxConnectionRow } from './dx';

/** Shared by the server summary and client assessments; placeholders never identify a site. */
export function knownDxLocation(value: string | undefined): string | undefined {
  const location = value?.trim();
  return location && location !== '?' && location.toLowerCase() !== 'unknown' ? location : undefined;
}

// Unknown, missing and future states cannot establish a deployed connection.
export const isDeployedDxConnection = (c: Pick<DxConnectionRow, 'state'>): boolean =>
  c.state === 'available' || c.state === 'down';

/** Lifecycle/unknown metadata alone is not evidence of a connection failure. */
export const hasDxDownEvidence = (c: Pick<DxConnectionRow, 'state' | 'stateMetricMin'>): boolean =>
  c.state === 'down' || c.stateMetricMin === 0;

export type DxConnectionEvidence = 'up' | 'down' | 'unknown' | 'unassessed' | 'unassessed-down';

/** An affirmative up needs deployed metadata AND an up metric; down=false is not proof. */
export function classifyDxConnection(c: DxConnectionRow): DxConnectionEvidence {
  if (!isDeployedDxConnection(c)) return c.stateMetricMin === 0 ? 'unassessed-down' : 'unassessed';
  if (hasDxDownEvidence(c) || c.down) return 'down';
  return c.stateMetricMin === 1 ? 'up' : 'unknown';
}

/** One scope for API down totals, the KPI and the deployed-health checklist.
 * A metric zero on an excluded row remains a period observation, not a deployed failure. */
export function summarizeDxConnectionHealth(connections: DxConnectionRow[]) {
  const coverage = {
    total: connections.length, assessed: 0, excluded: 0, unknown: 0, down: 0,
    excludedObservedDown: 0,
  };
  for (const c of connections) {
    const evidence = classifyDxConnection(c);
    if (evidence === 'unassessed' || evidence === 'unassessed-down') {
      coverage.excluded++;
      if (evidence === 'unassessed-down') coverage.excludedObservedDown++;
      continue;
    }
    coverage.assessed++;
    if (evidence === 'down') coverage.down++;
    else if (evidence === 'unknown') coverage.unknown++;
  }
  return coverage;
}

/** Deployed connections, including hosted. Excluded states cannot certify a deployed site.
 * SLA eligibility is a separate owned-only scope. */
export function summarizeDxLocations(connections: DxConnectionRow[]) {
  const groups = new Map<string, { location: string; region: string; connections: number; bandwidthBps: number }>();
  const sites = new Set<string>();
  let unknownConnections = 0;
  let excludedConnections = 0;
  for (const c of connections) {
    if (!isDeployedDxConnection(c)) { excludedConnections++; continue; }
    const location = knownDxLocation(c.location);
    if (!location) { unknownConnections++; continue; }
    sites.add(location);
    const key = JSON.stringify([location, c.region]);
    const group = groups.get(key) ?? { location, region: c.region, connections: 0, bandwidthBps: 0 };
    group.connections++;
    group.bandwidthBps += c.bandwidthBps;
    groups.set(key, group);
  }
  return {
    locations: [...groups.values()].sort((a, b) => b.connections - a.connections),
    knownLocations: sites.size, unknownConnections, excludedConnections,
    assessedConnections: connections.length - excludedConnections,
    singleLocation: sites.size === 1 && unknownConnections === 0,
  };
}
