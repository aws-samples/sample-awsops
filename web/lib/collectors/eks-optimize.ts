// EKS Cost Optimizer collector — v1 port (v1 src/lib/collectors/eks-optimize.ts) on v2 sources.
// EKS 리소스 최적화: 클러스터/파드 설정(Steampipe) + CloudWatch Container Insights 메트릭 수집.
//
// v1 → v2 source mapping:
// - Prometheus metric discovery (v1)  → 미가용 in v2 (no datasource client here) — SKIPPED, disclosed.
// - Per-pod cost API / OpenCost (v1)  → 미가용 in v2 — SKIPPED, disclosed; the analysis estimates
//   from node instance types instead.
// - K8s requests/limits + node capacity (v1 Steampipe) → runSteampipeQuery (guarded, 200-row cap).
// - NEW in v2: CloudWatch Container Insights cluster/node metrics via lib/metrics
//   eksClusterCI/eksNodesCI (utilization, throttle-adjacent signals: restarts/OOM/CrashLoop).
import { runSteampipeQuery, steampipeAvailable } from '../aws-data';
import { eksClusterCI, eksNodesCI } from '../metrics';
import type { ChatCollector, CollectCtx, CollectOutput } from './index';

// Cap the CI fan-out: 2 CloudWatch paths (cluster rollup + per-node) per cluster.
const CLUSTER_CAP = 3;

// ── Steampipe SQL (v1 eks-container-cost queries + cluster discovery; LIMITs added — the
//    runSteampipeQuery guard additionally enforces SELECT-only and a 200-row cap) ──

export const EKS_SQL = {
  clusters: `
SELECT name, version, status, region, account_id
FROM aws_eks_cluster
ORDER BY name
LIMIT 10`,

  // v1 queries/eks-container-cost.ts podResourceRequests
  podResourceRequests: `
SELECT
  p.name AS pod_name,
  p.namespace,
  p.phase,
  p.node_name,
  p.context_name,
  c ->> 'name' AS container_name,
  c -> 'resources' -> 'requests' ->> 'cpu' AS cpu_request,
  c -> 'resources' -> 'requests' ->> 'memory' AS memory_request,
  c -> 'resources' -> 'limits' ->> 'cpu' AS cpu_limit,
  c -> 'resources' -> 'limits' ->> 'memory' AS memory_limit
FROM
  kubernetes_pod p,
  jsonb_array_elements(p.containers) AS c
WHERE
  p.phase = 'Running' AND p.node_name IS NOT NULL
ORDER BY
  p.namespace, p.name
LIMIT 200`,

  // v1 queries/eks-container-cost.ts nodeCapacity
  nodeCapacity: `
SELECT
  name AS node_name,
  capacity_cpu,
  capacity_memory,
  allocatable_cpu,
  allocatable_memory,
  node_info ->> 'instanceType' AS instance_type,
  node_info ->> 'osImage' AS os_image,
  context_name
FROM
  kubernetes_node
ORDER BY
  name
LIMIT 100`,
} as const;

const oneLine = (sql: string) => sql.trim().replace(/\s+/g, ' ');

interface ClusterCI {
  name: string;
  region?: string;
  cluster: Record<string, number | null>;
  nodes: Record<string, Record<string, number | null>>;
  hasData: boolean;
}

// ── Collector implementation ────────────────────────────────────────────────

const eksOptimizeCollector: ChatCollector = {
  key: 'eks-optimize',
  sectionMeta: { agentName: 'EKS Cost Optimizer' },

  // Cluster discovery + K8s config both ride Steampipe — down ⇒ normal routing (CloudWatch CI
  // alone cannot even enumerate the clusters to probe).
  available: () => steampipeAvailable(),

  async collect(ctx: CollectCtx): Promise<CollectOutput> {
    const summary: string[] = [];
    const sections: string[] = [];
    const tools: string[] = [];
    let collected = 0;

    // 1) EKS clusters (Steampipe)
    ctx.onStep({ tool: 'steampipe_sql', query: oneLine(EKS_SQL.clusters) });
    let clusters: { name: string; region?: string }[] = [];
    try {
      const r = await runSteampipeQuery(EKS_SQL.clusters);
      clusters = r.rows.map((row) => ({ name: String(row.name), region: row.region ? String(row.region) : undefined }));
      collected++;
      if (!tools.includes('steampipe_sql')) tools.push('steampipe_sql');
      summary.push(`EKS clusters (Steampipe): ${clusters.length} found`);
      sections.push(`## EKS Clusters (Steampipe)\n\`\`\`json\n${JSON.stringify(r.rows)}\n\`\`\``);
    } catch (e) {
      summary.push(`EKS clusters (Steampipe): 미가용 (query failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)})`);
    }

    // 2) CloudWatch Container Insights per cluster (rollup + per-node). fleetLatest never throws —
    //    an all-null rollup + empty node map means CI is not enabled for that cluster.
    const probed = clusters.slice(0, CLUSTER_CAP);
    const ciResults: ClusterCI[] = [];
    for (const c of probed) {
      if (ctx.signal?.aborted) break;
      ctx.onStep({ tool: 'cloudwatch_ci', query: `ContainerInsights cluster+node metrics: ${c.name}${c.region ? ` (${c.region})` : ''}` });
      const [cluster, nodes] = await Promise.all([
        eksClusterCI(c.name, c.region),
        eksNodesCI(c.name, c.region, 3600, 50),
      ]);
      const hasData = Object.values(cluster).some((v) => v !== null) || Object.keys(nodes).length > 0;
      ciResults.push({ name: c.name, region: c.region, cluster, nodes, hasData });
    }
    const ciWithData = ciResults.filter((r) => r.hasData);
    if (ciWithData.length > 0) {
      collected += ciWithData.length;
      tools.push('cloudwatch_ci');
      for (const r of ciWithData) {
        sections.push(
          `## Container Insights — ${r.name} (last 1h, CloudWatch)\n` +
          `Cluster rollup (node/pod counts, restarts, OOMKilled, CrashLoop, CPU/mem over-limit %):\n` +
          `\`\`\`json\n${JSON.stringify(r.cluster)}\n\`\`\`\n` +
          `Per-node utilization (cpu/mem/fs %, reserved-capacity %, network):\n` +
          `\`\`\`json\n${JSON.stringify(r.nodes)}\n\`\`\``,
        );
      }
      summary.push(`Container Insights (CloudWatch): ${ciWithData.length}/${probed.length} clusters with data`);
    } else if (probed.length > 0) {
      summary.push('Container Insights (CloudWatch): 미가용 (no CI metrics — Container Insights not enabled?)');
    }
    if (clusters.length > probed.length) {
      summary.push(`Note: ${clusters.length - probed.length} cluster(s) beyond the first ${CLUSTER_CAP} were not probed for CI metrics`);
    }

    // 3) K8s resource requests/limits + node capacity (Steampipe kubernetes tables)
    ctx.onStep({ tool: 'steampipe_sql', query: oneLine(EKS_SQL.podResourceRequests) });
    ctx.onStep({ tool: 'steampipe_sql', query: oneLine(EKS_SQL.nodeCapacity) });
    const [podR, nodeR] = await Promise.allSettled([
      runSteampipeQuery(EKS_SQL.podResourceRequests),
      runSteampipeQuery(EKS_SQL.nodeCapacity),
    ]);
    if (podR.status === 'fulfilled') {
      collected++;
      if (!tools.includes('steampipe_sql')) tools.push('steampipe_sql');
      summary.push(`K8s pod resource requests/limits (Steampipe): ${podR.value.rowCount} containers${podR.value.truncated ? ' (truncated at 200)' : ''}`);
      sections.push(`## K8s Pod Resource Requests/Limits (Steampipe)\n\`\`\`json\n${JSON.stringify(podR.value.rows.slice(0, 100))}\n\`\`\``);
    } else {
      summary.push(`K8s pod resource requests/limits (Steampipe): 미가용 (kubernetes tables query failed: ${(podR.reason instanceof Error ? podR.reason.message : String(podR.reason)).slice(0, 120)})`);
    }
    if (nodeR.status === 'fulfilled') {
      collected++;
      summary.push(`K8s node capacity (Steampipe): ${nodeR.value.rowCount} nodes`);
      sections.push(`## Node Capacity (Steampipe)\n\`\`\`json\n${JSON.stringify(nodeR.value.rows)}\n\`\`\``);
    } else {
      summary.push(`K8s node capacity (Steampipe): 미가용 (query failed)`);
    }

    // 4) Sources v1 had that v2 does not wire here — skipped per item, disclosed (fail-open).
    summary.push('Prometheus real-time metrics: 미가용 (not integrated in this v2 collector — skipped)');
    summary.push('Per-pod cost API (OpenCost): 미가용 (not collected — estimate cost from node instance types)');

    sections.push('\n## Collection Summary\n' + summary.map((s) => `- ${s}`).join('\n'));
    const context = collected === 0
      ? '--- No EKS optimization data could be collected ---\n' + sections.join('\n\n')
      : '--- EKS OPTIMIZATION DATA (collected automatically) ---\n' + sections.join('\n\n');

    return {
      context,
      summary,
      tools,
      collected,
      via: `EKS Cost Optimizer (${clusters.length} clusters, CI ${ciWithData.length}/${probed.length})`,
    };
  },

  // v1 analysisPrompt adapted: CloudWatch Container Insights replaces Prometheus as the live
  // usage signal, and cost is estimated from node instance types (no per-pod cost API in v2).
  analysisPrompt: `You are an EKS resource optimization expert. You have been given REAL data collected from the user's environment:
- EKS cluster inventory (Steampipe)
- CloudWatch Container Insights metrics (cluster rollups: restarts, OOMKilled, CrashLoopBackOff, CPU/memory over-limit %; per-node cpu/mem/fs utilization and reserved-capacity %)
- Kubernetes resource configurations (container requests/limits and node capacity from Steampipe)

Analyze ALL the provided data and give specific, actionable recommendations.

## Analysis Structure

### 1. Executive Summary
- Total estimated monthly savings (estimate node cost from instance types when no cost data is provided)
- Number of over-provisioned workloads found
- Any critical issues (frequent restarts, OOMKilled, CrashLoopBackOff, CPU/memory over pod limit)

### 2. Per-Namespace Analysis (sorted by savings potential)
For each namespace with optimization potential: pod count, requests vs typical usage, savings estimate.

### 3. Per-Workload Recommendations (sorted by savings)
For each workload with significant over/under-provisioning:
- **Current**: CPU request/limit, Memory request/limit
- **Signals**: node utilization / reserved-capacity, restart & OOM counts (from Container Insights)
- **Recommended**: New CPU request/limit, New Memory request/limit
- **Risk**: OOMKilled or over-limit metrics mean the workload may need MORE resources, not less

### 4. Risk Warnings
- Workloads with restarts or OOMKilled signals — these may need MORE resources
- Pods with CPU/memory utilization over pod limit
- Nodes with very high reserved-capacity but low actual utilization (requests are inflated)

### 5. Node-level Optimization
- Nodes with very low utilization (candidates for consolidation)
- Instance type right-sizing suggestions from node capacity vs utilization

## Important Rules
- Use the ACTUAL metrics provided; when a source is marked 미가용/unavailable or missing, say so and reason from requests/limits ratios and node capacity instead — do not invent data
- For over-provisioned pods: recommend request = observed usage * 1.2 (20% headroom)
- For under-provisioned pods: recommend request = observed usage * 1.3 (30% headroom)
- Use tables and formatting for easy scanning
- Include kubectl patch/set commands for the top recommendations`,
};

export default eksOptimizeCollector;
