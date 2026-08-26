# Container Cost Dashboard (Phase 1: ECS) — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Container Cost page (`/container-cost`) that displays ECS task-level cost analysis using CloudWatch Container Insights metrics and Fargate pricing.

**Architecture:** New page follows existing AWSops pattern: Steampipe SQL queries for ECS task metadata + CloudWatch `execFileSync` API for Container Insights metrics + Fargate unit pricing for cost calculation. Data flows through a new API route (`/api/container-cost`) to a client-side page with StatsCards, charts, and drilldown table.

**Tech Stack:** Next.js 14 (App Router), Tailwind CSS, Recharts, Steampipe PostgreSQL, AWS CloudWatch CLI (`execFileSync`), lucide-react icons.

**Spec:** `docs/superpowers/specs/2026-03-16-container-cost-design.md`

---

## File Structure

| File | Responsibility | Action |
|------|---------------|--------|
| `src/lib/queries/container-cost.ts` | ECS task/cluster SQL queries via Steampipe | Create |
| `src/app/api/container-cost/route.ts` | API: ECS metadata + CloudWatch metrics + cost calc | Create |
| `src/app/container-cost/page.tsx` | UI: StatsCards + charts + drilldown table | Create |
| `src/app/container-cost/CLAUDE.md` | Directory documentation (auto-sync rule) | Create |
| `src/components/layout/Sidebar.tsx` | Add Container Cost menu item after EKS Explorer | Modify |
| `src/app/api/ai/route.ts` | Add container cost keywords to cost route | Modify |
| `src/lib/app-config.ts` | Add fargatePricing + opencostEndpoint to AppConfig | Modify |

---

## Chunk 1: Data Layer (Queries + Config)

### Task 1: Create ECS query file

**Files:**
- Create: `src/lib/queries/container-cost.ts`

- [ ] **Step 1: Create the query file with ECS task queries**

```typescript
// ECS container cost queries / ECS 컨테이너 비용 쿼리
export const queries = {
  // Running tasks with metadata / 실행 중 Task 메타데이터
  ecsRunningTasks: `
    SELECT
      t.task_arn,
      split_part(t.task_arn, '/', 2) AS task_id,
      split_part(t.cluster_arn, '/', 2) AS cluster_name,
      t."group" AS service_name,
      t.cpu,
      t.memory,
      t.launch_type,
      t.last_status,
      t.started_at,
      t.availability_zone
    FROM aws_ecs_task t
    WHERE t.last_status = 'RUNNING'
    ORDER BY t.cluster_arn, t."group"
  `,

  // Service-level summary / 서비스별 요약
  ecsServiceSummary: `
    SELECT
      split_part(t.cluster_arn, '/', 2) AS cluster_name,
      t."group" AS service_name,
      t.launch_type,
      COUNT(*) AS task_count,
      SUM(t.cpu::int) AS total_cpu_units,
      SUM(t.memory::int) AS total_memory_mb
    FROM aws_ecs_task t
    WHERE t.last_status = 'RUNNING'
    GROUP BY split_part(t.cluster_arn, '/', 2), t."group", t.launch_type
    ORDER BY 1, 2
  `,

  // Cluster overview / 클러스터 개요
  ecsClusters: `
    SELECT
      cluster_name,
      status,
      registered_container_instances_count,
      running_tasks_count,
      active_services_count
    FROM aws_ecs_cluster
    ORDER BY cluster_name
  `,
};
```

- [ ] **Step 2: Verify query syntax by checking column names**

Run on EC2 (Steampipe):
```bash
cd ~/awsops && node -e "
const { runQuery } = require('./src/lib/steampipe');
runQuery(\"SELECT column_name FROM information_schema.columns WHERE table_name = 'aws_ecs_task' ORDER BY column_name\")
  .then(r => console.log(r.rows.map(r => r.column_name).join(', ')))
  .catch(e => console.error(e));
"
```

Expected: Column list includes `task_arn`, `cluster_arn`, `cpu`, `memory`, `launch_type`, `last_status`, `started_at`, `availability_zone`, `group`.

- [ ] **Step 3: Commit**

```bash
git add src/lib/queries/container-cost.ts
git commit -m "feat: add ECS container cost queries"
```

---

### Task 2: Extend AppConfig for Fargate pricing

**Files:**
- Modify: `src/lib/app-config.ts` (lines 6-13)

- [ ] **Step 1: Add FargatePricing interface and new config fields**

Add after the existing `AppConfig` interface:

```typescript
export interface FargatePricing {
  region?: string;        // Region these prices apply to / 가격 적용 리전
  vcpuPerHour?: number;   // Fargate vCPU price per hour / Fargate vCPU 시간당 가격
  gbMemPerHour?: number;  // Fargate GB memory price per hour / Fargate GB 메모리 시간당 가격
  storagePerGbHour?: number; // Ephemeral storage price / 임시 스토리지 가격
}
```

Add to `AppConfig` interface (after `steampipePassword?`):

```typescript
  fargatePricing?: FargatePricing;
  opencostEndpoint?: string;   // OpenCost API endpoint (Phase 2) / OpenCost API 엔드포인트 (2단계)
```

Add default Fargate pricing to `DEFAULT_CONFIG`:

```typescript
const DEFAULT_CONFIG: AppConfig = {
  costEnabled: true,
  fargatePricing: {
    region: 'ap-northeast-2',
    vcpuPerHour: 0.04048,
    gbMemPerHour: 0.004445,
    storagePerGbHour: 0.000111,
  },
};
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/app-config.ts
git commit -m "feat: add Fargate pricing config to AppConfig"
```

---

## Chunk 2: API Route

### Task 3: Create Container Cost API route

**Files:**
- Create: `src/app/api/container-cost/route.ts`

Reference: `src/app/api/msk/route.ts` for CloudWatch `execFileSync` pattern.

- [ ] **Step 1: Create the API route file**

The API route handles two actions:
1. `tasks` — Get ECS task list with Steampipe metadata
2. `metrics` — Get Container Insights CloudWatch metrics for a cluster/service

Pattern: Follow MSK route — `execFileSync('aws', [...])` for CloudWatch, `runQuery()` for Steampipe.

```typescript
// Container Cost API: ECS task metadata + CloudWatch Container Insights metrics
// 컨테이너 비용 API: ECS Task 메타데이터 + CloudWatch Container Insights 메트릭
import { NextRequest, NextResponse } from 'next/server';
import { execFileSync } from 'child_process';
import { runQuery } from '@/lib/steampipe';
import { getConfig } from '@/lib/app-config';
import { queries } from '@/lib/queries/container-cost';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const REGION = 'ap-northeast-2';

// AWS CLI helper — same pattern as msk/route.ts / AWS CLI 헬퍼 — msk/route.ts와 동일 패턴
function awsCli(args: string[]): any | null {
  try {
    const result = execFileSync('aws', [...args, '--region', REGION, '--output', 'json'], {
      encoding: 'utf-8', timeout: 30000,
    });
    return JSON.parse(result);
  } catch {
    return null;
  }
}

// Fargate cost calculation / Fargate 비용 계산
function calculateFargateCost(cpuUnits: number, memoryMb: number, hours: number): {
  cpuCost: number; memoryCost: number; totalCost: number;
} {
  const config = getConfig();
  const pricing = config.fargatePricing || { vcpuPerHour: 0.04048, gbMemPerHour: 0.004445 };
  const vcpu = cpuUnits / 1024;
  const gbMem = memoryMb / 1024;
  const cpuCost = vcpu * (pricing.vcpuPerHour || 0.04048) * hours;
  const memoryCost = gbMem * (pricing.gbMemPerHour || 0.004445) * hours;
  return { cpuCost, memoryCost, totalCost: cpuCost + memoryCost };
}

// Container Insights metrics query / Container Insights 메트릭 쿼리
function getContainerInsightsMetrics(clusterName: string, serviceName?: string): any | null {
  const now = new Date();
  const start = new Date(now.getTime() - 3600 * 1000); // 1 hour ago / 1시간 전

  const dimensions: any[] = [{ Name: 'ClusterName', Value: clusterName }];
  if (serviceName) dimensions.push({ Name: 'ServiceName', Value: serviceName });

  const metricDefs = [
    { key: 'cpuUtilized', name: 'CpuUtilized', stat: 'Average' },
    { key: 'memoryUtilized', name: 'MemoryUtilized', stat: 'Average' },
    { key: 'cpuReserved', name: 'CpuReserved', stat: 'Average' },
    { key: 'memoryReserved', name: 'MemoryReserved', stat: 'Average' },
  ];

  const metricQueries = metricDefs.map((m, i) => ({
    Id: `m${i}`,
    MetricStat: {
      Metric: {
        Namespace: 'AWS/ECS/ContainerInsights',
        MetricName: m.name,
        Dimensions: dimensions,
      },
      Period: 300,
      Stat: m.stat,
    },
  }));

  const input = {
    MetricDataQueries: metricQueries,
    StartTime: start.toISOString(),
    EndTime: now.toISOString(),
  };

  // Write to temp file to avoid arg length limits / 임시 파일로 arg 길이 제한 회피
  const tmpFile = join(tmpdir(), `container-cost-${Date.now()}.json`);
  try {
    writeFileSync(tmpFile, JSON.stringify(input));
    const result = awsCli(['cloudwatch', 'get-metric-data', '--cli-input-json', `file://${tmpFile}`]);
    unlinkSync(tmpFile);

    if (!result?.MetricDataResults) return null;

    const metrics: Record<string, number> = {};
    result.MetricDataResults.forEach((r: any, i: number) => {
      const values = r.Values || [];
      metrics[metricDefs[i].key] = values.length > 0
        ? values.reduce((a: number, b: number) => a + b, 0) / values.length
        : 0;
    });
    return metrics;
  } catch {
    try { unlinkSync(tmpFile); } catch {}
    return null;
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action') || 'summary';

  try {
    if (action === 'tasks') {
      // ECS running tasks / ECS 실행 중 Task 목록
      const result = await runQuery(queries.ecsRunningTasks);
      if (result.error) return NextResponse.json({ error: result.error }, { status: 500 });

      // Calculate cost per task / Task별 비용 계산
      const tasks = result.rows.map((t: any) => {
        const cpuUnits = parseInt(t.cpu) || 256;
        const memoryMb = parseInt(t.memory) || 512;
        const startedAt = new Date(t.started_at);
        const hoursRunning = Math.max((Date.now() - startedAt.getTime()) / 3600000, 0.01);
        const cost = t.launch_type === 'FARGATE'
          ? calculateFargateCost(cpuUnits, memoryMb, hoursRunning)
          : { cpuCost: 0, memoryCost: 0, totalCost: 0 }; // EC2: requires node cost allocation / EC2: 노드 비용 분배 필요
        const dailyCost = t.launch_type === 'FARGATE'
          ? calculateFargateCost(cpuUnits, memoryMb, 24)
          : { cpuCost: 0, memoryCost: 0, totalCost: 0 };
        return { ...t, hoursRunning: Math.round(hoursRunning * 10) / 10, cost, dailyCost };
      });

      return NextResponse.json({ tasks });
    }

    if (action === 'metrics') {
      // Container Insights metrics per cluster / 클러스터별 Container Insights 메트릭
      const clusterName = searchParams.get('cluster');
      const serviceName = searchParams.get('service') || undefined;
      if (!clusterName) return NextResponse.json({ error: 'cluster required' }, { status: 400 });

      const metrics = getContainerInsightsMetrics(clusterName, serviceName);
      if (!metrics) {
        return NextResponse.json({
          metrics: null,
          insightsEnabled: false,
          message: 'Container Insights not enabled or no data available',
        });
      }
      return NextResponse.json({ metrics, insightsEnabled: true });
    }

    // Default: summary / 기본: 요약
    const [tasksResult, servicesResult, clustersResult] = await Promise.all([
      runQuery(queries.ecsRunningTasks),
      runQuery(queries.ecsServiceSummary),
      runQuery(queries.ecsClusters),
    ]);

    const tasks = (tasksResult.rows || []).map((t: any) => {
      const cpuUnits = parseInt(t.cpu) || 256;
      const memoryMb = parseInt(t.memory) || 512;
      const dailyCost = t.launch_type === 'FARGATE'
        ? calculateFargateCost(cpuUnits, memoryMb, 24)
        : { cpuCost: 0, memoryCost: 0, totalCost: 0 };
      return { ...t, dailyCost };
    });

    const totalDailyCost = tasks.reduce((sum: number, t: any) => sum + t.dailyCost.totalCost, 0);
    const fargateCount = tasks.filter((t: any) => t.launch_type === 'FARGATE').length;
    const ec2Count = tasks.filter((t: any) => t.launch_type === 'EC2').length;

    // Namespace (service) cost aggregation / 네임스페이스(서비스)별 비용 집계
    const serviceCosts: Record<string, number> = {};
    tasks.forEach((t: any) => {
      const svc = t.service_name || 'unknown';
      serviceCosts[svc] = (serviceCosts[svc] || 0) + t.dailyCost.totalCost;
    });
    const namespaceCosts = Object.entries(serviceCosts)
      .map(([name, cost]) => ({ name, cost: Math.round(cost * 1000) / 1000 }))
      .sort((a, b) => b.cost - a.cost);

    return NextResponse.json({
      summary: {
        totalDailyCost: Math.round(totalDailyCost * 1000) / 1000,
        totalMonthly: Math.round(totalDailyCost * 30 * 100) / 100,
        taskCount: tasks.length,
        fargateCount,
        ec2Count,
        clusterCount: clustersResult.rows?.length || 0,
        topService: namespaceCosts[0] || null,
      },
      tasks,
      services: servicesResult.rows || [],
      clusters: clustersResult.rows || [],
      namespaceCosts,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to fetch container cost data' }, { status: 500 });
  }
}
```

- [ ] **Step 2: Verify build compiles**

```bash
cd ~/awsops && npx next build 2>&1 | tail -5
```

Expected: Build succeeds or shows only the new route in compilation.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/container-cost/route.ts
git commit -m "feat: add container cost API route with CloudWatch Container Insights"
```

---

## Chunk 3: UI Page

### Task 4: Create Container Cost page

**Files:**
- Create: `src/app/container-cost/page.tsx`

Reference: `src/app/ecs/page.tsx` for layout pattern (StatsCards + chart + DataTable).

- [ ] **Step 1: Create the page file**

```typescript
'use client';
// Container Cost Dashboard / 컨테이너 비용 대시보드
// Phase 1: ECS Task cost analysis via Container Insights + Fargate pricing
// 1단계: Container Insights + Fargate 가격 기반 ECS Task 비용 분석

import { useState, useEffect, useCallback } from 'react';
import Header from '@/components/layout/Header';
import StatsCard from '@/components/common/StatsCard';
import DataTable from '@/components/common/DataTable';
import { DollarSign, Container, Cpu, TrendingUp } from 'lucide-react';
import { PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';

interface Task {
  task_id: string;
  cluster_name: string;
  service_name: string;
  cpu: string;
  memory: string;
  launch_type: string;
  started_at: string;
  availability_zone: string;
  dailyCost: { cpuCost: number; memoryCost: number; totalCost: number };
}

interface Summary {
  totalDailyCost: number;
  totalMonthly: number;
  taskCount: number;
  fargateCount: number;
  ec2Count: number;
  clusterCount: number;
  topService: { name: string; cost: number } | null;
}

interface ContainerCostData {
  summary: Summary;
  tasks: Task[];
  services: any[];
  clusters: any[];
  namespaceCosts: { name: string; cost: number }[];
}

const CHART_COLORS = ['#00d4ff', '#00ff88', '#a855f7', '#f59e0b', '#ef4444', '#6366f1', '#14b8a6', '#f97316'];

export default function ContainerCostPage() {
  const [data, setData] = useState<ContainerCostData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch('/awsops/api/container-cost');
      if (!res.ok) throw new Error(`Server error: ${res.status}`);
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      setData(json);
      setError(null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const formatCost = (cost: number) => `$${cost.toFixed(3)}`;
  const formatCostLg = (cost: number) => `$${cost.toFixed(2)}`;

  return (
    <div className="space-y-6">
      <Header
        title="Container Cost"
        subtitle="ECS Task cost analysis based on Fargate pricing and Container Insights"
      />

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 text-red-400">
          {error}
        </div>
      )}

      {/* StatsCards / 통계 카드 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatsCard
          label="Daily Cost (ECS)"
          value={data ? formatCostLg(data.summary.totalDailyCost) : '-'}
          icon={DollarSign}
          color="cyan"
        />
        <StatsCard
          label="Monthly Estimate"
          value={data ? formatCostLg(data.summary.totalMonthly) : '-'}
          icon={TrendingUp}
          color="green"
        />
        <StatsCard
          label="Running Tasks"
          value={data ? `${data.summary.taskCount} (F:${data.summary.fargateCount} / EC2:${data.summary.ec2Count})` : '-'}
          icon={Container}
          color="purple"
        />
        <StatsCard
          label="Top Cost Service"
          value={data?.summary.topService ? `${data.summary.topService.name.replace(/^service:/, '')} (${formatCost(data.summary.topService.cost)}/day)` : '-'}
          icon={Cpu}
          color="orange"
        />
      </div>

      {/* Charts / 차트 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Service Cost Distribution / 서비스별 비용 분포 */}
        <div className="bg-navy-800 rounded-lg p-4 border border-navy-600">
          <h3 className="text-white font-medium mb-4">Service Cost Distribution (Daily)</h3>
          {data && data.namespaceCosts.length > 0 ? (
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={data.namespaceCosts.map(s => ({
                    name: s.name.replace(/^service:/, ''),
                    value: s.cost,
                  }))}
                  cx="50%" cy="50%" outerRadius={100}
                  dataKey="value" nameKey="name"
                  label={({ name, value }) => `${name}: $${value.toFixed(3)}`}
                >
                  {data.namespaceCosts.map((_, i) => (
                    <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip formatter={(value: number) => formatCost(value)} />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[300px] flex items-center justify-center text-gray-500">
              No ECS tasks running
            </div>
          )}
        </div>

        {/* Service Cost Bar Chart / 서비스별 비용 바 차트 */}
        <div className="bg-navy-800 rounded-lg p-4 border border-navy-600">
          <h3 className="text-white font-medium mb-4">Cost by Service (CPU vs Memory)</h3>
          {data && data.services.length > 0 ? (
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={data.services.map((s: any) => {
                const svcTasks = data.tasks.filter(t => t.service_name === s.service_name);
                const cpuCost = svcTasks.reduce((sum, t) => sum + t.dailyCost.cpuCost, 0);
                const memCost = svcTasks.reduce((sum, t) => sum + t.dailyCost.memoryCost, 0);
                return {
                  name: (s.service_name || '').replace(/^service:/, ''),
                  CPU: Math.round(cpuCost * 1000) / 1000,
                  Memory: Math.round(memCost * 1000) / 1000,
                };
              })}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1a2540" />
                <XAxis dataKey="name" tick={{ fill: '#9ca3af', fontSize: 11 }} />
                <YAxis tick={{ fill: '#9ca3af', fontSize: 11 }} />
                <Tooltip contentStyle={{ backgroundColor: '#0f1629', border: '1px solid #1a2540', borderRadius: '8px' }} />
                <Legend />
                <Bar dataKey="CPU" fill="#00d4ff" />
                <Bar dataKey="Memory" fill="#00ff88" />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[300px] flex items-center justify-center text-gray-500">
              No service data available
            </div>
          )}
        </div>
      </div>

      {/* Task Table / Task 테이블 */}
      <div className="bg-navy-800 rounded-lg p-4 border border-navy-600">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-white font-medium">ECS Tasks — Cost Breakdown</h3>
          <span className="text-xs text-gray-400">
            Fargate tasks show calculated cost. EC2 tasks require node cost allocation (Phase 2).
          </span>
        </div>
        <DataTable
          columns={[
            { key: 'cluster_name', label: 'Cluster' },
            {
              key: 'service_name', label: 'Service',
              render: (v: string) => <span className="text-cyan-400">{(v || '').replace(/^service:/, '')}</span>,
            },
            { key: 'task_id', label: 'Task ID', render: (v: string) => <span className="font-mono text-xs">{v?.slice(0, 12)}</span> },
            {
              key: 'launch_type', label: 'Type',
              render: (v: string) => (
                <span className={`px-2 py-0.5 rounded text-xs ${v === 'FARGATE' ? 'bg-purple-500/20 text-purple-400' : 'bg-blue-500/20 text-blue-400'}`}>
                  {v}
                </span>
              ),
            },
            { key: 'cpu', label: 'CPU (units)', render: (v: string) => `${v} (${(parseInt(v) / 1024).toFixed(2)} vCPU)` },
            { key: 'memory', label: 'Memory (MB)', render: (v: string) => `${v} (${(parseInt(v) / 1024).toFixed(1)} GB)` },
            {
              key: 'dailyCost', label: 'Daily Cost',
              render: (_: any, row: Task) => row.launch_type === 'FARGATE'
                ? <span className="text-green-400 font-medium">{formatCost(row.dailyCost.totalCost)}</span>
                : <span className="text-gray-500">N/A (EC2)</span>,
            },
            { key: 'availability_zone', label: 'AZ' },
          ]}
          data={data?.tasks}
        />
      </div>

      {/* EKS Tab Placeholder (Phase 2) / EKS 탭 플레이스홀더 (2단계) */}
      <div className="bg-navy-800 rounded-lg p-4 border border-navy-600 opacity-50">
        <h3 className="text-white font-medium mb-2">EKS Pod Cost (Phase 2)</h3>
        <p className="text-gray-400 text-sm">
          OpenCost integration for EKS pod-level cost analysis (CPU, Memory, Network, Storage, GPU).
          Install OpenCost with <code className="text-cyan-400">scripts/06f-setup-opencost.sh</code> to enable.
        </p>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create CLAUDE.md for the new directory**

Create `src/app/container-cost/CLAUDE.md`:

```markdown
# Container Cost / 컨테이너 비용

## Role / 역할
ECS Task and EKS Pod cost analysis page.
ECS Task 및 EKS Pod 비용 분석 페이지.

## Files / 파일
- `page.tsx` — Container Cost dashboard (Phase 1: ECS, Phase 2: EKS/OpenCost)

## Data Sources / 데이터 소스
- Phase 1: Steampipe `aws_ecs_task` + CloudWatch Container Insights (`AWS/ECS/ContainerInsights`)
- Phase 2: OpenCost REST API (port 9003) — deferred

## Cost Calculation / 비용 계산
- Fargate: vCPU-hours x unit price + GB-hours x unit price (configurable in data/config.json)
- EC2 launch type: requires node cost allocation (not implemented in Phase 1)
```

- [ ] **Step 3: Build verification**

```bash
cd ~/awsops && npx next build 2>&1 | tail -10
```

Expected: Build succeeds with new route `/container-cost` in output.

- [ ] **Step 4: Commit**

```bash
git add src/app/container-cost/
git commit -m "feat: add Container Cost page with ECS task cost analysis"
```

---

## Chunk 4: Integration (Sidebar + AI Routing)

### Task 5: Add Container Cost to Sidebar

**Files:**
- Modify: `src/components/layout/Sidebar.tsx`

- [ ] **Step 1: Add menu item after EKS Explorer**

Find the Compute group's items array (after the `{ label: 'EKS Explorer', href: '/k8s/explorer', icon: ... }` entry).

Add:
```typescript
{ label: 'Container Cost', href: '/container-cost', icon: DollarSign },
```

The `DollarSign` icon is already imported (used by Cost page). Verify by checking imports at the top of the file.

- [ ] **Step 2: Commit**

```bash
git add src/components/layout/Sidebar.tsx
git commit -m "feat: add Container Cost to sidebar after EKS Explorer"
```

---

### Task 6: Add container cost keywords to AI routing

**Files:**
- Modify: `src/app/api/ai/route.ts` (cost route section, around line 153-164)

- [ ] **Step 1: Extend cost route tools and examples**

In the `cost` route entry of `ROUTE_REGISTRY`, add to `tools` array:
```typescript
'Container Cost (ECS/EKS 워크로드별 비용 분석)',
```

Add to `examples` array:
```typescript
'"컨테이너 비용" → cost', '"ECS Task 비용" → cost', '"Pod 비용 분석" → cost', '"네임스페이스별 비용" → cost',
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/ai/route.ts
git commit -m "feat: add container cost keywords to AI routing"
```

---

## Chunk 5: Documentation + Final Build

### Task 7: Update documentation

**Files:**
- Modify: `CLAUDE.md`
- Modify: `src/app/CLAUDE.md`
- Modify: `src/lib/CLAUDE.md`
- Modify: `src/lib/queries/CLAUDE.md` (if exists)

- [ ] **Step 1: Update root CLAUDE.md**

Update the stats table:
- Pages: 31 → 32
- Routes: 46 → 47
- SQL Query Files: 22 → 23
- API Routes: 10 → 11

Add to Key Files section under API Routes:
```
| `api/container-cost/route.ts` | ECS Container Cost (CloudWatch + Fargate pricing) |
```

Add to Deployment Scripts section:
```
Step 6f: 06f-setup-opencost.sh    OpenCost (Phase 2 — Metrics Server + OpenCost)
```

- [ ] **Step 2: Update src/app/CLAUDE.md**

Add under Monitoring section (or create new "Cost" subsection):
```
- `container-cost/page.tsx` — Container Cost (ECS Task cost + Phase 2: EKS Pod/OpenCost)
```

Add to API Routes table:
```
| `api/container-cost/route.ts` | ECS Container Cost (CloudWatch Container Insights + Fargate pricing) |
```

- [ ] **Step 3: Update src/lib/CLAUDE.md and queries CLAUDE.md**

Add `container-cost.ts` to the queries list.

- [ ] **Step 4: Commit all documentation**

```bash
git add CLAUDE.md src/app/CLAUDE.md src/lib/CLAUDE.md src/lib/queries/CLAUDE.md
git commit -m "docs: update documentation for Container Cost feature"
```

---

### Task 8: Final build and verification

- [ ] **Step 1: Full production build**

```bash
cd ~/awsops && npm run build
```

Expected: Build succeeds with no errors. New routes `/container-cost` and `/api/container-cost` appear in output.

- [ ] **Step 2: Manual verification checklist**

Start server and verify:
```bash
pkill -f "next-server" && sleep 2
nohup sh -c "PORT=3000 npm run start" > /tmp/awsops-server.log 2>&1 &
sleep 5
```

Test API:
```bash
curl -s http://localhost:3000/awsops/api/container-cost | python3 -m json.tool | head -20
```

Test page: Open `https://<cloudfront>/awsops/container-cost` in browser.

Verify:
- [ ] StatsCards display cost data (or $0.00 if no ECS tasks)
- [ ] Pie chart shows service cost distribution
- [ ] Bar chart shows CPU vs Memory cost breakdown
- [ ] Task table lists running ECS tasks with Fargate cost
- [ ] Sidebar shows Container Cost link in correct position
- [ ] EKS Phase 2 placeholder section is visible but disabled

- [ ] **Step 3: Final commit if any fixes needed**

```bash
git add -A && git commit -m "fix: container cost page adjustments after testing"
```
