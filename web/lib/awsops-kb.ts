// AWSops product knowledge base — injected as context by the in-app "AWSops Assistant" chat path
// (web/lib/assistant.ts) so the assistant can answer product/how-to questions about AWSops itself.
// Bounded single doc → injected directly as system context (no vector store). Keep it ACCURATE to
// the shipped features; edit this file when the product changes. Korean-primary (user preference).

export const AWSOPS_KB = `# AWSops 제품 가이드 (AI 어시스턴트 KB)

## AWSops란
AWSops는 **읽기 전용(read-only) AWS/Kubernetes 운영 대시보드 + AI 진단** 도구입니다.
- 실시간 AWS 리소스 조회(인벤토리/토폴로지/비용/보안/네트워크), Kubernetes(EKS) 조회, AI 채팅 진단.
- **AWS 리소스 변경·자율 실행은 영구 동결**(SSM/IaC/콘솔은 운영자 몫). 분석은 AWSops, 행동은 사람.
- **외부 데이터 통합은 거버넌스 하 허용**: 외부 관측성 read(Prometheus/Grafana/Datadog 등) + 외부 기록 write(Slack/Notion/Jira 등, flag-OFF·human-gate).

## AI 채팅 / 라우팅 모델
- 질문을 입력하면 **자동 라우팅**으로 섹션 에이전트가 선택됩니다(정규식 fast-path → Haiku 분류기).
- **섹션 에이전트(활성)**: Network, Data, Security, Cost, Monitoring. 각자 라이브 AWS 조회 도구를 가집니다.
- **아직 비활성(로드맵 P3)**: Container, IaC, Ops, Observability. 비활성 섹션으로 질문하면 활성 섹션/어시스턴트로 안내됩니다.
- **교차 도메인 질문**은 여러 섹션을 자동 합성해 하나의 답으로 줍니다(설정에 따라). 수동 전환칩은 보조 수단입니다.
- 특정 에이전트로 고정하려면 채팅 입력에서 \`/<섹션 또는 커스텀에이전트>\`로 핀(pin)할 수 있습니다.

## /customization — 에이전트·스킬·통합 만들기
좌측 메뉴 **Customization** 페이지에서 다음을 구성합니다(계정별 Agent Space 기준):
1. **Integrations(통합)** — 외부 시스템 커넥터를 등록(관리자).
   - **egress-READ**(외부 관측성 읽기): Prometheus·Grafana·Datadog·Loki·ClickHouse 등. endpoint + 인증(SigV4 / API key / OAuth) 입력 → 자격증명은 **Secrets Manager**에 저장, **SSRF 방어**(사설/메타데이터 차단, 사설망은 계정별 opt-in).
   - egress-READ 통합은 에이전트에 **도구 + 컨텍스트**로 주입됩니다.
2. **Skills(스킬)** — \`SKILL.md\`(frontmatter + Markdown) 형태의 분석 지침/노하우. 에이전트에 붙여 행동을 특화합니다. 폼으로 작성하거나 zip 업로드(zip은 관리자 전용).
3. **Agents(에이전트)** — 커스텀 프런티어 에이전트 생성: 이름, 설명, **routingKeywords**(이 키워드가 질문에 있으면 이 에이전트로 라우팅), 1차 게이트웨이, 붙일 스킬/통합, 모델, 응답 언어.
4. **Agent Space(계정별)** — 위 에이전트/스킬/통합을 계정 단위로 **활성화·스코핑**합니다. 활성화된 것만 채팅에서 선택·사용됩니다. 비-관리자 작성은 \`nonAdminAuthoring\` 플래그(기본 OFF)로 통제됩니다.

## 예시: "Prometheus 분석 에이전트" 만들기 (당신의 질문)
좌측 **Customization**에서:
1. **Integrations → New Integration(egress / READ)**: kind=Prometheus, endpoint=당신의 Prometheus URL, 인증 입력 → 저장(자격증명은 Secrets Manager, SSRF 검사 통과 필요).
2. **Skills → New Skill**: 예) "prometheus-rca" — PromQL 작성 요령, 자주 보는 메트릭(에러율·p99·포화도), 분석 절차를 \`SKILL.md\`로 작성.
3. **Agents → New Agent**: 이름 예) "Prometheus Analyst", routingKeywords=[\`prometheus\`,\`promql\`,\`메트릭\`], 1차 게이트웨이=monitoring(또는 적합 섹션), 위 스킬 + Prometheus 통합 attach, 모델/언어 선택.
4. **Agent Space**에서 이 에이전트·스킬·통합을 **활성화**(관리자) → 이제 채팅에서 관련 질문이 이 에이전트로 라우팅되거나, \`/prometheus-analyst\`로 직접 핀 가능.

> 참고: AWSops는 **AWS 리소스를 변경하지 않습니다**. 에이전트는 외부 데이터를 **읽어** 분석/진단하며, 외부 기록 write(티켓·메시지)는 별도 거버넌스(DLP·4-eyes·flag-OFF) 하에서만 동작합니다.

## 관리자 / 권한
- Integration/MCP 등록(egress·자격증명·SSRF 표면)과 Agent Space 활성화는 **관리자**(SSM admin_emails 또는 Cognito 그룹)만 가능.
- 폼 기반 Skill·Agent 작성은 \`nonAdminAuthoring\`(기본 OFF) 활성 시 일반 사용자도 가능(작성물은 기본 비활성, 활성화는 관리자).

## 한계 / 자주 묻는 것
- "비활성 섹션(Container/IaC/Ops/Observability) 에이전트는 왜 안 되나요?" → 로드맵 P3. 현재는 활성 섹션 또는 커스텀 에이전트 + 통합으로 대체하세요(예: Prometheus는 위처럼 Integration+커스텀 에이전트).
- AWS 리소스를 바꿔달라는 요청 → 불가(설계상 read-only). 변경은 SSM/Change Manager/IaC/콘솔에서.
`;
