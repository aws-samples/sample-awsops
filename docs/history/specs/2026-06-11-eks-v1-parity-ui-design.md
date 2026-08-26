# EKS v1-Parity UI — 리스트 카드 섹션 + 리소스 상태 + 탭별 차별화

**Date**: 2026-06-11
**Status**: Approved (scope: 리스트+상세 탭, user-selected)
**Driver**: 사용자 피드백 — "v1 `/k8s`처럼 card section 및 리소스 상태를 보여주면 좋겠어. 지금은 모든 리소스 탭이 똑같이 파이차트 하나에 리스트인데 v1의 UI가 훨씬 좋거든. CSS 제외하고는 v1이 마음에 드는 게 많아."

## 1. 문제

v2 `/eks`는 stats 6타일 + 플랫 DataTable 하나. v1 `/k8s`가 갖던 정보 밀도가 없다:
- 클러스터 **카드** (연결 배지·Version/VPC/Platform/Region·등록 액션이 한 카드에)
- **노드별 CPU/Memory 사용 바** (requested vs capacity, 임계값 색상)
- Pod Status 파이 + Pods per Namespace 바 차트
- **Warning Events** 테이블

v2 `/eks/[cluster]` 탭 4개(Nodes/Pods/Deployments/Services)는 전부 동일한 "검색+테이블" 한 가지 모양 — 차트/KPI 0개. v1 서브페이지는 탭(페이지)마다 다른 시각화를 가졌다(노드 리소스 바, 레플리카 비교 바, 상태 파이, 타입 파이).

## 2. 목표 / 비목표

**목표**
1. `/eks` 리스트를 v1 `/k8s` Overview 구성으로 재구축 (v2 paper+ink 디자인 시스템 유지)
2. `/eks/[cluster]` 탭마다 그 리소스에 맞는 KPI/시각화 추가 (탭별 차별화)
3. 전부 **read-only** (ADR-029 reversal 준수 — 클러스터 mutation 0)

**비목표 (이번 라운드 제외)**
- v1 노드 상세 뷰(ENI/IP 슬롯/CloudWatch 트래픽) — 백로그
- `/inventory/[type]` 타입별 차별화 (EC2 vCPU 합계, RDS 메트릭 등) — 별도 라운드
- OpenCost, kubeconfig 파일 관리

## 3. 설계

### 3.1 데이터 계층

**(a) Wave-1 cherry-pick**: `fdc9626` (feat/v2-opencost에 고립된 검증 완료 커밋)을 이 브랜치로 cherry-pick.
- `web/lib/eks-resources.ts` (신규): `parseCpuCores`/`parseMem`/`aggregateNodeResources`/`NodeResourceAgg` — client-safe (서버 import 없음)
- `web/lib/eks-incluster.ts`: NodeRow에 `cpuCapacity/cpuAllocatable/memCapacity/memAllocatable`, PodRow에 `cpuRequest/memRequest` 추가; 타입은 eks-resources에서 re-export
- `web/app/eks/[cluster]/page.tsx`: Nodes 탭에 "노드 리소스" Card (노드별 CPU/Mem Meter)
- 충돌: `web/lib/eks-incluster.test.ts` 1건 (양쪽 테스트 추가) — 수동 병합

**(b) `events` kind 추가** (`web/lib/eks-incluster.ts`):
- `Kind`에 `'events'` 추가, `KIND_PATH.events = '/api/v1/events?fieldSelector=type=Warning'` (Warning만 — v1 parity, 페이로드 절감)
- `EventRow { kind, object, reason, message, count, lastSeen }` + `normalizeEvent` (involvedObject.kind + name → object, `count ?? 1`, lastTimestamp/eventTime → age 포맷)
- 기존 BFF 라우트 `/api/eks/[cluster]/incluster?kind=events`가 자동으로 서빙 (isKind 통과). Events는 read-only core v1 리소스 — AmazonEKSAdminViewPolicy로 조회 가능.

**(c) 순수 탭 통계 헬퍼** (`web/lib/eks-tab-stats.ts`, 신규, client-safe):
- `podStatusCounts(rows) → {Running, Pending, Failed, Succeeded, ...}`
- `podsByNamespace(rows) → [{namespace, count}]` (내림차순)
- `deploymentHealth(rows) → [{name, namespace, desired, available, pct}]` (degraded 우선 정렬) — `ready: "2/3"` 문자열 파싱
- `serviceTypeCounts(rows) → {ClusterIP, NodePort, LoadBalancer, ...}`
- 전부 순수 함수 → vitest 단위 테스트

**(d) Fleet API** (`web/app/api/eks/fleet/route.ts`, 신규):
- 인증 → `getAllowedClusters()` → 클러스터별 `Promise.all` fan-out (nodes/pods/deployments/services/events)
- 응답: `{ clusters: [{ name, reachable, counts: {nodes, nodesReady, pods, podsRunning, deployments, services}, nodeAgg: NodeResourceAgg[], podStatus, podsByNamespace(top 10 — 클러스터별 pre-cap이라 교차 병합은 근사치, 허용), events(최신 25) }] }`
- **pod 원본 행은 클라이언트로 보내지 않는다** — 서버에서 집계 후 소형 페이로드만 (thin-BFF)
- 클러스터별 실패는 `reachable: false` + 0값으로 degrade (fleet 뷰는 절대 500 금지 — summary 패턴)
- 기존 `/api/eks/summary`는 그대로 둠 (다른 소비자 보호); `/eks` 페이지는 fleet으로 전환

### 3.2 `/eks` 리스트 페이지 (위→아래, v1 Overview 순서)

1. **헤더** — 기존 유지
2. **Stats 행** (6 StatTile): Clusters / Connected / Nodes(`N ready` trend) / Pods(`N running` trend) / Deployments / Services — fleet 응답에서 합산
3. **클러스터 카드 그리드** (`grid md:2 lg:3`, DataTable 대체): 카드당
   - 이름(mono; connected → `/eks/[name]` Link) + Status Badge + 연결 Badge(🟢 Connected/Entry 있음/미연결/확인 불가)
   - 2열 그리드: Version · Region · VPC · Platform
   - connected면 미니 카운트 행: `N nodes · N pods · N deploys`
   - 액션(기존 로직 그대로 이관): [조회 등록] [스크립트] [해제] — 가이드 패널(Copied! 포함) 유지
4. **노드 리소스 섹션** — 연결된 클러스터별 그룹: 노드당 1행 — mono 이름(+`N pods`) + CPU Meter(`req/alloc cores`) + Mem Meter(`req/alloc MiB`). fdc9626의 상세 페이지 렌더와 동일 패턴. 행 클릭 없음(상세는 클러스터 링크로).
5. **차트 행** (`grid md:2`): `DonutBreakdown` Pod Status(fleet 합산) + `BarDistribution` Pods per Namespace(fleet 합산 top 10)
6. **Warning Events** — fleet 병합(클러스터 컬럼 추가), lastSeen 내림차순, `DataTable` 컬럼: Cluster/Kind/Object/Reason/Message/Count/Last Seen. 0건이면 조용한 빈 상태.

연결된 클러스터가 0개면 4–6은 렌더하지 않음 (카드+가이드만 — 기존 온보딩 UX 보존).

### 3.3 `/eks/[cluster]` 탭별 차별화

| 탭 | 추가되는 것 (테이블 위) |
|----|------------------------|
| Nodes | (fdc9626) "노드 리소스" Card — 노드별 CPU/Mem Meter |
| Pods | StatTile 4개 (Total/Running/Pending/Failed) + `DonutBreakdown` 상태 분포 |
| Deployments | StatTile 3개 (Total/Fully available/Degraded) + **레플리카 비교 바** Card (deployment별 `available/desired` Meter, degraded 우선) |
| Services | StatTile 4개 (Total/ClusterIP/NodePort/LoadBalancer) + `DonutBreakdown` 타입 분포 |
| Events (신규 6번째 탭) | Warning events DataTable (Kind/Object/Reason/Message/Count/Last Seen) — kind=events |
| Diagnosis | 변경 없음 (ADR-035 surface 유지) |

KPI/차트는 **필터 적용 전 전체 행** 기준(요약은 전체를 말해야 함), 테이블만 검색/네임스페이스 필터 적용 — v1과 동일한 동작.

### 3.4 에러/빈 상태

- fleet 부분 실패: 실패 클러스터는 카드에 "조회 불가" 뱃지, 노드/차트 섹션에서 제외
- pods 보조 fetch 실패(nodes 탭): 기존 fdc9626 패턴 — viz 생략, 테이블은 정상
- events 404/403(이론상 권한 없음): 해당 클러스터 events만 빈 배열 degrade

## 4. 테스트 전략

- `eks-resources.test.ts` (cherry-pick에 포함) + `eks-incluster.test.ts` 병합 (normalizeEvent 추가)
- `eks-tab-stats.test.ts` — 4개 헬퍼 순수 단위 테스트
- `fleet/route.test.ts` — 401 / 정상 집계 / 클러스터 1개 실패 degrade
- 기존 393 테스트 무회귀, `tsc` clean, `make deploy` smoke

## 5. 보안/규율

- 전 변경 read-only (K8s GET only, AWS mutation 0) — ADR-029 reversal 준수
- 인증: 모든 신규 라우트 `verifyUser` 게이트 (기존 패턴)
- thin-BFF: pod 원본 fan-out 집계는 요청당 1회, 서버 집계 후 소형 응답. 클러스터 수가 커지면(>10) P4에서 워커/캐시 검토 — 현재 연결 1–3개
