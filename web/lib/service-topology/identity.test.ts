import { describe, expect, it } from 'vitest';
import { buildEntityIndex, resolveEndpoint } from './identity';
import { qualifyEvidence } from './evidence';
import type { Binding, EndpointClaim, SourceEvidence } from './types';

const scope = { account: '111111111111', region: 'us-east-1', vpc: 'vpc-a' };
const window = { start: 1000, end: 2000 };
const evidence: SourceEvidence = {
  id: 'eks/1',
  ...scope,
  status: 'ok',
  complete: true,
  stale: false,
  retained: false,
  capturedAt: 2000,
  window,
};
const binding: Binding = {
  ...scope,
  ip: 'fd00::1',
  kind: 'pod',
  nativeId: 'pod-uid',
  authority: 'cluster-arn',
  label: 'orders',
  evidence,
  confidence: 'observed',
  window,
};
const claim: EndpointClaim = { ...scope, ip: 'fd00:0:0:0:0:0:0:1', window };
const lookup = (bindings: Binding[], vetoes: SourceEvidence[] = [], c = claim) =>
  resolveEndpoint(c, buildEntityIndex(bindings, vetoes));

describe('scoped endpoint arbitration', () => {
  it('resolves the same Pod in ten observations without a load balancer', () => {
    const index = buildEntityIndex([binding], []);
    const results = Array.from({ length: 10 }, () => resolveEndpoint(claim, index));
    expect(results.every((r) => r.status === 'matched')).toBe(true);
    expect(new Set(results.map((r) => r.entityId)).size).toBe(1);
  });
  it('keeps a second UID or an unknown overlapping owner read as a veto', () => {
    expect(lookup([binding, { ...binding, nativeId: 'replacement' }]).status).toBe('ambiguous');
    const incomplete = { ...evidence, id: 'other', complete: false, vpc: null };
    expect(lookup([binding], [incomplete]).status).toBe('ambiguous');
    expect(lookup([binding], [{ ...incomplete, region: 'eu-west-1' }]).status).toBe('matched');
  });
  it('distinguishes old ownership, unqualified source state and inferred placement', () => {
    expect(lookup([{ ...binding, window: { start: 2001, end: 3000 } }]).status).not.toBe('matched');
    expect(lookup([{ ...binding, confidence: 'inferred' }]).status).toBe('context');
    expect(lookup([{ ...binding, evidence: { ...evidence, retained: true } }]).status).not.toBe('matched');
    expect(qualifyEvidence({ ...evidence, complete: undefined }, scope, window)).not.toBe('qualified');
  });
});

it('groups resolved endpoints while retaining the original observed pairs and row references', async () => {
  const { projectPeers } = await import('./project');
  const remote = { ...binding, ip: '10.0.2.1', nativeId: 'pod-b' };
  const rows = Array.from({ length: 10 }, (_, n) => ({
    sourceId: 'monitor',
    id: String(n),
    local: claim,
    remote: { ...claim, ip: remote.ip },
  }));
  const view = projectPeers(rows, [binding, remote], []);
  expect(view.entities.size).toBe(2);
  expect(view.peers.size).toBe(1);
  expect([...view.peers.values()][0].size).toBe(10);
  expect(view.rows).toHaveLength(10);
});

it('projects 10,000 peer observations across 2,000 replicas without losing their evidence', async () => {
  const { projectPeers } = await import('./project');
  const bindings = Array.from({ length: 2000 }, (_, i) => ({
    ...binding,
    ip: '10.' + Math.floor(i / 250) + '.0.' + ((i % 250) + 1),
    nativeId: 'pod-' + i,
    label: 'service-' + (i % 100),
  }));
  const rows = Array.from({ length: 10000 }, (_, i) => ({
    id: String(i),
    sourceId: 'fixture',
    local: { ...claim, ip: bindings[i % 2000].ip },
    remote: { ...claim, ip: bindings[(i + 1) % 2000].ip },
  }));
  const start = performance.now();
  const graph = projectPeers(rows, bindings, []);
  console.info(
    'Service topology fixture: 100 services / 2,000 replicas / 10,000 rows in',
    Math.round(performance.now() - start),
    'ms',
  );
  expect(graph.entities.size).toBe(2000);
  expect(graph.peers.size).toBe(2000);
  expect(graph.rows).toHaveLength(10000);
});
