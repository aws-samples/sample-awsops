import type { GuideSpec } from './DiagnosisGuide';

// EN translations of guides.tsx — keep keys in lockstep with GuideSpec.service values.
// Rendering is handled by the single DiagnosisGuide component; this file is data only.

const code = (t: string) => <code className="rounded bg-ink-50 px-1 font-mono text-[11px]">{t}</code>;

export const GUIDES_EN: Record<string, GuideSpec> = {
  MSK: {
    service: 'MSK',
    intro: (
      <>The metrics MSK exposes depend on the <b>monitoring level</b> (DEFAULT / PER_BROKER / PER_TOPIC_PER_BROKER / PER_TOPIC_PER_PARTITION).
      For any real diagnosis, raise it to at least <b>PER_BROKER</b>.</>
    ),
    sections: [
      { title: '① Broker resources (the root of most bottlenecks)', items: [
        <><b>CpuUser + CpuSystem</b> — alarm when the sum exceeds 60–70%. MSK recommendation: keep at least 40% CPU headroom.</>,
        <><b>KafkaDataLogsDiskUsed</b> — data disk usage (%). <b>The most common cause of outages</b> — above 85% is dangerous; expand storage or enable auto-scaling.</>,
        <><b>MemoryUsed / MemoryFree</b>, <b>RootDiskUsed</b> — check the root volume as well.</>,
      ]},
      { title: '② Cluster health', items: [
        <><b>ActiveControllerCount</b> — the healthy value is exactly <b>1</b>. A value of 0 or 2+ means a controller problem → investigate immediately.</>,
        <><b>OfflinePartitionsCount</b> — healthy value <b>0</b>. Anything above 0 means those partitions are unavailable (a data-availability problem).</>,
        <><b>UnderReplicatedPartitions</b> — healthy value <b>0</b>. Anything above 0 means replication is falling behind (a sign of broker overload or failure).</>,
        <><b>UnderMinIsrPartitionCount</b> — partitions below min.insync.replicas. Producers with acks=all are having writes rejected.</>,
      ]},
      { title: '③ Throughput and traffic', items: [
        <><b>BytesInPerSec / BytesOutPerSec</b> — compare against the instance type's network limit. Track <b>MessagesInPerSec</b> alongside.</>,
        <><b>ProduceThrottleTime / FetchThrottleTime</b> — whether quota or network throttling is occurring.</>,
      ]},
      { title: '④ Latency', items: [
        <><b>RequestQueueSize / ResponseQueueSize</b> — growing queues mean the broker cannot keep up with requests.</>,
        <>Drill into produce/fetch latency (FetchConsumerTotalTimeMsMean and friends) for detail.</>,
      ]},
      { title: '⑤ Consumer lag — what matters most in practice', items: [
        <><b>MaxOffsetLag / SumOffsetLag / EstimatedMaxTimeLag</b> — when consumers cannot keep up with producers, lag grows without bound. The first metric to check when diagnosing a real-time pipeline.</>,
        <>Consumer group lag can also be checked with Kafka's own {code('kafka-consumer-groups.sh')}, not just CloudWatch.</>,
      ]},
      { title: '⑥ Connections', items: [
        <><b>ConnectionCount / ClientConnectionCount</b>, <b>ConnectionCreationRate / CloseRate</b> — detect connection surges and reconnect storms.</>,
      ]},
    ],
    priorityHeader: ['Metric', 'Healthy value', 'Meaning'],
    priority: [
      ['ActiveControllerCount', '= 1', 'Controller healthy'],
      ['OfflinePartitionsCount', '= 0', 'Availability'],
      ['UnderReplicatedPartitions', '= 0', 'Replication health'],
      ['KafkaDataLogsDiskUsed', '< 85%', 'Avoid disk exhaustion'],
      ['CpuUser + CpuSystem', '< ~60%', 'Load headroom'],
      ['MaxOffsetLag', 'Stable trend', 'Consumer processing lag'],
    ],
  },

  RDS: {
    service: 'RDS',
    intro: (
      <>RDS diagnosis works across three layers — <b>basic CloudWatch metrics, Enhanced Monitoring, and Performance Insights</b> —
      which give you the instance, OS, and query perspectives respectively.</>
    ),
    sections: [
      { title: '① Basic CloudWatch metrics (instance level)', items: [
        <><b>CPUUtilization</b> — sustained above 80% calls for scaling the instance or tuning queries.</>,
        <><b>CPUCreditBalance / CPUCreditUsage</b> — T-class (burstable) only. When credits approach 0, performance falls off a cliff. <b>A trap that is frequently missed in production.</b></>,
        <><b>FreeableMemory</b> — persistently low means swap risk. <b>SwapUsage</b> should stay near 0 — growth is a sign of a sharp performance drop.</>,
        <><b>FreeStorageSpace</b> — <b>the most common cause of outages.</b> When it runs out, the database stops → storage auto-scaling and alarms are mandatory. A high <b>DiskQueueDepth</b> indicates a storage bottleneck.</>,
        <><b>ReadIOPS / WriteIOPS</b> — compare against provisioned IOPS (gp3/io1/io2). A spike in <b>ReadLatency / WriteLatency</b> = storage bottleneck. <b>BurstBalance</b> (gp2) exhaustion demotes you to baseline IOPS.</>,
        <><b>DatabaseConnections</b> — compare against max_connections. Diagnoses connection exhaustion or leaks (no connection pooling).</>,
      ]},
      { title: '② Replication / high availability', items: [
        <><b>ReplicaLag</b> (read replicas, seconds) / <b>AuroraReplicaLag</b> — data-freshness issues when reads are fanned out.</>,
        <>Track Multi-AZ failover events via RDS Events.</>,
      ]},
      { title: '③ Enhanced Monitoring (OS level, down to 1-second granularity)', items: [
        <>Basic CloudWatch is the hypervisor's view — for inside the OS use Enhanced Monitoring: per-process CPU/memory, os.cpuUtilization breakdown (user/system/wait/idle), os.diskIO, loadAverage.</>,
        <><b>High CPU wait = I/O bottleneck; high system = kernel overhead</b> — useful for telling causes apart.</>,
      ]},
      { title: '④ Performance Insights (query level — the heart of diagnosis)', items: [
        <><b>DB Load (AAS)</b> — the key indicator. Climbing <b>above the Max vCPU line</b> means overload.</>,
        <><b>Wait-event breakdown</b> — which of CPU / IO / Lock is the bottleneck (io/table/sql/handler, lock waits, etc.).</>,
        <><b>Top SQL</b> — identify the queries generating the load → tuning candidates.</>,
      ]},
    ],
    priorityHeader: ['Metric', 'Warning threshold', 'Meaning'],
    priority: [
      ['CPUUtilization', '> 80% sustained', 'Compute bottleneck'],
      ['FreeStorageSpace', 'Below threshold', 'Disk exhaustion → DB halt'],
      ['FreeableMemory', 'Low + SwapUsage rising', 'Memory pressure'],
      ['DatabaseConnections', 'Near max', 'Connection exhaustion/leak'],
      ['ReadLatency/WriteLatency', 'Spiking', 'Storage bottleneck'],
      ['ReplicaLag', 'Rising trend', 'Replication lag'],
      ['BurstBalance/CPUCreditBalance', 'Near 0', 'gp2/T-class credit exhaustion'],
      ['DB Load (PI)', '> Max vCPU', 'Overall overload'],
    ],
  },
  DynamoDB: {
    service: 'DynamoDB',
    intro: (
      <>DynamoDB is fully managed, so there is no OS/disk layer — diagnosis is <b>CloudWatch-centric: throughput,
      throttling, latency, and errors</b>. Which metrics matter depends on the capacity mode (On-Demand vs Provisioned).</>
    ),
    sections: [
      { title: '① Throttling — the single most important thing to check', items: [
        <><b>ThrottledRequests</b>, <b>ReadThrottleEvents / WriteThrottleEvents</b>, <b>OnlineIndexThrottleEvents</b> (GSI backfill).</>,
        <>The cause is usually one of two things: <b>under-provisioning</b> (capacity &lt; traffic) or a <b>hot partition / hot key</b> — plenty of capacity overall, but one partition hitting its per-partition limit (3,000 RCU / 1,000 WCU). The latter is the trickiest case to diagnose.</>,
      ]},
      { title: '② Capacity consumption', items: [
        <>Overlay <b>ConsumedRead/WriteCapacityUnits</b> (actual usage) against <b>ProvisionedRead/WriteCapacityUnits</b> (configured) to judge headroom.</>,
        <>For On-Demand, watch the consumption trend, the AccountMaxTableLevelReads/Writes ceilings, and sudden spikes that exceed the 2x rule.</>,
      ]},
      { title: '③ Latency', items: [
        <><b>SuccessfulRequestLatency</b> — <b>breaking it down per operation is the key</b> (GetItem/Query/PutItem/Scan…). This is service-side latency (network round-trip excluded).</>,
        <>Spiking Scan/Query latency points to inefficient access patterns (full scans, large result sets).</>,
      ]},
      { title: '④ Errors', items: [
        <><b>SystemErrors</b> (HTTP 500, server side) / <b>UserErrors</b> (HTTP 400, client side).</>,
        <><b>ConditionalCheckFailedRequests</b> — occurs legitimately with optimistic locking → judge in context. A high <b>TransactionConflict</b> means heavy contention.</>,
      ]},
      { title: '⑤ Global Tables / Streams', items: [
        <><b>ReplicationLatency</b>, PendingReplicationCount, AgeOfOldestUnreplicatedRecord — cross-region replication lag.</>,
        <>If Lambda consumes the Streams, check the Lambda's <b>IteratorAge</b> for stream-processing lag.</>,
      ]},
      { title: 'Going deeper: CloudWatch Contributor Insights for DynamoDB', items: [
        <><b>Purpose-built for hot-partition / hot-key detection</b> — it ranks the most frequently accessed partition keys, which is decisive when deciding whether throttling comes from "insufficient capacity" or "skewed key distribution".</>,
        <>Throttled keys can be tracked with a dedicated rule as well — enable Contributor Insights per table.</>,
      ]},
    ],
    priorityHeader: ['Metric', 'Warning threshold', 'Meaning'],
    priority: [
      ['ReadThrottleEvents / WriteThrottleEvents', '> 0 sustained', 'Insufficient capacity or hot partition'],
      ['SystemErrors', 'Spiking', 'Server-side problem'],
      ['ConsumedRCU/WCU vs Provisioned', 'Near/over limit', 'Low capacity headroom'],
      ['SuccessfulRequestLatency', 'Spiking', 'Access-pattern/performance problem'],
      ['ConditionalCheckFailedRequests', 'Higher than expected', 'Contention or logic problem'],
      ['ReplicationLatency (Global Tables)', 'Rising trend', 'Cross-region replication lag'],
    ],
  },

  ElastiCache: {
    service: 'ElastiCache',
    intro: (
      <>Metrics differ by engine (Redis/Valkey vs Memcached), but you always look at <b>CPU, memory, connections,
      performance (hit rate / latency), and engine-specific indicators</b>. The notes below assume Redis/Valkey.</>
    ),
    sections: [
      { title: '① CPU', items: [
        <><b>EngineCPUUtilization</b> — the most important metric on Redis/Valkey. The main command path is effectively <b>single-threaded</b>, so one saturated core is a real bottleneck even while CPUUtilization (the all-vCPU average) looks low.</>,
        <><b>CPUUtilization</b> — whole node. <b>Memcached is multithreaded, so this is the one that matters there.</b></>,
        <>Sustained high EngineCPU → suspect slow commands (O(N): KEYS, large HGETALL, big SORT) or scale out with more shards.</>,
      ]},
      { title: '② Memory — the heart of diagnosis', items: [
        <><b>DatabaseMemoryUsagePercentage</b> — usage against maxmemory. <b>The single most important alarm metric.</b> Track FreeableMemory / BytesUsedForCache alongside.</>,
        <><b>SwapUsage</b> — growth is dangerous (disk swapping → latency spikes).</>,
        <><b>Evictions</b> — keys being force-evicted because memory is full. If it persists, scale the node, shard, or revisit maxmemory-policy. <b>Reclaimed</b> (TTL expiry removal) is normal behavior.</>,
      ]},
      { title: '③ Performance — hit rate and latency', items: [
        <><b>CacheHitRate</b> (or CacheHits/CacheMisses) — the essence of cache effectiveness. A low value means TTLs are too short, the cache-key design is wrong, or the cache is cold.</>,
        <>Break latency down by command family (StringBasedCmdsLatency, GetType/SetType/HashBasedCmdsLatency…) to see which commands are slow. Track SuccessfulRead/WriteRequestLatency alongside.</>,
      ]},
      { title: '④ Connections', items: [
        <><b>CurrConnections</b> — against maxclients. A spike in <b>NewConnections</b> suggests missing connection pooling or a reconnect storm (connection setup is expensive). <b>CurrItems</b> is the item count.</>,
      ]},
      { title: '⑤ Network and throughput', items: [
        <>NetworkBytesIn/Out, <b>NetworkBandwidthIn/OutAllowanceExceeded</b> — exceeding the instance type's network ceiling. <b>An easy bottleneck to miss.</b> ConnTrack/PPS AllowanceExceeded are the same family.</>,
        <><b>ReplicationBytes / ReplicationLag</b> — read-replica replication lag.</>,
      ]},
      { title: '⑥ Engine-specific (Redis/Valkey)', items: [
        <>KeyspaceHits/Misses, SaveInProgress, BytesUsedForCache. For slow-command hunting, also use Redis {code('SLOWLOG')}.</>,
        <>In cluster mode, break metrics down per shard/node to find <b>hot shards</b>.</>,
      ]},
      { title: 'Diagnosis paths by symptom', items: [
        <>Latency up while overall CPU low → check <b>EngineCPUUtilization + SLOWLOG</b>.</>,
        <>Intermittent slowdowns with Evictions → revisit <b>memory sizing / TTL and eviction policy</b>.</>,
        <>Unexplained latency under heavy traffic → check the <b>Network...AllowanceExceeded</b> bandwidth ceilings.</>,
        <>Low hit rate → revisit <b>cache-key design and TTLs</b>.</>,
      ]},
    ],
    priorityHeader: ['Metric', 'Warning threshold', 'Meaning'],
    priority: [
      ['EngineCPUUtilization', '> 90% (Redis)', 'Single-thread saturation / slow commands'],
      ['DatabaseMemoryUsagePercentage', 'High', 'Memory pressure'],
      ['Evictions', '> 0 sustained', 'Memory shortage → key eviction'],
      ['SwapUsage', 'Rising', 'Risk of sharp performance drop'],
      ['CacheHitRate', 'Low', 'Poor cache effectiveness'],
      ['CurrConnections', 'Near max', 'Connection exhaustion'],
      ['Network...AllowanceExceeded', '> 0', 'Network ceiling bottleneck'],
      ['ReplicationLag', 'Rising trend', 'Replication lag'],
    ],
  },

  OpenSearch: {
    service: 'OpenSearch',
    intro: (
      <>For OpenSearch the essentials are <b>cluster status, JVM/memory, storage, search/indexing performance,
      and thread-pool queues</b> (managed OpenSearch Service, CloudWatch metrics).</>
    ),
    sections: [
      { title: '① Cluster status — the first thing to look at', items: [
        <><b>ClusterStatus.green/yellow/red</b> — <b>red demands immediate action</b>: primary shards unassigned (data inaccessible). Yellow means replicas unassigned (reduced availability, data still reachable).</>,
        <><b>Nodes</b> — a value different from expected means node loss or failure.</>,
        <><b>ClusterIndexWritesBlocked</b> — a value of 1 = writes blocked (disk shortage / JVM pressure / red status, etc.). <b>A critically important alarm metric.</b></>,
      ]},
      { title: '② JVM memory pressure — the heart of diagnosis', items: [
        <><b>JVMMemoryPressure</b> (newer: OldGenJVMMemoryPressure) — the most important one. <b>Above 80%, frequent GC degrades performance</b>; sustained above 92%, protection mechanisms may block writes.</>,
        <><b>JVMGCYoung/OldCollectionCount·Time</b> — frequent, long Old GC means severe heap pressure.</>,
        <>High pressure → suspect too many shards (oversharding), large aggregation queries, oversized field-data cache, or the need to scale nodes.</>,
      ]},
      { title: '③ CPU', items: [
        <><b>CPUUtilization</b> (data nodes) / <b>MasterCPUUtilization</b> (dedicated masters — saturation delays shard allocation and cluster-state updates) / WarmCPUUtilization (UltraWarm).</>,
      ]},
      { title: '④ Storage', items: [
        <><b>FreeStorageSpace</b> — free disk per node. <b>The most common cause of outages.</b> Hitting the disk watermarks (low 85% / high 90% / flood 95%) triggers shard relocation and write blocks.</>,
        <>ClusterUsedSpace, <b>DiskQueueDepth</b> (I/O queuing), Read/WriteLatency·Throughput (EBS).</>,
      ]},
      { title: '⑤ Search and indexing performance', items: [
        <><b>SearchRate / SearchLatency</b>, <b>IndexingRate / IndexingLatency</b> — latency spikes point to heavy queries, oversharding, or resource saturation.</>,
      ]},
      { title: '⑥ Thread-pool queues and rejections — the saturation signal', items: [
        <><b>ThreadpoolSearchQueue / ThreadpoolWriteQueue</b> — growing queues mean processing is falling behind.</>,
        <><b>ThreadpoolSearchRejected / ThreadpoolWriteRejected</b> — requests rejected because the queue is full. <b>Anything above 0 means clients are receiving errors → investigate immediately.</b> A strong signal of insufficient capacity or inefficient queries. CoordinatingWriteRejected·PrimaryWriteRejected indicate write backpressure.</>,
      ]},
      { title: '⑦ Other frequently checked metrics', items: [
        <><b>MasterReachableFromNode</b> (1 is healthy), <b>AutomatedSnapshotFailure</b> (backup failure), <b>KMSKeyError/KMSKeyInaccessible</b> (a value of 1 risks the cluster becoming inaccessible).</>,
        <>5xx/4xx/2xx HTTP codes, InvalidHostHeaderRequests, ThroughputThrottle/IopsThrottle (gp3).</>,
      ]},
      { title: 'Diagnosis paths by symptom', items: [
        <>Cluster red/yellow → find why shard allocation failed (disk watermarks, node loss).</>,
        <>Intermittent request failures (429/rejections) → check <b>Threadpool...Rejected + JVM pressure</b>.</>,
        <>Search latency spikes → check for heavy queries, oversharding (shard count vs data volume), resource saturation.</>,
        <>Writes blocked → the combination of <b>ClusterIndexWritesBlocked + FreeStorageSpace + JVMMemoryPressure</b>.</>,
        <>For fine-grained causes CloudWatch cannot see (a specific index/shard/query), use the cluster's own APIs: {code('_cluster/health')}, {code('_cat/indices?v')}, {code('_cat/shards')}, {code('_nodes/stats')}, plus slow logs / error logs.</>,
      ]},
    ],
    priorityHeader: ['Metric', 'Warning threshold', 'Meaning'],
    priority: [
      ['ClusterStatus.red', '= 1', 'Primary shards unassigned (data unavailable)'],
      ['ClusterIndexWritesBlocked', '= 1', 'Writes blocked'],
      ['JVMMemoryPressure', '> 80%', 'Heap pressure → GC/performance degradation'],
      ['FreeStorageSpace', 'Near watermark', 'Disk exhaustion'],
      ['Threadpool...Rejected', '> 0', 'Requests rejected (saturation)'],
      ['MasterCPUUtilization', 'High', 'Master bottleneck'],
      ['SearchLatency/IndexingLatency', 'Spiking', 'Query/indexing performance'],
      ['AutomatedSnapshotFailure', '= 1', 'Backup failure'],
    ],
  },
  ALB: {
    service: 'ALB',
    intro: (
      <>For ALB the essentials are <b>HTTP response codes, latency, connection/request counts, target health,
      and capacity (LCU)</b>. Above all, <b>separating "errors generated by the load balancer itself"
      (HTTPCode_ELB_*) from "errors returned by targets" (HTTPCode_Target_*)</b> is where every diagnosis starts.</>
    ),
    sections: [
      { title: '① HTTP response codes — the heart of diagnosis', items: [
        <><b>HTTPCode_ELB_5XX_Count</b> — 5xx generated by the ALB itself (the request never reached a target, or no response came back). Breaking it into 502/503/504 narrows the cause.</>,
        <><b>502</b> (Bad Gateway) — malformed response or dropped connection from the target. <b>The most common trouble.</b> <b>503</b> — no healthy targets (all unhealthy); very important. <b>504</b> — no response within the idle timeout; a sign of a slow backend.</>,
        <><b>HTTPCode_Target_5XX_Count</b> — backend application errors. Target_2XX/3XX serve as the healthy-traffic baseline.</>,
        <><b>The key distinction</b>: ELB_5XX up = LB↔target connectivity/health problem; Target_5XX up = application code problem.</>,
      ]},
      { title: '② Latency', items: [
        <><b>TargetResponseTime</b> — the most important. Read it <b>as p50/p90/p99 percentiles</b> (averages hide the long tail). A spike = backend performance degradation.</>,
      ]},
      { title: '③ Requests and connections', items: [
        <><b>RequestCount</b> (traffic baseline), <b>ActiveConnectionCount</b>, <b>NewConnectionCount</b> (detects TLS renegotiation storms).</>,
        <><b>RejectedConnectionCount</b> — the ALB hit its maximum connection limit. <b>Anything above 0 is a capacity problem.</b></>,
        <><b>Client/TargetTLSNegotiationErrorCount</b> — TLS negotiation failures.</>,
      ]},
      { title: '④ Target health — availability (only meaningful per target group)', items: [
        <><b>HealthyHostCount</b> — approaching 0 is dangerous; at 0 you get 503s.</>,
        <><b>UnHealthyHostCount</b> — when rising, investigate why health checks fail (app crash, wrong health-check path, slow startup).</>,
      ]},
      { title: '⑤ Capacity / throttling', items: [
        <><b>ConsumedLCUs</b> (billing/capacity sizing, spike detection), ProcessedBytes.</>,
        <><b>TargetConnectionErrorCount</b> — ALB→target connection failures. A sign of network, security-group, or target-port problems.</>,
      ]},
      { title: '⑥ Situational extras', items: [
        <><b>RequestCountPerTarget</b> — detects uneven load distribution. HTTP_Redirect/Fixed_Response_Count.</>,
        <>DesyncMitigationMode_NonCompliant_Request_Count (HTTP desync risk), GrpcRequestCount (gRPC).</>,
      ]},
      { title: 'Diagnosis flows by symptom', items: [
        <>502 spike → target app crashing or closing connections early; check for a <b>keep-alive timeout mismatch</b> (happens when ALB idle timeout &gt; backend keep-alive).</>,
        <>503 spike → check <b>HealthyHostCount</b>, then investigate why health checks fail.</>,
        <>504 spike → slow backend (TargetResponseTime) plus the ALB idle-timeout setting.</>,
        <>Intermittent 5xx while targets return 2xx → an LB-level problem: check <b>RejectedConnectionCount / TargetConnectionErrorCount</b>.</>,
        <>Cause unclear → use the <b>access logs (S3)</b> to break individual requests into elb_status_code vs target_status_code and request/target/response_processing_time — this tells you precisely whether latency is LB queuing or the backend.</>,
      ]},
    ],
    priorityHeader: ['Metric', 'Warning threshold', 'Meaning'],
    priority: [
      ['HTTPCode_ELB_5XX_Count', 'Spiking', 'LB↔target problem (break into 502/503/504)'],
      ['HTTPCode_Target_5XX_Count', 'Spiking', 'Backend app errors'],
      ['TargetResponseTime (p99)', 'Spiking', 'Backend performance degradation'],
      ['HealthyHostCount', 'Low/0', 'Too few healthy targets → 503'],
      ['UnHealthyHostCount', '> 0', 'Health-check failures'],
      ['RejectedConnectionCount', '> 0', 'Connection limit reached'],
      ['TargetConnectionErrorCount', '> 0', 'Target connection failures (network/SG)'],
    ],
  },

  NLB: {
    service: 'NLB',
    intro: (
      <>NLB operates at <b>L4 (TCP/UDP/TLS)</b>, so the perspective differs from ALB — there are no HTTP response
      codes; you focus on <b>connections (flows), resets (RST), target health, throughput, and capacity (LCU)</b>.
      With CloudWatch metrics being limited, <b>RST counts and target health are the core of diagnosis</b>.</>
    ),
    sections: [
      { title: '① Connection (flow) counts', items: [
        <><b>ActiveFlowCount</b> — active flows (TCP). Sudden surges/drops reveal traffic anomalies. <b>NewFlowCount</b> is the connection-establishment rate.</>,
        <>Per-protocol breakdown: ActiveFlowCount_TCP/_UDP/_TLS, NewFlowCount_TCP/_UDP/_TLS. <b>ConsumedLCUs</b> (_TCP/_UDP/_TLS) covers capacity/billing.</>,
      ]},
      { title: '② Resets (RST) — the heart of NLB diagnosis', items: [
        <><b>TCP_Target_Reset_Count</b> — RSTs sent by targets: the backend is dropping connections (app crash, closed port, backlog overflow). <b>A spike is a strong signal of a backend problem.</b></>,
        <><b>TCP_ELB_Reset_Count</b> — RSTs generated by the NLB: idle-timeout expiry and the like. <b>TCP_Client_Reset_Count</b> — client-originated.</>,
        <><b>The key distinction</b>: Target RST spike → backend problem; ELB RST spike → NLB level (usually the <b>350-second idle timeout</b>) or asymmetric routing.</>,
      ]},
      { title: '③ Target health — availability (per target group)', items: [
        <><b>HealthyHostCount</b> (near 0 is dangerous) / <b>UnHealthyHostCount</b> (when rising, investigate health-check failures).</>,
        <>NLB mixes active health checks (TCP/HTTP/HTTPS) with its own judgment — also review the target group's health-check settings (protocol/port/path).</>,
      ]},
      { title: '④ Throughput and bytes', items: [
        <><b>ProcessedBytes</b> (_TCP/_UDP/_TLS), ProcessedPackets.</>,
      ]},
      { title: '⑤ TLS (when using TLS listeners)', items: [
        <><b>Client/TargetTLSNegotiationErrorCount</b>, TLSNegotiationErrorCount — negotiation failures.</>,
      ]},
      { title: '⑥ Capacity limits and more', items: [
        <><b>PortAllocationErrorCount</b> — source-port exhaustion with client-IP preservation + PrivateLink/SNAT. <b>Anything above 0 means connections are failing — an easy cause to miss.</b></>,
        <>PeakPackets/BytesPerSecond, <b>UnhealthyRoutingFlowCount</b> (routing failed for lack of healthy targets — related to fail-open).</>,
      ]},
      { title: 'Diagnosis flows by symptom', items: [
        <>Intermittent connection drops → distinguish <b>Target RST (backend) vs ELB RST (350-second idle timeout exceeded)</b>; review keep-alive settings.</>,
        <>Connections not establishing at all → HealthyHostCount + security groups/NACLs/target ports. <b>NLB preserves the client IP, so target SGs must allow the client IPs — a common trap.</b></>,
        <>Connection failures under high load → <b>PortAllocationErrorCount</b> (SNAT port exhaustion).</>,
        <>TLS listener errors → Client/TargetTLSNegotiationErrorCount.</>,
      ]},
      { title: 'Caveats that differ from ALB', items: [
        <>Being L4, it <b>cannot see application-level latency/errors</b> — investigate HTTP problems via target (backend) metrics and logs.</>,
        <><b>VPC Flow Logs</b> are extremely useful for troubleshooting (accepted/rejected connections, client-IP tracing). NLB's own access logs exist <b>only for TLS listeners</b>.</>,
        <>Because of client-IP preservation, <b>target security-group rules</b> are frequently the culprit.</>,
      ]},
    ],
    priorityHeader: ['Metric', 'Warning threshold', 'Meaning'],
    priority: [
      ['HealthyHostCount', 'Low/0', 'Too few healthy targets'],
      ['UnHealthyHostCount', '> 0', 'Health-check failures'],
      ['TCP_Target_Reset_Count', 'Spiking', 'Backend resetting connections'],
      ['TCP_ELB_Reset_Count', 'Spiking', 'NLB resets (idle timeout, etc.)'],
      ['PortAllocationErrorCount', '> 0', 'SNAT source-port exhaustion'],
      ['ActiveFlowCount', 'Abnormal trend', 'Traffic/connection anomaly'],
      ['TargetTLSNegotiationErrorCount', '> 0', 'Target TLS problem'],
    ],
  },

  S3: {
    service: 'S3',
    intro: (
      <>S3 is managed storage that scales without limit, so there is no notion of "capacity saturation" — instead you
      look at <b>storage usage, request performance/errors, replication, and data protection</b>. A key point:
      CloudWatch metrics come in two kinds — <b>storage metrics (free, once a day)</b> and <b>request metrics
      (paid, 1-minute — they only exist once enabled per bucket/prefix)</b>.</>
    ),
    sections: [
      { title: '① Storage metrics (default, free — aggregated once daily)', items: [
        <><b>BucketSizeBytes</b> — break it down per storage class (StandardStorage/StandardIAStorage/GlacierStorage…) to make it useful for cost/lifecycle diagnosis.</>,
        <><b>NumberOfObjects</b> — surges/drops reveal anomalies and feed request-cost estimates. Aggregated once a day, so it is a <b>trend/cost view</b>, not a real-time one.</>,
      ]},
      { title: '② Request metrics (must be enabled, 1-minute) — the core of performance diagnosis', items: [
        <><b>4xxErrors</b> — 403 permissions / 404 paths, etc. A spike means policy or key-path problems. <b>5xxErrors</b> — 500/503 SlowDown; an S3-side issue or request-rate limit exceeded.</>,
        <><b>503 SlowDown</b> — exceeding the per-prefix request-rate limit (<b>3,500 writes / 5,500 reads per second per prefix</b>) = a hot-prefix signal.</>,
        <>Distinguish <b>FirstByteLatency</b> (S3 processing delay) from <b>TotalRequestLatency</b> (end-to-end — naturally large for big objects).</>,
        <>AllRequests/Get/Put/Delete/Head/List, BytesDownloaded/Uploaded — the traffic baseline.</>,
      ]},
      { title: '③ Replication (when using CRR/SRR)', items: [
        <><b>ReplicationLatency</b> — against the RTC SLA (15 minutes) when using RTC. A rising trend in <b>BytesPendingReplication / OperationsPendingReplication</b> = replication bottleneck.</>,
        <><b>OperationsFailedReplication</b> — anything above 0 warrants a permissions/configuration investigation.</>,
      ]},
      { title: '④ Data protection, lifecycle, and more', items: [
        <><b>Storage Lens</b> — account/organization-wide visibility: incomplete multipart uploads, accumulating noncurrent versions, and other inefficiencies — the key diagnostic tool.</>,
        <>S3 Storage Class Analysis — lifecycle-optimization diagnosis.</>,
      ]},
      { title: 'Diagnosis flows by symptom', items: [
        <>Intermittent 503 SlowDown → <b>hot prefix</b>: spread the key namespace across prefixes (random/hash), and use per-prefix request metrics to find which prefix is hot.</>,
        <>403 spike → check bucket policy / IAM / ACLs / Block Public Access / KMS key permissions. Trace denied principals and operations with <b>CloudTrail data events</b>.</>,
        <>Latency spike → distinguish FirstByteLatency vs TotalRequestLatency (S3 processing vs object size/network). Consider Transfer Acceleration, multipart, region proximity.</>,
        <>Replication lag/failures → OperationsPendingReplication trend + OperationsFailedReplication + replication rules/permissions.</>,
        <>Unexplained access/deletions → break individual requests down (requester, operation, response code, latency) via <b>server access logs / CloudTrail data events</b>.</>,
      ]},
      { title: 'S3-specific quirks', items: [
        <>For real-time performance diagnosis you must <b>enable request metrics first</b> (off by default, paid) — without them 4xx/5xx/latency simply do not show up (the '—' in the table below).</>,
        <>Tracing individual requests is the job of <b>server access logs / CloudTrail data events</b>, not CloudWatch.</>,
        <>For cost and lifecycle optimization, <b>Storage Lens</b> is the key tool.</>,
      ]},
    ],
    priorityHeader: ['Metric', 'Warning threshold', 'Meaning'],
    priority: [
      ['5xxErrors', 'Spiking', 'S3-side errors or request rate exceeded (503 SlowDown)'],
      ['4xxErrors', 'Spiking', 'Permission/path/request errors'],
      ['FirstByteLatency', 'Spiking', 'S3 processing delay'],
      ['OperationsFailedReplication', '> 0', 'Replication failures'],
      ['ReplicationLatency', 'Over SLA', 'Replication lag'],
      ['BucketSizeBytes', 'Abnormal surge', 'Cost/anomalous uploads'],
      ['NumberOfObjects', 'Abnormal surge/drop', 'Mass deletion/creation'],
    ],
  },
  EBS: {
    service: 'EBS',
    intro: (
      <>For EBS the focus is <b>IOPS, throughput, latency, queue depth, and burst/performance credits</b>. The essence
      is <b>telling apart whether you hit the volume's provisioned performance limit or the instance-side EBS
      bandwidth limit</b> — they are two separate ceilings.</>
    ),
    sections: [
      { title: '① IOPS (operation counts)', items: [
        <><b>VolumeReadOps / VolumeWriteOps</b> — these are period sums, so <b>divide by the period in seconds to get IOPS</b> (/300 for 5-minute aggregation). Compare against provisioned IOPS (gp3/io1/io2) or the baseline (gp2 = 3 IOPS/GB).</>,
        <>If combined IOPS sits pinned at the provisioned limit → the volume is the bottleneck.</>,
      ]},
      { title: '② Throughput', items: [
        <><b>VolumeReadBytes / VolumeWriteBytes</b> — convert to MB/s and compare against the throughput limit. <b>gp3 provisions IOPS and throughput independently</b>, so check both separately.</>,
      ]},
      { title: '③ Latency — judging I/O bottlenecks', items: [
        <><b>VolumeTotalRead/WriteTime</b> — average latency per operation = <b>TotalTime / Ops</b>.</>,
        <>High latency while IOPS/throughput are below their limits → large I/O sizes or a random-access pattern problem.</>,
      ]},
      { title: '④ Queue depth — the saturation signal', items: [
        <><b>VolumeQueueLength</b> — number of I/O requests waiting. <b>The most intuitive saturation indicator.</b> Persistently high means the volume cannot keep up (accompanied by latency spikes).</>,
      ]},
      { title: '⑤ Idle time and utilization', items: [
        <>VolumeIdleTime, <b>VolumeThroughputPercentage</b> (io1/io2 only — actual delivered vs provisioned; persistently below 100% = performance degradation), VolumeConsumedReadWriteOps.</>,
      ]},
      { title: '⑥ Burst/performance credits — an easy bottleneck to miss', items: [
        <><b>BurstBalance</b> — credit balance (%) for gp2·st1·sc1 only. Approaching 0 demotes you to baseline → intermittent slowdowns. <b>The usual culprit behind unexplained gp2 performance problems.</b></>,
        <>gp3/io1/io2 have no burst concept — <b>migrating gp2→gp3 often is the fix</b>.</>,
      ]},
      { title: '⑦ Instance level — the EBS bandwidth ceiling', items: [
        <>If the volume has headroom but things are slow, suspect the instance side: <b>EBSIOBalance% / EBSByteBalance%</b> (EBS burst balance on smaller instances) — approaching 0 demotes the instance to its baseline → <b>a bottleneck no matter how big the volume is.</b></>,
        <>EBSRead/WriteOps·Bytes — compare against the instance type's EBS bandwidth ceiling.</>,
      ]},
      { title: 'Diagnosis flows by symptom', items: [
        <>Intermittent/periodic slowdowns → <b>credit exhaustion in BurstBalance (gp2) or EBSIOBalance% (small instances)</b> — the number-one cause of EBS performance problems.</>,
        <>High latency with IOPS/throughput under the limits → I/O size/randomness or instance bandwidth. Check VolumeQueueLength together with the instance EBS balances.</>,
        <>Volume has headroom but still slow → check instance EBSByte/IOBalance% + the instance type's EBS ceiling (an instance-type upgrade may be needed).</>,
        <>IOPS pinned at the provisioned limit → raise gp3 IOPS/throughput, move to io2, spread across volumes (RAID 0), or add application caching.</>,
      ]},
      { title: 'EBS-specific caveats', items: [
        <>CloudWatch raw values are <b>period sums — you must divide to get real IOPS/latency</b>.</>,
        <>gp2's 3 IOPS/GB baseline + burst model → <b>credit exhaustion on small gp2 volumes</b> is a recurring culprit. Moving to gp3 is usually the answer.</>,
        <><b>Volume performance and instance EBS bandwidth are separate ceilings</b> — you must check both to pinpoint the bottleneck.</>,
      ]},
    ],
    priorityHeader: ['Metric', 'Warning threshold', 'Meaning'],
    priority: [
      ['VolumeQueueLength', 'Persistently high', 'Volume saturation (I/O queuing)'],
      ['BurstBalance (gp2/st1/sc1)', 'Near 0', 'Credit exhaustion → baseline demotion'],
      ['Avg latency (TotalTime/Ops)', 'Spiking', 'I/O bottleneck'],
      ['VolumeReadOps+WriteOps (derived IOPS)', 'Near provisioned', 'IOPS limit'],
      ['VolumeThroughputPercentage (io1/io2)', '< 100%', 'Below provisioned performance'],
      ['EBSIOBalance%/EBSByteBalance%', 'Near 0', 'Instance EBS bandwidth demotion'],
    ],
  },

  EC2: {
    service: 'EC2',
    intro: (
      <>For EC2 the basics are <b>CPU, network, EBS I/O, status checks, and burstable credits</b>. The most important
      quirk: <b>memory and disk usage are absent from the default CloudWatch metrics</b> (the hypervisor cannot see
      inside the guest) — both require installing the CloudWatch Agent.</>
    ),
    sections: [
      { title: '① CPU', items: [
        <><b>CPUUtilization</b> — sustained above 80%, consider scaling or changing the instance type. It is the hypervisor's view, so it cannot see guest internals such as vCPU steal.</>,
        <><b>CPUCreditBalance / CPUCreditUsage</b> — T-class only. Approaching 0 means baseline demotion (Standard) or extra charges (Unlimited). <b>The usual culprit behind unexplained slowdowns.</b> CPUSurplusCreditsCharged is the Unlimited overage billing.</>,
      ]},
      { title: '② Status checks — the core of availability diagnosis', items: [
        <><b>StatusCheckFailed_System</b> — an AWS infrastructure problem (host hardware/network/power). Remedy: <b>stop/start</b> (moves to another host).</>,
        <><b>StatusCheckFailed_Instance</b> — a problem inside the instance (OS boot/filesystem/network config/kernel). Remedy: investigate the OS / reboot.</>,
        <><b>StatusCheckFailed_AttachedEBS</b> — an attached EBS volume is not responding to I/O.</>,
        <>This distinction immediately answers <b>"is it AWS's problem or my OS's problem?"</b>. Automate recovery with a CloudWatch alarm + EC2 auto-recovery.</>,
      ]},
      { title: '③ Network', items: [
        <><b>NetworkIn/Out</b> (against the bandwidth ceiling), <b>NetworkPacketsIn/Out</b> (detects the PPS ceiling).</>,
        <>Bandwidth/PPS/conntrack ceiling breaches do not show in the default metrics — for accuracy use the <b>network performance metrics (ethtool, CloudWatch Agent)</b>: bw_in/out_allowance_exceeded, pps_allowance_exceeded, conntrack_allowance_exceeded. <b>An easy bottleneck to miss.</b></>,
      ]},
      { title: '④ EBS I/O (instance perspective)', items: [
        <>EBSRead/WriteOps·Bytes — instance↔EBS I/O.</>,
        <><b>EBSIOBalance% / EBSByteBalance%</b> — EBS burst balance on smaller instances. Approaching 0 demotes the instance to its baseline → <b>a bottleneck even with a large volume</b> (ties into the EBS guide).</>,
      ]},
      { title: '⑤ Requires the CloudWatch Agent (not provided by default) — essential in practice', items: [
        <><b>Memory</b> (mem_used_percent, etc.) — a large share of EC2 performance problems are memory, yet it is missing from the default metrics.</>,
        <><b>Disk</b> (disk_used_percent, diskio_*) — detects root/data volume exhaustion. <b>Swap</b> (swap_used_percent), guest-view CPU (including steal), processes.</>,
        <>For fine-grained diagnosis, installing the CloudWatch Agent is effectively mandatory.</>,
      ]},
      { title: 'Diagnosis flows by symptom', items: [
        <>Instance unresponsive → <b>status checks first</b>: System failure means the AWS side (stop/start to relocate); Instance failure means investigate the OS (system log/screenshot).</>,
        <>Intermittent/periodic slowdowns → on T-class, <b>CPUCreditBalance exhaustion is suspect number one</b>, then EBSIOBalance%.</>,
        <>Slow despite low CPU → check memory/swap (Agent), disk I/O, and network allowance breaches.</>,
        <>Network throughput plateau → check the type's bandwidth ceiling + *_allowance_exceeded; consider an instance-type upgrade.</>,
      ]},
      { title: 'EC2-specific caveats', items: [
        <><b>Memory and disk are absent from the default metrics → CloudWatch Agent is mandatory.</b> The answer to "why is there no memory metric?".</>,
        <>The status-check <b>System vs Instance</b> distinction = the key diagnostic point that immediately assigns responsibility (AWS vs you).</>,
        <>Burstable (T) credits and small instances' EBS/network bursts are the usual culprits behind unexplained performance problems — suspect them first on T/small types.</>,
        <>Deeper investigation: CloudWatch Logs, EC2 system log/screenshot, Compute Optimizer (rightsizing).</>,
      ]},
    ],
    priorityHeader: ['Metric', 'Warning threshold', 'Meaning'],
    priority: [
      ['StatusCheckFailed_System', '= 1', 'AWS infrastructure problem → stop/start'],
      ['StatusCheckFailed_Instance', '= 1', 'OS/instance-internal problem'],
      ['CPUUtilization', '> 80% sustained', 'Compute bottleneck'],
      ['CPUCreditBalance (T-class)', 'Near 0', 'Credit exhaustion → demotion/charges'],
      ['mem_used_percent (Agent)', 'High', 'Memory pressure'],
      ['disk_used_percent (Agent)', '> 85%', 'Disk exhaustion'],
      ['EBSIOBalance%/EBSByteBalance%', 'Near 0', 'EBS bandwidth demotion'],
      ['bw/pps/conntrack_allowance_exceeded (Agent)', '> 0', 'Network ceiling bottleneck'],
    ],
  },

  Lambda: {
    service: 'Lambda',
    intro: (
      <>For Lambda the focus is <b>invocations, errors, throttles, duration, and concurrency</b>. Being serverless
      there are no infrastructure metrics — you concentrate on per-execution success/failure/latency/capacity.</>
    ),
    sections: [
      { title: '① Invocations and errors — where diagnosis starts', items: [
        <><b>Invocations</b> (traffic baseline), <b>Errors</b> (handler exceptions and timeouts). Read it as an <b>error rate = Errors / Invocations</b> — the absolute count alone cannot be told apart from a traffic increase.</>,
        <><b>DeadLetterErrors</b> — DLQ delivery failures (async). Anything above 0 may mean failed events are being lost. <b>DestinationDeliveryFailures</b> is the same family.</>,
      ]},
      { title: '② Throttles — the concurrency limit', items: [
        <><b>Throttles</b> — 429s from exceeding the concurrency limit. <b>The most common scaling problem.</b> Causes: the account's regional limit (default 1,000), reserved-concurrency settings, or a sharp burst.</>,
      ]},
      { title: '③ Duration', items: [
        <><b>Duration</b> — read <b>as p50/p90/p99 percentiles</b> (averages hide cold starts and the long tail). <b>Approaching the configured timeout</b> risks timeout errors.</>,
        <>PostRuntimeExtensionsDuration — check extension overhead.</>,
      ]},
      { title: '④ Concurrency', items: [
        <><b>ConcurrentExecutions</b> — against the account/function limit. Getting close means throttling is imminent. UnreservedConcurrentExecutions is the pool excluding reserved.</>,
      ]},
      { title: '⑤ Provisioned concurrency (PC)', items: [
        <><b>ProvisionedConcurrencyUtilization</b> near 100% = PC is undersized. <b>ProvisionedConcurrencySpilloverInvocations &gt; 0</b> = overflow beyond PC is spilling into on-demand cold starts.</>,
      ]},
      { title: '⑥ Per event source (streams/queues)', items: [
        <><b>IteratorAge</b> — the key metric for Kinesis/DynamoDB Streams consumption. Continuous growth means Lambda cannot keep up with the producer → adjust batch size / ParallelizationFactor / function performance.</>,
        <><b>OffsetLag</b> (Kafka/MSK sources); for SQS also watch ApproximateAgeOfOldestMessage; for async, AsyncEventsReceived/Age/Dropped.</>,
      ]},
      { title: '⑦ Cold starts', items: [
        <>No direct metric — check <b>INIT_START / Init Duration</b> in CloudWatch Logs, or X-Ray. Diagnose together with a Duration p99 spike + PC spillover.</>,
      ]},
      { title: 'Diagnosis flows by symptom', items: [
        <>429 rejections → <b>Throttles + ConcurrentExecutions vs the limit</b>. Raise reserved, request an account-limit increase, or smooth the burst.</>,
        <>Intermittent slowness → <b>Duration p99 + Init Duration</b> (logs). Introduce PC, <b>raise memory (on Lambda more memory = more CPU)</b>, slim the package.</>,
        <>Rising error rate → exception stacks in the logs. If timeouts, check whether Duration is pinned at the configured value.</>,
        <>Stream falling behind → IteratorAge growing continuously → batching/parallelization/function performance/downstream bottleneck.</>,
        <>Async event loss → DeadLetterErrors / AsyncEventsDropped + DLQ configuration.</>,
      ]},
      { title: 'Lambda-specific caveats', items: [
        <><b>The memory setting is the performance setting</b> — more memory = more CPU/network, which can shrink Duration. Rightsize with Max Memory Used (log report); <b>Lambda Power Tuning</b> is a great help.</>,
        <>Always read errors <b>as a rate against Invocations</b>.</>,
        <>Deeper diagnosis: <b>CloudWatch Logs Insights</b> (aggregate error patterns, Init Duration, Max Memory Used) + <b>X-Ray</b> (cold-start and downstream breakdown). Enable <b>Lambda Insights</b> for CPU/memory/network metrics of the execution environment.</>,
      ]},
    ],
    priorityHeader: ['Metric', 'Warning threshold', 'Meaning'],
    priority: [
      ['Errors (error rate)', 'Spiking', 'Exceptions/timeouts'],
      ['Throttles', '> 0', 'Concurrency limit exceeded (429)'],
      ['Duration (p99)', 'Near timeout', 'Performance degradation/timeout risk'],
      ['ConcurrentExecutions', 'Near limit', 'Throttling imminent'],
      ['IteratorAge (streams)', 'Rising trend', 'Consumer processing lag'],
      ['ProvisionedConcurrencySpilloverInvocations', '> 0', 'PC undersized → cold starts'],
      ['DeadLetterErrors', '> 0', 'Risk of losing failed events'],
    ],
  },

  EKS: {
    service: 'EKS',
    intro: (
      <>EKS has more layers than other services — you have to look at the <b>control plane (API server/etcd), nodes
      (workers), pods/workloads, and scaling</b> layer by layer, and the metrics come not from CloudWatch alone but
      from several sources: <b>Container Insights, control-plane logs, and Prometheus/kube-state-metrics</b>.</>
    ),
    sections: [
      { title: 'Sort out the metric sources first', items: [
        <>EKS control plane → CloudWatch control-plane logging + some CloudWatch metrics (this dashboard: the {code('AWS/EKS')} namespace).</>,
        <>Nodes/pods/containers → <b>CloudWatch Container Insights</b> (agent required) or Prometheus (this dashboard: the {code('ContainerInsights')} namespace + the in-cluster API).</>,
        <>Kubernetes object state (Deployments, ReplicaSets, etc.) → kube-state-metrics. Node OS level → node_exporter / CloudWatch agent.</>,
      ]},
      { title: '① Control plane (API server / etcd) — managed, but you still watch its load', items: [
        <><b>apiserver_request_duration_seconds</b> — API server request latency. A spike means the control plane is overloaded.</>,
        <><b>apiserver_request_total</b> (per response code) — the <b>429 (throttling) and 5xx ratios</b>.</>,
        <><b>etcd_db_total_size_in_bytes</b> — etcd DB size. Approaching the limit (default cap 8GB) risks write rejections and cluster paralysis. Detects runaway accumulation of objects/secrets.</>,
        <><b>apiserver_current_inflight_requests</b> — in-flight requests. Check for Priority and Fairness (APF) throttling.</>,
        <>Control-plane logs (api, audit, authenticator, controllerManager, scheduler) are essential for root-cause tracing.</>,
      ]},
      { title: '② Node (worker) level — Container Insights', items: [
        <><b>node_cpu_utilization / node_memory_utilization</b> — node CPU/memory usage. Memory is central to diagnosing OOM/eviction.</>,
        <><b>node_filesystem_utilization</b> — node disk (especially /var/lib images/logs). <b>Above 85%, DiskPressure evicts pods.</b></>,
        <><b>node_status_condition</b> (Ready, MemoryPressure, DiskPressure, PIDPressure) — node condition status (this dashboard: queried in-cluster).</>,
        <><b>cluster_node_count / cluster_failed_node_count</b> — node counts / failed nodes, plus <b>node_network_total_bytes</b>.</>,
      ]},
      { title: '③ Pods / workloads — Container Insights', items: [
        <><b>pod_cpu_utilization_over_pod_limit</b> — usage against the limit. Exceeding the limit means CPU throttling.</>,
        <><b>pod_memory_utilization_over_pod_limit</b> — approaching the limit risks OOMKilled.</>,
        <><b>pod_number_of_container_restarts</b> — container restart count. A spike signals CrashLoopBackOff / OOMKill. <b>One of the most important anomaly indicators.</b></>,
        <><b>pod_status_ready / running / pending / failed</b>, and kube-state-metrics' {code('kube_pod_container_status_last_terminated_reason')} to confirm OOMKilled.</>,
        <><b>kube_pod_status_phase</b> — accumulating Pending pods means scheduling failures (insufficient resources, taints, unbound PVs).</>,
      ]},
      { title: '④ Scheduling / scaling', items: [
        <><b>Pending pod count</b> — pods that cannot be scheduled. Diagnose whether Cluster Autoscaler / Karpenter is failing to attach nodes, or resource requests are oversized.</>,
        <>Cluster Autoscaler: {code('cluster_autoscaler_unschedulable_pods_count')} · Karpenter: provisioning/drift/consolidation metrics.</>,
        <>HPA: {code('kube_horizontalpodautoscaler_status_current_replicas')} vs desired — whether the scale target is being reached.</>,
        <><b>Reserved vs actual resources</b>: the sum of requests vs node allocatable — detects nodes that are "logically full" from over-reserved requests (this dashboard: the reserved capacity column).</>,
      ]},
      { title: '⑤ Network / add-ons', items: [
        <><b>VPC CNI IP exhaustion</b> — subnet IPs run out, or the per-ENI IP cap keeps pods from getting an IP, leaving them Pending. Check awscni/ipamd metrics such as {code('aws_eni_allocated')}. <b>A common trap on EKS</b> (this dashboard: the ENI IP slot bar in the node detail).</>,
        <><b>CoreDNS latency/errors</b> — DNS problems fan out into widespread outages. {code('coredns_dns_request_duration_seconds')} and the failure rate.</>,
        <>kube-proxy and load-balancer controller health (this dashboard: the add-on status table).</>,
      ]},
      { title: 'Diagnosis flows by symptom', items: [
        <>Pods restarting continuously → <b>container_restarts + last_terminated_reason</b> (is it OOMKilled?) + memory against the limit. If OOM, raise the limit or investigate an app memory leak. Confirm with logs and {code('kubectl describe')}.</>,
        <>Pods stuck Pending → check the events in {code('kubectl describe pod')}. The cause is usually one of: ① insufficient resources (scaling needed) ② VPC CNI IP exhaustion ③ taints/affinity ④ an unbound PV.</>,
        <>Node NotReady → node conditions (Pressure), kubelet status, node OS level (disk/memory).</>,
        <>Intermittent API errors / slow deployments → control-plane latency and 429s, APF throttling, etcd size.</>,
        <>Widespread DNS-related outage → CoreDNS metrics/logs and the replica count.</>,
      ]},
      { title: 'EKS-specific caveats', items: [
        <><b>Container Insights must be enabled</b> for node/pod/container metrics to reach CloudWatch (not provided by default). Alternatively, AMP (Amazon Managed Prometheus) + kube-state-metrics/node_exporter.</>,
        <>CloudWatch metrics alone are often not enough — in practice it is common to view Kubernetes-native metrics with <b>Prometheus + Grafana</b> (or AMP/AMG).</>,
        <>Diagnosis combines metrics with <b>kubectl (describe, logs, events, top)</b> and the control-plane logs. For a specific pod/node problem, the kubectl events are ultimately decisive.</>,
        <><b>VPC CNI IP exhaustion</b> and <b>over-reserved resource requests</b> are EKS-specific causes of Pending — keep them at the top of your suspect list.</>,
      ]},
    ],
    priorityHeader: ['Metric', 'Warning threshold', 'Meaning'],
    priority: [
      ['pod_number_of_container_restarts', 'Spiking', 'CrashLoop/OOMKill'],
      ['pod_memory_utilization_over_pod_limit', 'Near 100%', 'OOMKilled risk'],
      ['node_status_condition (Pressure)', 'True', 'Disk/Memory/PID pressure → eviction'],
      ['Pending pod count', '> 0 sustained', 'Scheduling/scaling/IP failure'],
      ['node_filesystem_utilization', '> 85%', 'DiskPressure'],
      ['apiserver_request_duration / 429', 'Spiking', 'Control-plane overload'],
      ['etcd_db_total_size_in_bytes', 'Near limit', 'etcd saturation'],
      ['VPC CNI IP headroom', 'Low', 'Pod IP exhaustion'],
    ],
  },
  ANFW: {
    service: 'ANFW',
    intro: (
      <>Network Firewall monitoring looks at three layers together — <b>CloudWatch metrics, firewall logs
      (Alert/Flow/TLS), and complementary sources (VPC Flow Logs, CloudTrail, routing)</b>: metrics give
      volume and trends, logs give the &ldquo;which rule caught what&rdquo; context, and the complementary
      sources catch bypasses and changes.</>
    ),
    sections: [
      { title: '① CloudWatch metrics (AWS/NetworkFirewall)', items: [
        <><b>ReceivedPackets / ReceivedBytes</b> — total ingress and bandwidth. Dimensions are
        (FirewallName, AZ, Engine) — every packet passes the stateless engine first, so <b>received
        aggregation must use Engine=Stateless only</b> to avoid double-counting SFE-forwarded packets
        (how this page aggregates).</>,
        <><b>PassedPackets / DroppedPackets / RejectedPackets</b> — passed / dropped / explicitly rejected
        (TCP RST). A spike in blocked traffic signals an attack or a rule misplacement — use the Alert log
        to see which rule.</>,
        <><b>InvalidDroppedPackets / OtherDroppedPackets / StreamExceptionPolicyPackets</b> — abnormal
        packets, other drops, stream-exception handling. Sustained occurrences suggest asymmetric routing or
        session-handling issues.</>,
        <><b>TLS*Packets</b> (with TLS inspection) — monitor decryption failures (TLSDropped/Rejected).</>,
        <>Firewall <b>state</b> comes from the API (READY / IN_SYNC / per-AZ endpoints), not a CW metric —
        the table at the top of this page serves that role. The <b>CustomAction</b> dimension enables
        per-rule custom metrics.</>,
      ]},
      { title: '② Firewall logs (S3 / CloudWatch Logs / Firehose)', items: [
        <><b>Alert log</b> — traffic matched by stateful alert/drop rules. Which rule (sid) blocked or
        alerted on what — <b>the core of threat analysis</b>. The card below aggregates CloudWatch Logs
        destinations with Insights.</>,
        <><b>Flow log</b> — every flow the stateful engine saw (5-tuple, bytes/packets, session
        start/end). For traffic-pattern and top-talker analysis.</>,
        <><b>TLS log</b> — TLS inspection events (SNI, certificates, errors).</>,
        <>Logs carry source/destination IP·port, protocol, rule match, and timestamps — context
        metrics alone cannot give. <b>S3/Firehose destinations cannot be aggregated on this page</b>
        (analyze separately, e.g. Athena).</>,
      ]},
      { title: '③ Complementary data sources', items: [
        <><b>VPC Flow Logs</b> — verify firewall-endpoint subnets and routing, <b>detect traffic
        bypassing ANFW</b>.</>,
        <><b>CloudTrail</b> — audit policy / rule group change events (who changed the rules) —
        the change-audit card below.</>,
        <><b>Route tables</b> — confirm traffic actually traverses the firewall endpoints (see the VPC
        resource map).</>,
      ]},
      { title: '④ Paths by analysis goal', items: [
        <><b>Threat detection</b> → Alert log + spikes in DroppedPackets/RejectedPackets.</>,
        <><b>Capacity/performance</b> → ReceivedPackets/Bytes trend + Flow-log top talkers.</>,
        <><b>Availability</b> → firewall state (READY/IN_SYNC) + per-AZ endpoint/metric skew.</>,
        <><b>Change audit / compliance</b> → CloudTrail management events (write events first).</>,
      ]},
    ],
    priorityHeader: ['Data', 'Goal', 'Key signal'],
    priority: [
      ['Alert log + Dropped/RejectedPackets', 'Threat detection', 'Block spikes · signature (sid) matches'],
      ['ReceivedPackets/Bytes + Flow log', 'Capacity/performance', 'Traffic volume trend · top talkers'],
      ['Firewall state + per-AZ metrics', 'Availability', 'READY/IN_SYNC · AZ skew'],
      ['CloudTrail management events', 'Change audit', 'Who changed policies/rules'],
      ['VPC Flow Logs + routing', 'Bypass detection', 'Traffic not traversing the firewall'],
    ],
  },
};
