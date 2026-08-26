# Phase 3 — 갭 백로그 (V1→V2 미구현/오구현 + 잠복버그)

> 원천: `docs/reviews/2026-06-21-docs-reality-audit.md` §C(parity)·§B8(ai)·§E.
> 규칙: 각 항목 6기둥 매핑 + 우선순위 + 노력(S/M/L) + **posture**(구현 가능 / FROZEN·GATED 차단). 코드 작업은 격리 worktree.
> ⚠️ **posture 차단 항목은 구현 대상 아님** — AWS-리소스 변경·자율은 ADR-005 FROZEN. 백로그에 남기되 "do-not-build"로 표시.

## 우선순위 백로그

| id | 갭 | 상태 | 6기둥 | 우선 | 노력 | posture | 비고 |
|---|---|---|---|---|---|---|---|
| **P0** | | | | | | | |
| g-01 | ECS 서비스 인벤토리(desired/running, launch_type) | MISSING | 운영우수성 | **P0** | M | ✅ 구현가능(read-only) | parity-12. `sync_lambda.py` ecs_service 쿼리 + `inventory-types.ts` 타입 + 페이지. 유일 잔존 P0 |
| **P1** | | | | | | | |
| g-02 | EBS 스냅샷 탭/요약 | MISSING | 안정성 | P1 | M | ✅ 구현가능 | parity-13. ebs_snapshot sync + 타입 |
| g-03 | 컨테이너 CVE/취약점 스캔 | MISSING | 보안 | P1 | L | ⚠️ 설계 선행 | parity-14. v1 Steampipe Trivy 폐기 → 대체 스캐너(ECR scan/Inspector?) 결정 필요. read-only 조회 가능 |
| g-04 | ai-13 observability `SKILL_BASE` 키 부재(잠복버그) | LATENT | 운영우수성 | P1 | **S** | ✅ 구현가능 | observability 활성화 시 무음 ops 폴백. fix=키 추가 or active↔SKILL_BASE 기동 패리티 가드 |
| **P2** | | | | | | | |
| g-05 | ai-10 진단 섹션 스트리밍(ADR-045 #2) | MISSING | 성능/지연 | P2 | M | ✅ 구현가능 | `invoke_model_with_response_stream`. 병렬화는 이미 됨 |
| g-06 | EKS 노드 용량/Pod요청 바차트 | MIS-IMPL | 성능효율성 | P2 | S-M | ✅ 구현가능 | parity-19. NodeRow에 capacity/allocatable/podRequest 추가(read-only) |
| g-07 | 챗 container/iac/observability 섹션 활성화 | MIS-IMPL | 운영우수성 | P2 | S-M | ✅ 구현가능 | parity-20. `sections.ts` active:true + **g-04 선행**(SKILL_BASE 패리티) |
| g-08 | 부서(Cognito group)별 접근제어 | MISSING | 보안 | P2 | M | ✅ 구현가능 | parity-15. admin 이분 → 그룹 기반 페이지 ACL |
| g-09 | Lambda long-timeout(>300s)/메모리 KPI | MISSING | 비용 | P2 | S | ✅ 구현가능 | parity-16. 인벤토리 split kind 추가 |
| g-10 | 컨테이너 Cost 대시보드 | MISSING | 비용 | P2 | M | ✅ 구현가능 | parity-17. cost 페이지 확장(read-only) |
| g-11 | 인시던트 심각도 에스컬레이션(read-only 분류) | MIS-IMPL | 안정성 | P2 | M | 🟡 GATED | parity-21. **read-only 분류/에스컬레이션만**(escalateSeverity) — 자율 mitigation은 ADR-006 GATED/ADR-005 FROZEN. `incident_lifecycle_enabled` 게이트 내 |
| **P3** | | | | | | | |
| g-12 | 옛 `ADR-0NN` 텍스트 참조 정리(runbooks/reference/docs-site) | DRIFT | 운영우수성 | P3 | S | ✅ 문서 | MAPPING으로 resolve되나 경로 링크 갱신 |
| g-13 | PPTX 리포트 내보내기 | MISSING(부분) | 운영우수성 | P3 | M | ✅ 구현가능 | parity-02. DOCX/PDF/MD는 있음 |
| g-14 | i18n 페이지 본문 번역(현재 shell/nav만) | 부분 | 운영우수성 | P3 | L | ✅ 구현가능 | parity-07 |
| **DO-NOT-BUILD (posture 차단)** | | | | | | | |
| x-01 | 이벤트 기반 사전 스케일링(ADR-010) | v1-only | — | — | — | ⛔ FROZEN | parity-18. 사전스케일링=AWS 리소스 변경/자율 → **ADR-005 동결**. v2 미구현은 *의도*. 재도입은 새 ADR+패널+owner-override |

## 권장 순서
1. **g-01(P0 ECS 인벤토리)** — 유일 잔존 P0, read-only, 명확.
2. **g-04(ai-13, S)** — 작고 안전한 잠복버그 제거 → g-07(챗 섹션 활성화) 잠금 해제.
3. P1 나머지(g-02 EBS, g-03 CVE는 스캐너 설계 선행).
4. P2 묶음.

## 실행 규칙
- 각 항목 = 별도 브레인스토밍/계획 가치(특히 g-03 CVE, g-08 ACL, g-11 인시던트). 작은 것(g-04, g-09, g-12)은 바로.
- **전부 read-only** — AWS 리소스 변경 없음. g-11은 GATED 게이트 내 분류만.
- 코드 작업은 격리 worktree(동시 세션 WIP 충돌 회피), path-scoped 커밋.
