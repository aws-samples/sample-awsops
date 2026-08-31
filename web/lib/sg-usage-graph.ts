// Pure builder: maps the existing SG Usage data (web/lib/sg-analysis.ts — a live-AWS ENI/rule
// scan, independent of the SG Rules & Usage Aurora pipeline) into a PolicyGraphDto for the shared
// PolicyGraph canvas (web/components/graph/PolicyGraph.tsx). Never fetches anything itself — the
// Usage page (app/network/security-groups/usage/page.tsx) already holds the SgUsageRow (from
// GET /api/sg) and, once a row is selected, the SgHitsResult (from GET /api/sg?view=hits) — this
// module only reshapes that already-fetched data into nodes/edges.
//
// Graph content per the task brief: the selected SG's ENI attachments (aggregated by kind — the
// underlying /api/sg response only carries per-kind counts, not individual ENI ids) and mutual SG
// references (both directions: SGs this one references as a rule peer, and SGs that reference this
// one back). When traffic-hit data is available, observed peer IPs are added too, so the graph
// doubles as a compact "who talks to this SG" view alongside the Rules-detail graph's peer↔SG↔ENI
// framing.
import { boundGraph, policyEdgeId, policyNodeId, type PolicyGraphDto, type PolicyGraphNode, type PolicyGraphEdge, type PolicyGraphStatus } from './policy-graph';
import type { SgUsageRow, SgHitsResult } from './sg-analysis';
import type { RuleRow, RuleStatus } from './sg-rules';

const CAPS = { nodes: 60, edges: 90 };

/** Extracts the "sg-xxxxxxxx" id from a peerLabel/referencedBy display string like "sg-123 (name)". */
function extractSgId(label: string): { id: string; name: string | null } {
  const m = /^([^\s(]+)(?:\s+\(([^)]*)\))?$/.exec(label.trim());
  return { id: m?.[1] ?? label, name: m?.[2] ?? null };
}

/**
 * Builds a compact PolicyGraphDto for one selected SG: itself as the center node, its ENI
 * attachments (grouped by kind), the SGs it references (rule peer) and the SGs that reference it
 * back, and — when `hits` is supplied — the observed traffic peers from the hit-matching drilldown.
 * All relations here are structural/observational (not a resolved network-path run), so every edge
 * gets `status: 'allowed'` when the relation is confirmed to exist and `status: 'unknown'` for a
 * peer whose traffic disposition (ACCEPT/REJECT) isn't known — this graph never claims a firewall
 * decision, only "this SG is attached/referenced/talks-to X" facts already present in the caller's
 * already-fetched data.
 */
export function buildSgUsageGraph(
  row: SgUsageRow,
  hits: SgHitsResult | null = null,
  now: () => string = () => new Date().toISOString(),
): PolicyGraphDto {
  const nodes: PolicyGraphNode[] = [];
  const edges: PolicyGraphEdge[] = [];

  const centerId = policyNodeId('sg', row.id);
  nodes.push({
    id: centerId, kind: 'security_group', label: `${row.id}${row.name && row.name !== row.id ? ` (${row.name})` : ''}`,
    status: 'not_applicable', resourceId: row.id, scope: { accountId: 'self', region: row.region },
  });

  // ENI attachments, aggregated by resource kind (the /api/sg response only carries per-kind
  // counts — see file header).
  for (const k of row.attachedKinds) {
    const nid = policyNodeId('eni-kind', `${row.id}:${k.kind}`);
    nodes.push({ id: nid, kind: 'eni', label: `${k.kind} × ${k.count}`, status: 'not_applicable' });
    edges.push({
      id: policyEdgeId(centerId, nid), source: centerId, target: nid, relation: 'attached',
      status: 'allowed', label: 'attached',
    });
  }

  // Mutual SG references: this SG referencing another as a rule peer.
  const seenPeerSg = new Set<string>();
  for (const rule of row.rules) {
    if (rule.peerKind !== 'sg' || !rule.peer) continue;
    if (rule.peer === row.id || seenPeerSg.has(rule.peer)) continue;
    seenPeerSg.add(rule.peer);
    const nid = policyNodeId('sg', rule.peer);
    nodes.push({ id: nid, kind: 'security_group', label: rule.peerLabel || rule.peer, status: 'not_applicable', resourceId: rule.peer });
    edges.push({
      id: policyEdgeId(centerId, nid), source: centerId, target: nid, relation: 'references',
      status: 'allowed', label: rule.direction,
    });
  }

  // SGs that reference THIS one back (row.referencedBy: "sg-xxx (name)" labels).
  for (const label of row.referencedBy) {
    const { id, name } = extractSgId(label);
    if (id === row.id || seenPeerSg.has(id)) continue;
    const nid = policyNodeId('sg', id);
    if (!nodes.some((n) => n.id === nid)) {
      nodes.push({ id: nid, kind: 'security_group', label: name ? `${id} (${name})` : id, status: 'not_applicable', resourceId: id });
    }
    edges.push({
      id: policyEdgeId(nid, centerId), source: nid, target: centerId, relation: 'references',
      status: 'allowed', label: 'referenced_by',
    });
  }

  // Observed traffic peers (from the hit-matching drilldown), when supplied.
  if (hits) {
    for (const p of hits.peers) {
      const nid = policyNodeId('peer', p.ip);
      const status: PolicyGraphStatus = p.action === 'REJECT' ? 'blocked' : p.action === 'ACCEPT' ? 'allowed' : 'unknown';
      nodes.push({ id: nid, kind: 'peer', label: p.label ? `${p.ip} (${p.label})` : p.ip, status });
      edges.push({
        id: policyEdgeId(centerId, nid), source: centerId, target: nid, relation: 'traffic',
        status, label: p.port ? `:${p.port}` : undefined,
      });
    }
  }

  return boundGraph({ version: 1, capturedAt: now(), nodes, edges }, CAPS);
}

// A RuleStatus (the traffic-evidence classification computed by lib/sg-rules.ts's listRules) maps
// onto the small, fixed PolicyGraphStatus vocabulary at this builder boundary — the domain status
// values themselves are richer (observed_compatible vs. overlapping both mean "traffic seen", just
// with different attribution confidence) and stay visible via the caller's own status badge; this
// graph edge only needs the coarser allowed/unknown/not_run/not_applicable distinction.
const RULE_STATUS_TO_GRAPH: Record<RuleStatus, PolicyGraphStatus> = {
  observed_compatible: 'allowed',
  overlapping: 'allowed',
  no_observed_evidence: 'not_run',
  unassessable: 'unknown',
  not_configured: 'not_applicable',
};

/**
 * Builds a compact peer ↔ SG ↔ ENI PolicyGraphDto for one SG rule (the Rules screen's detail
 * drawer). `sg_rule_inventory` (web/lib/sg-rules.ts) carries the rule's SG id and peer, but not the
 * SG's individual ENI attachments — so the ENI side of the chain is a single structural placeholder
 * node ("attached ENIs") rather than real ENI ids; that's a real gap in the current schema, not a
 * simplification of the graph contract, and is called out in the network-security-graph work item.
 */
export function buildSgRuleGraph(rule: RuleRow, now: () => string = () => new Date().toISOString()): PolicyGraphDto {
  const nodes: PolicyGraphNode[] = [];
  const edges: PolicyGraphEdge[] = [];

  const sgId = policyNodeId('sg', rule.group_id);
  const eniId = policyNodeId('eni-kind', `${rule.group_id}:*`);
  const peerLabel = rule.peer_kind === 'sg' ? rule.peer_value
    : rule.peer_kind === 'pl' ? `${rule.peer_value} (prefix list)`
      : rule.peer_kind === 'internet' ? (rule.peer_value === '::/0' ? '::/0 (internet)' : '0.0.0.0/0 (internet)')
        : rule.peer_value;
  const peerId = policyNodeId(rule.peer_kind === 'sg' ? 'sg' : 'peer', rule.peer_value || 'unknown');
  const status = RULE_STATUS_TO_GRAPH[rule.status];

  nodes.push({ id: sgId, kind: 'security_group', label: rule.group_id, status: 'not_applicable', resourceId: rule.group_id, scope: { accountId: rule.account_id, region: rule.region } });
  nodes.push({ id: eniId, kind: 'eni', label: 'attached ENIs', status: 'not_applicable' });
  nodes.push({ id: peerId, kind: rule.peer_kind === 'sg' ? 'security_group' : 'peer', label: peerLabel, status: 'not_applicable' });

  edges.push({ id: policyEdgeId(sgId, eniId), source: sgId, target: eniId, relation: 'attached', status: 'allowed', label: 'attached' });
  const portLabel = rule.from_port == null ? rule.protocol : rule.from_port === rule.to_port ? `${rule.protocol}/${rule.from_port}` : `${rule.protocol}/${rule.from_port}-${rule.to_port}`;
  if (rule.is_egress) {
    edges.push({ id: policyEdgeId(sgId, peerId), source: sgId, target: peerId, relation: 'egress', status, label: portLabel });
  } else {
    edges.push({ id: policyEdgeId(peerId, sgId), source: peerId, target: sgId, relation: 'ingress', status, label: portLabel });
  }

  return boundGraph({ version: 1, capturedAt: now(), nodes, edges }, CAPS);
}
