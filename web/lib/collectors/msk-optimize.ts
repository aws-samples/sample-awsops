// MSK Broker Optimizer collector — v1 port (v1 src/lib/collectors/msk-optimize.ts) on v2 sources.
// MSK 브로커 적정 규모 컬렉터: 클러스터 구성(Steampipe) + 브로커 노드/메트릭/컨슈머 랙(CloudWatch) 수집.
//
// v1 → v2 source mapping:
// - Steampipe MSK list (v1 queries/msk.ts) → runSteampipeQuery (guarded, 200-row cap).
// - Broker nodes + CloudWatch metrics (v1 self-HTTP /api/msk) → lib/metrics DIRECTLY:
//   mskListNodes (kafka ListNodes) + mskBrokerFleetLive + mskClusterHealth (v1 gap: controller/
//   offline-partition health) + mskOffsetLags (CloudWatch MaxOffsetLag replaces v1's Prometheus
//   consumer-lag PromQL).
// - Prometheus Kafka JMX metrics (v1 optional) → 미가용 in v2 (no datasource client here) —
//   SKIPPED per item and disclosed; consumer lag is covered by CloudWatch MaxOffsetLag instead.
import { runSteampipeQuery, steampipeAvailable } from '../aws-data';
import { mskListNodes, mskBrokerFleetLive, mskClusterHealth, mskOffsetLags } from '../metrics';
import type { ChatCollector, CollectCtx, CollectOutput } from './index';

// Cap the CloudWatch fan-out: nodes + broker fleet + health + lag per cluster.
const CLUSTER_CAP = 3;

// ── Steampipe SQL (v1 queries/msk.ts list — provisioned JSONB nesting rule; LIMIT added) ──

export const MSK_SQL = {
  clusters: `
SELECT
  cluster_name,
  arn AS cluster_arn,
  state,
  cluster_type,
  provisioned -> 'CurrentBrokerSoftwareInfo' ->> 'KafkaVersion' AS kafka_version,
  (provisioned ->> 'NumberOfBrokerNodes')::int AS number_of_broker_nodes,
  provisioned ->> 'EnhancedMonitoring' AS enhanced_monitoring,
  provisioned -> 'BrokerNodeGroupInfo' ->> 'InstanceType' AS instance_type,
  provisioned -> 'BrokerNodeGroupInfo' -> 'StorageInfo' -> 'EbsStorageInfo' ->> 'VolumeSize' AS ebs_volume_gb,
  region,
  account_id
FROM aws_msk_cluster
ORDER BY cluster_name
LIMIT 20`,
} as const;

const oneLine = (sql: string) => sql.trim().replace(/\s+/g, ' ');
const str = (v: unknown) => (v == null ? '' : String(v));

interface ClusterProbe {
  name: string;
  brokers: { brokerId: number | null; instanceType: string | null; endpoints: string[] }[];
  brokerMetrics: Record<string, Record<string, number | null>>;
  health: Record<string, number | null>;
  offsetLags: { consumerGroup: string; topic: string; maxOffsetLag: number | null }[];
  hasMetrics: boolean;
}

// ── Collector implementation ────────────────────────────────────────────────

const mskOptimizeCollector: ChatCollector = {
  key: 'msk-optimize',
  sectionMeta: { agentName: 'MSK Broker Optimizer' },

  // Cluster discovery rides Steampipe — down ⇒ normal routing (CloudWatch alone cannot
  // enumerate the clusters/ARNs to probe).
  available: () => steampipeAvailable(),

  async collect(ctx: CollectCtx): Promise<CollectOutput> {
    const summary: string[] = [];
    const sections: string[] = [];
    const tools: string[] = [];
    let collected = 0;

    // 1) MSK clusters (Steampipe)
    ctx.onStep({ tool: 'steampipe_sql', query: oneLine(MSK_SQL.clusters) });
    let clusters: Record<string, unknown>[] = [];
    try {
      const r = await runSteampipeQuery(MSK_SQL.clusters);
      clusters = r.rows;
      collected++;
      tools.push('steampipe_sql');
      summary.push(`MSK clusters (Steampipe): ${clusters.length} found`);
      sections.push(`## MSK Cluster Configurations (Steampipe)\n\`\`\`json\n${JSON.stringify(clusters)}\n\`\`\``);
    } catch (e) {
      summary.push(`MSK clusters (Steampipe): 미가용 (query failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)})`);
    }

    // 2) Per-cluster broker nodes + CloudWatch metrics + health + consumer lag.
    //    mskListNodes / fleetLatest / mskOffsetLags never throw — empty/null means no data.
    const probed = clusters.slice(0, CLUSTER_CAP)
      .map((c) => ({ name: str(c.cluster_name), arn: str(c.cluster_arn), region: c.region ? str(c.region) : undefined }))
      .filter((c) => c.name && c.arn);
    const probes: ClusterProbe[] = [];
    let totalBrokers = 0;
    for (const c of probed) {
      if (ctx.signal?.aborted) break;
      ctx.onStep({ tool: 'msk_api', query: `kafka ListNodes: ${c.name}` });
      const nodes = await mskListNodes(c.arn);
      const brokerIds = nodes.map((n) => n.brokerId).filter((id): id is number => id != null);
      ctx.onStep({ tool: 'cloudwatch_metrics', query: `AWS/Kafka broker+cluster metrics: ${c.name} (${brokerIds.length} brokers, last 1h)` });
      const [brokerMetrics, health, offsetLags] = await Promise.all([
        brokerIds.length
          ? mskBrokerFleetLive(c.name, brokerIds, c.region)
          : Promise.resolve<Record<string, Record<string, number | null>>>({}),
        mskClusterHealth(c.name, c.region),
        mskOffsetLags(c.name, c.region),
      ]);
      const hasMetrics =
        Object.values(brokerMetrics).some((m) => Object.values(m).some((v) => v !== null)) ||
        Object.values(health).some((v) => v !== null) ||
        offsetLags.length > 0;
      totalBrokers += nodes.length;
      probes.push({
        name: c.name,
        brokers: nodes.map((n) => ({ brokerId: n.brokerId, instanceType: n.instanceType, endpoints: n.endpoints })),
        brokerMetrics, health, offsetLags, hasMetrics,
      });
    }

    const withMetrics = probes.filter((p) => p.hasMetrics);
    if (probes.some((p) => p.brokers.length > 0)) {
      collected++;
      tools.push('msk_api');
      summary.push(`MSK broker nodes (kafka ListNodes): ${totalBrokers} brokers across ${probes.length} cluster(s)`);
    } else if (probed.length > 0) {
      summary.push('MSK broker nodes (kafka ListNodes): 미가용 (no nodes returned)');
    }
    if (withMetrics.length > 0) {
      collected += withMetrics.length;
      tools.push('cloudwatch_metrics');
      summary.push(`CloudWatch broker/cluster metrics: ${withMetrics.length}/${probed.length} clusters with data`);
    } else if (probed.length > 0) {
      summary.push('CloudWatch broker/cluster metrics: 미가용 (no datapoints — check region/permissions)');
    }
    if (clusters.length > probed.length) {
      summary.push(`Note: ${clusters.length - probed.length} cluster(s) beyond the first ${CLUSTER_CAP} were not probed for broker metrics`);
    }

    for (const p of probes) {
      const parts = [
        `## Cluster ${p.name} — broker topology (kafka ListNodes)\n\`\`\`json\n${JSON.stringify(p.brokers.slice(0, 20))}\n\`\`\``,
        `Per-broker CloudWatch metrics (last 1h — cpuUser/cpuSystem %, memUsed/memFree bytes, bytesIn/Out per sec, msgsIn/sec, dataDisk/rootDisk used %, produce/fetchThrottle ms, urp/underMinIsr counts):\n\`\`\`json\n${JSON.stringify(p.brokerMetrics)}\n\`\`\``,
        `Cluster health (activeControllers should be 1, offlinePartitions should be 0):\n\`\`\`json\n${JSON.stringify(p.health)}\n\`\`\``,
      ];
      if (p.offsetLags.length > 0) {
        parts.push(`Consumer-group MaxOffsetLag (CloudWatch, worst first):\n\`\`\`json\n${JSON.stringify(p.offsetLags.slice(0, 20))}\n\`\`\``);
      } else {
        parts.push('Consumer-group MaxOffsetLag: no series found (no consumer groups reporting, or metric not available).');
      }
      sections.push(parts.join('\n'));
    }

    // 3) v1 source v2 does not wire here — skipped per item, disclosed (fail-open).
    summary.push('Prometheus Kafka JMX metrics: 미가용 (not integrated in this v2 collector — consumer lag covered by CloudWatch MaxOffsetLag)');

    sections.push('\n## Collection Summary\n' + summary.map((s) => `- ${s}`).join('\n'));
    const context = collected === 0
      ? '--- No MSK optimization data could be collected ---\n' + sections.join('\n\n')
      : '--- MSK BROKER RIGHTSIZING DATA (collected automatically) ---\n' + sections.join('\n\n');

    return {
      context,
      summary,
      tools,
      collected,
      via: `MSK Broker Optimizer (${clusters.length} clusters, ${totalBrokers} brokers, CW ${withMetrics.length}/${probed.length})`,
    };
  },

  // v1 analysisPrompt adapted: CloudWatch MaxOffsetLag/health metrics replace Prometheus JMX;
  // disk/throttle/replication keys follow lib/metrics MSK_BROKER_METRICS (documented in context).
  analysisPrompt: `You are an MSK (Managed Streaming for Apache Kafka) optimization expert. You have been given REAL data from the user's environment:
- MSK cluster configurations (broker count, instance type, EBS size, Kafka version, enhanced monitoring — Steampipe)
- Broker node topology (kafka ListNodes)
- Per-broker CloudWatch metrics (CpuUser/CpuSystem, MemoryUsed/Free, BytesIn/Out, MessagesIn, data/root disk used %, produce/fetch throttle, under-replicated / under-min-ISR partitions)
- Cluster health (ActiveControllerCount, OfflinePartitionsCount, GlobalPartitionCount)
- Consumer-group MaxOffsetLag (CloudWatch)

Analyze ALL the provided data and give specific, actionable broker rightsizing recommendations.

## Analysis Structure

### 1. Executive Summary
- Total estimated monthly savings
- Number of over-provisioned brokers/clusters
- Any critical issues (high CPU, disk > 85%, offline partitions, controller != 1, growing consumer lag, URP > 0)

### 2. Per-Cluster Analysis
For each MSK cluster:

#### Instance Type Rightsizing
| Cluster | Current Type | Broker Count | CPU (User+System) | Memory Used | Recommended Type | Est. Savings |
- **CPU (User+System) < 20%** → downsize instance type (e.g., kafka.m5.2xlarge → kafka.m5.xlarge)
- **CPU > 70%** → flag as capacity risk, do NOT downsize
- Compare memory used vs free — if memory utilization < 30%, a smaller type may work

#### Storage & Disk Health
- **KafkaDataLogsDiskUsed > 85%** → most common MSK failure cause — expand EBS or reduce retention FIRST
- Current EBS volume size vs BytesIn throughput and retention needs
- Consider gp3 with custom IOPS/throughput if using gp2

#### Broker Count Optimization
- If per-broker CPU/throughput is very low across all brokers → consider reducing broker count
- Minimum 3 brokers for production, 2 for dev/test
- Broker imbalance (uneven CPU/bytes across brokers) → partition reassignment before rightsizing

### 3. Kafka-Level Health (CloudWatch)
- **Consumer lag**: consumer groups with high/growing MaxOffsetLag need attention — may need MORE capacity
- **UnderReplicatedPartitions / UnderMinIsrPartitionCount > 0** → replication health issue, do NOT downsize
- **Produce/FetchThrottleTime > 0** → quota or network bottleneck signal
- **OfflinePartitionsCount > 0 or ActiveControllerCount != 1** → cluster-level incident, fix before optimizing

### 4. Architecture Recommendations
- **Provisioned vs Serverless**: if throughput is bursty and low average, MSK Serverless may be cheaper
- **Kafka version**: recommend upgrade if running an older version (security + performance)
- **Enhanced monitoring**: recommend enabling if currently DEFAULT
- **Multi-AZ broker distribution**: verify brokers span AZs evenly

### 5. Risk Warnings
- Clusters with CPU > 60% — do not downsize
- Clusters with growing consumer lag or URP > 0 — may need MORE capacity
- Disk > 80% — capacity risk regardless of CPU headroom

## Important Rules
- Provide specific instance type recommendations with cost estimates
- MSK pricing is per-broker-hour + EBS storage — calculate both
- If a source is marked 미가용/unavailable (e.g., Prometheus JMX), analyze from the CloudWatch metrics provided — do not invent data
- Use tables for easy comparison
- Include AWS CLI commands for applying recommendations where applicable`,
};

export default mskOptimizeCollector;
