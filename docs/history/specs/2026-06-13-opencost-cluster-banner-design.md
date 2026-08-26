# OpenCost — 클러스터 상세 collapse 배너로 통합 (read-only)

**Date:** 2026-06-13
**Branch:** `feat/v2-architecture-design`
**Status:** Approved (brainstorming) → consensus pipeline

## 1. 목표

top-level OpenCost 메뉴(`/opencost` 페이지 + EKS 하위 들여쓰기 NavItem)를 제거하고,
OpenCost **설치 감지 + 설치 가이드(번들 다운로드) + admin Helm 설정**을
클러스터 상세 페이지(`/eks/[cluster]`) 상단의 **collapse 배너**로 통합한다.

동기: OpenCost는 본질적으로 per-cluster 개념인데, 현재는 top-level 메뉴에서 다시
클러스터를 SegmentedControl로 골라야 해서 **선택을 두 번** 한다. 클러스터 상세에
진입한 시점엔 클러스터가 이미 정해져 있으므로 그 자리에서 contextual하게 노출하는 것이
자연스럽다. 미설치면 가이드가 자동으로 펼쳐지고, 설치돼 있으면 조용한 배지로 접힌다
(progressive disclosure).

## 2. 비목표 / 제약 (ADR-029 번복 준수)

- **이것은 재배치이지 재작성이 아니다.** 백엔드 라우트와 lib는 전부 그대로 재사용한다.
- **앱은 클러스터에 절대 쓰지 않는다.** "설치 가이드"는 ADR-029에서 폐기된 *mutating
  설치 버튼*이 아니라, `values.yaml`/`install.sh`를 **생성·다운로드**만 하는 read-only
  번들이다. 실제 설치는 사용자가 자기 kubeconfig로 직접(out-of-band) 실행한다.
- AWSops는 read-only ops 대시보드 + AI 진단이라는 스탠스를 유지한다.

## 3. 변경 없음 (그대로 재사용)

다음은 **수정하지 않는다** — 패널이 기존 API/lib를 호출만 한다:

- 라우트: `app/api/opencost/[cluster]/route.ts` (GET 설정 읽기 / PUT 설정 저장, admin),
  `.../status/route.ts` (read-only 설치 감지), `.../bundle/route.ts` (번들 생성)
- libs: `lib/opencost.ts`, `lib/opencost-status.ts`, `lib/opencost-config.ts`,
  `lib/opencost-allowlist.ts`

## 4. 신규 컴포넌트 — `web/app/eks/[cluster]/OpencostPanel.tsx`

`export default function OpencostPanel({ cluster }: { cluster: string })`, client component.

### 데이터 흐름
- 마운트 시: `GET /api/opencost/{cluster}/status` + `GET /api/me` (admin 판정) 병렬 호출.
- 고급(admin) 섹션을 펼칠 때: `GET /api/opencost/{cluster}` (저장된 config) lazy fetch.
- collapse open 상태: status 해석 직후 **1회** 초기화 — 미설치(+미degrade)면 자동 open,
  그 외 closed. 이후엔 사용자 토글이 우선.
- 모든 fetch 실패는 **throw 금지** — degrade 한 줄로 표시(기존 라우트가 이미 degrade-safe).

### 렌더 상태 (6종)

| 상태 | 판정 | 배지 | collapse 초기값 | 펼친 내용 |
|---|---|---|---|---|
| 조회 중 | status 미해결 | — | — | "조회 중…" 한 줄 |
| **404** | status route 404 (allowlist 밖) | neutral | 닫힘·토글 비활성 | "인-앱 조회 미온보딩 (Access Entry 필요)" — 가이드/다운로드 없음 |
| **미설치** | `installed:false`, reason 없음 | neutral `미설치` | **자동 펼침** | 설치 단계 + `values.yaml`·`install.sh` 다운로드 + admin 고급 섹션 |
| **degraded** | `installed:false`, `reason` 있음(예: 403 revoked) | neutral + `(reason)` | 자동 펼침 | 미설치와 동일(번들 유의미) |
| 설치됨·Ready | `installed:true, ready:true` | positive `● 설치됨 · Ready` | 닫힘 | 재설치/업그레이드용 번들 링크 |
| 설치됨·Not Ready | `installed:true, ready:false` | brand `설치됨 · Not Ready` | 닫힘 | 번들 링크 |

> **404 vs degraded(403) 구분:** 404 = allowlist 밖 → OpenCost 조회/번들 모두 무의미하므로
> 조용한 안내만. 403(degraded) = 온보딩됐으나 Access Entry revoked → 가이드/번들은 여전히
> 유의미(번들 생성은 in-cluster 접근과 독립).

### 설치 가이드(펼침) 내용
1. 단계 텍스트: `helm repo add opencost https://opencost.github.io/opencost-helm-chart` 등
   (출처 = `lib/opencost.ts` 상수: `OPENCOST_REPO_NAME/URL/CHART/NAMESPACE`)
2. 다운로드 버튼 2개: `values.yaml`, `install.sh` — `GET .../bundle` 응답을 Blob으로 저장.
3. (설치됨 상태에서도) 동일 다운로드를 "재설치/업그레이드용 번들"로 제공.

### admin 고급 하위섹션 (admin만 보임)
- 가시성: `/api/me`의 `isAdmin === true`일 때만 렌더(미admin이면 DOM에 없음).
- 내용: chart version(빈 값=latest) + values override JSON textarea + 저장 버튼.
- 저장: `PUT /api/opencost/{cluster}` — 서버가 admin을 재차 강제(403/503 메시지 표시).
- 즉 가시성은 UX 편의이고, **권한 강제는 서버가 source of truth**.

### UI 토큰
- 기존 `Badge`, `Card`/배너 스타일, paper/ink/brand 토큰 재사용. 새 디자인 시스템 도입 없음.
- 접근성: collapse 토글은 `<button aria-expanded>`; 배지 텍스트는 색에만 의존하지 않음.

## 5. 백엔드 변경 1건 (소)

`web/app/api/me/route.ts` 응답에 `isAdmin: boolean` 추가:

```ts
import { isAdmin } from '@/lib/admin';
// ...
const admin = await isAdmin(user);
return Response.json({ sub: user.sub, email: user.email, groups: user.groups ?? [], isAdmin: admin });
```

이유: `isAdmin`은 Cognito 그룹 **또는** SSM email allowlist이므로, 클라이언트가 `groups`만
보면 SSM-email admin을 놓친다. 서버 1회 호출로 정확한 가시성 신호를 내려준다. PUT의 admin
강제는 그대로라 **보안 영향 없음(UI 정확도만)**.

## 6. 배치

`web/app/eks/[cluster]/page.tsx` — 탭 `SegmentedControl` 직후, 콘텐츠 위에
`<OpencostPanel cluster={cluster} />` 한 줄 삽입. 탭과 무관하게 항상 표시(클러스터 스코프).

## 7. 제거

- `web/app/opencost/page.tsx` 삭제
- `web/app/opencost/opencost-page.test.tsx` 삭제
- `web/components/shell/Sidebar.tsx` — `/opencost` NavItem 1줄 제거(EKS는 유지)
- `web/components/shell/CommandPalette.tsx` — `/opencost` 엔트리 1줄 제거
- `web/lib/i18n.ts` — `nav.opencost` 키 2곳 제거 (패널 제목은 제품명 "OpenCost" 하드코딩)

## 8. 테스트

- **신규** `web/app/eks/[cluster]/OpencostPanel.test.tsx`:
  - 6개 상태 렌더(조회중/404/미설치/degraded/Ready/NotReady)
  - 미설치 → collapse 자동 펼침; 설치됨 → 닫힘
  - admin 게이트: `isAdmin:true`면 고급 섹션 보임, `false`면 DOM에 없음
  - 번들 다운로드 버튼 클릭 → `GET .../bundle` 호출 트리거(Blob/anchor는 mock)
  - status fetch 실패 → throw 없이 degrade 한 줄
- **수정** `web/app/api/me/route.test.ts`: 응답에 `isAdmin` 필드 assert(admin/비admin 2케이스)
- **삭제** `web/app/opencost/opencost-page.test.tsx`
- status/bundle/config route 테스트는 무변경.

## 9. 엣지/에러 정리

- status 네트워크 실패 → degrade 한 줄, 페이지 깨지지 않음.
- 404(allowlist 밖)에서는 다운로드 버튼을 노출하지 않는다(bundle도 404).
- 고급 섹션 저장 비admin → 서버 403 → "관리자 전용" 메시지(버튼은 보이지 않으므로 정상 경로엔 미발생).
- collapse 토글 후 재조회(refresh)가 사용자 open 상태를 덮어쓰지 않도록 초기화는 최초 1회만.

## 10. 영향 범위 (파일)

신규: `web/app/eks/[cluster]/OpencostPanel.tsx`, `web/app/eks/[cluster]/OpencostPanel.test.tsx`
수정: `web/app/eks/[cluster]/page.tsx`, `web/app/api/me/route.ts`,
`web/app/api/me/route.test.ts`, `web/components/shell/Sidebar.tsx`,
`web/components/shell/CommandPalette.tsx`, `web/lib/i18n.ts`
삭제: `web/app/opencost/page.tsx`, `web/app/opencost/opencost-page.test.tsx`
