# ADR-014: 횡단 관심사 — 캐시 · i18n · CDN 캐싱 / Cross-cutting concerns — caching · i18n · CDN caching

## Status / 상태

Accepted (2026-06-22) — consolidated. consolidates: 017, 026, 028

채택됨 (2026-06-22) — 통합. 통합 대상: 017(캐시 워머 프리워밍), 026(i18n LanguageProvider), 028(CloudFront CACHING_DISABLED)

> 이 ADR은 세 개의 횡단 결정을 하나로 합친다. 단일 Status를 가지며, 각 결정의 현행(net) 상태만 기술한다. 세부 v1 메커니즘 이력은 통합된 원본 ADR(017/026/028)에 보존된다.
>
> This ADR consolidates three cross-cutting decisions under a single Status, recording only the current (net) stance of each. Per-decision v1 mechanism history remains in the consolidated source ADRs (017/026/028).

## Context / 컨텍스트

AWSops는 세 가지 횡단 관심사 — 데이터 신선도(캐시), 사용자 언어(i18n), 엣지 전송(CDN 캐싱) — 를 운영 대시보드 성격에 맞춰 결정했다. 셋 모두 "실시간 운영 상태를 신뢰성 있게 보여준다"는 제품 가치를 떠받치는 성능·정확성 트레이드오프이며, 개별 페이지가 아니라 앱 전반에 걸친다.

AWSops decides three cross-cutting concerns — data freshness (caching), user language (i18n), and edge delivery (CDN caching) — in line with its operations-dashboard nature. All three are performance/correctness trade-offs that span the whole app (not a single page) and underpin the product promise of reliably showing live operational state.

## Decision / 결정

### 1. 캐시 — 백그라운드 프리워밍 (구 ADR-017) / Caching — background prewarming

대시보드가 호출하는 쿼리를 백그라운드 워머가 주기적으로 실행해 공용 캐시를 채워, 사용자 요청이 첫 렌더 시점에 워밍된 히트를 만나게 한다. 핵심 규칙: 지연 초기화(첫 API 요청에서 시작, 부팅이 데이터 백엔드 가용성에 의존하지 않음) · 배치 슬롯 일부를 라이브 트래픽용으로 예약 · 느린 모니터링 쿼리는 워밍 제외(필요 시 직접 조회) · 멀티 어카운트는 계정별 캐시 키로 격리 · fail-soft(실패 사이클은 로깅 후 다음 주기 재시도, 재진입 가드).

A background warmer periodically runs the queries the dashboard pages would issue, filling the shared cache so user requests hit a warm entry on first render. Core rules: lazy init (started on the first API request; boot never depends on data-backend availability) · reserve a fraction of batch slots for live traffic · exclude slow monitoring queries from warming (fetched on demand) · isolate multi-account via per-account cache keys · fail-soft (a failed cycle is logged and retried next interval, with a re-entry guard).

### 2. i18n — LanguageProvider + 평면 번역 맵 (구 ADR-026) / i18n — LanguageProvider + flat maps

커스텀 React Context(`LanguageProvider`)가 `{ lang, setLang, t }`를 제공하고, 평면 키-값 JSON 번역 맵(ko/en)을 정적으로 번들에 포함한다. 라우트 세그먼트 로케일(`/en/...`) 없이 라우터 비의존. 언어 선택은 `localStorage`에 저장되며 기본값은 `ko`, 누락 키는 영어 폴백 후 키 자체로 graceful degrade. 선택 언어는 `lang` 파라미터로 AI(AgentCore/스트리밍) 경로까지 전달되어 응답이 사후 번역 없이 선택 언어로 생성된다. v2 MVP 적용 범위는 **shell/네비게이션**이며, 페이지 본문 번역은 점진 적용(현행 부분 적용 — 감사 finding 참조).

A custom React Context (`LanguageProvider`) exposes `{ lang, setLang, t }`, statically bundling flat key-value JSON maps (ko/en). Router-agnostic, with no route-segmented locales (`/en/...`). Language choice persists in `localStorage`, defaults to `ko`, and missing keys degrade gracefully via an English fallback then the key itself. The selected language flows through the `lang` parameter into the AI (AgentCore/streaming) paths so responses are generated in the chosen language with no post-hoc translation layer. The v2 MVP scope is **shell/navigation**; page-body translation is applied incrementally (currently partial — see audit finding).

### 3. CDN 캐싱 — CloudFront CACHING_DISABLED (구 ADR-028) / CDN caching — CloudFront CACHING_DISABLED

CloudFront 디스트리뷰션의 default behavior(동적 대시보드·API)에는 `CACHING_DISABLED`를 적용하고, 콘텐츠 해시 정적 자산 경로(`_next/static`)에만 `CACHING_OPTIMIZED`를 유지한다. 모든 동적 응답은 엣지 캐싱 없이 오리진으로 전달된다. 정책 레벨 강제로 "핸들러가 `no-store`를 빠뜨려 실시간 상태가 공용 캐시에 유출"되는 버그 부류를 제거하고, 엣지 인증(viewer-request)이 매 요청 발화함을 보장한다. 신선도는 앱 레벨 캐시(결정 1)가 담당하며, CloudFront는 캐싱 외 역할(TLS 종료, Shield, 엣지 인증 연결점, 오리진-facing SG)로 요청 경로에 유지된다.

The CloudFront distribution applies `CACHING_DISABLED` to the default behavior (dynamic dashboard + API) and keeps `CACHING_OPTIMIZED` only for the content-hashed static-asset path (`_next/static`). Every dynamic response is forwarded to the origin with no edge caching. Policy-level enforcement removes the bug class where a handler forgets `no-store` and leaks live state into the shared cache, and guarantees the edge auth (viewer-request) fires on every request. Freshness is owned by the app-level cache (Decision 1); CloudFront stays in the request path for its non-cache roles (TLS termination, Shield, the edge-auth attachment point, and the origin-facing SG).

## Rationale / 근거

- **정확성 > 히트율**: 대시보드의 핵심 가치는 "지금 이 순간의 상태"이며 0이 아닌 엣지 TTL은 이를 깨뜨린다. 신선도는 계정별 스코핑을 인지하는 앱 캐시가, 엣지 비-캐시 역할은 CloudFront가 분담한다. / **Correctness over hit rate**: the dashboard's value is "state right now"; a non-zero edge TTL breaks it. The app cache (account-aware) owns freshness; CloudFront owns the edge non-cache roles.
- **정책 레벨 강제 > 응답별 규율**: `CACHING_DISABLED`는 헤더 누락에서 오는 조용한 데이터 유출 버그를 구조적으로 제거한다. / **Policy-level over per-response discipline**: `CACHING_DISABLED` structurally eliminates silent data-leak bugs from missing headers.
- **프리워밍으로 TTL 만료 첫 요청 비용 제거**: 만료 직전 갱신으로 사용자 요청이 거의 항상 워밍된 캐시를 만난다. 모니터링 제외·슬롯 예약은 백엔드 고갈을 막는다. / **Prewarming removes the first-request-after-TTL cost**: refreshing just before expiry means requests almost always hit a warm cache; monitoring exclusion + slot reservation prevent backend starvation.
- **i18n는 문제 영역에 맞춘 최소 구현**: 두 언어·짧은 레이블·ICU 불필요 → 평면 맵 + Context가 외부 의존 0으로 충분하고, 라우트 세그먼트 로케일을 피해 라우터/엣지와 충돌하지 않는다. UI·AI 응답 언어가 `lang`으로 끝까지 일치한다. / **i18n is minimal-to-fit**: two languages, short labels, no ICU need → a flat map + Context suffices with zero external dependency, avoids route-segmented locales that would clash with routing/edge, and keeps UI and AI-response language aligned end-to-end via `lang`.

## Consequences / 결과

### Positive / 긍정적

- 대시보드가 사실상 모든 요청에서 워밍된 캐시로 렌더되어 체감 로딩이 크게 줄고, 엣지 캐싱이 꺼져 있어 낡은 상태가 절대 노출되지 않는다. / Dashboards render from a warm cache on virtually every request (large perceived-latency drop), and with edge caching off stale state is never served.
- 단일 캐시 정책과 외부 의존 0 i18n으로 유지보수 표면이 작다. 엣지 인증이 100% 요청에서 발화하고, 멀티 어카운트가 계정별 키로 격리된다. / A single cache policy and zero-dependency i18n keep the maintenance surface small; edge auth fires on 100% of requests; multi-account is isolated by per-account keys.
- UI 언어와 AI 응답 언어가 `lang` 파라미터로 일관되며, 정적 자산만 엣지/브라우저에서 저렴하게 캐싱된다. / UI and AI-response language stay consistent via `lang`; only static assets cache cheaply at edge/browser.

### Negative / 부정적

- 엣지 캐싱이 없어 모든 동적 요청이 오리진에 도달 → 용량 산정은 전체 피크 기준이어야 하고, 오리진에서 먼 사용자는 전체 RTT 지연을 감수한다(현 규모에서 무시 가능, 대규모 확장 시 재검토). / No edge caching means every dynamic request hits the origin → capacity planning must size for full peak, and distant users pay full RTT (negligible at current scale; revisit at large scale).
- 워머는 유휴 시에도 소량 CPU/네트워크 비용이 있고, 워밍 쿼리 목록·번역 키는 코드/JSON에 선언되어 튜닝/문구 추가에 변경+재배포가 필요하다. 캐시 stale 윈도우(앱 TTL)는 인벤토리에는 허용되나 요청별 메트릭에는 부적합(모니터링 제외 사유). / The warmer incurs small idle CPU/network cost, and the warmed-query list and translation keys live in code/JSON so tuning/adding strings needs a change + redeploy. The app-TTL stale window is acceptable for inventory but not per-request metrics (the monitoring-exclusion reason).
- i18n에 복수형/성별·지역 변형·오프라인 번역 도구·세 번째 언어 확장 용이성이 없고, 언어 설정이 `localStorage`에만 있어 새 브라우저/프라이빗 모드는 기본 `ko`로 시작한다. 현행 페이지 본문 번역은 부분 적용 상태. / i18n has no plural/gender, regional variants, offline-translator tooling, or easy third-language expansion; preference lives only in `localStorage` so new browsers/private mode start in `ko`. Page-body translation is currently partial.

## 6 Pillars / 6대 기둥 (성능 효율성 / Performance Efficiency)

세 결정 모두 Well-Architected **성능 효율성** 기둥에 정렬된다: 백그라운드 프리워밍은 인지 지연을 sub-second로 낮추면서 백엔드 풀을 고갈시키지 않고(슬롯 예약·모니터링 제외), 엣지 `CACHING_DISABLED`는 정확성을 위해 엣지 캐시 이득을 의도적으로 포기하되 정적 자산만 `CACHING_OPTIMIZED`로 저렴하게 전송하며, i18n는 외부 의존 0·번들 포함으로 언어 전환을 네트워크 왕복 없이 즉시 처리한다. 신선도/지연 트레이드오프는 엣지가 아닌 앱 캐시 계층에 집중되어 계정별 스코핑까지 인지한 채 최적화된다.

All three align with the Well-Architected **Performance Efficiency** pillar: background prewarming drives perceived latency to sub-second without starving the backend pool (slot reservation + monitoring exclusion); edge `CACHING_DISABLED` deliberately forgoes edge-cache gains for correctness while still serving static assets cheaply via `CACHING_OPTIMIZED`; and i18n switches language instantly with no network round-trip (zero dependency, bundled). The freshness/latency trade-off is concentrated in the app cache layer (not the edge), optimized with full account-scoping awareness.
