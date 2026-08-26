# AWSops v2 — AI Diagnosis (AI 종합진단) Design Spec

> Status: **DRAFT for multi-AI consensus gate** · 2026-06-11 · branch `feat/v2-architecture-design`
> Brainstorm + `/co-agent:consensus` (kiro opus-4.8/kimi-k2.5/glm-5 + codex + gemini)

## 1. Goal & context

The 2026-06-10 v1→v2 gap audit ranks **"AI 종합진단 + 리포트 (15-section Opus) — entire domain absent"** as the **#1 P0 gap**. v1 had `src/app/ai-diagnosis/` (15-section Opus report, DOCX/PPTX/PDF export, S3 persistence, weekly/biweekly/monthly cron scheduling). v2 (`web/`) has **none of it**: no page, no nav item, worker registry is `{noop, noop-heavy}` only, zero report job type / deps.

This is squarely aligned with the post-2026-06-11 reversal posture: **AWSops is a read-only ops dashboard + AI diagnosis** (mutation/autonomy/BYO-MCP are do-not-pursue). A comprehensive read-only diagnostic report is exactly the kind of AI capability that *should* exist.

**Objective: not just restore v1 — exceed it.** The user wants a diagnosis that ingests *as much data as possible* and is genuinely deeper than v1's single-pass Steampipe report.

## 2. The expanded data vision (user steer)

A precise diagnosis must combine, comprehensively:
- **Resource inventory** (what exists)
- **Resource usage / utilization** (CPU, memory)
- **Disk usage**
- **Data flow & traffic flow** (network paths, throughput)
- **Cost** (Cost Explorer — spend, trend, forecast, waste)
- **External logs** — **Datadog, ClickHouse, Prometheus, Loki** — analyze frequent **WARN / ERROR** patterns
- **Traces** (latency, error spans)

And expose **diagnosis depth tiers**: **light / mid / deep**.

## 3. What v2 has TODAY (verified by grep/Read)

| Dimension | v2 source today | State |
|---|---|---|
| Resource inventory (22 types) | Aurora `inventory_resources` (ec2/lambda/ecs/ecr/s3/ebs/rds/dynamodb/vpc/subnet/sg/iam_role/iam_user/cloudfront/alb/nlb/waf/cloudtrail/elasticache/opensearch/msk/cloudwatch_alarm) | ✅ always-on |
| Resource usage (CPU/mem) | `web/lib/metrics.ts` CloudWatch `GetMetricData` (SDK, task role) | ✅ live |
| Cost | `web/lib/aws.ts` `getMtdCost` + `getCostTrend` (Cost Explorer) | ✅ MTD + trend |
| Network/traffic live query | AgentCore **network** gateway (flow-monitor tool) | ✅ 1 of 9 GW active |
| IAM/security posture live query | AgentCore **security** gateway (iam-mcp 14 tools) | ✅ 2 of 9 GW active |
| EKS in-cluster (nodes/pods/deploy/svc) | `web/lib/eks-incluster.ts` (read-only, task-role Access Entry) | ✅ |
| Incidents / triage / k8s findings | Aurora `incidents`, `incident_findings`, `k8s_findings`, `alert_diagnosis` | ✅ read-only |
| Async heavy-work backbone | P2 workers: `POST /api/jobs` → `worker_jobs` → SQS → SFN → Lambda/Fargate, `artifact_uri`→S3 | ✅ W9 GREEN |

**NOT in v2 yet:** external observability (Prometheus/Tempo/Loki) — `external-obs` GW undeployed; **Datadog / ClickHouse** — never integrated (new); CIS benchmark; optimize collectors (eks/db/msk/idle).

## 4. Architecture

> **Refined after consensus round 1 + user steer (2026-06-11):** native-first, but external sources are a **first-class, infinitely-extensible plane routed through the AgentCore `external-obs` gateway** (many orgs use NO native CloudWatch and live entirely in Datadog/Loki/etc. — external must not be a second-class afterthought). Plus an **architecture-diagram Knowledge Base** grounds the diagnosis (intended-vs-actual).

### 4.1 Two-plane pluggable source aggregator (graceful degradation)
`web/lib/diagnosis/sources/` — a registry of source adapters. Each:
```
interface DiagnosisSource {
  key: string;                       // 'inventory'|'cloudwatch-metrics'|'cloudwatch-logs'|'cost'|'securityhub'|'health'|'external-obs'|...
  plane: 'native' | 'external-obs';  // where it runs
  tiers: ('light'|'mid'|'deep')[];   // which tiers invoke it
  requiredConfig?: string[];         // SSM/Secrets keys; absent → degraded
  collect(ctx, tier): Promise<SourceResult>;   // { ok, data, degraded, notes, evidence[] }
}
```
A missing/unconfigured source returns `{ ok:false, degraded:true, notes:'source X not configured' }`; the section renders a **"data unavailable"** note rather than failing.

> **PII-minimizing scope decision (user steer 2026-06-11):** lean on **metrics + AWS-native + service-map/topology** data, NOT raw log payloads. Raw-log WARN/ERR ingestion (Loki/ClickHouse/Datadog-Logs/CW-Logs raw excerpts) is **deferred to fast-follow with mandatory redaction** — it is the dominant PII vector. The MVP's "data flow / traffic flow" dimension is delivered by **service maps** (aggregated topology + RED metrics: req/s, error-rate, p99 per edge) which carry no log payloads.

**Plane A — Native AWS (BFF/worker via task-role SDK, always-on baseline):**
Aurora inventory (22 types) · CloudWatch **metrics** (`GetMetricData`) · **AWS X-Ray / CloudWatch Application Signals service map** (native topology + RED metrics — the "actual traffic flow" source; OTel can feed App Signals) · VPC/Flow-Log topology **aggregated to edges** (not raw flows) · Cost Explorer (MTD/trend) + **Compute Optimizer / `ce:GetRightsizingRecommendation`** · **Security Hub + AWS Config** (CIS/drift, replaces v1 benchmark) · **AWS Health** + **CloudTrail LookupEvents** (what changed) · GuardDuty (threats) · EKS in-cluster · incidents/k8s findings. *Aggregated* CW Logs error-COUNTS per log group are low-PII and allowed; raw log lines are not (fast-follow).

**Plane B — External via AgentCore `external-obs` gateway (the extensibility engine):**
**MVP scope = service-map / dependency-topology / trace-derived RED metrics only** — **Datadog APM Service Map** and **OpenTelemetry service graph / span metrics**. These are the external counterparts of X-Ray/App Signals and give actual traffic flow **without raw-log PII**. **Raw-log providers (Loki/ClickHouse/Datadog Logs) are explicitly OUT of MVP** (PII; fast-follow with redaction). Each source = an MCP tool Lambda registered as a target on `awsops-external-obs-gateway`; the aggregator holds ONE `external-obs` adapter that **discovers (cached, fail-degraded)** the gateway's `readOnly`-allowlisted tools and calls them abstractly. **Adding a datasource = adding a gateway target — zero web/worker code change.** Gateway/MCP-Lambda tier is the enforced **chokepoint**: read-only creds (Secrets Manager), redaction, per-query row/byte/time caps, egress allowlist. Deep-tier high-volume runs invoke targets with bounded concurrency on Fargate (not serialized through the gateway hop). When an org runs no native AWS telemetry, Plane B becomes its primary source and Plane A degrades gracefully.

### 4.0 Diagnosis as a CONSULTANT workflow (two-phase) — the core methodology
> **User steer (2026-06-11, domain expert):** *"Topology alone is insufficient. A proper diagnosis always interviews the customer while co-drawing the architecture diagram."* Telemetry/topology is the **skeleton**; **intent, constraints, SLAs, ownership, and "is this deliberate or accidental?"** live only in the operator's head. The product must act as a **consultant**, not a scanner.

**Phase 1 — Architecture Discovery + Interview (build the *intended* model):**
1. **Auto-discover the actual topology** — service map (X-Ray/App Signals; Datadog/OTel external) + inventory + flow-log edges + posture → a **draft diagram**.
2. **AI-driven structured interview** (reuses the existing `/assistant` chat infra + `chat_threads`/`chat_messages`): the AI acts as a consultant — it *proposes* what it found and asks the operator to confirm/correct/annotate, progressively, not a blank-slate questionnaire. It captures: component purpose, **intended data/traffic flows** (who *should* talk to whom), constraints/invariants (public-facing-by-design? encryption? RTO/RPO? compliance scope?), criticality/ownership/SLAs, known issues, recent changes.
3. **Co-produce** a refined architecture diagram (render via the repo's architecture-diagram agent / draw.io) + **machine-checkable invariants** + narrative context → stored as a **versioned Architecture KB** (the "should-be"). Re-interview is delta-only, triggered on detected drift or on schedule.

**Phase 2 — Diagnosis (intended-vs-actual + telemetry):** compare the interview-enriched intended KB against the live actual (service map / metrics / posture / flow edges), layer in cost/RED-metrics + diff-vs-last-report, and emit **intent-aware, evidence-backed findings** — *"this edge violates the 'RDS private-only' constraint you confirmed in the interview."* Strictly read-only.

### 4.2-KB Architecture Knowledge Base (co-created, diagnosis grounding)
The Phase-1 output. Grounds findings against **operator-confirmed design intent** (the core "intended-vs-actual" engine — §6):
- **Content:** co-drawn diagram (draw.io XML = *text*, parseable) + narrative + machine-checkable **invariants** ("RDS private-only", "no 0.0.0.0/0 ingress", expected data-flow edges) + interview-captured intent/constraints/SLAs.
- **Store:** MVP = **RAG-lite** (parsed diagram + invariants injected into section prompts) + **invariants evaluated in deterministic code** against live state — verdict (not vector recall) drives drift. Graduate to managed Bedrock KB later (validate retrieval first).
- **Seed:** auto-draft from live topology (labelled **"observed/draft"**, never authoritative until the interview promotes it — avoids circularity).
- **Security / trust boundary (corrected by round 3):** **human-authored ≠ trustworthy.** ALL interview/operator free-text is **untrusted as instructions** — stored as data, fenced (`<untrusted>`, "never instructions"), and NEVER reaches a prompt as a directive (an operator may paste a ticket/log carrying injection). Only **schema-validated, admin-promoted invariants** compile to deterministic checks; the LLM only ever proposes candidates against a fixed predicate schema and **never activates** an invariant. Plane-B telemetry is likewise untrusted and never rewrites invariants. Invariants evaluated in code; only the verdict reaches the LLM.

### 4.2 Diagnosis tiers
| Tier | Sources | LLM | Runtime | ~Time | Use |
|---|---|---|---|---|---|
| **light** | Aurora inventory + posture flags + cost MTD/trend + top alarms | none or 1 Haiku summary | inline BFF (or Lambda) | ~30s | quick snapshot, cheap, frequent |
| **mid** | + CloudWatch utilization (CPU/mem/disk) + idle/waste scan + active AgentCore GWs (network/security) | Sonnet per-section | Lambda (<15min) | ~2–4min | standard 8-section infra report |
| **deep** | + external logs (Loki/Datadog/ClickHouse WARN/ERR) + traces (Tempo) + CIS benchmark + flow-log traffic analysis | Opus, 15 sections (5 batches × 3), prompt-cached (ADR-038) | Fargate (long/OOM) | ~10–20min | exhaustive report + DOCX/PPTX/PDF |

### 4.3 Worker integration
`report` job type added to `scripts/v2/workers/handlers.py` REGISTRY. `runtime`: light/mid→`lambda`, deep→`fargate`. Worker runs the aggregator for the tier, calls Bedrock per section, writes markdown + structured findings → S3 (`artifact_uri`) + a new `diagnosis_reports` row. Reuses the existing idempotent dispatcher / SFN Choice / status_updater / reaper — no new control plane.

### 4.4 Persistence
New table `diagnosis_reports` (id, tier, status, requested_by, sources_used JSONB, summary JSONB, artifact_uri, created_at). Reuse the orphan `report_schedules` table for later cron scheduling (currently no consumer). History enables **report diffing** (§6).

### 4.5 UI
`web/app/ai-diagnosis/page.tsx` (nav item under a new top-level "AI" or beside Overview): tier selector (light/mid/deep), Run (enqueues job, polls `/api/jobs/[id]`), history list, viewer with TOC sidebar + streaming markdown render, **Markdown download** (MVP). DOCX/PPTX/PDF = deep-tier follow-up. Scheduling UI = follow-up (admin-only).

## 5. External log analysis (Datadog / ClickHouse / Prometheus / Loki)

Each as a source adapter querying for **frequent WARN/ERROR** over a window:
- **Loki** — LogQL `sum by (level) (count_over_time({...} |= "error" [1h]))`, top error lines.
- **Prometheus** — PromQL error-rate / alert-firing (reuse v1 `eks-optimize` queries).
- **Datadog** — Logs Aggregation API (`/api/v2/logs/analytics/aggregate`) facet by status/service, top error patterns.
- **ClickHouse** — parameterized read-only SQL against a logs table (top messages by count where level in warn/error).
- **Tempo/Jaeger** — error-span sampling (reuse v1 `trace-analyze` collector).

Config: endpoint + credentials in **Secrets Manager** (never env); a new `external_datasources` table or SSM holds non-secret config (endpoint, dataset/table, default labels). All adapters are **read-only** (query APIs only). Absent config → tier degrades.

## 6. How v2 EXCEEDS v1
**Primary differentiator (panel consensus = report diffing, elevated by user steer to):** **Intended-vs-Actual topology gap analysis.** The architecture-diagram KB (§4.2-KB) is the "should-be" topology + invariants; the "is" is the **actual service map** (X-Ray/App Signals natively, Datadog/OTel externally) + aggregated VPC/flow-log edges + inventory. Diagnosis = the gap, with explainable per-section severity — *"service A→RDS edge exists but the architecture declares RDS private-only → CRITICAL drift"* — evaluated in deterministic code, not from raw untrusted text. Strictly read-only (no autonomy).
- **Report diffing / regression detection** — "what changed/regressed since last run" (v1 had no history/diff).
- **Tiered depth** (light/mid/deep) vs v1's single mode.
- **Infinitely-extensible external plane** via the external-obs gateway (§4.1 Plane B) — orgs that live in Datadog/Loki are first-class.
- **Prompt caching (ADR-038)** — cheaper/faster Opus; **MapReduce log summarization** (Haiku → Opus) to fit context.
- **Cross-link to incidents & k8s findings** already in Aurora; **evidence-backed findings** (source, resource_arn, query, window, confidence).
- **Async on the OOM-safe worker tier** — v1 ran in-process.

## 7. Consensus — round 1 (RESOLVED)
Panel (kiro-opus4.8 · codex-gpt5.5 · gemini · kiro-kimi; 4/5 quorum, glm-5 lost stdin):
1. **Sources:** native-first — CloudWatch Logs Insights, Security Hub/Config, Compute Optimizer + Health/CloudTrail/GuardDuty; external SaaS deferred & "only the stack the org runs". *(refined: see §4.1 Plane B — external is first-class via gateway, but native is the baseline.)*
2. **Tiering:** keep light/mid/deep, implement as time-budget + source-allowlist (registry-driven); section-scope later.
3. **Beat v1:** report diffing/regression = top differentiator *(elevated to intended-vs-actual, §6)*; avoid anomaly/remediation-backlog (autonomy).
4. **Security:** PII redaction before Bedrock; read-only enforced at credential/IAM layer; egress allowlist; per-source caps; deep = admin-gate + cooldown; evidence-backed findings.
5. **Schema:** new `diagnosis_reports` (FK `worker_job_id`, `parent_report_id` for diff lineage); reuse orphan `report_schedules`; don't overload `worker_jobs`.
6. **MVP:** mid-tier, 8 infra sections, Aurora + CloudWatch(metrics+Logs Insights) + Cost + active GW + incidents/k8s + diff-vs-previous; page+viewer+MD; async on workers.

## 8. Open questions FOR CONSENSUS ROUND 2 (the two new elements)
1. **External-obs gateway as the ingestion plane (§4.1 Plane B):** Is routing ALL external datasources (Datadog/ClickHouse/Loki/…) through MCP tool Lambdas behind the `external-obs` AgentCore gateway — with redaction/read-only/caps enforced at that tier — the right extensibility + security model? Pitfalls (latency, gateway throttling, MCP tool sprawl, dynamic-discovery failure modes)? Better alternative for the "org uses zero native CloudWatch" case?
2. **Architecture-diagram KB grounding (§4.2-KB):** Is parsing draw.io XML + invariants into a KB (Bedrock KB vs AgentCore Memory vs RAG-lite prompt injection) sound for "intended-vs-actual" diagnosis? KB freshness/staleness risk, drift between KB and reality, KB-poisoning trust boundary (must Plane-B log data never mutate invariants)? Is auto-generating the intended diagram from live inventory circular (actual≈intended)?
3. **Revised MVP with these in:** Does adding (a) one Plane-B external adapter via the gateway and (b) RAG-lite arch-KB grounding to the round-1 MVP overload the first slice, or is it the right "beats v1 decisively" cut? What should be cut to fast-follow?
4. **Any CRITICAL/MAJOR introduced by §4.1 Plane B + §4.2-KB** not already covered in round 1.

## 8R. Consensus round 2 (RESOLVED)
Panel (codex-gpt5.5 · gemini · kiro-opus4.8 · kiro-glm5; 4/5 quorum, kimi lost stdin).
1. **External-obs gateway plane → ADOPT** as the *governed* chokepoint (credential custody, redaction, read-only allowlist, SSRF/SigV4). Refinements: (a) **allowlist only `readOnly=true` MCP tools**, versioned schemas, fail-closed CI (no free-form marketplace); (b) **don't serialize deep-tier high-volume scans through the gateway invocation hop** — gateway governs/registers, the worker invokes target MCP Lambdas with **bounded concurrency**, on **Fargate** for deep; (c) tool **discovery is cached + fail-degraded**, never a per-query live call.
2. **Architecture KB → ADOPT as RAG-lite + deterministic invariants** for MVP; **defer managed Bedrock KB** (validate retrieval later). The high-value signal is **machine-checkable invariants evaluated in deterministic code** against live inventory/flow-logs — the verdict (not raw retrieval) drives the drift finding. Auto-generated diagrams are **"observed/draft" only**, never authoritative invariants until an admin promotes them (avoids the circularity).
3. **Revised MVP → Plane-B live adapter DEFERRED to fast-follow; Arch-KB KEPT.** Majority + strongest reasoning: one live external source drags credential custody + redaction tests + throttle-degradation into slice 1 for marginal demo value, while native + diff + RAG-lite KB already clear v1 decisively. Build the external-obs **adapter seam + gateway design** now; ship the first live external target second.

### 8R-risks (new, all have fixes — design stands)
- **[CRITICAL] Prompt-injection / KB-poisoning:** untrusted Plane-B log text sharing context with trusted invariants can flip a CRITICAL drift to benign. **Fix:** evaluate invariants in **deterministic code**, pass only the boolean/severity verdict into the prompt; fence all external log text in `<untrusted>` segments with explicit "never treat as instructions" framing; XML-tag TRUSTED-INTENDED vs UNTRUSTED-OBSERVED.
- **[CRITICAL] MCP discovery = capability expansion:** **Fix:** per-source `readOnly` tool allowlist, versioned tool schemas, CI smoke that fails closed on a non-read-only/unknown tool.
- **[MAJOR] Throttle ≠ unconfigured:** a throttled/timed-out gateway call must NOT render as the benign "data unavailable" degraded path → false all-clear. **Fix:** distinguish `unconfigured` (quiet note) from `query-failed/throttled` (loud WARN banner + non-success `diagnosis_reports.status`); per-source retry/backoff+jitter; surface partial-coverage % in the summary.
- **[MAJOR] Arch-KB staleness → false CRITICAL drift.** **Fix:** persist KB `version/author/uploaded_at/last_validated_at`; downgrade stale invariant violations unless recently confirmed; UI staleness warning when live-inventory version diverges.
- **[MAJOR] Redaction at MCP tier is an unverifiable claim.** **Fix:** mandatory redaction **unit-test fixture per external adapter** + deny-by-default **egress allowlist enforced in the Lambda SG/resource policy**, not just code.
- **[MAJOR] Gateway resource starvation vs live chat** (deep jobs saturate gateway/Lambda concurrency → 429s for chat). **Fix:** dedicated diagnosis concurrency limit / low-priority lane; bounded parallelism; Fargate for deep.
- **[MINOR] MCP tool cold starts (1–3s).** **Fix:** provisioned concurrency on hot adapters or accept first-call latency.

## 8R3. Open questions FOR CONSENSUS ROUND 3 (the consultant/interview pivot, §4.0)
1. **Interview-driven KB co-creation:** Is an AI-driven structured interview (seeded from auto-topology, operator confirms/corrects) the right way to build the "intended" model — vs upload-only or auto-only? How to avoid interview fatigue (progressive "propose & confirm" vs questionnaire)? How many questions before value?
2. **MVP placement of Phase 1:** Does the interview belong in the MVP, or ship Phase-2 diagnosis on auto-topology first and add interview enrichment next? The user implies interview is essential to a *proper* diagnosis — but is a SHORT "confirm the auto-drafted invariants" interview enough for slice 1, with deep interview as fast-follow?
3. **Merging interview answers + auto-topology into invariants:** how to reconcile operator statements with discovered reality without the LLM fabricating invariants? (Proposed: AI proposes candidate invariants from topology; operator accepts/edits; accepted ones become deterministic checks.)
4. **KB freshness via interview:** delta re-interview on drift — does this scale, and how to avoid nagging? Any new CRITICAL/MAJOR from the interview/KB-co-creation loop.

## 8R3. Consensus round 3 (RESOLVED — consultant/interview pivot)
Panel (codex-gpt5.5 · gemini · kiro-opus4.8 · kiro-glm5; 4/5 quorum, kimi lost stdin). **Unanimous on all four.**
1. **Method = "propose & confirm"** (not blank questionnaire): AI extracts candidate invariants from auto-topology, operator reviews; order by drift-risk (public ingress, RDS exposure, cross-tier edges first); ~5–12 confirmations/session; value at the first confirmed invariant.
2. **Phase 1 IN the MVP, but only the SHORT "confirm-the-drafted-invariants" flow** (admin-gated). Without it, intended-vs-actual is circular/inert. Full consultant interview (narrative/SLA/ownership/co-drawing) + delta re-interview = fast-follow.
3. **Anti-fabrication:** LLM proposes candidates **against a fixed predicate schema/enum only** (never free-form executable logic); **operator (admin) explicitly accepts/edits → promotes**; deterministic code evaluates; only the verdict reaches the diagnosis LLM. Record provenance (AI-proposed vs human-authored).
4. **Freshness = drift/finding-driven delta re-interview** (NOT schedule-polling): trigger only when a live change violates an existing invariant or adds a significant edge; debounce/batch; staleness-downgrade; allow "unknown/NA".

### 8R3-risks (new — all have fixes)
- **[CRITICAL] LLM invariant fabrication** → only operator-accepted candidates become invariants; LLM never activates; provenance stored.
- **[CRITICAL] Prompt-injection via operator interview text** ("human-authored ≠ trustworthy") → treat all interview free-text as data, fence `<untrusted>`, never as instructions; only schema-validated promoted invariants drive checks. *(corrects §4.2-KB)*
- **[CRITICAL/MAJOR] Circularity / confirmation bias** — AI proposes an invariant from a *current misconfiguration* (accidentally-public DB) → operator rubber-stamps → bug codified as intent. → AI flags **"Heuristic Risk"** during interview ("this is currently public; confirming makes it intended — proceed?"); **per-item explicit accept for risky/security items (no bulk-accept)**; severity-cap AI-proposed-accepted until re-confirmed.
- **[MAJOR] Interview fatigue → empty KB → silent topology-only degrade** → persist partial progress, surface coverage %, never block the report on a complete interview, max-question budget.
- **[MAJOR] Trust model — who may define intent** → admin/architecture-owner promotion only (gate via `web/lib/admin.ts`); non-owner answers stay draft annotations.
- **[MAJOR] KB staleness** → bind each invariant to the **topology fingerprint** it was confirmed against; auto-expire/flag on divergence; unified **`ArchitectureIntent` JSON doc** as the KB's single source of truth (prose + diagram XML + invariants + metadata bundled, versioned).

## 9. FINAL MVP (consensus-locked — 3 rounds, no unresolved CRITICAL)
**Scope (slice 1 — "decisively beats v1"):**
- **Tier:** `mid` (registry-driven = time-budget + native source-allowlist). `light` cheap path included; `deep`/Opus-15/exports = fast-follow.
- **Sources (Plane A native, PII-minimizing — metrics/topology/posture, no raw logs):** Aurora inventory (22) · CloudWatch **metrics** · **X-Ray / CloudWatch Application Signals service map** (actual traffic flow: topology + RED metrics) · VPC/Flow-Log topology **aggregated to edges** · Cost Explorer MTD/trend (+ Compute Optimizer if cheap) · Security Hub/Config posture · active AgentCore network/security GWs · incidents + k8s findings · CloudTrail LookupEvents (what-changed) · *aggregated* CW Logs error-counts (raw log excerpts = fast-follow with redaction).
- **External (Plane B):** **service-map only** — Datadog Service Map / OTel service graph adapter **seam built**; first live external target is fast-follow. Raw-log providers explicitly deferred.
- **Phase 1 (IN MVP, SHORT, admin-gated):** auto-draft topology → AI proposes ~5–12 candidate invariants (drift-risk ordered) against a **fixed predicate schema** → admin **confirms/edits/promotes** (per-item accept for risky items; **"Heuristic Risk" flag** when a candidate reflects a *current* misconfig) → stored as a versioned **`ArchitectureIntent` JSON doc** (diagram XML + invariants + metadata, bound to a **topology fingerprint**). Full narrative/SLA/ownership interview + co-drawing = fast-follow.
- **Differentiator (Phase 2):** **intended-vs-actual** — invariants from the `ArchitectureIntent` doc evaluated in **deterministic code** against live state (verdict → LLM, never raw untrusted text) + **report diff vs previous** (regression), explainable per-section severity, **evidence-backed findings** (source/resource_arn/query/window/confidence).
- **Delivery:** `web/app/ai-diagnosis/page.tsx` (nav item) — Phase-1 invariant-confirm panel (admin), tier selector, Run (enqueue → poll `/api/jobs/[id]`), history list, viewer (TOC + streaming markdown), **Markdown download**. Admin-gate `deep` + Phase-1 authoring.
- **Backbone:** new `report` job type in `scripts/v2/workers/handlers.py` (mid→Lambda, deep→Fargate); reuse dispatcher/SFN/status_updater/reaper; artifact→S3.
- **Schema:** new `diagnosis_reports` (FK `worker_job_id`, `parent_report_id`, `sources_used` JSONB, `summary` JSONB, `tier`, `status`); new `architecture_intent` (versioned JSON doc + `topology_fingerprint` + provenance + `last_validated_at`); reuse orphan `report_schedules` for cron later.
- **Seams built, not shipped live:** external-obs Plane-B adapter interface + gateway target design; managed Bedrock KB; full consultant interview + delta re-interview; DOCX/PPTX/PDF; scheduling UI.

**Security controls (mandatory in slice 1):** all interview/operator free-text treated as **untrusted data** (fenced, never instructions); only schema-validated, **admin-promoted** invariants drive deterministic checks (LLM never activates/fabricates); PII/secret redaction before any Bedrock call; read-only at the IAM layer; per-source row/byte/time caps; idempotent report jobs deduped on `(tier, requested_by, window)`; `unconfigured` vs `throttled/failed` distinguished (no false all-clear); deep admin-gated + cooldown.

