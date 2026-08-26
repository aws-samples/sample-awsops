# Documentation

프로젝트 문서의 목적별 분류. 각 디렉토리의 자체 CLAUDE.md 를 참고.
Project documentation organized by purpose. Each subdirectory has its own CLAUDE.md.

## 구조 / Structure

| 디렉토리 / Directory | 용도 / Purpose |
|---|---|
| [architecture.md](architecture.md) | 시스템 아키텍처 (단일 파일) |
| [onboarding.md](onboarding.md) | 신규 팀원 온보딩 |
| [INSTALL_GUIDE.md](INSTALL_GUIDE.md) | 설치 가이드 (11단계) |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | 일반 트러블슈팅 모음 |
| [decisions/](decisions/) | **결정 단일 진실 = `BASELINE.md`** + 통합 ADR 001~016 + `ADR-MAPPING.md` (옛 ADR 001~046 본문은 git tag `adr-legacy-2026-06-22`) |
| [runbooks/](runbooks/) | 운영 시나리오별 대응 가이드 |
| [reviews/](reviews/) | 코드 리뷰 / 교차 리뷰 결과 |
| [plans/](plans/) | 구 기획 문서(legacy) — 현행 plan은 `superpowers/plans/` |
| [superpowers/reference/](superpowers/reference/) | v2 컴포넌트별 현행 설계 레퍼런스 (컴포넌트당 단일 출처) / current v2 design, one file per component |
| [superpowers/specs/](superpowers/specs/) | 설계 spec(brainstorming 산출) / design specs |
| [superpowers/plans/](superpowers/plans/) | 구현 계획(writing-plans 산출) — **현행+동결/승계 혼재**; frozen-era 계획(029–036 remediation 등)은 live 아님(ADR-005 FROZEN), 현행 진실은 `decisions/BASELINE.md` |
| [superpowers/archive/](superpowers/archive/) | v2 설계문서 실행 이력 / archived v2 design docs |
| AI_TEST_*.md | AI 어시스턴트 테스트 질문셋 |
| TEST-COVERAGE-PLAN.md | 테스트 커버리지 계획 |

## 문서 규칙 / Conventions
- 모든 신규 문서는 **한국어/영어 병기**
- 결정 현행 진실 = `docs/decisions/BASELINE.md`. 새 ADR = 통합 ADR 최고번호 + 1 (현재 **016**), 같은 PR에서 BASELINE 갱신
- ADR 파일명: `NNN-kebab-case-title.md`
- **현행 진실(decisions/BASELINE + superpowers/reference)과 옛 계획/이력을 섞지 않는다.** `superpowers/plans|specs`·`superpowers/archive`엔 reversed/frozen-era·승계된 문서가 섞여 있으니 live guidance로 단정 말 것 — 변경·자율 관련은 ADR-005 FROZEN이 최종.
- 런북은 `docs/runbooks/CLAUDE.md` 규칙 준수

## 문서 관련 스킬 / Related Skills
- `/sync-docs` — CLAUDE.md 자동 동기화
- `/project-init:add-adr` — 새 ADR 생성
- `/project-init:add-runbook` — 새 런북 생성
- `/project-init:health-check` — 문서 커버리지 검증
