// Service Latency Analyzer collector — v1 trace-analyze port (v1 src/lib/collectors/trace-analyze.ts)
// 서비스 트레이스/지연 분석 컬렉터: v1은 Tempo/Jaeger 트레이스 + Prometheus 서비스 메트릭 기반.
//
// v1 → v2 source mapping:
// - Tempo/Jaeger trace search (v1 primary)   → 미가용 in v2 (no datasource client here) — disclosed.
// - Prometheus service request/error rates    → 미가용 in v2 — disclosed.
// - CloudWatch ServiceLens/X-Ray              → not wired in v2 — disclosed.
// - SUBSTITUTE (per task spec): service-level latency/error signals from the load-balancer layer —
//   ALB discovery via Steampipe, then lib/metrics albFleetLive (p50/p99 latency, ELB-vs-target 5xx,
//   request/connection counts) per ALB. Coarser than span-level traces, but real and live.
import { runSteampipeQuery, steampipeAvailable } from '../aws-data';
import { albFleetLive } from '../metrics';
import type { ChatCollector, CollectCtx, CollectOutput } from './index';

// Cap the CloudWatch fan-out (fleetLatest batches internally; this bounds context size).
const ALB_CAP = 25;

// ── Steampipe SQL (aws-data catalog columns + arn for the CloudWatch LoadBalancer dimension) ──

export const TRACE_SQL = {
  albs: `
SELECT
  name,
  arn,
  type,
  scheme,
  state_code,
  vpc_id,
  dns_name,
  region,
  account_id
FROM aws_ec2_application_load_balancer
ORDER BY name
LIMIT 50`,
} as const;

const oneLine = (sql: string) => sql.trim().replace(/\s+/g, ' ');
const str = (v: unknown) => (v == null ? '' : String(v));

/** CloudWatch LoadBalancer dimension value: the ARN part after ":loadbalancer/" —
 *  "app/<name>/<id>" (inventory metrics route pattern). Null for non-matching ARNs. */
export function albDimFromArn(arn: string): string | null {
  return arn.match(/loadbalancer\/(app\/.+)$/)?.[1] ?? null;
}

// ── Collector implementation ────────────────────────────────────────────────

const traceAnalyzeCollector: ChatCollector = {
  key: 'trace-analyze',
  sectionMeta: { agentName: 'Service Latency Analyzer' },

  // Service (ALB) discovery rides Steampipe — down ⇒ normal routing (CloudWatch alone cannot
  // enumerate the load balancers to probe).
  available: () => steampipeAvailable(),

  async collect(ctx: CollectCtx): Promise<CollectOutput> {
    const summary: string[] = [];
    const sections: string[] = [];
    const tools: string[] = [];
    let collected = 0;

    // 0) v1 sources v2 does not wire — disclosed up front (fail-open, never fatal).
    summary.push('Tempo/Jaeger distributed traces: 미가용 (no tracing datasource in this v2 collector — span-level analysis skipped)');
    summary.push('Prometheus service request/error rates: 미가용 (not integrated in this v2 collector)');
    summary.push('CloudWatch ServiceLens/X-Ray: 미가용 (not wired) — substituting ALB-layer latency/error metrics');

    // 1) ALB discovery (Steampipe)
    ctx.onStep({ tool: 'steampipe_sql', query: oneLine(TRACE_SQL.albs) });
    let albs: Record<string, unknown>[] = [];
    try {
      const r = await runSteampipeQuery(TRACE_SQL.albs);
      albs = r.rows;
      collected++;
      tools.push('steampipe_sql');
      summary.push(`ALB discovery (Steampipe): ${albs.length} load balancers found`);
      sections.push(`## Application Load Balancers (Steampipe)\n\`\`\`json\n${JSON.stringify(albs.map((a) => ({ name: a.name, scheme: a.scheme, state: a.state_code, vpc: a.vpc_id, dns: a.dns_name, region: a.region, account: a.account_id })))}\n\`\`\``);
    } catch (e) {
      summary.push(`ALB discovery (Steampipe): 미가용 (query failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)})`);
    }

    // 2) ALB latency/error metrics (CloudWatch albFleetLive — p50/p99, ELB vs target errors).
    //    fleetLatest never throws — an all-null row means no traffic/datapoints in the window.
    const dimByName = new Map<string, string>();
    for (const a of albs.slice(0, ALB_CAP)) {
      const dim = albDimFromArn(str(a.arn));
      if (dim) dimByName.set(str(a.name) || dim, dim);
    }
    let fleetRows: { service: string; metrics: Record<string, number | null> }[] = [];
    if (dimByName.size > 0 && !ctx.signal?.aborted) {
      ctx.onStep({ tool: 'cloudwatch_metrics', query: `AWS/ApplicationELB latency+error metrics: ${dimByName.size} ALBs (p50/p99, 5xx, last 1h)` });
      const fleet = await albFleetLive([...dimByName.values()]);
      const dimToName = new Map([...dimByName.entries()].map(([n, d]) => [d, n]));
      fleetRows = Object.entries(fleet)
        .map(([dim, m]) => ({ service: dimToName.get(dim) ?? dim, metrics: m }))
        .filter((r) => Object.values(r.metrics).some((v) => v !== null))
        // worst-first: highest p99, then most 5xx — the analysis reads top-down
        .sort((a, b) => (b.metrics.respP99 ?? -1) - (a.metrics.respP99 ?? -1)
          || ((b.metrics.elb5xx ?? 0) + (b.metrics.tgt5xx ?? 0)) - ((a.metrics.elb5xx ?? 0) + (a.metrics.tgt5xx ?? 0)));
      if (fleetRows.length > 0) {
        collected++;
        tools.push('cloudwatch_metrics');
        summary.push(`ALB latency/error metrics (CloudWatch): ${fleetRows.length}/${dimByName.size} ALBs with data (last 1h)`);
        sections.push(
          `## ALB Latency & Error Metrics (CloudWatch last 1h, worst p99 first — respP50/respP99 s, elb5xx/elb502/elb503/elb504 vs tgt5xx/tgt4xx/tgt2xx counts, requests, active/new/rejected connections, tgtConnErr, clientTlsErr, lcu)\n` +
          `\`\`\`json\n${JSON.stringify(fleetRows)}\n\`\`\``,
        );
      } else {
        summary.push('ALB latency/error metrics (CloudWatch): 미가용 (no datapoints in the last hour — idle or wrong region)');
      }
    } else if (albs.length > 0) {
      summary.push('ALB latency/error metrics (CloudWatch): 미가용 (no CloudWatch dimension derivable from ALB ARNs)');
    }

    sections.push('\n## Collection Summary\n' + summary.map((s) => `- ${s}`).join('\n'));
    const context = collected === 0
      ? '--- No service latency data could be collected ---\n' + sections.join('\n\n')
      : '--- SERVICE LATENCY DATA (collected automatically — ALB layer; distributed traces unavailable) ---\n' + sections.join('\n\n');

    return {
      context,
      summary,
      tools,
      collected,
      via: `Service Latency Analyzer (${albs.length} ALBs, metrics ${fleetRows.length})`,
    };
  },

  // v1 analysisPrompt adapted: span-level trace sections are replaced by LB-layer latency/error
  // analysis; the prompt is explicit about the granularity limit and what instrumentation would help.
  analysisPrompt: `You are a distributed systems performance expert. You have been given REAL service-level data from the user's environment, collected at the LOAD BALANCER layer (ALB CloudWatch metrics). Distributed traces (Tempo/Jaeger/X-Ray) were NOT available — do not pretend span-level visibility.

## Analysis Structure

### 1. Service Latency Overview
- Rank services (ALBs) by p99 latency; compare p50 vs p99 (a large gap = tail-latency problem)
- Identify services with meaningful traffic (requests) vs idle ones

### 2. Error Analysis
- **ELB-generated errors (elb5xx/502/503/504) vs target-generated errors (tgt5xx)** — this distinction is the diagnostic starting point:
  - elb502/504 with low tgt5xx → target timeouts/connection resets (app or keep-alive tuning)
  - elb503 → no healthy targets or rejected connections (capacity)
  - tgt5xx dominant → application errors behind the LB
- rejected connections / tgtConnErr / clientTlsErr as capacity and TLS signals

### 3. Bottleneck Hypotheses
- For each high-p99 service: plausible causes ranked (target saturation, slow downstream dependency, connection churn — high newConn vs active)
- Correlate error spikes with latency where visible

### 4. Optimization Recommendations
- Targets that could benefit from scaling, keep-alive/idle-timeout alignment, or caching
- LCU-based cost signals (high lcu with low requests → inefficient traffic patterns)

### 5. Instrumentation Gaps
- State clearly that span-level tracing was unavailable; recommend enabling AWS X-Ray / ADOT or a Tempo/Jaeger datasource for service-dependency and per-span latency analysis

## Rules
- Base the analysis ONLY on the ACTUAL metrics provided; null metrics mean no datapoints — say so
- If a source is marked 미가용/unavailable, acknowledge it honestly — never invent trace data
- Use tables for easy scanning; include specific AWS CLI/console follow-up checks`,
};

export default traceAnalyzeCollector;
