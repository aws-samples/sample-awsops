# DevOps RCA — Incident Orchestrator, Stage 3 첫 슬라이스 (설계)

> **➡️ AUTHORITATIVE RECORD = [ADR-046](../../decisions/046-devops-rca-incident-orchestrator-eog.md) (2026-06-20).** 이 스펙은 설계 디테일이고, 결정의 단일 소스는 ADR-046. **두 가지 owner 정정 반영**: (1) **D1 정정** — 오케스트레이터는 기존 connector를 직접 wrap하는 게 아니라 **AgentCore "+1"로서 8 섹션 게이트웨이 fabric 위에서 오케스트레이션**(기존 MCP+SigV4 재사용; bounded 툴 = 게이트웨이 페더레이션된 기존 MCP 툴의 큐레이션 서브셋, 게이트웨이 우회 아님; 결정론 컨트롤러가 노드별로 여러 게이트웨이 가로질러 호출·취합). (2) **첫 인시던트 진입** — k8sgpt pod 실패가 아니라 **등록된 알림-소스 integration(AlertManager/Slack/Datadog/generic)의 webhook 알림**(기존 `/api/incidents/webhook`+`normalizeAlert`); 1차 슬라이스는 AlertManager(기존 `normalizeAlertmanager`)로 end-to-end 증명, 등록은 다른 소스로 일반화. k8sgpt는 rules-detect 소스 중 하나.

> Status: Draft (brainstorm → spec). Branch `feat/v2-architecture-design`.
> 멀티-AI 패널 만장일치 PIVOT-TO-RCA-AGENT (2026-06-20, kimi·glm·agy). 결정 브리프: `docs/brainstorm/devops-rca-vs-plugin-registry-brief.md`. 원천 비전: owner Notion "AWSOps 구현 사전지식 + ADR" (자체 ADR-001~010, Proposed).
> 이 스펙은 `2026-06-20-plugin-registry-phase1-design.md`(플러그인 레지스트리)를 **supersede**한다 — 레지스트리는 "두 실제 소비자에서 나중에 추출"로 격하.

## 0. 한 줄 요지
AWSops의 **"1 인시던트 오케스트레이터"**(CLAUDE.md가 비워둔 칸)를, **알림으로 깨어나 read-only RCA를 설명하는 EoG 에이전트**로, AgentCore 안에 챗과 분리된 **두 번째 실행 경로**로 짓는다. Stage 3 첫 슬라이스만.

## 1. 왜 (1차 가치)
- 현재 AI 진단(collector→enumerate→report)은 사용자 구동 리포트 생성기. RCA 에이전트는 **알림 구동 자율 RCA**(PUSH, ~100x 비용 효율, Notion ADR-002).
- ReAct 단독은 SRE 시나리오 11~14%만 해결(ITBench) → **규칙이 감지·LLM은 설명만**(ADR-001) + **결정론 컨트롤러 + LLM 국소추론**(EoG, ADR-003, ReAct 대비 ~7x 정확도·재현성·감사성 = FSI 적합).
- read-only·in-VPC·익명화 → AWSops 번복 독트린(AWS-리소스 변경+자율 동결)에 **완전 부합**. (S4 액션은 동결 유지.)

## 2. 핵심 아키텍처 결정 (확정)

### D1. EoG ⊂ AgentCore (워커 아님)
EoG는 실행 *모델*, AgentCore는 실행 *집*. AgentCore Runtime은 우리 코드를 돌린다 — 그 코드가 ReAct 루프 대신 **결정론적 컨트롤러**. AgentCore를 쓰는 이유(owner 확정):
- **상태**: 여러 게이트웨이를 넘나드는 취합 + long-running 인시던트 세션 → **AgentCore Memory**.
- **AWS-native 라인**: AgentCore를 빼면 on-prem 설계로 미끄러짐. Notion ADR-007("Bedrock AgentCore in-VPC")이 못박음.
→ 오케스트레이터 = **신규 AgentCore 엔트리포인트** (챗 `agent.py`와 분리; 경계 칼같이 — 패널 만장일치).

### D2. 두 실행 경로, 공유 substrate
- **Chat Router** (기존 Strands/AgentCore, 8게이트웨이, 대화형 Q&A) — 불변.
- **Incident Orchestrator** (신규 EoG 컨트롤러, 알림 구동 RCA) — 신규.
- 공유: 동일 커넥터(prometheus/loki/tempo/...)·graph-store·k8sgpt·AgentCore in-VPC. **RCA를 챗 루프에 욱여넣지 않는다.**

### D3. Stage 3는 기존 graph-store로, Neptune은 게이트
1-hop bounded 이웃은 **기존 `lib/graph-store.ts`·`topology.ts`**로 검증(선행 스파이크). **Neptune(ADR-043)은 S2+ multi-hop belief-propagation에서만** 평가 — Stage 3를 막지 않음. 기존 그래프가 1-hop 이웃을 못 주면 그때 Neptune 스파이크로 에스컬레이트.

## 3. Stage 3 데이터 플로우 (read-only)

```
AlertManager / 기존 알림 소스
  └→ POST /api/incidents/webhook   (★ 이미 존재)
       └→ 경량 라우터(Stage3 최소): dedup + deploy-overlap 억제      (ADR-002, ADR-009 일부)
            └→ incident(queued) → InvokeAgentRuntime(incident-orchestrator)

Incident Orchestrator (AgentCore, 결정론 EoG 컨트롤러):
  1. alert 파싱 → failing entity 식별
  2. bounded neighborhood 조회 = failing entity + 그래프 이웃 (graph-store; ADR-004, get_all_* 금지)
  3. 노드별 bounded 툴 호출 (기존 커넥터 wrap):
       get_entity_neighbors / get_recent_deploys / get_exemplar_trace / get_error_logs_for_trace
       + k8sgpt findings (rules-detect, ADR-001)
  4. 노드별 LLM 호출 (Bedrock, 익명화 후): "원인 vs 증상" 라벨링만 — 컨트롤러가 순회 결정, LLM은 루프 안 돎
  5. 컨트롤러가 라벨 취합 → Stage3는 단순 1-hop 집계(풀 belief-propagation 아님) → RCA 설명 리포트
  6. de-anon → incident_rca 저장(Aurora) → /incidents UI 노출
  - 세션 상태: AgentCore Memory (cross-gateway 취합 + long-running)
```

## 4. 컴포넌트

### 4.1 Bounded 툴 4종 (기존 커넥터 wrap; ADR-004 — 너무 넓지도 좁지도 않게)
| 툴 | 반환 | wrap 대상 |
|---|---|---|
| `get_entity_neighbors(entity)` | failing entity + 직접 이웃(상한) | `graph-store.ts`/`topology.ts` |
| `get_recent_deploys(entity, window)` | 최근 배포 마커(deploy_id/version) | 배포 소스 (ADR-009; Stage3는 가용 소스만, 없으면 빈 결과) |
| `get_exemplar_trace(entity)` | exemplar가 가리키는 trace(이웃 포함) | `tempo_mcp.py` |
| `get_error_logs_for_trace(trace_id)` | trace의 에러 로그(~50줄급) | `loki_mcp.py` |
→ `get_all_metrics/get_all_logs`는 **만들지 않는다**(context overload 실패). 반환 상한이 너무 작아도 실패 → 로그 50줄/trace는 이웃 포함.

### 4.2 EoG 컨트롤러 (결정론 Python, AgentCore 엔트리포인트)
- 순회/상태/집계는 코드 소유. LLM은 노드별 "원인 vs 증상" 라벨링 1회씩.
- Stage 3: 1-hop, 단일 인시던트 타입 end-to-end. belief-propagation·multi-hop은 S2.

### 4.3 익명화 (ADR-010, FSI)
- LLM 호출 전 pod명 해시·테이블명 마스킹·PII 제거(k8sgpt --anonymize 패턴), 수신 후 de-anon. 매핑 테이블은 인시던트 세션 스코프(Memory/Aurora).

### 4.4 트리거 라우터 (Stage 3 최소)
- 기존 `/api/incidents/webhook` 확장: dedup(중복 알림) + deploy-overlap 억제만. blast-radius/RUM 필터는 S2+.

### 4.5 저장
- `incident_rca`(신규 마이그레이션, ULID 파일): incident_id FK, failing_entity, rca_label(cause/symptom 트리), evidence_refs, anonymized 여부, model, 생성시각. read 경로는 `/incidents/[id]`.

## 5. 범위 / 비범위

**In scope (Stage 3 첫 슬라이스):**
- 단일 인시던트 타입(예: k8sgpt 감지 pod 실패 또는 알려진 서비스 알림) end-to-end.
- 신규 AgentCore 오케스트레이터 엔트리포인트(결정론 EoG, 1-hop).
- bounded 툴 4종 = 기존 커넥터 wrap.
- 익명화 + read-only RCA 리포트 + `incident_rca` 저장 + `/incidents/[id]` 노출.
- 기존 graph-store 1-hop 이웃 viability 스파이크.

**Out of scope (명시):**
- ❌ S1 OTel 계측/collector 설정 = **고객 몫**(앱 코드 아님; glm 가드레일 — 범용 observability 프로젝트로 번지지 말 것).
- ❌ S2 일반화 감지(anomaly/changepoint·incident digest) — **S3가 툴 경계 증명 후** 게이트.
- ❌ Neptune 서비스-그래프(ADR-043) — S2 belief-propagation 필요 시 평가.
- ❌ S4 자율 액션 — **동결**(번복 독트린; approval-gated도 동결 유지).
- ❌ 풀 belief-propagation·multi-hop·EoG 일반 컨트롤러.
- ❌ 챗 경로(`agent.py`) 변경 — 두 경로 분리 유지.
- ❌ 플러그인 레지스트리(supersede) — 나중에 추출.

## 6. 시퀀싱 게이트 (kimi)
- 기존 graph-store가 1-hop 이웃 적합 → Stage 3 진행. 부적합 → Neptune 스파이크로 에스컬레이트(아키텍처 재고 트리거).
- **S2(감지)는 S3가 툴 경계·EoG 패턴 증명 후** 착수. **S4(액션)는 동결** (S2 정확도 무관하게 독트린상 do-not-enable).

## 7. 에러 처리 / 안전
- 커넥터/그래프 호출 실패 → 해당 노드 evidence 비우고 라벨 "unknown", 인시던트는 계속(부분 RCA > 무응답).
- LLM 호출 실패 → 결정론 evidence만의 raw 리포트로 degrade.
- 익명화 실패 시 **fail-closed**(LLM 호출 안 함) — FSI.
- 전 경로 read-only. 어떤 툴도 AWS 리소스 변경 안 함.

## 8. 테스트 (TDD)
- 컨트롤러: 1-hop 순회 결정론(같은 입력→같은 순회), LLM은 라벨링만 호출(mock).
- bounded 툴: 반환 상한·이웃 포함, `get_all_*` 부재.
- 익명화 round-trip + fail-closed.
- degrade(커넥터 down → unknown 라벨, 인시던트 지속).
- 트리거 라우터 dedup/deploy-overlap.
- read-only 불변(어떤 경로도 mutate 호출 안 함).

## 9. 플랜 단계에서 확정할 열린 결정
- 오케스트레이터: 신규 엔트리포인트 파일 vs `agent.py` 모드 분기 (추천: 분리 파일).
- bounded 툴: 컨트롤러가 커넥터 직접 호출 vs 게이트웨이 MCP 경유 (추천: 기존 게이트웨이/커넥터 재사용).
- 라우터 위치: BFF `/api/incidents/webhook` 확장 vs 별도 Lambda.
- `incident_rca` 스키마 최종 컬럼.
- 첫 인시던트 타입 선정(k8sgpt pod 실패 권장 — 감지·익명화 패턴 기존 자산).
