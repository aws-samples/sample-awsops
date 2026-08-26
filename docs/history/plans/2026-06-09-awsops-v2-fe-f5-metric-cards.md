# Frontend F5 — Metric KPI Cards (EC2 avg CPU + hourly cost)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Spec: `docs/superpowers/specs/2026-06-09-awsops-v2-fe-f5-metric-cards-design.md`. Steps `- [ ]`.

**Goal:** EC2 page gets live **평균 CPU** (CloudWatch) + **시간당 비용** (Pricing API) KPI cards, like v1. Generic API (`/api/inventory/[type]/metrics`) so other types follow later.

**Invariants:** metric cards are **supplementary** — every failure degrades silently (page keeps F3 total/state cards + donut + table + F4 detail panel); verifyUser-gated; read-only; existing 108 tests stay green.

---

### Task 1: `web/lib/metrics.ts` — CloudWatch CPU + Pricing cost

**Files:** Create `web/lib/metrics.ts`, `web/lib/metrics.test.ts`; Modify `web/package.json`

- [ ] **Step 1: deps** — `cd /home/atomoh/awsops/web && npm install @aws-sdk/client-cloudwatch @aws-sdk/client-pricing`
- [ ] **Step 2: `ec2AvgCpu(instanceIds)`**:
```ts
import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
const REGION = process.env.AWS_REGION || 'ap-northeast-2';
let cw: CloudWatchClient | null = null;
const cwClient = () => (cw ??= new CloudWatchClient({ region: REGION }));
export async function ec2AvgCpu(instanceIds: string[]): Promise<number | null> {
  const ids = instanceIds.slice(0, 100);
  if (!ids.length) return null;
  const r = await cwClient().send(new GetMetricDataCommand({
    StartTime: new Date(Date.now() - 3 * 3600_000), EndTime: new Date(),
    MetricDataQueries: ids.map((id, i) => ({
      Id: `m${i}`, ReturnData: true,
      MetricStat: { Metric: { Namespace: 'AWS/EC2', MetricName: 'CPUUtilization', Dimensions: [{ Name: 'InstanceId', Value: id }] }, Period: 3600, Stat: 'Average' },
    })),
  }));
  const latest = (r.MetricDataResults ?? []).map((m) => m.Values?.[0]).filter((v): v is number => typeof v === 'number');
  if (!latest.length) return null;
  return Math.round((latest.reduce((a, b) => a + b, 0) / latest.length) * 10) / 10;
}
```
- [ ] **Step 3: `ec2HourlyCost(typeCounts)`** — Pricing API (us-east-1), cached per type:
```ts
import { PricingClient, GetProductsCommand } from '@aws-sdk/client-pricing';
let pricing: PricingClient | null = null;
const priceClient = () => (pricing ??= new PricingClient({ region: 'us-east-1' }));
const priceCache = new Map<string, number | null>();
async function onDemandHourly(instanceType: string): Promise<number | null> {
  if (priceCache.has(instanceType)) return priceCache.get(instanceType)!;
  let price: number | null = null;
  try {
    const r = await priceClient().send(new GetProductsCommand({
      ServiceCode: 'AmazonEC2', MaxResults: 1,
      Filters: [
        { Type: 'TERM_MATCH', Field: 'instanceType', Value: instanceType },
        { Type: 'TERM_MATCH', Field: 'location', Value: 'Asia Pacific (Seoul)' },
        { Type: 'TERM_MATCH', Field: 'operatingSystem', Value: 'Linux' },
        { Type: 'TERM_MATCH', Field: 'tenancy', Value: 'Shared' },
        { Type: 'TERM_MATCH', Field: 'preInstalledSw', Value: 'NA' },
        { Type: 'TERM_MATCH', Field: 'capacitystatus', Value: 'Used' },
      ],
    }));
    const item = r.PriceList?.[0];
    if (item) {
      const p = JSON.parse(item as string);
      const od = p.terms?.OnDemand ?? {};
      const dim = Object.values(od)[0] as any;
      const pd = dim && Object.values(dim.priceDimensions ?? {})[0] as any;
      const usd = pd?.pricePerUnit?.USD;
      if (usd) price = Number(usd);
    }
  } catch { price = null; }
  priceCache.set(instanceType, price);
  return price;
}
export async function ec2HourlyCost(typeCounts: Record<string, number>): Promise<number | null> {
  let total = 0, any = false;
  for (const [t, n] of Object.entries(typeCounts)) {
    const p = await onDemandHourly(t);
    if (p != null) { total += p * n; any = true; }
  }
  return any ? Math.round(total * 100) / 100 : null;
}
```
- [ ] **Step 4: unit test** `metrics.test.ts` — mock @aws-sdk/client-cloudwatch (GetMetricData → 2 results with Values) → ec2AvgCpu averages; mock @aws-sdk/client-pricing (GetProducts → a realistic PriceList JSON string with terms.OnDemand…pricePerUnit.USD) → onDemandHourly parses + ec2HourlyCost sums × counts; empty ids → null. Run `cd web && npx vitest run lib/metrics.test.ts`.
- [ ] **Step 5: Commit** — `git add web/lib/metrics.ts web/lib/metrics.test.ts web/package.json web/package-lock.json && git commit -m "feat(v2-fe-f5): metrics lib — ec2AvgCpu (CloudWatch GetMetricData fleet avg) + ec2HourlyCost (Pricing API on-demand, cached)"`

---

### Task 2: metrics route + page cards + task-role IAM

**Files:** Create `web/app/api/inventory/[type]/metrics/route.ts`, `…/route.test.ts`; Modify `web/app/inventory/[type]/page.tsx`, `terraform/foundation/workload.tf`

- [ ] **Step 1: route** — `GET`, `dynamic='force-dynamic'`, verifyUser→401. If `params.type==='ec2'`: query Aurora (`getPool`) `SELECT data->>'instance_id' AS id, data->>'instance_state' AS state, data->>'instance_type' AS type FROM inventory_resources WHERE resource_type='ec2' AND account_id='self'`; running ids = rows where state='running'; typeCounts = count per type (all); `cpu=await ec2AvgCpu(runningIds)`, `cost=await ec2HourlyCost(typeCounts)`; return `{cards:[{label:'평균 CPU', value: cpu==null?'—':`${cpu}%`, accent:true},{label:'시간당 비용(USD)', value: cost==null?'—':`$${cost.toFixed(2)}`, accent:true}]}`. Else `{cards:[]}`. Wrap in try/catch → `{cards:[]}` (supplementary; never blank the page). 
- [ ] **Step 2: route test** — 401 unauth; ec2 → 2 cards (mock @/lib/metrics + getPool); non-ec2 (e.g. 's3') → `{cards:[]}`. Mirror inventory route test.
- [ ] **Step 3: page** — in `web/app/inventory/[type]/page.tsx`: add `const [metricCards,setMetricCards]=useState<{label:string;value:string|number;accent?:boolean}[]>([])`; a `useEffect` (on `type`) fetches `/api/inventory/${type}/metrics` → `setMetricCards(d.cards||[])` (catch→[]); render the metric cards as `<StatTile variant="accent">` appended INTO the existing KPI `grid grid-cols-2 md:grid-cols-5 gap-4` (after total + state tiles). No other change (donut/filters/detail-panel intact).
- [ ] **Step 4: IAM** — `terraform/foundation/workload.tf`: add `resource "aws_iam_role_policy" "task_metrics"` on `aws_iam_role.task`: Actions `cloudwatch:GetMetricData`, `cloudwatch:GetMetricStatistics`, `cloudwatch:ListMetrics`, `pricing:GetProducts`, `pricing:DescribeServices`; Resource `*`. `export PATH="$HOME/.local/bin:$PATH"; terraform fmt workload.tf; terraform validate; terraform plan` → only the new IAM policy (1 add), no other diffs.
- [ ] **Step 5: build+test** — `cd web && npm run test && npm run build` green; `terraform validate` Success.
- [ ] **Step 6: Commit** — `git add web/app/inventory terraform/foundation/workload.tf && git commit -m "feat(v2-fe-f5): GET /api/inventory/[type]/metrics (ec2 CPU+cost cards) + EC2 page metric KPI cards + task-role cloudwatch/pricing IAM"`

---

### Task 3: Local smoke + deploy + verify (CONTROLLER)
- [ ] **Step 1:** full gate `cd web && npm run test && npm run build`.
- [ ] **Step 2 (local smoke):** with deploy-host creds, run `ec2AvgCpu([<a few running instance-ids from the cluster account>])` + `ec2HourlyCost({'t3.micro':2,'t4g.nano':1})` via `npx tsx` → confirm a real CPU % + $/hr (proves CloudWatch + Pricing access/parse before deploy). (Get running EC2 ids via `aws ec2 describe-instances`.)
- [ ] **Step 3:** `terraform plan -out` (visible) → `apply` (task_metrics IAM); `make deploy`.
- [ ] **Step 4:** edge check `/api/inventory/ec2/metrics` 302; confirm (browser or local-smoke-proven) the EC2 page shows 평균 CPU + 시간당 비용. Report + values.

---

## Self-Review
- Closes gap #1 (v1's CPU/cost cards) with the real data sources (CloudWatch + Pricing), EC2-first + extensible.
- Supplementary + degrade-silent → never blanks the page; verifyUser-gated; read-only IAM.
- Local smoke de-risks CloudWatch/Pricing access + parse before deploy.
