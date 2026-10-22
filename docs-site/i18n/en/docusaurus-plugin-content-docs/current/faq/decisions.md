---
sidebar_position: 7
title: Design Principles FAQ
description: Why AWSops behaves the way it does, framed as operator Q&A — read-only posture, external-write governance, AI routing/diagnosis, infrastructure shape, and cost/security/operations principles.
---

# Design Principles FAQ

This page distills the core design principles that determine *why AWSops behaves the way it does*, in the form of the questions operators ask most.

:::info
AWSops's single most important principle is **read-only**. That constraint is bound precisely to **AWS-resource mutation + autonomy**. Reading external observability **data** and writing external **data records** under governance fall outside it — they are data operations, not AWS-resource changes.
:::

## Security

### Does AWSops change AWS resources directly or remediate automatically?

**No. AWS-resource mutation and autonomous execution are permanently frozen (do-not-enable).**

The code for the mutating-action framework and its execution substrate (SSM Automation + Change Manager × workers) is preserved dark, but the flags are permanently OFF and are not enabled.

- **No screen or AI feature performs AWS-resource changes** such as terminating EC2, modifying SGs, scaling, or deploying.
- All ~160 AgentCore MCP Lambda tools are read-only.

:::info
The "freeze" is scoped to **AWS resources only**. The control layer and the worker execution branch may be reused for non-AWS external data writes, but the AWS-resource automation substrate itself stays frozen.
:::

### Are writes to external systems like Slack or Jira also blocked?

**No — they are allowed under governance.** These are **data records**, not AWS-resource changes.

Non-AWS-resource external knowledge/comms writes (records and messages in Slack, Notion, Confluence, Jira, ServiceNow) are narrowly allowed. The read-only constraint applies to AWS-resource mutation + autonomy, and **external data integration (read + write) is excluded** from it.

- Leaving reports, tickets, and messages in external systems is possible under governance controls.
- Mutation rights over AWS infrastructure itself are granted **by no path at all**.

### Is there a risk of leaking internal information when writing externally?

External data writes are designed to operate only under **hard conditions**. The key guards:

- **DLP / redaction** — strips sensitive information from outbound content
- **Destination allowlist** — sends only to approved external destinations
- **SSRF guard** — blocks metadata/IMDS and internal endpoints
- **Secrets in Secrets Manager**
- **Human gate** — sends only after human approval (or a draft-only fallback)
- **Non-AWS-resource only** + **flag-OFF by default**

:::tip
External writes are not "an exception that was allowed" — they are the data-write standard under a **control mandate**.
:::

### How does login work?

AWSops uses an **in-app login form** (`/login`).

The self-hosted `/login` form calls the BFF `POST /api/auth/login` → authenticates via the unsigned public Cognito `InitiateAuth(USER_PASSWORD_AUTH)` → issues the `awsops_token` cookie (id_token, 12 hours). Every subsequent request is checked by Lambda@Edge with **RS256 JWKS signature verification**. The Hosted UI PKCE flow is preserved only as a dark fallback.

The Cognito + Lambda@Edge setup follows least privilege (no REFRESH granted).

### How are admin privileges controlled?

By a **server-side fail-closed gate**.

Admin functions are allowed only for users who are Cognito `admins` **group members** or are included in the SSM **admin email allowlist**. If neither confirms the user, access is blocked by default (fail-closed).

## Architecture

### Why isn't the infrastructure a single EC2?

AWSops rebuilt v1's **single-EC2 monolith** into a **Terraform-based MSA**.

- **IaC**: Terraform (partial S3 backend). CDK is retired.
- **Compute**: ECS Fargate (arm64). The web tier is a Next.js 15 thin-BFF served at the root path.
- **Async workers**: heavy, long, or OOM-risk work is not handled by web directly; it goes SQS → ESM (kill-switch) → dispatcher Lambda (idempotent) → Step Functions → Lambda or `ecs:runTask.sync` Fargate.

There is no live Steampipe query path; only the flag-gated inventory sync exists.

### Why is data stored in Aurora?

State is persisted to **Aurora Serverless v2 (PostgreSQL 17)**, not JSON files on an EC2 instance.

All app state — `worker_jobs` (async jobs), chat threads, AI diagnosis reports, datasource schema caches, and more — lives in Aurora, and the app accesses it via node-pg. State therefore survives instance restarts and replacements.

### Will AWSops adopt a graph database such as Neptune?

**Not now — it is deferred.**

Topology and resource graphs are handled well enough by Postgres recursive CTEs, so the **Postgres-first** principle holds; Neptune remains only an option and is flag-OFF. The topology UI keeps its current client build, and server-side materialization is wired when a consumer appears.

## AI

### Does AI analyze incidents and also remediate them automatically?

**Analysis (RCA): yes. Automatic mitigation: no.**

Autonomous mitigation/action is not provided; **only read-only triage, investigation, and RCA are provided** (advisory only; analysis-only when activated). Humans make the decision and take action based on the analysis.

### Where are RCA (root-cause analysis) results recorded?

They are designed to be recorded via bidirectional write-back to OpsCenter / Incident Manager.

However, this write-back currently inherits the role of the frozen automation substrate, so it is **flag-OFF and do-not-enable until a self-contained role split is in place and `rca_writeback_enabled` is turned on**. The write-back is classified as an **AWS-native observability metadata write**: it is governed like data rather than frozen, but the role split must come first.

### How does AI routing work?

**Hybrid routing** — a regex fast-path + a Haiku 4.5 classifier + prompt caching.

The gate score was validated at hybrid 69.2% → **96.9% (+27.7pp) PASSED**. A fast regex catches clear queries first, and ambiguous ones go to the Haiku classifier. The classifier timeout is 3.5s (1s is not enough on the global cross-region profile).

### Do repeated questions keep costing AI spend?

They are **optimized through prompt caching and per-depth model selection**.

- **Prompt caching** — an ~59% hit rate reduces recomputation of repeated context.
- **Per-depth models** — AI diagnosis uses Sonnet by default for Light and Mid (8+1 sections); Deep (15+1 sections) uses Sonnet by default with Opus as an option (cost-gate). Classification and routing use the cheaper Haiku 4.5.
- The Aurora durable token budget (persisted budget) is implemented in v1; wiring it into the current web-chat path is follow-up work.

### How many gateways are there?

**Nine.**

In addition to the 8 AWS-domain gateways — network · container · data · security · cost · monitoring · iac · ops — the **external-obs gateway**, which hosts the external observability connectors (Prometheus · ClickHouse), is provisioned and routed as the ninth (9 provisioned / 9 routed). The chat key `observability` aliases to external-obs.

### Can I configure additional agents or tools myself?

**Only through governed connectors** — curated connectors, official presets, or the administrator-registered `custom_mcp` integration.

The multi-agent platform provides frontier agents (DevOps/Security/FinOps + N) and an Integrations axis, and the admin-configured Agent Space is LIVE. However:

- **Arbitrary-form BYO-MCP is not provided.** MCP endpoint paths without governance controls are not allowed.
- The administrator-only `custom_mcp` integration is the governed path with those controls: admin-only registration, per-account enablement, an admin-set exposed-tool ceiling (empty exposes nothing), a credential read from Secrets Manager at connect time, and connect-time SSRF checks. Official presets keep their host pins.
- Of the **mutating tools**, only non-AWS external data writes are narrowly allowed under external-write governance; AWS-resource mutation is not provided.

### Does AI also diagnose Kubernetes (EKS) automatically?

**Read-only diagnosis only.**

The K8sGPT hybrid (in-cluster K8s diagnosis integrated into AgentCore via MCP, Haiku 4.5) provides **only the read-only Result-CRD integration (GET-only)**, with no wiring toward automatic remediation. All EKS lookups are read-only. The default authenticating principal is the web task role for the host cluster, or the registered member read role for a member cluster (typically `AWSopsReadOnlyRole`), and that role needs an Access Entry and read policy. Member metadata lookups and default Kubernetes token signing both use member-role credentials; the existing host-role Entry alone is not sufficient. A stored SA token or an explicit AssumeRole uses a separately allowed Kubernetes principal, and a member AssumeRole is limited to roles in the same member account. SA authentication does not need an IAM Access Entry but does need metadata permissions. None of these methods enables automatic remediation.

## Operations

### How are long or heavy jobs handled?

They are **enqueued to the async worker tier**.

Web is a thin-BFF, so it never runs heavy, long, or OOM-risk work inline: `POST /api/jobs` → `worker_jobs` (queued) + SQS → ESM (kill-switch) → dispatcher Lambda (idempotent on job_id) → Step Functions routes by `$.runtime` (short → RunLambda, long/OOM-risk → `ecs:runTask.sync` Fargate) → the worker writes running/succeeded itself → on failure the status_updater Lambda writes failed → a reaper (EventBridge, every 5 min) reconciles stale jobs.

:::tip
The ESM has a kill-switch to stop queue consumption instantly, and the dispatcher is idempotent on job_id, so duplicate dispatches are safely ignored.
:::
