---
sidebar_position: 7
title: Key Architecture Decisions FAQ
description: The core architecture decisions (ADRs) behind AWSops, framed as operator Q&A — read-only posture, external-write governance, AI routing/diagnosis, infrastructure shape, and cost/security/operations decisions.
---

# Key Architecture Decisions FAQ

This page distills the design decisions (ADRs — Architecture Decision Records) that determine *why AWSops behaves the way it does*, in the form of the questions operators ask most. Each answer cites the underlying ADR number.

The full decision log and detailed context live in `docs/decisions/` (ADR 001–044); the index and correction notes are in `docs/decisions/CLAUDE.md`.

:::info
AWSops's most important principle is **read-only**. But that constraint is bound precisely to **AWS-resource mutation + autonomy** (ADR-041). External observability **data reads** and governed external **data writes** are *not* covered by it — they are data operations, not AWS-resource changes.
:::

## Security

### Does AWSops change AWS resources directly, or take automated action?

**No. AWS-resource mutation and autonomy are permanently frozen (do-not-enable).**

A mutating-action framework (ADR-029) and an execution substrate (SSM Automation + Change Manager × P2-worker hybrid, ADR-036) were designed, but **both were REVERSED by 3-AI consensus on 2026-06-11**. The code is retained in a dark state, but the flags are permanently OFF — it is never enabled.

- **AWS-resource changes** — stopping an EC2 instance, modifying an SG, scaling, deploying — are performed by no screen and no AI feature.
- All ~120 AgentCore MCP tools are read-only.

:::info
The scope of the "freeze" is **AWS-resources only** (ADR-029/036 scope clarification 2026-06-16; ADR-041 keystone). The controls layer and the worker execution branch may be reused for non-AWS external data writes, but the AWS-resource automation substrate itself stays frozen.
:::

### Are writes to external systems like Slack / Jira also blocked?

**No — they are allowed under governance.** They are **data records**, not AWS-resource changes (ADR-040, ADR-041).

After the 2026-06-11 reversal, ADR-040 carved out a narrow allowance for **non-AWS-resource external knowledge/comms writes** (records and messages to Slack, Notion, Confluence, Jira, ServiceNow), and ADR-041 re-anchored this as the keystone: read-only constraint = AWS-resource mutation + autonomy, **external data integration (read + write) excluded**.

- Leaving a report, ticket, or message in an external system is possible under governance controls.
- No path — **none** — grants permission to change the AWS infrastructure itself.

### Could internal information leak when writing externally?

External data writes are designed to operate only under ADR-040's **seven hard conditions**. The key guards are:

- **DLP / redaction** — strips sensitive information from outbound content (strongly emphasized, as it was the dissent's core concern)
- **Destination allowlist** — sends only to approved external destinations
- **SSRF guard** — blocks metadata/IMDS and internal endpoints
- **Secrets in Secrets Manager**
- **Human-gate** — sent only after human approval (or a draft-only fallback)
- **Non-AWS-resource only** + **flag-OFF by default**

:::tip
To stay coherent with the 2026-06-11 consensus (which explicitly named external-endpoint/egress/SSRF as scope-creep), ADR-041 records this allowance as an **owner-override**, not a "clarification" (addendum applied). In other words, external writes are not an "exception" but a data-write standard *under* a controls mandate.
:::

### How was login decided?

AWSops uses an **in-app login form** (`/login`) (ADR-042).

The self-hosted `/login` form calls the BFF `POST /api/auth/login` → authenticates via the unsigned public Cognito `InitiateAuth(USER_PASSWORD_AUTH)` → mints an `awsops_token` cookie (id_token, 12 hours). Every subsequent request is checked by Lambda@Edge with **RS256 JWKS signature verification**. The Hosted UI PKCE flow is retained only as a dark fallback.

This refines ADR-020 (Cognito + Lambda@Edge) on top of the ADR-037 foundation, following least privilege (no REFRESH granted).

### How is admin access controlled?

A **server-side, fail-closed gate** (ADR-023).

Admin features are allowed only for users who are members of the Cognito `admins` **group** or who appear on the SSM **admin-email allowlist**. If neither check confirms the user, access is denied by default (fail-closed).

## Architecture

### Why isn't the infrastructure a single EC2 instance?

AWSops rebuilt v1's **single-EC2 monolith** into a **Terraform-based MSA** (ADR-037, ADR-030).

- **IaC**: Terraform (partial S3 backend). CDK is dropped (ADR-024 → superseded by ADR-037).
- **Compute**: ECS Fargate (arm64). web is a Next.js 14 thin-BFF served at the root path.
- **Async workers**: heavy / long / OOM-risk work is never run inline by web — it goes through SQS → ESM (kill-switch) → dispatcher Lambda (idempotent) → Step Functions → Lambda or `ecs:runTask.sync` Fargate.

ADR-037 supersedes ADR-024 in full and refines ADR-030's mechanism (no live Steampipe; flag-gated inventory sync only).

### Why is data stored in Aurora?

State is persisted in **Aurora Serverless v2 (PostgreSQL 17)**, not in JSON files on an EC2 instance (ADR-030).

App state — `worker_jobs` (async jobs), chat threads, AI diagnosis reports, datasource schema cache — all lives in Aurora, and the app accesses it via node-pg. This keeps state intact across instance restarts and replacements. (The Aurora / dual-ECR *intent* holds from ADR-030; the 4-container / Service-Connect / CDK *mechanism* is superseded by ADR-037.)

### Will a graph database like Neptune be adopted?

**Not for now — it's deferred** (ADR-043).

Topology and resource graphs are handled well enough by Postgres recursive CTEs, so the **Postgres-first** principle holds; Neptune remains an option only, flag-OFF. (2026-06-17 addendum: a 5-family consensus reaffirmed Postgres-first; the topology UI keeps its current client-side build, with server-side materialize wired only when a consumer appears.)

## AI

### Does the AI automatically analyze incidents and take action?

**Analysis (RCA) yes, automated action (mitigation) no** (ADR-032, DOWNGRADED 2026-06-11).

ADR-032 originally defined an event-triggered autonomous incident lifecycle (multi-agent Lead/Sub), but the 2026-06-11 consensus **dropped autonomous mitigation/action** and **retained only read-only Triage, investigation, and RCA** (advisory-only; analysis-only when enabled). A human reviews the analysis and decides on any action.

### Where do RCA (root-cause analysis) results get recorded?

They are designed to write back bidirectionally to OpsCenter / Incident Manager (ADR-034, KEPT).

However, ADR-034 currently inherits the frozen 029/036 substrate role, so until a **self-contained role is decoupled and `rca_writeback_enabled` is turned on, it is flag-OFF / do-not-enable**. The ADR-041 coherence addendum (2026-06-17) classifies this writeback as an **AWS-native observability-metadata write (third tier)** — governed like data rather than FROZEN, but the role split must come first.

### How does AI routing work?

**ADR-038 hybrid routing** — regex fast-path + Haiku 4.5 classifier + prompt caching. **Activated LIVE 2026-06-10.**

The gate score was validated at hybrid 69.2% → **96.9% (+27.7pp) PASSED**. Rather than the earlier 11/18-route Sonnet registry, a fast regex catches clear queries first, and ambiguous ones are routed by the Haiku classifier. (The classifier timeout was corrected to 3.5s — 1s is too short on global cross-region profiles.)

### Does the AI keep costing money for repeated questions?

**It's optimized with prompt caching and model-by-depth selection** (ADR-038, ADR-033).

- **Prompt caching** — about a 59% hit rate, reducing recomputation of repeated context (ADR-038).
- **Model by task depth** — AI Diagnosis uses Sonnet by default for base (8 sections), and Sonnet default / Opus selectable (cost-gate) for deep (15 sections). Classification and routing use the cheaper Haiku 4.5 (ADR-033).
- ADR-033 defined an Aurora durable token budget (implemented in v1; wiring it into the current web chat path is a pending follow-up).

### Did the gateways grow to 9?

**No — it stays at 8** (ADR-004).

The **8 section gateways** — network · container · data · security · cost · monitoring · iac · ops — are maintained, and external observability is a separate **"Integrations axis"** (ADR-039), not a 9th gateway.

### Can I add my own agents or tools?

**Only via curated connectors** (ADR-039, ADR-031, ADR-041).

The ADR-039 multi-agent platform introduced frontier agents (DevOps/Security/FinOps + N) and the Integrations axis, and admin-configured Agent Spaces (ADR-031 Phase 1/2) are LIVE. However:

- **Arbitrary-form BYO-MCP (ADR-031 Phase 3) is dropped** (2026-06-11 reversal). Connectors are allowed in **curated form** only (ADR-041).
- Among **mutating tools (ADR-031 Phase 4)**, only non-AWS external *data* writes are narrowly allowed under ADR-040 governance; AWS-resource mutation stays dropped.

### Does the AI diagnose Kubernetes (EKS) automatically too?

**It provides read-only diagnosis only** (ADR-035, DOWNGRADED 2026-06-11).

The K8sGPT hybrid (in-cluster K8s diagnosis integrated into AgentCore via MCP, Haiku 4.5) retains only **read-only Result-CRD integration (GET-only)**; the wiring that led to automated action (H3a → 032/034/029 proposals) was dropped. EKS queries are all read-only, based on a task-role Access Entry + View policy.

## Operations

### How are long or heavy jobs handled?

They are **enqueued to the async worker tier** (ADR-037).

Since web is a thin-BFF, it never runs heavy/long/OOM-risk work inline: `POST /api/jobs` → `worker_jobs` (queued) + SQS → ESM (kill-switch) → dispatcher Lambda (idempotent on job_id) → Step Functions routes by `$.runtime` (short → RunLambda, long/OOM-risk → `ecs:runTask.sync` Fargate) → the worker writes running/succeeded itself → on failure the status_updater Lambda writes failed → a reaper (EventBridge, every 5 min) reconciles stale jobs.

:::tip
The ESM has a kill-switch to stop queue consumption instantly, and the dispatcher is idempotent on job_id, so duplicate dispatches are safely ignored.
:::

### Where can I read more about these decisions?

The full ADR set (001–044) is in `docs/decisions/`, and the index, status, and reversal/correction notes are in `docs/decisions/CLAUDE.md`. The 2026-06-11 high-risk reversal consensus is in `docs/reviews/2026-06-11-high-risk-adr-reversal-consensus.md`, and the external-write unfreeze consensus is in `docs/reviews/2026-06-14-external-write-unfreeze-consensus.md`.
