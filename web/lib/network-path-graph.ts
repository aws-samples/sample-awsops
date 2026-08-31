// Pure builder: maps a Network Path Check run's candidates + steps (web/lib/network-path.ts's
// NetworkPathRunDetail — sourced from network_path_run_candidates/network_path_run_steps) into a
// PolicyGraphDto for the shared PolicyGraph canvas. No worker-side graph builder exists yet (the
// e7d7fd9a commit only brought in the shared DTO/canvas contract) — this is that missing piece for
// the UI side. Per the design spec, the graph is the PRIMARY result and the layer checklist
// (rendered directly from `steps`, unchanged) remains the textual source of truth; this module only
// feeds the graph, it never replaces the checklist data itself.
import { boundGraph, policyEdgeId, policyNodeId, type PolicyGraphDto, type PolicyGraphStatus } from './policy-graph';
import type { NetworkPathRunDetail } from './network-path';

const CAPS = { nodes: 120, edges: 180 };
const VALID_STATUS = new Set<PolicyGraphStatus>(['allowed', 'blocked', 'unknown', 'not_run', 'not_applicable']);

function asStatus(v: string | null | undefined): PolicyGraphStatus {
  return v && VALID_STATUS.has(v as PolicyGraphStatus) ? (v as PolicyGraphStatus) : 'unknown';
}

export interface NetworkPathGraphResult {
  graph: PolicyGraphDto;
  /** Best-effort "currently executing" edge ids for an in-progress run — the first `not_run` step
   *  ordinal within each still-in-progress candidate (candidate.status == null). Empty once the run
   *  is terminal (every candidate has a final status), since nothing is "running" anymore. */
  runningIds: string[];
}

/**
 * Builds one graph per run: a shared `source` node fans out to each candidate's ordered step chain
 * (by `ordinal`), converging into a shared `destination` node. Every node/edge in a candidate's
 * chain is tagged with `pathIds: [candidate_id]` so `boundGraph`'s cluster admission treats each
 * candidate atomically (see policy-graph.ts) — a candidate is either shown whole or, if the graph
 * cap is exceeded, dropped whole (never a partial, misleadingly-plausible slice).
 */
export function buildNetworkPathGraph(run: NetworkPathRunDetail, now: () => string = () => new Date().toISOString()): NetworkPathGraphResult {
  const sourceId = policyNodeId('endpoint', 'source');
  const destId = policyNodeId('endpoint', 'destination');
  const terminal = run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled';

  const nodes: { id: string; kind: string; label: string; status: PolicyGraphStatus; pathIds?: string[] }[] = [
    { id: sourceId, kind: 'endpoint', label: 'source', status: 'not_applicable' },
    { id: destId, kind: 'endpoint', label: 'destination', status: 'not_applicable' },
  ];
  const edges: { id: string; source: string; target: string; relation: string; status: PolicyGraphStatus; label?: string; pathIds?: string[] }[] = [];
  const runningIds: string[] = [];

  const byCandidate = new Map<string, typeof run.steps>();
  for (const s of run.steps) {
    const list = byCandidate.get(s.candidate_id) ?? [];
    list.push(s);
    byCandidate.set(s.candidate_id, list);
  }

  for (const candidate of run.candidates) {
    const steps = (byCandidate.get(candidate.candidate_id) ?? []).slice().sort((a, b) => a.ordinal - b.ordinal);
    let prevId = sourceId;
    let firstNotRunFound = false;
    for (const step of steps) {
      const nodeId = policyNodeId('step', `${step.candidate_id}:${step.ordinal}`);
      const status = asStatus(step.status);
      nodes.push({
        id: nodeId, kind: step.layer, label: `${step.layer}: ${step.resource ?? step.summary ?? '?'}`,
        status, pathIds: [candidate.candidate_id],
      });
      const edgeId = policyEdgeId(prevId, nodeId);
      edges.push({ id: edgeId, source: prevId, target: nodeId, relation: step.layer, status, label: step.summary || undefined, pathIds: [candidate.candidate_id] });
      if (!terminal && !candidate.status && status === 'not_run' && !firstNotRunFound) {
        firstNotRunFound = true;
        runningIds.push(edgeId);
      }
      prevId = nodeId;
    }
    const finalEdgeId = policyEdgeId(prevId, destId, candidate.candidate_id);
    edges.push({
      id: finalEdgeId, source: prevId, target: destId, relation: 'candidate', status: asStatus(candidate.status),
      pathIds: [candidate.candidate_id],
    });
  }

  const graph = boundGraph({ version: 1, capturedAt: now(), nodes, edges }, CAPS);
  return { graph, runningIds };
}
