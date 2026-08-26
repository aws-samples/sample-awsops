# ADR-006: 인시던트 라이프사이클 = ANALYSIS-ONLY (GATED, 자율 mitigation 폐기) / Incident Lifecycle = ANALYSIS-ONLY (GATED, autonomous mitigation abandoned)

## Status / 상태

**Accepted (2026-06-22) — consolidated.** consolidates: **009** (알림 트리거 AI 진단 / alert-triggered AI diagnosis), **032** (이벤트 트리거 자율 인시던트 라이프사이클 / event-triggered autonomous incident lifecycle), **034** (알림 자동 RCA 라이트백 / alert auto-RCA write-back), **035** (K8sGPT 하이브리드 인클러스터 진단 / K8sGPT hybrid in-cluster diagnosis).

이 ADR은 흩어진 인시던트-진단 레거시 결정 4건을 단일 결정으로 통합하고, 2026-06-11 3-AI 합의 reversal/downgrade의 최종 상태를 권위 있게 고정한다. 자율 조치(autonomous mitigation) 경로는 ADR-005(AWS 변경·자율 = FROZEN)로 영구 폐기되며, 본 ADR은 그 위에 남는 **read-only 진단 가치**만 기술한다.

This ADR consolidates four scattered legacy incident-diagnosis decisions into a single record and authoritatively fixes the post-2026-06-11 (3-AI consensus) reversal/downgrade state. The autonomous-mitigation path is permanently abandoned under ADR-005 (AWS mutation + autonomy = FROZEN); this ADR documents only the **read-only diagnosis value** that remains on top of it.

## Context / 컨텍스트

AWSops는 알림(CloudWatch SNS / Alertmanager / Grafana / Generic)이나 수동 트리거로 진입하는 인시던트 진단 능력을 갖는다. 역사적으로 이 영역은 네 개의 ADR로 누적되었다:

- **009** — 알림 트리거 단일 패스 AI 진단(상관분석 엔진 `alert-correlation.ts` 포함).
- **032** — 009를 승계하는 단계별(Trigger → Triage → Investigation → RCA → Prevention) 멀티 에이전트 Lead/Sub 라이프사이클. 원안엔 자율 mitigation 단계 포함.
- **034** — RCA 출력을 OpsCenter/Incident Manager에 양방향 라이트백(외부 관측 메타데이터 write).
- **035** — K8sGPT를 인클러스터 진단 센서로 AgentCore에 MCP 통합. 원안엔 finding → 인시던트 → 라이트백 → remediation 제안(H3a) 배선 포함.

**2026-06-11 3-AI 합의 reversal**(`docs/history/reviews/2026-06-11-high-risk-adr-reversal-consensus.md`)에서 mutating substrate(구 029/036)가 REVERSED·do-not-enable·flag-OFF 동결되었다. 그 결과 032의 자율 mitigation 단계, 034의 라이트백 실행 경로(구 036 substrate 상속), 035의 H3a remediation 배선이 모두 의존하던 기반이 사라졌다. 본 ADR은 이 정리된 상태를 **단일 진실 출처**로 고정한다.

The incident-diagnosis surface accumulated across four ADRs (009, 032, 034, 035). The 2026-06-11 3-AI consensus reversal froze the mutating substrate (former 029/036) as do-not-enable / flag-OFF. That removed the foundation under 032's autonomous-mitigation stage, 034's write-back execution path, and 035's H3a remediation wiring. This ADR fixes the resulting state as a single source of truth.

§D terraform 교차검증과 일치하는 현행 게이트(모두 default `false`):

| flag | 레거시 ADR | 분류 / classification |
|---|---|---|
| `incident_lifecycle_enabled` | 032 | GATED — analysis-only (자율 abandoned) |
| `rca_writeback_enabled` | 034 | GATED — frozen role 상속, decouple 선행 필요 |
| `k8sgpt_enabled` | 035 | GATED — GET-only (Result CRD read), dark 503 |

(009의 알림 인그레스/HMAC 웹훅(ADR-022)은 트리거 진입점으로 유효하게 유지된다.)

## Decision / 결정

**핵심: read-only Triage / 조사(Investigation) / RCA만 수행한다 — 권고 전용(recommendation-only)이며 mutation 라우팅은 금지된다.** 자율 조치 경로는 ADR-005(FROZEN)로 폐기되었고, 본 ADR의 어떤 단계도 ADR-005의 동결 substrate(구 029/036)를 호출하지 않는다.

1. **단일 Status — ANALYSIS-ONLY.** 인시던트 라이프사이클은 단계별(Trigger → Triage → Investigation → RCA → Prevention)로 영속(Aurora)될 수 있으나, **RCA + 권고 텍스트에서 멈춘다.** Mitigation/remediation 실행 단계는 존재하지 않는다(폐기). Prevention은 권고 전용(recommend-only).

2. **mutation 라우팅 금지.** Triage·Investigation·RC 단계의 어떤 에이전트(Lead/Sub 포함)도 변경 도구를 직접 호출하거나 ADR-005 동결 substrate로 라우팅하지 않는다. 출력은 항상 "AWSops 권고(confidence·근거·타임스탬프 라벨)"이며 "확정된 근본 원인"으로 단정하지 않는다.

3. **전부 GATED — default false.** `incident_lifecycle_enabled` · `rca_writeback_enabled` · `k8sgpt_enabled` 모두 기본 비활성. 활성화되더라도 analysis-only(no mitigation 실행, no ADR-005 substrate 호출).

4. **rca_writeback는 자족 role 분리 선행.** 034의 OpsCenter/Incident Manager write는 AWS-네이티브 관측 메타데이터 write(데이터-write처럼 거버넌스)이나, 현재 frozen role을 상속하므로 **자족(self-contained) role 분리 + `rca_writeback_enabled` 토글 전까지 do-not-enable** 유지. (loop-breaker 마커 `CreatedBy=AWSops-AIOps`로 자체 라이트백 재수신 차단 — 인그레스가 마커 이벤트 drop.)

5. **K8sGPT = GET-only.** K8sGPT operator는 read-only ClusterRole(get/list/watch만; create/update/patch/delete 거부) + `--fix` 비활성 + AI backend 없음(deterministic-only `analyze --output json`). AWSops는 `Result` CRD를 **read만** 하고, LLM 설명(narration)은 AWSops AgentCore(Haiku 4.5, in-region)에서 수행한다. 클러스터 write 없음. finding은 "검증할 가설"로 취급, 결정적 데이터 충돌 시 결정적 데이터 우선. H3a(remediation 제안 배선)는 폐기.

6. **추측 금지.** RCA는 수집된 증거(메트릭·로그·이벤트·변경 이력)에 근거해야 하며, 데이터가 불충분하면 신뢰도(HIGH/MEDIUM/LOW)를 낮추고 대안 가설을 명시한다. 알림 페이로드는 공격자 제어 입력으로 간주 — 권한·에이전트 로스터·승인에 영향을 줄 수 없고, RCA 본문은 구조적 입력 격리 + sanity-check를 거친다.

7. **트리거·인그레스 유지.** ADR-022 HMAC 웹훅(CloudWatch SNS / Alertmanager / Grafana / Generic) + 수동 진입은 트리거 entry point로 유효. 009의 상관분석 엔진은 Triage look-back 컴포넌트로 보존(폐기 아님). 실행은 P2 워커 백본(SQS+SFN)에 바인딩되며 `incident_lifecycle` 테이블은 도메인 상태이지 별도 오케스트레이션 spine이 아니다.

**Core: perform only read-only Triage / Investigation / RCA — recommendation-only, no mutation routing.** The autonomous-action path is abandoned under ADR-005 (FROZEN); no stage in this ADR calls the frozen substrate. The lifecycle stops at RCA + recommendation. All three flags are GATED (default false); `rca_writeback` additionally requires decoupling off the frozen role before any activation. K8sGPT is GET-only (reads the `Result` CRD; no cluster writes). No speculation — RCA is evidence-grounded, alert payloads are treated as untrusted. Single Status.

## Consequences / 결과

### Positive / 긍정적
- 진단 가치(상관분석·단계별 조사·RCA·예방 권고·인클러스터 K8s 가시성)는 보존하면서 자율 조치의 폭발 반경을 영구 제거. / Diagnosis value retained; autonomous-action blast radius permanently removed.
- 4개 레거시 ADR의 reversal/downgrade 상태가 단일 권위 문서로 수렴 — 인덱스·배너 drift 제거. / Four legacy decisions converge into one authoritative record; banner/index drift eliminated.
- 모든 게이트가 default false + terraform flag로 강제되어 invariant가 코드로 보장. / All gates default-false, enforced by terraform flags.

### Negative / 부정적
- 그럴듯하게 틀린 RCA가 응답자를 오도할 수 있음 → 권고 라벨 + confidence + 근거 인용으로 완화. / Confidently-wrong RCA risk → mitigated by recommendation labeling + confidence + evidence.
- 라이프사이클 상태 머신(Triage 레이스, 체크포인트/워치독, 멱등성)은 활성화 시 정확 구현이 까다로움. / State-machine correctness is non-trivial if ever enabled.
- K8sGPT는 CNCF Sandbox 성숙도 — 버전 스큐 위험은 버전 핀 + 어댑터 + CI 호환성 테스트로 격리. / Sandbox-maturity coupling, isolated by pinned version + adapter.
- `rca_writeback`는 자족 role 분리라는 선행 작업 없이는 활성화 불가(do-not-enable). / `rca_writeback` blocked on role decoupling.

### 6 Pillars (Well-Architected — 안정성 · 운영 우수성) / Reliability · Operational Excellence
- **안정성 / Reliability**: read-only 자세 + 자율 조치 제거로 진단이 인프라를 변경할 수 없음 → 진단 파이프라인 자체가 장애를 유발하지 않는다. P2 백본 바인딩으로 at-least-once + 멱등 키 + 워치독(stalled 전이)이 멈춘 인시던트를 복구. 모든 경로 default-OFF라 미검증 자동화가 프로덕션에 흘러들지 않음.
- **운영 우수성 / Operational Excellence**: MTTR 단축(상관분석된 RCA 권고를 응답자가 일하는 곳에 전달), 단계별 타임라인 영속(사후 포렌식), 예방 권고 피드백 루프, 결정적 데이터 우선(LLM 가설은 보조). 알림 상관으로 N개 증상 대신 단일 인시던트 진단 → 알림 피로 감소.
