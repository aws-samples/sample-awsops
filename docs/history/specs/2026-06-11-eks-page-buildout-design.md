# 설계: EKS 페이지 빌드아웃 — 클러스터 리스트 v1-parity + 런타임 조회 등록 (구 kubeconfig 등록의 v2 등가)

> 작성 2026-06-11 · 브랜치 `feat/v2-architecture-design` · 사용자 승인(설계 제시 후 "스펙 만들고 플랜부터 구현까지")
> 결정 요지: access entry = **v1과 같은 수준(CLI 가이드)**, kubeconfig 등록 = **앱이 조회하도록 런타임 등록**(v1 UX 등가, v2 메커니즘).

## 1. 배경 / 목표

`/eks`는 현재 4컬럼(Name/Status/Version/Endpoint) 리스트뿐이고 구식 다크 인라인 스타일이다(리스킨 전). v1(`src/app/k8s/page.tsx`)은 클러스터 카드(+vpc/platform/region/접근배지), access-entry CLI 가이드, kubeconfig 등록 버튼을 제공했다.

v2 사실(정찰 확정):
- v1 "kubeconfig 자동등록"은 EC2 호스트 전용(`update-kubeconfig` 파일 + Steampipe 재시작)이라 Fargate에서 불가/불요. **v2 등가물 = 클러스터를 앱 조회 허용 리스트에 올리는 것** — presigned-STS(`web/lib/eks-incluster.ts`)는 Access Entry만 있으면 동작한다.
- v1 "access entry 기능"도 SDK 호출이 아닌 **CLI 복붙 가이드**였다(create-access-entry + associate-access-policy 명령 표시).
- 현재 허용 리스트는 `ONBOARDED_EKS_CLUSTERS` env(Terraform 정적) — 추가하려면 tfvars+apply+재배포.
- UI에서 직접 `CreateAccessEntry` 호출은 mutating → ADR-029 경로(action_catalog, substrate 현재 OFF) — **범위 밖**(후속).

**목표**: ① 리스트를 v1 수준+로 강화(컬럼·접근배지·리스킨), ② Access Entry가 이미 있는 클러스터를 **버튼 한 번에(재배포 없이) 조회 등록**, ③ Entry 없는 클러스터에 v1식 온보딩 가이드.

## 2. 데이터 — migration **v11** `eks_registrations` (현 최신 v10 — ADR-032 P4가 v10 선점, P2 게이트 검증)

```sql
CREATE TABLE IF NOT EXISTS eks_registrations (
  cluster_name  TEXT PRIMARY KEY,
  registered_by TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- **허용 리스트 = env(`ONBOARDED_EKS_CLUSTERS`) ∪ DB** — Terraform 온보딩(fsi-demo-cluster)은 불변·항상 유효, DB는 런타임 추가분.
- 신규 모듈 **`web/lib/eks-registry.ts`** 단일 소스:
  - `getAllowedClusters(): Promise<Set<string>>` — env 파싱 ∪ DB SELECT. **DB 실패/미설정 → env-only로 degrade**(기존 동작 보존, throw 금지).
  - `isAllowed(cluster)` — 위 Set 조회 (30s 인메모리 TTL 캐시 — 라우트 호출마다 DB 왕복 방지).
  - `registerCluster(cluster, userSub)` / `unregisterCluster(cluster)` — 파라미터라이즈드 INSERT(ON CONFLICT DO NOTHING)/DELETE. DB 미설정 시 false 반환(라우트가 503).

## 3. 서버 — access 상태 합성 + 등록 API

### 3.1 `web/lib/eks-access.ts` (신규)
- `getTaskRoleArn(): Promise<string>` — `STS GetCallerIdentity`로 현재 role ARN(assumed-role → IAM role ARN 변환, v1 `callerRole` 변환식 이식). 10분 캐시.
- `hasAccessEntry(cluster): Promise<boolean>` — `DescribeAccessEntry(cluster, taskRoleArn)` (IAM 기존 보유: `eks:DescribeAccessEntry`). NotFound → false, 기타 에러 → null(unknown, UI는 '확인 불가').
- `onboardingGuide(cluster): {commands: string[]}` — v1과 동일한 두 명령(create-access-entry STANDARD + associate-access-policy **AmazonEKSViewPolicy** cluster scope)에 task role ARN·리전 자동 삽입 + `make configure`(Terraform 영구 온보딩) 안내 문구.

### 3.2 API
- **`GET /api/eks` 확장**: row마다 `{ name, status, version, region, vpcId, platformVersion, createdAt, access }` — `vpcId`/`platformVersion`은 기존 DescribeCluster 응답에서 추출(추가 IAM 0). `access: 'connected' | 'entry-only' | 'no-entry' | 'unknown'`:
  - `connected` = 허용 리스트에 있음 **그리고** entry 확인됨 — env 출신은 Terraform이 entry를 보장하므로 확인 생략, **DB(runtime) 출신은 매번 재확인**(entry가 회수되면 no-entry로 강등 표시, 등록은 유지되어 해제 가능)
  - `entry-only` = entry 있음 + 미등록 → "조회 등록" 버튼 대상
  - `no-entry` = entry 없음 → "온보딩 가이드" 버튼 대상
  - `unknown` = DescribeAccessEntry 에러(권한/스로틀) — 등록 버튼은 노출(서버가 재검증)
- **`POST /api/eks/[cluster]/register`** — `verifyUser` + **`isAdmin`**(기존 lib/admin 재사용): ① 클러스터 실존(DescribeCluster) ② `hasAccessEntry` 재검증 — true → `registerCluster` → 200 `{registered:true}`; false → **409 `{registered:false, guide}`**(가이드 데이터 동봉) ③ DB 미설정 → 503.
- **`DELETE /api/eks/[cluster]/register`** — admin, env 출신 클러스터는 **삭제 불가 400**(Terraform 관할 명시), DB 행만 삭제.
- **기존 라우트 전환**: `[cluster]/incluster/route.ts` + `[cluster]/k8sgpt/route.ts`의 allow-list 검사(`ONBOARDED_EKS_CLUSTERS` 직접 파싱)를 `eks-registry.isAllowed()`로 교체 — 등록 즉시 조회 가능.

## 4. UI — `/eks` 페이지 재작성 (paper+ink 리스킨)

- 다른 페이지(D3 인벤토리/F2 셸)와 동일한 디자인 시스템 — 구식 다크 인라인 스타일 제거.
- 컬럼: **Name(상세 링크는 connected만 활성) · Status · Version · Region · VPC · Platform · 연결**:
  - 🟢 `Connected` 배지 — `/eks/[cluster]` 링크 활성(기존 탭 페이지)
  - 🟡 `Entry 있음` + **[조회 등록]** 버튼(admin에게만 노출) → POST → 성공 시 행 갱신(Connected)
  - ⚪ `Entry 없음` + **[온보딩 가이드]** 버튼 → 행 확장 패널: 복붙 명령 2개(ARN 채워짐, copy 버튼) + "`make configure`로 Terraform 영구 온보딩 가능" / "명령 실행 후 다시 [조회 등록]" 안내
  - DB 출신 등록 행엔 admin에게 [등록 해제]
- 비관리자: 배지는 보이되 등록/해제 버튼 숨김(서버도 403).

## 5. 에러 처리 / Degrade

| 상황 | 처리 |
|---|---|
| DB 미설정/실패 | 허용리스트 env-only(기존 클러스터 정상 동작), 등록 POST 503, GET의 access는 entry 기반으로 계속 계산 |
| DescribeAccessEntry 에러 | access='unknown', 등록 시 서버 재검증이 최종 판정 |
| 미허용 클러스터 상세 접근 | 기존대로 404 |
| 등록 경합(동시 POST) | INSERT ON CONFLICT DO NOTHING — 멱등 |
| env 출신 해제 시도 | 400 + "Terraform(onboard_eks_clusters) 관할" 메시지 |

## 6. 테스트

- `eks-registry.test.ts`: env∪DB 합집합, degrade(env-only), TTL 캐시, register/unregister 멱등, DB-off 시 false.
- `eks-access.test.ts`: assumed-role→role ARN 변환, NotFound→false, 기타 에러→null, guide 명령 포맷(ARN/리전 삽입).
- `api/eks/route.test.ts` 확장: access 합성(4상태), 새 필드.
- `register/route.test.ts`(신규): 401/403(비admin)/409+guide/200/503/DELETE env-guard 400.
- `incluster` 라우트 테스트: isAllowed 모킹으로 기존 케이스 회귀 + DB 등록 클러스터 허용.
- UI: 배지/버튼 노출 분기(jsdom) — 핵심 분기만.

## 7. 범위 밖

- **원클릭 Access Entry 생성**(mutating) — ~~ADR-029 후속~~ → **영구 범위 밖**(2026-06-11 ADR-029/036 REVERSED: mutating 방향 전면 폐기). CLI 가이드가 최종 형태 — 본 구현의 read-only 접근이 새 정책과 정확히 부합.
- 노드 CPU/mem 시각화 — worktree `gap-impl-wave1`에 구현·push됨(미머지) → 그쪽 머지로(중복 금지).
- 로컬 kubectl용 kubeconfig 다운로드, K9s 7종 리소스 확장, 노드그룹/애드온 컬럼(추가 IAM 필요), 부서별 접근제어.

## 7.5 배포 후 정정 (2026-06-11)

- **403 근본원인**: `AmazonEKSViewPolicy`는 k8s `view` ClusterRole 상당 — **cluster-scope 리소스(nodes) 미포함**(공식 권한표 확인). P1e가 고른 정책의 설계상 한계였음(연계는 멀쩡). → 연계를 **`AmazonEKSAdminViewPolicy`**(`*`/get,list,watch)로 교체(eks.tf + 가이드 명령). Secrets 읽기가 포함되나 BFF kind allow-list가 프록시를 차단. v1 가이드도 AdminView였음.
- **v1-parity UX 보강**: 온보딩 스크립트를 비연결 행에 **상시 노출**(GET이 guide 동봉, '스크립트' 버튼 — POST 불요) + **fleet stats row**(`GET /api/eks/summary`: connected 클러스터 합산 Nodes/Pods/Deployments/Services, per-cluster degrade).

## 8. 운영(구현 후)

migration v11 psql(승인 절차 — Aurora 마스터 `awsops_admin`+`PGSSLMODE=require`) → `make deploy`. 인프라 변경 0(plan 무변경 — IAM·env 기존 그대로).
