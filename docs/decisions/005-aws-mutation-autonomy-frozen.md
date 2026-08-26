# ADR-005: AWS 리소스 변경 · 자율 조치 = FROZEN (do-not-enable) / AWS-Resource Mutation · Autonomous Action = FROZEN (do-not-enable)

## Status / 상태

**Accepted (2026-06-22) — consolidated.** consolidates: **029** (변경 작업 프레임워크 / mutating-action framework), **036** (변경·조치 실행 substrate / remediation-execution substrate), **031 Phase 4** (ADR-029 게이트 경유 mutating 도구 / mutating tools via the ADR-029 gate).

이 ADR은 위 셋의 단일 현행 결정이다. 옛 029/036/031-P4 본문(메커니즘·합의 이력·번복 체인)은 git tag `adr-legacy-2026-06-22`로 보존되며(매핑 `docs/history/ADR-MAPPING.md`), **현행 결정은 본 문서뿐**이다. 한 가지 사실만 기록한다: **AWS-리소스 변경 + 자율 조치는 동결(do-not-enable)**이다 — 명시적 새 ADR + 멀티-AI 패널 + owner-override 전까지(§Decision 3).

This ADR is the single current decision superseding all three. Their historical bodies (mechanism, consensus chains, reversal trail) are preserved in git tag `adr-legacy-2026-06-22` (mapped in `docs/history/ADR-MAPPING.md`); the current decision lives **only here**. It records one fact: **AWS-resource mutation + autonomous action is frozen (do-not-enable)** — until an explicit new ADR + multi-AI panel + owner-override (§Decision 3).

## Context / 컨텍스트

AWSops는 실시간 AWS/Kubernetes 운영 대시보드 + AI 진단 도구다. **read-only**가 제품의 본질이다 (ADR-041 정의: "read-only" 제약 = **AWS-리소스 변경 + 자율 조치**의 부재 — 외부 DATA read/write는 별개로 ADR-007이 거버넌스한다).

과거에 AWSops가 고객 인프라를 변경(이벤트 기반 사전 스케일링 Phase 3, 원클릭 자동 조치, 자율 인시던트 mitigation)하도록 확장하려는 일련의 결정(029 변경 프레임워크, 036 실행 substrate, 031-P4 mutating 도구)이 있었다. 6대 통제(Action Catalog·per-action IAM·2단계 plan→execute 멱등·필수 dry-run·4-eyes 승인·페어 롤백·3중 감사·킬스위치)와 함께 설계·구현되었고, **flag-OFF로 출하**되었다.

**2026-06-11, owner는 3-AI 합의(kiro/codex/gemini)로 이 방향 전체를 번복했다** (git tag `adr-legacy-2026-06-22`의 029/036/031 원문 + `docs/history/reviews/2026-06-11-high-risk-adr-reversal-consensus.md`). 근거: 외부 변경/자율은 소규모 팀이 안전하게 유지할 수 없는 blast-radius이며, AWSops의 가치 명제(read-only 진단)에 불필요하다. 인프라 변경은 운영자의 SSM/Change Manager/IaC/콘솔에 맡긴다.

AWSops is a read-only AWS/Kubernetes ops dashboard + AI diagnosis tool. A past line of decisions (029/036/031-P4) would have let it mutate customer infrastructure (event pre-scaling Phase 3, one-click remediation, autonomous incident mitigation). The full control framework was built and **shipped flag-OFF**. On **2026-06-11 the owner reversed the entire direction** via 3-AI consensus: external mutation/autonomy is blast-radius a small team cannot safely own and is unnecessary to the read-only-diagnosis value proposition. Infrastructure mutation stays with the operator's SSM/Change Manager/IaC/console.

이 동결은 라이브 코드/인프라와 일치한다: `terraform/foundation/variables.tf` `remediation_enabled` default=`false` + description `"⛔ DECISION REVERSED 2026-06-11 — DO NOT ENABLE … Stays false permanently"` (Phase 1 감사 §D / 라이브 패널 §교차검증 #1로 확인).

## Decision / 결정

**AWS-리소스 변경 + 자율 조치는 동결한다 (do-not-enable).**

1. **게이트 플래그는 영구 OFF.** `remediation_enabled` (그리고 AWS-리소스 변경/자율을 활성화하는 모든 후속 플래그)는 default=`false`이며 **켜지 않는다**. 이를 켜는 PR은 regression으로 취급한다. 이는 "아직 안 켠 로드맵"이 **아니다** — **금지(frozen)**다. "frozen"="건드리지 마라"이지 "gated"="조건 충족하면 켜봐"가 아니다 (라이브 패널 C1, 6-AI 권고).

2. **flag-OFF substrate는 보존한다 (삭제 아님).** 6대 통제와 dark 실행 코드(P2 워커 spine의 SSM Automation/Change Manager executor 분기, per-action 카탈로그 골격 등)는 무해하므로 삭제하지 않고 그대로 둔다. 활성 경로가 없으므로 운영 blast-radius는 0이다.

3. **재활성화 절차 (명시).** 이 동결을 되돌리려면 **반드시** 다음을 모두 충족해야 한다:
   - 2026-06-11 reversal을 **명시적으로 번복**하는 **새 ADR** (이 ADR-005를 supersede),
   - **멀티-AI 패널** 검토,
   - **날짜가 박힌 owner-override** 기록.
   조용한 default 토글, 코드 주석 완화, 또는 "clarification" 식 사후 재서술로는 해제할 수 없다. (2026-06-16 거버넌스 규칙: scope-creep 번복 재서술 = 새 패널 + owner-override 필요.)

4. **외부 DATA write는 본 동결의 대상이 아니다 (별개).** Slack/Notion/Jira 기록·메시지·티켓 등 **비-AWS-리소스 외부 데이터 write**는 ADR-007(거버넌스된 외부 데이터 통합)이 별도 control plane(`integrations_write_enabled` 등 자체 플래그 + 전용 킬스위치 + no-AWS-mutation IAM)으로 다룬다. 이미 LIVE인 외부-comms write 인스턴스(예: `diagnosis_notify_enabled` SNS 이메일, 단일 토픽 스코프)가 존재한다. 029/036의 6대 통제 facade 및 lambda executor 분기는 이 외부 DATA write에 **재사용**될 수 있으나(공유 P2 SFN spine, 별도 엔진 아님), 그것은 본 ADR이 동결하는 **AWS-리소스 변경**과 무관하다.

**AWS-resource mutation + autonomous action is frozen (do-not-enable).** (1) `remediation_enabled` and any successor flag that enables AWS-resource mutation/autonomy stay default-`false` and **are not turned on** — a PR flipping one is a regression; this is *frozen* ("do not touch"), not *gated* ("meet the conditions and try"). (2) The flag-OFF substrate (the six controls + dark executor code) is **retained, not deleted** — harmless with no active path. (3) **Re-activation requires** a new ADR explicitly reversing the 2026-06-11 reversal **and** a multi-AI panel **and** a dated owner-override; no silent toggle/comment-softening/"clarification". (4) **External DATA write is out of scope** — governed separately by ADR-007 on its own control plane; the six-control facade may be *reused* there (shared P2 spine, not a second engine) but that is unrelated to the frozen AWS-resource mutation.

## Consequences / 영향

### Positive / 긍정적
- 운영 blast-radius 0. 어떤 AWS 리소스도 AWSops를 통해 변경되지 않는다 — RCE/오작동이 인프라 손상으로 번지지 않는다.
- 제품 경계가 명확하다: read-only 운영 대시보드 + AI 진단. 가치 명제와 신뢰 경계가 단순하다.
- 소규모 팀이 유지·증명해야 할 거버넌스 표면(4-eyes 엔진·체인지 캘린더·감사 상관·롤백 오케스트레이션·교차계정 변경)이 없다.
- substrate 보존으로 외부 DATA write(ADR-007)는 검증된 통제 패턴을 재사용할 수 있다.

### Negative / 부정적
- 대시보드 내 자동 조치(원클릭 스케일링·자율 mitigation·인프라 라이트백)는 불가 — 운영자가 SSM/Change Manager/IaC/콘솔에서 직접 수행해야 한다. 의도된 트레이드오프다.
- dark 코드가 저장소에 남아 유지보수 인지 비용이 약간 있다 (배너·BASELINE §2 동결 항목으로 명시하여 완화).

### Post-acceptance deviations / 채택 후 편차
- *(없음 / none)*

## 6 Pillars (보안 · 운영 우수성) / Six Pillars (Security · Operational Excellence)

본 동결은 Well-Architected의 두 기둥에 직접 정렬한다:

- **보안 / Security**
  - **최소 권한 — 절대형.** 변경 IAM 권한이 활성화되지 않으므로 권한 상승·과대 역할 경로가 원천 차단된다.
  - **공격 표면 축소.** write/mutate API가 라이브가 아니므로 dashboard 침해가 인프라 변경으로 전이될 수 없다 (blast-radius 0).
  - **변경 불가 가드레일.** 동결은 코드 주석·메모리·규율이 아니라 **terraform `*_enabled` default=false + 재활성화 ADR/패널/owner-override 절차**로 강제된다 (anti-drift 메커니즘).
- **운영 우수성 / Operational Excellence**
  - **명확한 경계.** "read-only 진단" 단일 책임 — 운영자가 시스템 행동을 정확히 예측할 수 있다.
  - **거버넌스된 변경 관리.** 재활성화 시 단일 Status·명시 번복·패널·날짜박힌 owner-override를 강제 — 판정 가능한(auditable) 결정 기록.
  - **substrate 보존 + flag 게이트.** dark 코드는 무해하게 유지되고 활성 경로 0 — 운영 위험 없이 미래 옵션(외부 DATA write 재사용)을 남긴다.

This freeze aligns directly with **Security** (absolute least-privilege — no mutation IAM is live; minimized attack surface — no write/mutate path; immutable guardrail enforced by terraform default + re-activation procedure) and **Operational Excellence** (clear read-only boundary; governed, auditable change management; harmless substrate retention behind permanently-OFF flags).
