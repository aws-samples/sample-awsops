---
sidebar_position: 7
title: 주요 의사결정 FAQ
description: AWSops의 핵심 아키텍처 의사결정(ADR)을 운영자 관점의 Q&A로 정리합니다 — 읽기 전용 자세, 외부 쓰기 거버넌스, AI 라우팅·진단, 인프라 구조, 비용·보안·운영 결정.
---

# 주요 의사결정 FAQ

AWSops가 "왜 이렇게 동작하는가"를 결정한 핵심 설계 판단(ADR, Architecture Decision Records)을 운영자가 가장 자주 묻는 질문 형태로 정리했습니다. 각 답변에는 근거가 된 ADR 번호를 함께 표기합니다.

전체 의사결정 기록과 상세 맥락은 `docs/decisions/`(ADR 001~044)에서 확인할 수 있으며, 인덱스와 정정 노트는 `docs/decisions/CLAUDE.md`에 있습니다.

:::info
AWSops의 가장 중요한 원칙은 **읽기 전용(read-only)**입니다. 단, 이 제약은 정확히 **AWS 리소스 변경 + 자율 실행(autonomy)**에 묶여 있습니다 (ADR-041). 외부 관측성 **데이터 읽기**와 거버넌스 하 외부 **데이터 기록(쓰기)**은 이 제약에 해당하지 않습니다 — 데이터 연산이지 AWS 리소스 변경이 아니기 때문입니다.
:::

## 보안 / Security

### AWSops가 AWS 리소스를 직접 변경하거나 자동으로 조치하나요?

**아니요. AWS 리소스 변경과 자율 실행은 영구적으로 동결(do-not-enable)되어 있습니다.**

원래 변경 작업 프레임워크(ADR-029)와 실행 substrate(SSM Automation + Change Manager × P2 워커 하이브리드, ADR-036)가 설계되었으나, **2026-06-11 3-AI 합의로 둘 다 번복(REVERSED)**되었습니다. 코드는 다크(dark) 상태로 보존되지만 플래그는 영구 OFF이며, 활성화하지 않습니다.

- EC2 종료, SG 수정, 스케일링, 배포 같은 **AWS 리소스 변경은 어떤 화면·AI 기능으로도 수행되지 않습니다.**
- 약 120개의 AgentCore MCP 도구는 모두 read-only입니다.

:::info
"동결"의 범위는 **AWS 리소스 한정**입니다 (ADR-029/036 2026-06-16 스코프 정정, ADR-041 keystone). 통제 층과 워커 실행 분기는 비-AWS 외부 데이터 쓰기에 재사용될 수 있으나, AWS 리소스 자동화 substrate 자체는 동결을 유지합니다.
:::

### Slack·Jira 같은 외부 시스템에 기록을 쓰는 것도 막혀 있나요?

**아니요 — 거버넌스 하에서 허용됩니다.** 이것은 **데이터 레코드**이지 AWS 리소스 변경이 아니기 때문입니다 (ADR-040, ADR-041).

2026-06-11 번복 이후, ADR-040이 **비-AWS-리소스 외부 knowledge/comms write**(Slack·Notion·Confluence·Jira·ServiceNow 기록·메시지)에 한해 좁은 carve-out을 두었고, ADR-041이 이를 keystone으로 재정합했습니다: read-only 제약 = AWS 리소스 변경 + 자율, **외부 데이터 통합(read+write)은 제외**.

- 외부 시스템에 리포트·티켓·메시지를 남기는 것은 거버넌스 통제 하에 가능합니다.
- AWS 인프라 자체에 대한 변경 권한은 **어떤 경로로도** 부여되지 않습니다.

### 외부에 쓸 때 내부 정보가 유출될 위험은 없나요?

외부 데이터 쓰기는 ADR-040의 **7대 하드조건** 하에서만 동작하도록 설계되어 있습니다. 핵심 가드는 다음과 같습니다:

- **DLP / redaction** — 외부로 나가는 내용에서 민감 정보를 제거 (반대표의 핵심 우려였던 만큼 강하게 명시됨)
- **목적지 allowlist** — 승인된 외부 목적지로만 전송
- **SSRF 가드** — 메타데이터/IMDS 차단, 내부 엔드포인트 차단
- **시크릿은 Secrets Manager** 관리
- **human-gate** — 사람 승인 후 전송 (또는 draft-only 폴백)
- **비-AWS-리소스 전용** + **기본 flag-OFF**

:::tip
2026-06-11 합의가 external-endpoint/egress/SSRF를 scope-creep으로 명시했던 점과의 정합을 위해, ADR-041은 이 해제를 'clarification'이 아닌 **owner-override**로 명기합니다(addendum 반영). 즉 외부 쓰기는 "예외 허용"이 아니라 **통제 mandate** 하의 데이터-write 표준입니다.
:::

### 로그인은 어떻게 결정되었나요?

AWSops는 **인앱 로그인 폼**(`/login`)을 사용합니다 (ADR-042).

자체 `/login` 폼이 BFF `POST /api/auth/login`을 호출 → 무서명 공개 Cognito `InitiateAuth(USER_PASSWORD_AUTH)`로 인증 → `awsops_token` 쿠키(id_token, 12시간) 발급. 이후 모든 요청은 Lambda@Edge가 **RS256 JWKS 서명 검증**으로 검사합니다. Hosted UI PKCE 플로우는 다크 폴백으로만 보존됩니다.

이 결정은 ADR-037 파운데이션 위에 ADR-020(Cognito + Lambda@Edge)을 정제한 것으로, 최소 권한(REFRESH 미부여)을 따릅니다.

### 관리자 권한은 어떻게 통제되나요?

**서버 측 fail-closed 게이트**입니다 (ADR-023).

관리자 기능은 Cognito `admins` **그룹 멤버**이거나 SSM **관리자 이메일 allowlist**에 포함된 사용자에게만 허용됩니다. 둘 중 어느 쪽으로도 확인되지 않으면 기본적으로 차단(fail-closed)됩니다.

## 아키텍처 / Architecture

### 인프라 구조는 왜 단일 EC2가 아닌가요?

AWSops는 v1의 **단일 EC2 모놀리식**을 **Terraform 기반 MSA**로 재구축했습니다 (ADR-037, ADR-030).

- **IaC**: Terraform(부분 S3 backend). CDK는 폐기되었습니다 (ADR-024 → ADR-037이 승계).
- **컴퓨트**: ECS Fargate(arm64). web은 Next.js 14 thin-BFF로 루트 경로에서 서빙됩니다.
- **비동기 워커**: 무겁거나 긴/OOM 위험 작업은 web이 직접 처리하지 않고 SQS → ESM(킬스위치) → dispatcher Lambda(멱등) → Step Functions → Lambda 또는 `ecs:runTask.sync` Fargate로 보냅니다.

ADR-037은 ADR-024를 전면 승계하고 ADR-030의 메커니즘을 정제했습니다(라이브 Steampipe 없음, flag-gated 인벤토리 sync만 확정).

### 데이터는 왜 Aurora에 저장하나요?

EC2 인스턴스 내 JSON 파일이 아니라 **Aurora Serverless v2(PostgreSQL 17)**에 영속화합니다 (ADR-030).

`worker_jobs`(비동기 작업), 채팅 스레드, AI 진단 리포트, 데이터소스 스키마 캐시 등 앱 상태가 모두 Aurora에 저장되며, 앱은 node-pg로 접근합니다. 이로써 인스턴스 재시작·교체에도 상태가 유지됩니다. (Aurora·이중 ECR 의도는 ADR-030에서 유효하며, 4-컨테이너/Service Connect/CDK 메커니즘은 ADR-037이 승계했습니다.)

### Neptune 같은 그래프 DB를 도입하나요?

**현재는 아니요 — 연기(deferred)되었습니다** (ADR-043).

토폴로지·리소스 그래프는 Postgres 재귀 CTE로 충분히 처리되므로 **Postgres-first** 원칙을 유지하며, Neptune은 옵션으로만 남겨두고 플래그 OFF입니다. (2026-06-17 addendum: 5-패밀리 합의로 Postgres-first 재확인; 토폴로지 UI는 현행 클라이언트 빌드 유지, 서버 materialize는 소비자 등장 시 배선.)

## AI

### 장애를 AI가 자동으로 분석하고 조치까지 하나요?

**분석(RCA)은 예, 자동 조치(mitigation)는 아니요** (ADR-032, DOWNGRADED 2026-06-11).

ADR-032는 원래 이벤트 트리거 자율 인시던트 라이프사이클(멀티 에이전트 Lead/Sub)을 정의했으나, 2026-06-11 합의로 **자율 mitigation/action은 폐기**되고 **read-only Triage·조사·RCA만 유지**됩니다(권고 전용, 활성화 시 analysis-only). 분석 결과를 토대로 사람이 판단하고 조치합니다.

### RCA(원인 분석) 결과는 어디에 기록되나요?

OpsCenter / Incident Manager 양방향 라이트백으로 기록하도록 설계되어 있습니다 (ADR-034, KEPT).

단, ADR-034는 현재 frozen 029/036 substrate role을 상속하므로, **자족(self-contained) role 분리와 `rca_writeback_enabled` 활성화 전까지는 flag-OFF·do-not-enable**입니다. ADR-041 coherence addendum(2026-06-17)은 이 라이트백을 **AWS-네이티브 관측 메타데이터 write(제3티어)**로 명시 — FROZEN이 아니라 데이터처럼 거버넌스되지만, role 분리가 선행되어야 합니다.

### AI 라우팅은 어떻게 동작하나요?

**ADR-038 하이브리드 라우팅**입니다 — 정규식 fast-path + Haiku 4.5 분류기 + 프롬프트 캐싱. **2026-06-10 활성화 LIVE**.

게이트 점수가 hybrid 69.2% → **96.9%(+27.7pp) PASSED**로 검증되었습니다. 이전의 11/18-route Sonnet 레지스트리 방식이 아니라, 빠른 정규식으로 명확한 질의를 먼저 잡고 모호하면 Haiku 분류기로 라우팅합니다. (분류기 타임아웃은 3.5s로 정정 — 글로벌 cross-region 프로파일에서 1s는 부족.)

### 반복되는 질문에 AI 비용이 계속 드나요?

**프롬프트 캐싱과 작업 깊이별 모델 선택으로 최적화**됩니다 (ADR-038, ADR-033).

- **프롬프트 캐싱** — 약 59% 히트율로 반복 컨텍스트 재계산을 줄입니다 (ADR-038).
- **작업 깊이별 모델** — AI 진단은 base(8섹션)는 Sonnet 기본, deep(15섹션)은 Sonnet 기본·Opus 선택(cost-gate). 분류·라우팅에는 저렴한 Haiku 4.5를 사용합니다 (ADR-033).
- ADR-033은 Aurora durable token budget(예산 영속)을 정의했습니다 — v1에 구현돼 있고, 현재 웹 챗 경로 연동은 후속 과제입니다.

### 게이트웨이가 9개로 늘었나요?

**아니요 — 8개로 유지됩니다** (ADR-004).

network · container · data · security · cost · monitoring · iac · ops의 **8개 섹션 게이트웨이**가 유지되며, 외부 관측성은 별도의 **"Integrations 축"**(ADR-039)이지 9번째 게이트웨이가 아닙니다.

### 내가 직접 에이전트나 도구를 추가 구성할 수 있나요?

**큐레이션된 커넥터 한정으로 가능합니다** (ADR-039, ADR-031, ADR-041).

ADR-039 멀티 에이전트 플랫폼은 프런티어 에이전트(DevOps/Security/FinOps + N)와 Integrations 축을 도입했고, 관리자 구성 Agent Space(ADR-031 Phase 1/2)는 LIVE입니다. 다만:

- **임의 형태의 BYO-MCP(ADR-031 Phase 3)는 폐기**되었습니다 (2026-06-11 번복). 커넥터는 **큐레이션된 형태**만 허용됩니다 (ADR-041).
- **변경(mutating) 도구(ADR-031 Phase 4)** 중 비-AWS 외부 데이터 write만 ADR-040 거버넌스로 좁게 허용되며, AWS 리소스 변경은 폐기를 유지합니다.

### Kubernetes(EKS) 진단도 AI가 자동으로 하나요?

**read-only 진단만 제공합니다** (ADR-035, DOWNGRADED 2026-06-11).

K8sGPT 하이브리드(MCP로 AgentCore에 통합되는 인클러스터 K8s 진단, Haiku 4.5)는 **read-only Result-CRD 통합(GET-only)만 유지**되고, 자동 조치로 이어지는 배선(H3a → 032/034/029 제안)은 폐기되었습니다. EKS 조회는 task-role Access Entry + View policy 기반으로 모두 읽기 전용입니다.

## 운영 / Operations

### 긴 작업이나 무거운 작업은 어떻게 처리하나요?

**비동기 워커 티어로 enqueue**합니다 (ADR-037).

web은 thin-BFF이므로 무거운/긴/OOM 위험 작업을 직접 실행하지 않습니다: `POST /api/jobs` → `worker_jobs`(queued) + SQS → ESM(킬스위치) → dispatcher Lambda(job_id 멱등) → Step Functions가 `$.runtime`에 따라 짧은 작업은 RunLambda, 긴/OOM 위험 작업은 `ecs:runTask.sync` Fargate로 라우팅 → 워커가 직접 running/succeeded 기록 → 실패 시 status_updater Lambda가 failed 기록 → reaper(EventBridge 5분)가 stale 작업을 정합화합니다.

:::tip
ESM에는 킬스위치가 있어 큐 소비를 즉시 중단할 수 있고, dispatcher는 job_id 기준 멱등이라 중복 디스패치가 안전하게 무시됩니다.
:::

### 이 결정들을 어디서 더 자세히 볼 수 있나요?

전체 ADR(001~044)은 `docs/decisions/`에 있으며, 인덱스·상태·번복/정정 노트는 `docs/decisions/CLAUDE.md`에서 확인할 수 있습니다. 2026-06-11 고위험 번복 합의 문서는 `docs/reviews/2026-06-11-high-risk-adr-reversal-consensus.md`에, 외부 쓰기 해제 합의는 `docs/reviews/2026-06-14-external-write-unfreeze-consensus.md`에 있습니다.
