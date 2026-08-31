import { describe, it, expect } from 'vitest';
import { buildSgUsageGraph, buildSgRuleGraph } from './sg-usage-graph';
import type { SgUsageRow, SgHitsResult, SgRule } from './sg-analysis';
import type { RuleRow } from './sg-rules';

const rule = (over: Partial<SgRule> = {}): SgRule => ({
  direction: 'ingress', protocol: 'tcp', fromPort: 443, toPort: 443, portRange: '443',
  peer: 'sg-peer1', peerKind: 'sg', peerLabel: 'sg-peer1 (peer-name)', description: null, open: false,
  ...over,
});

const row = (over: Partial<SgUsageRow> = {}): SgUsageRow => ({
  id: 'sg-abc123', name: 'web-sg', description: '', region: 'ap-northeast-2', vpcId: 'vpc-1',
  vpcLabel: 'vpc-1', isDefault: false, eniCount: 2,
  attachedKinds: [{ kind: 'ec2', count: 2 }],
  referencedBy: ['sg-other (other-name)'],
  ingressRules: 1, egressRules: 0, openIngress: 0, unused: false,
  rules: [rule()],
  ...over,
});

describe('buildSgUsageGraph', () => {
  it('includes the center SG node and attachment/reference structure', () => {
    const g = buildSgUsageGraph(row(), null, () => '2026-08-19T00:00:00.000Z');
    expect(g.nodes.some((n) => n.id === 'sg:sg-abc123')).toBe(true);
    expect(g.nodes.some((n) => n.id === 'eni-kind:sg-abc123:ec2')).toBe(true);
    expect(g.nodes.some((n) => n.id === 'sg:sg-peer1')).toBe(true);
    expect(g.nodes.some((n) => n.id === 'sg:sg-other')).toBe(true);
    expect(g.edges.some((e) => e.relation === 'attached')).toBe(true);
    expect(g.edges.some((e) => e.relation === 'references')).toBe(true);
  });

  it('never duplicates a node id when a peer is both a rule reference and a referencedBy entry', () => {
    const r = row({ referencedBy: ['sg-peer1 (peer-name)'] });
    const g = buildSgUsageGraph(r);
    const peerNodes = g.nodes.filter((n) => n.id === 'sg:sg-peer1');
    expect(peerNodes).toHaveLength(1);
  });

  it('folds in observed traffic peers with ACCEPT/REJECT mapped to allowed/blocked', () => {
    const hits: SgHitsResult = {
      source: 'flowlogs', note: null, ruleHits: [], idleIngressRules: 0,
      peers: [
        { ip: '10.0.0.5', label: 'EC2: i-1', port: '443', action: 'ACCEPT', count: 5, bytes: 100 },
        { ip: '10.0.0.9', label: null, port: '22', action: 'REJECT', count: 1, bytes: 40 },
      ],
      rangeSec: 3600,
    };
    const g = buildSgUsageGraph(row(), hits);
    const accepted = g.nodes.find((n) => n.id === 'peer:10.0.0.5');
    const rejected = g.nodes.find((n) => n.id === 'peer:10.0.0.9');
    expect(accepted?.status).toBe('allowed');
    expect(rejected?.status).toBe('blocked');
  });

  it('returns a valid bounded PolicyGraphDto (version/capturedAt/truncated contract)', () => {
    const g = buildSgUsageGraph(row());
    expect(g.version).toBe(1);
    expect(typeof g.capturedAt).toBe('string');
    expect(g.truncated).toBe(false);
    expect(g.pathTruncated).toBe(false);
  });
});

const ruleRow = (over: Partial<RuleRow> = {}): RuleRow => ({
  account_id: '123456789012', region: 'ap-northeast-2', rule_id: 'sgr-1', group_id: 'sg-1',
  is_egress: false, protocol: 'tcp', from_port: 443, to_port: 443, peer_kind: 'cidr', peer_value: '10.0.0.0/16',
  description: null, compatible_match_count: 3, overlap_match_count: 0, last_observed_at: null,
  status: 'observed_compatible',
  ...over,
});

describe('buildSgRuleGraph', () => {
  it('builds a peer -> SG -> ENI chain for an ingress rule', () => {
    const g = buildSgRuleGraph(ruleRow(), () => '2026-08-19T00:00:00.000Z');
    expect(g.nodes.some((n) => n.id === 'sg:sg-1')).toBe(true);
    expect(g.nodes.some((n) => n.id === 'eni-kind:sg-1:*')).toBe(true);
    expect(g.nodes.some((n) => n.id === 'peer:10.0.0.0/16')).toBe(true);
    const ingressEdge = g.edges.find((e) => e.relation === 'ingress');
    expect(ingressEdge?.source).toBe('peer:10.0.0.0/16');
    expect(ingressEdge?.target).toBe('sg:sg-1');
    expect(ingressEdge?.status).toBe('allowed');
  });

  it('maps not_configured to not_applicable and no_observed_evidence to not_run', () => {
    const notConfigured = buildSgRuleGraph(ruleRow({ status: 'not_configured' }));
    expect(notConfigured.edges.find((e) => e.relation === 'ingress')?.status).toBe('not_applicable');
    const noEvidence = buildSgRuleGraph(ruleRow({ status: 'no_observed_evidence' }));
    expect(noEvidence.edges.find((e) => e.relation === 'ingress')?.status).toBe('not_run');
  });

  it('directs the edge SG -> peer for an egress rule', () => {
    const g = buildSgRuleGraph(ruleRow({ is_egress: true }));
    const egressEdge = g.edges.find((e) => e.relation === 'egress');
    expect(egressEdge?.source).toBe('sg:sg-1');
    expect(egressEdge?.target).toBe('peer:10.0.0.0/16');
  });
});
