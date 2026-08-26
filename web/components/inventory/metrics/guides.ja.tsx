import type { GuideSpec } from './DiagnosisGuide';

// JA translations of guides.tsx — keep keys in lockstep with GuideSpec.service values.
// Rendering is handled by the single DiagnosisGuide component; this file is data only.

const code = (t: string) => <code className="rounded bg-ink-50 px-1 font-mono text-[11px]">{t}</code>;

export const GUIDES_JA: Record<string, GuideSpec> = {
  MSK: {
    service: 'MSK',
    intro: (
      <>MSK は<b>モニタリングレベル</b> (DEFAULT / PER_BROKER / PER_TOPIC_PER_BROKER / PER_TOPIC_PER_PARTITION) に応じて
      公開されるメトリクスが異なります。診断が必要な場合は、最低でも <b>PER_BROKER 以上</b>に引き上げておくことを推奨します。</>
    ),
    sections: [
      { title: '① ブローカーリソース（ボトルネックの根源）', items: [
        <><b>CpuUser + CpuSystem</b> — 合計が 60~70% を超えたらアラーム。MSK の推奨: CPU の余裕を 40% 以上維持。</>,
        <><b>KafkaDataLogsDiskUsed</b> — データディスク使用率 (%)。<b>最も一般的な障害原因</b> — 85% を超えると危険で、ストレージ拡張/オートスケーリングが必要。</>,
        <><b>MemoryUsed / MemoryFree</b>、<b>RootDiskUsed</b> — ルートボリュームも併せて確認。</>,
      ]},
      { title: '② クラスターの健全性', items: [
        <><b>ActiveControllerCount</b> — 正常値はちょうど <b>1</b>。0 または 2 以上ならコントローラー異常 → 直ちに調査。</>,
        <><b>OfflinePartitionsCount</b> — 正常値は <b>0</b>。0 より大きいと該当パーティションがサービス不能（データ可用性の問題）。</>,
        <><b>UnderReplicatedPartitions</b> — 正常値は <b>0</b>。0 より大きいとレプリケーションが遅れている状態（ブローカーの過負荷/障害の兆候）。</>,
        <><b>UnderMinIsrPartitionCount</b> — min.insync.replicas を下回るパーティション。acks=all のプロデューサーが書き込みを拒否される状況。</>,
      ]},
      { title: '③ スループット・トラフィック', items: [
        <><b>BytesInPerSec / BytesOutPerSec</b> — インスタンスタイプのネットワーク上限と比較して確認。<b>MessagesInPerSec</b> も併せて確認。</>,
        <><b>ProduceThrottleTime / FetchThrottleTime</b> — クォータ/ネットワークのスロットリング発生の有無。</>,
      ]},
      { title: '④ 遅延 (Latency)', items: [
        <><b>RequestQueueSize / ResponseQueueSize</b> — キューが溜まるとブローカーがリクエストに追いつけていない状態。</>,
        <>Produce/Fetch のレイテンシー（FetchConsumerTotalTimeMsMean など）で詳細を確認。</>,
      ]},
      { title: '⑤ コンシューマーラグ — 実務で最も重要', items: [
        <><b>MaxOffsetLag / SumOffsetLag / EstimatedMaxTimeLag</b> — コンシューマーがプロデューサーに追いつけないと lag が増え続ける。リアルタイムパイプライン診断で最優先のメトリクス。</>,
        <>コンシューマーグループの lag は CloudWatch のほか、Kafka 自体の {code('kafka-consumer-groups.sh')} でも確認可能。</>,
      ]},
      { title: '⑥ 接続', items: [
        <><b>ConnectionCount / ClientConnectionCount</b>、<b>ConnectionCreationRate / CloseRate</b> — 接続の急増・再接続ストームを検知。</>,
      ]},
    ],
    priorityHeader: ['メトリクス', '正常値', '意味'],
    priority: [
      ['ActiveControllerCount', '= 1', 'コントローラー正常'],
      ['OfflinePartitionsCount', '= 0', '可用性'],
      ['UnderReplicatedPartitions', '= 0', 'レプリケーションの健全性'],
      ['KafkaDataLogsDiskUsed', '< 85%', 'ディスク枯渇の防止'],
      ['CpuUser + CpuSystem', '< ~60%', '負荷の余裕'],
      ['MaxOffsetLag', '傾向が安定', 'コンシューマーの処理遅延'],
    ],
  },

  RDS: {
    service: 'RDS',
    intro: (
      <>RDS の診断は <b>CloudWatch 基本メトリクス・Enhanced Monitoring・Performance Insights</b> の
      3 つの層をあわせて確認します — それぞれインスタンス / OS / クエリの観点です。</>
    ),
    sections: [
      { title: '① CloudWatch 基本メトリクス（インスタンスレベル）', items: [
        <><b>CPUUtilization</b> — 持続的に 80% を超える場合はインスタンスの拡張またはクエリチューニングが必要。</>,
        <><b>CPUCreditBalance / CPUCreditUsage</b> — T 系インスタンス（バーストパフォーマンス）限定。クレジットが 0 に近づくとパフォーマンスが急落する。<b>本番環境で見落とされがちな落とし穴。</b></>,
        <><b>FreeableMemory</b> — 慢性的に低い場合はスワップのリスク。<b>SwapUsage</b> は 0 に近いのが正常 — 増加はパフォーマンス急落のサイン。</>,
        <><b>FreeStorageSpace</b> — <b>最も多い障害原因。</b>枯渇すると DB が停止する → ストレージのオートスケーリングとアラームが必須。<b>DiskQueueDepth</b> が高い場合はストレージボトルネック。</>,
        <><b>ReadIOPS / WriteIOPS</b> — プロビジョンド IOPS (gp3/io1/io2) の上限と比較。<b>ReadLatency / WriteLatency</b> の急増 = ストレージボトルネック。<b>BurstBalance</b> (gp2) は枯渇するとベースライン IOPS に低下。</>,
        <><b>DatabaseConnections</b> — max_connections と比較。コネクションの枯渇やリーク（プール未使用）を診断。</>,
      ]},
      { title: '② レプリケーション / 高可用性', items: [
        <><b>ReplicaLag</b>（リードレプリカ、秒）/ <b>AuroraReplicaLag</b> — 読み取りを分散している場合のデータ鮮度の問題。</>,
        <>Multi-AZ フェイルオーバーイベントは RDS Events で追跡。</>,
      ]},
      { title: '③ Enhanced Monitoring（OS レベル、最短 1 秒間隔）', items: [
        <>CloudWatch 基本メトリクスはハイパーバイザー視点 — OS 内部は Enhanced Monitoring で確認する：プロセス別 CPU/メモリ、os.cpuUtilization の内訳 (user/system/wait/idle)、os.diskIO、loadAverage。</>,
        <><b>CPU wait が高い = I/O ボトルネック、system が高い = カーネルオーバーヘッド</b> — 原因の切り分けに有用。</>,
      ]},
      { title: '④ Performance Insights（クエリレベル — 診断の中核）', items: [
        <><b>DB Load (AAS)</b> — 最重要指標。<b>Max vCPU ラインを上回る</b>と過負荷。</>,
        <><b>Wait events の分解</b> — CPU / IO / Lock のどれがボトルネックかを特定（io/table/sql/handler、ロック待ちなど）。</>,
        <><b>Top SQL</b> — 負荷を発生させている上位クエリを特定 → チューニング対象。</>,
      ]},
    ],
    priorityHeader: ['メトリクス', '注意基準', '意味'],
    priority: [
      ['CPUUtilization', '> 80% 持続', 'コンピュートボトルネック'],
      ['FreeStorageSpace', 'しきい値以下', 'ディスク枯渇 → DB 停止'],
      ['FreeableMemory', '低水準 + SwapUsage 増加', 'メモリ不足'],
      ['DatabaseConnections', 'max に接近', 'コネクション枯渇/リーク'],
      ['ReadLatency/WriteLatency', '急増', 'ストレージボトルネック'],
      ['ReplicaLag', '増加傾向', 'レプリケーション遅延'],
      ['BurstBalance/CPUCreditBalance', '0 に接近', 'gp2/T 系のクレジット枯渇'],
      ['DB Load (PI)', '> Max vCPU', '全体的な過負荷'],
    ],
  },

  DynamoDB: {
    service: 'DynamoDB',
    intro: (
      <>DynamoDB はフルマネージドサービスのため OS/ディスク層がなく、<b>CloudWatch を中心にスループット・スロットリング・レイテンシー・エラー</b>を
      確認します。キャパシティモード (On-Demand vs Provisioned) によって注目すべき指標が変わります。</>
    ),
    sections: [
      { title: '① スロットリング — 診断で最も重要', items: [
        <><b>ThrottledRequests</b>、<b>ReadThrottleEvents / WriteThrottleEvents</b>、<b>OnlineIndexThrottleEvents</b>（GSI のインデックス作成時）。</>,
        <>原因は通常次の 2 つのいずれか: <b>プロビジョニング不足</b>（容量 &lt; トラフィック）または<b>ホットパーティション/ホットキー</b> — 全体の容量には余裕があるのに、特定のパーティションがパーティションあたりの上限 (3000 RCU / 1000 WCU) に達しているケース。後者が最も診断の難しいケース。</>,
      ]},
      { title: '② キャパシティ使用量', items: [
        <><b>ConsumedRead/WriteCapacityUnits</b>（実消費量）と <b>ProvisionedRead/WriteCapacityUnits</b>（設定値）を重ねて表示し、余裕/不足を判断する。</>,
        <>On-Demand では消費量のトレンド + AccountMaxTableLevelReads/Writes の上限 + 瞬間的な急増（2 倍ルール超過）の有無を確認する。</>,
      ]},
      { title: '③ レイテンシー (Latency)', items: [
        <><b>SuccessfulRequestLatency</b> — <b>オペレーション別の分解が要点</b> (GetItem/Query/PutItem/Scan…)。サービス側のレイテンシー（ネットワーク往復を除く）。</>,
        <>Scan/Query のレイテンシーが跳ね上がる場合は、非効率なアクセスパターン（フルスキャン、大きな結果セット）を疑う。</>,
      ]},
      { title: '④ エラー', items: [
        <><b>SystemErrors</b>（HTTP 500、サーバー側）/ <b>UserErrors</b>（HTTP 400、クライアント側）。</>,
        <><b>ConditionalCheckFailedRequests</b> — 楽観的ロックを使用していれば正常時にも発生する → 文脈で判断。<b>TransactionConflict</b> が高い場合は競合が激しい。</>,
      ]},
      { title: '⑤ Global Tables / ストリーム', items: [
        <><b>ReplicationLatency</b>、PendingReplicationCount、AgeOfOldestUnreplicatedRecord — リージョン間のレプリケーション遅延。</>,
        <>Streams を Lambda で消費している場合は、Lambda の <b>IteratorAge</b> でストリーム処理の遅延を確認する。</>,
      ]},
      { title: '診断の深掘り: CloudWatch Contributor Insights for DynamoDB', items: [
        <><b>ホットパーティション/ホットキーの検出に特化したツール</b> — 最も頻繁にアクセスされるパーティションキーをランキング表示し、スロットリングの原因が「容量不足」なのか「キー分布の偏り」なのかを切り分ける際に決定的。</>,
        <>スロットリングされたキー (Throttled key) も専用ルールで確認できる — テーブルごとに Contributor Insights を有効化して使用する。</>,
      ]},
    ],
    priorityHeader: ['メトリクス', '注意しきい値', '意味'],
    priority: [
      ['ReadThrottleEvents / WriteThrottleEvents', '> 0 が継続', '容量不足またはホットパーティション'],
      ['SystemErrors', '急増', 'サーバー側の異常'],
      ['ConsumedRCU/WCU vs Provisioned', '近接/超過', '容量の余裕不足'],
      ['SuccessfulRequestLatency', '急増', 'アクセスパターン/性能の問題'],
      ['ConditionalCheckFailedRequests', '想定より高い', '競合またはロジックの問題'],
      ['ReplicationLatency (Global Tables)', '増加傾向', 'リージョン間のレプリケーション遅延'],
    ],
  },

  ElastiCache: {
    service: 'ElastiCache',
    intro: (
      <>エンジン (Redis/Valkey vs Memcached) によってメトリクスは異なりますが、共通して<b>CPU・メモリ・接続・パフォーマンス（ヒット率/レイテンシー）・エンジン固有の指標</b>を確認します。以下は Redis/Valkey を基準としています。</>
    ),
    sections: [
      { title: '① CPU', items: [
        <><b>EngineCPUUtilization</b> — Redis/Valkey で最も重要。主要なコマンド処理は実質<b>シングルスレッド</b>のため、1 コアが飽和すると CPUUtilization（全 vCPU 平均）は低く見えても実際にはボトルネック。</>,
        <><b>CPUUtilization</b> — ノード全体。<b>Memcached はマルチスレッドのため、こちらが有効。</b></>,
        <>EngineCPU の持続的な高止まり → 遅いコマンド（O(N): KEYS、大きな HGETALL、大型 SORT）を疑うか、シャードの拡張を検討。</>,
      ]},
      { title: '② メモリ — 診断の核心', items: [
        <><b>DatabaseMemoryUsagePercentage</b> — maxmemory に対する使用率。<b>最も重要なアラーム指標。</b>FreeableMemory / BytesUsedForCache も併せて確認。</>,
        <><b>SwapUsage</b> — 増加すると危険（ディスクスワップ → レイテンシー急増）。</>,
        <><b>Evictions</b> — メモリが満杯になりキーが強制的にエビクションされる。継続的に発生する場合はノード拡張・シャーディング・maxmemory-policy の見直しが必要。<b>Reclaimed</b>（TTL 期限切れによる削除）は正常な動作。</>,
      ]},
      { title: '③ パフォーマンス — ヒット率とレイテンシー', items: [
        <><b>CacheHitRate</b>（または CacheHits/CacheMisses）— キャッシュ効果の核心。低い場合は TTL が短すぎる / キャッシュキー設計の問題 / コールドキャッシュを疑う。</>,
        <>コマンド種別ごとのレイテンシー (StringBasedCmdsLatency, GetType/SetType/HashBasedCmdsLatency…) でどのコマンドが遅いかを分解。SuccessfulRead/WriteRequestLatency も併せて確認。</>,
      ]},
      { title: '④ 接続', items: [
        <><b>CurrConnections</b> — maxclients に対する値。<b>NewConnections</b> の急増 = コネクションプール未使用/再接続ストームの疑い（接続確立のコストは大きい）。<b>CurrItems</b> はアイテム数。</>,
      ]},
      { title: '⑤ ネットワーク・スループット', items: [
        <>NetworkBytesIn/Out、<b>NetworkBandwidthIn/OutAllowanceExceeded</b> — インスタンスタイプごとのネットワーク上限の超過。<b>見落としやすいボトルネック。</b>ConnTrack/PPS AllowanceExceeded も同類。</>,
        <><b>ReplicationBytes / ReplicationLag</b> — リードレプリカのレプリケーション遅延。</>,
      ]},
      { title: '⑥ エンジン固有 (Redis/Valkey)', items: [
        <>KeyspaceHits/Misses、SaveInProgress、BytesUsedForCache。遅いコマンドの追跡には Redis {code('SLOWLOG')} も併用。</>,
        <>クラスターモードではシャード/ノード単位に分解して<b>ホットシャード</b>を確認。</>,
      ]},
      { title: '症状別の診断パス', items: [
        <>レイテンシー増加 + 全体 CPU は低い → <b>EngineCPUUtilization + SLOWLOG</b> を確認。</>,
        <>断続的な性能低下 + Evictions → <b>メモリ不足 / TTL・エビクションポリシー</b>を見直し。</>,
        <>原因不明のレイテンシー + トラフィック大 → <b>Network...AllowanceExceeded</b> の帯域幅上限を確認。</>,
        <>ヒット率が低い → <b>キャッシュキー設計・TTL</b> を見直し。</>,
      ]},
    ],
    priorityHeader: ['メトリクス', '注意基準', '意味'],
    priority: [
      ['EngineCPUUtilization', '> 90% (Redis)', 'シングルスレッド飽和/遅いコマンド'],
      ['DatabaseMemoryUsagePercentage', '高い', 'メモリ圧迫'],
      ['Evictions', '> 0 が継続', 'メモリ不足 → キーのエビクション'],
      ['SwapUsage', '増加', '性能急落のリスク'],
      ['CacheHitRate', '低い', 'キャッシュ効果の低下'],
      ['CurrConnections', 'max に近接', '接続の枯渇'],
      ['Network...AllowanceExceeded', '> 0', 'ネットワーク上限のボトルネック'],
      ['ReplicationLag', '増加傾向', 'レプリケーション遅延'],
    ],
  },

  OpenSearch: {
    service: 'OpenSearch',
    intro: (
      <>OpenSearch では <b>クラスターステータス・JVM/メモリ・ストレージ・検索/インデキシング性能・スレッドプールキュー</b>を
      中心に確認します（マネージド OpenSearch Service、CloudWatch メトリクス基準）。</>
    ),
    sections: [
      { title: '① クラスターステータス — 最初に確認するもの', items: [
        <><b>ClusterStatus.green/yellow/red</b> — <b>red は即時対応が必要</b>：プライマリシャード未割り当て（データにアクセス不可）。yellow はレプリカ未割り当て（可用性低下、データにはアクセス可能）。</>,
        <><b>Nodes</b> — 想定値と異なればノードの離脱/障害。</>,
        <><b>ClusterIndexWritesBlocked</b> — 値 1 = 書き込みブロック（ディスク不足/JVM 負荷/red など）。<b>非常に重要なアラーム指標。</b></>,
      ]},
      { title: '② JVM メモリ負荷 — 診断の中核', items: [
        <><b>JVMMemoryPressure</b>（新しいドメインでは OldGenJVMMemoryPressure）— 最重要。<b>80% を超えると頻繁な GC で性能が低下</b>し、92% 以上が続くと保護メカニズムが書き込みをブロックすることがある。</>,
        <><b>JVMGCYoung/OldCollectionCount·Time</b> — Old GC が頻繁かつ長い場合はヒープ圧迫が深刻。</>,
        <>負荷が高い → シャード数過多（オーバーシャーディング）、大規模な集約クエリ、フィールドデータキャッシュの肥大、ノード拡張の必要性を疑う。</>,
      ]},
      { title: '③ CPU', items: [
        <><b>CPUUtilization</b>（データノード）/ <b>MasterCPUUtilization</b>（専用マスター — 飽和するとシャード割り当て・クラスターステート更新が遅延）/ WarmCPUUtilization (UltraWarm)。</>,
      ]},
      { title: '④ ストレージ', items: [
        <><b>FreeStorageSpace</b> — ノードごとの空きディスク。<b>最も多い障害原因。</b>ディスクウォーターマーク (low 85% / high 90% / flood 95%) に達するとシャード再配置・書き込みブロックが発生。</>,
        <>ClusterUsedSpace、<b>DiskQueueDepth</b>（I/O 待ち）、Read/WriteLatency·Throughput (EBS)。</>,
      ]},
      { title: '⑤ 検索・インデキシング性能', items: [
        <><b>SearchRate / SearchLatency</b>、<b>IndexingRate / IndexingLatency</b> — レイテンシーが急上昇する場合は重いクエリ・オーバーシャーディング・リソース飽和を疑う。</>,
      ]},
      { title: '⑥ スレッドプールのキューと拒否 — 負荷飽和のシグナル', items: [
        <><b>ThreadpoolSearchQueue / ThreadpoolWriteQueue</b> — キューが溜まると処理が追いついていない状態。</>,
        <><b>ThreadpoolSearchRejected / ThreadpoolWriteRejected</b> — キューが満杯になりリクエストを拒否。<b>0 より大きければクライアントがエラーを受け取っている状態 → 即時調査。</b>容量不足/クエリ非効率の強いシグナル。CoordinatingWriteRejected·PrimaryWriteRejected は書き込みバックプレッシャー。</>,
      ]},
      { title: '⑦ その他よく確認するもの', items: [
        <><b>MasterReachableFromNode</b>（1 が正常）、<b>AutomatedSnapshotFailure</b>（バックアップ失敗）、<b>KMSKeyError/KMSKeyInaccessible</b>（値 1 ならクラスターにアクセスできなくなるリスク）。</>,
        <>5xx/4xx/2xx HTTP コード、InvalidHostHeaderRequests、ThroughputThrottle/IopsThrottle (gp3)。</>,
      ]},
      { title: '症状別の診断パス', items: [
        <>クラスターが red/yellow → シャード割り当て失敗の原因（ディスクウォーターマーク、ノード離脱）を確認。</>,
        <>断続的なリクエスト失敗（429/拒否）→ <b>Threadpool...Rejected + JVM 負荷</b>を確認。</>,
        <>検索レイテンシーの急増 → 重いクエリ、オーバーシャーディング（データ量に対するシャード数）、リソース飽和を点検。</>,
        <>書き込みブロック → <b>ClusterIndexWritesBlocked + FreeStorageSpace + JVMMemoryPressure</b> の組み合わせで確認。</>,
        <>CloudWatch では捉えられない細かな原因（特定のインデックス/シャード/クエリ）はクラスター自身の API で確認：{code('_cluster/health')}、{code('_cat/indices?v')}、{code('_cat/shards')}、{code('_nodes/stats')}、Slow logs / Error logs。</>,
      ]},
    ],
    priorityHeader: ['メトリクス', '注意基準', '意味'],
    priority: [
      ['ClusterStatus.red', '= 1', 'プライマリシャード未割り当て（データ利用不可）'],
      ['ClusterIndexWritesBlocked', '= 1', '書き込みブロック'],
      ['JVMMemoryPressure', '> 80%', 'ヒープ圧迫 → GC/性能低下'],
      ['FreeStorageSpace', 'ウォーターマーク接近', 'ディスク枯渇'],
      ['Threadpool...Rejected', '> 0', 'リクエスト拒否（飽和）'],
      ['MasterCPUUtilization', '高い', 'マスターのボトルネック'],
      ['SearchLatency/IndexingLatency', '急増', 'クエリ/インデキシング性能'],
      ['AutomatedSnapshotFailure', '= 1', 'バックアップ失敗'],
    ],
  },

  ALB: {
    service: 'ALB',
    intro: (
      <>ALB では <b>HTTP レスポンスコード・レイテンシー・接続/リクエスト数・ターゲットヘルス・キャパシティ (LCU)</b> を中心に確認します。
      特に <b>「ロードバランサー自体が生成したエラー」(HTTPCode_ELB_*) と「ターゲットが返したエラー」(HTTPCode_Target_*) を
      区別すること</b>が診断の出発点です。</>
    ),
    sections: [
      { title: '① HTTP レスポンスコード — 診断の核心', items: [
        <><b>HTTPCode_ELB_5XX_Count</b> — ALB 自体が生成した 5xx（ターゲットに届かなかった、または応答を受け取れなかった）。502/503/504 に細分すると原因が絞り込める。</>,
        <><b>502</b> (Bad Gateway) — ターゲットの malformed 応答/接続の切断。<b>最もよくあるトラブル。</b> <b>503</b> — 正常なターゲットが存在しない（すべて unhealthy）、きわめて重要。<b>504</b> — idle timeout 内に応答が返らず、バックエンドが遅い兆候。</>,
        <><b>HTTPCode_Target_5XX_Count</b> — バックエンドアプリケーションのエラー。Target_2XX/3XX は正常トラフィックのベースライン。</>,
        <><b>重要な切り分け</b>: ELB_5XX↑ = LB↔ターゲット間の接続/ヘルスの問題、Target_5XX↑ = アプリケーションコードの問題。</>,
      ]},
      { title: '② レイテンシー (Latency)', items: [
        <><b>TargetResponseTime</b> — 最重要。<b>p50/p90/p99 パーセンタイルで</b>見る必要がある（平均はロングテールを隠す）。急増 = バックエンドの性能低下。</>,
      ]},
      { title: '③ リクエスト・接続数', items: [
        <><b>RequestCount</b>（トラフィックのベースライン）、<b>ActiveConnectionCount</b>、<b>NewConnectionCount</b>（TLS 再ネゴシエーションの急増を検知）。</>,
        <><b>RejectedConnectionCount</b> — ALB の最大接続数の上限に到達。<b>0 より大きければキャパシティの問題。</b></>,
        <><b>Client/TargetTLSNegotiationErrorCount</b> — TLS ネゴシエーションの失敗。</>,
      ]},
      { title: '④ ターゲットヘルス — 可用性（ターゲットグループ単位で見て初めて意味がある）', items: [
        <><b>HealthyHostCount</b> — 0 に近づくと危険、0 になると 503 が発生。</>,
        <><b>UnHealthyHostCount</b> — 増加時はヘルスチェック失敗の原因を調査（アプリのクラッシュ、ヘルスチェックパスの誤り、起動の遅延）。</>,
      ]},
      { title: '⑤ キャパシティ / スロットリング', items: [
        <><b>ConsumedLCUs</b>（料金・キャパシティ算定、急増の検知）、ProcessedBytes。</>,
        <><b>TargetConnectionErrorCount</b> — ALB→ターゲットの接続失敗。ネットワーク/セキュリティグループ/ターゲットポートの問題の兆候。</>,
      ]},
      { title: '⑥ その他の状況別', items: [
        <><b>RequestCountPerTarget</b> — 負荷分散の偏りを検知。HTTP_Redirect/Fixed_Response_Count。</>,
        <>DesyncMitigationMode_NonCompliant_Request_Count（HTTP desync のリスク）、GrpcRequestCount (gRPC)。</>,
      ]},
      { title: '症状別の診断フロー', items: [
        <>502 急増 → ターゲットアプリのクラッシュ/コネクションの早期切断、<b>keep-alive タイムアウトの不一致</b>（ALB idle timeout &gt; バックエンド keep-alive の場合に発生）を点検。</>,
        <>503 急増 → <b>HealthyHostCount</b> を確認し、ヘルスチェック失敗の原因を調査。</>,
        <>504 急増 → バックエンドの遅さ (TargetResponseTime) + ALB idle timeout の設定。</>,
        <>断続的な 5xx なのに Target は 2xx → LB レベルの問題: <b>RejectedConnectionCount / TargetConnectionErrorCount</b> を確認。</>,
        <>原因不明 → <b>アクセスログ (S3)</b> で個々のリクエストの elb_status_code vs target_status_code、request/target/response_processing_time を分解 — レイテンシーが LB のキューイングかバックエンドかを正確に切り分けられる。</>,
      ]},
    ],
    priorityHeader: ['メトリクス', '注意基準', '意味'],
    priority: [
      ['HTTPCode_ELB_5XX_Count', '急増', 'LB↔ターゲットの問題（502/503/504 に細分）'],
      ['HTTPCode_Target_5XX_Count', '急増', 'バックエンドアプリのエラー'],
      ['TargetResponseTime (p99)', '急増', 'バックエンドの性能低下'],
      ['HealthyHostCount', '低い/0', '正常なターゲットの不足 → 503'],
      ['UnHealthyHostCount', '> 0', 'ヘルスチェックの失敗'],
      ['RejectedConnectionCount', '> 0', '接続数上限に到達'],
      ['TargetConnectionErrorCount', '> 0', 'ターゲット接続の失敗（ネットワーク/SG）'],
    ],
  },

  NLB: {
    service: 'NLB',
    intro: (
      <>NLB は <b>L4 (TCP/UDP/TLS)</b> で動作するため、ALB とは見るべき観点が異なります — HTTP レスポンスコードは存在せず、
      <b>接続（フロー）・リセット (RST)・ターゲットヘルス・スループット・キャパシティ (LCU)</b> を中心に確認します。
      CloudWatch メトリクスが限られているため、<b>RST カウントとターゲットヘルスが診断の要</b>です。</>
    ),
    sections: [
      { title: '① 接続（フロー）数', items: [
        <><b>ActiveFlowCount</b> — アクティブフロー数 (TCP)。急増・急減でトラフィック異常を検知する。<b>NewFlowCount</b> は接続確立レート。</>,
        <>プロトコル別の内訳: ActiveFlowCount_TCP/_UDP/_TLS、NewFlowCount_TCP/_UDP/_TLS。<b>ConsumedLCUs</b> (_TCP/_UDP/_TLS) はキャパシティ・料金の算定に使う。</>,
      ]},
      { title: '② リセット (RST) — NLB 診断の核心', items: [
        <><b>TCP_Target_Reset_Count</b> — ターゲットが送信した RST: バックエンドが接続を切断している（アプリのクラッシュ、ポートのクローズ、バックログ超過）。<b>急増はバックエンド問題の強いシグナル。</b></>,
        <><b>TCP_ELB_Reset_Count</b> — NLB が生成した RST: アイドルタイムアウト超過など。<b>TCP_Client_Reset_Count</b> — クライアント発。</>,
        <><b>重要な切り分け</b>: Target RST の急増 → バックエンド問題、ELB RST の急増 → NLB レベル（主に <b>idle timeout 350秒</b>）または非対称ルーティング。</>,
      ]},
      { title: '③ ターゲットヘルス — 可用性（ターゲットグループ単位）', items: [
        <><b>HealthyHostCount</b>（0 に近いと危険）/ <b>UnHealthyHostCount</b>（増加時はヘルスチェック失敗を調査）。</>,
        <>NLB はアクティブ (TCP/HTTP/HTTPS) ヘルスチェックと自身の判定が混在する — ターゲットグループのヘルスチェック設定（プロトコル/ポート/パス）も併せて点検する。</>,
      ]},
      { title: '④ スループット・バイト数', items: [
        <><b>ProcessedBytes</b> (_TCP/_UDP/_TLS)、ProcessedPackets。</>,
      ]},
      { title: '⑤ TLS（TLS リスナー使用時）', items: [
        <><b>Client/TargetTLSNegotiationErrorCount</b>、TLSNegotiationErrorCount — ネゴシエーション失敗。</>,
      ]},
      { title: '⑥ キャパシティ上限・その他', items: [
        <><b>PortAllocationErrorCount</b> — クライアント IP 保持 + PrivateLink/SNAT 環境でのソースポート枯渇。<b>0 より大きければ接続失敗が発生している — 見落としやすい原因。</b></>,
        <>PeakPackets/BytesPerSecond、<b>UnhealthyRoutingFlowCount</b>（正常なターゲットがなくルーティングに失敗 — フェイルオープン関連）。</>,
      ]},
      { title: '症状別の診断フロー', items: [
        <>断続的な接続断 → <b>Target RST（バックエンド）vs ELB RST（idle timeout 350秒超過）</b>を切り分け、keep-alive 設定を点検する。</>,
        <>接続自体が確立しない → HealthyHostCount + セキュリティグループ/NACL/ターゲットポート。<b>NLB はクライアント IP を保持するため、ターゲットの SG がクライアント IP を許可する必要がある — よくある落とし穴。</b></>,
        <>高負荷時の接続失敗 → <b>PortAllocationErrorCount</b>（SNAT ポート枯渇）。</>,
        <>TLS リスナーのエラー → Client/TargetTLSNegotiationErrorCount。</>,
      ]},
      { title: 'ALB と異なる注意点', items: [
        <>L4 のため<b>アプリケーションレベルのレイテンシー/エラーは見えない</b> — HTTP の問題はターゲット（バックエンド）のメトリクス・ログで調査する。</>,
        <><b>VPC Flow Logs</b> がトラブルシューティングに非常に有用（接続の許可/拒否、クライアント IP の追跡）。NLB 自体のアクセスログは <b>TLS リスナーのみ</b>で提供される。</>,
        <>クライアント IP 保持の特性上、<b>ターゲットのセキュリティグループルール</b>が原因になりやすい。</>,
      ]},
    ],
    priorityHeader: ['メトリクス', '注意基準', '意味'],
    priority: [
      ['HealthyHostCount', '低い/0', '正常なターゲット不足'],
      ['UnHealthyHostCount', '> 0', 'ヘルスチェック失敗'],
      ['TCP_Target_Reset_Count', '急増', 'バックエンドが接続をリセット'],
      ['TCP_ELB_Reset_Count', '急増', 'NLB リセット（idle timeout など）'],
      ['PortAllocationErrorCount', '> 0', 'SNAT ソースポート枯渇'],
      ['ActiveFlowCount', '異常な傾向', 'トラフィック/接続の異常'],
      ['TargetTLSNegotiationErrorCount', '> 0', 'ターゲットの TLS 問題'],
    ],
  },

  S3: {
    service: 'S3',
    intro: (
      <>S3 は無制限にスケールするマネージドストレージのため「容量飽和」という概念がなく、代わりに
      <b>ストレージ使用量・リクエストパフォーマンス/エラー・レプリケーション・データ保護</b>を確認します。
      CloudWatch メトリクスが<b>ストレージメトリクス（無料、1日1回）</b>と<b>リクエストメトリクス
      （有料、1分 — バケット/プレフィックスごとに有効化しないと存在しない）</b>の 2 種類に
      分かれる点が重要です。</>
    ),
    sections: [
      { title: '① ストレージメトリクス（デフォルト、無料 — 1日1回の集計）', items: [
        <><b>BucketSizeBytes</b> — ストレージクラス別 (StandardStorage/StandardIAStorage/GlacierStorage…) に分解してはじめてコスト/ライフサイクル診断に有用。</>,
        <><b>NumberOfObjects</b> — 急増/急減で異常を検知し、リクエストコストの見積もりにも利用。1日1回の集計なのでリアルタイム用ではなく<b>トレンド・コストの観点。</b></>,
      ]},
      { title: '② リクエストメトリクス（要有効化、1分）— パフォーマンス診断の核心', items: [
        <><b>4xxErrors</b> — 403 権限 / 404 パスなど。急増時はポリシー・キーパスの問題。<b>5xxErrors</b> — 500/503 SlowDown、S3 側の問題またはリクエストレート超過。</>,
        <><b>503 SlowDown</b> — プレフィックスあたりのリクエストレート上限（<b>プレフィックスごとに毎秒 3,500 write / 5,500 read</b>）超過 = ホットプレフィックスのシグナル。</>,
        <><b>FirstByteLatency</b>（S3 の処理遅延）と <b>TotalRequestLatency</b>（全体 — 大きいオブジェクトでは自然に大きくなる）を区別。</>,
        <>AllRequests/Get/Put/Delete/Head/List、BytesDownloaded/Uploaded — トラフィックのベースライン。</>,
      ]},
      { title: '③ レプリケーション（CRR/SRR 使用時）', items: [
        <><b>ReplicationLatency</b> — RTC 使用時は SLA（15分）と比較。<b>BytesPendingReplication / OperationsPendingReplication</b> の増加傾向 = レプリケーションのボトルネック。</>,
        <><b>OperationsFailedReplication</b> — 0 より大きければ権限/設定の問題を調査。</>,
      ]},
      { title: '④ データ保護・ライフサイクル・その他', items: [
        <><b>Storage Lens</b> — アカウント/組織全体の可視性: 不完全なマルチパートアップロード、非現行バージョンの蓄積など、非効率を診断する中核ツール。</>,
        <>S3 Storage Class Analysis — ライフサイクル最適化の診断。</>,
      ]},
      { title: '症状別の診断フロー', items: [
        <>断続的な 503 SlowDown → <b>ホットプレフィックス</b>: キーの名前空間をプレフィックスに分散（ランダム/ハッシュ）し、プレフィックス別のリクエストメトリクスでどのプレフィックスがホットかを確認。</>,
        <>403 の急増 → バケットポリシー / IAM / ACL / Block Public Access / KMS キー権限を点検。<b>CloudTrail データイベント</b>で拒否されたプリンシパル・オペレーションを追跡。</>,
        <>レイテンシーの急増 → FirstByteLatency と TotalRequestLatency を区別（S3 の処理 vs オブジェクトサイズ/ネットワーク）。Transfer Acceleration・マルチパート・リージョン近接性を検討。</>,
        <>レプリケーション遅延/失敗 → OperationsPendingReplication の傾向 + OperationsFailedReplication + レプリケーションルール/権限。</>,
        <>原因不明のアクセス/削除 → <b>サーバーアクセスログ / CloudTrail データイベント</b>で個々のリクエスト（リクエスタ・オペレーション・レスポンスコード・レイテンシー）に分解。</>,
      ]},
      { title: 'S3 特有のポイント', items: [
        <>リアルタイムのパフォーマンス診断には<b>まずリクエストメトリクスの有効化</b>が必要です（デフォルトで無効、有料）— 有効化しないと 4xx/5xx/Latency は表示されません（下の表の「—」）。</>,
        <>個々のリクエストの追跡は CloudWatch ではなく<b>サーバーアクセスログ / CloudTrail データイベント</b>の役割。</>,
        <>コスト・ライフサイクルの最適化は <b>Storage Lens</b> が中核ツール。</>,
      ]},
    ],
    priorityHeader: ['メトリクス', '注意基準', '意味'],
    priority: [
      ['5xxErrors', '急増', 'S3 側のエラーまたはリクエストレート超過 (503 SlowDown)'],
      ['4xxErrors', '急増', '権限/パス/リクエストのエラー'],
      ['FirstByteLatency', '急増', 'S3 の処理遅延'],
      ['OperationsFailedReplication', '> 0', 'レプリケーション失敗'],
      ['ReplicationLatency', 'SLA 超過', 'レプリケーション遅延'],
      ['BucketSizeBytes', '異常な急増', 'コスト/異常アップロード'],
      ['NumberOfObjects', '異常な急増/急減', '大量削除/作成'],
    ],
  },

  EBS: {
    service: 'EBS',
    intro: (
      <>EBS は<b>IOPS・スループット・レイテンシー・キュー深度・バースト/パフォーマンスクレジット</b>を中心に確認します。核心は
      <b>ボリュームがプロビジョニングしたパフォーマンス上限に達しているのか、インスタンス側の EBS 帯域幅の上限に達しているのかを区別</b>する
      ことです — 両者は別々の上限です。</>
    ),
    sections: [
      { title: '① IOPS（オペレーション数）', items: [
        <><b>VolumeReadOps / VolumeWriteOps</b> — 期間の合計値のため、<b>期間（秒）で割って初めて IOPS</b>（5 分集計なら /300）。プロビジョニングした IOPS (gp3/io1/io2) または baseline (gp2 = 3 IOPS/GB) と比較して確認。</>,
        <>合算 IOPS がプロビジョニング上限に張り付いていれば → ボリュームがボトルネック。</>,
      ]},
      { title: '② スループット (Throughput)', items: [
        <><b>VolumeReadBytes / VolumeWriteBytes</b> — MB/s に換算してスループット上限と比較。<b>gp3 は IOPS とスループットを独立してプロビジョニング</b>するため、両方を別々に確認する必要がある。</>,
      ]},
      { title: '③ レイテンシー (Latency) — I/O ボトルネックの判断', items: [
        <><b>VolumeTotalRead/WriteTime</b> — オペレーションあたりの平均レイテンシー = <b>TotalTime / Ops</b>。</>,
        <>レイテンシーが高いのに IOPS/スループットは上限未達 → I/O サイズが大きいか、ランダムアクセスパターンの問題。</>,
      ]},
      { title: '④ キュー深度 — 飽和のシグナル', items: [
        <><b>VolumeQueueLength</b> — 待機中の I/O リクエスト数。<b>最も直感的な飽和指標。</b>持続的に高ければボリュームがリクエストに追いついていない状態（レイテンシー急増を伴う）。</>,
      ]},
      { title: '⑤ アイドル・使用率', items: [
        <>VolumeIdleTime、<b>VolumeThroughputPercentage</b>（io1/io2 専用 — プロビジョニング値に対する実際の提供比率、100% 未満が続く = パフォーマンス低下）、VolumeConsumedReadWriteOps。</>,
      ]},
      { title: '⑥ バースト/パフォーマンスクレジット — 見落としやすいボトルネック', items: [
        <><b>BurstBalance</b> — gp2・st1・sc1 専用のクレジット残量 (%)。0 に近づくと baseline へ降格 → 間欠的なパフォーマンス低下。<b>gp2 の原因不明なパフォーマンス低下でよくある犯人。</b></>,
        <>gp3/io1/io2 にはバーストの概念がない — <b>gp2→gp3 への移行で解決</b>するケースが多い。</>,
      ]},
      { title: '⑦ インスタンスレベル — EBS 帯域幅の上限', items: [
        <>ボリュームには余裕があるのに遅い場合はインスタンス側を疑う：<b>EBSIOBalance% / EBSByteBalance%</b>（小型インスタンスの EBS バースト残量）— 0 に近づくとインスタンスの baseline へ降格 → <b>ボリュームをどれだけ大きくしてもボトルネック。</b></>,
        <>EBSRead/WriteOps·Bytes — インスタンスタイプごとの EBS 帯域幅上限と比較して確認。</>,
      ]},
      { title: '症状別の診断フロー', items: [
        <>間欠的/周期的なパフォーマンス低下 → <b>BurstBalance (gp2) または EBSIOBalance%（小型インスタンス）のクレジット枯渇</b> — EBS パフォーマンス問題の筆頭原因。</>,
        <>レイテンシーが高い + IOPS/スループットは上限未達 → I/O サイズ・ランダム性、またはインスタンス帯域幅。VolumeQueueLength とインスタンスの EBS balance を併せて確認。</>,
        <>ボリュームには余裕があるのに遅い → インスタンスの EBSByte/IOBalance% + インスタンスタイプの EBS 上限を点検（タイプの引き上げが必要な場合あり）。</>,
        <>IOPS がプロビジョニング上限に張り付く → gp3 の IOPS/スループット引き上げ、io2 への移行、ボリューム分散 (RAID 0)/アプリケーション側キャッシュを検討。</>,
      ]},
      { title: 'EBS 特有の注意点', items: [
        <>CloudWatch の生の値は<b>期間の合計 — 割り算で換算して初めて実際の IOPS/レイテンシー</b>になります。</>,
        <>gp2 の 3 IOPS/GB baseline + バーストモデル → <b>小さい gp2 ボリュームのクレジット枯渇</b>が定番の原因。多くの場合、gp3 への移行が答え。</>,
        <><b>ボリュームのパフォーマンスとインスタンスの EBS 帯域幅は別々の上限</b> — 両方を確認して初めてボトルネックを正確に特定できます。</>,
      ]},
    ],
    priorityHeader: ['メトリクス', '注意基準', '意味'],
    priority: [
      ['VolumeQueueLength', '持続的に高い', 'ボリューム飽和（I/O 待ち）'],
      ['BurstBalance (gp2/st1/sc1)', '0 に接近', 'クレジット枯渇 → baseline へ降格'],
      ['平均レイテンシー (TotalTime/Ops)', '急増', 'I/O ボトルネック'],
      ['VolumeReadOps+WriteOps（換算 IOPS）', 'プロビジョニング値に接近', 'IOPS 上限'],
      ['VolumeThroughputPercentage (io1/io2)', '< 100%', 'プロビジョニング性能未達'],
      ['EBSIOBalance%/EBSByteBalance%', '0 に接近', 'インスタンス EBS 帯域幅の降格'],
    ],
  },

  EC2: {
    service: 'EC2',
    intro: (
      <>EC2 では <b>CPU・ネットワーク・EBS I/O・ステータスチェック (status check)・バーストクレジット</b> を基本として
      確認する。最も重要な特徴: <b>メモリとディスクの使用率はデフォルトの CloudWatch メトリクスに存在しない</b>
      （ハイパーバイザーはゲスト内部を見られない）— この 2 つには CloudWatch Agent のインストールが必要。</>
    ),
    sections: [
      { title: '① CPU', items: [
        <><b>CPUUtilization</b> — 80% 超が継続する場合はスケーリングやインスタンスタイプ変更を検討。ハイパーバイザー視点のため、vCPU steal などゲスト内部は見えない。</>,
        <><b>CPUCreditBalance / CPUCreditUsage</b> — T 系専用。0 に近づくとベースラインへの制限 (Standard) または追加課金 (Unlimited)。<b>原因不明の性能低下の常連。</b>CPUSurplusCreditsCharged は Unlimited の超過課金。</>,
      ]},
      { title: '② ステータスチェック (Status Checks) — 可用性診断の要', items: [
        <><b>StatusCheckFailed_System</b> — AWS インフラ側の問題（ホストのハードウェア/ネットワーク/電源）。対応: <b>stop/start</b>（別ホストへ移動）。</>,
        <><b>StatusCheckFailed_Instance</b> — インスタンス内部の問題（OS 起動/ファイルシステム/ネットワーク設定/カーネル）。対応: OS の調査/再起動。</>,
        <><b>StatusCheckFailed_AttachedEBS</b> — アタッチされた EBS が I/O に応答しない。</>,
        <>この区別により <b>「AWS 側の問題か、自分の OS の問題か」</b> を即座に切り分けられる。自動復旧は CloudWatch アラーム + EC2 auto-recovery。</>,
      ]},
      { title: '③ ネットワーク', items: [
        <><b>NetworkIn/Out</b>（帯域幅上限との対比）、<b>NetworkPacketsIn/Out</b>（PPS 上限の検知）。</>,
        <>帯域幅/PPS/conntrack の上限超過はデフォルトメトリクスには現れない — <b>ネットワークパフォーマンスメトリクス (ethtool, CloudWatch Agent)</b> の bw_in/out_allowance_exceeded、pps_allowance_exceeded、conntrack_allowance_exceeded で確認するのが正確。<b>見落としやすいボトルネック。</b></>,
      ]},
      { title: '④ EBS I/O（インスタンス視点）', items: [
        <>EBSRead/WriteOps・Bytes — インスタンス↔EBS 間の I/O。</>,
        <><b>EBSIOBalance% / EBSByteBalance%</b> — 小型インスタンスの EBS バースト残量。0 に近づくとインスタンスがベースラインに制限され → <b>ボリュームが大きくてもボトルネック</b>（EBS 診断と関連）。</>,
      ]},
      { title: '⑤ CloudWatch Agent が必要（デフォルト未提供）— 実務では必須', items: [
        <><b>メモリ</b>（mem_used_percent など）— EC2 の性能問題の多くはメモリ起因だが、デフォルトメトリクスには存在しない。</>,
        <><b>ディスク</b> (disk_used_percent, diskio_*) — ルート/データボリュームの枯渇を検知。<b>スワップ</b> (swap_used_percent)、ゲスト視点の CPU（steal 含む）、プロセス。</>,
        <>詳細な診断には CloudWatch Agent のインストールが事実上必須。</>,
      ]},
      { title: '症状別の診断フロー', items: [
        <>インスタンスが応答しない → <b>まずステータスチェック</b>: System 失敗なら AWS 側（stop/start で別ホストへ移行）、Instance 失敗なら OS を調査（システムログ/スクリーンショット）。</>,
        <>断続的/周期的な性能低下 → T 系なら <b>CPUCreditBalance の枯渇が最有力</b>、次に EBSIOBalance%。</>,
        <>CPU は低いのに遅い → メモリ/スワップ (Agent)、ディスク I/O、ネットワークの allowance 超過を確認。</>,
        <>ネットワークスループットが頭打ち → インスタンスタイプの帯域幅上限 + *_allowance_exceeded を確認し、タイプの引き上げを検討。</>,
      ]},
      { title: 'EC2 特有の注意点', items: [
        <><b>メモリ・ディスクはデフォルトメトリクスに存在しない → CloudWatch Agent が必須。</b>「なぜメモリのメトリクスがないのか」への答え。</>,
        <>ステータスチェックの <b>System vs Instance</b> の区別 = 責任の所在（AWS vs ユーザー）を即座に切り分ける中核の診断ポイント。</>,
        <>バーストパフォーマンス (T) インスタンスのクレジットや小型インスタンスの EBS/ネットワークバーストは、原因不明の性能問題の常連 — T 系/小型ならまず疑う。</>,
        <>詳細調査: CloudWatch Logs、EC2 システムログ/スクリーンショット、Compute Optimizer（ライトサイジング）。</>,
      ]},
    ],
    priorityHeader: ['メトリクス', '注意基準', '意味'],
    priority: [
      ['StatusCheckFailed_System', '= 1', 'AWS インフラ問題 → stop/start'],
      ['StatusCheckFailed_Instance', '= 1', 'OS/インスタンス内部の問題'],
      ['CPUUtilization', '> 80% 持続', 'コンピュートのボトルネック'],
      ['CPUCreditBalance（T 系）', '0 に接近', 'クレジット枯渇 → 制限/課金'],
      ['mem_used_percent (Agent)', '高い', 'メモリ逼迫'],
      ['disk_used_percent (Agent)', '> 85%', 'ディスク枯渇'],
      ['EBSIOBalance%/EBSByteBalance%', '0 に接近', 'EBS 帯域幅の制限'],
      ['bw/pps/conntrack_allowance_exceeded (Agent)', '> 0', 'ネットワーク上限のボトルネック'],
    ],
  },

  Lambda: {
    service: 'Lambda',
    intro: (
      <>Lambda は<b>呼び出し・エラー・スロットル・実行時間・同時実行数</b>を中心に見ます。
      サーバーレスのためインフラメトリクスはなく、実行単位の成功/失敗/レイテンシー/キャパシティに注目します。</>
    ),
    sections: [
      { title: '① 呼び出しとエラー — 診断の出発点', items: [
        <><b>Invocations</b>（トラフィックのベースライン）、<b>Errors</b>（ハンドラー例外・タイムアウト）。<b>エラー率 = Errors / Invocations</b> として見て初めて意味がある — 絶対値だけではトラフィック増加と区別できない。</>,
        <><b>DeadLetterErrors</b> — DLQ への配信失敗（非同期）。0 より大きければ失敗イベントが失われている可能性がある。<b>DestinationDeliveryFailures</b> も同類。</>,
      ]},
      { title: '② スロットル — 同時実行数の上限', items: [
        <><b>Throttles</b> — 同時実行数の上限超過による 429。<b>最もよくあるスケーリング問題。</b>原因: アカウントのリージョン上限（デフォルト 1,000）、reserved concurrency の設定、急激なバースト。</>,
      ]},
      { title: '③ 実行時間 (Duration)', items: [
        <><b>Duration</b> — <b>p50/p90/p99 のパーセンタイルで</b>見る（平均はコールドスタート・ロングテールを隠す）。<b>タイムアウト設定値に近づく</b>とタイムアウトエラーの危険。</>,
        <>PostRuntimeExtensionsDuration — 拡張機能 (extension) のオーバーヘッドを確認。</>,
      ]},
      { title: '④ 同時実行数 (Concurrency)', items: [
        <><b>ConcurrentExecutions</b> — アカウント/関数の上限と対比して見る。上限に近づくとスロットリング目前。UnreservedConcurrentExecutions は reserved を除いたプール。</>,
      ]},
      { title: '⑤ プロビジョニングされた同時実行 (PC)', items: [
        <><b>ProvisionedConcurrencyUtilization</b> が 100% に近い = PC 不足。<b>ProvisionedConcurrencySpilloverInvocations &gt; 0</b> = PC を超えた分が on-demand のコールドスタートに流れている。</>,
      ]},
      { title: '⑥ イベントソース別（ストリーム/キュー）', items: [
        <><b>IteratorAge</b> — Kinesis/DynamoDB Streams 消費の要。増え続ける場合は Lambda がプロデューサーに追いついていない → バッチサイズ/ParallelizationFactor/関数性能を調整。</>,
        <><b>OffsetLag</b>（Kafka/MSK ソース）。SQS なら ApproximateAgeOfOldestMessage も併せて確認、非同期なら AsyncEventsReceived/Age/Dropped。</>,
      ]},
      { title: '⑦ コールドスタート', items: [
        <>直接のメトリクスはない — CloudWatch Logs の <b>INIT_START / Init Duration</b> または X-Ray で確認。Duration p99 の急増 + PC スピルオーバーと合わせて診断。</>,
      ]},
      { title: '症状別の診断フロー', items: [
        <>429 での拒否 → <b>Throttles + ConcurrentExecutions vs 上限</b>。reserved の引き上げ/アカウント上限の引き上げ申請/バーストの平準化。</>,
        <>断続的な遅さ → <b>Duration p99 + Init Duration</b>（ログ）。PC の導入、<b>メモリ増強（Lambda はメモリ↑=CPU↑）</b>、パッケージの軽量化。</>,
        <>エラー率の上昇 → ログの例外スタックを確認。タイムアウトなら Duration が設定値に張り付いていないか確認。</>,
        <>ストリームの滞留 → IteratorAge が増加し続ける → バッチ/並列化/関数性能/ダウンストリームのボトルネック。</>,
        <>非同期イベントの喪失 → DeadLetterErrors / AsyncEventsDropped + DLQ の設定。</>,
      ]},
      { title: 'Lambda 特有の注意点', items: [
        <><b>メモリ設定がそのまま性能</b> — メモリ↑=CPU・ネットワーク↑で Duration が縮むことも。Max Memory Used（ログレポート）でライトサイジング、<b>Lambda Power Tuning</b> が有用。</>,
        <>エラーは必ず <b>Invocations に対する比率</b>で見る。</>,
        <>詳細診断: <b>CloudWatch Logs Insights</b>（エラーパターン・Init Duration・Max Memory Used の集計）+ <b>X-Ray</b>（コールドスタート・ダウンストリームの分解）。<b>Lambda Insights</b> を有効にすれば実行環境の CPU/メモリ/ネットワークメトリクスまで見られる。</>,
      ]},
    ],
    priorityHeader: ['メトリクス', '注意基準', '意味'],
    priority: [
      ['Errors（エラー率）', '急増', '例外/タイムアウト'],
      ['Throttles', '> 0', '同時実行数の上限超過 (429)'],
      ['Duration (p99)', 'タイムアウトに近接', '性能劣化/タイムアウトの危険'],
      ['ConcurrentExecutions', '上限に近接', 'スロットリング目前'],
      ['IteratorAge（ストリーム）', '増加傾向', 'コンシューマーの処理遅延'],
      ['ProvisionedConcurrencySpilloverInvocations', '> 0', 'PC 不足 → コールドスタート'],
      ['DeadLetterErrors', '> 0', '失敗イベント喪失の危険'],
    ],
  },

  EKS: {
    service: 'EKS',
    intro: (
      <>EKS は他のサービスよりレイヤーが多いです — <b>コントロールプレーン（API サーバー/etcd）・ノード（ワーカー）・Pod/ワークロード・
      スケーリング</b>をレイヤーごとに見る必要があり、メトリクスの取得元も CloudWatch 一つではなく、<b>Container Insights・
      コントロールプレーンログ・Prometheus/kube-state-metrics</b> など複数に分かれています。</>
    ),
    sections: [
      { title: 'まずメトリクスの取得元を整理', items: [
        <>EKS コントロールプレーン → CloudWatch コントロールプレーンロギング + 一部の CloudWatch メトリクス（このダッシュボード: {code('AWS/EKS')} 名前空間）。</>,
        <>ノード/Pod/コンテナ → <b>CloudWatch Container Insights</b>（エージェントが必要）または Prometheus（このダッシュボード: {code('ContainerInsights')} 名前空間 + クラスター内 API）。</>,
        <>Kubernetes オブジェクトの状態（Deployment、ReplicaSet など）→ kube-state-metrics。ノードの OS レベル → node_exporter / CloudWatch agent。</>,
      ]},
      { title: '① コントロールプレーン（API サーバー / etcd）— マネージドでも負荷指標の確認は必要', items: [
        <><b>apiserver_request_duration_seconds</b> — API サーバーのリクエストレイテンシー。急増はコントロールプレーンの過負荷を示す。</>,
        <><b>apiserver_request_total</b>（コード別）— <b>429（スロットリング）・5xx の比率</b>。</>,
        <><b>etcd_db_total_size_in_bytes</b> — etcd DB のサイズ。上限（デフォルト上限 8GB）に近づくと書き込み拒否・クラスター麻痺のリスク。オブジェクト/シークレットの過剰な蓄積を検知。</>,
        <><b>apiserver_current_inflight_requests</b> — 進行中のリクエスト。優先度と公平性 (APF) によるスロットリングを確認。</>,
        <>コントロールプレーンログ (api, audit, authenticator, controllerManager, scheduler) は問題の原因追跡に不可欠。</>,
      ]},
      { title: '② ノード（ワーカー）レベル — Container Insights', items: [
        <><b>node_cpu_utilization / node_memory_utilization</b> — ノードの CPU/メモリ使用率。メモリは OOM/退避の診断の要。</>,
        <><b>node_filesystem_utilization</b> — ノードのディスク（特に /var/lib のイメージ/ログ）。<b>85% を超えると DiskPressure により Pod が退避される。</b></>,
        <><b>node_status_condition</b> (Ready, MemoryPressure, DiskPressure, PIDPressure) — ノードのコンディション（このダッシュボード: クラスター内照会）。</>,
        <><b>cluster_node_count / cluster_failed_node_count</b> — ノード数/障害ノード数、<b>node_network_total_bytes</b>。</>,
      ]},
      { title: '③ Pod / ワークロード — Container Insights', items: [
        <><b>pod_cpu_utilization_over_pod_limit</b> — limit に対する使用率。limit を超えると CPU スロットリング。</>,
        <><b>pod_memory_utilization_over_pod_limit</b> — limit に近づくと OOMKilled のリスク。</>,
        <><b>pod_number_of_container_restarts</b> — コンテナの再起動回数。急増は CrashLoopBackOff / OOMKill のシグナル。<b>最も重要な異常指標の一つ。</b></>,
        <><b>pod_status_ready / running / pending / failed</b>、kube-state-metrics の {code('kube_pod_container_status_last_terminated_reason')} で OOMKilled かどうかを確認。</>,
        <><b>kube_pod_status_phase</b> — Pending が溜まるとスケジューリング失敗（リソース不足、taint、PV 未割り当て）。</>,
      ]},
      { title: '④ スケジューリング / スケーリング', items: [
        <><b>Pending Pod 数</b> — スケジュールされない Pod。Cluster Autoscaler / Karpenter がノードを追加できていないのか、リソース request が過大なのかを診断。</>,
        <>Cluster Autoscaler: {code('cluster_autoscaler_unschedulable_pods_count')} · Karpenter: プロビジョニング/ドリフト/consolidation のメトリクス。</>,
        <>HPA: {code('kube_horizontalpodautoscaler_status_current_replicas')} vs desired — スケール目標に到達しているかどうか。</>,
        <><b>リソース予約 vs 実際</b>: request の合計 vs ノードの allocatable — request の過剰予約でノードが「論理的に満杯」になる状況を検知（このダッシュボード: reserved capacity 列）。</>,
      ]},
      { title: '⑤ ネットワーク / アドオン', items: [
        <><b>VPC CNI の IP 枯渇</b> — サブネットの IP 使い切りや ENI あたりの IP 上限により、Pod が IP を取得できず Pending になる。{code('aws_eni_allocated')} など awscni/ipamd のメトリクスを確認。<b>EKS でよくある落とし穴</b>（このダッシュボード: ノード詳細の ENI IP スロットバー）。</>,
        <><b>CoreDNS のレイテンシー/エラー</b> — DNS の問題は広範囲な障害に波及する。{code('coredns_dns_request_duration_seconds')}、失敗率。</>,
        <>kube-proxy、ロードバランサーコントローラーの状態（このダッシュボード: アドオン状態の表）。</>,
      ]},
      { title: '症状別の診断フロー', items: [
        <>Pod が再起動を繰り返す → <b>container_restarts + last_terminated_reason</b>（OOMKilled かどうか）+ limit に対するメモリ。OOM なら limit の引き上げ、またはアプリのメモリリークを調査。ログ・{code('kubectl describe')} で確認。</>,
        <>Pod が Pending → {code('kubectl describe pod')} のイベントを確認。原因はたいてい ①リソース不足（スケーリングが必要）②VPC CNI の IP 枯渇 ③taint/affinity ④PV 未割り当て のいずれか。</>,
        <>ノードが NotReady → ノードのコンディション (Pressure)、kubelet の状態、ノードの OS レベル（ディスク/メモリ）。</>,
        <>断続的な API エラー/デプロイが遅い → コントロールプレーンのレイテンシー・429、APF スロットリング、etcd サイズを確認。</>,
        <>DNS 起因の広範囲な障害 → CoreDNS のメトリクス・ログ、レプリカ数。</>,
      ]},
      { title: 'EKS 特有の注意点', items: [
        <><b>Container Insights を有効にして初めて</b>ノード/Pod/コンテナのメトリクスが CloudWatch に入ります（デフォルトでは提供されません）。または AMP (Amazon Managed Prometheus) + kube-state-metrics/node_exporter の組み合わせ。</>,
        <>CloudWatch メトリクスだけでは足りないことが多く、実務では <b>Prometheus + Grafana</b>（または AMP/AMG）で Kubernetes ネイティブのメトリクスを見るのが一般的です。</>,
        <>診断ではメトリクスに加えて <b>kubectl (describe, logs, events, top)</b> とコントロールプレーンログを併用します。特定の Pod/ノードの問題では、最終的に kubectl のイベントが決め手になります。</>,
        <><b>VPC CNI の IP 枯渇</b>と<b>リソース request の過剰予約</b>は EKS 特有の Pending の原因なので、真っ先に疑うリストに入れてください。</>,
      ]},
    ],
    priorityHeader: ['メトリクス', '注意基準', '意味'],
    priority: [
      ['pod_number_of_container_restarts', '急増', 'CrashLoop/OOMKill'],
      ['pod_memory_utilization_over_pod_limit', '100% に接近', 'OOMKilled リスク'],
      ['node_status_condition (Pressure)', 'True', 'Disk/Memory/PID の圧迫 → 退避'],
      ['Pending Pod 数', '> 0 が継続', 'スケジューリング/スケーリング/IP の失敗'],
      ['node_filesystem_utilization', '> 85%', 'DiskPressure'],
      ['apiserver_request_duration / 429', '急増', 'コントロールプレーンの過負荷'],
      ['etcd_db_total_size_in_bytes', '上限に接近', 'etcd の飽和'],
      ['VPC CNI IP 残量', '少ない', 'Pod IP の枯渇'],
    ],
  },
  ANFW: {
    service: 'ANFW',
    intro: (
      <>Network Firewall の監視は <b>CloudWatch メトリクス・ファイアウォールログ（Alert/Flow/TLS）・補完ソース（VPC Flow Logs、CloudTrail、ルーティング）</b>の 3 層を一緒に見ます — メトリクスは量と傾向、ログは「どのルールが何を」のコンテキスト、補完ソースはバイパスと変更を捕捉します。</>
    ),
    sections: [
      { title: '① CloudWatch メトリクス（AWS/NetworkFirewall）', items: [
        <><b>ReceivedPackets / ReceivedBytes</b> — 総流入量・帯域幅。ディメンションは（FirewallName, AZ, Engine）— 全パケットが先に stateless エンジンを通過するため、<b>受信集計は Engine=Stateless のみ</b>を使い SFE 転送分の二重集計を回避（本画面の集計方式）。</>,
        <><b>PassedPackets / DroppedPackets / RejectedPackets</b> — 通過/破棄/明示的拒否（TCP RST）。遮断急増は攻撃またはルール誤配置のシグナル — Alert ログでどのルールか確認。</>,
        <><b>InvalidDroppedPackets / OtherDroppedPackets / StreamExceptionPolicyPackets</b> — 異常パケット・その他破棄・ストリーム例外処理。継続発生は非対称ルーティング/セッション処理の問題を疑う。</>,
        <><b>TLS*Packets</b>（TLS 検査使用時）— 復号化失敗（TLSDropped/Rejected）の監視。</>,
        <>ファイアウォールの<b>状態</b>は CW メトリクスではなく API（READY / IN_SYNC / AZ 別エンドポイント）で確認 — 本画面上部のテーブルがその役割。<b>CustomAction</b> ディメンションでルール別カスタム指標も可能。</>,
      ]},
      { title: '② ファイアウォールログ（S3 / CloudWatch Logs / Firehose）', items: [
        <><b>Alert ログ</b> — stateful ルールの alert/drop にマッチしたトラフィック。どのルール（sid）が何を遮断/警告したか — <b>脅威分析の中核</b>。下のカードが CloudWatch Logs 宛てを Insights で集計。</>,
        <><b>Flow ログ</b> — stateful エンジンが見た全フロー（5-tuple、バイト/パケット、セッション開始・終了）。トラフィックパターン・Top talker 分析用。</>,
        <><b>TLS ログ</b> — TLS 検査イベント（SNI、証明書、エラー）。</>,
        <>ログには送信元/宛先 IP・ポート、プロトコル、ルールマッチ、タイムスタンプを含む — メトリクスだけでは得られないコンテキスト。<b>S3/Firehose 宛ては本画面で集計不可</b>（Athena 等で別途分析）。</>,
      ]},
      { title: '③ 補完データソース', items: [
        <><b>VPC Flow Logs</b> — ファイアウォールエンドポイントのサブネット・ルーティング検証、<b>ANFW バイパストラフィックの検出</b>。</>,
        <><b>CloudTrail</b> — ポリシー/ルールグループ変更の管理イベント監査（誰がルールを変えたか）— 下の変更監査カード。</>,
        <><b>ルートテーブル</b> — トラフィックが実際にファイアウォールを経由するか確認（VPC リソースマップ参照）。</>,
      ]},
      { title: '④ 分析目的別の経路', items: [
        <><b>脅威検知</b> → Alert ログ + Dropped/RejectedPackets 急増。</>,
        <><b>容量/性能</b> → ReceivedPackets/Bytes 傾向 + Flow ログ Top talker。</>,
        <><b>可用性</b> → ファイアウォール状態（READY/IN_SYNC）+ AZ 別の偏差。</>,
        <><b>変更監査/コンプライアンス</b> → CloudTrail 管理イベント（write 優先）。</>,
      ]},
    ],
    priorityHeader: ['データ', '目的', '主要シグナル'],
    priority: [
      ['Alert ログ + Dropped/RejectedPackets', '脅威検知', '遮断急増 · シグネチャ（sid）マッチ'],
      ['ReceivedPackets/Bytes + Flow ログ', '容量/性能', 'トラフィック傾向 · Top talker'],
      ['ファイアウォール状態 + AZ 別指標', '可用性', 'READY/IN_SYNC · AZ 偏差'],
      ['CloudTrail 管理イベント', '変更監査', '誰がポリシー/ルールを変えたか'],
      ['VPC Flow Logs + ルーティング', 'バイパス検出', 'ファイアウォールを経由しないトラフィック'],
    ],
  },
};
