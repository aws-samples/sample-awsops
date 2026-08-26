// web/lib/intent.ts
// ADR Plan-2 Intent Engine — BFF CRUD for the `architecture_intent` table + predicate validation.
//
// SAFETY / anti-fabrication (§8R3): the LLM never activates an invariant. Candidates are stored
// status='draft', provenance='ai_proposed'; only an ADMIN promotes a draft to 'active' (the only
// status the deterministic worker engine evaluates). The `kind` enum here MIRRORS the Python
// evaluator (scripts/v2/workers/diagnosis/invariants.py KINDS) exactly — adding a kind means adding
// it in BOTH places. Operator-supplied text is stored as DATA only; it is never echoed into a prompt.
//
// proposeCandidates() is DETERMINISTIC (no Bedrock): it reads Aurora `inventory_resources` and emits
// draft candidates. The LLM-based proposal lives in the worker (propose.py) as a fast-follow.
import { getPool } from './db';

// MIRROR of invariants.py KINDS (single source of truth shared with the Python evaluator).
export const INVARIANT_KINDS = [
  'private_only',
  'no_public_ingress',
  'forbidden_edge',
  'expected_edge',
  'max_error_rate',
  'encryption_required',
] as const;
export type InvariantKind = (typeof INVARIANT_KINDS)[number];

// Edge kinds require params.from + params.to; target kinds require a `target`.
const EDGE_KINDS: InvariantKind[] = ['forbidden_edge', 'expected_edge', 'max_error_rate'];
const TARGET_KINDS: InvariantKind[] = ['private_only', 'no_public_ingress', 'encryption_required'];
const SEVERITIES = ['info', 'warning', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface ArchitectureIntent {
  id: number;
  kind: InvariantKind;
  target: string | null;
  params: Record<string, unknown>;
  severity: Severity;
  status: 'draft' | 'active' | 'rejected';
  provenance: 'ai_proposed' | 'human_authored';
  topology_fingerprint: string | null;
  created_by: string;
  created_at: string;
}

// A normalized candidate (the shape we validate/insert).
export interface Candidate {
  kind: InvariantKind;
  target: string | null;
  params: Record<string, unknown>;
  severity: Severity;
  heuristic_risk?: boolean;
}

const COLS =
  'id, kind, target, params, severity, status, provenance, topology_fingerprint, created_by, created_at';

/**
 * Re-validate a candidate against the fixed predicate schema (mirror of propose.validate_candidate).
 * Returns a normalized Candidate or null. Pure — no IO.
 */
export function validatePredicate(c: unknown): Candidate | null {
  if (!c || typeof c !== 'object') return null;
  const obj = c as Record<string, unknown>;
  const kind = obj.kind as InvariantKind;
  if (!INVARIANT_KINDS.includes(kind)) return null;

  const rawParams = obj.params;
  if (rawParams != null && (typeof rawParams !== 'object' || Array.isArray(rawParams))) return null;
  const params = (rawParams as Record<string, unknown>) ?? {};

  if (EDGE_KINDS.includes(kind) && !(params.from && params.to)) return null;

  const target = (obj.target as string | undefined) ?? null;
  if (TARGET_KINDS.includes(kind) && !target) return null;

  const severity = (obj.severity as Severity) ?? 'warning';
  if (!SEVERITIES.includes(severity)) return null;

  const out: Candidate = { kind, target, params, severity };
  // carry the heuristic-risk flag through if present (param- or top-level)
  if (typeof obj.heuristic_risk === 'boolean') out.heuristic_risk = obj.heuristic_risk;
  return out;
}

export async function listIntents(status?: string): Promise<ArchitectureIntent[]> {
  const where = status ? 'WHERE status = $1' : '';
  const args = status ? [status] : [];
  const { rows } = await getPool().query(
    `SELECT ${COLS} FROM architecture_intent ${where} ORDER BY created_at DESC`,
    args,
  );
  return rows as ArchitectureIntent[];
}

/**
 * Admin path: validate the (possibly edited) predicate, then flip a DRAFT row to active +
 * human_authored. The WHERE clause guards status='draft' so a non-draft is a no-op. Returns the
 * promoted id, or null if the predicate is invalid (no UPDATE issued).
 */
export async function promoteIntent(
  id: number,
  edits: Record<string, unknown>,
  createdBy: string,
): Promise<number | null> {
  const v = validatePredicate(edits);
  if (!v) return null;
  const { rows } = await getPool().query(
    `UPDATE architecture_intent
       SET status = 'active', provenance = 'human_authored',
           kind = $2, target = $3, params = $4::jsonb, severity = $5, created_by = $6,
           last_validated_at = NOW()
     WHERE id = $1 AND status = 'draft'
     RETURNING id`,
    [id, v.kind, v.target, JSON.stringify(v.params), v.severity, createdBy],
  );
  return (rows[0]?.id as number) ?? null;
}

export async function rejectIntent(id: number): Promise<void> {
  await getPool().query(
    `UPDATE architecture_intent SET status = 'rejected' WHERE id = $1`,
    [id],
  );
}

/** Insert a draft candidate (status='draft', provenance='ai_proposed'). Returns the new id. */
export async function insertCandidate(c: Candidate, createdBy: string): Promise<number> {
  const params = { ...c.params } as Record<string, unknown>;
  // Persist the heuristic-risk flag inside params (the table has no dedicated column).
  if (c.heuristic_risk) params.heuristic_risk = true;
  const { rows } = await getPool().query(
    `INSERT INTO architecture_intent (kind, target, params, severity, status, provenance, created_by)
     VALUES ($1, $2, $3::jsonb, $4, 'draft', 'ai_proposed', $5)
     RETURNING id`,
    [c.kind, c.target, JSON.stringify(params), c.severity, createdBy],
  );
  return rows[0].id as number;
}

// Resource types for which a private_only + encryption_required candidate makes sense.
const ELIGIBLE_TYPES = new Set(['rds', 'elasticache', 'opensearch']);
const MAX_CANDIDATES = 20;

/** True if an identical (kind,target,params) intent already exists in active|draft (idempotency). */
async function candidateExists(c: Candidate): Promise<boolean> {
  const { rows } = await getPool().query(
    `SELECT id FROM architecture_intent
     WHERE kind = $1 AND target IS NOT DISTINCT FROM $2
       AND md5(params::text) = md5($3::jsonb::text)
       AND status IN ('active', 'draft')
     LIMIT 1`,
    [c.kind, c.target, JSON.stringify(c.params)],
  );
  return rows.length > 0;
}

/**
 * DETERMINISTIC candidate proposal (MVP, no LLM). Reads `inventory_resources` (account_id='self'),
 * and for each eligible data-store type (rds/elasticache/opensearch) emits a `private_only` and an
 * `encryption_required` draft. Idempotent: skips a candidate already present as active/draft.
 * Order is irrelevant (the UI orders by drift-risk). Returns the candidates actually inserted.
 */
export async function proposeCandidates(createdBy: string): Promise<Candidate[]> {
  const { rows } = await getPool().query(
    `SELECT DISTINCT resource_type FROM inventory_resources WHERE account_id = 'self'`,
    [],
  );
  const types = (rows as { resource_type: string }[])
    .map((r) => r.resource_type)
    .filter((t) => ELIGIBLE_TYPES.has(t));

  const drafts: Candidate[] = [];
  for (const t of types) {
    drafts.push({ kind: 'private_only', target: t, params: {}, severity: 'critical' });
    drafts.push({ kind: 'encryption_required', target: t, params: {}, severity: 'warning' });
  }

  const inserted: Candidate[] = [];
  for (const c of drafts.slice(0, MAX_CANDIDATES)) {
    if (await candidateExists(c)) continue;
    await insertCandidate(c, createdBy);
    inserted.push(c);
  }
  return inserted;
}
