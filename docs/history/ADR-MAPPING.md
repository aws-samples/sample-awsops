# ADR 매핑 — 옛(LEGACY) → 새 통합 ADR / brainstorm / v1-only

> 이 표는 옛 ADR 번호와 새 결정의 다리다. **옛 ADR 본문은 working tree에 없다** — git tag `adr-legacy-2026-06-22`로 보존.
> 복원: `git show adr-legacy-2026-06-22:docs/decisions/<옛파일명>.md`
> 현행 진실 = `../decisions/BASELINE.md` + `../decisions/0NN-*.md`. 이 파일은 provenance(언제/왜 추적)용.

| 옛 ADR | 옛 제목 | → 행선지 |
|---|---|---|
| 001 | Steampipe pg Pool | ADR-001 (v2 파운데이션; pg Pool은 v2서 라이브 Steampipe 폐기) |
| 002 | AI 하이브리드 라우팅 | ADR-003 |
| 003 | SCP 차단 컬럼 처리 | ADR-010 |
| 004 | Gateway 역할 분리 | ADR-004 |
| 005 | VPC Lambda → Steampipe | ADR-001 (superseded) |
| 006 | Cost 가용성 Probe | ADR-012 |
| 007 | 리소스 인벤토리 베이스라인 | ADR-010 |
| 008 | 멀티 어카운트 지원 | ADR-011 |
| 009 | 알림 트리거 AI 진단 | ADR-006 (+ADR-008 진단) |
| 010 | 이벤트 기반 사전 스케일링 | **v1-only** — v2 미구현(감사 parity-18). 새 ADR 없음. v2 도입 시 신규 ADR 필요 |
| 011 | 외부 데이터소스 통합 | ADR-007 |
| 012 | SNS 알림 전략 | ADR-013 |
| 013 | 자동 수집 조사 에이전트 | ADR-008 |
| 014 | 리포트 프록시 다운로드 URL | ADR-013 |
| 015 | FinOps MCP Lambda | ADR-012 |
| 016 | Bedrock 모델 선택 전략 | ADR-008 |
| 017 | 캐시 워머 프리워밍 | ADR-014 |
| 018 | AgentCore Memory 격리/보존 | ADR-004 |
| 019 | 진단 리포트 포맷 매트릭스 | ADR-008 |
| 020 | Cognito + Lambda@Edge 인증 | ADR-002 |
| 021 | AI 응답 SSE 스트리밍 | ADR-008 |
| 022 | 알림 웹훅 HMAC-SHA256 | ADR-013 |
| 023 | Admin Role Model | ADR-002 |
| 024 | CDK 3-Stack 분할 | ADR-001 (superseded: CDK→Terraform) |
| 025 | 멀티 라우트 병렬 Synthesis | ADR-003 |
| 026 | i18n LanguageProvider | ADR-014 |
| 027 | Code Interpreter 세션 격리 | ADR-004 |
| 028 | CloudFront CACHING_DISABLED | ADR-014 |
| 029 | 변경 작업 프레임워크 | **ADR-005 (FROZEN)** |
| 030 | ECS Fargate + Aurora + 이중 ECR | ADR-001 |
| 031 | 런타임 커스텀 에이전트·스킬 | ADR-004 (P1/P2 LIVE) · **ADR-005 (P4 mutating=FROZEN)** · ADR-007 (P3 BYO-MCP=큐레이션만, 임의형태 폐기) |
| 032 | 이벤트 트리거 자율 인시던트 | ADR-006 (analysis-only, 자율 mitigation 폐기) |
| 033 | AIOps LLM 비용 최적화 | ADR-008 |
| 034 | 알림 자동 RCA 라이트백 | ADR-006 (GATED) |
| 035 | K8sGPT 하이브리드 | ADR-006 (GATED, GET-only) |
| 036 | 변경·조치 실행 substrate | **ADR-005 (FROZEN)** · ADR-009 (워커 spine 참조) |
| 037 | v2 파운데이션 Terraform | ADR-001 · ADR-009 (워커 티어) |
| 038 | 하이브리드 에이전트 라우팅 | ADR-003 (LIVE) |
| 039 | 멀티 에이전트 플랫폼 | ADR-004 (P1/P2 platform) · ADR-007 (Integrations/외부) |
| 040 | 거버넌스된 외부 write | ADR-007 |
| 041 | "read-only"=리소스 (keystone) | ADR-007 (keystone) |
| 042 | v2 인앱 로그인 | ADR-002 |
| 043 | Neptune 그래프 substrate (옵션) | **BASELINE §2 (deferred 옵션)** — Postgres-first, 새 ADR 없음(도입 시 신규) |
| 044 | v2 챗 멀티-도메인 라우팅 | ADR-003 |
| 045 | AI 진단 지연 (병렬렌더+스트리밍) | ADR-008 (스트리밍은 미구현=후속) |
| 046 | DevOps RCA 인시던트 오케스트레이터 | **brainstorm** — `brainstorm/046-devops-rca-eog-PROPOSED.md` (Proposed, 미결정 탐색; 결정 아님) |
