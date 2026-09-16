---
sidebar_position: 1
title: General FAQ
description: Answers to the most common questions — what AWSops is, how it is deployed, how you log in, whether it changes your infrastructure, and where data is stored.
---

# General FAQ

Common questions and answers about the AWSops dashboard.

## What is AWSops?

AWSops is a **real-time, read-only operations dashboard + AI diagnosis** tool for AWS and Kubernetes environments. Key features include:

- **Resource monitoring**: status of major AWS services including EC2, Lambda, ECS, EKS, RDS, S3
- **Network / topology visualization**: VPC, subnets, Security Groups, plus the resource graph from CloudFront → LB → Target Group → DB
- **Security analysis**: IAM permission analysis, compliance, vulnerability checks
- **Cost management**: Cost Explorer-based cost analysis and dashboards
- **AI assistant**: natural-language queries for AWS resource analysis and troubleshooting (streaming + domain routing + persistent conversations)
- **AI Diagnosis**: worker-generated, read-only diagnosis reports (Light·Mid 8+1 sections (9 total) / Deep 15+1 sections (16 total), with DOCX/PDF export)

The platform is a **Terraform-based MSA** — live AWS queries go through **Amazon Bedrock AgentCore MCP tools**, and app state is persisted in **Aurora Serverless v2 (PostgreSQL 17)**.

:::info
AWSops is a **read-only** operations tool. It queries, visualizes, and diagnoses your infrastructure, but it does not change AWS resources. See "Does AWSops change my infrastructure?" below for details.
:::

## How is it deployed and how does it work?

AWSops is a microservice architecture provisioned with **Terraform** (`terraform/foundation/`, partial S3 backend). The core layers are:

| Layer | Composition |
|-------|-------------|
| **IaC** | Terraform (S3 partial backend, `use_lockfile`). CDK is dropped |
| **Edge** | CloudFront (TLS) → VPC Origin (`https-only:443`) → internal ALB HTTPS:443 (regional ACM) → Fargate. **No public ALB** |
| **Compute** | ECS Fargate (arm64). web is a Next.js 15 thin-BFF served at the **root path (`/`)** |
| **Data** | Aurora Serverless v2 (PostgreSQL 17), accessed via node-pg |
| **AI** | AgentCore Runtime + MCP Lambda tools across 9 section gateways (live query) |
| **Async workers** | SQS → ESM (kill-switch) → dispatcher Lambda → Step Functions → Lambda or Fargate |

Heavy, long, or OOM-risk work is never run inline by web — it is sent to the **async worker tier**: `POST /api/jobs` → enqueue into `worker_jobs` → SQS → idempotent dispatcher Lambda → Step Functions routes short jobs to RunLambda and long/OOM-risk jobs to `ecs:runTask.sync` Fargate. Failures are recorded by a status_updater Lambda, and a reaper (EventBridge, every 5 min) reconciles stale jobs.

:::tip
The edge is **end-to-end TLS**. CloudFront connects to the internal ALB over TLS, and the ALB SG allows 443 only from the CloudFront managed SG `CloudFront-VPCOrigins-Service-SG`. There is no X-Custom-Secret header and no managed prefix list.
:::

## Does AWSops change my infrastructure?

**No.** AWSops is a **read-only operations dashboard + AI diagnosis** tool. **AWS-resource mutation and autonomy are permanently frozen (do-not-enable).** No screen and no AI feature will stop an EC2 instance, modify a security group, or alter your infrastructure.

The AI assistant and diagnosis **query** live data to analyze and diagnose it — they perform no mutation. All ~160 AgentCore MCP Lambda tools are read-only.

The only "write" permitted, under governance, is **external data records** — for example, leaving a report, ticket, or message in an external system. This works only under the following guards:

- SSRF guard (metadata/IMDS blocked, destination allowlist)
- secrets managed in Secrets Manager
- DLP / redaction
- human-gate (human approval)
- flag-OFF by default

:::info
External "writes" are **data records** (tickets, messages, reports), **not AWS-resource changes**. No path grants permission to change the AWS infrastructure itself.
:::

## How do I log in?

AWSops uses a **self-hosted login form** (`/login`).

1. When you open AWSops, unauthenticated users are redirected to `/login` by the edge (Lambda@Edge).
2. Entering your email/password on the `/login` form triggers the BFF call `POST /api/auth/login`.
3. The BFF authenticates via the public Cognito `InitiateAuth (USER_PASSWORD_AUTH)` and mints an `awsops_token` cookie (id_token, valid 12 hours).
4. Every subsequent request is verified by Lambda@Edge with **full RS256 JWKS signature verification** (including iss/aud/token_use).

Auth is handled by a Cognito User Pool + Lambda@Edge (`us-east-1`). The Hosted UI PKCE flow is retained only as a dark fallback.

**Admin privileges** are gated server-side and fail-closed — only members of the Cognito `admins` group or users on the SSM admin-email allowlist can access admin features.

## Where is data stored?

AWSops stores state in **managed AWS services**, not in JSON files on an EC2 instance.

| Store | Contents |
|-------|----------|
| **Aurora Serverless v2 (PostgreSQL 17)** | app state: `worker_jobs` (async jobs), chat threads, AI diagnosis reports, datasource schema cache |
| **SSM Parameter Store** | source of truth for AgentCore config (`/ops/awsops-v2/agentcore/...` — runtime ARN, interpreter id, memory id, etc.) |
| **S3** | AI diagnosis report exports (DOCX/PDF) |

Live AWS resource data is **not stored** — AgentCore MCP tools fetch it at query time. (Steampipe is used only as a flag-gated **inventory sync** (`steampipe_enabled`, default OFF), not as the live query engine.)

:::tip
The app accesses Aurora via **node-pg** (the shared pool in `web/lib/db.ts`). The v1 `data/*.json` file pattern is no longer used.
:::

## How does AWSops query live AWS data?

Live AWS / Kubernetes data is queried through **AgentCore MCP Lambda tools**. About 160 read-only tools are distributed across **9 section gateways** (network · container · data · security · cost · monitoring · iac · ops · external-obs).

- All tools are read-only.
- The gateway count is **9** (ADR-004 as amended 2026-06-24) — external-obs, hosting the Prometheus·ClickHouse connectors, is provisioned and routed as the ninth.
- It no longer relies on a local Steampipe service (127.0.0.1:9193) or direct access to 380 tables.

## Can it query external observability data (Prometheus / Loki / Tempo / ClickHouse / Datadog)?

**Yes — through the read-only datasource platform.** You can connect external observability backends as connectors and query metrics, logs, and traces.

Supported targets (examples): Prometheus, Loki, Tempo, ClickHouse, Mimir, and others.

Components:

- **Connector Lambdas** — query external backends read-only
- **Aurora schema cache** — caches connector schemas
- **`/datasources` Explore page** — browse directly in the UI
- **NL→query chat injection** — the AI assistant turns natural-language questions into datasource queries

:::info
Connector input is **SSRF-guarded and size-bounded** (`readJsonBounded` before parse, metadata/IMDS blocked). The datasource platform only **reads** external data; it does not change AWS resources.
:::

## Does it support theming and mobile?

**Theming — a 3-theme runtime picker**

- **Cobalt** (default)
- **Teal**
- **Dark**

The theme is stored in localStorage and applied with no flash on refresh, and the charts and the mark (logo) recolor in response to the theme. The **Cmd-K command palette** is available everywhere for quick navigation.

**Mobile — responsive layout**

- Top bar + 5 bottom tabs + hamburger drawer
- Tables convert to cards
- Chat goes fullscreen
- Grid reflow and a detail sheet

## Does it support multiple AWS accounts?

The AWSops live environment runs on a single account (`123456789012`). Live AWS queries are performed by the AgentCore MCP tools using the execution role; queries against a genuinely different account go only through a dedicated cross-account assume path. (Selecting the host account as the target uses the execution role directly, so no unnecessary self-assume occurs.) All access is read-only.
