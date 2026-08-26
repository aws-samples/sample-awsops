# Archive — v2 design-document execution history / v2 설계문서 실행 이력

These are the original **dated, phase-oriented** v2 design specs and plans (P1a–P2). They are **historical execution artifacts**, kept for traceability. They have been **superseded by the component-oriented reference set** in [`../reference/`](../reference/), which is the single current source of truth per component.

이 문서들은 v2의 날짜·단계별 원본 설계 spec/plan(P1a–P2)입니다. 이력 추적을 위해 보존하며, 현행 단일 출처인 [`../reference/`](../reference/) 컴포넌트 레퍼런스로 **대체되었습니다**. 신규 작업·구현은 `../reference/`를 보세요.

> Decisions remain in the immutable ADRs (`../../decisions/`). These archived docs and the reference docs both cite them. / 결정은 불변 ADR(`../../decisions/`)에 있으며, 본 archive와 reference 모두 ADR을 인용합니다.

## Original → reference map / 원본 → 레퍼런스 매핑

| Archived document | Superseded by |
|---|---|
| `2026-05-30-awsops-v2-architecture-design.md` (master spec) | [`reference/README.md`](../reference/README.md) |
| `2026-05-30-awsops-v2-p1a-foundation-edge-spine.md` | [`reference/01-edge-network.md`](../reference/01-edge-network.md) |
| `2026-05-31-awsops-v2-p1b-cognito-edge-auth.md` | [`reference/02-auth.md`](../reference/02-auth.md) |
| `2026-05-31-awsops-v2-p1d-web-cicd-auth.md` | [`reference/04-web-bff.md`](../reference/04-web-bff.md) (+ auth hardening → [`02-auth.md`](../reference/02-auth.md)) |
| `2026-05-31-awsops-v2-p1c-aurora.md` | [`reference/03-data-aurora.md`](../reference/03-data-aurora.md) |
| `2026-05-31-awsops-v2-p1f-agentcore-provisioner.md` | [`reference/05-agentcore.md`](../reference/05-agentcore.md) |
| `2026-05-31-custom-agents-skills-design.md` | [`reference/05-agentcore.md`](../reference/05-agentcore.md) |
| `2026-05-31-adr-031-phase1.md` | [`reference/05-agentcore.md`](../reference/05-agentcore.md) |
| `2026-06-02-awsops-v2-p2-async-worker-backbone-design.md` | [`reference/06-workers.md`](../reference/06-workers.md) |
| `2026-06-02-awsops-v2-p2-async-worker-backbone.md` | [`reference/06-workers.md`](../reference/06-workers.md) |
| `2026-05-31-awsops-v2-p1e-eks-onboarding.md` | [`reference/07-eks.md`](../reference/07-eks.md) |

The cross-review records for these phases stay in [`../../reviews/`](../../reviews/) (e.g. `v2-p1d-readiness-architecture-review.md`, `v2-p1f-scope-architecture-review.md`). / 단계별 교차 리뷰 기록은 `../../reviews/`에 그대로 있습니다.
