# ADR-012: Cost / FinOps / 비용 / FinOps

## Status / 상태

**Accepted (2026-06-22) — consolidated.** / **채택됨 (2026-06-22) — 통합.**

Consolidates: **006** (Cost Explorer availability probe), **015** (FinOps MCP Lambda).
통합 대상: **006**(Cost Explorer 가용성 probe), **015**(FinOps MCP Lambda).

> Single source of truth for the v2 Cost/FinOps domain. This ADR describes only what is in code/infra today; it does not speculate about future cost features.
> v2 Cost/FinOps 도메인의 단일 출처. 본 ADR은 **현재 코드/인프라에 존재하는 것만** 기술하며, 향후 비용 기능을 추측하지 않는다.

## Context / 컨텍스트

AWSops는 비용을 두 축으로 다룬다: **(1) AWS 지출 가시성**("얼마를 썼는가", 추세·MoM·예측)과 **(2) AWS 비용 최적화 권고**("얼마를 절약할 수 있는가"). 더해 v2는 자체 AI 기능의 **Bedrock 토큰 비용**을 운영 비용으로 귀속·추적한다.

두 가지 환경 제약이 설계를 좌우한다:
- **MSP/SCP Payer 환경**: Cost Explorer API가 SCP로 차단되거나 타임아웃될 수 있다. 매 요청 반복 실패는 화면 지연과 API 비용($0.01/건)을 유발한다 → 가용성 사전 감지 필요.
- **권고 API의 서로 다른 활성화 모델**: Compute Optimizer(계정 opt-in), Trusted Advisor(Business/Enterprise Support), Cost Optimization Hub(조직 범위) — 지출 보고와 갱신 주기·IAM·가용성이 모두 다르다 → 분리·우아한 비활성 처리 필요.

AWSops is a **read-only** ops dashboard + AI diagnosis (ADR-041). 본 도메인은 전부 read-only: 비용 조회·권고 조회·토큰 귀속이며 AWS 리소스를 변경하지 않는다.

## Decision / 결정

### 1. AWS 지출 가시성 (LIVE) / Spend visibility
- Cost Explorer 기반 지출 뷰: **월별 추세, MoM(전월 대비) 변화, 단순 예측**을 제공한다(`/cost` 페이지 + `/api/cost` BFF).
- 데이터는 read-only Cost Explorer 호출로 파생하며 AWS 리소스를 변경하지 않는다.

### 2. Cost Explorer 가용성 probe (LIVE) — supersedes 006 / 006 승계
- **`costEnabled` 자동 감지**: Cost Explorer 접근 가능 여부를 사전 판별하여, 차단/타임아웃 환경에서는 비용 쿼리를 전송하지 않고 즉시 비활성 상태로 응답한다(MSP/SCP Payer에서 빈 화면·반복 실패·API 비용 회피).
- 결과는 캐시되어 매 요청 probe를 반복하지 않는다(MSP/SCP 상태는 계정 수준이라 자주 변하지 않음).
- **006의 v1 메커니즘은 폐기**: v1의 Steampipe 경량 probe(`aws_cost_by_service_monthly`), `data/config.json` 영구 저장, `data/cost/*.json` 스냅샷 폴백은 모두 v1 전용이며 v2(ADR-037: Steampipe/`data/*.json` 미사용)에는 적용되지 않는다. v2 net = **costEnabled 자동 감지**(Cost Explorer 직접 호출 기반).

### 3. FinOps 비용 분석 도구 (LIVE) — supersedes 015 / 015 승계
- AgentCore Cost 게이트웨이의 FinOps MCP 도구가 **비용 분석/최적화 권고**를 제공한다(rightsizing, SP/RI 커버리지, Cost Optimization Hub, Trusted Advisor 비용 점검 계열).
- **우아한 비활성 처리**: opt-in/Support-plan 게이팅 API는 `AccessDeniedException`/`OptInRequiredException`/`SubscriptionRequiredException`을 포착하여 `{ available: false, reason }` 구조 응답을 반환 → 전체 요청을 실패시키지 않고 AI 라우트가 사용자에게 상황을 설명한다.
- **최소 권한**: 권고 전용 권한(`compute-optimizer:Get*`, `ce:Get*Utilization*`, `cost-optimization-hub:*`, `trustedadvisor:Describe*`)은 read-only이며 지출 분석 도구와 분리된 최소 정책으로 유지한다(ADR-004 역할 분리를 API 계열 단위로 한 단계 확장).
- 015의 "19→20 Lambda" 운영 카운트 등 v1 CDK 시점 수치는 이력이며 v2 현행 배선(`agent/lambda/*` + AgentCore 게이트웨이)이 진실이다.

### 4. Bedrock 토큰 비용 귀속 (LIVE) / Bedrock token-cost attribution
- v2 자체 AI 기능(진단·챗)의 Bedrock 사용량을 **`ai_cost_aggregator`** 워커 Lambda가 집계하여 Aurora **`ai_usage_daily`** 테이블에 일별로 기록한다(`ai_cost_tracking_enabled=true`, 6h 집계 룰).
- **`global.*` 추론 프로파일**을 사용하여 호출 로그 기반으로 AWSops 트래픽만 비용 귀속이 가능하다(`us.*`→`global.*` 마이그레이션이 attribution을 가능케 함).
- `/api/ai-usage`로 노출. read-only(사용량 read+집계 기록은 자체 운영 메타데이터 write이지 AWS 리소스 변경 아님 — ADR-041 데이터 연산).

## Consequences / 결과

### Positive / 긍정적
- 단일 ADR로 비용 도메인(지출·권고·토큰)이 하나의 출처에 모인다(006/015 분산 해소).
- MSP/SCP 환경에서 비용 쿼리/메뉴가 자동 비활성 → 빈 화면·반복 실패·API 비용 $0.
- 권고 도구는 비활성 API를 우아하게 설명하고, 최소 권한 read-only로 유지된다.
- AI 운영 비용(Bedrock 토큰)이 AWSops 단위로 가시화된다.

### Negative / 부정적
- 권고 데이터 신선도는 초가 아닌 일/주 단위 — UI/프롬프트가 "오늘 신규 권고 없음=정상"을 설명해야 한다.
- `global.*` 추론 프로파일 전제 — 비프로파일 호출은 비용 귀속에서 누락된다.
- `ai_usage_daily`는 `global.*` 트래픽이 누적되기 전까지 비어 있다.

## WA 6 Pillars — 비용 최적화 / Cost Optimization
본 도메인은 Well-Architected **비용 최적화(Cost Optimization)** 기둥에 직접 대응한다:
- **지출 가시성**: 월별 추세·MoM·예측으로 소비 추이 관측.
- **최적화 권고**: rightsizing·SP/RI 커버리지·idle 리소스 점검으로 절감 기회 식별(권고 조회는 read-only).
- **자체 운영 비용 추적**: Bedrock 토큰 비용 귀속으로 AI 기능의 비용을 측정·관리.
- 부가적으로 운영 우수성(가용성 자동 감지로 차단 환경에서 불필요한 호출 제거).

## References / 참고
- ADR-004 (Gateway 역할 분리) — 본 ADR이 Lambda/API 계열 단위로 확장하는 원칙
- ADR-016 (Bedrock 모델 선택), ADR-033 (AIOps LLM 비용 최적화) — AI 비용 맥락
- ADR-037 (v2 파운데이션 — Terraform/Aurora, 라이브 Steampipe·`data/*.json` 폐기)
- ADR-041 (read-only = 리소스 한정; 외부/자체 데이터 연산은 거버넌스 하 허용)
- 통합 전 원본: 006(Cost 가용성 Probe), 015(FinOps MCP Lambda)
