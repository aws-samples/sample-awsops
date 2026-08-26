# Container Cost Dashboard — Design Spec
# 컨테이너 비용 대시보드 — 설계 스펙

## 1. Overview / 개요

Add a dedicated Container Cost page (`/container-cost`) to the AWSops dashboard that tracks and analyzes per-task (ECS) and per-pod (EKS) costs using actual resource usage data.

ECS Task별, EKS Pod별 실제 사용량 기반 비용 추적/분석 페이지를 AWSops 대시보드에 추가한다.

### Phased Approach / 단계별 접근

| Phase | Target | Data Source | Cost Items |
|-------|--------|-------------|------------|
| 1 | ECS | Container Insights (CloudWatch) | CPU + Memory + Fargate direct billing |
| 2 | EKS | OpenCost REST API (port 9003) | CPU + Memory + Network + Storage + GPU |

## 2. Architecture / 아키텍처

```
Phase 1 (ECS):
  Container Insights (CloudWatch)  -->  /api/container-cost/route.ts  -->  container-cost/page.tsx
  Cost Explorer (Fargate pricing)  -/

Phase 2 (EKS):
  OpenCost API (:9003)  -->  /api/container-cost/route.ts  -->  container-cost/page.tsx
  06f-setup-opencost.sh (Metrics Server + OpenCost install)
```

### Data Flow / 데이터 흐름

**ECS (Phase 1):**
1. `execFileSync` + `aws cloudwatch get-metric-data` — Container Insights metrics
   - Namespace: `AWS/ECS/ContainerInsights`
   - Metrics: `CpuUtilized`, `MemoryUtilized`, `CpuReserved`, `MemoryReserved`
   - Dimensions: ClusterName, ServiceName, TaskId
2. Steampipe `aws_ecs_task` — Task metadata (launch_type, cpu, memory, started_at)
3. Cost calculation:
   - Fargate: `CpuUtilized` vCPU-hours x $0.04048/hr + `MemoryUtilized` GB-hours x $0.004445/hr (ap-northeast-2)
   - EC2: Task resource ratio x instance cost allocation

**EKS (Phase 2):**
1. HTTP request to OpenCost API: `http://<opencost-service>:9003/allocation/compute`
   - Parameters: `window=1d`, `aggregate=namespace,pod`
2. Response includes: cpuCost, memoryCost, networkCost, pvCost, gpuCost, totalCost
3. OpenCost internally uses Metrics Server data + AWS pricing

## 3. UI Design / UI 설계

### Page Location / 페이지 위치
- Route: `/container-cost`
- Sidebar: After "EKS Explorer" (`/k8s/explorer`) in Compute section

### Layout / 레이아웃

**Top — StatsCards (4)**

| Card | Content | Color |
|------|---------|-------|
| Total Container Cost | ECS + EKS combined daily/monthly cost | cyan |
| ECS Tasks | Running task count + daily cost | green |
| EKS Pods | Running pod count + daily cost (Phase 2, disabled until then) | purple |
| Top Cost Namespace | Highest cost namespace name + amount | orange |

**Middle — Charts (2)**
- Daily cost trend: Recharts Line chart, ECS/EKS series separated by color
- Namespace cost distribution: Recharts Pie or Bar chart

**Bottom — Drilldown Table**
- Tabs: `ECS Tasks` | `EKS Pods` (Phase 2)
- ECS tab columns: Service, Task ID, CPU Used/Reserved, Memory Used/Reserved, Launch Type (Fargate/EC2), Daily Cost
- EKS tab columns: Pod, Namespace, CPU Cost, Memory Cost, Network Cost, Storage Cost, Total Cost, Node
- Filtering: namespace, service, cost range
- Sorting: by cost (default desc), by resource usage

### Theme / 테마
- Follow existing navy dark theme
- StatsCard `color` prop: names ('cyan', 'green', 'purple', 'orange')
- Chart colors: match existing Recharts palette

## 4. API Route / API 라우트

### File: `src/app/api/container-cost/route.ts`

**GET — Retrieve container cost data**

Query parameters:
- `type`: `ecs` | `eks` | `all` (default: `all`)
- `period`: `1d` | `7d` | `30d` (default: `1d`)
- `cluster`: cluster name filter (optional)
- `namespace`: namespace filter (optional)

Response structure:
```json
{
  "summary": {
    "totalDailyCost": 12.45,
    "ecsDailyCost": 8.20,
    "eksDailyCost": 4.25,
    "ecsTaskCount": 24,
    "eksPodCount": 87,
    "topNamespace": { "name": "production", "cost": 5.30 }
  },
  "ecsTasks": [
    {
      "cluster": "my-cluster",
      "service": "my-service",
      "taskId": "abc123",
      "cpuUtilized": 0.25,
      "cpuReserved": 0.5,
      "memoryUtilizedMB": 512,
      "memoryReservedMB": 1024,
      "launchType": "FARGATE",
      "dailyCost": 0.34,
      "startedAt": "2026-03-15T10:00:00Z"
    }
  ],
  "eksPods": [
    {
      "pod": "nginx-abc123",
      "namespace": "default",
      "cpuCost": 0.023,
      "memoryCost": 0.011,
      "networkCost": 0.003,
      "pvCost": 0.008,
      "gpuCost": 0.0,
      "totalCost": 0.045,
      "node": "ip-10-0-1-50"
    }
  ],
  "dailyTrend": [
    { "date": "2026-03-10", "ecsCost": 7.80, "eksCost": 4.10 }
  ],
  "namespaceCosts": [
    { "namespace": "production", "cost": 5.30 },
    { "namespace": "staging", "cost": 2.10 }
  ]
}
```

### ECS CloudWatch Metrics Collection / ECS CloudWatch 메트릭 수집

Pattern: Same as existing `/api/msk/route.ts`, `/api/rds/route.ts` — `execFileSync` with `aws cloudwatch get-metric-data`.

Metrics to collect per ECS service:
- `CpuUtilized` (vCPU count, actual usage)
- `MemoryUtilized` (bytes, actual usage)
- `CpuReserved` (vCPU count, reserved)
- `MemoryReserved` (bytes, reserved)
- `NetworkRxBytes`, `NetworkTxBytes` (optional)

### EKS OpenCost API Integration / EKS OpenCost API 연동

```typescript
// OpenCost allocation API call / OpenCost 할당 API 호출
const response = await fetch(
  `http://${OPENCOST_HOST}:9003/allocation/compute?window=${period}&aggregate=namespace,pod`
);
const data = await response.json();
```

OpenCost service access from EC2 (production):
- NodePort service created by `06f-setup-opencost.sh`
- EC2 accesses OpenCost via EKS worker node IP + NodePort
- `opencostEndpoint` configured in `data/config.json` (e.g., `http://<node-ip>:<nodeport>`)
- Security: EKS worker node security group must allow inbound from EC2 on the NodePort
- If `opencostEndpoint` is not set in config, EKS tab is disabled gracefully

## 5. Queries / 쿼리 파일

### File: `src/lib/queries/container-cost.ts`

```sql
-- ECS running tasks with metadata / ECS 실행 중 Task 메타데이터
ecsRunningTasks: `
  SELECT
    t.task_arn,
    t.cluster_arn,
    split_part(t.cluster_arn, '/', 2) AS cluster_name,
    t."group" AS service_name,
    t.cpu,
    t.memory,
    t.launch_type,
    t.last_status,
    t.started_at,
    t.connectivity,
    t.availability_zone
  FROM aws_ecs_task t
  WHERE t.last_status = 'RUNNING'
  ORDER BY t.cluster_arn, t."group"
`

-- ECS service summary / ECS 서비스별 요약
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
`

-- ECS clusters / ECS 클러스터
ecsClusters: `
  SELECT
    cluster_name,
    status,
    registered_container_instances_count,
    running_tasks_count,
    active_services_count
  FROM aws_ecs_cluster
  ORDER BY cluster_name
`
```

## 6. Sidebar / 사이드바 수정

### File: `src/components/layout/Sidebar.tsx`

Add menu item after EKS Explorer:
```typescript
{ name: 'Container Cost', href: '/container-cost', icon: DollarSign }
```

Note: Use `DollarSign` from lucide-react (not `DollarSignIcon`).

Position in sidebar:
```
Compute
  EC2
  Lambda
  ECS
  ECR
  EKS Overview
    Pods
    Nodes
    Deployments
    Services
    EKS Explorer
  Container Cost    <-- NEW
Network & CDN
  ...
```

## 7. AI Routing / AI 라우팅 수정

### File: `src/app/api/ai/route.ts`

Add keywords to `cost` route examples:
```typescript
examples: [
  // existing...
  '"컨테이너 비용" -> cost',
  '"Pod 비용 분석" -> cost',
  '"ECS Task 비용" -> cost',
  '"네임스페이스별 비용" -> cost',
]
```

Add to `aws-data` route for listing queries:
```typescript
examples: [
  // existing...
  '"ECS Task 목록과 비용" -> aws-data',
]
```

## 8. Deployment Script / 배포 스크립트

### File: `scripts/06f-setup-opencost.sh`

```bash
#!/bin/bash
# Step 6f: Install Metrics Server + OpenCost on EKS cluster
# 단계 6f: EKS 클러스터에 Metrics Server + OpenCost 설치

# Prerequisites / 전제 조건:
# - EKS cluster accessible via kubectl
# - Helm 3 installed
# - KUBECONFIG set (~/.kube/config)

# 1. Check/Install Helm / Helm 확인 및 설치
if ! command -v helm &> /dev/null; then
  curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
fi

# 2. Install Metrics Server / Metrics Server 설치
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
kubectl wait --for=condition=ready pod -l k8s-app=metrics-server -n kube-system --timeout=120s

# 3. Install OpenCost / OpenCost 설치
helm repo add opencost https://opencost.github.io/opencost-helm-chart
helm repo update
helm install opencost opencost/opencost \
  --namespace opencost --create-namespace \
  --set opencost.exporter.defaultClusterId="$(kubectl config current-context)" \
  --set opencost.exporter.aws.service_account_region=ap-northeast-2

# 4. Wait for OpenCost ready / OpenCost 준비 대기
kubectl wait --for=condition=ready pod -l app.kubernetes.io/name=opencost -n opencost --timeout=180s

# 5. Create NodePort service for EC2 access / EC2 접근용 NodePort 서비스
kubectl expose deployment opencost -n opencost \
  --type=NodePort --port=9003 --target-port=9003 --name=opencost-external \
  2>/dev/null || echo "Service already exists"

# 6. Verify / 확인
OPENCOST_PORT=$(kubectl get svc opencost-external -n opencost -o jsonpath='{.spec.ports[0].nodePort}')
echo "OpenCost accessible at: http://<node-ip>:${OPENCOST_PORT}"
echo "Test: curl http://localhost:${OPENCOST_PORT}/allocation/compute?window=1d"
```

### Deployment step order / 배포 단계 순서
```
Step 6a: AgentCore Runtime
Step 6b: AgentCore Gateways
Step 6c: AgentCore Tools (Lambda)
Step 6d: Code Interpreter
Step 6e: AgentCore Memory
Step 6f: OpenCost (Metrics Server + OpenCost)   <-- NEW
```

## 9. ECS Container Insights Prerequisite / ECS Container Insights 전제 조건

Container Insights must be enabled on ECS clusters. If not already enabled:

```bash
aws ecs update-cluster-settings \
  --cluster <cluster-name> \
  --settings name=containerInsights,value=enabled \
  --region ap-northeast-2
```

This is documented in the deployment script but NOT automated (user must enable per cluster).

## 10. Fargate Pricing Reference / Fargate 가격 참조 (ap-northeast-2)

| Resource | Price |
|----------|-------|
| vCPU per hour | $0.04048 |
| GB memory per hour | $0.004445 |
| Ephemeral storage (>20GB) per GB-hour | $0.000111 |

These values should be configurable in `data/config.json`:
```json
{
  "fargatePricing": {
    "region": "ap-northeast-2",
    "vcpuPerHour": 0.04048,
    "gbMemPerHour": 0.004445,
    "storagePerGbHour": 0.000111
  },
  "opencostEndpoint": ""
}
```

Note: `fargatePricing.region` documents which region the prices apply to.
Per-account deployment must update these values if deploying to a different region.
`opencostEndpoint` is empty until Phase 2 (OpenCost installation).
The `AppConfig` interface in `app-config.ts` uses optional fields, so new fields are backward-compatible.

## 11. Files to Create/Modify / 생성/수정 파일 목록

### New Files / 새 파일
| File | Description |
|------|-------------|
| `src/app/container-cost/page.tsx` | Container Cost page (ECS tab + EKS tab) |
| `src/app/container-cost/CLAUDE.md` | Directory documentation (auto-sync rule) |
| `src/app/api/container-cost/route.ts` | API route (CloudWatch + OpenCost) |
| `src/lib/queries/container-cost.ts` | ECS Steampipe queries |
| `scripts/06f-setup-opencost.sh` | OpenCost installation script |

### Modified Files / 수정 파일
| File | Change |
|------|--------|
| `src/components/layout/Sidebar.tsx` | Add Container Cost menu item |
| `src/app/api/ai/route.ts` | Add container cost keywords to routing |
| `data/config.json` | Add fargatePricing, opencostEndpoint fields |
| `CLAUDE.md` | Update page count (32), route count, script list |
| `src/app/CLAUDE.md` | Add container-cost page and API documentation |
| `src/lib/CLAUDE.md` | Add container-cost.ts query file |
| `src/lib/queries/CLAUDE.md` | Add container-cost.ts documentation |
| `src/components/CLAUDE.md` | Update if new components added |

## 12. Phase Implementation Order / 단계별 구현 순서

### Phase 1: ECS Container Cost (immediate)
1. Create `src/lib/queries/container-cost.ts` — ECS task queries
2. Create `src/app/api/container-cost/route.ts` — CloudWatch metrics + cost calculation
3. Create `src/app/container-cost/page.tsx` — UI with ECS tab (EKS tab disabled)
4. Modify `Sidebar.tsx` — Add menu item
5. Modify `ai/route.ts` — Add container cost keywords
6. Update documentation (CLAUDE.md files)
7. Build and test

### Phase 2: EKS Pod Cost (after OpenCost installation)
1. Create `scripts/06f-setup-opencost.sh` — Installation script
2. Run script on EKS cluster
3. Extend `api/container-cost/route.ts` — Add OpenCost API integration
4. Enable EKS tab in `container-cost/page.tsx`
5. Add config fields to `data/config.json` (opencostEndpoint)
6. Update documentation
7. Build and test

## 13. Testing / 테스트

### Phase 1 Validation
- [ ] ECS tasks visible in table with correct metadata
- [ ] Container Insights metrics (CPU/Memory) displayed
- [ ] Fargate cost calculation matches expected values
- [ ] Daily trend chart renders correctly
- [ ] Namespace cost aggregation is accurate
- [ ] AI routing classifies "ECS Task 비용" to cost route

### Phase 2 Validation
- [ ] OpenCost API returns valid data
- [ ] EKS tab shows pods with 5-item cost breakdown (CPU/Memory/Network/Storage/GPU)
- [ ] Combined ECS + EKS total cost in StatsCards
- [ ] OpenCost installation script runs idempotently

## 14. Error Handling / 에러 처리

- **Container Insights not enabled**: If CloudWatch returns zero data points for a cluster, API response includes `insightsEnabled: false` per cluster. UI shows a warning banner: "Container Insights not enabled on cluster X. Enable it to see cost data."
- **OpenCost not installed (Phase 2)**: If `opencostEndpoint` is empty or unreachable, EKS tab shows disabled state with message: "OpenCost not configured. Run 06f-setup-opencost.sh."
- **No ECS tasks running**: Show empty state with message, not $0.00 costs.
- **CloudWatch API throttling**: Retry with exponential backoff (same pattern as existing metric APIs).

## 15. Query File Pattern / 쿼리 파일 패턴

Follow existing pattern from `src/lib/queries/ecs.ts`:
```typescript
export const queries = {
  ecsRunningTasks: `SELECT ...`,
  ecsServiceSummary: `SELECT ...`,
  ecsClusters: `SELECT ...`,
};
```

## 16. Out of Scope / 범위 밖

- Real-time streaming metrics (polling interval is sufficient)
- Custom cost allocation tags for ECS (future enhancement)
- Multi-cluster cost comparison (single cluster per type for now)
- Spot instance pricing integration for OpenCost (manual config)
- Cost alert/budget features for containers (use existing cost gateway)
