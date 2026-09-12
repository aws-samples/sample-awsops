import type { DxConnectionRow } from './dx';

/** Shared by the server summary and client assessments; placeholders never identify a site. */
export function knownDxLocation(value: string | undefined): string | undefined {
  const location = value?.trim();
  return location && location !== '?' && location.toLowerCase() !== 'unknown' ? location : undefined;
}

const NOT_DEPLOYED = new Set(['deleted', 'rejected', 'ordering', 'requested', 'pending']);
export const isDeployedDxConnection = (c: DxConnectionRow): boolean => !NOT_DEPLOYED.has(c.state);

/** Deployed connections, including hosted. Inactive inventory cannot certify an available site.
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
