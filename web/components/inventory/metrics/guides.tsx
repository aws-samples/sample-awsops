import type { GuideSpec } from './DiagnosisGuide';

// 서비스별 진단 가이드 콘텐츠 (owner 제공 가이드를 데이터로) — 렌더링은 DiagnosisGuide 하나가 담당.
// 새 서비스 추가 = 여기에 GuideSpec 하나 + 해당 테이블에서 <DiagnosisGuide spec={...} /> 한 줄.

const code = (t: string) => <code className="rounded bg-ink-50 px-1 font-mono text-[11px]">{t}</code>;

export const MSK_GUIDE: GuideSpec = {
  service: 'MSK',
  intro: (
    <>MSK는 <b>모니터링 레벨</b>(DEFAULT / PER_BROKER / PER_TOPIC_PER_BROKER / PER_TOPIC_PER_PARTITION)에 따라
    노출되는 메트릭이 달라집니다. 진단이 필요하면 최소 <b>PER_BROKER 이상</b>으로 올려두는 것을 권장합니다.</>
  ),
  sections: [
    { title: '① 브로커 리소스 (병목의 근원)', items: [
      <><b>CpuUser + CpuSystem</b> — 합산 60~70% 초과 시 경보. MSK 권장: CPU 여유 40% 이상 유지.</>,
      <><b>KafkaDataLogsDiskUsed</b> — 데이터 디스크 사용률(%). <b>가장 흔한 장애 원인</b> — 85% 초과 시 위험, 스토리지 확장/오토스케일링 필요.</>,
      <><b>MemoryUsed / MemoryFree</b>, <b>RootDiskUsed</b> — 루트 볼륨도 함께 확인.</>,
    ]},
    { title: '② 클러스터 건강성', items: [
      <><b>ActiveControllerCount</b> — 정상값은 정확히 <b>1</b>. 0이거나 2 이상이면 컨트롤러 이상 → 즉시 조사.</>,
      <><b>OfflinePartitionsCount</b> — 정상값 <b>0</b>. 0보다 크면 해당 파티션 서비스 불가 (데이터 가용성 문제).</>,
      <><b>UnderReplicatedPartitions</b> — 정상값 <b>0</b>. 0보다 크면 복제가 뒤처지는 중 (브로커 부하/장애 신호).</>,
      <><b>UnderMinIsrPartitionCount</b> — min.insync.replicas 미달 파티션. acks=all 프로듀서가 쓰기 거부당하는 상황.</>,
    ]},
    { title: '③ 처리량·트래픽', items: [
      <><b>BytesInPerSec / BytesOutPerSec</b> — 인스턴스 타입의 네트워크 한계 대비 확인. <b>MessagesInPerSec</b> 병행.</>,
      <><b>ProduceThrottleTime / FetchThrottleTime</b> — 쿼터/네트워크 스로틀링 발생 여부.</>,
    ]},
    { title: '④ 지연(Latency)', items: [
      <><b>RequestQueueSize / ResponseQueueSize</b> — 큐가 쌓이면 브로커가 요청을 못 따라가는 중.</>,
      <>Produce/Fetch 레이턴시 (FetchConsumerTotalTimeMsMean 등)로 상세 확인.</>,
    ]},
    { title: '⑤ 컨슈머 지연 — 실무에서 가장 중요', items: [
      <><b>MaxOffsetLag / SumOffsetLag / EstimatedMaxTimeLag</b> — 컨슈머가 프로듀서를 못 따라가면 lag이 계속 증가. 실시간 파이프라인 진단의 최우선 지표.</>,
      <>컨슈머 그룹 lag은 CloudWatch 외에 Kafka 자체 {code('kafka-consumer-groups.sh')}로도 확인.</>,
    ]},
    { title: '⑥ 연결', items: [
      <><b>ConnectionCount / ClientConnectionCount</b>, <b>ConnectionCreationRate / CloseRate</b> — 커넥션 폭증·재연결 폭풍 감지.</>,
    ]},
  ],
  priorityHeader: ['메트릭', '정상값', '의미'],
  priority: [
    ['ActiveControllerCount', '= 1', '컨트롤러 정상'],
    ['OfflinePartitionsCount', '= 0', '가용성'],
    ['UnderReplicatedPartitions', '= 0', '복제 건강성'],
    ['KafkaDataLogsDiskUsed', '< 85%', '디스크 고갈 방지'],
    ['CpuUser + CpuSystem', '< ~60%', '부하 여유'],
    ['MaxOffsetLag', '추세 안정', '컨슈머 처리 지연'],
  ],
};

export const RDS_GUIDE: GuideSpec = {
  service: 'RDS',
  intro: (
    <>RDS 진단은 <b>CloudWatch 기본 메트릭 · Enhanced Monitoring · Performance Insights</b> 세 층위를
    함께 봅니다 — 각각 인스턴스 / OS / 쿼리 관점입니다.</>
  ),
  sections: [
    { title: '① CloudWatch 기본 메트릭 (인스턴스 레벨)', items: [
      <><b>CPUUtilization</b> — 지속 80% 초과 시 인스턴스 확장 또는 쿼리 튜닝.</>,
      <><b>CPUCreditBalance / CPUCreditUsage</b> — T계열(버스터블) 한정. 크레딧이 0에 수렴하면 성능 급락. <b>프로덕션에서 자주 놓치는 함정.</b></>,
      <><b>FreeableMemory</b> — 지속적으로 낮으면 스왑 위험. <b>SwapUsage</b>는 0에 가까워야 정상 — 커지면 성능 급락 신호.</>,
      <><b>FreeStorageSpace</b> — <b>가장 흔한 장애 원인.</b> 고갈되면 DB가 멈춤 → 스토리지 오토스케일링/경보 필수. <b>DiskQueueDepth</b>가 높으면 스토리지 병목.</>,
      <><b>ReadIOPS / WriteIOPS</b> — 프로비저닝 IOPS(gp3/io1/io2) 한계 대비. <b>ReadLatency / WriteLatency</b> 급증 = 스토리지 병목. <b>BurstBalance</b>(gp2)는 고갈 시 baseline IOPS로 강등.</>,
      <><b>DatabaseConnections</b> — max_connections 대비. 커넥션 고갈/누수(풀 미사용) 진단.</>,
    ]},
    { title: '② 복제 / 고가용성', items: [
      <><b>ReplicaLag</b>(리드 리플리카, 초) / <b>AuroraReplicaLag</b> — 읽기 분산 시 데이터 최신성 문제.</>,
      <>Multi-AZ 페일오버 이벤트는 RDS Events로 추적.</>,
    ]},
    { title: '③ Enhanced Monitoring (OS 레벨, 최소 1초 간격)', items: [
      <>CloudWatch 기본은 하이퍼바이저 관점 — OS 내부는 Enhanced Monitoring으로: 프로세스별 CPU/메모리, os.cpuUtilization 세부(user/system/wait/idle), os.diskIO, loadAverage.</>,
      <><b>CPU wait 높음 = I/O 병목, system 높음 = 커널 오버헤드</b> — 원인 구분에 유용.</>,
    ]},
    { title: '④ Performance Insights (쿼리 레벨 — 진단의 핵심)', items: [
      <><b>DB Load (AAS)</b> — 핵심 지표. <b>Max vCPU 라인 위</b>로 올라가면 과부하.</>,
      <><b>Wait events 분해</b> — CPU / IO / Lock 중 무엇이 병목인지 (io/table/sql/handler, 락 대기 등).</>,
      <><b>Top SQL</b> — 부하 유발 상위 쿼리 식별 → 튜닝 대상.</>,
    ]},
  ],
  priorityHeader: ['메트릭', '주의 기준', '의미'],
  priority: [
    ['CPUUtilization', '> 80% 지속', '컴퓨트 병목'],
    ['FreeStorageSpace', '임계치 이하', '디스크 고갈 → DB 정지'],
    ['FreeableMemory', '낮음 + SwapUsage 증가', '메모리 부족'],
    ['DatabaseConnections', 'max 근접', '커넥션 고갈/누수'],
    ['ReadLatency/WriteLatency', '급증', '스토리지 병목'],
    ['ReplicaLag', '증가 추세', '복제 지연'],
    ['BurstBalance/CPUCreditBalance', '0 근접', 'gp2/T계열 크레딧 고갈'],
    ['DB Load (PI)', '> Max vCPU', '전반 과부하'],
  ],
};

export const DDB_GUIDE: GuideSpec = {
  service: 'DynamoDB',
  intro: (
    <>DynamoDB는 관리형 서비스라 OS/디스크 층위가 없고 <b>CloudWatch 중심으로 처리량·스로틀링·지연·에러</b>를
    봅니다. 캐패시티 모드(On-Demand vs Provisioned)에 따라 관심 지표가 달라집니다.</>
  ),
  sections: [
    { title: '① 스로틀링 — 진단에서 가장 중요', items: [
      <><b>ThrottledRequests</b>, <b>ReadThrottleEvents / WriteThrottleEvents</b>, <b>OnlineIndexThrottleEvents</b>(GSI 인덱싱).</>,
      <>원인은 보통 둘 중 하나: <b>프로비저닝 부족</b>(용량 &lt; 트래픽) 또는 <b>핫 파티션/핫 키</b> — 전체 용량은 남는데 특정 파티션이 한계(파티션당 3000 RCU / 1000 WCU)에 걸림. 후자가 가장 진단하기 까다로운 케이스.</>,
    ]},
    { title: '② 캐패시티 사용량', items: [
      <><b>ConsumedRead/WriteCapacityUnits</b>(실소비) vs <b>ProvisionedRead/WriteCapacityUnits</b>(설정값)를 겹쳐 여유/부족 판단.</>,
      <>On-Demand는 소비량 추세 + AccountMaxTableLevelReads/Writes 상한 + 순간 급증(2배 룰 초과) 여부.</>,
    ]},
    { title: '③ 지연 (Latency)', items: [
      <><b>SuccessfulRequestLatency</b> — <b>오퍼레이션별 분해가 핵심</b>(GetItem/Query/PutItem/Scan…). 서비스 측 지연(네트워크 왕복 제외).</>,
      <>Scan/Query 지연이 튀면 비효율적 액세스 패턴(풀스캔, 큰 결과셋) 의심.</>,
    ]},
    { title: '④ 에러', items: [
      <><b>SystemErrors</b>(HTTP 500, 서버 측) / <b>UserErrors</b>(HTTP 400, 클라이언트 측).</>,
      <><b>ConditionalCheckFailedRequests</b> — 낙관적 락 사용 시 정상적으로도 발생 → 맥락 판단. <b>TransactionConflict</b> 높으면 경합 심함.</>,
    ]},
    { title: '⑤ Global Tables / 스트림', items: [
      <><b>ReplicationLatency</b>, PendingReplicationCount, AgeOfOldestUnreplicatedRecord — 리전 간 복제 지연.</>,
      <>Streams를 Lambda로 소비 중이면 Lambda의 <b>IteratorAge</b>로 스트림 처리 지연 확인.</>,
    ]},
    { title: '진단 심화: CloudWatch Contributor Insights for DynamoDB', items: [
      <><b>핫 파티션/핫 키 탐지 특화 도구</b> — 가장 자주 접근되는 파티션 키를 순위로 표시해, 스로틀 원인이 "용량 부족"인지 "키 분포 불균형"인지 구분할 때 결정적.</>,
      <>Throttled key(스로틀된 키)도 별도 룰로 확인 가능 — 테이블별로 Contributor Insights를 활성화해 사용.</>,
    ]},
  ],
  priorityHeader: ['메트릭', '주의 기준', '의미'],
  priority: [
    ['ReadThrottleEvents / WriteThrottleEvents', '> 0 지속', '용량 부족 또는 핫 파티션'],
    ['SystemErrors', '급증', '서버 측 이상'],
    ['ConsumedRCU/WCU vs Provisioned', '근접/초과', '용량 여유 부족'],
    ['SuccessfulRequestLatency', '급증', '액세스 패턴/성능 문제'],
    ['ConditionalCheckFailedRequests', '예상보다 높음', '경합 또는 로직 문제'],
    ['ReplicationLatency (Global Tables)', '증가 추세', '리전 간 복제 지연'],
  ],
};

export const EC_GUIDE: GuideSpec = {
  service: 'ElastiCache',
  intro: (
    <>엔진(Redis/Valkey vs Memcached)에 따라 메트릭이 다르지만 공통적으로 <b>CPU · 메모리 · 연결 ·
    성능(히트율/지연) · 엔진 고유 지표</b>를 봅니다. 아래는 Redis/Valkey 기준입니다.</>
  ),
  sections: [
    { title: '① CPU', items: [
      <><b>EngineCPUUtilization</b> — Redis/Valkey에서 가장 중요. 주 명령 처리가 사실상 <b>단일 스레드</b>라 코어 하나가 포화되면 CPUUtilization(전체 vCPU 평균)은 낮아 보여도 실제로는 병목.</>,
      <><b>CPUUtilization</b> — 노드 전체. <b>Memcached는 멀티스레드라 이쪽이 유효.</b></>,
      <>EngineCPU 지속 높음 → 느린 명령(O(N): KEYS, 큰 HGETALL, 대형 SORT) 의심 또는 샤드 확장.</>,
    ]},
    { title: '② 메모리 — 진단 핵심', items: [
      <><b>DatabaseMemoryUsagePercentage</b> — maxmemory 대비 사용률. <b>가장 중요한 경보 지표.</b> FreeableMemory / BytesUsedForCache 병행.</>,
      <><b>SwapUsage</b> — 커지면 위험(디스크 스왑 → 지연 급증).</>,
      <><b>Evictions</b> — 메모리가 꽉 차 키 강제 축출. 지속 발생 시 노드 확장·샤딩·maxmemory-policy 재검토. <b>Reclaimed</b>(TTL 만료 제거)는 정상 동작.</>,
    ]},
    { title: '③ 성능 — 히트율과 지연', items: [
      <><b>CacheHitRate</b>(또는 CacheHits/CacheMisses) — 캐시 효용의 핵심. 낮으면 TTL 너무 짧음 / 캐시 키 설계 문제 / 콜드 캐시.</>,
      <>명령군별 지연(StringBasedCmdsLatency, GetType/SetType/HashBasedCmdsLatency…)으로 어떤 명령이 느린지 분해. SuccessfulRead/WriteRequestLatency 병행.</>,
    ]},
    { title: '④ 연결', items: [
      <><b>CurrConnections</b> — maxclients 대비. <b>NewConnections</b> 급증 = 커넥션 풀 미사용/재연결 폭풍 의심(연결 수립 비용 큼). <b>CurrItems</b>는 아이템 수.</>,
    ]},
    { title: '⑤ 네트워크·처리량', items: [
      <>NetworkBytesIn/Out, <b>NetworkBandwidthIn/OutAllowanceExceeded</b> — 인스턴스 타입별 네트워크 상한 초과. <b>놓치기 쉬운 병목.</b> ConnTrack/PPS AllowanceExceeded도 동류.</>,
      <><b>ReplicationBytes / ReplicationLag</b> — 리드 리플리카 복제 지연.</>,
    ]},
    { title: '⑥ 엔진 고유 (Redis/Valkey)', items: [
      <>KeyspaceHits/Misses, SaveInProgress, BytesUsedForCache. 느린 명령 추적은 Redis {code('SLOWLOG')} 병행.</>,
      <>클러스터 모드면 샤드/노드별로 분해해 <b>핫 샤드</b> 확인.</>,
    ]},
    { title: '증상별 진단 경로', items: [
      <>지연 증가 + 전체 CPU 낮음 → <b>EngineCPUUtilization + SLOWLOG</b> 확인.</>,
      <>간헐적 성능 저하 + Evictions → <b>메모리 부족 / TTL·eviction 정책</b> 재검토.</>,
      <>원인 불명 지연 + 트래픽 많음 → <b>Network...AllowanceExceeded</b> 대역폭 상한 확인.</>,
      <>히트율 낮음 → <b>캐시 키 설계·TTL</b> 재검토.</>,
    ]},
  ],
  priorityHeader: ['메트릭', '주의 기준', '의미'],
  priority: [
    ['EngineCPUUtilization', '> 90% (Redis)', '단일 스레드 포화/느린 명령'],
    ['DatabaseMemoryUsagePercentage', '높음', '메모리 압박'],
    ['Evictions', '> 0 지속', '메모리 부족 → 키 축출'],
    ['SwapUsage', '증가', '성능 급락 위험'],
    ['CacheHitRate', '낮음', '캐시 효용 저하'],
    ['CurrConnections', 'max 근접', '연결 고갈'],
    ['Network...AllowanceExceeded', '> 0', '네트워크 상한 병목'],
    ['ReplicationLag', '증가 추세', '복제 지연'],
  ],
};

export const OS_GUIDE: GuideSpec = {
  service: 'OpenSearch',
  intro: (
    <>OpenSearch는 <b>클러스터 상태 · JVM/메모리 · 스토리지 · 검색/인덱싱 성능 · 스레드 풀 큐</b>를
    핵심으로 봅니다 (관리형 OpenSearch Service, CloudWatch 메트릭 기준).</>
  ),
  sections: [
    { title: '① 클러스터 상태 — 가장 먼저 보는 것', items: [
      <><b>ClusterStatus.green/yellow/red</b> — <b>red는 즉시 대응</b>: 프라이머리 샤드 미할당(데이터 접근 불가). yellow는 레플리카 미할당(가용성 저하, 데이터는 접근 가능).</>,
      <><b>Nodes</b> — 예상값과 다르면 노드 이탈/장애.</>,
      <><b>ClusterIndexWritesBlocked</b> — 값 1 = 쓰기 차단(디스크 부족/JVM 압박/red 등). <b>매우 중요한 경보 지표.</b></>,
    ]},
    { title: '② JVM 메모리 압박 — 진단의 핵심', items: [
      <><b>JVMMemoryPressure</b>(신형 OldGenJVMMemoryPressure) — 가장 중요. <b>80% 초과 시 잦은 GC로 성능 저하</b>, 92% 이상 지속 시 보호 메커니즘이 쓰기를 차단할 수 있음.</>,
      <><b>JVMGCYoung/OldCollectionCount·Time</b> — Old GC가 잦고 길면 힙 압박 심각.</>,
      <>압박 높음 → 샤드 수 과다(오버샤딩), 큰 집계 쿼리, 필드 데이터 캐시 과다, 노드 확장 필요 의심.</>,
    ]},
    { title: '③ CPU', items: [
      <><b>CPUUtilization</b>(데이터 노드) / <b>MasterCPUUtilization</b>(전용 마스터 — 포화 시 샤드 할당·상태 갱신 지연) / WarmCPUUtilization(UltraWarm).</>,
    ]},
    { title: '④ 스토리지', items: [
      <><b>FreeStorageSpace</b> — 노드별 여유 디스크. <b>가장 흔한 장애 원인.</b> 디스크 워터마크(low 85% / high 90% / flood 95%)에 걸리면 샤드 재배치·쓰기 차단.</>,
      <>ClusterUsedSpace, <b>DiskQueueDepth</b>(I/O 대기), Read/WriteLatency·Throughput(EBS).</>,
    ]},
    { title: '⑤ 검색·인덱싱 성능', items: [
      <><b>SearchRate / SearchLatency</b>, <b>IndexingRate / IndexingLatency</b> — 지연이 튀면 무거운 쿼리·오버샤딩·리소스 포화 의심.</>,
    ]},
    { title: '⑥ 스레드 풀 큐와 거부 — 부하 포화 신호', items: [
      <><b>ThreadpoolSearchQueue / ThreadpoolWriteQueue</b> — 큐가 쌓이면 처리 지연 중.</>,
      <><b>ThreadpoolSearchRejected / ThreadpoolWriteRejected</b> — 큐가 꽉 차 요청 거부. <b>0보다 크면 클라이언트가 에러를 받는 중 → 즉시 조사.</b> 용량 부족/쿼리 비효율의 강한 신호. CoordinatingWriteRejected·PrimaryWriteRejected는 쓰기 배압.</>,
    ]},
    { title: '⑦ 기타 자주 보는 것', items: [
      <><b>MasterReachableFromNode</b>(1이 정상), <b>AutomatedSnapshotFailure</b>(백업 실패), <b>KMSKeyError/KMSKeyInaccessible</b>(값 1이면 클러스터 접근 불가 위험).</>,
      <>5xx/4xx/2xx HTTP 코드, InvalidHostHeaderRequests, ThroughputThrottle/IopsThrottle(gp3).</>,
    ]},
    { title: '증상별 진단 경로', items: [
      <>클러스터 red/yellow → 샤드 할당 실패 원인(디스크 워터마크, 노드 이탈) 확인.</>,
      <>간헐적 요청 실패(429/거부) → <b>Threadpool...Rejected + JVM 압박</b> 확인.</>,
      <>검색 지연 급증 → 무거운 쿼리, 오버샤딩(샤드 수 대비 데이터량), 리소스 포화 점검.</>,
      <>쓰기 차단 → <b>ClusterIndexWritesBlocked + FreeStorageSpace + JVMMemoryPressure</b> 조합.</>,
      <>CloudWatch로 안 잡히는 세밀한 원인(특정 인덱스/샤드/쿼리)은 자체 API로: {code('_cluster/health')}, {code('_cat/indices?v')}, {code('_cat/shards')}, {code('_nodes/stats')}, Slow logs / Error logs.</>,
    ]},
  ],
  priorityHeader: ['메트릭', '주의 기준', '의미'],
  priority: [
    ['ClusterStatus.red', '= 1', '프라이머리 샤드 미할당(데이터 불가)'],
    ['ClusterIndexWritesBlocked', '= 1', '쓰기 차단'],
    ['JVMMemoryPressure', '> 80%', '힙 압박 → GC/성능 저하'],
    ['FreeStorageSpace', '워터마크 근접', '디스크 고갈'],
    ['Threadpool...Rejected', '> 0', '요청 거부(포화)'],
    ['MasterCPUUtilization', '높음', '마스터 병목'],
    ['SearchLatency/IndexingLatency', '급증', '쿼리/인덱싱 성능'],
    ['AutomatedSnapshotFailure', '= 1', '백업 실패'],
  ],
};

export const ALB_GUIDE: GuideSpec = {
  service: 'ALB',
  intro: (
    <>ALB는 <b>HTTP 응답 코드 · 지연 · 연결/요청 수 · 타깃 헬스 · 용량(LCU)</b>을 핵심으로 봅니다.
    특히 <b>"로드밸런서 자체가 낸 에러"(HTTPCode_ELB_*)와 "타깃이 낸 에러"(HTTPCode_Target_*)를
    구분하는 것</b>이 진단의 출발점입니다.</>
  ),
  sections: [
    { title: '① HTTP 응답 코드 — 진단의 핵심', items: [
      <><b>HTTPCode_ELB_5XX_Count</b> — ALB가 직접 생성한 5xx(타깃까지 못 갔거나 응답을 못 받음). 502/503/504로 세분하면 원인이 좁혀집니다.</>,
      <><b>502</b>(Bad Gateway) — 타깃의 malformed 응답/연결 끊김. <b>가장 흔한 트러블.</b> <b>503</b> — 정상 타깃이 없음(전부 unhealthy), 매우 중요. <b>504</b> — idle timeout 내 응답 실패, 백엔드 느림 신호.</>,
      <><b>HTTPCode_Target_5XX_Count</b> — 백엔드 애플리케이션 오류. Target_2XX/3XX는 정상 트래픽 기준선.</>,
      <><b>핵심 구분</b>: ELB_5XX↑ = LB↔타깃 연결/헬스 문제, Target_5XX↑ = 애플리케이션 코드 문제.</>,
    ]},
    { title: '② 지연 (Latency)', items: [
      <><b>TargetResponseTime</b> — 가장 중요. <b>p50/p90/p99 백분위로</b> 봐야 함(평균은 롱테일을 숨김). 급증 = 백엔드 성능 저하.</>,
    ]},
    { title: '③ 요청·연결 수', items: [
      <><b>RequestCount</b>(트래픽 기준선), <b>ActiveConnectionCount</b>, <b>NewConnectionCount</b>(TLS 재협상 폭주 감지).</>,
      <><b>RejectedConnectionCount</b> — ALB 최대 연결 한도 도달. <b>0보다 크면 용량 문제.</b></>,
      <><b>Client/TargetTLSNegotiationErrorCount</b> — TLS 협상 실패.</>,
    ]},
    { title: '④ 타깃 헬스 — 가용성 (타깃 그룹 차원으로 봐야 의미)', items: [
      <><b>HealthyHostCount</b> — 0에 가까워지면 위험, 0이면 503 발생.</>,
      <><b>UnHealthyHostCount</b> — 증가 시 헬스체크 실패 원인 조사(앱 크래시, 헬스체크 경로 오류, 시작 지연).</>,
    ]},
    { title: '⑤ 용량 / 스로틀', items: [
      <><b>ConsumedLCUs</b>(요금·용량 산정, 급증 감지), ProcessedBytes.</>,
      <><b>TargetConnectionErrorCount</b> — ALB→타깃 연결 실패. 네트워크/보안그룹/타깃 포트 문제 신호.</>,
    ]},
    { title: '⑥ 기타 상황별', items: [
      <><b>RequestCountPerTarget</b> — 부하 분산 불균형 감지. HTTP_Redirect/Fixed_Response_Count.</>,
      <>DesyncMitigationMode_NonCompliant_Request_Count(HTTP desync 위험), GrpcRequestCount(gRPC).</>,
    ]},
    { title: '증상별 진단 흐름', items: [
      <>502 급증 → 타깃 앱 크래시/커넥션 조기 종료, <b>keep-alive 타임아웃 불일치</b>(ALB idle timeout &gt; 백엔드 keep-alive면 발생) 점검.</>,
      <>503 급증 → <b>HealthyHostCount</b> 확인, 헬스체크 실패 원인 조사.</>,
      <>504 급증 → 백엔드 느림(TargetResponseTime) + ALB idle timeout 설정.</>,
      <>간헐적 5xx인데 Target은 2xx → LB 레벨 문제: <b>RejectedConnectionCount / TargetConnectionErrorCount</b> 확인.</>,
      <>원인 불명 → <b>액세스 로그(S3)</b>로 개별 요청의 elb_status_code vs target_status_code, request/target/response_processing_time 분해 — 지연이 LB 큐잉인지 백엔드인지 정확히 구분.</>,
    ]},
  ],
  priorityHeader: ['메트릭', '주의 기준', '의미'],
  priority: [
    ['HTTPCode_ELB_5XX_Count', '급증', 'LB↔타깃 문제(502/503/504로 세분)'],
    ['HTTPCode_Target_5XX_Count', '급증', '백엔드 앱 오류'],
    ['TargetResponseTime (p99)', '급증', '백엔드 성능 저하'],
    ['HealthyHostCount', '낮음/0', '가용 타깃 부족 → 503'],
    ['UnHealthyHostCount', '> 0', '헬스체크 실패'],
    ['RejectedConnectionCount', '> 0', '연결 한도 도달'],
    ['TargetConnectionErrorCount', '> 0', '타깃 연결 실패(네트워크/SG)'],
  ],
};

export const NLB_GUIDE: GuideSpec = {
  service: 'NLB',
  intro: (
    <>NLB는 <b>L4(TCP/UDP/TLS)</b>에서 동작해 ALB와 관점이 다릅니다 — HTTP 응답 코드가 없고
    <b> 연결(플로우) · 리셋(RST) · 타깃 헬스 · 처리량 · 용량(LCU)</b>을 중심으로 봅니다.
    CloudWatch 메트릭이 제한적이라 <b>RST 카운트와 타깃 헬스가 진단의 핵심</b>입니다.</>
  ),
  sections: [
    { title: '① 연결(플로우) 수', items: [
      <><b>ActiveFlowCount</b> — 활성 플로우(TCP 기준). 급증/급감으로 트래픽 이상 감지. <b>NewFlowCount</b>는 연결 수립률.</>,
      <>프로토콜별 분해: ActiveFlowCount_TCP/_UDP/_TLS, NewFlowCount_TCP/_UDP/_TLS. <b>ConsumedLCUs</b>(_TCP/_UDP/_TLS)는 용량·요금 산정.</>,
    ]},
    { title: '② 리셋(RST) — NLB 진단의 핵심', items: [
      <><b>TCP_Target_Reset_Count</b> — 타깃이 보낸 RST: 백엔드가 연결을 끊음(앱 크래시, 포트 닫힘, 백로그 초과). <b>급증 = 백엔드 문제 강한 신호.</b></>,
      <><b>TCP_ELB_Reset_Count</b> — NLB가 생성한 RST: 유휴 타임아웃 초과 등. <b>TCP_Client_Reset_Count</b> — 클라이언트발.</>,
      <><b>핵심 구분</b>: Target RST 급증 → 백엔드 문제, ELB RST 급증 → NLB 레벨(주로 <b>idle timeout 350초</b>) 또는 비대칭 라우팅.</>,
    ]},
    { title: '③ 타깃 헬스 — 가용성 (타깃 그룹 차원)', items: [
      <><b>HealthyHostCount</b>(0에 가까우면 위험) / <b>UnHealthyHostCount</b>(증가 시 헬스체크 실패 조사).</>,
      <>NLB는 액티브(TCP/HTTP/HTTPS) 헬스체크 + 자체 판단이 섞임 — 대상 그룹의 헬스체크 설정(프로토콜/포트/경로)도 함께 점검.</>,
    ]},
    { title: '④ 처리량·바이트', items: [
      <><b>ProcessedBytes</b>(_TCP/_UDP/_TLS), ProcessedPackets.</>,
    ]},
    { title: '⑤ TLS (TLS 리스너 사용 시)', items: [
      <><b>Client/TargetTLSNegotiationErrorCount</b>, TLSNegotiationErrorCount — 협상 실패.</>,
    ]},
    { title: '⑥ 용량 한계·기타', items: [
      <><b>PortAllocationErrorCount</b> — 클라이언트 IP 보존 + PrivateLink/SNAT 상황의 소스 포트 고갈. <b>0보다 크면 연결 실패 발생 — 놓치기 쉬운 원인.</b></>,
      <>PeakPackets/BytesPerSecond, <b>UnhealthyRoutingFlowCount</b>(정상 타깃이 없어 라우팅 실패 — 페일오버 오픈 관련).</>,
    ]},
    { title: '증상별 진단 흐름', items: [
      <>간헐적 연결 끊김 → <b>Target RST(백엔드) vs ELB RST(idle timeout 350초 초과)</b> 구분, keep-alive 설정 점검.</>,
      <>연결 자체가 안 됨 → HealthyHostCount + 보안그룹/NACL/타깃 포트. <b>NLB는 클라이언트 IP를 보존하므로 타깃 SG가 클라이언트 IP를 허용해야 함 — 흔한 함정.</b></>,
      <>부하 높을 때 연결 실패 → <b>PortAllocationErrorCount</b>(SNAT 포트 고갈).</>,
      <>TLS 리스너 오류 → Client/TargetTLSNegotiationErrorCount.</>,
    ]},
    { title: 'ALB와 다른 주의점', items: [
      <>L4라 <b>애플리케이션 레벨 지연/에러를 못 봄</b> — HTTP 문제는 타깃(백엔드) 메트릭·로그로.</>,
      <><b>VPC Flow Logs</b>가 트러블슈팅에 매우 유용(연결 수락/거부, 클라이언트 IP 추적). NLB 자체 액세스 로그는 <b>TLS 리스너에서만</b> 제공.</>,
      <>클라이언트 IP 보존 특성 때문에 <b>타깃 보안그룹 규칙</b>이 자주 원인.</>,
    ]},
  ],
  priorityHeader: ['메트릭', '주의 기준', '의미'],
  priority: [
    ['HealthyHostCount', '낮음/0', '가용 타깃 부족'],
    ['UnHealthyHostCount', '> 0', '헬스체크 실패'],
    ['TCP_Target_Reset_Count', '급증', '백엔드가 연결 리셋'],
    ['TCP_ELB_Reset_Count', '급증', 'NLB 리셋(idle timeout 등)'],
    ['PortAllocationErrorCount', '> 0', 'SNAT 소스 포트 고갈'],
    ['ActiveFlowCount', '이상 추세', '트래픽/연결 이상'],
    ['TargetTLSNegotiationErrorCount', '> 0', '타깃 TLS 문제'],
  ],
};

export const S3_GUIDE: GuideSpec = {
  service: 'S3',
  intro: (
    <>S3는 무제한 확장되는 관리형 스토리지라 "용량 포화" 개념이 없고, 대신 <b>스토리지 사용량 ·
    요청 성능/에러 · 복제 · 데이터 보호</b>를 봅니다. CloudWatch 메트릭이 <b>스토리지 메트릭(무료,
    일 1회)</b>과 <b>요청 메트릭(유료, 1분 — 버킷/프리픽스별로 활성화해야 존재)</b> 두 종류로
    나뉜다는 점이 중요합니다.</>
  ),
  sections: [
    { title: '① 스토리지 메트릭 (기본, 무료 — 일 1회 집계)', items: [
      <><b>BucketSizeBytes</b> — 스토리지 클래스별(StandardStorage/StandardIAStorage/GlacierStorage…)로 분해해야 비용/라이프사이클 진단에 유용.</>,
      <><b>NumberOfObjects</b> — 급증/급감으로 이상 감지, 요청 비용 산정. 하루 한 번 집계라 실시간용이 아닌 <b>추세·비용 관점.</b></>,
    ]},
    { title: '② 요청 메트릭 (활성화 필요, 1분) — 성능 진단 핵심', items: [
      <><b>4xxErrors</b> — 403 권한/404 경로 등. 급증 시 정책·키 경로 문제. <b>5xxErrors</b> — 500/503 SlowDown, S3 측 이슈 또는 요청률 초과.</>,
      <><b>503 SlowDown</b> — 프리픽스당 요청률 한도(<b>초당 3,500 write / 5,500 read per prefix</b>) 초과 = 핫 프리픽스 신호.</>,
      <><b>FirstByteLatency</b>(S3 처리 지연) vs <b>TotalRequestLatency</b>(전체 — 큰 객체면 자연히 큼) 구분.</>,
      <>AllRequests/Get/Put/Delete/Head/List, BytesDownloaded/Uploaded — 트래픽 기준선.</>,
    ]},
    { title: '③ 복제 (CRR/SRR 사용 시)', items: [
      <><b>ReplicationLatency</b> — RTC 사용 시 SLA(15분) 대비. <b>BytesPendingReplication / OperationsPendingReplication</b> 증가 추세 = 복제 병목.</>,
      <><b>OperationsFailedReplication</b> — 0보다 크면 권한/설정 문제 조사.</>,
    ]},
    { title: '④ 데이터 보호·수명주기·기타', items: [
      <><b>Storage Lens</b> — 계정/조직 전반 가시성: 불완전 멀티파트 업로드, 비현재 버전 누적 등 비효율 진단의 핵심 도구.</>,
      <>S3 Storage Class Analysis — 라이프사이클 최적화 진단.</>,
    ]},
    { title: '증상별 진단 흐름', items: [
      <>간헐적 503 SlowDown → <b>핫 프리픽스</b>: 키 네임스페이스를 프리픽스로 분산(랜덤/해시), 프리픽스별 요청 메트릭으로 어느 프리픽스가 뜨거운지 확인.</>,
      <>403 급증 → 버킷 정책/IAM/ACL/Block Public Access/KMS 키 권한 점검. <b>CloudTrail 데이터 이벤트</b>로 거부된 주체·오퍼레이션 추적.</>,
      <>지연 급증 → FirstByteLatency vs TotalRequestLatency 구분(S3 처리 vs 객체 크기/네트워크). Transfer Acceleration·멀티파트·리전 근접성 검토.</>,
      <>복제 지연/실패 → OperationsPendingReplication 추세 + OperationsFailedReplication + 복제 룰/권한.</>,
      <>원인 불명 접근/삭제 → <b>서버 액세스 로그 / CloudTrail 데이터 이벤트</b>로 개별 요청(요청자·오퍼레이션·응답 코드·지연) 분해.</>,
    ]},
    { title: 'S3만의 특이점', items: [
      <>실시간 성능 진단은 <b>요청 메트릭을 먼저 켜야</b> 합니다(기본 비활성, 유료) — 안 켜면 4xx/5xx/Latency가 안 보입니다(아래 테이블의 '—').</>,
      <>개별 요청 추적은 CloudWatch가 아니라 <b>서버 액세스 로그 / CloudTrail 데이터 이벤트</b>의 몫.</>,
      <>비용·수명주기 최적화는 <b>Storage Lens</b>가 핵심 도구.</>,
    ]},
  ],
  priorityHeader: ['메트릭', '주의 기준', '의미'],
  priority: [
    ['5xxErrors', '급증', 'S3 측 오류 또는 요청률 초과(503 SlowDown)'],
    ['4xxErrors', '급증', '권한/경로/요청 오류'],
    ['FirstByteLatency', '급증', 'S3 처리 지연'],
    ['OperationsFailedReplication', '> 0', '복제 실패'],
    ['ReplicationLatency', 'SLA 초과', '복제 지연'],
    ['BucketSizeBytes', '이상 급증', '비용/이상 업로드'],
    ['NumberOfObjects', '이상 급증/급감', '대량 삭제/생성'],
  ],
};

export const EBS_GUIDE: GuideSpec = {
  service: 'EBS',
  intro: (
    <>EBS는 <b>IOPS · 처리량 · 지연 · 큐 깊이 · 버스트/성능 크레딧</b>을 중심으로 봅니다. 핵심은
    <b> 볼륨이 프로비저닝한 성능 한계에 걸렸는지, 인스턴스 쪽 EBS 대역폭에 걸렸는지 구분</b>하는
    것입니다 — 둘은 별개의 한계입니다.</>
  ),
  sections: [
    { title: '① IOPS (작업 수)', items: [
      <><b>VolumeReadOps / VolumeWriteOps</b> — 기간 합계라 <b>기간(초)으로 나눠야 IOPS</b>(5분 집계면 /300). 프로비저닝 IOPS(gp3/io1/io2) 또는 baseline(gp2 = 3 IOPS/GB) 대비 확인.</>,
      <>합산 IOPS가 프로비저닝 한계에 붙어 있으면 → 볼륨이 병목.</>,
    ]},
    { title: '② 처리량 (Throughput)', items: [
      <><b>VolumeReadBytes / VolumeWriteBytes</b> — MB/s로 환산해 처리량 한계 대비. <b>gp3는 IOPS와 처리량을 독립 프로비저닝</b>하므로 둘 다 따로 봐야 함.</>,
    ]},
    { title: '③ 지연 (Latency) — I/O 병목 판단', items: [
      <><b>VolumeTotalRead/WriteTime</b> — 작업당 평균 지연 = <b>TotalTime / Ops</b>.</>,
      <>지연이 높은데 IOPS/처리량은 한계 미달 → I/O 크기가 크거나 랜덤 액세스 패턴 문제.</>,
    ]},
    { title: '④ 큐 깊이 — 포화 신호', items: [
      <><b>VolumeQueueLength</b> — 대기 중인 I/O 요청 수. <b>가장 직관적인 포화 지표.</b> 지속적으로 높으면 볼륨이 요청을 못 따라가는 중 (지연 급증과 동반).</>,
    ]},
    { title: '⑤ 유휴·사용률', items: [
      <>VolumeIdleTime, <b>VolumeThroughputPercentage</b>(io1/io2 전용 — 프로비저닝 대비 실제 제공 비율, 100% 미만 지속 = 성능 저하), VolumeConsumedReadWriteOps.</>,
    ]},
    { title: '⑥ 버스트/성능 크레딧 — 놓치기 쉬운 병목', items: [
      <><b>BurstBalance</b> — gp2·st1·sc1 전용 크레딧 잔량(%). 0에 수렴하면 baseline으로 강등 → 간헐적 성능 저하. <b>gp2 원인 불명 성능 저하의 흔한 범인.</b></>,
      <>gp3/io1/io2는 버스트 개념 없음 — <b>gp2→gp3 마이그레이션으로 해결</b>하는 경우가 많음.</>,
    ]},
    { title: '⑦ 인스턴스 레벨 — EBS 대역폭 한계', items: [
      <>볼륨은 여유로운데 느리면 인스턴스 쪽을 의심: <b>EBSIOBalance% / EBSByteBalance%</b>(소형 인스턴스의 EBS 버스트 잔량) — 0에 수렴하면 인스턴스 baseline으로 강등 → <b>볼륨이 아무리 커도 병목.</b></>,
      <>EBSRead/WriteOps·Bytes — 인스턴스 타입별 EBS 대역폭 상한 대비 확인.</>,
    ]},
    { title: '증상별 진단 흐름', items: [
      <>간헐적/주기적 성능 저하 → <b>BurstBalance(gp2) 또는 EBSIOBalance%(소형 인스턴스) 크레딧 고갈</b> — EBS 성능 문제의 1순위 원인.</>,
      <>지연 높음 + IOPS/처리량 한계 미달 → I/O 크기·랜덤성 또는 인스턴스 대역폭. VolumeQueueLength + 인스턴스 EBS balance 함께 확인.</>,
      <>볼륨은 여유로운데 느림 → 인스턴스 EBSByte/IOBalance% + 인스턴스 타입 EBS 상한 점검 (타입 상향 필요할 수 있음).</>,
      <>IOPS가 프로비저닝 한계에 붙음 → gp3 IOPS/처리량 상향, io2 전환, 볼륨 분산(RAID 0)/앱 캐싱 검토.</>,
    ]},
    { title: 'EBS만의 주의점', items: [
      <>CloudWatch 원시값은 <b>기간 합계 — 나눠서 환산해야 실제 IOPS/지연</b>이 됩니다.</>,
      <>gp2의 3 IOPS/GB baseline + 버스트 모델 → <b>작은 gp2 볼륨의 크레딧 고갈</b>이 단골 원인. 대개 gp3 전환이 답.</>,
      <><b>볼륨 성능과 인스턴스 EBS 대역폭은 별개 한계</b> — 둘 다 봐야 병목을 정확히 짚습니다.</>,
    ]},
  ],
  priorityHeader: ['메트릭', '주의 기준', '의미'],
  priority: [
    ['VolumeQueueLength', '지속적 높음', '볼륨 포화(I/O 대기)'],
    ['BurstBalance (gp2/st1/sc1)', '0 근접', '크레딧 고갈 → baseline 강등'],
    ['평균 지연 (TotalTime/Ops)', '급증', 'I/O 병목'],
    ['VolumeReadOps+WriteOps (환산 IOPS)', '프로비저닝 근접', 'IOPS 한계'],
    ['VolumeThroughputPercentage (io1/io2)', '< 100%', '프로비저닝 성능 미달'],
    ['EBSIOBalance%/EBSByteBalance%', '0 근접', '인스턴스 EBS 대역폭 강등'],
  ],
};

export const EC2_GUIDE: GuideSpec = {
  service: 'EC2',
  intro: (
    <>EC2는 <b>CPU · 네트워크 · EBS I/O · 상태 점검(status check) · 버스터블 크레딧</b>을 기본으로
    봅니다. 가장 중요한 특이점: <b>메모리와 디스크 사용률은 기본 CloudWatch 메트릭에 없습니다</b>
    (하이퍼바이저 밖을 못 봄) — 이 둘은 CloudWatch Agent를 설치해야 합니다.</>
  ),
  sections: [
    { title: '① CPU', items: [
      <><b>CPUUtilization</b> — 지속 80% 초과 시 확장/타입 변경 검토. 하이퍼바이저 관점이라 vCPU steal 등 게스트 내부는 못 봄.</>,
      <><b>CPUCreditBalance / CPUCreditUsage</b> — T계열 전용. 0 수렴 시 baseline 강등(Standard) 또는 추가 과금(Unlimited). <b>원인 불명 성능 저하의 단골 범인.</b> CPUSurplusCreditsCharged는 Unlimited 초과 과금.</>,
    ]},
    { title: '② 상태 점검 (Status Checks) — 가용성 진단 핵심', items: [
      <><b>StatusCheckFailed_System</b> — AWS 인프라 문제(호스트 하드웨어/네트워크/전원). 대응: <b>stop/start</b>(다른 호스트로 이동).</>,
      <><b>StatusCheckFailed_Instance</b> — 인스턴스 내부 문제(OS 부팅/파일시스템/네트워크 설정/커널). 대응: OS 조사/재부팅.</>,
      <><b>StatusCheckFailed_AttachedEBS</b> — 연결 EBS가 I/O에 응답 못 함.</>,
      <>이 구분이 <b>"AWS 문제냐 내 OS 문제냐"</b>를 즉시 갈라줍니다. 자동 복구는 CloudWatch 알람 + EC2 auto-recovery.</>,
    ]},
    { title: '③ 네트워크', items: [
      <><b>NetworkIn/Out</b>(대역폭 상한 대비), <b>NetworkPacketsIn/Out</b>(PPS 상한 감지).</>,
      <>대역폭/PPS/conntrack 상한 초과는 기본 메트릭에 안 나옴 — <b>네트워크 성능 메트릭(ethtool, CloudWatch Agent)</b>의 bw_in/out_allowance_exceeded, pps_allowance_exceeded, conntrack_allowance_exceeded로 봐야 정확. <b>놓치기 쉬운 병목.</b></>,
    ]},
    { title: '④ EBS I/O (인스턴스 관점)', items: [
      <>EBSRead/WriteOps·Bytes — 인스턴스↔EBS I/O.</>,
      <><b>EBSIOBalance% / EBSByteBalance%</b> — 소형 인스턴스의 EBS 버스트 잔량. 0 수렴 시 인스턴스 baseline 강등 → <b>볼륨이 커도 병목</b> (EBS 진단과 연결).</>,
    ]},
    { title: '⑤ CloudWatch Agent 필요 (기본 미제공) — 실무 필수', items: [
      <><b>메모리</b>(mem_used_percent 등) — EC2 성능 문제의 상당수가 메모리인데 기본 메트릭에 없음.</>,
      <><b>디스크</b>(disk_used_percent, diskio_*) — 루트/데이터 볼륨 고갈 감지. <b>스왑</b>(swap_used_percent), 게스트 관점 CPU(steal 포함), 프로세스.</>,
      <>세밀한 진단에는 CloudWatch Agent 설치가 사실상 필수.</>,
    ]},
    { title: '증상별 진단 흐름', items: [
      <>인스턴스 응답 없음 → <b>상태 점검부터</b>: System 실패면 AWS 측(stop/start 이전), Instance 실패면 OS 조사(시스템 로그/스크린샷).</>,
      <>간헐적/주기적 성능 저하 → T계열이면 <b>CPUCreditBalance 고갈 1순위</b>, 다음 EBSIOBalance%.</>,
      <>CPU는 낮은데 느림 → 메모리/스왑(Agent), 디스크 I/O, 네트워크 allowance 초과 확인.</>,
      <>네트워크 처리량 정체 → 타입 대역폭 상한 + *_allowance_exceeded 확인, 타입 상향 검토.</>,
    ]},
    { title: 'EC2만의 주의점', items: [
      <><b>메모리·디스크는 기본 메트릭에 없음 → CloudWatch Agent 필수.</b> "메모리 메트릭이 왜 없지?"의 답.</>,
      <>상태 점검 <b>System vs Instance</b> 구분 = 책임 소재(AWS vs 사용자)를 즉시 가르는 핵심 진단 포인트.</>,
      <>버스터블(T) 크레딧·소형 인스턴스의 EBS/네트워크 버스트가 원인 불명 성능 문제의 단골 — T/소형이면 우선 의심.</>,
      <>심층 조사: CloudWatch Logs, EC2 시스템 로그/스크린샷, Compute Optimizer(라이트사이징).</>,
    ]},
  ],
  priorityHeader: ['메트릭', '주의 기준', '의미'],
  priority: [
    ['StatusCheckFailed_System', '= 1', 'AWS 인프라 문제 → stop/start'],
    ['StatusCheckFailed_Instance', '= 1', 'OS/인스턴스 내부 문제'],
    ['CPUUtilization', '> 80% 지속', '컴퓨트 병목'],
    ['CPUCreditBalance (T계열)', '0 근접', '크레딧 고갈 → 강등/과금'],
    ['mem_used_percent (Agent)', '높음', '메모리 압박'],
    ['disk_used_percent (Agent)', '> 85%', '디스크 고갈'],
    ['EBSIOBalance%/EBSByteBalance%', '0 근접', 'EBS 대역폭 강등'],
    ['bw/pps/conntrack_allowance_exceeded (Agent)', '> 0', '네트워크 상한 병목'],
  ],
};

export const LAMBDA_GUIDE: GuideSpec = {
  service: 'Lambda',
  intro: (
    <>Lambda는 <b>호출 · 에러 · 스로틀 · 실행 시간 · 동시성</b>을 중심으로 봅니다. 서버리스라
    인프라 메트릭은 없고, 실행 단위의 성공/실패/지연/용량에 집중합니다.</>
  ),
  sections: [
    { title: '① 호출과 에러 — 진단의 출발점', items: [
      <><b>Invocations</b>(트래픽 기준선), <b>Errors</b>(핸들러 예외·타임아웃). <b>에러율 = Errors / Invocations</b>로 봐야 의미 있음 — 절대값만 보면 트래픽 증가와 구분 불가.</>,
      <><b>DeadLetterErrors</b> — DLQ 전달 실패(비동기). 0보다 크면 실패 이벤트가 유실 중일 수 있음. <b>DestinationDeliveryFailures</b>도 동류.</>,
    ]},
    { title: '② 스로틀 — 동시성 한계', items: [
      <><b>Throttles</b> — 동시성 한도 초과 429. <b>가장 흔한 스케일 문제.</b> 원인: 계정 리전 한도(기본 1,000), reserved concurrency 설정, 급격한 버스트.</>,
    ]},
    { title: '③ 실행 시간 (Duration)', items: [
      <><b>Duration</b> — <b>p50/p90/p99 백분위로</b> (평균은 콜드스타트·롱테일을 숨김). <b>타임아웃 설정에 근접</b>하면 타임아웃 에러 위험.</>,
      <>PostRuntimeExtensionsDuration — 확장(extension) 오버헤드 확인.</>,
    ]},
    { title: '④ 동시성 (Concurrency)', items: [
      <><b>ConcurrentExecutions</b> — 계정/함수 한도 대비. 근접 시 스로틀 임박. UnreservedConcurrentExecutions는 reserved 제외 풀.</>,
    ]},
    { title: '⑤ 프로비저닝된 동시성 (PC)', items: [
      <><b>ProvisionedConcurrencyUtilization</b> 100% 근접 = PC 부족. <b>ProvisionedConcurrencySpilloverInvocations &gt; 0</b> = PC 초과분이 on-demand 콜드스타트로 넘어가는 중.</>,
    ]},
    { title: '⑥ 이벤트 소스별 (스트림/큐)', items: [
      <><b>IteratorAge</b> — Kinesis/DynamoDB Streams 소비의 핵심. 계속 증가하면 Lambda가 프로듀서를 못 따라감 → 배치 크기/ParallelizationFactor/함수 성능 조정.</>,
      <><b>OffsetLag</b>(Kafka/MSK 소스), SQS면 ApproximateAgeOfOldestMessage 병행, 비동기면 AsyncEventsReceived/Age/Dropped.</>,
    ]},
    { title: '⑦ 콜드스타트', items: [
      <>직접 메트릭 없음 — CloudWatch Logs의 <b>INIT_START / Init Duration</b> 또는 X-Ray로 확인. Duration p99 급증 + PC 스필오버와 함께 진단.</>,
    ]},
    { title: '증상별 진단 흐름', items: [
      <>429 거부 → <b>Throttles + ConcurrentExecutions vs 한도</b>. reserved 상향/계정 한도 증설/버스트 완화.</>,
      <>간헐적 느림 → <b>Duration p99 + Init Duration</b>(로그). PC 도입, <b>메모리 상향(Lambda는 메모리↑=CPU↑)</b>, 패키지 경량화.</>,
      <>에러율 상승 → 로그 예외 스택. 타임아웃이면 Duration이 설정값에 붙어 있는지 확인.</>,
      <>스트림 밀림 → IteratorAge 지속 증가 → 배치/병렬화/함수 성능/다운스트림 병목.</>,
      <>비동기 유실 → DeadLetterErrors / AsyncEventsDropped + DLQ 설정.</>,
    ]},
    { title: 'Lambda만의 주의점', items: [
      <><b>메모리 설정이 곧 성능</b> — 메모리↑=CPU·네트워크↑로 Duration이 줄기도. Max Memory Used(로그 리포트)로 라이트사이징, <b>Lambda Power Tuning</b> 유용.</>,
      <>에러율은 반드시 <b>Invocations 대비 비율</b>로.</>,
      <>심층 진단: <b>CloudWatch Logs Insights</b>(에러 패턴·Init Duration·Max Memory Used 집계) + <b>X-Ray</b>(콜드스타트·다운스트림 분해). <b>Lambda Insights</b>를 켜면 CPU/메모리/네트워크 실행 환경 메트릭까지.</>,
    ]},
  ],
  priorityHeader: ['메트릭', '주의 기준', '의미'],
  priority: [
    ['Errors (에러율)', '급증', '예외/타임아웃'],
    ['Throttles', '> 0', '동시성 한도 초과(429)'],
    ['Duration (p99)', '타임아웃 근접', '성능 저하/타임아웃 위험'],
    ['ConcurrentExecutions', '한도 근접', '스로틀 임박'],
    ['IteratorAge (스트림)', '증가 추세', '컨슈머 처리 지연'],
    ['ProvisionedConcurrencySpilloverInvocations', '> 0', 'PC 부족 → 콜드스타트'],
    ['DeadLetterErrors', '> 0', '실패 이벤트 유실 위험'],
  ],
};

export const EKS_GUIDE: GuideSpec = {
  service: 'EKS',
  intro: (
    <>EKS는 다른 서비스보다 계층이 많습니다 — <b>컨트롤 플레인(API 서버/etcd) · 노드(워커) · 파드/워크로드 ·
    스케일링</b>을 층별로 봐야 하고, 메트릭 출처도 CloudWatch 하나가 아니라 <b>Container Insights ·
    컨트롤 플레인 로그 · Prometheus/kube-state-metrics</b> 등 여러 곳입니다.</>
  ),
  sections: [
    { title: '메트릭 출처 먼저 정리', items: [
      <>EKS 컨트롤 플레인 → CloudWatch 컨트롤 플레인 로깅 + 일부 CloudWatch 메트릭 (이 대시보드: {code('AWS/EKS')} 네임스페이스).</>,
      <>노드/파드/컨테이너 → <b>CloudWatch Container Insights</b>(에이전트 필요) 또는 Prometheus (이 대시보드: {code('ContainerInsights')} 네임스페이스 + 인-클러스터 API).</>,
      <>쿠버네티스 오브젝트 상태(Deployment, ReplicaSet 등) → kube-state-metrics. 노드 OS 레벨 → node_exporter / CloudWatch agent.</>,
    ]},
    { title: '① 컨트롤 플레인 (API 서버 / etcd) — 관리형이지만 부하 지표는 봐야 함', items: [
      <><b>apiserver_request_duration_seconds</b> — API 서버 요청 지연. 급증하면 컨트롤 플레인 과부하.</>,
      <><b>apiserver_request_total</b> (코드별) — <b>429(스로틀), 5xx 비율</b>.</>,
      <><b>etcd_db_total_size_in_bytes</b> — etcd DB 크기. 한계(기본 상한 8GB)에 근접하면 쓰기 거부·클러스터 마비 위험. 오브젝트/시크릿 과다 누적 감지.</>,
      <><b>apiserver_current_inflight_requests</b> — 진행 중 요청. 우선순위/공정성(APF) 스로틀 확인.</>,
      <>컨트롤 플레인 로그(api, audit, authenticator, controllerManager, scheduler)는 문제 원인 추적에 필수.</>,
    ]},
    { title: '② 노드 (워커) 레벨 — Container Insights', items: [
      <><b>node_cpu_utilization / node_memory_utilization</b> — 노드 CPU/메모리 사용률. 메모리는 OOM/eviction 진단 핵심.</>,
      <><b>node_filesystem_utilization</b> — 노드 디스크(특히 /var/lib 이미지/로그). <b>85% 넘으면 DiskPressure로 파드 축출.</b></>,
      <><b>node_status_condition</b> (Ready, MemoryPressure, DiskPressure, PIDPressure) — 노드 상태 조건 (이 대시보드: 인-클러스터 조회).</>,
      <><b>cluster_node_count / cluster_failed_node_count</b> — 노드 수/실패 노드, <b>node_network_total_bytes</b>.</>,
    ]},
    { title: '③ 파드 / 워크로드 — Container Insights', items: [
      <><b>pod_cpu_utilization_over_pod_limit</b> — limit 대비 사용률. limit 초과 시 CPU 스로틀링.</>,
      <><b>pod_memory_utilization_over_pod_limit</b> — limit 근접 시 OOMKilled 위험.</>,
      <><b>pod_number_of_container_restarts</b> — 컨테이너 재시작 수. 급증하면 CrashLoopBackOff / OOMKill 신호. <b>가장 중요한 이상 지표 중 하나.</b></>,
      <><b>pod_status_ready / running / pending / failed</b>, kube-state-metrics의 {code('kube_pod_container_status_last_terminated_reason')}으로 OOMKilled 여부.</>,
      <><b>kube_pod_status_phase</b> — Pending이 쌓이면 스케줄링 실패(리소스 부족, taint, PV 미할당).</>,
    ]},
    { title: '④ 스케줄링 / 스케일링', items: [
      <><b>Pending 파드 수</b> — 스케줄 안 되는 파드. Cluster Autoscaler / Karpenter가 노드를 못 붙이는지, 리소스 request 과다인지 진단.</>,
      <>Cluster Autoscaler: {code('cluster_autoscaler_unschedulable_pods_count')} · Karpenter: 프로비저닝/드리프트/consolidation 메트릭.</>,
      <>HPA: {code('kube_horizontalpodautoscaler_status_current_replicas')} vs desired — 스케일 목표 도달 여부.</>,
      <><b>리소스 예약 vs 실제</b>: request 합계 vs 노드 allocatable — request 과다 예약으로 노드가 "논리적으로 꽉 찬" 상황 감지 (이 대시보드: reserved capacity 컬럼).</>,
    ]},
    { title: '⑤ 네트워크 / 애드온', items: [
      <><b>VPC CNI IP 고갈</b> — 서브넷 IP 소진, ENI당 IP 한계로 파드가 IP를 못 받아 Pending. {code('aws_eni_allocated')} 등 awscni/ipamd 메트릭 확인. <b>EKS에서 흔한 함정</b> (이 대시보드: 노드 상세의 ENI IP 슬롯 바).</>,
      <><b>CoreDNS 지연/에러</b> — DNS 문제는 광범위한 장애로 번짐. {code('coredns_dns_request_duration_seconds')}, 실패율.</>,
      <>kube-proxy, 로드밸런서 컨트롤러 상태 (이 대시보드: 애드온 상태 표).</>,
    ]},
    { title: '증상별 진단 흐름', items: [
      <>파드가 계속 재시작 → <b>container_restarts + last_terminated_reason</b>(OOMKilled인지) + limit 대비 메모리. OOM이면 limit 상향 or 앱 메모리 누수 조사. 로그·{code('kubectl describe')}로 확인.</>,
      <>파드가 Pending → {code('kubectl describe pod')} 이벤트 확인. 원인은 대개 ①리소스 부족(스케일링 필요) ②VPC CNI IP 고갈 ③taint/affinity ④PV 미할당 중 하나.</>,
      <>노드가 NotReady → node condition(Pressure), kubelet 상태, 노드 OS 레벨(디스크/메모리).</>,
      <>간헐적 API 오류/느린 배포 → 컨트롤 플레인 지연·429, APF 스로틀, etcd 크기 확인.</>,
      <>DNS 관련 광범위 장애 → CoreDNS 메트릭·로그, 레플리카 수.</>,
    ]},
    { title: 'EKS만의 주의점', items: [
      <><b>Container Insights를 켜야</b> 노드/파드/컨테이너 메트릭이 CloudWatch에 들어옵니다(기본 미제공). 또는 AMP(Amazon Managed Prometheus) + kube-state-metrics/node_exporter 조합.</>,
      <>CloudWatch 메트릭만으로는 부족한 경우가 많아, 실무에선 <b>Prometheus + Grafana</b>(또는 AMP/AMG)로 쿠버네티스 네이티브 메트릭을 보는 게 일반적입니다.</>,
      <>진단은 메트릭 + <b>kubectl (describe, logs, events, top)</b> + 컨트롤 플레인 로그를 함께 씁니다. 특정 파드/노드 문제는 결국 kubectl 이벤트가 결정적입니다.</>,
      <><b>VPC CNI IP 고갈</b>과 <b>리소스 request 과다 예약</b>은 EKS 특유의 Pending 원인이니 우선 의심 목록에 두세요.</>,
    ]},
  ],
  priorityHeader: ['메트릭', '주의 기준', '의미'],
  priority: [
    ['pod_number_of_container_restarts', '급증', 'CrashLoop/OOMKill'],
    ['pod_memory_utilization_over_pod_limit', '100% 근접', 'OOMKilled 위험'],
    ['node_status_condition (Pressure)', 'True', 'Disk/Memory/PID 압박 → 축출'],
    ['Pending 파드 수', '> 0 지속', '스케줄링/스케일링/IP 실패'],
    ['node_filesystem_utilization', '> 85%', 'DiskPressure'],
    ['apiserver_request_duration / 429', '급증', '컨트롤 플레인 과부하'],
    ['etcd_db_total_size_in_bytes', '한계 근접', 'etcd 포화'],
    ['VPC CNI IP 잔량', '낮음', '파드 IP 고갈'],
  ],
};

export const ANFW_GUIDE: GuideSpec = {
  service: 'ANFW',
  intro: (
    <>Network Firewall 모니터링은 <b>CloudWatch 지표 · 방화벽 로그(Alert/Flow/TLS) · 보완 소스
    (VPC Flow Logs, CloudTrail, 라우팅)</b> 세 계층을 함께 봅니다 — 지표는 볼륨과 추이,
    로그는 &ldquo;어떤 규칙이 어떤 트래픽을&rdquo;의 컨텍스트, 보완 소스는 우회·변경을 잡습니다.</>
  ),
  sections: [
    { title: '① CloudWatch 지표 (AWS/NetworkFirewall)', items: [
      <><b>ReceivedPackets / ReceivedBytes</b> — 전체 유입량·대역폭. 차원은 (FirewallName, AZ, Engine) —
      모든 패킷이 stateless 엔진을 먼저 통과하므로 <b>수신 집계는 Engine=Stateless만</b> 사용해야
      SFE 포워딩 분의 이중 집계를 피합니다 (이 화면의 집계 방식).</>,
      <><b>PassedPackets / DroppedPackets / RejectedPackets</b> — 통과/폐기/명시적 거부(TCP RST).
      차단 트래픽 급증은 공격 신호 또는 룰 오배치 신호 — Alert 로그로 어떤 룰인지 확인.</>,
      <><b>InvalidDroppedPackets / OtherDroppedPackets / StreamExceptionPolicyPackets</b> —
      비정상 패킷·기타 폐기·스트림 예외 처리. 지속 발생 시 비대칭 라우팅/세션 처리 이슈 의심.</>,
      <><b>TLS*Packets</b> (TLS 검사 사용 시) — 복호화 실패(TLSDropped/Rejected) 모니터링.</>,
      <>방화벽 <b>상태</b>는 CW 지표가 아닌 API(READY / IN_SYNC / AZ별 엔드포인트)로 확인 —
      이 화면 상단 테이블이 그 역할입니다. <b>CustomAction</b> 차원을 쓰면 규칙별 커스텀 지표도 가능.</>,
    ]},
    { title: '② 방화벽 로그 (S3 / CloudWatch Logs / Firehose)', items: [
      <><b>Alert 로그</b> — stateful 규칙의 alert/drop 매칭 트래픽. 어떤 규칙(sid)이 무엇을
      차단/경고했는지 — <b>보안 위협 분석의 핵심</b>. 아래 카드가 CloudWatch Logs 대상을 Insights로 집계.</>,
      <><b>Flow 로그</b> — stateful 엔진이 본 모든 플로우(5-tuple, 바이트/패킷, 세션 시작·종료).
      트래픽 패턴·Top talker 분석용.</>,
      <><b>TLS 로그</b> — TLS 검사 이벤트(SNI, 인증서, 오류).</>,
      <>로그에는 소스/목적지 IP·포트, 프로토콜, 규칙 매칭, 타임스탬프가 포함 — 지표만으로는
      알 수 없는 컨텍스트. <b>S3/Firehose 대상은 이 화면에서 집계 불가</b>(Athena 등 별도 분석).</>,
    ]},
    { title: '③ 보완 데이터 소스', items: [
      <><b>VPC Flow Logs</b> — 방화벽 엔드포인트 서브넷·라우팅 검증, <b>ANFW 우회 트래픽 탐지</b>.</>,
      <><b>CloudTrail</b> — 정책/룰 그룹 변경 관리 이벤트 감사 (누가 규칙을 바꿨는지) — 아래 변경 감사 카드.</>,
      <><b>Route Table</b> — 트래픽이 실제 방화벽 엔드포인트를 경유하는지 확인 (VPC 리소스 맵 참조).</>,
    ]},
    { title: '④ 분석 목적별 경로', items: [
      <><b>보안 위협 탐지</b> → Alert 로그 + DroppedPackets/RejectedPackets 급증.</>,
      <><b>용량/성능</b> → ReceivedPackets/Bytes 추이 + Flow 로그 Top talker.</>,
      <><b>가용성</b> → 방화벽 상태(READY/IN_SYNC) + AZ별 엔드포인트/지표 편차.</>,
      <><b>변경 감사/규정 준수</b> → CloudTrail 관리 이벤트 (write 이벤트 우선).</>,
    ]},
  ],
  priorityHeader: ['데이터', '목적', '핵심 신호'],
  priority: [
    ['Alert 로그 + Dropped/RejectedPackets', '보안 위협 탐지', '차단 급증 · 시그니처(sid) 매칭'],
    ['ReceivedPackets/Bytes + Flow 로그', '용량/성능', '트래픽 볼륨 추이 · Top talker'],
    ['방화벽 상태 + AZ별 지표', '가용성', 'READY/IN_SYNC · AZ 편차'],
    ['CloudTrail 관리 이벤트', '변경 감사', '누가 정책/룰을 바꿨는지'],
    ['VPC Flow Logs + 라우팅', '우회 탐지', '방화벽 미경유 트래픽'],
  ],
};
