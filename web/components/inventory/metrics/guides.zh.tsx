import type { GuideSpec } from './DiagnosisGuide';

// ZH translations of guides.tsx — keep keys in lockstep with GuideSpec.service values.

const code = (t: string) => <code className="rounded bg-ink-50 px-1 font-mono text-[11px]">{t}</code>;

export const GUIDES_ZH: Record<string, GuideSpec> = {
  MSK: {
    service: 'MSK',
    intro: (
      <>MSK 依据<b>监控级别</b>（DEFAULT / PER_BROKER / PER_TOPIC_PER_BROKER / PER_TOPIC_PER_PARTITION）
      暴露不同粒度的指标。若需要进行诊断，建议至少提升到 <b>PER_BROKER 及以上</b>级别。</>
    ),
    sections: [
      { title: '① Broker 资源（瓶颈的根源）', items: [
        <><b>CpuUser + CpuSystem</b> — 两者之和超过 60~70% 时应告警。MSK 官方建议：保持 40% 以上的 CPU 余量。</>,
        <><b>KafkaDataLogsDiskUsed</b> — 数据盘使用率（%）。<b>最常见的故障原因</b> — 超过 85% 即进入危险区，需要扩容存储或启用自动扩缩。</>,
        <><b>MemoryUsed / MemoryFree</b>、<b>RootDiskUsed</b> — 根卷也要一并检查。</>,
      ]},
      { title: '② 集群健康状况', items: [
        <><b>ActiveControllerCount</b> — 正常值应恰好为 <b>1</b>。若为 0 或大于等于 2，说明控制器异常 → 需立即排查。</>,
        <><b>OfflinePartitionsCount</b> — 正常值为 <b>0</b>。大于 0 表示相关分区不可服务（数据可用性问题）。</>,
        <><b>UnderReplicatedPartitions</b> — 正常值为 <b>0</b>。大于 0 表示副本复制正在落后（Broker 过载或故障的信号）。</>,
        <><b>UnderMinIsrPartitionCount</b> — 低于 min.insync.replicas 的分区数。此时 acks=all 的生产者会被拒绝写入。</>,
      ]},
      { title: '③ 吞吐量与流量', items: [
        <><b>BytesInPerSec / BytesOutPerSec</b> — 对照实例类型的网络带宽上限检查，并结合 <b>MessagesInPerSec</b> 一起观察。</>,
        <><b>ProduceThrottleTime / FetchThrottleTime</b> — 判断是否发生了配额或网络层面的限流。</>,
      ]},
      { title: '④ 延迟（Latency）', items: [
        <><b>RequestQueueSize / ResponseQueueSize</b> — 队列不断堆积说明 Broker 已经跟不上请求处理速度。</>,
        <>可通过 Produce/Fetch 延迟指标（如 FetchConsumerTotalTimeMsMean 等）做更细致的确认。</>,
      ]},
      { title: '⑤ 消费者滞后 — 实际运维中最重要', items: [
        <><b>MaxOffsetLag / SumOffsetLag / EstimatedMaxTimeLag</b> — 消费者跟不上生产者时 lag 会持续增长，是诊断实时数据管道的首要指标。</>,
        <>消费者组 lag 除了 CloudWatch，也可用 Kafka 自带的 {code('kafka-consumer-groups.sh')} 直接确认。</>,
      ]},
      { title: '⑥ 连接', items: [
        <><b>ConnectionCount / ClientConnectionCount</b>、<b>ConnectionCreationRate / CloseRate</b> — 用于发现连接数暴涨或重连风暴。</>,
      ]},
    ],
    priorityHeader: ['指标', '正常值', '含义'],
    priority: [
      ['ActiveControllerCount', '= 1', '控制器正常'],
      ['OfflinePartitionsCount', '= 0', '可用性'],
      ['UnderReplicatedPartitions', '= 0', '副本健康状况'],
      ['KafkaDataLogsDiskUsed', '< 85%', '防止磁盘耗尽'],
      ['CpuUser + CpuSystem', '< ~60%', '负载余量'],
      ['MaxOffsetLag', '趋势平稳', '消费者处理滞后'],
    ],
  },
  RDS: {
    service: 'RDS',
    intro: (
      <>RDS 诊断需要同时查看 <b>CloudWatch 基础指标 · Enhanced Monitoring · Performance Insights</b> 三个层次
      — 分别对应实例 / 操作系统 / 查询三种视角。</>
    ),
    sections: [
      { title: '① CloudWatch 基础指标（实例级）', items: [
        <><b>CPUUtilization</b> — 持续超过 80% 时应考虑扩容实例或优化查询。</>,
        <><b>CPUCreditBalance / CPUCreditUsage</b> — 仅限 T 系列（突发型）实例。积分趋近于 0 时性能会骤降。<b>这是生产环境中经常被忽视的陷阱。</b></>,
        <><b>FreeableMemory</b> — 持续偏低意味着存在换页（swap）风险。<b>SwapUsage</b> 正常应接近 0 — 一旦变大就是性能骤降的信号。</>,
        <><b>FreeStorageSpace</b> — <b>最常见的故障原因。</b>耗尽后数据库会直接停摆 → 必须配置存储自动扩容和告警。<b>DiskQueueDepth</b> 偏高说明存储层存在瓶颈。</>,
        <><b>ReadIOPS / WriteIOPS</b> — 对照预置 IOPS（gp3/io1/io2）上限检查。<b>ReadLatency / WriteLatency</b> 突增 = 存储瓶颈。<b>BurstBalance</b>（gp2）耗尽后会被降级为 baseline IOPS。</>,
        <><b>DatabaseConnections</b> — 对照 max_connections 检查，用于诊断连接耗尽或泄漏（未使用连接池）。</>,
      ]},
      { title: '② 复制 / 高可用', items: [
        <><b>ReplicaLag</b>（只读副本，单位秒）/ <b>AuroraReplicaLag</b> — 读写分离时会引发数据新鲜度问题。</>,
        <>Multi-AZ 故障转移事件可通过 RDS Events 追踪。</>,
      ]},
      { title: '③ Enhanced Monitoring（OS 级，最小 1 秒粒度）', items: [
        <>CloudWatch 基础指标是虚拟化管理层（hypervisor）视角 — OS 内部需靠 Enhanced Monitoring：按进程的 CPU/内存、os.cpuUtilization 细分（user/system/wait/idle）、os.diskIO、loadAverage。</>,
        <><b>CPU wait 高 = I/O 瓶颈，system 高 = 内核开销大</b> — 对区分根因非常有用。</>,
      ]},
      { title: '④ Performance Insights（查询级 — 诊断的核心）', items: [
        <><b>DB Load (AAS)</b> — 核心指标。一旦升到 <b>Max vCPU 线以上</b>就属于过载。</>,
        <><b>Wait events 分解</b> — 判断瓶颈到底在 CPU / IO / Lock 中的哪一类（io/table/sql/handler、锁等待等）。</>,
        <><b>Top SQL</b> — 找出造成负载的头部查询 → 作为调优对象。</>,
      ]},
    ],
    priorityHeader: ['指标', '告警标准', '含义'],
    priority: [
      ['CPUUtilization', '持续 > 80%', '计算瓶颈'],
      ['FreeStorageSpace', '低于阈值', '磁盘耗尽 → 数据库停摆'],
      ['FreeableMemory', '偏低 + SwapUsage 上升', '内存不足'],
      ['DatabaseConnections', '接近 max', '连接耗尽/泄漏'],
      ['ReadLatency/WriteLatency', '突增', '存储瓶颈'],
      ['ReplicaLag', '呈上升趋势', '复制延迟'],
      ['BurstBalance/CPUCreditBalance', '趋近 0', 'gp2/T 系列积分耗尽'],
      ['DB Load (PI)', '> Max vCPU', '整体过载'],
    ],
  },
  DynamoDB: {
    service: 'DynamoDB',
    intro: (
      <>DynamoDB 是全托管服务，没有 OS/磁盘层面的指标，主要<b>以 CloudWatch 为中心查看吞吐量、限流、延迟和错误</b>。
      根据容量模式（On-Demand 与 Provisioned）不同，需要关注的指标也随之变化。</>
    ),
    sections: [
      { title: '① 限流（Throttling）— 诊断中最重要', items: [
        <><b>ThrottledRequests</b>、<b>ReadThrottleEvents / WriteThrottleEvents</b>、<b>OnlineIndexThrottleEvents</b>（GSI 建立索引时）。</>,
        <>原因通常是二者之一：<b>预置容量不足</b>（容量 &lt; 流量），或者<b>热分区/热键</b> — 整体容量尚有富余，但某个分区触到上限（每分区 3000 RCU / 1000 WCU）。后者是最难诊断的情形。</>,
      ]},
      { title: '② 容量使用情况', items: [
        <>将 <b>ConsumedRead/WriteCapacityUnits</b>（实际消耗）与 <b>ProvisionedRead/WriteCapacityUnits</b>（配置值）叠加对比，判断容量余量是否充足。</>,
        <>On-Demand 模式则看消耗趋势 + AccountMaxTableLevelReads/Writes 上限 + 是否出现瞬时激增（超过 2 倍规则）。</>,
      ]},
      { title: '③ 延迟（Latency）', items: [
        <><b>SuccessfulRequestLatency</b> — <b>关键在于按操作类型分解</b>（GetItem/Query/PutItem/Scan…）。这是服务端延迟（不含网络往返）。</>,
        <>Scan/Query 延迟出现尖峰时，应怀疑低效的访问模式（全表扫描、结果集过大）。</>,
      ]},
      { title: '④ 错误', items: [
        <><b>SystemErrors</b>（HTTP 500，服务端）/ <b>UserErrors</b>（HTTP 400，客户端）。</>,
        <><b>ConditionalCheckFailedRequests</b> — 使用乐观锁时正常情况下也会出现 → 需结合上下文判断。<b>TransactionConflict</b> 偏高说明竞争激烈。</>,
      ]},
      { title: '⑤ Global Tables / 流（Streams）', items: [
        <><b>ReplicationLatency</b>、PendingReplicationCount、AgeOfOldestUnreplicatedRecord — 跨区域复制延迟。</>,
        <>若用 Lambda 消费 Streams，可通过 Lambda 的 <b>IteratorAge</b> 确认流处理是否滞后。</>,
      ]},
      { title: '深入诊断：CloudWatch Contributor Insights for DynamoDB', items: [
        <><b>专用于探测热分区/热键的工具</b> — 按访问频率对分区键排名展示，在区分限流原因究竟是"容量不足"还是"键分布不均"时起决定性作用。</>,
        <>也可以通过单独的规则查看被限流的键（Throttled key）— 需按表启用 Contributor Insights。</>,
      ]},
    ],
    priorityHeader: ['指标', '告警标准', '含义'],
    priority: [
      ['ReadThrottleEvents / WriteThrottleEvents', '持续 > 0', '容量不足或热分区'],
      ['SystemErrors', '突增', '服务端异常'],
      ['ConsumedRCU/WCU vs Provisioned', '接近/超出', '容量余量不足'],
      ['SuccessfulRequestLatency', '突增', '访问模式/性能问题'],
      ['ConditionalCheckFailedRequests', '高于预期', '竞争或逻辑问题'],
      ['ReplicationLatency (Global Tables)', '呈上升趋势', '跨区域复制延迟'],
    ],
  },
  ElastiCache: {
    service: 'ElastiCache',
    intro: (
      <>不同引擎（Redis/Valkey 与 Memcached）的指标有所差异，但共同点是查看 <b>CPU · 内存 · 连接 ·
      性能（命中率/延迟）· 引擎特有指标</b>这几类。下文以 Redis/Valkey 为准。</>
    ),
    sections: [
      { title: '① CPU', items: [
        <><b>EngineCPUUtilization</b> — 在 Redis/Valkey 中最重要。主命令处理实际上是<b>单线程</b>的，因此即使单核已经饱和，CPUUtilization（所有 vCPU 的平均值）看起来也可能不高，但实际上已是瓶颈。</>,
        <><b>CPUUtilization</b> — 节点整体。<b>Memcached 是多线程的，看这个指标才有效。</b></>,
        <>EngineCPU 持续偏高 → 怀疑存在慢命令（O(N)：KEYS、大体量 HGETALL、大型 SORT），或考虑扩展分片。</>,
      ]},
      { title: '② 内存 — 诊断核心', items: [
        <><b>DatabaseMemoryUsagePercentage</b> — 相对 maxmemory 的使用率，是<b>最重要的告警指标</b>。可结合 FreeableMemory / BytesUsedForCache 一起看。</>,
        <><b>SwapUsage</b> — 一旦变大就很危险（换页到磁盘 → 延迟骤增）。</>,
        <><b>Evictions</b> — 内存占满导致键被强制驱逐。持续发生时应扩容节点、增加分片或重新审视 maxmemory-policy。<b>Reclaimed</b>（TTL 到期清除）属于正常行为。</>,
      ]},
      { title: '③ 性能 — 命中率与延迟', items: [
        <><b>CacheHitRate</b>（或 CacheHits/CacheMisses）— 衡量缓存价值的核心。偏低说明 TTL 过短 / 缓存键设计有问题 / 冷缓存。</>,
        <>按命令族的延迟指标（StringBasedCmdsLatency、GetType/SetType/HashBasedCmdsLatency…）可分解出哪类命令慢，并结合 SuccessfulRead/WriteRequestLatency 一起看。</>,
      ]},
      { title: '④ 连接', items: [
        <><b>CurrConnections</b> — 对照 maxclients 检查。<b>NewConnections</b> 突增 = 怀疑未使用连接池/重连风暴（建连成本很高）。<b>CurrItems</b> 表示条目数。</>,
      ]},
      { title: '⑤ 网络与吞吐量', items: [
        <>NetworkBytesIn/Out、<b>NetworkBandwidthIn/OutAllowanceExceeded</b> — 超出实例类型的网络上限，是<b>容易被忽视的瓶颈</b>。ConnTrack/PPS 的 AllowanceExceeded 同理。</>,
        <><b>ReplicationBytes / ReplicationLag</b> — 只读副本的复制延迟。</>,
      ]},
      { title: '⑥ 引擎特有（Redis/Valkey）', items: [
        <>KeyspaceHits/Misses、SaveInProgress、BytesUsedForCache。追踪慢命令时可配合 Redis 的 {code('SLOWLOG')}。</>,
        <>若为集群模式，按分片/节点分解，找出<b>热分片</b>。</>,
      ]},
      { title: '按症状的诊断路径', items: [
        <>延迟上升 + 整体 CPU 不高 → 检查 <b>EngineCPUUtilization + SLOWLOG</b>。</>,
        <>间歇性性能下降 + Evictions → 重新审视<b>内存不足 / TTL 与驱逐策略</b>。</>,
        <>原因不明的延迟 + 流量偏大 → 检查 <b>Network...AllowanceExceeded</b> 是否触到带宽上限。</>,
        <>命中率低 → 重新审视<b>缓存键设计与 TTL</b>。</>,
      ]},
    ],
    priorityHeader: ['指标', '告警标准', '含义'],
    priority: [
      ['EngineCPUUtilization', '> 90% (Redis)', '单线程饱和/慢命令'],
      ['DatabaseMemoryUsagePercentage', '偏高', '内存压力'],
      ['Evictions', '持续 > 0', '内存不足 → 键被驱逐'],
      ['SwapUsage', '上升', '性能骤降风险'],
      ['CacheHitRate', '偏低', '缓存效用下降'],
      ['CurrConnections', '接近 max', '连接耗尽'],
      ['Network...AllowanceExceeded', '> 0', '网络上限瓶颈'],
      ['ReplicationLag', '呈上升趋势', '复制延迟'],
    ],
  },
  OpenSearch: {
    service: 'OpenSearch',
    intro: (
      <>OpenSearch 的诊断重点是<b>集群状态 · JVM/内存 · 存储 · 搜索/索引性能 · 线程池队列</b>
      （以托管的 OpenSearch Service 与其 CloudWatch 指标为准）。</>
    ),
    sections: [
      { title: '① 集群状态 — 第一优先检查项', items: [
        <><b>ClusterStatus.green/yellow/red</b> — <b>red 必须立即处理</b>：主分片未分配（数据不可访问）。yellow 表示副本分片未分配（可用性下降，但数据仍可访问）。</>,
        <><b>Nodes</b> — 与预期值不符说明有节点脱离或故障。</>,
        <><b>ClusterIndexWritesBlocked</b> — 值为 1 = 写入被阻断（磁盘不足/JVM 压力/red 等原因）。<b>非常重要的告警指标。</b></>,
      ]},
      { title: '② JVM 内存压力 — 诊断的核心', items: [
        <><b>JVMMemoryPressure</b>（新版为 OldGenJVMMemoryPressure）— 最重要。<b>超过 80% 时频繁 GC 导致性能下降</b>，持续在 92% 以上时保护机制可能会阻断写入。</>,
        <><b>JVMGCYoung/OldCollectionCount·Time</b> — Old GC 又频繁又耗时说明堆压力严重。</>,
        <>压力偏高时 → 怀疑分片数过多（过度分片）、大型聚合查询、字段数据缓存过大，或需要扩容节点。</>,
      ]},
      { title: '③ CPU', items: [
        <><b>CPUUtilization</b>（数据节点）/ <b>MasterCPUUtilization</b>（专用主节点 — 饱和时分片分配和集群状态更新会变慢）/ WarmCPUUtilization（UltraWarm）。</>,
      ]},
      { title: '④ 存储', items: [
        <><b>FreeStorageSpace</b> — 各节点的剩余磁盘。<b>最常见的故障原因。</b>一旦触到磁盘水位线（low 85% / high 90% / flood 95%），会触发分片迁移或写入阻断。</>,
        <>ClusterUsedSpace、<b>DiskQueueDepth</b>（I/O 排队）、Read/WriteLatency·Throughput（EBS）。</>,
      ]},
      { title: '⑤ 搜索与索引性能', items: [
        <><b>SearchRate / SearchLatency</b>、<b>IndexingRate / IndexingLatency</b> — 延迟出现尖峰时怀疑重查询、过度分片或资源饱和。</>,
      ]},
      { title: '⑥ 线程池队列与拒绝 — 负载饱和信号', items: [
        <><b>ThreadpoolSearchQueue / ThreadpoolWriteQueue</b> — 队列堆积说明处理已经滞后。</>,
        <><b>ThreadpoolSearchRejected / ThreadpoolWriteRejected</b> — 队列已满导致请求被拒绝。<b>大于 0 意味着客户端正在收到错误 → 立即排查。</b>这是容量不足或查询低效的强烈信号。CoordinatingWriteRejected、PrimaryWriteRejected 属于写入背压。</>,
      ]},
      { title: '⑦ 其他常看项', items: [
        <><b>MasterReachableFromNode</b>（1 为正常）、<b>AutomatedSnapshotFailure</b>（备份失败）、<b>KMSKeyError/KMSKeyInaccessible</b>（值为 1 时集群有无法访问的风险）。</>,
        <>5xx/4xx/2xx HTTP 状态码、InvalidHostHeaderRequests、ThroughputThrottle/IopsThrottle（gp3）。</>,
      ]},
      { title: '按症状的诊断路径', items: [
        <>集群 red/yellow → 排查分片分配失败的原因（磁盘水位线、节点脱离）。</>,
        <>间歇性请求失败（429/拒绝）→ 检查 <b>Threadpool...Rejected + JVM 压力</b>。</>,
        <>搜索延迟骤增 → 排查重查询、过度分片（分片数相对数据量）与资源饱和。</>,
        <>写入被阻断 → 综合查看 <b>ClusterIndexWritesBlocked + FreeStorageSpace + JVMMemoryPressure</b>。</>,
        <>CloudWatch 抓不到的细粒度原因（特定索引/分片/查询）用自身 API 排查：{code('_cluster/health')}、{code('_cat/indices?v')}、{code('_cat/shards')}、{code('_nodes/stats')}，以及 Slow logs / Error logs。</>,
      ]},
    ],
    priorityHeader: ['指标', '告警标准', '含义'],
    priority: [
      ['ClusterStatus.red', '= 1', '主分片未分配（数据不可用）'],
      ['ClusterIndexWritesBlocked', '= 1', '写入被阻断'],
      ['JVMMemoryPressure', '> 80%', '堆压力 → GC/性能下降'],
      ['FreeStorageSpace', '接近水位线', '磁盘耗尽'],
      ['Threadpool...Rejected', '> 0', '请求被拒绝（饱和）'],
      ['MasterCPUUtilization', '偏高', '主节点瓶颈'],
      ['SearchLatency/IndexingLatency', '突增', '查询/索引性能'],
      ['AutomatedSnapshotFailure', '= 1', '备份失败'],
    ],
  },
  ALB: {
    service: 'ALB',
    intro: (
      <>ALB 的诊断重点是 <b>HTTP 响应码 · 延迟 · 连接/请求数 · 目标健康状况 · 容量（LCU）</b>。
      尤其要<b>区分"负载均衡器自身产生的错误"（HTTPCode_ELB_*）与"目标产生的错误"（HTTPCode_Target_*）</b>
      — 这是诊断的出发点。</>
    ),
    sections: [
      { title: '① HTTP 响应码 — 诊断的核心', items: [
        <><b>HTTPCode_ELB_5XX_Count</b> — ALB 自身生成的 5xx（请求没到达目标，或没收到响应）。按 502/503/504 细分即可缩小原因范围。</>,
        <><b>502</b>（Bad Gateway）— 目标返回畸形响应或连接被断开。<b>最常见的故障。</b><b>503</b> — 没有健康的目标（全部 unhealthy），非常重要。<b>504</b> — 在 idle timeout 内未能响应，是后端变慢的信号。</>,
        <><b>HTTPCode_Target_5XX_Count</b> — 后端应用错误。Target_2XX/3XX 则是正常流量的基线。</>,
        <><b>关键区分</b>：ELB_5XX 上升 = LB 与目标之间的连接/健康问题，Target_5XX 上升 = 应用代码问题。</>,
      ]},
      { title: '② 延迟（Latency）', items: [
        <><b>TargetResponseTime</b> — 最重要。必须<b>以 p50/p90/p99 分位数</b>来看（平均值会掩盖长尾）。突增 = 后端性能劣化。</>,
      ]},
      { title: '③ 请求与连接数', items: [
        <><b>RequestCount</b>（流量基线）、<b>ActiveConnectionCount</b>、<b>NewConnectionCount</b>（发现 TLS 重新协商风暴）。</>,
        <><b>RejectedConnectionCount</b> — ALB 达到最大连接上限。<b>大于 0 就是容量问题。</b></>,
        <><b>Client/TargetTLSNegotiationErrorCount</b> — TLS 协商失败。</>,
      ]},
      { title: '④ 目标健康状况 — 可用性（须按目标组维度查看才有意义）', items: [
        <><b>HealthyHostCount</b> — 趋近 0 即危险，为 0 时会出现 503。</>,
        <><b>UnHealthyHostCount</b> — 上升时排查健康检查失败的原因（应用崩溃、健康检查路径错误、启动过慢）。</>,
      ]},
      { title: '⑤ 容量 / 限流', items: [
        <><b>ConsumedLCUs</b>（计费与容量核算，用于发现突增）、ProcessedBytes。</>,
        <><b>TargetConnectionErrorCount</b> — ALB→目标连接失败。是网络/安全组/目标端口问题的信号。</>,
      ]},
      { title: '⑥ 其他场景指标', items: [
        <><b>RequestCountPerTarget</b> — 发现负载分配不均。HTTP_Redirect/Fixed_Response_Count。</>,
        <>DesyncMitigationMode_NonCompliant_Request_Count（HTTP desync 风险）、GrpcRequestCount（gRPC）。</>,
      ]},
      { title: '按症状的诊断流程', items: [
        <>502 激增 → 排查目标应用崩溃/连接被提前关闭，以及 <b>keep-alive 超时不匹配</b>（ALB idle timeout &gt; 后端 keep-alive 时会发生）。</>,
        <>503 激增 → 检查 <b>HealthyHostCount</b>，排查健康检查失败原因。</>,
        <>504 激增 → 后端变慢（TargetResponseTime）+ 检查 ALB idle timeout 设置。</>,
        <>间歇性 5xx 但 Target 全是 2xx → LB 层面问题：检查 <b>RejectedConnectionCount / TargetConnectionErrorCount</b>。</>,
        <>原因不明 → 用<b>访问日志（S3）</b>逐请求分解 elb_status_code 与 target_status_code、request/target/response_processing_time — 精确区分延迟出在 LB 排队还是后端。</>,
      ]},
    ],
    priorityHeader: ['指标', '告警标准', '含义'],
    priority: [
      ['HTTPCode_ELB_5XX_Count', '突增', 'LB↔目标问题（按 502/503/504 细分）'],
      ['HTTPCode_Target_5XX_Count', '突增', '后端应用错误'],
      ['TargetResponseTime (p99)', '突增', '后端性能劣化'],
      ['HealthyHostCount', '偏低/0', '可用目标不足 → 503'],
      ['UnHealthyHostCount', '> 0', '健康检查失败'],
      ['RejectedConnectionCount', '> 0', '达到连接上限'],
      ['TargetConnectionErrorCount', '> 0', '目标连接失败（网络/SG）'],
    ],
  },
  NLB: {
    service: 'NLB',
    intro: (
      <>NLB 工作在 <b>L4（TCP/UDP/TLS）</b>层，视角与 ALB 不同 — 没有 HTTP 响应码，
      主要围绕<b>连接（流）· 重置（RST）· 目标健康状况 · 吞吐量 · 容量（LCU）</b>展开。
      由于 CloudWatch 指标较为有限，<b>RST 计数与目标健康状况是诊断的核心</b>。</>
    ),
    sections: [
      { title: '① 连接（流）数', items: [
        <><b>ActiveFlowCount</b> — 活跃流数（以 TCP 计）。通过突增/骤降发现流量异常。<b>NewFlowCount</b> 表示建连速率。</>,
        <>按协议分解：ActiveFlowCount_TCP/_UDP/_TLS、NewFlowCount_TCP/_UDP/_TLS。<b>ConsumedLCUs</b>（_TCP/_UDP/_TLS）用于容量与计费核算。</>,
      ]},
      { title: '② 重置（RST）— NLB 诊断的核心', items: [
        <><b>TCP_Target_Reset_Count</b> — 目标发出的 RST：后端主动断开连接（应用崩溃、端口关闭、backlog 溢出）。<b>激增 = 后端问题的强烈信号。</b></>,
        <><b>TCP_ELB_Reset_Count</b> — NLB 生成的 RST：超过空闲超时等原因。<b>TCP_Client_Reset_Count</b> — 来自客户端。</>,
        <><b>关键区分</b>：Target RST 激增 → 后端问题；ELB RST 激增 → NLB 层面（多为 <b>idle timeout 350 秒</b>）或非对称路由。</>,
      ]},
      { title: '③ 目标健康状况 — 可用性（按目标组维度）', items: [
        <><b>HealthyHostCount</b>（趋近 0 即危险）/ <b>UnHealthyHostCount</b>（上升时排查健康检查失败原因）。</>,
        <>NLB 混合了主动健康检查（TCP/HTTP/HTTPS）与自身判断 — 目标组的健康检查配置（协议/端口/路径）也要一并核对。</>,
      ]},
      { title: '④ 吞吐量与字节数', items: [
        <><b>ProcessedBytes</b>（_TCP/_UDP/_TLS）、ProcessedPackets。</>,
      ]},
      { title: '⑤ TLS（使用 TLS 监听器时）', items: [
        <><b>Client/TargetTLSNegotiationErrorCount</b>、TLSNegotiationErrorCount — 协商失败。</>,
      ]},
      { title: '⑥ 容量上限与其他', items: [
        <><b>PortAllocationErrorCount</b> — 保留客户端 IP + PrivateLink/SNAT 场景下的源端口耗尽。<b>大于 0 表示正在发生连接失败 — 容易被忽视的原因。</b></>,
        <>PeakPackets/BytesPerSecond、<b>UnhealthyRoutingFlowCount</b>（没有健康目标导致路由失败 — 与 fail-open 相关）。</>,
      ]},
      { title: '按症状的诊断流程', items: [
        <>间歇性断连 → 区分 <b>Target RST（后端）与 ELB RST（超出 idle timeout 350 秒）</b>，并检查 keep-alive 设置。</>,
        <>完全连不上 → 检查 HealthyHostCount + 安全组/NACL/目标端口。<b>NLB 会保留客户端 IP，因此目标安全组必须放行客户端 IP — 常见陷阱。</b></>,
        <>高负载时连接失败 → 检查 <b>PortAllocationErrorCount</b>（SNAT 端口耗尽）。</>,
        <>TLS 监听器报错 → Client/TargetTLSNegotiationErrorCount。</>,
      ]},
      { title: '与 ALB 不同的注意点', items: [
        <>由于是 L4，<b>看不到应用层的延迟/错误</b> — HTTP 问题要靠目标（后端）的指标和日志。</>,
        <><b>VPC Flow Logs</b> 对排障非常有用（连接接受/拒绝、客户端 IP 追踪）。NLB 自身的访问日志<b>仅在 TLS 监听器下</b>提供。</>,
        <>因为保留客户端 IP 的特性，<b>目标安全组规则</b>经常是问题根源。</>,
      ]},
    ],
    priorityHeader: ['指标', '告警标准', '含义'],
    priority: [
      ['HealthyHostCount', '偏低/0', '可用目标不足'],
      ['UnHealthyHostCount', '> 0', '健康检查失败'],
      ['TCP_Target_Reset_Count', '突增', '后端重置连接'],
      ['TCP_ELB_Reset_Count', '突增', 'NLB 重置（idle timeout 等）'],
      ['PortAllocationErrorCount', '> 0', 'SNAT 源端口耗尽'],
      ['ActiveFlowCount', '趋势异常', '流量/连接异常'],
      ['TargetTLSNegotiationErrorCount', '> 0', '目标 TLS 问题'],
    ],
  },
  S3: {
    service: 'S3',
    intro: (
      <>S3 是可无限扩展的托管存储，不存在"容量耗尽"的概念，诊断的重点在于<b>存储用量 ·
      请求性能/错误 · 复制 · 数据保护</b>。需要注意 CloudWatch 指标分为两类：<b>存储指标（免费，
      每日一次）</b>与<b>请求指标（收费，1 分钟粒度 — 必须按桶/前缀启用后才存在）</b>。</>
    ),
    sections: [
      { title: '① 存储指标（默认，免费 — 每日汇总一次）', items: [
        <><b>BucketSizeBytes</b> — 按存储类别（StandardStorage/StandardIAStorage/GlacierStorage…）分解后，才对成本与生命周期诊断有用。</>,
        <><b>NumberOfObjects</b> — 通过突增/骤降发现异常，并用于估算请求成本。因为每天只汇总一次，不适合实时用途，属于<b>趋势与成本视角</b>。</>,
      ]},
      { title: '② 请求指标（需启用，1 分钟粒度）— 性能诊断核心', items: [
        <><b>4xxErrors</b> — 403 权限/404 路径等。突增时排查策略或键路径问题。<b>5xxErrors</b> — 500/503 SlowDown，属于 S3 侧问题或请求速率超限。</>,
        <><b>503 SlowDown</b> — 超过单前缀请求速率上限（<b>每前缀每秒 3,500 写 / 5,500 读</b>）= 热前缀信号。</>,
        <>区分 <b>FirstByteLatency</b>（S3 处理耗时）与 <b>TotalRequestLatency</b>（端到端 — 对象大时自然偏高）。</>,
        <>AllRequests/Get/Put/Delete/Head/List、BytesDownloaded/Uploaded — 流量基线。</>,
      ]},
      { title: '③ 复制（使用 CRR/SRR 时）', items: [
        <><b>ReplicationLatency</b> — 使用 RTC 时对照 SLA（15 分钟）。<b>BytesPendingReplication / OperationsPendingReplication</b> 持续上升 = 复制瓶颈。</>,
        <><b>OperationsFailedReplication</b> — 大于 0 时排查权限/配置问题。</>,
      ]},
      { title: '④ 数据保护、生命周期与其他', items: [
        <><b>Storage Lens</b> — 账户/组织级的全局可见性：诊断未完成的分段上传、非当前版本堆积等低效问题的核心工具。</>,
        <>S3 Storage Class Analysis — 用于生命周期优化诊断。</>,
      ]},
      { title: '按症状的诊断流程', items: [
        <>间歇性 503 SlowDown → <b>热前缀</b>：把键名空间按前缀打散（随机/哈希），并用按前缀的请求指标确认哪个前缀过热。</>,
        <>403 激增 → 检查桶策略/IAM/ACL/Block Public Access/KMS 密钥权限。用 <b>CloudTrail 数据事件</b>追踪被拒绝的主体与操作。</>,
        <>延迟骤增 → 区分 FirstByteLatency 与 TotalRequestLatency（S3 处理 vs 对象大小/网络）。评估 Transfer Acceleration、分段上传与区域就近性。</>,
        <>复制延迟/失败 → OperationsPendingReplication 趋势 + OperationsFailedReplication + 复制规则/权限。</>,
        <>不明访问/删除 → 用<b>服务器访问日志 / CloudTrail 数据事件</b>逐请求分解（请求者、操作、响应码、延迟）。</>,
      ]},
      { title: 'S3 的特殊之处', items: [
        <>实时性能诊断<b>必须先开启请求指标</b>（默认关闭，收费）— 不开启就看不到 4xx/5xx/Latency（下表中的 '—'）。</>,
        <>单个请求的追踪不靠 CloudWatch，而是<b>服务器访问日志 / CloudTrail 数据事件</b>的职责。</>,
        <>成本与生命周期优化的核心工具是 <b>Storage Lens</b>。</>,
      ]},
    ],
    priorityHeader: ['指标', '告警标准', '含义'],
    priority: [
      ['5xxErrors', '突增', 'S3 侧错误或请求速率超限（503 SlowDown）'],
      ['4xxErrors', '突增', '权限/路径/请求错误'],
      ['FirstByteLatency', '突增', 'S3 处理延迟'],
      ['OperationsFailedReplication', '> 0', '复制失败'],
      ['ReplicationLatency', '超出 SLA', '复制延迟'],
      ['BucketSizeBytes', '异常激增', '成本/异常上传'],
      ['NumberOfObjects', '异常激增/骤降', '大量删除/创建'],
    ],
  },
  EBS: {
    service: 'EBS',
    intro: (
      <>EBS 的诊断围绕 <b>IOPS · 吞吐量 · 延迟 · 队列深度 · 突发/性能积分</b>展开。关键在于
      <b>区分瓶颈是卷触到了自身预置的性能上限，还是实例侧的 EBS 带宽上限</b>
      — 二者是相互独立的限制。</>
    ),
    sections: [
      { title: '① IOPS（操作数）', items: [
        <><b>VolumeReadOps / VolumeWriteOps</b> — 原始值是周期内合计，<b>必须除以周期秒数才是 IOPS</b>（5 分钟汇总则 /300）。对照预置 IOPS（gp3/io1/io2）或 baseline（gp2 = 3 IOPS/GB）检查。</>,
        <>合计 IOPS 贴着预置上限运行 → 瓶颈在卷本身。</>,
      ]},
      { title: '② 吞吐量（Throughput）', items: [
        <><b>VolumeReadBytes / VolumeWriteBytes</b> — 换算成 MB/s 后对照吞吐量上限。<b>gp3 的 IOPS 与吞吐量是独立预置的</b>，两项必须分别检查。</>,
      ]},
      { title: '③ 延迟（Latency）— 判断 I/O 瓶颈', items: [
        <><b>VolumeTotalRead/WriteTime</b> — 单次操作平均延迟 = <b>TotalTime / Ops</b>。</>,
        <>延迟偏高但 IOPS/吞吐量未达上限 → 可能是 I/O 尺寸偏大或随机访问模式的问题。</>,
      ]},
      { title: '④ 队列深度 — 饱和信号', items: [
        <><b>VolumeQueueLength</b> — 排队等待的 I/O 请求数。<b>最直观的饱和指标。</b>持续偏高说明卷已跟不上请求（通常伴随延迟骤增）。</>,
      ]},
      { title: '⑤ 空闲与利用率', items: [
        <>VolumeIdleTime、<b>VolumeThroughputPercentage</b>（仅 io1/io2 — 实际达成相对预置的比例，持续低于 100% = 性能未达标）、VolumeConsumedReadWriteOps。</>,
      ]},
      { title: '⑥ 突发/性能积分 — 容易被忽视的瓶颈', items: [
        <><b>BurstBalance</b> — gp2·st1·sc1 专用的积分余量（%）。趋近 0 时被降级到 baseline → 间歇性性能下降。<b>gp2 不明原因性能劣化的常见元凶。</b></>,
        <>gp3/io1/io2 没有突发概念 — 很多情况下<b>迁移 gp2→gp3 即可解决</b>。</>,
      ]},
      { title: '⑦ 实例级 — EBS 带宽上限', items: [
        <>卷本身很空闲却仍然慢 → 怀疑实例侧：<b>EBSIOBalance% / EBSByteBalance%</b>（小型实例的 EBS 突发余量）— 趋近 0 时被降到实例 baseline → <b>卷再大也照样是瓶颈。</b></>,
        <>EBSRead/WriteOps·Bytes — 对照实例类型的 EBS 带宽上限检查。</>,
      ]},
      { title: '按症状的诊断流程', items: [
        <>间歇性/周期性性能下降 → <b>BurstBalance（gp2）或 EBSIOBalance%（小型实例）积分耗尽</b> — EBS 性能问题的头号原因。</>,
        <>延迟偏高 + IOPS/吞吐量未达上限 → I/O 尺寸与随机性，或实例带宽问题。把 VolumeQueueLength 与实例 EBS balance 一起看。</>,
        <>卷很空闲却慢 → 检查实例的 EBSByte/IOBalance% + 实例类型 EBS 上限（可能需要升级实例类型）。</>,
        <>IOPS 贴着预置上限 → 上调 gp3 IOPS/吞吐量、转 io2、分散到多卷（RAID 0）或引入应用层缓存。</>,
      ]},
      { title: 'EBS 特有的注意点', items: [
        <>CloudWatch 原始值是<b>周期合计 — 必须换算才能得到真实 IOPS/延迟</b>。</>,
        <>gp2 的 3 IOPS/GB baseline + 突发模型 → <b>小容量 gp2 卷的积分耗尽</b>是老生常谈的原因。通常转 gp3 就是答案。</>,
        <><b>卷性能与实例 EBS 带宽是两个独立的上限</b> — 两边都要看才能精准定位瓶颈。</>,
      ]},
    ],
    priorityHeader: ['指标', '告警标准', '含义'],
    priority: [
      ['VolumeQueueLength', '持续偏高', '卷饱和（I/O 排队）'],
      ['BurstBalance (gp2/st1/sc1)', '趋近 0', '积分耗尽 → 降级到 baseline'],
      ['平均延迟 (TotalTime/Ops)', '突增', 'I/O 瓶颈'],
      ['VolumeReadOps+WriteOps (换算 IOPS)', '接近预置值', 'IOPS 上限'],
      ['VolumeThroughputPercentage (io1/io2)', '< 100%', '未达预置性能'],
      ['EBSIOBalance%/EBSByteBalance%', '趋近 0', '实例 EBS 带宽降级'],
    ],
  },
  EC2: {
    service: 'EC2',
    intro: (
      <>EC2 基础诊断项为 <b>CPU · 网络 · EBS I/O · 状态检查（status check）· 突发型积分</b>。
      最重要的特殊点：<b>内存和磁盘使用率不在默认 CloudWatch 指标中</b>
      （虚拟化管理层看不到 OS 内部）— 这两项必须安装 CloudWatch Agent 才能获取。</>
    ),
    sections: [
      { title: '① CPU', items: [
        <><b>CPUUtilization</b> — 持续超过 80% 时评估扩容或更换实例类型。这是 hypervisor 视角，看不到 vCPU steal 等客户机内部情况。</>,
        <><b>CPUCreditBalance / CPUCreditUsage</b> — T 系列专用。趋近 0 时被降级到 baseline（Standard）或产生额外费用（Unlimited）。<b>不明原因性能下降的常见元凶。</b>CPUSurplusCreditsCharged 是 Unlimited 模式下的超额计费。</>,
      ]},
      { title: '② 状态检查（Status Checks）— 可用性诊断核心', items: [
        <><b>StatusCheckFailed_System</b> — AWS 基础设施问题（宿主机硬件/网络/电源）。处置：<b>stop/start</b>（迁移到其他宿主机）。</>,
        <><b>StatusCheckFailed_Instance</b> — 实例内部问题（OS 启动/文件系统/网络配置/内核）。处置：排查 OS 或重启。</>,
        <><b>StatusCheckFailed_AttachedEBS</b> — 挂载的 EBS 无法响应 I/O。</>,
        <>这一区分能立即回答<b>"是 AWS 的问题还是我的 OS 的问题"</b>。自动恢复可用 CloudWatch 告警 + EC2 auto-recovery。</>,
      ]},
      { title: '③ 网络', items: [
        <><b>NetworkIn/Out</b>（对照带宽上限）、<b>NetworkPacketsIn/Out</b>（发现 PPS 上限）。</>,
        <>带宽/PPS/conntrack 超限不会出现在默认指标里 — 必须借助<b>网络性能指标（ethtool、CloudWatch Agent）</b>的 bw_in/out_allowance_exceeded、pps_allowance_exceeded、conntrack_allowance_exceeded 才准确。<b>容易被忽视的瓶颈。</b></>,
      ]},
      { title: '④ EBS I/O（实例视角）', items: [
        <>EBSRead/WriteOps·Bytes — 实例↔EBS 的 I/O。</>,
        <><b>EBSIOBalance% / EBSByteBalance%</b> — 小型实例的 EBS 突发余量。趋近 0 时实例被降到 baseline → <b>卷再大也照样是瓶颈</b>（与 EBS 诊断相衔接）。</>,
      ]},
      { title: '⑤ 需要 CloudWatch Agent（默认不提供）— 实际运维必备', items: [
        <><b>内存</b>（mem_used_percent 等）— EC2 性能问题相当一部分出在内存，但默认指标里没有。</>,
        <><b>磁盘</b>（disk_used_percent、diskio_*）— 发现根卷/数据卷耗尽。<b>Swap</b>（swap_used_percent）、客户机视角的 CPU（含 steal）、进程级指标。</>,
        <>要做精细诊断，安装 CloudWatch Agent 几乎是必选项。</>,
      ]},
      { title: '按症状的诊断流程', items: [
        <>实例无响应 → <b>先看状态检查</b>：System 失败是 AWS 侧（stop/start 迁移），Instance 失败则排查 OS（系统日志/截图）。</>,
        <>间歇性/周期性性能下降 → T 系列首查 <b>CPUCreditBalance 耗尽</b>，其次是 EBSIOBalance%。</>,
        <>CPU 不高却很慢 → 检查内存/Swap（Agent）、磁盘 I/O、网络 allowance 是否超限。</>,
        <>网络吞吐量上不去 → 对照实例类型带宽上限 + 检查 *_allowance_exceeded，评估升级实例类型。</>,
      ]},
      { title: 'EC2 特有的注意点', items: [
        <><b>内存和磁盘不在默认指标中 → 必须装 CloudWatch Agent。</b>这就是"为什么没有内存指标？"的答案。</>,
        <>状态检查 <b>System vs Instance</b> 的区分 = 立即划清责任归属（AWS vs 用户）的核心诊断点。</>,
        <>突发型（T 系列）积分和小型实例的 EBS/网络突发是不明原因性能问题的常客 — 只要是 T 系列或小型实例就要优先怀疑。</>,
        <>深入排查：CloudWatch Logs、EC2 系统日志/截图、Compute Optimizer（合理化选型）。</>,
      ]},
    ],
    priorityHeader: ['指标', '告警标准', '含义'],
    priority: [
      ['StatusCheckFailed_System', '= 1', 'AWS 基础设施问题 → stop/start'],
      ['StatusCheckFailed_Instance', '= 1', 'OS/实例内部问题'],
      ['CPUUtilization', '持续 > 80%', '计算瓶颈'],
      ['CPUCreditBalance (T 系列)', '趋近 0', '积分耗尽 → 降级/计费'],
      ['mem_used_percent (Agent)', '偏高', '内存压力'],
      ['disk_used_percent (Agent)', '> 85%', '磁盘耗尽'],
      ['EBSIOBalance%/EBSByteBalance%', '趋近 0', 'EBS 带宽降级'],
      ['bw/pps/conntrack_allowance_exceeded (Agent)', '> 0', '网络上限瓶颈'],
    ],
  },
  Lambda: {
    service: 'Lambda',
    intro: (
      <>Lambda 的诊断围绕<b>调用 · 错误 · 限流 · 执行时长 · 并发</b>展开。因为是无服务器架构，
      没有基础设施层指标，重点集中在每次执行的成功/失败/延迟/容量上。</>
    ),
    sections: [
      { title: '① 调用与错误 — 诊断的出发点', items: [
        <><b>Invocations</b>（流量基线）、<b>Errors</b>（处理函数异常、超时）。<b>错误率 = Errors / Invocations</b> 才有意义 — 只看绝对值无法区分是不是流量增长导致的。</>,
        <><b>DeadLetterErrors</b> — DLQ 投递失败（异步调用）。大于 0 时失败事件可能正在丢失。<b>DestinationDeliveryFailures</b> 同理。</>,
      ]},
      { title: '② 限流 — 并发上限', items: [
        <><b>Throttles</b> — 超出并发限额的 429。<b>最常见的扩展性问题。</b>原因：账户区域限额（默认 1,000）、reserved concurrency 配置、突发流量。</>,
      ]},
      { title: '③ 执行时长（Duration）', items: [
        <><b>Duration</b> — 用 <b>p50/p90/p99 分位数</b>来看（平均值会掩盖冷启动和长尾）。<b>接近超时设置值</b>时有超时错误风险。</>,
        <>PostRuntimeExtensionsDuration — 检查扩展（extension）带来的开销。</>,
      ]},
      { title: '④ 并发（Concurrency）', items: [
        <><b>ConcurrentExecutions</b> — 对照账户/函数限额。接近上限时限流在即。UnreservedConcurrentExecutions 是扣除 reserved 后的共享池。</>,
      ]},
      { title: '⑤ 预置并发（PC）', items: [
        <><b>ProvisionedConcurrencyUtilization</b> 接近 100% = PC 不足。<b>ProvisionedConcurrencySpilloverInvocations &gt; 0</b> = 超出 PC 的部分正溢出到 on-demand 冷启动。</>,
      ]},
      { title: '⑥ 按事件源（流/队列）', items: [
        <><b>IteratorAge</b> — 消费 Kinesis/DynamoDB Streams 的核心指标。持续增长说明 Lambda 跟不上生产者 → 调整批大小/ParallelizationFactor/函数性能。</>,
        <><b>OffsetLag</b>（Kafka/MSK 源）；SQS 场景结合 ApproximateAgeOfOldestMessage；异步场景看 AsyncEventsReceived/Age/Dropped。</>,
      ]},
      { title: '⑦ 冷启动', items: [
        <>没有直接指标 — 通过 CloudWatch Logs 的 <b>INIT_START / Init Duration</b> 或 X-Ray 确认。结合 Duration p99 突增 + PC 溢出一起诊断。</>,
      ]},
      { title: '按症状的诊断流程', items: [
        <>429 被拒 → <b>Throttles + ConcurrentExecutions 对照限额</b>。上调 reserved/申请提升账户限额/平滑突发流量。</>,
        <>间歇性变慢 → <b>Duration p99 + Init Duration</b>（日志）。引入 PC、<b>上调内存（Lambda 中内存↑=CPU↑）</b>、精简部署包。</>,
        <>错误率上升 → 查日志中的异常堆栈。若是超时，确认 Duration 是否贴着设置值。</>,
        <>流消费积压 → IteratorAge 持续增长 → 排查批量/并行度/函数性能/下游瓶颈。</>,
        <>异步事件丢失 → DeadLetterErrors / AsyncEventsDropped + 核对 DLQ 配置。</>,
      ]},
      { title: 'Lambda 特有的注意点', items: [
        <><b>内存配置即性能</b> — 内存↑=CPU·网络↑，Duration 可能随之下降。用 Max Memory Used（日志报告）做合理化配置，<b>Lambda Power Tuning</b> 很有用。</>,
        <>错误率务必<b>以相对 Invocations 的比例</b>来看。</>,
        <>深入诊断：<b>CloudWatch Logs Insights</b>（聚合错误模式、Init Duration、Max Memory Used）+ <b>X-Ray</b>（分解冷启动与下游耗时）。开启 <b>Lambda Insights</b> 还能拿到执行环境的 CPU/内存/网络指标。</>,
      ]},
    ],
    priorityHeader: ['指标', '告警标准', '含义'],
    priority: [
      ['Errors (错误率)', '突增', '异常/超时'],
      ['Throttles', '> 0', '超出并发限额（429）'],
      ['Duration (p99)', '接近超时值', '性能下降/超时风险'],
      ['ConcurrentExecutions', '接近限额', '限流在即'],
      ['IteratorAge (流)', '呈上升趋势', '消费者处理滞后'],
      ['ProvisionedConcurrencySpilloverInvocations', '> 0', 'PC 不足 → 冷启动'],
      ['DeadLetterErrors', '> 0', '失败事件丢失风险'],
    ],
  },
  EKS: {
    service: 'EKS',
    intro: (
      <>EKS 的层次比其他服务更多 — 需要按<b>控制平面（API Server/etcd）· 节点（Worker）· Pod/工作负载 ·
      扩缩容</b>逐层排查，而且指标来源也不只是 CloudWatch 一处，还包括 <b>Container Insights ·
      控制平面日志 · Prometheus/kube-state-metrics</b> 等多个渠道。</>
    ),
    sections: [
      { title: '先理清指标来源', items: [
        <>EKS 控制平面 → CloudWatch 控制平面日志 + 部分 CloudWatch 指标（本仪表盘：{code('AWS/EKS')} 命名空间）。</>,
        <>节点/Pod/容器 → <b>CloudWatch Container Insights</b>（需要安装代理）或 Prometheus（本仪表盘：{code('ContainerInsights')} 命名空间 + 集群内 API）。</>,
        <>Kubernetes 对象状态（Deployment、ReplicaSet 等）→ kube-state-metrics。节点 OS 层 → node_exporter / CloudWatch agent。</>,
      ]},
      { title: '① 控制平面（API Server / etcd）— 虽是托管服务，负载指标仍需关注', items: [
        <><b>apiserver_request_duration_seconds</b> — API Server 请求延迟。突增说明控制平面过载。</>,
        <><b>apiserver_request_total</b>（按状态码）— 关注 <b>429（限流）、5xx 比例</b>。</>,
        <><b>etcd_db_total_size_in_bytes</b> — etcd 数据库大小。接近上限（默认 8GB）时有拒绝写入、集群瘫痪的风险。可用于发现对象/Secret 的过量堆积。</>,
        <><b>apiserver_current_inflight_requests</b> — 进行中的请求数。用于确认优先级与公平性（APF）限流。</>,
        <>控制平面日志（api、audit、authenticator、controllerManager、scheduler）是追查问题根因的必备手段。</>,
      ]},
      { title: '② 节点（Worker）层 — Container Insights', items: [
        <><b>node_cpu_utilization / node_memory_utilization</b> — 节点 CPU/内存使用率。内存是诊断 OOM/驱逐（eviction）的关键。</>,
        <><b>node_filesystem_utilization</b> — 节点磁盘（尤其是 /var/lib 下的镜像/日志）。<b>超过 85% 会触发 DiskPressure 并驱逐 Pod。</b></>,
        <><b>node_status_condition</b>（Ready、MemoryPressure、DiskPressure、PIDPressure）— 节点状态条件（本仪表盘：集群内查询）。</>,
        <><b>cluster_node_count / cluster_failed_node_count</b> — 节点数/故障节点数，以及 <b>node_network_total_bytes</b>。</>,
      ]},
      { title: '③ Pod / 工作负载 — Container Insights', items: [
        <><b>pod_cpu_utilization_over_pod_limit</b> — 相对 limit 的使用率。超过 limit 时会发生 CPU 限流（throttling）。</>,
        <><b>pod_memory_utilization_over_pod_limit</b> — 接近 limit 时有 OOMKilled 风险。</>,
        <><b>pod_number_of_container_restarts</b> — 容器重启次数。突增是 CrashLoopBackOff / OOMKill 的信号。<b>最重要的异常指标之一。</b></>,
        <><b>pod_status_ready / running / pending / failed</b>，并通过 kube-state-metrics 的 {code('kube_pod_container_status_last_terminated_reason')} 确认是否为 OOMKilled。</>,
        <><b>kube_pod_status_phase</b> — Pending 持续堆积意味着调度失败（资源不足、taint、PV 未绑定）。</>,
      ]},
      { title: '④ 调度 / 扩缩容', items: [
        <><b>Pending Pod 数量</b> — 无法被调度的 Pod。判断是 Cluster Autoscaler / Karpenter 加不上节点，还是资源 request 设置过高。</>,
        <>Cluster Autoscaler：{code('cluster_autoscaler_unschedulable_pods_count')} · Karpenter：置备/漂移（drift）/consolidation 相关指标。</>,
        <>HPA：{code('kube_horizontalpodautoscaler_status_current_replicas')} vs desired — 判断扩缩目标是否达成。</>,
        <><b>资源预留 vs 实际使用</b>：request 总和 vs 节点 allocatable — 发现因 request 过度预留导致节点"逻辑上已满"的情况（本仪表盘：reserved capacity 列）。</>,
      ]},
      { title: '⑤ 网络 / 插件（Add-on）', items: [
        <><b>VPC CNI IP 耗尽</b> — 子网 IP 用尽、单 ENI 的 IP 上限导致 Pod 拿不到 IP 而 Pending。检查 {code('aws_eni_allocated')} 等 awscni/ipamd 指标。<b>EKS 中的常见陷阱</b>（本仪表盘：节点详情中的 ENI IP 槽位条）。</>,
        <><b>CoreDNS 延迟/错误</b> — DNS 问题会蔓延成大范围故障。关注 {code('coredns_dns_request_duration_seconds')} 及失败率。</>,
        <>kube-proxy、负载均衡器控制器的状态（本仪表盘：插件状态表）。</>,
      ]},
      { title: '按症状的诊断流程', items: [
        <>Pod 反复重启 → <b>container_restarts + last_terminated_reason</b>（是否为 OOMKilled）+ 相对 limit 的内存使用。若是 OOM，则上调 limit 或排查应用内存泄漏。用日志和 {code('kubectl describe')} 确认。</>,
        <>Pod 处于 Pending → 用 {code('kubectl describe pod')} 查看事件。原因通常是以下之一：①资源不足（需要扩容）②VPC CNI IP 耗尽 ③taint/affinity ④PV 未绑定。</>,
        <>节点 NotReady → 检查 node condition（各类 Pressure）、kubelet 状态、节点 OS 层（磁盘/内存）。</>,
        <>间歇性 API 报错/部署缓慢 → 检查控制平面延迟与 429、APF 限流、etcd 大小。</>,
        <>DNS 引发的大范围故障 → 查看 CoreDNS 指标与日志、副本数。</>,
      ]},
      { title: 'EKS 特有的注意点', items: [
        <><b>必须开启 Container Insights</b>，节点/Pod/容器指标才会进入 CloudWatch（默认不提供）。或者采用 AMP（Amazon Managed Prometheus）+ kube-state-metrics/node_exporter 的组合。</>,
        <>仅靠 CloudWatch 指标往往不够，实践中通常用 <b>Prometheus + Grafana</b>（或 AMP/AMG）来查看 Kubernetes 原生指标。</>,
        <>诊断时应把指标、<b>kubectl（describe、logs、events、top）</b>和控制平面日志结合起来用。针对具体 Pod/节点的问题，最终往往是 kubectl 事件给出决定性线索。</>,
        <><b>VPC CNI IP 耗尽</b>和<b>资源 request 过度预留</b>是 EKS 特有的 Pending 原因，应放入优先排查清单。</>,
      ]},
    ],
    priorityHeader: ['指标', '告警标准', '含义'],
    priority: [
      ['pod_number_of_container_restarts', '突增', 'CrashLoop/OOMKill'],
      ['pod_memory_utilization_over_pod_limit', '接近 100%', 'OOMKilled 风险'],
      ['node_status_condition (Pressure)', 'True', 'Disk/Memory/PID 压力 → 驱逐'],
      ['Pending Pod 数量', '持续 > 0', '调度/扩缩容/IP 分配失败'],
      ['node_filesystem_utilization', '> 85%', 'DiskPressure'],
      ['apiserver_request_duration / 429', '突增', '控制平面过载'],
      ['etcd_db_total_size_in_bytes', '接近上限', 'etcd 饱和'],
      ['VPC CNI IP 余量', '偏低', 'Pod IP 耗尽'],
    ],
  },
  ANFW: {
    service: 'ANFW',
    intro: (
      <>Network Firewall 监控需要同时关注三个层面 — <b>CloudWatch 指标、防火墙日志（Alert/Flow/TLS）与补充数据源（VPC Flow Logs、CloudTrail、路由）</b>：指标看量与趋势，日志提供“哪条规则拦截了什么”的上下文，补充源捕捉绕过与变更。</>
    ),
    sections: [
      { title: '① CloudWatch 指标（AWS/NetworkFirewall）', items: [
        <><b>ReceivedPackets / ReceivedBytes</b> — 总流入量与带宽。维度为（FirewallName, AZ, Engine）— 所有数据包先经过 stateless 引擎，因此<b>接收统计只能用 Engine=Stateless</b>，避免转发到 SFE 的数据包被重复计数（本页的统计方式）。</>,
        <><b>PassedPackets / DroppedPackets / RejectedPackets</b> — 放行/丢弃/显式拒绝（TCP RST）。拦截流量激增是攻击或规则错配信号 — 用 Alert 日志确认是哪条规则。</>,
        <><b>InvalidDroppedPackets / OtherDroppedPackets / StreamExceptionPolicyPackets</b> — 异常包/其他丢弃/流异常处理。持续出现时怀疑非对称路由/会话处理问题。</>,
        <><b>TLS*Packets</b>（使用 TLS 检查时）— 监控解密失败（TLSDropped/Rejected）。</>,
        <>防火墙<b>状态</b>来自 API（READY / IN_SYNC / 按 AZ 端点）而非 CW 指标 — 本页顶部表格即此用途。<b>CustomAction</b> 维度可实现按规则的自定义指标。</>,
      ]},
      { title: '② 防火墙日志（S3 / CloudWatch Logs / Firehose）', items: [
        <><b>Alert 日志</b> — stateful 规则 alert/drop 命中的流量。哪条规则（sid）拦截/告警了什么 — <b>威胁分析的核心</b>。下方卡片用 Insights 汇总 CloudWatch Logs 目标。</>,
        <><b>Flow 日志</b> — stateful 引擎看到的全部流（5元组、字节/包数、会话起止）。用于流量模式与 Top talker 分析。</>,
        <><b>TLS 日志</b> — TLS 检查事件（SNI、证书、错误）。</>,
        <>日志包含源/目标 IP·端口、协议、规则命中、时间戳 — 仅靠指标无法获得的上下文。<b>S3/Firehose 目标无法在本页汇总</b>（需 Athena 等另行分析）。</>,
      ]},
      { title: '③ 补充数据源', items: [
        <><b>VPC Flow Logs</b> — 验证防火墙端点子网与路由，<b>检测绕过 ANFW 的流量</b>。</>,
        <><b>CloudTrail</b> — 审计策略/规则组变更管理事件（谁改了规则）— 下方变更审计卡片。</>,
        <><b>路由表</b> — 确认流量确实经过防火墙端点（参见 VPC 资源地图）。</>,
      ]},
      { title: '④ 按分析目标的路径', items: [
        <><b>威胁检测</b> → Alert 日志 + Dropped/RejectedPackets 激增。</>,
        <><b>容量/性能</b> → ReceivedPackets/Bytes 趋势 + Flow 日志 Top talker。</>,
        <><b>可用性</b> → 防火墙状态（READY/IN_SYNC）+ 按 AZ 端点/指标偏差。</>,
        <><b>变更审计/合规</b> → CloudTrail 管理事件（write 事件优先）。</>,
      ]},
    ],
    priorityHeader: ['数据', '目标', '关键信号'],
    priority: [
      ['Alert 日志 + Dropped/RejectedPackets', '威胁检测', '拦截激增 · 签名（sid）命中'],
      ['ReceivedPackets/Bytes + Flow 日志', '容量/性能', '流量趋势 · Top talker'],
      ['防火墙状态 + 按 AZ 指标', '可用性', 'READY/IN_SYNC · AZ 偏差'],
      ['CloudTrail 管理事件', '变更审计', '谁改了策略/规则'],
      ['VPC Flow Logs + 路由', '绕过检测', '未经防火墙的流量'],
    ],
  },
};
