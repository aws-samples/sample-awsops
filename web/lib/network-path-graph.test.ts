import { describe, it, expect } from 'vitest';
import { buildNetworkPathGraph } from './network-path-graph';
import type { NetworkPathRunDetail } from './network-path';

const baseRun = (over: Partial<NetworkPathRunDetail> = {}): NetworkPathRunDetail => ({
  id: 'run-1', check_id: 'chk-1', requested_by_sub: 'u-1',
  definition_snapshot: { source: {}, destination: {}, request: {} },
  status: 'running', phase: 'verify', overall_status: null, validation_bundle: null, worker_job_id: 'job-1',
  created_at: '2026-08-19T00:00:00Z', finished_at: null, error: null,
  candidates: [{ candidate_id: 'c1', candidate_kind: 'primary', status: null, first_blocker: null }],
  steps: [
    { candidate_id: 'c1', account_id: '123456789012', region: 'ap-northeast-2', ordinal: 0, layer: 'security_group', status: 'allowed', resource: 'sg-1', summary: 'ok', evidence: null, observed_at: null },
    { candidate_id: 'c1', account_id: '123456789012', region: 'ap-northeast-2', ordinal: 1, layer: 'nacl', status: 'not_run', resource: null, summary: '', evidence: null, observed_at: null },
  ],
  ...over,
});

describe('buildNetworkPathGraph', () => {
  it('chains source -> step(s) -> destination, tagged with the candidate id as pathIds', () => {
    const { graph } = buildNetworkPathGraph(baseRun(), () => '2026-08-19T00:00:00.000Z');
    expect(graph.nodes.some((n) => n.id === 'endpoint:source')).toBe(true);
    expect(graph.nodes.some((n) => n.id === 'endpoint:destination')).toBe(true);
    const sgStep = graph.nodes.find((n) => n.id === 'step:c1:0');
    expect(sgStep?.status).toBe('allowed');
    expect(sgStep?.pathIds).toEqual(['c1']);
  });

  it('reports the first not_run step of a still-in-progress candidate as running', () => {
    const { runningIds } = buildNetworkPathGraph(baseRun());
    expect(runningIds).toEqual([expect.stringContaining('step:c1:0->step:c1:1')]);
  });

  it('reports no running ids once the run is terminal', () => {
    const { runningIds } = buildNetworkPathGraph(baseRun({
      status: 'succeeded',
      candidates: [{ candidate_id: 'c1', candidate_kind: 'primary', status: 'allowed', first_blocker: null }],
    }));
    expect(runningIds).toEqual([]);
  });

  it('falls back unknown statuses to "unknown" rather than throwing', () => {
    const { graph } = buildNetworkPathGraph(baseRun({
      steps: [{ candidate_id: 'c1', account_id: 'a', region: 'r', ordinal: 0, layer: 'route', status: 'weird_value', resource: null, summary: '', evidence: null, observed_at: null }],
    }));
    const n = graph.nodes.find((x) => x.id === 'step:c1:0');
    expect(n?.status).toBe('unknown');
  });
});
