# co-agent consensus — `.reference` AIOps/DBA patterns → AWSops v2 적용

> 2026-06-10 · 패널: kiro · codex · gemini (3/3, quorum 충분) · Claude 의장
> 출처: `.reference/` (AIOps on DB / DBA-Agent / Samsung DB-Agent workshop — **Amazon Confidential·Samsung 표기**). 외부 패널엔 **탈식별 일반패턴 + v2 컨텍스트만** 전송(원문 미전송, 사용자 동의).
> 대상 영상 `.reference/YADA.mp4`(190MB, 야놀자 케이스 추정)는 미처리.

## 강한 합의 (3/3)
| 패턴 | 매핑 | 우선순위 |
|---|---|---|
| **P2 깊은 Postgres-ops 데이터경로** (pg_catalog/pg_stat, CloudWatch, Performance Insights API) | `data` 게이트웨이 | **HIGH — 만장일치 #1** |
| **P3 안전 가드레일 mutating** (evidence-first, validate-before-exec, 2계층 안전, always CONCURRENTLY / never VACUUM FULL·DROP·DELETE·TRUNCATE) | ADR-029/036 | HIGH (6대 통제 경유 시에만) |
| **P4 토큰 효율** (prompt caching, tool 결과압축, **트리거별 tool 선택/스키마 pruning**) | ADR-033 | HIGH/MED |
| **P5 과거 인시던트 RAG** (pgvector Top-N 유사사례) | Aurora pgvector + ADR-032 트리아지 / ADR-034 | MED |
| **P8 @tool 작성 베스트프랙티스** (명확 docstring/반환형/MCP 재사용) | 9 게이트웨이 전체 | HIGH/MED |
| **P10 DB-ops 유스케이스 분류** (10종) | ADR-031 카탈로그 | LOW/MED |

## 중복 (이미 v2 보유) — 3/3
- **P6 AgentCore 매핑 · P9 notebook→prod**: v2는 이미 AgentCore Runtime(in-VPC)+Memory+SigV4 Streamable HTTP MCP+SQS/SFN 워커+`agentcore_stats`. (codex: observability/cost-trace 강조점만 취득)

## 이견 (dissent)
1. **P1 멀티에이전트 supervisor + A2A `consult_X` tool**: codex HIGH / kiro MED / gemini REDUNDANT.
   → 의장: Lead/Sub *설계*는 ADR-032에 있으나 **미구현**. `consult_X` @tool + `list_available_capabilities` + `temperature=0`는 ADR-032 미명시 **구현 레시피** → 중복 아님(codex 정확).
2. **P2의 RDS Data API 하위옵션**: codex·gemini 권장(서버리스 VPC 배선 회피) / kiro RISKY(in-VPC Fargate라 node-pg 직결, Data API는 2차 인증·지연·1MB 제한).
   → 의장: **타깃 의존** — 우리 app-Aurora/in-VPC 런타임 = 직결(IAM auth); 임의 **고객 Aurora**(타 VPC, Data API 활성) = Data API 후보. 단일 정답 없음.
3. **P7 이모지 ChatOps**: codex·kiro RISKY(승인게이트·감사·kill-switch 우회 금지 → 029/034 경유), gemini 미언급.

## 결론 — 그라인드 반영
**기존 ADR에 흡수할 레시피** (구현 시 자동 반영):
- P3 안전규칙 → **ADR-029/036**
- P1 consult-tool 패턴 → **ADR-032** Lead/Sub 오케스트레이터
- P4 트리거별 tool pruning + 결과압축 → **ADR-033** (v2 슬라이스)
- P8 docstring 위생 → 9 게이트웨이 도구 전반

**순신규 후보** (사용자 결정: 2026-06-10 그라인드엔 미편입, 후속 검토):
- 🆕 **P2 Aurora/Postgres DBA 에이전트** (data 게이트웨이 pg-ops/PI 도구) — 만장일치 최고가치, 실제 기능 공백
- 🆕 **P5 pgvector 인시던트 RAG** — 트리아지/RCA substrate

**의장 최고가치 권고 (3/3 일치):** data 게이트웨이의 깊은 Postgres-ops/Performance Insights 도구 부재가 ADR-032(RCA)·ADR-034(write-back)·proactive health의 binding 제약 → P2를 가장 먼저 닫으면 P3/P5/P4가 모두 더 큰 가치를 낸다.
