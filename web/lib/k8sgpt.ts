// web/lib/k8sgpt.ts
// ADR-035 H1–H2 AWSops-side substrate. K8sGPT runs DETERMINISTIC-ONLY (operator, out-of-band);
// AWSops reads the Result CRDs (P3-D STS path), adapts them (Rule 7), dedups+persists (Rule 11),
// and narrates them with the Container AgentCore agent (Haiku 4.5, ap-northeast-2) keeping the
// deterministic analyzer_result (FACT) structurally separate from llm_explanation (HYPOTHESIS, Rule 8).
//
// SAFETY: getDiagnosis returns {enabled:false} and performs NO cluster read / NO STS presign /
// NO AgentCore invoke unless K8SGPT_ENABLED === 'true'. A stale (> threshold) or down operator
// degrades gracefully (Rule 9) — returns whatever deterministic facts exist, marked stale, with
// NO narration error bubbling. AWSops NEVER writes to the cluster.
import { randomUUID } from 'crypto';
import { getPool } from '@/lib/db';
import { invokeAgent } from '@/lib/agentcore';
import { listK8sgptResults } from '@/lib/eks-incluster';
import { adaptResultList, type AnalyzerResult } from '@/lib/k8sgpt-adapter';
import { triageAndCreateOrLink, enqueueInitialStage } from '@/lib/incident';
import type { AlertEvent } from '@/lib/incident-normalize';

const STALE_MS = (parseInt(process.env.K8SGPT_STALE_MINUTES || '5', 10) || 5) * 60 * 1000; // Rule 9

function enabled(): boolean {
  return process.env.K8SGPT_ENABLED === 'true';
}

export interface DiagnosisFinding {
  analyzer_result: AnalyzerResult;          // Rule 8: FACT (deterministic, high confidence)
  llm_explanation: string | null;           // Rule 8: HYPOTHESIS (Haiku narration; null if none/dedup-cached)
  llm_model: string | null;
  first_seen: string | null;
  last_seen: string | null;
}
export interface DiagnosisResult {
  enabled: boolean;
  cluster: string;
  last_scan_timestamp: string | null;       // Rule 9 — exposed for staleness UI
  stale: boolean;                            // true ⇒ operator down/slow; facts may be old
  operator_detected: boolean;
  findings: DiagnosisFinding[];
}

const NARRATION_PROMPT =
  'You are the AWSops Container-section diagnostic narrator. You are given a DETERMINISTIC K8sGPT ' +
  'analyzer finding (analyzer kind, resource, error, details). Write ONE short plain-language ' +
  'hypothesis (2-3 sentences) of the likely cause and what to check next. This is a HYPOTHESIS, not ' +
  'a verified fact — do NOT restate the deterministic data as certain, do NOT invent resource names, ' +
  'do NOT propose auto-remediation. If unsure, say so.';

/** Narrate ONE finding via the Container agent (Haiku tier). Best-effort: returns null on any error
 *  (Rule 9 degrade — the deterministic fact still surfaces). The model NEVER mutates analyzer_result. */
async function narrate(cluster: string, r: AnalyzerResult): Promise<string | null> {
  try {
    const text = await invokeAgent({
      gateway: 'container',
      sessionId: randomUUID() + randomUUID().slice(0, 1), // >=33 chars
      systemPromptOverride: NARRATION_PROMPT,
      messages: [{ role: 'user', content:
        `cluster=${cluster}\nanalyzer=${r.analyzer}\nresource=${r.resourceName}\n` +
        `errors=${JSON.stringify(r.errors)}\ndetails=${r.details}\nparent=${r.parentObject}` }],
    });
    return text?.trim() || null;
  } catch {
    return null; // degrade-safe: hypothesis is supplementary; the fact already stands
  }
}

/** getDiagnosis — the single entry point used by the route. Gated, dedup'd (Rule 11), degrade-safe (Rule 9). */
export async function getDiagnosis(cluster: string): Promise<DiagnosisResult> {
  if (!enabled()) {
    return { enabled: false, cluster, last_scan_timestamp: null, stale: true, operator_detected: false, findings: [] };
  }

  // 1) Read the deterministic Result CRDs (P3-D STS path). Operator absent / unreachable ⇒ degrade.
  let crds: Awaited<ReturnType<typeof listK8sgptResults>> = [];
  let operatorDetected = true;
  try {
    crds = await listK8sgptResults(cluster);
  } catch {
    operatorDetected = false; // Rule 9: down/absent operator → degrade gracefully, no throw
  }
  const facts = adaptResultList(crds);

  // 2) Persist a scan run (last_scan_timestamp, Rule 9) — best-effort.
  const now = new Date().toISOString();
  await recordScanRun(cluster, now, facts.length, operatorDetected).catch(() => {});

  // 3) Dedup + persist findings, narrate ONLY new/changed fingerprints (Rule 11 — no re-narrate).
  const out: DiagnosisFinding[] = [];
  for (const f of facts) {
    const existing = await getFinding(cluster, f.fingerprint).catch(() => null);
    let narration = existing?.llm_explanation ?? null;
    let model = existing?.llm_model ?? null;
    if (!existing) {
      narration = await narrate(cluster, f);                 // first sighting → narrate once
      model = narration ? (process.env.K8SGPT_NARRATION_MODEL || 'haiku-4.5') : null;
    }
    const saved = await upsertFinding(cluster, f, narration, model, now).catch(() => null);
    out.push({
      analyzer_result: f,                                    // FACT (Rule 8 — never overwritten by LLM)
      llm_explanation: narration,                            // HYPOTHESIS (Rule 8 — separate field)
      llm_model: model,
      first_seen: saved?.first_seen ?? now,
      last_seen: saved?.last_seen ?? now,
    });
  }

  // 4) Staleness (Rule 9): the newest persisted scan older than STALE_MS ⇒ stale.
  const lastScan = await lastScanTimestamp(cluster).catch(() => null);
  const stale = !operatorDetected || (lastScan ? Date.now() - new Date(lastScan).getTime() > STALE_MS : true);
  return { enabled: true, cluster, last_scan_timestamp: lastScan, stale, operator_detected: operatorDetected, findings: out };
}

// --- DB helpers (degrade-safe; tables are migration v7, always-present) ---

interface FindingRow { llm_explanation: string | null; llm_model: string | null; first_seen: string; last_seen: string; }

async function getFinding(cluster: string, fingerprint: string): Promise<FindingRow | null> {
  if (!process.env.AURORA_ENDPOINT) return null;
  const { rows } = await getPool().query(
    `SELECT llm_explanation, llm_model, first_seen, last_seen
     FROM k8s_findings WHERE cluster = $1 AND fingerprint = $2`, [cluster, fingerprint]);
  return rows[0] ?? null;
}

async function upsertFinding(
  cluster: string, f: AnalyzerResult, narration: string | null, model: string | null, at: string,
): Promise<FindingRow | null> {
  if (!process.env.AURORA_ENDPOINT) return null;
  // first_seen kept on conflict; last_seen bumped. Narration only set when provided (dedup-preserving).
  const { rows } = await getPool().query(
    `INSERT INTO k8s_findings
       (id, cluster, namespace, kind, name, analyzer, error, details, parent_object,
        fingerprint, llm_explanation, llm_model, adapter_version, first_seen, last_seen)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)
     ON CONFLICT (cluster, fingerprint) DO UPDATE SET
       last_seen = EXCLUDED.last_seen,
       llm_explanation = COALESCE(k8s_findings.llm_explanation, EXCLUDED.llm_explanation),
       llm_model = COALESCE(k8s_findings.llm_model, EXCLUDED.llm_model)
     RETURNING llm_explanation, llm_model, first_seen, last_seen`,
    [randomUUID(), cluster, f.namespace, f.analyzer, f.resourceName, f.analyzer,
     JSON.stringify(f.errors), f.details, f.parentObject, f.fingerprint, narration, model,
     f.adapterVersion, at]);
  return rows[0] ?? null;
}

async function recordScanRun(cluster: string, at: string, findingCount: number, operatorDetected: boolean): Promise<void> {
  if (!process.env.AURORA_ENDPOINT) return;
  await getPool().query(
    `INSERT INTO k8s_scan_runs (id, cluster, scanned_at, finding_count, operator_detected)
     VALUES ($1,$2,$3,$4,$5)`, [randomUUID(), cluster, at, findingCount, operatorDetected]);
}

async function lastScanTimestamp(cluster: string): Promise<string | null> {
  if (!process.env.AURORA_ENDPOINT) return null;
  const { rows } = await getPool().query(
    `SELECT scanned_at FROM k8s_scan_runs WHERE cluster = $1 ORDER BY scanned_at DESC LIMIT 1`, [cluster]);
  return rows[0]?.scanned_at ? new Date(rows[0].scanned_at).toISOString() : null;
}

// --- H3a SEAM (ADR-035 Rule 4/6) — thin, twice-gated, NOT auto-invoked ---
//
// Turn a deterministic K8sGPT finding into an ADR-032 incident, which (when
// incident_lifecycle_enabled) drives correlation/RCA → ADR-034 write-back → ADR-029/036
// remediation PROPOSALS (catalog enabled=false, gated by remediation_enabled). NO auto-apply.
//
// GATED TWICE + NOT auto-called: returns {decision:'disabled'} unless BOTH K8SGPT_ENABLED and the
// incident lifecycle gate (INCIDENT_LIFECYCLE_ENABLED, enforced inside triageAndCreateOrLink) are on.
// The route does NOT call this; it is invoked only from an explicit, admin-initiated "raise incident"
// action (future H3a UI) so a finding never autonomously creates work. The seam carries ONLY
// deterministic facts (Rule 6/8) — the LLM hypothesis (llm_explanation) does NOT cross into the
// incident record. PROPOSAL only, never a cluster write (Rule 4).
export async function raiseIncidentFromFinding(cluster: string, f: AnalyzerResult): Promise<{ decision: string; incidentId?: string }> {
  if (!enabled()) return { decision: 'disabled' }; // gate #1: K8sGPT flag off → no seam, no incident
  // gate #2 (INCIDENT_LIFECYCLE_ENABLED) is enforced inside triageAndCreateOrLink → {decision:'disabled'}.
  const event: AlertEvent = {
    id: `k8sgpt:${cluster}:${f.fingerprint}`,
    source: 'generic',                    // ADR-032 trigger_source; K8sGPT is a sensor input
    alertName: `[K8sGPT/${cluster}] ${f.analyzer} ${f.resourceName}`,
    severity: 'warning',                  // deterministic finding default; UI may override at raise-time
    status: 'firing',
    message: f.errors.join('; '),         // deterministic FACT only; NO LLM hypothesis crosses the seam
    timestamp: new Date().toISOString(),
    labels: {},
    annotations: { details: f.details, parentObject: f.parentObject, adapterVersion: f.adapterVersion },
    services: [f.analyzer],
    resources: [`eks:${cluster}/${f.resourceName}`], // ADR-006 cross-boundary anchor (Rule 6)
    rawPayload: { kind: 'k8sgpt-finding', cluster, fingerprint: f.fingerprint }, // FACT provenance, no hypothesis
  };
  const tri = await triageAndCreateOrLink(event); // ADR-032 gate (INCIDENT_LIFECYCLE_ENABLED) inside
  if (tri.decision === 'New' && tri.incidentId) await enqueueInitialStage(tri.incidentId);
  return tri;
}
