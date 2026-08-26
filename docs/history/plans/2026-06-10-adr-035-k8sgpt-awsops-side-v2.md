# ADR-035 K8sGPT AWSops-Side Substrate (v2, flag-gated, operator install out-of-band) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the **AWSops-side substrate** for ADR-035 (K8sGPT in-cluster diagnosis, H1–H2 + the H3a seam) behind a new `k8sgpt_enabled` flag (default false). AWSops READS the deterministic K8sGPT `Result` CRDs from an onboarded EKS cluster over the **existing P3-D presigned-STS read path**, normalizes them through a **versioned adapter** (Rule 7), persists them (with dedup, Rule 11), narrates them with the **Container-section AgentCore agent (Haiku 4.5, ap-northeast-2)** keeping **fact (`analyzer_result`) and hypothesis (`llm_explanation`) structurally separate** (Rule 8), and surfaces them read-only on the EKS page. The K8sGPT **operator Helm install stays an OUT-OF-BAND documented operator runbook** — AWSops NEVER writes to the shared EKS cluster (mirrors ADR-029 §7 "KEDA install is out-of-band"). Flag-off ⇒ `terraform plan` = No changes for gated infra, $0, the K8s-diagnosis MCP tool/UI/narration are dark.

**Architecture:** The H0 spike PROVED K8sGPT's deterministic analyzers work read-only against `fsi-demo-cluster` (K8s 1.36; 45 findings / 43 `Result` objects with `kind,name,error,details,parentObject`), and that K8sGPT's own `amazonbedrock`/`--explain` backend + MCP server are NOT viable (no Haiku 4.5, no ap-northeast-2, MCP refuses to start without an AI backend). So per the **H0 refinement (BINDING, amends Rules 2/5):** K8sGPT runs **deterministic-only**; AWSops consumes the **`Result` CRDs**; **all LLM narration happens in AWSops' AgentCore (Container agent, Bedrock Haiku 4.5, ap-northeast-2).** This plan adds NO new compute: the Result reader is a **BFF route reusing the P3-D `eks-incluster.ts` STS read path** (same `k8s-aws-v1.` token, just a different API group — `result.core.k8sgpt.ai/v1`), the narration rides the **existing AgentCore runtime** (`web/lib/agentcore.ts` `invokeAgent({gateway:'container'})`), and the only gated TF resource is a **monthly Bedrock budget alarm** (Rule 11). Domain tables (`k8s_findings`, `k8s_scan_runs`, migration **v7**) are **always-present + inert when off**. The H3a remediation/incident seam is a **thin wiring + doc** into the already-built ADR-032 (`web/lib/incident.ts`) / ADR-034 / ADR-029-036 (`/api/actions`) substrate — it ENABLES nothing.

**Gated by `k8sgpt_enabled` (default false) ⇒ $0/dark when off:**
- `terraform plan` = No changes (the single gated resource, the Bedrock budget alarm, is `count = local.k8s`).
- The BFF route `/api/eks/[cluster]/k8sgpt` reads `K8SGPT_ENABLED !== 'true'` (env injected only when flagged) → returns `503` + `{enabled:false}` and **performs NO cluster read / NO STS presign / NO AgentCore invoke**.
- No narration (no Bedrock calls), no UI panel, no scan persistence.
- The always-present `k8s_findings` / `k8s_scan_runs` tables stay empty and inert (mirrors the migration-v4/v5/v6 "harmless when off" pattern).

**Tech Stack:** Next.js 14 (web BFF, root path, no basePath) · `@smithy/signature-v4` + `@aws-sdk/client-eks` (reused, P3-D) · `@aws-sdk/client-bedrock-agentcore` (reused, narration via `invokeAgent`) · Bedrock Haiku 4.5 `global.anthropic.claude-haiku-4-5-20251001-v1:0` (ap-northeast-2, in the Container agent — selected per ADR-016/033) · Aurora PG17 node-pg (`web/lib/db.ts` `getPool`) · Terraform (partial S3 backend, `aws_budgets_budget` / `aws_cloudwatch_metric_alarm`) · vitest 2.x · Helm (OUT-OF-BAND operator install only).

**Key contracts (DO NOT break):**
- **P3-D read path (reuse, do NOT fork the auth):** `web/lib/eks-incluster.ts` `eksToken(cluster, region)` (presigned-STS `k8s-aws-v1.` bearer via the `awsops-v2-task` Access Entry + `AmazonEKSViewPolicy`) + `clusterConn(cluster)` (`endpoint` + `caPem` from `DescribeCluster`, 5-min cache) + the private `k8sGet(endpoint, path, token, caPem)` GET-with-CA helper. The K8sGPT reader calls the SAME `eksToken`/`clusterConn`; it ONLY adds a new API path. **No write verbs ever** — GET/list only.
- **Cluster allowlist gate (reuse):** `process.env.ONBOARDED_EKS_CLUSTERS` (CSV, set by `workload.tf:209`) — every K8sGPT route 404s an unknown cluster exactly like `incluster/route.ts`.
- **Auth/admin (reuse):** `web/lib/auth.ts` `verifyUser(cookieHeader)` + `web/lib/admin.ts` `isAdmin(user)` (fail-closed). The K8sGPT route is **admin-gated** (diagnosis is operator-sensitive).
- **Narration (reuse):** `web/lib/agentcore.ts` `invokeAgent({gateway:'container', messages, sessionId, systemPromptOverride?})` → Container-section agent, Haiku tier. **Decision: a DIRECT invoke with a `systemPromptOverride`** (a focused narration prompt) rather than a new ADR-031 catalog skill — narration is a single bounded call, not a customizable agent persona; this keeps the fact/hypothesis split owned by the adapter, not the model.
- **Fact-vs-hypothesis invariant (Rule 8, BINDING):** the tool/route response returns `analyzer_result` (deterministic — which analyzer fired, on which resource, the raw `error`/`details`/`parentObject`) and `llm_explanation` (the Haiku narration — a hypothesis) as **separate top-level fields**. On any conflict with AWSops' own deterministic data, deterministic WINS; the UI labels the narration **"AI hypothesis"**. The narration NEVER mutates or overwrites the `analyzer_result`.
- **Deterministic-only invariant (H0 refinement, BINDING):** AWSops NEVER calls K8sGPT's `--explain` / `ai.backend` / its MCP server. The only K8sGPT artifact AWSops consumes is the deterministic `Result` CRD (`result.core.k8sgpt.ai/v1`).
- **Incident/action seams (reuse, H3a):** ADR-032 `web/lib/incident.ts` `triageAndCreateOrLink(event)` + `enqueueInitialStage(incidentId)` (gated by `INCIDENT_LIFECYCLE_ENABLED`); the `action_catalog` + `web/app/api/actions/route.ts` (`createPlan`, gated by catalog `enabled=false` + `remediation_enabled`); ADR-034 `incident_writeback`. H3a feeds findings into these — it does NOT change their gating.
- **No-cluster-write invariant (BINDING):** AWSops issues ONLY HTTP GET against the cluster API. The operator install, its RBAC, and binding the Result-CRD read to `awsops-v2-task` are ALL out-of-band operator actions.

---

## File map

**Terraform (`terraform/foundation/`)**
- Modify `variables.tf` — add `variable "k8sgpt_enabled"` (default false) + `variable "k8sgpt_monthly_bedrock_budget_usd"` (default 50).
- Create `k8sgpt.tf` — `locals { k8s = var.k8sgpt_enabled ? 1 : 0 }`, the gated Bedrock budget alarm + (optional) SNS, the `K8SGPT_ENABLED` / `K8SGPT_*` env contribution doc. (The web env injection itself is a small edit to `workload.tf`.)
- Modify `workload.tf` — append `K8SGPT_ENABLED` (+ scan-staleness threshold) to the web task `environment` via the existing `concat(base, flag ? [...] : [])` idiom.
- Modify `data/schema.sql` — migration **v7**: `k8s_findings` + `k8s_scan_runs` (+ `schema_migrations` v7 row).

**Web (`web/`)**
- Create `lib/k8sgpt-adapter.ts` — versioned adapter (Rule 7): K8sGPT `Result` CRD → our stable `AnalyzerResult` contract; `fingerprint()`; `ADAPTER_K8SGPT_VERSION` pin.
- Create `lib/k8sgpt-adapter.test.ts` — adapter normalization + fingerprint stability + unknown-field tolerance, using the H0 real `Result` shape.
- Modify `lib/eks-incluster.ts` — add `listK8sgptResults(cluster)` (reuses `eksToken`/`clusterConn`/`k8sGet`; new API path).
- Create `lib/k8sgpt.ts` — `getDiagnosis(cluster)`: enabled-gate → read Results → adapt → dedup/persist → narrate (Container agent) keeping fact/hypothesis separate → stale-scan degrade (Rule 9). DB read/write helpers.
- Create `lib/k8sgpt.test.ts` — fact/hypothesis separation, dedup (no re-narrate unchanged finding), stale-scan degrade, flag-off no-op.
- Create `app/api/eks/[cluster]/k8sgpt/route.ts` — read-only GET, admin+auth-gated, allowlist-gated, 503 when off.
- Modify `app/eks/[cluster]/page.tsx` — add a "Diagnosis (K8sGPT)" tab/panel: `analyzer_result` facts table + "AI hypothesis"-labelled narration; absent/503 → quiet empty state.

**Docs**
- Create `docs/runbooks/k8sgpt-operator-install.md` — the OUT-OF-BAND operator install runbook (Helm, deterministic-only, read-only RBAC, `--fix` off, pinned version, bind Result-CRD read RBAC to `awsops-v2-task`). Clearly marked: operator/cluster-admin action, NOT executed by AWSops.

---

## Out of scope (explicit)

- **AWSops installing the K8sGPT operator** or ANY write to the shared EKS cluster — the operator + its RBAC + the `awsops-v2-task` read-RBAC binding are OUT-OF-BAND (runbook only). AWSops issues HTTP GET only.
- **K8sGPT `--explain` / `ai.backend` / its MCP server** — not viable (H0 (b)/(c)); deterministic `Result` CRDs only. All narration is AWSops-owned (Haiku 4.5 in AgentCore).
- **Auto-remediation** of any kind (Rule 4). H3a produces gated PROPOSALS into the existing ADR-029/036 worker tier; nothing auto-applies. K8sGPT `--fix` stays OFF at the operator config level (runbook).
- **Enabling** `k8sgpt_enabled`, `incident_lifecycle_enabled`, `remediation_enabled`, or `rca_writeback_enabled`. All ship false; this plan only builds the substrate + thin seam.
- **Multi-cluster / fleet operator management** (the H2 ">5 clusters" note) — the route is per-cluster and allowlist-gated; fleet disambiguation beyond per-cluster is deferred.
- **H3b accuracy-audit** (thumbs-up/down logging + periodic K8sGPT-vs-postmortem audit) beyond the schema seam (`k8s_findings.feedback` column reserved). The audit job/UI is deferred.
- **Prometheus metrics scraping** from the operator — the deterministic `Result` CRD + `last_scan_timestamp` is the integration artifact (per H1 "done when"). Metrics dashboards are deferred.
- **Touching v1 `src/`** — none.

---

## Out-of-band operator install runbook (NOT executed by AWSops)

> ⚠️ **This section documents an OPERATOR action requiring cluster-admin on the target EKS cluster. AWSops does NOT perform any step here.** It mirrors ADR-029 §7 "KEDA install is out-of-band." The runbook file is `docs/runbooks/k8sgpt-operator-install.md` (created in Task 7). AWSops only READS the `Result` CRDs the operator produces.

The operator must be installed **deterministic-only** per the H0 refinement + Rules 7/9:

```bash
# 1) Pin the operator version (Rule 7 — the version is part of the schema-compat contract).
#    ADAPTER_K8SGPT_VERSION in web/lib/k8sgpt-adapter.ts MUST match this CRD generation.
helm repo add k8sgpt https://charts.k8sgpt.ai/
helm repo update

# 2) Install deterministic-only: NO ai.backend, NO --explain (H0 (b) fails; narration is AWSops-side).
#    --anonymize as defense-in-depth (Rule 5; note it does NOT mask Event/Describe/env-var/image values).
#    --fix OFF at config level (Rule 9 — defense-in-depth, not merely "not called").
helm upgrade --install k8sgpt-operator k8sgpt/k8sgpt-operator \
  --namespace k8sgpt-operator-system --create-namespace \
  --version <PINNED_OPERATOR_VERSION> \
  --set k8sgpt.deployAnonymized=true

# 3) Apply a K8sGPT CR with NO ai/backend block (deterministic analyzers only), --fix disabled:
cat <<'YAML' | kubectl apply -f -
apiVersion: core.k8sgpt.ai/v1alpha1
kind: K8sGPT
metadata: { name: k8sgpt-deterministic, namespace: k8sgpt-operator-system }
spec:
  version: <PINNED_K8SGPT_IMAGE>
  noCache: false
  # NO `ai:` block → deterministic analyzers only → Result CRDs, no LLM. (H0 refinement)
  # NO remediation / --fix.
YAML
```

**Read-only RBAC + bind to the AWSops task principal (Rules 1/9 — out-of-band):**
- The operator runs with a **read-only ClusterRole**: `get/list/watch` only; `create/update/patch/delete` explicitly absent. (`--fix`/auto-remediation disabled at config level.)
- Bind a **read-only ClusterRole for the `results.result.core.k8sgpt.ai` CRD** to the IAM principal that the P1e Access Entry maps for `awsops-v2-task`, so the AWSops BFF's presigned-STS token can `get/list` `Result` objects. Example (operator applies):

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata: { name: awsops-k8sgpt-result-reader }
rules:
  - apiGroups: ["result.core.k8sgpt.ai"]
    resources: ["results"]
    verbs: ["get","list","watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata: { name: awsops-k8sgpt-result-reader }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: awsops-k8sgpt-result-reader }
subjects:
  # Group/user that the P1e Access Entry maps awsops-v2-task to (see aws-auth / Access Entry).
  - apiGroup: rbac.authorization.k8s.io
    kind: Group
    name: <THE_GROUP_THE_P1E_ACCESS_ENTRY_GRANTS>
```

**Validation the operator runs (NOT AWSops):**
```bash
kubectl get results.result.core.k8sgpt.ai -A          # Result CRDs flowing
kubectl get results.result.core.k8sgpt.ai -A -o json | jq '.items[0]'   # kind,name,error,details,parentObject
```
When this returns Results AND the `awsops-k8sgpt-result-reader` binding is live, the AWSops-side route (flag on) can read them. Until then, the AWSops route degrades gracefully (empty + "operator not detected").

---

## Tasks

### Task 1: Versioned adapter — K8sGPT `Result` CRD → stable `AnalyzerResult` (Rule 7)

**Files:**
- Create: `web/lib/k8sgpt-adapter.ts`
- Create: `web/lib/k8sgpt-adapter.test.ts`

The adapter is the durable interface (Rule 7): it pins the K8sGPT CRD generation it understands and maps the native schema to OUR stable contract, tolerating unknown upstream fields. The H0 real shape is `{kind, name, error, details, parentObject}` — note `error` is an **array of `{text}`** in the CRD `spec`, and the CRD wraps it in `metadata`/`spec`.

- [ ] **Step 1: write `web/lib/k8sgpt-adapter.ts`**

```ts
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
  const m = crd.metadata?.namespace;
  if (m) return m;
  const n = crd.spec?.name ?? '';
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
  const analyzer = crd.spec?.kind ?? '';
  const resourceName = crd.spec?.name ?? '';
  const errors = (crd.spec?.error ?? []).map((e) => e?.text ?? '').filter(Boolean);
  const base = { analyzer, resourceName, errors };
  return {
    ...base,
    namespace: ns(crd),
    details: crd.spec?.details ?? '',
    parentObject: crd.spec?.parentObject ?? '',
    fingerprint: fingerprint(base),
    adapterVersion: ADAPTER_K8SGPT_VERSION,
  };
}

/** Map a CRD list (k8s `items`) → AnalyzerResult[]. Drops items with no analyzer kind. */
export function adaptResultList(items: K8sgptResultCrd[] | undefined): AnalyzerResult[] {
  return (items ?? []).map(adaptResult).filter((r) => r.analyzer && r.resourceName);
}
```

- [ ] **Step 2: write `web/lib/k8sgpt-adapter.test.ts`** using the H0 real shape as the fixture

```ts
import { describe, it, expect } from 'vitest';
import { adaptResult, adaptResultList, fingerprint, ADAPTER_K8SGPT_VERSION } from './k8sgpt-adapter';

// H0 spike real shape (fsi-demo-cluster, K8s 1.36): kind,name,error,details,parentObject.
const otelCrd = {
  metadata: { name: 'otel-collector-result', namespace: 'observability' },
  spec: {
    kind: 'DaemonSet',
    name: 'observability/otel-collector',
    error: [{ text: 'DaemonSet observability/otel-collector has 5/8 ready pods' }],
    details: 'CrashLoopBackOff on container otel-collector',
    parentObject: 'DaemonSet/otel-collector',
    backend: '', // deterministic-only — NO amazonbedrock
  },
};

describe('adaptResult (Rule 7 versioned adapter)', () => {
  it('maps the H0 native Result shape to the stable AnalyzerResult contract', () => {
    const r = adaptResult(otelCrd);
    expect(r.analyzer).toBe('DaemonSet');
    expect(r.resourceName).toBe('observability/otel-collector');
    expect(r.namespace).toBe('observability');
    expect(r.errors).toEqual(['DaemonSet observability/otel-collector has 5/8 ready pods']);
    expect(r.details).toContain('CrashLoopBackOff');
    expect(r.parentObject).toBe('DaemonSet/otel-collector');
    expect(r.adapterVersion).toBe(ADAPTER_K8SGPT_VERSION);
    expect(r.fingerprint).toMatch(/^[0-9a-f]{32}$/);
  });

  it('tolerates missing namespace (derives from name) and unknown upstream fields', () => {
    const r = adaptResult({ spec: { kind: 'Pod', name: 'kube-system/x', error: [], extraNew: 1 } as never });
    expect(r.namespace).toBe('kube-system');
    expect(r.errors).toEqual([]);
  });

  it('fingerprint is stable across scans (timestamp-independent) and changes on error change', () => {
    const a = fingerprint({ analyzer: 'Pod', resourceName: 'ns/p', errors: ['b', 'a'] });
    const b = fingerprint({ analyzer: 'Pod', resourceName: 'ns/p', errors: ['a', 'b'] });
    const c = fingerprint({ analyzer: 'Pod', resourceName: 'ns/p', errors: ['a', 'changed'] });
    expect(a).toBe(b);          // order-independent → unchanged finding == same fingerprint
    expect(a).not.toBe(c);      // changed error → re-narrate
  });

  it('adaptResultList drops items with no analyzer/resource', () => {
    expect(adaptResultList([otelCrd, { spec: {} }, undefined as never])).toHaveLength(1);
  });
});
```

- [ ] **Step 3: verify** — `cd /home/atomoh/awsops/web && npx vitest run lib/k8sgpt-adapter.test.ts` → all green.
- [ ] **Step 4: commit** (`feat(v2-p3-k8sgpt): Rule-7 versioned adapter K8sGPT Result CRD → stable AnalyzerResult + tests`).

---

### Task 2: Extend the P3-D read path — `listK8sgptResults` (Result CRD via the SAME STS token)

**Files:**
- Modify: `web/lib/eks-incluster.ts`

This is the key reuse: the SAME `eksToken` (presigned-STS `k8s-aws-v1.` bearer via the `awsops-v2-task` Access Entry) + the SAME `clusterConn` (endpoint+CA) + the SAME `k8sGet` GET-with-CA helper — only the API path changes from `/api/v1/...` to the K8sGPT namespaced CRD collection `/apis/result.core.k8sgpt.ai/v1/results` (all namespaces). **GET only — no write verb is added.**

- [ ] **Step 1: add the K8sGPT path constant + reader to `web/lib/eks-incluster.ts`** (append below `listInCluster`)

```ts
// ── K8sGPT Result CRDs (ADR-035) — SAME presigned-STS token path, different API group ─────
// result.core.k8sgpt.ai/v1, namespaced `results`; cluster-wide collection across namespaces.
// READ-ONLY: a single HTTP GET, exactly like listInCluster. AWSops issues NO write verb.
const K8SGPT_RESULTS_PATH = '/apis/result.core.k8sgpt.ai/v1/results';

import type { K8sgptResultCrd } from '@/lib/k8sgpt-adapter';

/** GET the K8sGPT Result CRD collection. Throws on transport/HTTP error (caller degrades gracefully).
 *  A 404 here typically means the operator/CRD is absent → the caller treats it as "no operator". */
export async function listK8sgptResults(cluster: string): Promise<K8sgptResultCrd[]> {
  const { endpoint, caPem } = await clusterConn(cluster);   // reuse P3-D DescribeCluster+CA (cached)
  const token = await eksToken(cluster, REGION);            // reuse P3-D presigned-STS bearer
  const body = await k8sGet(endpoint, K8SGPT_RESULTS_PATH, token, caPem); // reuse P3-D GET-with-CA
  const parsed = JSON.parse(body) as { items?: K8sgptResultCrd[] };
  return parsed.items ?? [];
}
```

- [ ] **Step 2: confirm no write surface** — grep that `eks-incluster.ts` still issues only `method: 'GET'` (the `k8sGet` helper hardcodes GET; we add no new request site). `grep -n "method:" web/lib/eks-incluster.ts` → only `'GET'`.
- [ ] **Step 3: verify** the existing `lib/eks-incluster.test.ts` still passes (`npx vitest run lib/eks-incluster.test.ts`) — the new export does not touch the tested `eksToken`/normalizers.
- [ ] **Step 4: commit** (`feat(v2-p3-k8sgpt): listK8sgptResults — read Result CRDs via the P3-D STS path (GET-only, no cluster write)`).

---

### Task 3: `web/lib/k8sgpt.ts` — gate, read, dedup/persist, narrate (fact/hypothesis split), stale degrade

**Files:**
- Create: `web/lib/k8sgpt.ts`
- Create: `web/lib/k8sgpt.test.ts`

This is the orchestration layer. Mirrors `web/lib/incident.ts` conventions: enabled-gate first, `getPool()` for DB, degrade-safe try/catch, SSM-free env config. Implements Rules 8/9/11.

- [ ] **Step 1: write `web/lib/k8sgpt.ts`**

```ts
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
```

- [ ] **Step 2: write `web/lib/k8sgpt.test.ts`** — flag-off no-op, fact/hypothesis separation, dedup, stale degrade

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const invokeAgent = vi.fn();
const listK8sgptResults = vi.fn();
const query = vi.fn();
vi.mock('@/lib/agentcore', () => ({ invokeAgent }));
vi.mock('@/lib/eks-incluster', () => ({ listK8sgptResults }));
vi.mock('@/lib/db', () => ({ getPool: () => ({ query }) }));

const crd = (over = {}) => ({
  spec: { kind: 'DaemonSet', name: 'observability/otel-collector',
    error: [{ text: '5/8 ready pods' }], details: 'CrashLoopBackOff', parentObject: 'DaemonSet/otel-collector' },
  ...over,
});

async function load() { return await import('./k8sgpt'); }

beforeEach(() => {
  vi.resetModules();
  invokeAgent.mockReset(); listK8sgptResults.mockReset(); query.mockReset();
  process.env.AURORA_ENDPOINT = 'aurora.local';
  process.env.K8SGPT_ENABLED = 'true';
  query.mockResolvedValue({ rows: [] }); // default: no existing finding, inserts return nothing
});

describe('getDiagnosis gate (BINDING flag-off behavior)', () => {
  it('flag OFF → no cluster read, no narration, enabled:false', async () => {
    process.env.K8SGPT_ENABLED = 'false';
    const { getDiagnosis } = await load();
    const r = await getDiagnosis('fsi-demo-cluster');
    expect(r.enabled).toBe(false);
    expect(listK8sgptResults).not.toHaveBeenCalled();   // NO STS presign / NO cluster read
    expect(invokeAgent).not.toHaveBeenCalled();          // NO Bedrock call
  });
});

describe('fact/hypothesis separation (Rule 8)', () => {
  it('returns deterministic analyzer_result distinctly from the Haiku llm_explanation', async () => {
    listK8sgptResults.mockResolvedValue([crd()]);
    invokeAgent.mockResolvedValue('Likely a bad readiness probe; check container logs. (hypothesis)');
    query.mockImplementation((sql: string) => {
      if (sql.includes('SELECT scanned_at')) return Promise.resolve({ rows: [{ scanned_at: new Date().toISOString() }] });
      if (sql.startsWith('INSERT INTO k8s_findings')) return Promise.resolve({ rows: [{ first_seen: 'x', last_seen: 'x', llm_explanation: null, llm_model: null }] });
      return Promise.resolve({ rows: [] });
    });
    const { getDiagnosis } = await load();
    const r = await getDiagnosis('fsi-demo-cluster');
    const f = r.findings[0];
    expect(f.analyzer_result.analyzer).toBe('DaemonSet');                 // FACT
    expect(f.analyzer_result.errors).toEqual(['5/8 ready pods']);          // FACT untouched
    expect(f.llm_explanation).toContain('hypothesis');                     // HYPOTHESIS, separate field
    expect(f.analyzer_result).not.toHaveProperty('llm_explanation');       // structurally separate
  });
});

describe('dedup (Rule 11) — do not re-narrate an unchanged finding', () => {
  it('reuses the persisted narration when the fingerprint already exists', async () => {
    listK8sgptResults.mockResolvedValue([crd()]);
    query.mockImplementation((sql: string) => {
      if (sql.startsWith('SELECT llm_explanation')) return Promise.resolve({ rows: [{ llm_explanation: 'cached', llm_model: 'haiku-4.5', first_seen: 'a', last_seen: 'b' }] });
      if (sql.includes('SELECT scanned_at')) return Promise.resolve({ rows: [{ scanned_at: new Date().toISOString() }] });
      return Promise.resolve({ rows: [{ first_seen: 'a', last_seen: 'b', llm_explanation: 'cached', llm_model: 'haiku-4.5' }] });
    });
    const { getDiagnosis } = await load();
    const r = await getDiagnosis('fsi-demo-cluster');
    expect(invokeAgent).not.toHaveBeenCalled();          // no re-narrate
    expect(r.findings[0].llm_explanation).toBe('cached');
  });
});

describe('stale-scan degrade (Rule 9)', () => {
  it('operator unreachable → operator_detected:false, stale:true, still returns (no throw)', async () => {
    listK8sgptResults.mockRejectedValue(new Error('connect ETIMEDOUT'));
    query.mockResolvedValue({ rows: [] });
    const { getDiagnosis } = await load();
    const r = await getDiagnosis('fsi-demo-cluster');
    expect(r.operator_detected).toBe(false);
    expect(r.stale).toBe(true);
    expect(r.findings).toEqual([]);
  });

  it('last scan older than STALE_MS → stale:true', async () => {
    listK8sgptResults.mockResolvedValue([]);
    const old = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    query.mockImplementation((sql: string) =>
      sql.includes('SELECT scanned_at') ? Promise.resolve({ rows: [{ scanned_at: old }] }) : Promise.resolve({ rows: [] }));
    const { getDiagnosis } = await load();
    const r = await getDiagnosis('fsi-demo-cluster');
    expect(r.stale).toBe(true);
  });
});
```

- [ ] **Step 3: verify** — `cd /home/atomoh/awsops/web && npx vitest run lib/k8sgpt.test.ts` → all green.
- [ ] **Step 4: commit** (`feat(v2-p3-k8sgpt): k8sgpt.ts — gate/read/dedup/persist + Container-agent narration (Rule 8/9/11) + tests`).

---

### Task 4: BFF route — `/api/eks/[cluster]/k8sgpt` (read-only, admin+allowlist-gated, 503 when off)

**Files:**
- Create: `web/app/api/eks/[cluster]/k8sgpt/route.ts`

Mirrors `incluster/route.ts` (auth + allowlist) but uses `isAdmin` (diagnosis is operator-sensitive) and short-circuits to 503 when the flag is off — proving the route is DARK + reads NOTHING from the cluster when `k8sgpt_enabled` is false.

- [ ] **Step 1: write the route**

```ts
// web/app/api/eks/[cluster]/k8sgpt/route.ts
// ADR-035 read-only diagnosis route. Auth (verifyUser) + admin (isAdmin) + cluster-allowlist gated.
// Flag OFF (K8SGPT_ENABLED !== 'true') → 503 {enabled:false} and getDiagnosis does NO cluster read.
import { verifyUser } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';
import { getDiagnosis } from '@/lib/k8sgpt';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: { cluster: string } }) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  if (!(await isAdmin(user))) return Response.json({ status: 'error', message: 'admin required' }, { status: 403 });

  if (process.env.K8SGPT_ENABLED !== 'true') {
    // Dark when off: no cluster read, no STS presign, no Bedrock — honest 503.
    return Response.json({ enabled: false, message: 'k8sgpt diagnosis disabled' }, { status: 503 });
  }

  const allow = (process.env.ONBOARDED_EKS_CLUSTERS || '').split(',').filter(Boolean);
  if (!allow.includes(params.cluster)) {
    return Response.json({ status: 'error', message: 'unknown cluster' }, { status: 404 });
  }
  try {
    return Response.json(await getDiagnosis(params.cluster));
  } catch (e) {
    return Response.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
```

- [ ] **Step 2: verify** the route compiles in the web build (`cd /home/atomoh/awsops/web && npx tsc --noEmit`) — no type errors against `getDiagnosis`.
- [ ] **Step 3: commit** (`feat(v2-p3-k8sgpt): /api/eks/[cluster]/k8sgpt route — admin+allowlist-gated, 503/dark when off`).

---

### Task 5: UI surface — "Diagnosis (K8sGPT)" panel on the EKS page (Rule 8 labelling)

**Files:**
- Modify: `web/app/eks/[cluster]/page.tsx`

Add a fifth tab "Diagnosis" that fetches `/api/eks/[cluster]/k8sgpt`. Render the deterministic `analyzer_result` facts in the `DataTable` and the `llm_explanation` in the `DetailPanel` **explicitly labelled "AI hypothesis"** (Rule 8). On 503/`enabled:false`/empty → a quiet "diagnosis disabled or no operator detected" state (degrade-safe, Rule 9). Stale banner when `stale:true`.

- [ ] **Step 1: add the tab + state**: extend the `Tab` union with `'diagnosis'`, add `{ value: 'diagnosis', label: 'Diagnosis' }` to `TABS`, and a separate fetch branch in `load()` (the diagnosis endpoint returns `{enabled,stale,findings:[{analyzer_result,llm_explanation,...}]}`, not `{rows}`). Map each finding to a row: `{ analyzer, resourceName, namespace, errors: f.analyzer_result.errors.join('; '), hypothesis: f.llm_explanation ?? '—' }`.
- [ ] **Step 2: diagnosis columns** (separate from `COLUMNS`):

```tsx
const DIAGNOSIS_COLUMNS: Column[] = [
  { key: 'analyzer', label: 'Analyzer' },
  { key: 'resourceName', label: 'Resource' },
  { key: 'namespace', label: 'Namespace' },
  { key: 'errors', label: 'Finding (deterministic)' },   // Rule 8 FACT
];
```

- [ ] **Step 3: render the hypothesis distinctly** — in the `DetailPanel` for a selected diagnosis row, show the deterministic facts (analyzer/resource/errors/details/parentObject) and BELOW them, in a visually distinct block, the narration prefixed with an explicit badge: `AI hypothesis (Haiku) — verify before acting` (Rule 8). When `enabled:false` (503) or `findings.length===0`, render: `진단 비활성 또는 K8sGPT operator 미감지 (read-only)`. When `stale`, render a small amber `last scan stale (>5m)` banner.
- [ ] **Step 4: verify** the page builds (`npx tsc --noEmit`) and the existing tabs are untouched.
- [ ] **Step 5: commit** (`feat(v2-p3-k8sgpt): EKS-page Diagnosis panel — deterministic facts + 'AI hypothesis'-labelled narration (Rule 8)`).

---

### Task 6: Terraform — `k8sgpt_enabled` flag + gated Bedrock budget alarm (Rule 11) + web env

**Files:**
- Modify: `terraform/foundation/variables.tf`
- Create: `terraform/foundation/k8sgpt.tf`
- Modify: `terraform/foundation/workload.tf`

Justification of gated vs always-present: the Result reader is a BFF route reusing P3-D (no new infra); the narration rides the existing AgentCore runtime (no new infra). The ONLY net-new gated AWS resource is the **monthly Bedrock budget alarm** (Rule 11). The domain tables are always-present (migration v7, Task 9) and inert when off. Therefore flag-off ⇒ `terraform plan` = No changes (count=0 on the one gated resource) ⇒ $0.

- [ ] **Step 1: add variables** to `variables.tf`

```hcl
variable "k8sgpt_enabled" {
  type        = bool
  description = "ADR-035 K8sGPT in-cluster diagnosis (AWSops-side substrate) gate. false (default) = 0 gated infra ($0), the /api/eks/[cluster]/k8sgpt route is dark (503), NO cluster read, NO narration. The always-present k8s_findings/k8s_scan_runs tables (migration v7) are harmless when off. The K8sGPT OPERATOR install is OUT-OF-BAND (docs/runbooks/k8sgpt-operator-install.md) — AWSops NEVER writes to the EKS cluster. REQUIRES onboard_eks_clusters non-empty + agentcore_enabled (narration rides the Container agent)."
  default     = false
}

variable "k8sgpt_monthly_bedrock_budget_usd" {
  type        = number
  description = "ADR-035 Rule 11 cost cap: monthly Bedrock spend budget (USD) for the K8sGPT narration. Alarm only (no enforcement). Tunable."
  default     = 50
}
```

- [ ] **Step 2: create `k8sgpt.tf`** — the single gated resource (budget alarm) + the gating local

```hcl
# terraform/foundation/k8sgpt.tf
# AWSops v2 ADR-035 — K8sGPT in-cluster diagnosis, AWSOPS-SIDE SUBSTRATE ONLY.
# Gated by var.k8sgpt_enabled (default false → count=0 → ZERO gated AWS resources, ZERO cost).
#
# REUSE (no new infra): the Result CRD reader is a BFF route reusing the P3-D presigned-STS read
# path (web/lib/eks-incluster.ts — the awsops-v2-task Access Entry + AmazonEKSViewPolicy from
# eks.tf, GET-only); the Haiku 4.5 narration rides the EXISTING AgentCore runtime (Container agent,
# ai.tf). NO new compute, NO new IAM role, NO ECR. The always-present k8s_findings/k8s_scan_runs
# tables (migration v7) are inert when off.
#
# OUT-OF-BAND (NOT here, mirrors ADR-029 §7 KEDA): the K8sGPT operator Helm install, its read-only
# ClusterRole + --fix-off config, and binding the Result-CRD read RBAC to awsops-v2-task are ALL
# operator/cluster-admin actions documented in docs/runbooks/k8sgpt-operator-install.md. AWSops
# issues ONLY HTTP GET against the cluster API — it NEVER writes to the shared EKS cluster.
#
# The ONLY gated AWS resource is the Rule 11 monthly Bedrock budget alarm.

locals {
  k8s = var.k8sgpt_enabled ? 1 : 0
}

# Rule 11 — monthly Bedrock budget alarm scoped to the narration spend. Notifies via email when
# actual or forecasted spend crosses the threshold. No enforcement (cost VISIBILITY, not a kill).
resource "aws_budgets_budget" "k8sgpt_bedrock" {
  count        = local.k8s
  name         = "${var.project}-k8sgpt-bedrock-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.k8sgpt_monthly_bedrock_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  cost_filter {
    name   = "Service"
    values = ["Amazon Bedrock"]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.admin_email] # reuse the existing single admin email (variables.tf:67)
  }
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.admin_email]
  }
}
```

> Verified during recon: the existing variable is **`var.admin_email`** (singular string, `variables.tf:67`, used by `auth.tf`); there is NO `admin_emails` list var and NO existing SNS topic in the foundation. Use `[var.admin_email]` as shown. (The SSM `admin_emails` param at `workload.tf:79` is a runtime app-config CSV — do NOT reference it from Terraform for budget subscribers.) The whole resource is `count = local.k8s`, so it is absent (and emits nothing) when off.

- [ ] **Step 3: inject the web env** in `workload.tf` (the existing `concat(base, flag ? [...] : [])` idiom, same site as the ADR-038/incident env). Append to the flag-gated env list:

```hcl
    var.k8sgpt_enabled ? [
      { name = "K8SGPT_ENABLED", value = "true" },
      { name = "K8SGPT_STALE_MINUTES", value = "5" },
      { name = "K8SGPT_NARRATION_MODEL", value = "global.anthropic.claude-haiku-4-5-20251001-v1:0" },
    ] : [],
```

(When off, `K8SGPT_ENABLED` is simply absent → the route reads `!== 'true'` → 503/dark.)

- [ ] **Step 4: validate** — `terraform -chdir=terraform/foundation fmt` + `validate`. Do NOT apply (controller task does the gated apply check).
- [ ] **Step 5: commit** (`feat(v2-p3-k8sgpt): k8sgpt_enabled flag + gated Bedrock budget alarm (Rule 11) + web env (dark when off)`).

---

### Task 7: Out-of-band operator install runbook (doc only)

**Files:**
- Create: `docs/runbooks/k8sgpt-operator-install.md`

- [ ] **Step 1: write the runbook** (bilingual ko/en per `docs/runbooks/CLAUDE.md`) containing the full **Out-of-band operator install runbook** section from this plan (above): Helm install **deterministic-only** (NO `ai.backend`/`--explain`), `--anonymize`, read-only ClusterRole + `--fix` off (Rule 9), pinned operator version (Rule 7, must match `ADAPTER_K8SGPT_VERSION`), and the `awsops-k8sgpt-result-reader` ClusterRole+Binding to the P1e-mapped group/principal for `awsops-v2-task`. Lead with a banner: **"OPERATOR ACTION — requires cluster-admin on the target EKS cluster. AWSops does NOT execute any step here (mirrors ADR-029 §7)."**
- [ ] **Step 2: cross-link** — add a one-line pointer in `docs/decisions/035-k8sgpt-hybrid-incluster-diagnosis.md` Post-acceptance / References to the runbook, and (optional) note H1 "done when" is satisfied by the operator runbook + this substrate.
- [ ] **Step 3: commit** (`docs(v2-p3-k8sgpt): out-of-band K8sGPT operator install runbook (deterministic-only, read-only RBAC, --fix off)`).

---

### Task 8: H3a seam — K8sGPT finding → ADR-032 incident → ADR-034 write-back → ADR-029/036 gated PROPOSAL (thin wiring + doc)

**Files:**
- Modify: `web/lib/k8sgpt.ts` (add ONE exported seam function; do NOT call it from the route)
- Create/append: a "H3a seam" section in `docs/runbooks/k8sgpt-operator-install.md` (or a short `docs/superpowers/reference/` note)

The seam is a thin, gated, documented path — it ENABLES nothing. It reuses the already-built ADR-032 `triageAndCreateOrLink` + `enqueueInitialStage` (gated by `INCIDENT_LIFECYCLE_ENABLED`), which in turn (when enabled) drives the incident SM → ADR-034 write-back stage (gated by `rca_writeback_enabled`) → ADR-029/036 remediation PROPOSALS via the `action_catalog` (every row `enabled=false`, gated by `remediation_enabled`). No auto-apply (Rule 4).

- [ ] **Step 1: add the seam function to `web/lib/k8sgpt.ts`** — maps a finding to an `AlertEvent` and hands it to the EXISTING incident triage. It is gated TWICE (k8sgpt flag + incident flag) and NEVER auto-called:

```ts
import { triageAndCreateOrLink, enqueueInitialStage } from '@/lib/incident';
import type { AnalyzerResult } from '@/lib/k8sgpt-adapter';

/**
 * H3a SEAM (ADR-035 Rule 4/6) — turn a deterministic K8sGPT finding into an ADR-032 incident,
 * which (when incident_lifecycle_enabled) drives correlation/RCA → ADR-034 write-back → ADR-029/036
 * remediation PROPOSALS (catalog enabled=false, gated by remediation_enabled). NO auto-apply.
 *
 * GATED TWICE + NOT auto-called: returns {decision:'disabled'} unless BOTH K8SGPT_ENABLED and the
 * incident lifecycle gate are on. The route does NOT call this; it is invoked only from an explicit,
 * admin-initiated "raise incident" action (future H3a UI) so a finding never autonomously creates work.
 */
export async function raiseIncidentFromFinding(cluster: string, f: AnalyzerResult): Promise<{ decision: string; incidentId?: string }> {
  if (!enabled()) return { decision: 'disabled' };
  const event = {
    id: `k8sgpt:${cluster}:${f.fingerprint}`,
    source: 'generic' as const,           // ADR-032 trigger_source; K8sGPT is a sensor input
    severity: 'warning' as const,         // deterministic finding default; UI may override at raise-time
    services: [f.analyzer],
    resources: [`eks:${cluster}/${f.resourceName}`], // ADR-006 cross-boundary anchor (Rule 6)
    title: `[K8sGPT/${cluster}] ${f.analyzer} ${f.resourceName}`,
    description: f.errors.join('; '),     // deterministic fact only; NO LLM hypothesis crosses the seam
  };
  const tri = await triageAndCreateOrLink(event); // ADR-032 gate (INCIDENT_LIFECYCLE_ENABLED) inside
  if (tri.decision === 'New' && tri.incidentId) await enqueueInitialStage(tri.incidentId);
  return tri;
}
```

- [ ] **Step 2: confirm the AlertEvent shape** matches `web/lib/incident-normalize.ts` `AlertEvent` (adjust field names if the real type differs — e.g. `source`/`severity` literals). The seam carries ONLY deterministic facts across the boundary (Rule 6/8); the LLM hypothesis does NOT cross into the incident record. Run `npx tsc --noEmit`.
- [ ] **Step 3: document the seam** — a short "H3a remediation seam" subsection: the end-to-end gated path (K8s finding → `raiseIncidentFromFinding` → ADR-032 incident → ADR-034 write-back stage → ADR-029/036 catalog PROPOSAL), naming each gate that must be on (`k8sgpt_enabled`, `incident_lifecycle_enabled`, `rca_writeback_enabled`, `remediation_enabled` + per-catalog-row `enabled` + 4-eyes). Emphasize: PROPOSAL only, no auto-apply (Rule 4); the seam is not auto-invoked.
- [ ] **Step 4: (optional) test** the seam's flag-off behavior in `k8sgpt.test.ts` (`K8SGPT_ENABLED='false'` → `{decision:'disabled'}`, no incident call).
- [ ] **Step 5: commit** (`feat(v2-p3-k8sgpt): H3a seam — finding → ADR-032 incident → 034/029-036 gated proposal (thin, twice-gated, no auto-call)`).

---

### Task 9: Migration v7 — `k8s_findings` + `k8s_scan_runs` (always-present, inert when off)

**Files:**
- Modify: `terraform/foundation/data/schema.sql`

Append below the migration-v6 block. Mirrors the v4/v5/v6 "always-present, inert when off, idempotent" pattern. The `(cluster, fingerprint)` UNIQUE is the dedup key (Rule 11); `feedback` is the reserved H3b accuracy seam.

- [ ] **Step 1: append the v7 block to `data/schema.sql`**

```sql
-- ============================================================================
-- ADR-035 (migration v7): K8s-diagnosis DOMAIN STATE — always-present, inert when
-- k8sgpt_enabled=false. AWSops READS deterministic K8sGPT Result CRDs (out-of-band
-- operator, read-only) over the P3-D presigned-STS path and persists them here with
-- dedup (Rule 11). NO autonomous behavior; NO cluster write. The deterministic
-- analyzer columns (FACT) are kept distinct from the LLM narration column (HYPOTHESIS,
-- Rule 8). The feedback column is the reserved H3b accuracy-audit seam. Idempotent.
-- ============================================================================

-- 1) k8s_findings — one durable row per deduped finding (cluster, fingerprint).
--    Deterministic FACT columns (analyzer/error/details/parent_object) are distinct from the
--    HYPOTHESIS column (llm_explanation) — Rule 8 enforced at the schema level.
CREATE TABLE IF NOT EXISTS k8s_findings (
  id              UUID PRIMARY KEY,
  cluster         TEXT NOT NULL,
  namespace       TEXT NOT NULL DEFAULT '',
  kind            TEXT NOT NULL DEFAULT '',          -- analyzer kind (K8s resource kind)
  name            TEXT NOT NULL DEFAULT '',          -- resource the analyzer fired on (ns/name)
  analyzer        TEXT NOT NULL DEFAULT '',          -- which analyzer fired (FACT)
  error           JSONB NOT NULL DEFAULT '[]'::jsonb,-- deterministic error texts (FACT)
  details         TEXT NOT NULL DEFAULT '',          -- deterministic details (FACT)
  parent_object   TEXT NOT NULL DEFAULT '',          -- (FACT)
  fingerprint     TEXT NOT NULL,                     -- dedup id (Rule 11): sha256(analyzer+resource+errors)
  llm_explanation TEXT,                              -- Haiku narration (HYPOTHESIS, Rule 8; nullable)
  llm_model       TEXT,                              -- model id/version that produced the narration
  adapter_version TEXT,                              -- ADAPTER_K8SGPT_VERSION provenance (Rule 7)
  feedback        TEXT CHECK (feedback IN ('up','down')), -- H3b accuracy seam (thumbs up/down; reserved)
  first_seen      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (cluster, fingerprint)                      -- dedup: one row per stable finding (Rule 11)
);
CREATE INDEX IF NOT EXISTS idx_k8s_findings_cluster ON k8s_findings (cluster, last_seen DESC);

-- 2) k8s_scan_runs — last_scan_timestamp per cluster (Rule 9 staleness signal).
CREATE TABLE IF NOT EXISTS k8s_scan_runs (
  id                UUID PRIMARY KEY,
  cluster           TEXT NOT NULL,
  scanned_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  finding_count     INTEGER NOT NULL DEFAULT 0,
  operator_detected BOOLEAN NOT NULL DEFAULT false   -- false ⇒ operator down/absent (degrade, Rule 9)
);
CREATE INDEX IF NOT EXISTS idx_k8s_scan_runs_cluster ON k8s_scan_runs (cluster, scanned_at DESC);

INSERT INTO schema_migrations (version, description)
VALUES (7, 'ADR-035: K8s-diagnosis domain — k8s_findings (dedup fingerprint + fact/hypothesis split) + k8s_scan_runs (last_scan_timestamp/Rule 9), inert when off')
ON CONFLICT (version) DO NOTHING;
```

- [ ] **Step 2: verify** the SQL parses (it is `CREATE TABLE IF NOT EXISTS` + idempotent `ON CONFLICT`). If a local PG is available: `psql -f data/schema.sql` twice → no error, `SELECT * FROM schema_migrations` shows v7. Otherwise leave for the CONTROLLER task to apply.
- [ ] **Step 3: commit** (`feat(v2-p3-k8sgpt): migration v7 — k8s_findings (dedup + fact/hypothesis split) + k8s_scan_runs (always-present, inert)`).

---

### Task 10 (CONTROLLER): prove $0/dark when off, apply migration v7, verify the route is dark + no cluster read

> Controller runs this (shared infra + Aurora apply + idle-timeout-safe). Subagents stop at Task 9.

- [ ] **Step 1: prove No-changes / $0 when off** — with `k8sgpt_enabled=false` (default):
  ```
  terraform -chdir=terraform/foundation plan
  ```
  Expected: **No changes** for the gated resources (`aws_budgets_budget.k8sgpt_bedrock` shows `count=0`). The web task def env diff, if any, MUST NOT add `K8SGPT_ENABLED` when off. Confirm $0 (the only gated resource is count=0).
- [ ] **Step 2: apply migration v7** — run `data/schema.sql` against Aurora (the same mechanism prior migrations used; idempotent). Verify `SELECT version, description FROM schema_migrations ORDER BY version` ends at **7** and `k8s_findings` / `k8s_scan_runs` exist and are EMPTY.
- [ ] **Step 3: verify the route is dark + reads nothing from the cluster (flag off)** — with the deployed web (K8SGPT_ENABLED absent), as an admin:
  ```
  curl -s -H "Cookie: awsops_token=<id>" https://awsops-v2.example.com/api/eks/fsi-demo-cluster/k8sgpt
  ```
  Expected: `503 {"enabled":false,...}`. Confirm via CloudWatch/logs that **NO `DescribeCluster`, NO STS presign, NO `InvokeAgentRuntime`** fired (the route short-circuits before `getDiagnosis` touches the cluster). Confirm `k8s_findings` is still EMPTY (no scan persisted).
- [ ] **Step 4: confirm NO cluster write at any point** — review `web/lib/eks-incluster.ts` (`grep -n "method:"` → only `'GET'`) and confirm `k8sgpt.tf` provisions no resource targeting the EKS cluster (only the budget alarm). AWSops issues ONLY HTTP GET; the operator install + RBAC are out-of-band (runbook).
- [ ] **Step 5 (optional, flag-on smoke — only with operator pre-installed out-of-band):** set `k8sgpt_enabled=true` in a throwaway plan, confirm the budget alarm is the ONLY new resource; if an operator is live on `fsi-demo-cluster`, hit the route → expect deterministic `analyzer_result` facts + (on first sight) a Haiku `llm_explanation`, separated. Then revert to off.
- [ ] **Step 6: run the full web test suite** — `cd /home/atomoh/awsops/web && npx vitest run` → all green (adapter + k8sgpt + unchanged eks-incluster/incident/remediation).

---

## Self-Review

**Rule / phase → task mapping (confirm before declaring done):**

| Rule / phase | Where it lives | Task |
|---|---|---|
| **H1** — read deterministic Result CRDs (operator out-of-band) | `listK8sgptResults` (P3-D STS path) + operator runbook | 2, 7 |
| **H2** — adapter + Container-agent enrichment + read-only UI | adapter, `k8sgpt.ts` narration, EKS-page panel | 1, 3, 5 |
| **H3a seam** — finding → 032 incident → 034 write-back → 029/036 PROPOSAL | `raiseIncidentFromFinding` (twice-gated, not auto-called) + doc | 8 |
| **Rule 6** — cross-boundary correlation (IRSA/IAM/SG/RDS/cost) | seam carries `resources: eks:<cluster>/<resource>` anchor into ADR-032 (which fans out to AWS-substrate sub-agents); UI shows facts for the Container agent to enrich | 5, 8 |
| **Rule 7** — versioned adapter + pinned version + schema-compat test | `k8sgpt-adapter.ts` (`ADAPTER_K8SGPT_VERSION`) + adapter test using H0 real shape | 1, 7 |
| **Rule 8** — fact (`analyzer_result`) vs hypothesis (`llm_explanation`) separate; deterministic wins; UI "AI hypothesis" | `DiagnosisFinding` two-field shape; schema `error`(fact) vs `llm_explanation`(hypothesis); UI badge | 3, 5, 9 |
| **Rule 9** — read-only + fail-safe + `last_scan_timestamp` + stale(>5m) degrade | `getDiagnosis` try/catch degrade, `k8s_scan_runs`, stale banner; operator read-only RBAC + `--fix` off (runbook) | 3, 5, 7, 9 |
| **Rule 11** — scan-interval config + dedup (no re-narrate) + monthly Bedrock budget alarm | dedup via `(cluster,fingerprint)` + COALESCE narration reuse; gated `aws_budgets_budget` | 3, 6, 9 |
| **Flag-off ⇒ dark + $0 + NO cluster write** | `K8SGPT_ENABLED` env gate (route 503, `getDiagnosis` no-op), `count=local.k8s`, GET-only | 4, 6, 10 |

**Placeholder scan:** grep the new files for `TODO`/`PLACEHOLDER`/`FIXME`/`<...>` — there must be NONE in `.ts`/`.sql`/`.hcl` (the only `<...>` permitted is in the **out-of-band runbook** doc, where the operator fills in the pinned version + the P1e-mapped group). Confirm `ADAPTER_K8SGPT_VERSION` (code) and `PINNED_OPERATOR_VERSION` (runbook) are documented to be kept in sync.

**Flag-off invariants re-verified (BINDING):**
- `terraform plan` with `k8sgpt_enabled=false` ⇒ **No changes** for gated infra (the one gated resource is `count=0`) ⇒ **$0**. (Task 10 Step 1)
- The route returns **503 `{enabled:false}`** and `getDiagnosis` performs **NO** cluster read / STS presign / Bedrock call when off. (Task 3 test + Task 10 Step 3)
- The always-present `k8s_findings`/`k8s_scan_runs` tables stay **empty + inert** when off. (Task 10 Step 2)
- AWSops issues **ONLY HTTP GET** against the cluster — **NO cluster write** anywhere; the operator install + RBAC binding are **out-of-band** (runbook, mirrors ADR-029 §7). (Task 7, Task 10 Step 4)
- K8sGPT runs **deterministic-only** — AWSops never calls `--explain`/`ai.backend`/its MCP server (H0 refinement). (Tasks 1/3/7 contracts)
- **No auto-remediation** — H3a produces gated PROPOSALS only; the seam is twice-gated and not auto-invoked (Rule 4). (Task 8)
