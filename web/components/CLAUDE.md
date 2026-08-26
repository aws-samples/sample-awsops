# 컴포넌트 모듈 / Components Module

## 역할 / Role
클라이언트 컴포넌트 90개, 12개 서브디렉토리: `ui`(공용 프리미티브), `shell`(AppShell·Sidebar·LanguageProvider·AccountSelector 등), `charts`, `chat`, `inventory`(+`metrics/`), `eks`, `diagnosis`, `datasources`, `insights`, `dx`(DX 구성도), `nfm`, `overview`.
(88 client components across 11 subdirs: shared primitives in `ui/`, app shell, and domain components.)

## 주요 파일 / Key Files
- `ui/DataTable.tsx` + `ui/DetailPanel.tsx` — 목록+상세 기본 조합. DetailPanel은 행이 이미 들고 있는 전체 데이터를 추가 fetch 없이 렌더 — `spec`(`InvType`)에 `sections`가 있으면 섹션 그룹 렌더, 없으면 flat key 목록(하위호환). 신규 인벤토리 타입은 `sections` 정의 필수 (renders the full row; grouped sections when the spec provides them)
- `inventory/metrics/MetricTable.tsx` — 선언적 `MetricCol` 모델(`{value, render?, danger?, facet?, facetValues?, type}`)만 정의하면 정렬·전역 검색·facet 필터·'문제만' 토글이 무료 제공. 서비스별 테이블(Ec2/Rds/Alb/...)은 컬럼 정의로만 작성. opt-in prop: `facetValues`(다중값 facet — joined 표시값 exact-match는 복합값 행 누락), `maxRender`+`capKeep`(렌더 단계 행 상한 — 데이터 단계 컷은 정확 검색을 조용히 0건으로 만듦), `rowClass`(행 단위 클래스 훅) (declarative column model — sort/search/facet/danger-only for free; opt-in multi-value facets, render-stage cap, per-row class)
- `inventory/metrics/guides.tsx` + `guides.{en,zh,ja}.tsx` — 진단 가이드 언어별 본문. i18n lockstep — 4개 파일 동시 갱신 (per-language guide bodies, update all four together)
- `dx/DxTopology.tsx` — Direct Connect 구성도 (React Flow + dagre, topology 페이지 관례 준수 — dynamic ssr:false, colorMode, light/dark 색 쌍, imperative fitView). 그래프/SLA 판정은 `lib/dx-topology.ts` 순수 함수 (DX topology diagram; graph/SLA logic lives in the pure lib)
- `nfm/FlowHopPath.tsx` — End-to-End 홉 스텝퍼 (로컬 엔드포인트 → traversedConstructs → 원격 엔드포인트). kind별 고유 글리프 + 색 — color-only 식별 금지 (E2E hop stepper; a glyph per kind, never color-only)
- `eks/NodeDrilldownPanel.tsx` — 노드 드릴다운 (용량 카드 + Pod/ENI 섹션, nodes+pods 자체 라이브 조회). EKS 개요와 `/eks/nodes` 플릿 페이지(`FleetKindPage`)가 공유 (node drilldown shared by the EKS overview and the fleet page)
- `chat/MessageList.tsx` + `chat/useChat.ts` — 스트리밍 스무딩: 마크다운 파싱 입력을 ~180ms `useThrottled`로 스로틀(토큰마다 전체 재파싱 O(n²) 회피) + 미완성 코드펜스 균형(MessageList); 타자기 버퍼 — 델타를 모아 24ms마다 백로그 비례(최소 3자) 방출, 종결 시 즉시 flush(useChat) (throttled markdown parse + typewriter buffer)
- `shell/LanguageProvider.tsx` — `useI18n()` 훅 (`t`/`tt`/lang 컨텍스트) (i18n context hook)
- `shell/Sidebar.tsx` — 내비게이션. 새 페이지 등록 지점 (navigation; where new pages register)
- `shell/ChangelogVersion.tsx` — 사이드바 풋터 버전 칩 + 변경 이력 모달 (`/api/changelog`). **사이드바의 transform이 fixed 자손의 containing block이 됨** — 사이드바 내부 모달류는 `createPortal`(body)로 렌더 필수 (the sidebar transform traps fixed descendants; portal modals to body)
- `ui/StatCard.tsx` — `StatTile`의 alias re-export. 새 코드는 `StatTile` 직접 import

## 규칙 / Rules
- 페이지에서 소비하는 컴포넌트는 `export default`. 단, 공유 유틸 모듈(`metrics/shared.tsx`, `guides.*.tsx`, `LanguageProvider.tsx` 등)은 named export가 기존 패턴 — 임의 변경 금지.
- 새 UI는 `ui/` 프리미티브(Badge, StatePill, Card, PageHeader, StatTile 등) 재사용 우선 — 프리미티브 신설 남발 금지.
- 사용자 표시 문자열은 한국어 리터럴 + `tt()` 경유 (미등록 문자열은 통과되므로 안전).
- 테스트는 컴포넌트 옆 `*.test.tsx` colocate (vitest).
