import { describe, it, expect, vi } from 'vitest';
import { traversalSql, downstream, upstream, blastRadius, FANOUT_CAP, MAX_DEPTH } from './graph-query';

describe('graph-query traversal SQL', () => {
  it('uses the PG17 CYCLE clause (no manual visited array)', () => {
    expect(traversalSql('down')).toContain('CYCLE node SET is_cycle USING path');
  });
  it('down follows source→target; up reverses', () => {
    const d = traversalSql('down');
    expect(d).toContain('e.source = w.node');
    expect(d).toContain('SELECT e.target');
    const u = traversalSql('up');
    expect(u).toContain('e.target = w.node');
    expect(u).toContain('SELECT e.source');
  });
  it('is class-scoped ($2) and depth-bounded ($3)', () => {
    const d = traversalSql('down');
    expect(d).toContain('e.class = $2');
    expect(d).toContain('w.depth < $3');
  });
  it('caps per-hop fan-out via a LATERAL LIMIT (hub guard, not total breadth)', () => {
    const d = traversalSql('down');
    expect(d).toContain('JOIN LATERAL');
    expect(d).toContain(`LIMIT ${FANOUT_CAP}`);
  });
  it('does not expand from a default security group unless it is the start node', () => {
    const d = traversalSql('down');
    expect(d).toContain("(n.meta ->> 'default') = 'true'");
    expect(d).toContain('w.depth = 0 OR NOT EXISTS');
  });
});

describe('graph-query functions', () => {
  it('downstream defaults to class=flow + MAX_DEPTH', async () => {
    const query = vi.fn(() => Promise.resolve({ rows: [{ id: 'x', depth: 1 }] }));
    const r = await downstream({ query } as never, 'cf:D1');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('WITH RECURSIVE'), ['cf:D1', 'flow', MAX_DEPTH, 'self']);
    expect(r[0].id).toBe('x');
  });
  it('passes class + clamped depth from opts', async () => {
    const query = vi.fn(() => Promise.resolve({ rows: [] }));
    await downstream({ query } as never, 'alb:lb', { cls: 'infra', depth: 2 });
    expect(query).toHaveBeenCalledWith(expect.anything(), ['alb:lb', 'infra', 2, 'self']);
    await downstream({ query } as never, 'alb:lb', { cls: 'infra', depth: 999 });
    expect(query).toHaveBeenCalledWith(expect.anything(), ['alb:lb', 'infra', MAX_DEPTH, 'self']); // clamped
  });
  it('passes the account scope through to the traversal params', async () => {
    const query = vi.fn(() => Promise.resolve({ rows: [] }));
    await downstream({ query } as never, 'x', { cls: 'infra', depth: 2, account: '222233334444' });
    expect(query).toHaveBeenCalledWith(expect.anything(), ['x', 'infra', 2, '222233334444']);
  });
  it('blastRadius is the upstream traversal', () => {
    expect(blastRadius).toBe(upstream);
  });
});
