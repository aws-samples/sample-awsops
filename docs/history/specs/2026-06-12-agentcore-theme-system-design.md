# AgentCore 테마 시스템 — 설계 (2026-06-12)

> web(`web/`, v2 thin-BFF)의 색 시스템을 **Claude(웜 크림+테라코타) → AgentCore(쿨 뉴트럴 + Bedrock teal)** 로 재구성하고, 런타임 **테마 선택기**(teal / azure / teal-console)를 추가한다. 색 사용이 토큰 레이어(CSS 변수 + Tailwind 토큰)에 집중돼 있어 컴포넌트 대량 수정 없이 가능하다.

## 배경 / 동기
- 현재 팔레트가 "Anthropic 제품"처럼 보임: 크림 배경 `#FAF9F5`(=Claude.ai), 테라코타 `#D97757`(=Claude 브랜드), 웜브라운 뉴트럴.
- AWSops v2는 **AgentCore 기반 제품**. 색을 AWS/AgentCore 정체성으로 옮긴다.
- **정식 근거**: AWS Architecture 아이콘 `Arch_Amazon-Bedrock`(AI 카테고리) = 배경 타일 **teal `#01A88D`** + 흰 글리프. AI 카테고리 타일도 `#01A88D`. → **teal이 정식 Bedrock/AI 색.** AgentCore 발표 아이콘의 azure `#528DF8`·violet `#7B26FF`·cyan은 *대체 틴트*(보조/차트용).

## 현재 구조 (확인됨)
- `web/app/globals.css`: `:root`에 `--claude-*`, `--ink-*`, `--paper*`, semantic alias(`--brand`, `--surface-page`, `--text-primary`, `--chart-*`, `--shadow-*`) 존재.
- `web/tailwind.config.ts`: `colors`에 `paper`/`ink`/`claude`/`emerald`/`rose` 램프를 **고정 hex**로 정의 → `bg-claude-500` 등은 빌드 시 hex로 컴파일(런타임 변수 미참조).
- 사용량: `paper/ink` 클래스 337곳, `claude` 클래스 66곳, 하드코딩 hex는 6파일뿐(`app/topology/page.tsx`, `components/ui/AwsopsMark.tsx`, `components/ui/components.test.tsx`, `components/charts/AreaTrend.tsx`, `charts/theme.ts`, + paper hex 1곳).
- 사이드바/헤더 크롬: `Sidebar.tsx`가 `bg-paper-muted`(연회색) 공유, active item `bg-claude-500`. `layout.tsx` body `bg-paper text-ink-800`.
- **테마/다크 인프라 없음**(신규 구축).

## 핵심 아이디어
Tailwind 토큰을 **CSS 변수 참조로 1회 전환**하면, `<html data-theme>` 한 속성으로 전역 색이 바뀐다. 라이트 테마 2개(teal/azure)는 **순수 CSS 전환**(컴포넌트 수정 0). 다크 크롬 테마(teal-console)만 크롬 표면을 전용 토큰으로 분리하면 된다(파일 2개 소폭).

---

## 설계

### 1. Tailwind 토큰 → CSS 변수 (`tailwind.config.ts`)
각 shade를 `var(--*)`로 매핑하고 `claude`→`brand` 리네임:
```ts
colors: {
  paper: { DEFAULT: 'var(--paper)', muted: 'var(--paper-muted)' },
  ink:   { 50:'var(--ink-50)', …, 900:'var(--ink-900)' },
  brand: { 50:'var(--brand-50)', …, 900:'var(--brand-900)' },   // was `claude`
  chrome:{ DEFAULT:'var(--surface-chrome)', muted:'var(--surface-chrome-muted)',
           fg:'var(--chrome-fg)', 'fg-muted':'var(--chrome-fg-muted)',
           border:'var(--chrome-border)', 'active':'var(--chrome-active-bg)',
           'active-fg':'var(--chrome-active-fg)' },
  positive:{ DEFAULT:'var(--positive)', surface:'var(--positive-surface)', text:'var(--positive-text)', border:'var(--positive-border)' },
  negative:{ DEFAULT:'var(--negative)', surface:'var(--negative-surface)', text:'var(--negative-text)', border:'var(--negative-border)' },
  warning: { DEFAULT:'var(--warning)',  surface:'var(--warning-surface)',  text:'var(--warning-text)',  border:'var(--warning-border)' },
}
```
- `emerald`/`rose`는 의미색이 `positive`/`negative` 토큰으로 이관됨에 따라 정리 — **안전을 위해 `var()` 매핑으로 유지하다가 사용처 치환이 끝나(`grep` 0) 제거**(중간에 클래스 깨짐 방지). `boxShadow.focus`의 하드코딩 rgba도 `var(--shadow-focus)` 사용.
- shadow rgba(웜 `31,30,29`)는 쿨 뉴트럴(`16,32,42`)로 globals.css에서 갱신.

### 2. CSS 변수 + 테마 블록 (`globals.css`)
**공유 쿨 뉴트럴**(teal/azure/console 동일) — 웜브라운 `ink`/`paper`를 쿨슬레이트로 교체:
```
--ink-50 #F4F6F8  --ink-100 #E7ECEF  --ink-200 #D3DAE0  --ink-300 #AFBAC3
--ink-400 #7D8A96 --ink-500 #5A6873  --ink-600 #3D4852  --ink-700 #2A333B
--ink-800 #16202A --ink-900 #0C141C
--paper #F4F6F8   --paper-muted #EBEFF2   --white #FFFFFF
```
alias 레이어(`--text-primary=--ink-800` 등)는 그대로 유지.

**`:root` 기본 = teal**, 추가 블록 `[data-theme="azure"]`, `[data-theme="teal-console"]`. 각 블록이 override하는 것: **brand 램프 / chrome 토큰 / chart 토큰**. (의미색·뉴트럴은 공유.)

brand 램프:
| | 50 | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900 |
|--|--|--|--|--|--|--|--|--|--|--|
| **teal** | #E6F6F2 | #C4EBE3 | #8FD9CC | #54C3B0 | #1FB199 | **#01A88D** | #00876F | #0A6B5A | #0C5447 | #0A3D34 |
| **azure** | #EAF1FE | #D2E2FD | #A9C7FB | #7FA9F9 | #5E96F8 | **#528DF8** | #2E6BE6 | #1F54C2 | #1B4196 | #15306B |

chrome 토큰:
| 토큰 | light (teal·azure) | teal-console |
|--|--|--|
| `--surface-chrome` (헤더) | #FFFFFF | #22332F |
| `--surface-chrome-muted` (사이드바) | #F4F6F8 | #1B2A27 |
| `--chrome-fg` | var(--ink-800) | #FFFFFF |
| `--chrome-fg-muted` | var(--ink-500) | #9DB3AD |
| `--chrome-border` | var(--ink-100) | #2A3D38 |
| `--chrome-active-bg` | var(--brand-50) | #26403A |
| `--chrome-active-fg` | var(--brand-700) | #FFFFFF |
| `--chrome-active-border` | var(--brand-500) | var(--brand-500) |

chart 토큰(테마별 override로 lead 색 중복 회피):
| 테마 | --chart-1 | --chart-2 | --chart-3 | --chart-4 | --chart-5 |
|--|--|--|--|--|--|
| teal/console | #01A88D | #528DF8 | #7B26FF | #39C2B0 | var(--ink-400) |
| azure | #528DF8 | #01A88D | #7B26FF | #39C2B0 | var(--ink-400) |
| 공통 | --chart-grid var(--ink-100), --chart-axis var(--ink-400), tooltip bg var(--ink-800) |

의미색(공유):
```
--positive #01A88D  --positive-surface #E6F6F2  --positive-text #00715D  --positive-border #8FD9CC
--negative #D13212  --negative-surface #FDECE8  --negative-text #A32A0F  --negative-border #F5C3B5
--warning  #F59E0B  --warning-surface #FEF3E2   --warning-text #B26B05   --warning-border #FAD9A0
```
(positive=teal계 — teal/console 테마에선 brand와 동일 hue로 "정상=teal", azure 테마에선 brand=azure와 구분됨.)

### 3. 접근성 (WCAG) 규칙 — **필수**
teal `#01A88D`는 흰 배경 텍스트 대비 ~2.9:1 → **본문/링크 텍스트는 `brand-700`(teal #0A6B5A, azure #1F54C2) 사용**. `brand-500`은 **채움/보더/active 바/아이콘/큰 굵은 텍스트**용. **Primary 버튼은 `brand-600` 이상 배경 + 흰 텍스트**(teal #00876F+white ≈ 3.7:1 → 굵게/큰글씨로 AA-large 충족; 일반 크기 라벨은 `brand-700`). 다크 크롬 위 텍스트는 `--chrome-fg`(흰)로 충분. → 토큰 alias `--text-brand=var(--brand-700)`, `--brand=var(--brand-500)`(채움), `--brand-hover=var(--brand-600)`, `--on-brand=#fff`로 분리.

### 4. 테마 적용 메커니즘
- `web/lib/theme.ts`: `THEMES = ['teal','azure','teal-console']`, 라벨/순서, `getStored()/setStored()`(localStorage key `awsops-theme`, 기본 `teal`), `applyTheme(t)`(set `<html data-theme>`).
- `web/app/layout.tsx`: `<html lang="ko">`에 **SSR no-flash inline 스크립트**(paint 전 localStorage 읽어 `data-theme` 설정) 주입. body 클래스는 그대로(`bg-paper text-ink-800`).
- **헤더/사이드바 크롬 토큰화**:
  - `Sidebar.tsx`: 컨테이너 `bg-paper-muted`→`bg-chrome-muted`, 텍스트 `text-ink-*`→`text-chrome-fg(-muted)`, 보더 `border-ink-*`→`border-chrome-border`, active item `bg-claude-500 text-white`→`bg-chrome-active text-chrome-active-fg`(또는 `bg-brand-500`는 light에서 유지하되 console에서 위 토큰으로) — light/console 모두 자연스럽게.
  - `layout.tsx`의 상단 헤더(있으면)도 `bg-chrome`/`text-chrome-fg`.
- **테마 선택기 UI**:
  - `web/components/shell/ThemeToggle.tsx`: 사이드바 푸터 3-way 세그먼트(Teal·Azure·Console) 또는 드롭다운. 클릭 시 `applyTheme`+persist.
  - `CommandPalette.tsx`: "Theme: Teal / Azure / Console" 명령 3개 추가(Cmd-K).

### 5. 차트 (`components/charts/theme.ts`)
하드코딩 hex(`CHART`, `PALETTE`, `TOOLTIP_STYLES`)를 **`var(--chart-*)` 문자열**로 교체(SVG fill/stroke는 `var()` 허용). 예: `PALETTE = ['var(--chart-1)', … 'var(--chart-5)']`, `CHART.grid='var(--chart-grid)'`, tooltip bg `var(--ink-800)`. recharts가 `var()`를 못 받는 prop(있다면, 예: gradient `<stop stop-color>`)은 런타임 `getComputedStyle`로 해석하는 작은 헬퍼 또는 고정 AgentCore hex로 처리(구현 시 식별).

### 6. 정리 (하드코딩 / 잔존 의미색)
- `components/ui/AwsopsMark.tsx`: Claude 오렌지 hex → brand 토큰(`currentColor`/`var(--brand-500)`)로. (마크 §7)
- `app/topology/page.tsx`, `components/charts/AreaTrend.tsx`: 하드코딩 hex → `var(--chart-*)`/토큰.
- `components/ui/components.test.tsx`: 색 단언을 새 토큰/teal 값으로 업데이트.
- 잔존 `emerald-*`/`rose-*` 직접 클래스 사용처 → `positive-*`/`negative-*` 토큰으로 치환(grep로 식별).
- `paper` 하드코딩 1곳 → `var(--paper)`.
- **`claude`→`brand` 리네임**: 66개 클래스 사용처 기계적 치환(`bg/text/border/ring/from/to/via/fill/stroke-claude-N`→`-brand-N`). 변경 후 `grep claude` 0 확인.

### 7. 마크 / favicon
- 현 neural-pulse 마크(Claude 오렌지)를 **teal**로 리컬러. 1차: 단색 `var(--brand-500)`(teal). favicon도 teal로 재출력.
- (옵션·후속) Bedrock 스타일 "teal 라운드 타일 + ✦/회로 글리프" 모티프 도입은 별도 검토.

---

## 범위 밖 (YAGNI)
- 사용자별 테마 영속(Aurora 저장) — 1차는 localStorage만. (계정 동기화는 후속.)
- 시스템 prefers-color-scheme 자동 다크 — 명시 선택만.
- 챗/assistant·로그인 화면은 토큰을 이미 거치므로 §1 전환으로 자동 반영. 토큰 미사용 잔존 하드코딩만 §6에서 정리.
- 로고 모티프 전면 재디자인(✦/회로)은 후속.

## 테스트 / 검증
- `vitest`(`web` `npm test`): `components.test.tsx` 갱신 + 테마 적용 유닛(applyTheme가 data-theme set, localStorage round-trip).
- 빌드: `next build`(standalone) tsc 통과 — 토큰 리네임 누락 시 클래스 미정의로 무시되므로 **빌드 후 `grep -r "claude" web/app web/components` = 0** 게이트.
- 수동: 3테마 토글 → 사이드바/버튼/차트/KPI 색 전환, console 다크 크롬, no-flash(새로고침 시 깜빡임 없음), 대비(teal 텍스트는 brand-700).
- 배포: `make deploy`(web 이미지만, arm64 빌드→ECR→ECS 롤링→`/api/health` smoke). terraform/migrate 무관.

## 파일 영향 요약
| 파일 | 변경 |
|--|--|
| `web/tailwind.config.ts` | 토큰 var() 전환, `claude`→`brand`, `chrome`/`positive`/`negative`/`warning` 추가 |
| `web/app/globals.css` | 쿨 뉴트럴, 3 `[data-theme]` 블록(brand/chrome/chart), 의미색, shadow 쿨화, alias 정리 |
| `web/app/layout.tsx` | no-flash inline 스크립트 + 헤더 크롬 토큰 |
| `web/components/shell/Sidebar.tsx` | 크롬 토큰화(paper-muted→chrome, claude→brand/active) |
| `web/components/shell/CommandPalette.tsx` | Theme 명령 3개 |
| `web/components/shell/ThemeToggle.tsx` (신규) | 사이드바 푸터 선택기 |
| `web/lib/theme.ts` (신규) | 테마 목록/적용/영속 |
| `web/components/charts/theme.ts` | var() 기반 팔레트 |
| `web/components/ui/AwsopsMark.tsx` | teal 리컬러 |
| `app/topology/page.tsx`, `charts/AreaTrend.tsx`, `ui/components.test.tsx` | 하드코딩/단언 정리 |
| (전역) `claude`→`brand` 66곳, `emerald/rose`→`positive/negative` 잔존 치환 | 기계적 |
| `web/public/favicon*`, mark | teal 재출력 |
