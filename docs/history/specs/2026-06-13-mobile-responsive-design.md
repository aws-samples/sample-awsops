# 모바일 반응형 UI — 설계 (2026-06-13)

> AWSops v2 web을 데스크톱 전용에서 **모바일/태블릿 반응형**으로 확장한다. 단일 브레이크포인트 `lg`(1024px) 기준으로 **<lg = 모바일 크롬(상단바 + 하단 탭바 + 햄버거 드로어)**, **≥lg = 기존 데스크톱 사이드바**. 핵심 페이지(scope B)는 모바일 전용 처리(테이블→카드, 챗 풀스크린, 그리드 reflow, 디테일 시트).

## 배경 / 동기
- 현재 web은 **데스크톱 전용**: `app/layout.tsx`에 **viewport 메타 없음**(모바일이 데스크톱 폭으로 축소 렌더), 사이드바 `w-64 shrink-0` 고정 + `AppShell` `flex h-screen`(접힘 없음), 반응형 클래스 27개뿐, KPI 그리드 다수가 `grid-cols-4/5` 고정.
- 사용자 요청: "모바일용 UI도". 주 시나리오(brainstorm 확정): **글랜스·모니터링 + AI 어시스턴트/챗 + 리소스 조회/드릴다운**. 목표 수준 **B = 핵심 페이지 최적화**.

## 결정 (brainstorm 확정)
- **내비 패턴 = 드로어 + 하단 탭바**(2안). 상단바(☰+로고+타이틀+검색) + 하단 탭바 + 햄버거 드로어(기존 사이드바 재사용).
- **하단 탭 5개**: Overview / Cost / Inventory / Assistant / **More**(=드로어).
- **단일 브레이크포인트 `lg`(1024px)**: <lg 모바일 전체 처리, ≥lg 데스크톱 그대로. (태블릿도 <lg면 모바일 크롬; 카드 모드는 내부에서 반응형 컬럼으로 폭 활용.)
- **scope B 처리**: 테이블→카드, 챗 풀스크린, 대시보드 그리드 reflow, 디테일 패널 풀스크린 시트.

## 아키텍처
- **반응형 크롬은 CSS 우선**: 데스크톱 사이드바 `hidden lg:flex`, 모바일 크롬 `lg:hidden`. JS 브레이크포인트 감지 없음 — **드로어 열림/닫힘만 client 상태**(useState in AppShell).
- **chrome 토큰 재사용**: 모바일 상단바/탭바/드로어는 기존 `chrome` 토큰(`bg-chrome`, `text-chrome-fg`, `border-chrome-border`, `bg-chrome-active`)을 써서 **teal/cobalt/console 테마에 자동 호환**(console에선 모바일 크롬도 다크).
- **viewport**: `app/layout.tsx`에 Next 14 `export const viewport = { width: 'device-width', initialScale: 1 }` 추가(모든 페이지 적용).

## 컴포넌트 (신규)

### `web/components/shell/MobileTopBar.tsx` (client)
- `<lg`에서만 표시(`lg:hidden`). 좌→우: ☰ 버튼(드로어 토글, `aria-label`) · `AwsopsMark`(sm) · 현재 페이지 타이틀(pathname→라벨, `mobile-tabs.ts`/nav 매핑) · 🔍(Cmd-K 오픈; 기존 ⌘K 토글 이벤트 재사용 — `window` 키이벤트 dispatch 또는 공유 store).
- `bg-chrome border-b border-chrome-border`, `sticky top-0 z-30`.
- 우측 슬롯: LanguageToggle/UserIdentity는 넣지 않고 **드로어**로 이동(공간 절약).

### `web/components/shell/BottomTabBar.tsx` (client)
- `<lg`에서만(`lg:hidden`), `fixed bottom-0 inset-x-0 z-30`, `bg-chrome border-t border-chrome-border`, safe-area 패딩(`pb-[env(safe-area-inset-bottom)]`).
- 5탭: 각 `lib/mobile-tabs.ts`의 `{href,label,icon}`. active = `usePathname()` 매칭 → `text-chrome-active-fg`(또는 brand-700), 그 외 `text-chrome-fg-muted`.
- **More** 탭은 href 없이 `onClick`→드로어 오픈(공유 상태/콜백).
- 본문이 탭바에 가리지 않게 `<main>`에 `<lg` 하단 패딩(`pb-16 lg:pb-0`).

### `web/components/shell/MobileNav.tsx` (client, 드로어)
- 햄버거/More가 여는 슬라이드인 오버레이. `fixed inset-0 z-40`, 배경 딤(`bg-ink-900/40`, 클릭 시 닫힘), 좌측 패널 `bg-chrome-muted`(기존 사이드바와 동일 표면) translate-x 트랜지션.
- **내용 = 기존 `Sidebar` 재사용**: Sidebar를 `<MobileNav>` 안에서 렌더(또는 Sidebar 본문을 공용 `SidebarNav`로 추출해 데스크톱/드로어 공용). 링크 클릭 시 `onNavigate`로 드로어 닫힘.
- 드로어 푸터에 LanguageToggle·UserIdentity·ThemeToggle(데스크톱은 사이드바 푸터 그대로).

### `web/lib/mobile-tabs.ts`
- `MOBILE_TABS: { href?: string; label: string; tkey: string; icon: LucideIcon; action?: 'drawer' }[]` = Overview/Cost/Inventory/Assistant/More. i18n 키는 기존 LanguageProvider 패턴. `Inventory` 탭은 인벤토리 인덱스(첫 타입 또는 `/inventory`) — 정확 목적지는 구현 시 확정(없으면 첫 등록 타입).

### `web/components/shell/AppShell.tsx` (수정)
- 드로어 open state(useState) 보유. 렌더:
  - 데스크톱 사이드바: `<Sidebar className="hidden lg:flex" />`
  - 모바일: `<MobileTopBar onMenu/>` + `<main className="… pb-16 lg:pb-0">{children}</main>` + `<BottomTabBar onMore/>` + `<MobileNav open onClose/>`
- `lg:` 클래스로 동시 존재하되 CSS로 한쪽만 표시(레이아웃 단순·SSR 안전). `ShellGate`는 `/login` bare 분기 그대로(모바일에서도 로그인은 풀스크린).

## 페이지별 처리 (scope B)

### 대시보드 (Overview / Cost / bedrock)
- KPI 그리드: 고정 `grid-cols-4`/`grid-cols-5` → **반응형** `grid-cols-2 lg:grid-cols-4`(또는 4/5에 맞춰 `sm:grid-cols-2 lg:grid-cols-N`). 2-col 모바일 기본.
- 차트: recharts `ResponsiveContainer`가 폭 반응(이미) — 부모 컨테이너가 풀폭인지 확인. 2-up 차트 행은 `<lg`에서 1-col stack.
- 페이지 좌우 패딩 `<lg` 축소(`px-4 lg:px-8` 등).

### 테이블 → 카드 (DataTable)
- `DataTable.tsx`에 **카드 모드**: `<lg`에서 `<table>` 대신 카드 리스트(`grid-cols-1 sm:grid-cols-2`), 각 카드 = primary 컬럼(제목/링크) + 상태 배지 + 주요 2–3 필드(label:value). `lg+`에서 기존 표(`overflow-x-auto` 유지) — 단일 `lg` 브레이크포인트 일관.
- 컬럼 메타에 "모바일 카드에 노출할 키" 표시 옵션(없으면 처음 N개 컬럼). 정렬/필터 컨트롤은 카드 모드에서도 상단에 유지.
- 적용 대상: `inventory/[type]`·`eks` 등 DataTable 사용처 전부(컴포넌트 한 곳 수정으로 전파).

### 챗 / 어시스턴트
- `ChatDrawer`(우측 도킹·리사이즈): `<lg`에서 **풀스크린 오버레이**(`inset-0`, 폭/리사이즈 핸들 숨김, 닫기 버튼). 폭 localStorage 영속은 `lg+`에서만 적용.
- `/assistant` 풀페이지는 이미 모바일 OK — 헤더/컴포저 패딩만 `<lg` 점검.

### 드릴다운 / 디테일 패널
- 인벤토리/리소스 디테일이 우측 도킹 패널이면 `<lg`에서 **풀스크린 시트**(하단/우측 슬라이드, 닫기 + 배경 딤). 데스크톱 우측 패널 그대로.

## 테스트 / 검증
- vitest: `BottomTabBar`(pathname→active 매핑, More=드로어 콜백), `MobileNav`(open/close·onNavigate 닫힘), `DataTable` 카드모드 렌더(주요 필드·배지 표시; jsdom은 뷰포트 없으니 카드/표 분기는 클래스 존재로 검증 또는 prop 강제).
- 반응형 자체는 CSS → 유닛 한계. **build + Playwright 모바일 뷰포트(390×844)** 수동: 상단바/탭바/드로어, KPI 2-col, 테이블 카드, 챗 풀스크린, console 테마 모바일 다크.
- 배포: web `make deploy`(테마와 동일, terraform 무관).

## 범위 밖 (YAGNI)
- 모바일 우선 재설계(C안)·하단 탭 6+개·제스처(스와이프)·PWA/오프라인/홈스크린·푸시.
- 비핵심 페이지(customization/opencost/topology 등)의 완전 맞춤 — 반응형 토대(드로어/탭/그리드 reflow)로 "쓸 수 있게"까지만, 카드/시트 등 전용 처리는 핵심 페이지 우선.
- 데스크톱 레이아웃 변경 없음(≥lg는 현행 유지).

## 파일 영향 요약
| 파일 | 변경 |
|--|--|
| `web/app/layout.tsx` | `export const viewport` 추가 |
| `web/components/shell/AppShell.tsx` | 반응형 크롬 + 드로어 state |
| `web/components/shell/MobileTopBar.tsx` (신규) | 상단바(☰/로고/타이틀/검색) |
| `web/components/shell/BottomTabBar.tsx` (신규) | 하단 5탭 |
| `web/components/shell/MobileNav.tsx` (신규) | 햄버거 드로어(Sidebar 재사용) |
| `web/components/shell/Sidebar.tsx` | (필요 시) 본문을 공용화 + `onNavigate`·`className` props |
| `web/lib/mobile-tabs.ts` (신규) | 탭 정의/active |
| `web/components/ui/DataTable.tsx` | `<lg` 카드 모드 |
| `web/components/chat/ChatDrawer.tsx` | `<lg` 풀스크린 |
| 디테일 패널 컴포넌트 | `<lg` 풀스크린 시트 |
| 대시보드 KPI 그리드(Overview/Cost/bedrock 등) | 그리드 클래스 반응형화 + 패딩 |
