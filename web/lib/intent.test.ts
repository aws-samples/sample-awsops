import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  listIntents,
  validatePredicate,
  promoteIntent,
  rejectIntent,
  insertCandidate,
  proposeCandidates,
  INVARIANT_KINDS,
} from './intent';

// Mirror the diagnosis.test.ts mock idiom: a single query spy whose return is shaped by the SQL.
const query = vi.fn(async (sql: string = '') => {
  if (sql.includes('SELECT') && sql.includes('inventory_resources'))
    return { rows: [{ resource_type: 'rds' }, { resource_type: 'elasticache' }, { resource_type: 's3' }] };
  if (sql.includes('SELECT') && sql.includes('architecture_intent') && sql.includes('md5'))
    return { rows: [] }; // dedup probe: nothing pre-existing
  if (sql.includes('SELECT') && sql.includes('FROM architecture_intent'))
    return { rows: [{ id: 1, kind: 'private_only', target: 'rds', status: 'active' }] };
  if (sql.includes('INSERT INTO architecture_intent')) return { rows: [{ id: 42 }] };
  if (sql.includes('UPDATE architecture_intent')) return { rows: [{ id: 7 }] };
  return { rows: [] };
});

vi.mock('./db', () => ({
  getPool: () => ({ query: (...a: unknown[]) => query(...(a as [string, unknown[]])) }),
}));

beforeEach(() => query.mockClear());

describe('validatePredicate (mirrors invariants.py KINDS + per-kind required params)', () => {
  it('exposes the same kind enum as the Python evaluator', () => {
    expect(INVARIANT_KINDS).toEqual([
      'private_only',
      'no_public_ingress',
      'forbidden_edge',
      'expected_edge',
      'max_error_rate',
      'encryption_required',
    ]);
  });

  it('rejects an unknown kind', () => {
    expect(validatePredicate({ kind: 'rm -rf', params: {} })).toBeNull();
  });

  it('rejects an edge kind missing from/to params', () => {
    expect(validatePredicate({ kind: 'expected_edge', params: { from: 'api' } })).toBeNull();
    expect(validatePredicate({ kind: 'forbidden_edge', params: {} })).toBeNull();
  });

  it('keeps a well-formed edge candidate', () => {
    const c = validatePredicate({ kind: 'expected_edge', params: { from: 'api', to: 'rds' }, severity: 'warning' });
    expect(c?.kind).toBe('expected_edge');
    expect(c?.params).toEqual({ from: 'api', to: 'rds' });
  });

  it('rejects a target kind without a target', () => {
    expect(validatePredicate({ kind: 'private_only', params: {} })).toBeNull();
  });

  it('keeps a well-formed target candidate and normalizes severity default', () => {
    const c = validatePredicate({ kind: 'private_only', target: 'rds' });
    expect(c?.kind).toBe('private_only');
    expect(c?.target).toBe('rds');
    expect(c?.severity).toBe('warning');
  });

  it('rejects a bad severity', () => {
    expect(validatePredicate({ kind: 'private_only', target: 'rds', severity: 'fatal' })).toBeNull();
  });
});

describe('listIntents', () => {
  it('lists all when no status given', async () => {
    const rows = await listIntents();
    expect(rows[0].id).toBe(1);
    const [sql, args] = query.mock.calls.at(-1) as [string, unknown[]];
    expect(sql).toContain('FROM architecture_intent');
    expect(args).toEqual([]);
  });

  it('filters by status when given', async () => {
    await listIntents('draft');
    const [sql, args] = query.mock.calls.at(-1) as [string, unknown[]];
    expect(sql).toContain('WHERE status = $1');
    expect(args).toEqual(['draft']);
  });
});

describe('promoteIntent (admin path)', () => {
  it('flips a valid draft to active + human_authored', async () => {
    const out = await promoteIntent(7, { kind: 'private_only', target: 'rds', severity: 'critical' }, 'admin@x');
    expect(out).not.toBeNull();
    const [sql, args] = query.mock.calls.at(-1) as [string, unknown[]];
    expect(sql).toContain('UPDATE architecture_intent');
    expect(sql).toContain("status = 'active'");
    expect(sql).toContain("provenance = 'human_authored'");
    expect(sql).toContain("status = 'draft'"); // only promote drafts
    expect(args).toContain(7);
  });

  it('refuses to promote an invalid predicate (no UPDATE issued)', async () => {
    const out = await promoteIntent(7, { kind: 'bogus' }, 'admin@x');
    expect(out).toBeNull();
    expect(query.mock.calls.some(([s]) => String(s).includes('UPDATE'))).toBe(false);
  });
});

describe('rejectIntent', () => {
  it('sets status rejected', async () => {
    await rejectIntent(7);
    const [sql, args] = query.mock.calls.at(-1) as [string, unknown[]];
    expect(sql).toContain('UPDATE architecture_intent');
    expect(sql).toContain("status = 'rejected'");
    expect(args).toEqual([7]);
  });
});

describe('insertCandidate', () => {
  it('inserts a draft / ai_proposed row', async () => {
    const id = await insertCandidate({ kind: 'private_only', target: 'rds', params: {}, severity: 'warning' }, 'sys');
    expect(id).toBe(42);
    const [sql, args] = query.mock.calls.at(-1) as [string, unknown[]];
    expect(sql).toContain('INSERT INTO architecture_intent');
    expect(sql).toContain("'draft'");
    expect(sql).toContain("'ai_proposed'");
    expect(args).toContain('sys');
  });
});

describe('proposeCandidates (deterministic, no LLM)', () => {
  it('reads inventory and inserts draft candidates for private_only + encryption_required', async () => {
    const out = await proposeCandidates('admin@x');
    // rds + elasticache are eligible types here (s3 is not); 2 candidates each.
    expect(out.length).toBe(4);
    const kinds = out.map((c) => c.kind).sort();
    expect(kinds).toEqual(['encryption_required', 'encryption_required', 'private_only', 'private_only']);
    const inserts = query.mock.calls.filter(([s]) => String(s).includes('INSERT INTO architecture_intent'));
    expect(inserts.length).toBe(4);
  });

  it('is idempotent: skips a candidate that already exists as active/draft', async () => {
    query.mockImplementation(async (sql: string = '') => {
      if (sql.includes('inventory_resources')) return { rows: [{ resource_type: 'rds' }] };
      // dedup probe finds an existing (kind,target,params) → skip insert
      if (sql.includes('architecture_intent') && sql.includes('md5')) return { rows: [{ id: 1 }] };
      if (sql.includes('INSERT')) return { rows: [{ id: 99 }] };
      return { rows: [] };
    });
    const out = await proposeCandidates('admin@x');
    expect(out.length).toBe(0);
    expect(query.mock.calls.some(([s]) => String(s).includes('INSERT'))).toBe(false);
  });
});
