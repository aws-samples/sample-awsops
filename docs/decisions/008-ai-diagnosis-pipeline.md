# ADR-008: AI 진단 파이프라인 (수집기 + 모델선택 + 포맷 + 병렬렌더/스트리밍 + 비용캐싱) / AI Diagnosis Pipeline (collectors + model selection + format + parallel render/streaming + cost caching)

## Status / 상태

Accepted (2026-06-22; amended 2026-06-24) — consolidated / 채택 (2026-06-22; 2026-06-24 개정) — 통합

> **Consolidates / 통합 대상**: ADR-013 (자동 수집 조사 에이전트), ADR-016 (Bedrock 모델 선택 전략), ADR-019 (진단 리포트 포맷 매트릭스), ADR-021 (AI 응답 SSE 스트리밍), ADR-033 (AIOps LLM 비용 최적화), ADR-045 (AI 진단 지연 — 병렬 렌더 + 스트리밍).
>
> 이 ADR은 위 6개 ADR을 하나의 진단 파이프라인 결정으로 합치며, **현행(net) 상태만** 기술한다. v1(`src/`) 시점의 메커니즘(컬렉터 레지스트리·SSE `SendFn`·Puppeteer PDF·node-cache 등)은 *역사적 맥락*으로만 참조하고, v2 라이브 동작을 진실의 기준으로 삼는다.
>
> This ADR folds the six ADRs above into a single diagnosis-pipeline decision and records **the current (net) state only**. The v1 (`src/`) mechanisms (collector registry, SSE `SendFn`, Puppeteer PDF, node-cache, etc.) are cited only as *historical context*; v2 live behavior is the source of truth.

## Context / 컨텍스트

AWSops의 AI 진단은 인프라 증거(인벤토리·CloudWatch·연결된 데이터소스)를 수집해 Bedrock에 넘기고, Well-Architected 형식의 종합 리포트를 산출하는 read-only 기능이다. 이 파이프라인은 단계마다 독립적으로 진화한 여러 결정이 누적된 결과다: (1) 증거 수집 분해, (2) 경로별 Bedrock 모델 배정, (3) 리포트 산출 포맷, (4) 응답 스트리밍, (5) LLM 비용 통제, (6) deep 티어 렌더 지연. 결정들이 6개 ADR에 흩어져 있어 현행 진실과 문서가 어긋났다(특히 v1 메커니즘이 v2에 그대로 적용되는 것처럼 읽힘). 본 ADR은 이를 단일 출처로 통합한다.

AWSops AI Diagnosis is a read-only feature that gathers infrastructure evidence (inventory · CloudWatch · connected datasources), hands it to Bedrock, and produces a Well-Architected-style comprehensive report. The pipeline accreted several independently-evolved decisions: (1) evidence-collection decomposition, (2) per-flow Bedrock model assignment, (3) report output formats, (4) response streaming, (5) LLM cost control, (6) deep-tier render latency. Those decisions were spread across six ADRs, drifting from the live truth (notably reading as if v1 mechanisms still apply to v2). This ADR consolidates them into a single source.

### 현행 사실 (감사 §B8, ai-09~14 기준) / Current facts (per audit §B8)

- **진단 워커는 raw boto3 직접 Bedrock 호출이다.** `scripts/v2/workers/diagnosis/report.py`가 `bedrock-runtime.invoke_model`(Anthropic Messages 프로토콜)을 직접 호출한다 — **Strands가 아니다**. Strands는 도구 루프가 실제로 필요한 대화형 챗 에이전트(`agent/agent.py`, AgentCore)에만 쓰인다. / The diagnosis worker is a raw boto3 direct Bedrock call (`invoke_model`), **not** Strands; Strands is chat-only.
- **deep 15섹션 병렬 렌더는 구현됨**(동시성 제한 풀, 섹션별 타임아웃 격리, `partial` degrade 보존). / Deep 15-section parallel rendering is implemented (bounded concurrency, per-section timeout isolation, `partial` degrade).
- **스트리밍(ADR-045 우선순위 #2)은 미구현 = 후속.** `invoke_model_with_response_stream` 호출은 코드에 0건이며(`report.py` non-stream), 본 통합 ADR도 이를 **미완·후속 작업**으로 정직하게 기술한다(감사 ai-10 DRIFT). / Streaming (ADR-045 priority #2) is **not implemented — a follow-up**; zero `invoke_model_with_response_stream` calls exist (audit ai-10 DRIFT).
- **모델 배정은 `global.*` 크로스리전 추론 프로파일을 유지**한다 — 비용 귀속(`ai_usage_daily`, Bedrock invocation-log) 때문. / Model assignment keeps `global.*` cross-region inference profiles for cost attribution.
- **리포트 포맷은 DOCX/PDF/MD**가 v2 워커 경로에서 산출된다. / Report formats DOCX/PDF/MD are produced by the v2 worker path.
- **비용 통제는 프롬프트 캐싱**(직접 `callBedrock`/`invoke_model` 경로 한정 — 게이트웨이 호출 토큰은 Strands 런타임 내부라 불투명)으로 이뤄진다. / Cost control is prompt caching, scoped to direct-invoke paths only (gateway-call tokens are opaque inside the Strands runtime).
- **환각 방지**: 진단은 read-only이고, 수집된 증거 위에서만 추론하며, 누락/비가용 데이터소스는 치명적이지 않게 스킵하고 coverage note를 남겨 모델이 없는 데이터를 지어내지 않도록 한다. / Hallucination guard: read-only, reasons only over collected evidence, skips missing datasources gracefully, leaves a coverage note so the model does not invent absent data.

## Decision / 결정

진단 파이프라인을 다음 6개 기둥으로 확정한다. 전 구간 **read-only**(AWS 리소스 변경·자율 없음)이며, 진단 렌더 오케스트레이션만 변경 대상이다.

The diagnosis pipeline is fixed on the following six pillars. The whole pipeline stays **read-only** (no AWS-resource mutation, no autonomy); only render orchestration is in scope for change.

### 1. 증거 수집 — 소스별 분해 + 우아한 축퇴 (구 ADR-013) / Evidence collection — per-source decomposition + graceful degradation

증거 수집은 소스별(인벤토리·CloudWatch·K8s·Prometheus·Loki·Tempo·데이터소스)로 분해해 병렬 호출한다. 누락·비가용 소스는 치명적이지 않게 **스킵**하고 도달 가능한 증거만으로 진행하며, 어떤 소스가 비었는지 **coverage note**로 남긴다(멀티 계정·부분 구성 환경에서 우아하게 축퇴). 스코프가 알려지면 incident/alert 컨텍스트로 좁혀 무관 증거가 분석을 희석하지 않게 한다.

Evidence is decomposed per source and gathered in parallel. Missing/unavailable sources are **skipped non-fatally**; the run proceeds on reachable evidence and records a **coverage note** of what was empty (graceful degradation in multi-account / partially-configured environments). When scope is known, narrowing by incident/alert context prevents unrelated evidence from diluting the analysis.

### 2. Bedrock 모델 선택 — 깊이 대 지연 축 (구 ADR-016) / Bedrock model selection — depth-vs-latency axis

표준 모델 ID는 `global.` 크로스리전 추론 프로파일 접두사를 가진 소수만 사용한다:

A small set of canonical model IDs, all with the `global.` cross-region inference-profile prefix:

```
sonnet-4.6 → global.anthropic.claude-sonnet-4-6
opus-4.8   → global.anthropic.claude-opus-4-8
haiku-4.5  → global.anthropic.claude-haiku-4-5-20251001-v1:0
```

- **지연 민감 경로 = Sonnet**: 챗 스트리밍·NL→쿼리. (**라우터 분류기는 Haiku 4.5** — ADR-003/038, Sonnet 아님.) / Latency-sensitive (chat stream, NL→query) = Sonnet; the **router classifier is Haiku 4.5** (ADR-003/038), not Sonnet.
- **깊이 민감 경로 = Opus**: 종합 진단 리포트(다분 백그라운드 잡, 산출물 품질이 결과물). deep 티어는 Sonnet 기본 + Opus 선택(cost-gate). / Depth-sensitive (comprehensive report) = Opus; deep tier is Sonnet-default with opt-in Opus behind a cost gate.
- `global.*`는 **awsops-only 비용 귀속**(`ai_usage_daily`, Bedrock invocation-log)에 필요하므로 유지한다. / `global.*` retained for awsops-only cost attribution.

### 3. 리포트 포맷 — DOCX / PDF / Markdown (구 ADR-019) / Report formats

동일한 고정 섹션 목록을 모든 제너레이터가 순회한다(섹션 순서·TOC 결정적). 현행 v2 워커 경로는 **DOCX**(임원/SRE 리뷰), **PDF**(감사 아카이브·화면 렌더 일치), **Markdown**(엔지니어/티켓 diff)을 산출한다. 포맷마다 워크플로우가 대체 불가능하므로 단일 "범용" 포맷으로 합치지 않는다.

All generators walk the same fixed section list (deterministic order/TOC). The current v2 worker path emits **DOCX** (exec/SRE review), **PDF** (audit archive, matches on-screen render), and **Markdown** (engineer/ticket diff). Each format serves a non-substitutable workflow, so no single "universal" format is used.

### 4. 응답 스트리밍 — SSE 진행 프레임 (구 ADR-021) / Response streaming — SSE progress frames

장시간 AI 플로우(챗 등)는 SSE(`text/event-stream`, `ReadableStream`)로 단계별 진행을 노출한다 — 단일 불투명 상태가 아니라 `status`/`chunk`/`done`/`error` 같은 이름 붙은 프레임. SSE는 HTTP 네이티브라 CloudFront→ALB→Fargate 경로와 엣지 인증을 그대로 유지하고, 취소는 `AbortController`로 동작한다. **진단 리포트 자체의 섹션 출력 스트리밍은 별도이며 아래 #6에서 후속으로 다룬다.**

Long-running AI flows (chat) use SSE (`text/event-stream` + `ReadableStream`) to expose step-by-step progress via named frames (`status`/`chunk`/`done`/`error`) rather than one opaque status. SSE is HTTP-native, preserving the CloudFront→ALB→Fargate path and edge auth; cancellation works via `AbortController`. **Streaming of the diagnosis report's own section output is separate and tracked as a follow-up in #6.**

### 5. LLM 비용 통제 — 프롬프트 캐싱 + 비용 귀속 (구 ADR-033) / LLM cost control — prompt caching + cost attribution

- **프롬프트 캐싱은 AWSops가 통제하는 직접 호출 경로**(분류·합성·15섹션 진단의 `callBedrock`/`invoke_model`)에만 적용된다. 1~3개 AgentCore **게이트웨이** 호출은 Strands 런타임 내부에서 프롬프트가 구성(MCP/SigV4)되어 **불투명**하므로 AWSops 계층의 캐싱 대상이 아니다. / Prompt caching applies only to AWSops-controlled direct-invoke paths; gateway-call tokens are opaque inside the Strands runtime.
- **비용 귀속**: `global.*` 프로파일 + Bedrock invocation-log → `ai_usage_daily` 집계로 awsops-only Bedrock 지출을 귀속한다. / Cost attribution via `global.*` + invocation logs → `ai_usage_daily`.
- 의미(semantic) 응답 캐시(Aurora pgvector)는 **연기**된 후속이다(현행은 정확 일치 캐시까지). / Semantic answer cache (Aurora pgvector) is a **deferred** follow-up.

### 6. deep 티어 지연 — 병렬 렌더(구현) + 스트리밍(후속) (구 ADR-045) / Deep-tier latency — parallel render (done) + streaming (follow-up)

진단 워커(단발 섹션 호출)는 **boto3 `bedrock-runtime` 직접 호출을 유지**한다 — 여기서는 Anthropic SDK 직결 API(IAM/VPC/레지던시/비용귀속 상실)도, `AnthropicBedrock` 래퍼(동일 엔드포인트, 단발 호출 속도 이득 無 → 지연 레버 아님)도 채택하지 않는다. **이 판단은 단발 진단 호출에 한정된다.**

별개 표면인 **멀티턴 챗 에이전트 루프**(AgentCore Runtime, `agent/agent.py`)에는 `ANTHROPIC_AGENT_LOOP_ENABLED`(default OFF·dark) 게이트 하에 **`AsyncAnthropicBedrock`(Bedrock 클라이언트) 기반 커스텀 루프**가 실험으로 허용된다 — 레버는 지연이 아니라 **도구 루프 디버깅성**(Strands 에이전트 루프의 불투명성 제거)이며, **Bedrock 경유라 IAM/VPC/레지던시/비용귀속·invocation-log 귀속이 보존**된다(API 키 없음, 동일 `global.*` 프로파일 + 홈리전). read-only·additive·flag-gated이고 기존 게이트웨이 MCP를 재사용한다(신규 BYO-MCP 아님). 라우팅/런타임 거버넌스는 ADR-003/004 범위.

The diagnosis worker (single-shot per-section calls) keeps the **boto3 `bedrock-runtime` direct call** — there, neither the Anthropic SDK direct-to-API path (loses IAM/VPC/residency/cost-attribution) nor the `AnthropicBedrock` wrapper (same endpoint, no single-shot speed gain → not a latency lever) is adopted. **This judgment is scoped to single-shot diagnosis calls.**

For the distinct surface of the **multi-turn chat agent loop** (AgentCore Runtime, `agent/agent.py`), a custom **`AsyncAnthropicBedrock` (Bedrock-client) loop** is permitted as an experiment behind `ANTHROPIC_AGENT_LOOP_ENABLED` (default OFF, dark): the lever is **tool-loop debuggability** (removing the opacity of the Strands agent loop), not latency, and going **through Bedrock preserves IAM/VPC/residency/cost-attribution + invocation-log attribution** (no API key, same `global.*` profile + home region). Read-only, additive, flag-gated; it reuses the existing gateway MCP (not a new BYO-MCP). Routing/runtime governance stays in scope of ADR-003/004.

우선순위순 지연 최적화:
1. **섹션 렌더 병렬화 — 구현됨.** 동시성 제한 풀(Bedrock TPM/RPM 아래 유지)로 벽시계를 15콜의 합 → 최장 섹션 수준으로 단축. 섹션별 타임아웃 격리·`partial` degrade 계약 보존. / **Parallel per-section rendering — implemented.** Bounded-concurrency pool; wall-clock from sum → ~max; per-section timeout isolation and `partial` degrade preserved.
2. **섹션 출력 스트리밍 — 미구현 = 후속.** `invoke_model_with_response_stream` 적용은 현재 0건(`report.py` non-stream)이며, 체감 first-token 지연을 낮추기 위한 **계획된 후속 작업**으로 남는다(감사 ai-10). / **Section-output streaming — not implemented, a follow-up** (zero `invoke_model_with_response_stream` today; audit ai-10).
3. `global.*` 프로파일 유지 — 측정상 정당화될 때만 특정 티어에 리전 프로파일 고려. / Keep `global.*`; consider a regional profile only with a measured case.

## Consequences / 결과

### Positive / 긍정적
- 진단 파이프라인 전 단계가 하나의 ADR로 합쳐져 단일 출처가 된다(흩어진 6개 ADR의 DRIFT 해소). / Single source for the whole pipeline, resolving drift across six ADRs.
- 소스별 분해 + 우아한 축퇴로 부분 구성 환경에서도 도달 가능한 증거로 진단이 완료된다. / Per-source decomposition + graceful degradation completes diagnosis on reachable evidence.
- 깊이/지연 축 모델 배정으로 비용·지연을 경로 특성에 맞게 통제하며, `global.*`로 비용 귀속을 보존한다. / Depth/latency model assignment controls cost/latency per flow; `global.*` preserves attribution.
- deep 리포트가 순차 합 → 최장 섹션 시간으로 대폭 단축(병렬 렌더 구현). / Deep reports cut from sequential sum to slowest-section time.
- 프롬프트 캐싱이 직접 호출 경로의 비용·첫 토큰 지연을 모두 낮춘다. / Prompt caching lowers both cost and first-token latency on direct paths.
- read-only 불변 — AWS 리소스 변경·자율 없음. / Read-only invariant — no AWS-resource mutation/autonomy.

### Negative / 부정적
- **스트리밍 미완**: 진단 섹션 출력 스트리밍(#6-2)은 후속이라 deep 티어의 체감 first-token 지연 이득은 아직 미실현. / Streaming unshipped: the perceived first-token win for deep tier is not yet realized.
- 병렬 렌더는 동시성 제한·백오프 필수 — 무차별 fan-out은 `ThrottlingException` 위험. / Parallel render needs bounded concurrency + backoff; naive fan-out risks throttling.
- 프롬프트 캐싱은 직접 호출 경로에만 유효 — 게이트웨이 토큰(종종 최대 소비자)은 불투명해 비용 절감 사각이 남는다. / Caching only covers direct paths; gateway tokens (often the largest) stay opaque.
- 다수 포맷 제너레이터 유지 비용 + 포맷 간 패리티 자동 테스트 부재(섹션 드리프트는 리뷰로만 포착). / Multi-format maintenance cost + no automated parity test (section drift caught only by review).
- 모델 ID는 신규 Claude 버전 출시 시 함께 회전해야 함. / Model IDs must rotate together on new Claude releases.

## 6 Pillars (요약) / summary

| # | Pillar | 현행 상태 / State |
|---|---|---|
| 1 | 증거 수집 (소스별 분해 + 우아한 축퇴 + coverage note) | LIVE |
| 2 | Bedrock 모델 선택 (깊이-지연 축, `global.*`) | LIVE |
| 3 | 리포트 포맷 (DOCX/PDF/MD) | LIVE |
| 4 | SSE 진행 스트리밍 (챗 등 장시간 플로우) | LIVE |
| 5 | LLM 비용 통제 (프롬프트 캐싱 직접경로 한정 + `global.*` 비용귀속) | LIVE |
| 6 | deep 티어 지연 (병렬 렌더 = LIVE / 섹션 스트리밍 = **후속·미구현**) | PARTIAL |

## References / 참고 자료

### Internal
- `scripts/v2/workers/diagnosis/report.py` — 진단 워커 `generate()`(병렬 렌더), `_bedrock_render` non-streaming `invoke_model`. 스트리밍(#6-2)은 미구현.
- `agent/agent.py` — Strands 챗 에이전트(도구 루프) — 진단 경로와 별개, 본 ADR이 변경하지 않음.
- `docs/reviews/2026-06-21-docs-reality-audit.md` §B8 (ai-09~14) — 진단 raw boto3 direct·병렬화 구현·스트리밍 미구현(ai-10 DRIFT)·환각 방지 검증.
- Consolidates: ADR-013 / ADR-016 / ADR-019 / ADR-021 / ADR-033 / ADR-045.

### External
- [Amazon Bedrock cross-region inference profiles](https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html)
- [Amazon Bedrock prompt caching](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html)
- [Bedrock `InvokeModelWithResponseStreamCommand`](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/bedrock-runtime/command/InvokeModelWithResponseStreamCommand/) — 섹션 스트리밍(#6-2) 후속의 기반 API.
