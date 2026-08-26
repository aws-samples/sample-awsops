# AWSops v2 — F5 Metric KPI Cards (EC2-first) Design

**Status:** Accepted. 2026-06-09. Closes gap #1 from the v1-EC2 comparison ("카드 수 부족 — 평균 CPU / 시간당 비용").

**Goal:** Add **live metric KPI cards** to inventory pages — starting with EC2's **average CPU** (CloudWatch) and **hourly cost** (Pricing API) — matching v1's `/awsops/ec2` card set, built extensibly so other types (RDS, etc.) can follow.

**Why separate from F3/F4:** these need data NOT in the inventory snapshot — CloudWatch `GetMetricData` (per-instance CPU) + the Pricing API (on-demand $/hr) — so they're a distinct BFF metrics path, not derivable from the loaded rows.

---

## Decisions
- **EC2 first, registry-extensible.** Implement EC2 (the page the user referenced); the API is generic (`/api/inventory/[type]/metrics`) and returns `{cards:[]}` for types without metric support yet — RDS/ElastiCache/etc. add later by extending `lib/metrics.ts` + the per-type switch.
- **Avg CPU = running-fleet average.** CloudWatch `GetMetricData` (one `CPUUtilization` query per **running** instance, `AWS/EC2`, dim `InstanceId`, Period 3600s, Stat Average, last ~3h window → latest datapoint), averaged across instances. Cap 100 instances/call (GetMetricData allows 500 queries). Stopped instances excluded (no recent data). Degrade → null (card shows `—`).
- **Hourly cost = Σ on-demand price × count.** Pricing API (`@aws-sdk/client-pricing`, **us-east-1 only**) `GetProducts` per **distinct instance type** (filters: ServiceCode `AmazonEC2`, location `Asia Pacific (Seoul)`, instanceType, operatingSystem `Linux`, tenancy `Shared`, preInstalledSw `NA`, capacitystatus `Used`) → parse OnDemand USD/hr from `terms.OnDemand`; **per-type cache** (Map, process-lifetime); `total = Σ price[type] × count[type]`. Degrade per-type → skip (note partial). Returns null if all fail.
- **BFF-direct** (web task role), `verifyUser`-gated; computed on request (no new store). Independent degrade — a CloudWatch/Pricing hiccup must not blank the page (the F3 total/state cards + table stay).

## Architecture
- **`web/lib/metrics.ts`**:
  - `ec2AvgCpu(instanceIds: string[]): Promise<number|null>` — CloudWatch GetMetricData, fleet avg %, 1-decimal.
  - `ec2HourlyCost(typeCounts: Record<string,number>): Promise<number|null>` — Pricing API, cached per type, Σ.
  - lazy clients (`CloudWatchClient` region=AWS_REGION; `PricingClient` region='us-east-1').
- **`web/app/api/inventory/[type]/metrics/route.ts`** — `GET`, `verifyUser`→401, `dynamic='force-dynamic'`. For `type==='ec2'`: query Aurora `inventory_resources` (type=ec2) → running instance_ids + per-type counts (from `data->>'instance_type'`/`data->>'instance_state'`) → `cards = [{label:'평균 CPU', value: cpu==null?'—':`${cpu}%`, accent:true}, {label:'시간당 비용(USD)', value: cost==null?'—':`$${cost.toFixed(2)}`, accent:true}]`. Other types → `{cards:[]}`. Try/catch → `{cards:[]}` on error (never 5xx-blank the page; the metric cards are supplementary).
- **Generic page (`web/app/inventory/[type]/page.tsx`)**: after the existing total/state StatTiles, a `useEffect` fetches `/api/inventory/${type}/metrics`; if `cards.length>0`, render them as `<StatTile>`s appended to the KPI grid (or a thin second row). Existing cards/donut/filters/detail-panel unchanged; metric fetch degrades silently (no card on failure).
- **IAM (`workload.tf`)**: new `aws_iam_role_policy.task_metrics` on `aws_iam_role.task` — `cloudwatch:GetMetricData`, `cloudwatch:GetMetricStatistics`, `cloudwatch:ListMetrics`, `pricing:GetProducts`, `pricing:DescribeServices` (Resource `*`; read-only). No other infra.
- **Deps**: `@aws-sdk/client-cloudwatch`, `@aws-sdk/client-pricing`.

## Verification
- **Local smoke** (deploy-host creds, like P3-D): call `ec2AvgCpu(<some running instance ids>)` + `ec2HourlyCost({'t3.micro':2,...})` → real CPU % + $/hr, before deploy.
- **Unit (vitest)**: route 401 unauth; ec2 path returns 2 cards (mock lib); non-ec2 returns `{cards:[]}`; lib pricing-parse from a mock GetProducts PriceList JSON.
- **Live (controller)**: `make deploy` → EC2 page shows 평균 CPU + 시간당 비용 cards with real values.

## Out of scope (later)
RDS/ElastiCache/OpenSearch metric cards (same pattern, different namespace/dimension); network/disk metric cards; historical metric charts (that's the bigger `/monitoring`-style feature); Savings-Plan/RI-adjusted cost (on-demand list price only here).
