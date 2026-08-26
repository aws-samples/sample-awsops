# ADR-003: AI 에이전트 라우팅 (하이브리드: 정규식 fast-path + Haiku 분류기 + 교차도메인 자동합성)

## Status

Accepted (2026-06-22) — consolidated. consolidates: 002, 025, 038, 044.

이 ADR은 현행 net 상태만 기술한다. 옛 라우팅 ADR(002 v1 하이브리드 라우팅, 025 멀티-라우트 병렬 합성, 038 정규식+Haiku 하이브리드, 044 v2 챗 멀티-도메인 라우팅+Thread/Agent 바인딩)을 하나로 통합한다.
This ADR records only the current net state, consolidating the prior routing ADRs (002 v1 hybrid routing, 025 multi-route parallel synthesis, 038 regex+Haiku hybrid, 044 v2 chat multi-domain routing + thread/agent binding) into one.

## Context

AWSops 챗은 운영자 질의를 8개 섹션 게이트웨이(network/container/data/security/cost/monitoring/iac/ops) 중 적합한 에이전트로 라우팅해야 한다. 두 가지 라우팅 결함이 누적되어 있었다:

1. **단일-매칭 정규식의 한계.** `web/lib/route.ts`의 first-match 키워드 정규식은 다중 도메인 질의("EKS 파드가 RDS 연결 안 돼")를 첫 매칭(container)으로 강등해 실제 원인(network/data)을 놓쳤고, 무매칭 질의는 비활성 `ops` 섹션으로 떨어졌다.
2. **교차도메인 UX 미결.** 운영자 질의의 상당수가 도메인 경계를 가로지르지만, 사용자가 한 번에 통합 답변을 받을 경로가 정의되지 않았다 — 사용자에게 N개 질문을 따로 하게 하거나 한 게이트웨이의 부분 답변만 주었다.

또한 챗 thread와 에이전트의 바인딩, 그리고 picker 핀 ↔ 전환칩 사이의 우선순위가 정의되지 않아 데드락 위험이 있었다.

The chat must route operator queries to the right section agent among 8 section gateways. First-match regex demoted multi-domain queries to a single (often wrong) section and dropped no-match queries to the inactive `ops` section; cross-domain queries had no single-answer path; and thread↔agent binding plus picker-pin vs switch-chip precedence were undefined.

## Decision

### 1. 하이브리드 라우팅 (정규식 fast-path + Haiku 분류기 + 교차도메인 자동합성)

`classifyRoute(prompt, pinned)`(`web/lib/route.ts` + `web/lib/classifier.ts`)는 단일 섹션이 아니라 **신뢰도가 포함된 랭크된 라우트 집합**을 반환한다.

- **명확 단일-도메인 질의**(신뢰도 임계 위 단일 우세 라우트): 정규식 fast-path → Haiku 분류기 fallback으로 **단일 게이트웨이** 라우팅. 명확 질의(~70%)는 정규식이 즉시·무료 처리하고, 모호/무매칭만 Haiku가 8섹션 top-3 랭킹.
- **교차도메인 질의 감지**(임계 위 라우트 ≥2, 최대 3개로 절단): `Promise.allSettled`로 부채꼴 호출 후 `synthesizeResponsesStreaming()`로 **자동 합성**하여 하나의 병합 답변을 스트리밍한다. **사용자 개입 없이 자동·투명하게 핸드오프**된다.
- **전환칩(switch chips)은 잔존하되 보조 수단으로 강등**: 합성이 다루지 못한 도메인을 끌어오거나 특정 단일 에이전트로 재질의할 때만 쓴다. 교차도메인 답변의 주 경로가 아니다.

### 2. 라우팅 우선순위 래더

```
explicit pin (picker / pin chip)
  > custom agent (routingKeywords)
  > Agent Space active filter (비활성 에이전트는 선택 불가)
  > classifier { single-route (regex > llm)  |  multi-route fan-out + synthesis }
  > active-section fallback (비활성 `ops`로는 절대 폴백 안 함)
```

Agent Space에서 비활성인 에이전트를 picker로 선택하면 정직한 "agent disabled" 메시지를 반환한다(무음 폴백 금지).

### 3. Picker-pin ↔ 전환칩 (데드락 해소)

- picker 선택은 **현재 턴(및 변경 전까지 후속 턴)에만 에이전트를 핀**하며 `chat_messages.meta`에 기록.
- **전환칩 클릭은 활성 핀을 해제하고 칩 타깃으로 재라우팅**한다. 칩은 의도적 사용자 오버라이드이므로 stale 핀을 이긴다 → 핀된 에이전트에서 UI로 빠져나오지 못하는 데드락 제거.

### 4. Thread ↔ Agent 바인딩

- **챗 thread는 에이전트-불가지(agent-agnostic), 라우팅은 턴 단위(per-turn)다.** thread는 대화 컨테이너이지 에이전트 세션이 아니다. 턴 중 에이전트 전환이 새 thread를 fork하거나 컨텍스트를 버리지 않는다.
- **메모리 격리는 `userId` + `accountId`(+ thread) 키이며 에이전트 키가 아니다.** 단일 thread가 여러 게이트웨이를 정당하게 거칠 수 있고, 에이전트별 메모리 파티션은 도입하지 않는다.
- 핀된 에이전트(있다면)와 각 턴이 사용한 라우트는 기존 `done`/`meta` SSE 이벤트에 실린다(신규 이벤트 프레임 없음).

### 5. 세 멀티-에이전트 모델 경계 명시

| 모델 | Owner | 시점 | 메커니즘 |
|---|---|---|---|
| **챗 교차도메인** | 본 ADR | 인터랙티브 챗, 다중도메인 질의 | 1–3 라우트 병렬 fan-out + Bedrock 합성, 턴 단위 |
| **인시던트 페더레이션** | ADR-032 (P4) | 이벤트/알람 트리거 인시던트 라이프사이클 | Step Functions Map 위 Lead/Sub, read-only Sub |
| **외부 통합** | ADR-039 | 에이전트의 외부 SaaS read/write | 단일 MCP egress substrate, 거버넌스 |

챗은 동기·턴 단위, 인시던트는 비동기·오케스트레이션. 챗 대화가 인시던트를 필요로 하면 **명시적으로 에스컬레이션**(ADR-032로 인시던트 오픈)하지 무음 승격은 없다.

### 6. AWSops Assistant (product-help) 경로

제품/사용법 질의("/customization 어떻게?")가 비활성 섹션으로 키워드-라우팅되어 막히던 갭을 메운다.

- 바운드된 제품 KB(`web/lib/awsops-kb.ts`)를 컨텍스트로 주입한 **Bedrock-direct** 답변(`web/lib/assistant.ts`). 모델 = **Haiku via `ConverseCommand`(non-stream)** — web task role의 Bedrock IAM(Haiku만 `bedrock:InvokeModel` 부여, stream/Sonnet 미부여)에 맞춤. 버퍼된 답변을 단일-에이전트 경로처럼 타입라이터 스트리밍.
- 래더 배치: `explicit pin > product-help intent(isProductHelpIntent) > custom keyword > classifier`. **자동-라우팅된 비활성 섹션은 Assistant로 graceful degrade**, **명시적 핀으로 선택한 비활성 섹션은 정직한 🔒 유지**.
- KB-grounded, 인젝션 차단(`<awsops_docs>`/`<user_query>` 태그), never-throws.

### 7. 프롬프트 캐싱 + temperature=0 (agent.py)

`strands-agents==1.41.0`(핀)의 `BedrockConfig`는 `cache_config: CacheConfig(strategy="auto")` + `cache_tools="default"` + `temperature` 공식 지원(`cache_prompt`는 deprecated 미사용). 미지원 버전 대비 try/except graceful no-op. 반복 질의 입력 토큰을 대폭 절감하고 temperature=0으로 툴선택 결정성 확보.

### 8. 분류기 보안 / IAM

- 불변 시스템 프롬프트 + `<query>` 구분자 + 엄격 enum/스키마 검증 + 툴 없음 + advisory-only(권한 결정 불사용).
- web task role에 `bedrock:InvokeModel`(Haiku ARN 한정). 분류기 모델 ID = `global.anthropic.claude-haiku-4-5-20251001-v1:0`. 분류기 타임아웃 = **3500ms**(`CLASSIFIER_TIMEOUT_MS` env 튜너블; `global.` 크로스리전 프로파일은 ap-northeast-2에서 1.9~3.0s 소요하므로 1s는 부족) + 429 백오프 1회.

### 9. AgentCore Gateway 시맨틱 툴 검색 — P4 연기

플랫폼-네이티브 시맨틱 툴 검색(`searchType=SEMANTIC`, "300툴 → ~4 주입")은 명시적으로 **P4로 연기**한다. 페이오프가 전 게이트웨이 함대에 묶여 있고(현재 8섹션 중 read-only 슬라이스만 라이브), 빈 게이트웨이 시맨틱 검색은 유령매칭을 낳으며, 단일 통합 에이전트는 섹션별 `SKILL_BASE` 페르소나를 희석한다. 본 ADR의 하이브리드가 적재하는 오라우팅 로그가 P4 시맨틱 설계의 학습 입력이 된다.

## Consequences

### Positive
- 교차도메인 질의가 **자동 합성된 단일 답변**을 받는다 — 어시스턴트가 "다른 에이전트를 고르라"고 떠넘기지 않는다.
- 라우팅 우선순위가 명문화되어 커스텀 에이전트·Agent Space와의 상호작용이 결정적. picker/칩 데드락 제거.
- thread↔agent 바인딩 정의(에이전트-불가지, 턴 단위)로 Claude-app 대화 모델의 일관된 멘탈 모델 확보.
- 세 멀티-에이전트 모델(챗/인시던트/외부통합) 경계 명시.
- v2 직접 호출 경로의 프롬프트 캐싱으로 반복 질의 입력 토큰 절감 + temperature=0 결정성.

### Negative
- 다중도메인 턴은 두 번째 Bedrock 합성 호출 비용(~+400ms p50, 최악 +4096 출력 토큰)을 병렬 게이트웨이 위에 더한다. 3-라우트 상한 + sub-flag 게이트로 한정.
- 분류기가 단일 섹션이 아닌 **랭크된 멀티-라우트 집합**을 반환 → 골든셋은 정확 일치가 아닌 집합 중첩을 채점.
- 모호 질의에 분류기 지연(상한 3.5s). BFF가 Bedrock Runtime을 직접 호출하는 신규 IAM 표면(Haiku ARN 한정으로 최소화).
- 전환칩이 보조 역할로 좁아져, 교차도메인이 자동임을 UI가 전달해야 한다.

### Gating / LIVE 현황
- **단일-라우트 하이브리드는 LIVE** (`hybrid_routing_enabled`): 게이트 결과 regex 69.2% → hybrid **96.9% (63/65), +27.7pp PASSED** (SLO ≥85% 및 +15pp 충족). 캐싱 검증 GREEN(입력 ~59% 캐시 히트). 분류기 타임아웃 3500ms로 LIVE.
- **멀티-라우트 fan-out + 자동합성 재활성화**는 sub-flag 뒤에서 출하되며 다중도메인 골든셋(집합-중첩 채점) 통과가 전제. 통과 전에는 현행 단일-라우트 + 칩 동작으로 graceful degrade(회귀 없음). 합성은 Sonnet을 쓰므로 활성화 전 web task role IAM 확대가 선행 필요.

### ⚠️ Load-bearing invariant (P3 활성화 전제)
`agent.py`의 `SKILL_BASE`에는 `observability` 키가 없고(`network/container/ops/data/security/monitoring/cost/diagnostics/iac`만 존재), `build_skill_prompt`는 미지 키를 DEFAULT로 무음 폴백한다. 오늘은 `observability`가 `active:false`라 안전하나, **P3에서 어떤 섹션이든 `active:true`로 전환하기 전에 해당 키의 `SKILL_BASE` 엔트리 존재를 확인**해야 한다(또는 active-section↔SKILL_BASE 패리티 기동 체크 추가). 위반 시 잘못된 전문가 프롬프트로 무음 오라우팅된다.

## 6 Pillars

| Pillar | 정렬 |
|---|---|
| **Operational Excellence** | 라우팅 우선순위·thread 바인딩·세 모델 경계 명문화로 결정적 운영. 오라우팅 로그 적재(CloudWatch `switchedFrom`)가 P4 학습 입력. |
| **Security** | 분류기 불변 시스템 프롬프트 + 구분자 태그 + enum 검증 + advisory-only(권한 결정 불사용); IAM은 Haiku ARN 한정 최소권한. Assistant KB는 인젝션 차단·never-throws. |
| **Reliability** | `Promise.allSettled`로 한 게이트웨이 장애가 전체 응답을 죽이지 않음(생존 응답만 합성); 비활성 섹션 graceful degrade(Assistant/활성 대안); sub-flag 게이트로 회귀 0. |
| **Performance Efficiency** | 정규식 fast-path가 명확 질의(~70%)를 즉시·무료 처리; 병렬 fan-out으로 벽시계 = max(게이트웨이) + 합성; 프롬프트 캐싱(입력 ~59% 히트). |
| **Cost Optimization** | 명확 질의는 LLM 분류기 미호출(무료); 3-라우트 상한 + sub-flag로 합성 토큰 비용 한정; 캐싱 읽기 90% 할인; 라우트별 토큰 귀속 기록. |
| **Sustainability** | 불필요한 LLM 호출 회피(정규식 fast-path·캐싱)로 컴퓨트·토큰 소비 최소화. |
