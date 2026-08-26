# AWSops v2 — Inventory Data Layer: Steampipe → Aurora (D1 keystone) Design Spec

> Branch `feat/v2-architecture-design`. Brainstormed 2026-06-05; **revised after a 3-AI co-agent review (kiro·codex·gemini = REVIEW: architecture + Steampipe-for-parity endorsed; tightenings folded in below).** Re-prioritized after user feedback "where did the v1 dashboard go?" — v2 dropped Steampipe and never ported v1's ~35-page Steampipe-backed inventory dashboard. This is the **keystone data layer** that unblocks porting those pages. (Supersedes the originally-planned P3-D "EKS kubeconfig"; in-cluster EKS view becomes a later page-wave.)

## Goal
Bring v1-parity inventory data to v2: a **warm Steampipe Fargate service** (stateless live AWS fetcher) feeds **Aurora** (durable per-resource store); the dashboard reads **Aurora only** (fast, server-side paginated, survives Steampipe restarts), with **on-demand Refresh** (warm-Steampipe→Aurora) AND a **scheduled sync** so data never goes silently stale. D1 delivers the data layer + ONE proof page (EC2). The other ~34 v1 pages port in later waves on this plumbing.

## Why this shape (brainstorm + co-agent confirmed)
- **Steampipe is stateless** — a query-time FDW; stores nothing durably, so a restart loses nothing (AWS is the source of truth). Durability comes from **Aurora**, not Steampipe.
- **Refresh must be fast** (v1 had it). A batch-job-per-refresh (cold start) is ~1–3 min — too slow. A **warm Steampipe service** answers in seconds.
- **Dashboard reads Aurora only** → fast, server-side paginated, decoupled from Steampipe uptime, observable freshness.
- **Steampipe is a TACTICAL compatibility collector** (not the long-term app data layer): it gives v1 parity fast (380 tables + v1 SQL reuse). The `syncInventory(type)` abstraction lets any type later migrate to a pure-SDK collector transparently. (co-agent consensus #7.)

## Architecture
```
                         ┌─ scheduled sync (EventBridge rate(15m) → sync invocation)   [IN D1]
warm Steampipe Fargate ◀─┤
 (:9193 FDW, stateless,  └─ Refresh button → BFF sync-now (warm → seconds, per-type lock)
  FARGATE_SPOT, ec2:Describe* role)
        │ query → per-resource UPSERT (+ delete-stale) + write inventory_sync_runs
        ▼
   Aurora: inventory_resources (per-resource rows) + inventory_sync_runs (status/age)
        ▲
   dashboard pages read Aurora only (lib/db.ts, server-side WHERE/ORDER/LIMIT) — durable, fast, restart-safe
```

## Scope (D1)
**In:** (1) Steampipe Fargate **service** (custom image w/ **pinned** aws plugin; warm; **FARGATE_SPOT**; private subnet; dedicated SG ingress 9193 from web SG only; Cloud Map discovery; **ECS healthCheck on :9193**; `ec2:Describe*`+`sts:GetCallerIdentity` IAM; awslogs; RunningTaskCount alarm; password via Secrets Manager). (2) Aurora schema: **`inventory_resources`** (per-resource rows) + **`inventory_sync_runs`** (status). (3) `web/lib/steampipe.ts` (pg pool → Steampipe, **statement_timeout 45s**, reconnect-on-error). (4) `web/lib/inventory.ts`: `readResources(type, {limit,offset})` (Aurora, paginated) + `syncInventory(type)` (query Steampipe → per-resource UPSERT + delete-stale + record a sync_run; **per-(type,account) concurrency lock**). (5) **EC2 proof routes+page**: `GET /api/inventory/ec2` (Aurora, paginated) + `POST /api/inventory/ec2/refresh` (sync-now; **synchronous w/ hard timeout, 202/async-capable contract**) + an `/ec2` page (DataTable + RefreshButton + stale-age badge). (6) **Scheduled sync** (EventBridge rate(15m) → ec2 sync). All gated by **`var.steampipe_enabled`** (count → $0 when off).

**Out (later waves D2+):** the other ~34 v1 pages (each = port v1 query + page + IAM-expand on this plumbing); **async refresh via the P2 worker tier for slow types** (the 202 contract is set in D1; routing slow types through SQS→SFN→worker lands when a slow type needs it); **multi-account aggregator**; CIS/compliance; in-cluster EKS (original P3-D); **inventory history** (D1 is latest-only — `inventory_resources` holds current state; an append-only history table is a deferred decision, NOT claimed by D1); IAM-tightening beyond per-wave; Secrets Manager rotation.

## Components
| File / resource | Responsibility |
|---|---|
| `scripts/v2/steampipe/Dockerfile` | `FROM` Steampipe base; **`steampipe plugin install aws@<pinned>`** (deterministic); copy `aws.spc`; non-root `steampipe` user; entrypoint `steampipe service start --database-listen network --database-port 9193 --foreground`. arm64. |
| `scripts/v2/steampipe/aws.spc` | AWS connection: default cred chain (= task role); `regions = ["<deploy region>"]` (NOT `["*"]` — bounded latency/API volume; co-agent #scale). |
| `terraform/foundation/steampipe.tf` | ECR; ECS service (warm, cpu 512/mem 2048, **capacity_provider FARGATE_SPOT**, **healthCheck** `CMD steampipe query "select 1"` interval 15s/startPeriod 60s, awslogs); dedicated SG (ingress 9193 from web `service` SG); Cloud Map private namespace+service (`steampipe.<ns>`, short DNS TTL); task role w/ inline `ec2:Describe*`+`sts:GetCallerIdentity` (NOT ReadOnlyAccess); `random_password`→Secrets Manager→`STEAMPIPE_DATABASE_PASSWORD`; `aws_cloudwatch_metric_alarm` RunningTaskCount<1; EventBridge rule rate(15m)→ec2 sync; all `count = var.steampipe_enabled ? 1 : 0`. |
| `terraform/foundation/data/schema.sql` (append) | **`inventory_resources(resource_type TEXT, account_id TEXT, region TEXT, resource_id TEXT, data JSONB, captured_at TIMESTAMPTZ, PRIMARY KEY(resource_type,account_id,region,resource_id))`** + index on `(resource_type,account_id)`; **`inventory_sync_runs(id, resource_type, account_id, started_at, finished_at, status, row_count, error)`**. (Existing empty `inventory_snapshots` left unused / for a different snapshot purpose.) |
| `web/lib/steampipe.ts` | pg `Pool`→Steampipe (host=`STEAMPIPE_HOST` Cloud Map DNS, 9193, user `steampipe`, password from secret, db `steampipe`, ssl `rejectUnauthorized:false` self-signed [VPC+SG-internal; plaintext acceptable alt — documented], **statement_timeout 45s**, max 4, reconnect-on-error). |
| `web/lib/inventory.ts` | `readResources(type,{limit,offset})` (Aurora SELECT paginated) + `latestSyncRun(type)` (age/status) + `syncInventory(type)` (per-(type,account) **lock** via pg advisory lock; run the type's Steampipe SQL; per-resource UPSERT into `inventory_resources`; delete rows of that (type,account) not in this run; write `inventory_sync_runs`). Holds per-type SQL (D1: `ec2`). |
| `web/app/api/inventory/[type]/route.ts` | `GET` verifyUser → `readResources` (paginated) + `latestSyncRun` (age). |
| `web/app/api/inventory/[type]/refresh/route.ts` | `POST` verifyUser → `syncInventory` (synchronous, hard `maxDuration` budget; if lock held → 409; **contract supports future 202+job for slow types**) → fresh page + `captured_at`. |
| `web/app/ec2/page.tsx` + `web/components/ui/RefreshButton.tsx` | EC2 DataTable from `/api/inventory/ec2`; RefreshButton (spinner + "N분 전 업데이트" + **stale-age warning when old**). |

## Data flow
- **Load** → `GET /api/inventory/ec2?limit=&offset=` → Aurora `inventory_resources` (server-side paginated) + `inventory_sync_runs` age → table + freshness badge.
- **Refresh** → `POST …/refresh` → `syncInventory('ec2')`: acquire (type,account) advisory lock (409 if busy) → pg-query warm Steampipe (`SELECT … FROM aws_ec2_instance`) → UPSERT each into `inventory_resources` → delete stale → record sync_run → return. Warm → seconds.
- **Scheduled** → EventBridge rate(15m) → same `ec2` sync path (so data stays fresh without a user).
- **Steampipe down/Spot-interrupted** → refresh 503/409; **Aurora keeps last snapshot, dashboard fully works** (durable decoupling); next refresh/schedule re-fetches.

## Steampipe SQL (D1: ec2) — `web/lib/inventory.ts`
```sql
SELECT instance_id, instance_type, instance_state, region, account_id,
       private_ip_address, public_ip_address, vpc_id, launch_time
FROM aws_ec2_instance ORDER BY launch_time DESC
```
(Verify columns via `information_schema.columns`; `account_id` required for multi-account-readiness; `resource_id`=`instance_id`.)

## Error handling
- **Steampipe unreachable/Spot-interrupted/disabled** → refresh 503; page shows last Aurora snapshot + "수집 서비스 일시 불가". `GET` (Aurora) always works.
- **Refresh in progress (lock held)** → 409 (no Steampipe stampede; co-agent #concurrency).
- **Empty / never-synced** → "데이터 없음 — Refresh로 수집" + button.
- **Stale** → freshness badge warns when `captured_at` older than a threshold (e.g., >30m) so old data never looks fresh.
- **Steampipe query error / FDW hang** → 45s `statement_timeout` aborts; sync_run records `error`; page shows last good snapshot. (v1 FDW-hang lesson: healthCheck kills hung tasks fast.)
- **Auth** → all routes `verifyUser` (401).

## IAM / security (co-agent #1, #security)
- Steampipe task role: **inline `ec2:Describe*` + `sts:GetCallerIdentity` only** (D1). Expand per page-wave (least-privilege; "tighten later rarely happens"). NOT ReadOnlyAccess.
- Steampipe service: private subnet only; dedicated SG ingress 9193 **from the web `service` SG only**; non-root container; egress→NAT for AWS APIs. DB password in Secrets Manager (rotation = follow-up).
- Cost: **Fargate Spot** (~$6/mo vs ~$20 on-demand; Spot interruption only briefly disables Refresh since Aurora is durable). `steampipe_enabled=false` default → $0.

## Observability (co-agent #6)
awslogs driver on the Steampipe task; CloudWatch alarm on `RunningTaskCount < 1` (when enabled); `inventory_sync_runs` is the app-level audit (last sync, errors, row counts, age) surfaced in the freshness badge.

## Testing
- **Unit (vitest):** `lib/inventory.ts` — `syncInventory` (mock Steampipe pg query + Aurora pool → UPSERT+delete-stale+sync_run shape; lock-held→409), `readResources` (paginated), `latestSyncRun`; routes (mock auth+lib → 401, 200 paginated GET, refresh 200/503/409); `lib/steampipe.ts` pool config (timeout 45s).
- **Build:** `npm run build` (new routes + `/ec2`).
- **TF:** `terraform plan` `steampipe_enabled=false` → "No changes" (gating); `=true` → Steampipe service+SG+CloudMap+IAM+secret+alarm+EventBridge created, nothing else disturbed; FARGATE_SPOT capacity provider valid.
- **E2E (post-deploy, controller):** enable → apply → build/push steampipe+web → `/ec2`: empty → Refresh → warm Steampipe queries EC2 → Aurora per-resource UPSERT → table shows real instances + "방금"; reload → fast paginated Aurora read; wait → scheduled sync keeps it fresh; (durability) restart/Spot-interrupt the Steampipe task → page still shows the snapshot.

## Non-goals (explicit)
Async refresh via P2 worker for slow types (202 contract set now; lands per-need); the other ~34 pages (waves); multi-account aggregator; CIS/compliance; in-cluster EKS (original P3-D); inventory history (latest-only in D1); IAM beyond per-wave; secret rotation.
