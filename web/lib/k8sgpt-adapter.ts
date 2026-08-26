// web/lib/k8sgpt-adapter.ts
// ADR-035 Rule 7 — the VERSIONED ADAPTER is the stable abstraction between K8sGPT's
// native Result CRD schema and OUR durable MCP/tool contract. Pin the operator generation;
// a CI schema-compat test (k8sgpt-adapter.test.ts) gates upgrades. If K8sGPT is archived or
// its schema diverges, swap the analyzer behind THIS contract — callers never change.
import { createHash } from 'crypto';

/** The K8sGPT operator CRD generation this adapter is verified against (Rule 7 pin).
 *  MUST match the PINNED_OPERATOR_VERSION in docs/runbooks/k8sgpt-operator-install.md. */
export const ADAPTER_K8SGPT_VERSION = '0.4.x/result.core.k8sgpt.ai/v1';

// --- K8sGPT native Result CRD (only the fields we read; tolerate the rest) ---
export interface K8sgptResultCrd {
  metadata?: { name?: string; namespace?: string; creationTimestamp?: string };
  spec?: {
    kind?: string;                 // analyzer kind, e.g. "Pod", "Service" (H0: `kind`)
    name?: string;                 // resource the analyzer fired on (H0: `name`, "ns/obj")
    error?: { text?: string; sensitive?: unknown[] }[]; // H0: `error` (array)
    details?: string;              // H0: `details` (deterministic, NOT the LLM explain)
    parentObject?: string;         // H0: `parentObject`
    backend?: string;              // deterministic-only ⇒ expect "" / absent (NOT "amazonbedrock")
  };
}

/** OUR stable, deterministic fact contract (Rule 8: this is the FACT half, high confidence). */
export interface AnalyzerResult {
  analyzer: string;        // spec.kind — which analyzer fired
  resourceName: string;    // spec.name — the resource (namespace/name)
  namespace: string;       // metadata.namespace (Result object's ns) or derived from resourceName
  errors: string[];        // flattened spec.error[].text
  details: string;         // spec.details (deterministic detail; NOT an LLM explanation)
  parentObject: string;    // spec.parentObject
  fingerprint: string;     // stable dedup id (Rule 11)
  adapterVersion: string;  // ADAPTER_K8SGPT_VERSION — provenance for the schema-compat audit
}

function ns(crd: K8sgptResultCrd): string {
  const m = crd?.metadata?.namespace;
  if (m) return m;
  const n = crd?.spec?.name ?? '';
  return n.includes('/') ? n.split('/')[0] : '';
}

/** Stable fingerprint for dedup (Rule 11): identity of the FINDING, not its narration.
 *  Excludes timestamps so an unchanged finding fingerprints identically across scans. */
export function fingerprint(r: Pick<AnalyzerResult, 'analyzer' | 'resourceName' | 'errors'>): string {
  const basis = JSON.stringify([r.analyzer, r.resourceName, [...r.errors].sort()]);
  return createHash('sha256').update(basis).digest('hex').slice(0, 32);
}

/** Map ONE native CRD → our AnalyzerResult. Tolerant of missing/unknown fields (Rule 7). */
export function adaptResult(crd: K8sgptResultCrd): AnalyzerResult {
  const analyzer = crd?.spec?.kind ?? '';
  const resourceName = crd?.spec?.name ?? '';
  const errors = (crd?.spec?.error ?? []).map((e) => e?.text ?? '').filter(Boolean);
  const base = { analyzer, resourceName, errors };
  return {
    ...base,
    namespace: ns(crd),
    details: crd?.spec?.details ?? '',
    parentObject: crd?.spec?.parentObject ?? '',
    fingerprint: fingerprint(base),
    adapterVersion: ADAPTER_K8SGPT_VERSION,
  };
}

/** Map a CRD list (k8s `items`) → AnalyzerResult[]. Drops items with no analyzer kind. */
export function adaptResultList(items: K8sgptResultCrd[] | undefined): AnalyzerResult[] {
  return (items ?? []).map(adaptResult).filter((r) => r.analyzer && r.resourceName);
}
