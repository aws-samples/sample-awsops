# AWSops v2 — P3-B: Data Pages MVP (Design Spec)

> Branch `feat/v2-architecture-design`. Brainstormed 2026-06-04. Re-scoped from "agent fleet depth" after user feedback: the deployed P3-A app shows **only the chat on an empty shell — nothing to do**. P3-B gives the app real, usable pages. (Original agent-fleet-depth deferred.)

## Goal
Turn the chat-only shell into a usable ops dashboard by adding **real-data pages** (Overview, EKS, Jobs, Cost) built from data v2 actually has — with the chat drawer docked alongside.

## Key facts (measured 2026-06-04)
- v2 Aurora: **only `worker_jobs` has data (6 rows)**; all ADR-030 tables (`cost_snapshots`, `agentcore_stats`, `alert_diagnosis`, `inventory_snapshots`, …) are **0 rows** (no v2 writer — those collectors don't run in v2). So Aurora-backed pages = **Jobs only**; other real data must come **live from AWS SDK**.
- web task role already has **`eks-read`** (eks:DescribeCluster/ListClusters/DescribeAccessEntry, P1e) and Aurora access (`web/lib/db.ts` getPool, P2). It does **not** yet have Cost Explorer perms.
- `web/app/api/jobs/route.ts` already exists as **POST (enqueue, P2)** — add a **GET (list)** handler to it.
- v2 has **no Steampipe** — there is no general AWS inventory source.

## Data layer decision (the core P3-B decision)
**Chosen: A — BFF-direct AWS SDK (read-only) + Aurora for app state.** The thin-BFF makes targeted, read-only SDK calls (EKS describe, Cost Explorer) using the Fargate task role, and reads `worker_jobs` from Aurora. This is **per-page targeted reads, NOT a general inventory** and NOT Steampipe. (Rejected: B re-introduce a data source [Steampipe-on-Fargate / sync→Aurora] — big, new infra, the thing v2 dropped; C agent-mediated — agents return prose, wrong for tabular pages.) General v1-style inventory (EC2/S3/RDS 380-table) remains a **separate, deferred** data-source decision.

## Scope
**In:** 4 pages (Overview, EKS, Jobs, Cost) + 4 BFF data routes (all `verifyUser`-gated) + `web/lib/aws.ts` (EKS + Cost Explorer clients) + shared UI (`StatCard`, `DataTable`) + TopNav real nav links + the Cost Explorer IAM grant. Chat drawer unchanged (docks on every page).

**Out (later):** collectors to populate the empty ADR-030 tables (cost_snapshots/stats/alerts pages); general AWS inventory pages (EC2/S3/RDS — needs the deferred data-source decision); agent fleet depth (more wired sections — the original P3-B, now after this); pagination/filtering polish.

## Components (file boundaries)
| File | Responsibility |
|---|---|
| `web/lib/aws.ts` | Lazy `EKSClient` (region env) + `CostExplorerClient` (**us-east-1** — CE is global/us-east-1 only) + thin wrappers `listClusters()`, `getMtdCost()`. |
| `web/app/api/eks/route.ts` | `GET`: verifyUser → ListClusters → DescribeCluster each → `{clusters:[{name,status,version,endpoint,createdAt}]}`. |
| `web/app/api/jobs/route.ts` | **add `GET`**: verifyUser → recent `worker_jobs` (50) → `{jobs:[{job_id,type,status,runtime,error,created_at,updated_at}]}`. (POST enqueue stays.) |
| `web/app/api/cost/route.ts` | `GET`: verifyUser → CE GetCostAndUsage (MTD, MONTHLY, UnblendedCost, group by SERVICE) → `{total,currency,byService:[{service,amount}]}`. |
| `web/app/api/overview/route.ts` | `GET`: verifyUser → server-aggregate `{jobs:{queued,running,succeeded,failed},clusterCount,mtdCost}`. |
| `web/app/page.tsx` | Overview — StatCards from `/api/overview`. |
| `web/app/eks/page.tsx`, `web/app/jobs/page.tsx`, `web/app/cost/page.tsx` | DataTable/cards from their routes; loading + error states. |
| `web/components/ui/StatCard.tsx`, `web/components/ui/DataTable.tsx` | Navy-theme shared UI (StatCard = label+value+accent; DataTable = columns+rows, empty state). |
| `web/components/shell/TopNav.tsx` (modify) | Real nav links: Overview / EKS / Jobs / Cost (active highlight). |

## Data flow
Page (client component) → `fetch('/api/<x>')` (same-origin, cookie sent) → BFF route: `verifyUser(cookie)` (401 if invalid) → SDK/Aurora read → JSON. Pages render loading → data | error. All pages sit under the edge-auth (Lambda@Edge); the data routes re-verify (defense-in-depth, same as `/api/chat`). Chat drawer (P3-A) unchanged, mounted in `layout.tsx`.

### Route response contracts
- `GET /api/eks` → `{ clusters: [{ name, status, version, endpoint, createdAt }] }` (DescribeCluster per ListClusters name; cap 25).
- `GET /api/jobs` → `{ jobs: [{ job_id, type, status, runtime, error, created_at, updated_at }] }` (ORDER BY created_at DESC LIMIT 50).
- `GET /api/cost` → `{ total: number, currency: string, byService: [{ service, amount }] }` (MTD; top services by amount desc).
- `GET /api/overview` → `{ jobs: { queued, running, succeeded, failed }, clusterCount: number, mtdCost: number }`.
- All routes: 401 `{status:'error',message:'unauthenticated'}` if no valid user; 500 `{status:'error',message}` on SDK/DB error.

## IAM
Add to the web task role (new `aws_iam_role_policy.task_cost` in `ai.tf` or `workload.tf`, gated like the others):
`ce:GetCostAndUsage` (+ `ce:GetCostForecast` for a future forecast widget), Resource `*` (Cost Explorer has no resource-level scoping). EKS read + Aurora already present. (Cost Explorer ~$0.01/request — acceptable; Overview + Cost page = 1-2 CE calls per load.)

## Error handling
- **Auth fail** → 401 envelope; page shows "세션 만료 — 새로고침".
- **SDK/DB error** → 500 envelope; page shows an error card with the message + a retry.
- **Empty data** → DataTable empty state ("데이터 없음") — expected for a fresh account or zero clusters.
- **Cost Explorer unavailable / no perms** → cost route 500 with a clear message; Overview degrades (cost card shows "—") rather than failing the whole page.

## Testing
- **Unit (vitest):** `lib/aws.ts` wrappers (mock EKS/CE SDK → shape); each route (mock auth+SDK/db → 401 unauth, 200 shape, 500 on error); `lib/db` job-list query shape (mock pool).
- **Build:** `npm run build` passes; new routes + pages in the manifest.
- **E2E (post-deploy, manual):** login → Overview cards populated (job counts from the 6 real jobs, cluster count, MTD cost) → EKS page lists clusters → Jobs page shows the 6 jobs → Cost page shows MTD/by-service → chat drawer still works on every page.

## Non-goals (explicit)
ADR-030 table collectors; general AWS inventory (EC2/S3/RDS); agent fleet depth (more wired chat sections); real-time refresh/websockets; pagination/sort/filter beyond a basic table.
