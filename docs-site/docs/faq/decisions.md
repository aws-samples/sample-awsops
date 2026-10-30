---
sidebar_position: 7
title: 설계 원칙 FAQ
description: AWSops가 왜 이렇게 동작하는지 운영자 관점의 Q&A로 정리합니다 — 읽기 전용 자세, 외부 쓰기 거버넌스, AI 라우팅·진단, 인프라 구조, 비용·보안·운영 원칙.
---

# 설계 원칙 FAQ

AWSops가 "왜 이렇게 동작하는가"를 결정하는 핵심 설계 원칙을 운영자가 가장 자주 묻는 질문 형태로 정리했습니다.

:::info
AWSops의 가장 중요한 원칙은 **읽기 전용(read-only)**입니다. 단, 이 제약은 정확히 **AWS 리소스 변경 + 자율 실행(autonomy)**에 묶여 있습니다. 외부 관측성 **데이터 읽기**와 거버넌스 하 외부 **데이터 기록(쓰기)**은 이 제약에 해당하지 않습니다 — 데이터 연산이지 AWS 리소스 변경이 아니기 때문입니다.
:::

## 보안 / Security

### AWSops가 AWS 리소스를 직접 변경하거나 자동으로 조치하나요?

**아니요. AWS 리소스 변경과 자율 실행은 영구적으로 동결(do-not-enable)되어 있습니다.**

변경 작업 프레임워크와 실행 substrate(SSM Automation + Change Manager × 워커)의 코드는 다크(dark) 상태로 보존되지만 플래그는 영구 OFF이며, 활성화하지 않습니다.

- EC2 종료, SG 수정, 스케일링, 배포 같은 **AWS 리소스 변경은 어떤 화면·AI 기능으로도 수행되지 않습니다.**
- 약 160개의 AgentCore MCP Lambda 도구는 모두 read-only입니다.

:::info
"동결"의 범위는 **AWS 리소스 한정**입니다. 통제 층과 워커 실행 분기는 비-AWS 외부 데이터 쓰기에 재사용될 수 있으나, AWS 리소스 자동화 substrate 자체는 동결을 유지합니다.
:::

### Slack·Jira 같은 외부 시스템에 기록을 쓰는 것도 막혀 있나요?

**아니요 — 거버넌스 하에서 허용됩니다.** 이것은 **데이터 레코드**이지 AWS 리소스 변경이 아니기 때문입니다.

비-AWS-리소스 외부 knowledge/comms write(Slack·Notion·Confluence·Jira·ServiceNow 기록·메시지)는 좁게 허용됩니다. read-only 제약은 AWS 리소스 변경 + 자율에 적용되며, **외부 데이터 통합(read+write)은 제외**됩니다.

- 외부 시스템에 리포트·티켓·메시지를 남기는 것은 거버넌스 통제 하에 가능합니다.
- AWS 인프라 자체에 대한 변경 권한은 **어떤 경로로도** 부여되지 않습니다.

### 외부에 쓸 때 내부 정보가 유출될 위험은 없나요?

외부 데이터 쓰기는 **하드 조건** 하에서만 동작하도록 설계되어 있습니다. 핵심 가드는 다음과 같습니다:

- **DLP / redaction** — 외부로 나가는 내용에서 민감 정보를 제거
- **목적지 allowlist** — 승인된 외부 목적지로만 전송
- **SSRF 가드** — 메타데이터/IMDS 차단, 내부 엔드포인트 차단
- **시크릿은 Secrets Manager** 관리
- **human-gate** — 사람 승인 후 전송 (또는 draft-only 폴백)
- **비-AWS-리소스 전용** + **기본 flag-OFF**

:::tip
외부 쓰기는 "예외 허용"이 아니라 **통제 mandate** 하의 데이터-write 표준입니다.
:::

### 로그인은 어떻게 동작하나요?

AWSops는 **인앱 로그인 폼**(`/login`)을 사용합니다.

자체 `/login` 폼이 BFF `POST /api/auth/login`을 호출 → 무서명 공개 Cognito `InitiateAuth(USER_PASSWORD_AUTH)`로 인증 → `awsops_token` 쿠키(id_token, 12시간) 발급. 이후 모든 요청은 Lambda@Edge가 **RS256 JWKS 서명 검증**으로 검사합니다. Hosted UI PKCE 플로우는 다크 폴백으로만 보존됩니다.

Cognito + Lambda@Edge 구성은 최소 권한(REFRESH 미부여)을 따릅니다.

### 관리자 권한은 어떻게 통제되나요?

**서버 측 fail-closed 게이트**입니다.

관리자 기능은 Cognito `admins` **그룹 멤버**이거나 SSM **관리자 이메일 allowlist**에 포함된 사용자에게만 허용됩니다. 둘 중 어느 쪽으로도 확인되지 않으면 기본적으로 차단(fail-closed)됩니다.

## 아키텍처 / Architecture

### 인프라 구조는 왜 단일 EC2가 아닌가요?

AWSops는 v1의 **단일 EC2 모놀리식**을 **Terraform 기반 MSA**로 재구축했습니다.

- **IaC**: Terraform(부분 S3 backend). CDK는 폐기되었습니다.
- **컴퓨트**: ECS Fargate(arm64). web은 Next.js 15 thin-BFF로 루트 경로에서 서빙됩니다.
- **비동기 워커**: 무겁거나 긴/OOM 위험 작업은 web이 직접 처리하지 않고 SQS → ESM(킬스위치) → dispatcher Lambda(멱등) → Step Functions → Lambda 또는 `ecs:runTask.sync` Fargate로 보냅니다.

라이브 Steampipe 쿼리 경로는 없으며, flag-gated 인벤토리 sync만 있습니다.

### 데이터는 왜 Aurora에 저장하나요?

EC2 인스턴스 내 JSON 파일이 아니라 **Aurora Serverless v2(PostgreSQL 17)**에 영속화합니다.

`worker_jobs`(비동기 작업), 채팅 스레드, AI 진단 리포트, 데이터소스 스키마 캐시 등 앱 상태가 모두 Aurora에 저장되며, 앱은 node-pg로 접근합니다. 이로써 인스턴스 재시작·교체에도 상태가 유지됩니다.

### Neptune 같은 그래프 DB를 도입하나요?

**현재는 아니요 — 연기(deferred)되었습니다.**

토폴로지·리소스 그래프는 Postgres 재귀 CTE로 충분히 처리되므로 **Postgres-first** 원칙을 유지하며, Neptune은 옵션으로만 남겨두고 플래그 OFF입니다. 토폴로지 UI는 현행 클라이언트 빌드를 유지하고, 서버 materialize는 소비자가 생길 때 배선합니다.

## AI

### 장애를 AI가 자동으로 분석하고 조치까지 하나요?

**분석(RCA)은 예, 자동 조치(mitigation)는 아니요.**

자율 mitigation/action은 제공하지 않으며, **read-only Triage·조사·RCA만 제공**합니다(권고 전용, 활성화 시 analysis-only). 분석 결과를 토대로 사람이 판단하고 조치합니다.

### RCA(원인 분석) 결과는 어디에 기록되나요?

OpsCenter / Incident Manager 양방향 라이트백으로 기록하도록 설계되어 있습니다.

단, 이 라이트백은 현재 동결된 자동화 substrate의 role을 상속하므로, **자족(self-contained) role 분리와 `rca_writeback_enabled` 활성화 전까지는 flag-OFF·do-not-enable**입니다. 이 라이트백은 **AWS-네이티브 관측 메타데이터 write**로 분류되어 동결 대상이 아니라 데이터처럼 거버넌스되지만, role 분리가 선행되어야 합니다.

### AI 라우팅은 어떻게 동작하나요?

**하이브리드 라우팅**입니다 — 정규식 fast-path + Haiku 5.5 분류기 + 프롬프트 캐싱으로 동작합니다.

게이트 점수는 hybrid 69.2% → **96.9%(+27.7pp) PASSED**로 검증되었습니다. 빠른 정규식으로 명확한 질의를 먼저 잡고, 모호하면 Haiku 분류기로 라우팅합니다. 분류기 타임아웃은 3.5s입니다(글로벌 cross-region 프로파일에서 1s는 부족).

### 반복되는 질문에 AI 비용이 계속 드나요?

**프롬프트 캐싱과 작업 깊이별 모델 선택으로 최적화**됩니다.

- **프롬프트 캐싱** — 약 59% 히트율로 반복 컨텍스트 재계산을 줄입니다.
- **작업 깊이별 모델** — AI 진단은 Light·Mid(8+1섹션)는 Sonnet 기본, Deep(15+1섹션)은 Sonnet 기본·Opus 선택(cost-gate). 분류·라우팅에는 저렴한 Haiku 5.5를 사용합니다.
- Aurora durable token budget(예산 영속)은 v1에 구현돼 있고, 현재 웹 챗 경로 연동은 후속 과제입니다.

### 게이트웨이는 몇 개인가요?

**9개입니다.**

network · container · data · security · cost · monitoring · iac · ops의 8개 AWS 도메인 게이트웨이에 더해, 외부 관측성 커넥터(Prometheus·ClickHouse)를 호스팅하는 **external-obs 게이트웨이**가 아홉 번째로 프로비저닝·라우팅됩니다(9 프로비저닝 / 9 라우트). 챗 키 `observability`는 external-obs로 별칭됩니다.

### 내가 직접 에이전트나 도구를 추가 구성할 수 있나요?

**거버넌스된 커넥터로만 가능합니다** — 큐레이션 커넥터, 공식 프리셋, 또는 관리자가 등록하는 `custom_mcp` 연동입니다.

멀티 에이전트 플랫폼은 프런티어 에이전트(DevOps/Security/FinOps + N)와 Integrations 축을 제공하며, 관리자 구성 Agent Space는 LIVE입니다. 다만:

- **임의 형태의 BYO-MCP는 제공하지 않습니다.** 거버넌스 통제가 없는 MCP 엔드포인트 경로는 허용되지 않습니다.
- 관리자 전용 `custom_mcp` 연동은 이 통제를 갖춘 거버넌스 경로입니다: 관리자만 등록, 계정별 활성화, 관리자가 지정한 노출 도구 상한(비어 있으면 도구를 노출하지 않음), 연결 시 Secrets Manager에서 읽는 자격 증명, 연결 시 SSRF 검사. 공식 프리셋의 호스트 고정은 그대로입니다.
- **변경(mutating) 도구** 중 비-AWS 외부 데이터 write만 외부 쓰기 거버넌스로 좁게 허용되며, AWS 리소스 변경은 제공하지 않습니다.

### Kubernetes(EKS) 진단도 AI가 자동으로 하나요?

**read-only 진단만 제공합니다.**

K8sGPT 하이브리드(MCP로 AgentCore에 통합되는 인클러스터 K8s 진단, Haiku 5.5)는 **read-only Result-CRD 통합(GET-only)만 제공**하며, 자동 조치로 이어지는 배선은 없습니다. EKS 조회는 모두 읽기 전용입니다. 기본 인증 주체는 호스트 클러스터의 web 태스크 역할 또는 멤버 클러스터의 등록된 멤버 읽기 역할(일반적으로 `AWSopsReadOnlyRole`)이며, 해당 역할의 Access Entry·읽기 정책이 필요합니다. 멤버의 메타데이터 조회와 기본 Kubernetes 토큰 서명은 모두 멤버 역할 자격증명을 사용하고, 기존 호스트 역할 Entry만으로는 허용되지 않습니다. 저장된 SA 토큰 또는 명시적 AssumeRole은 별도 허용된 Kubernetes 인증 주체를 사용하며, 멤버 AssumeRole은 같은 멤버 계정의 역할로 제한됩니다. SA 인증은 IAM Access Entry가 필요하지 않지만 메타데이터 권한은 필요합니다. 어떤 방식도 자동 조치를 활성화하지 않습니다.

## 운영 / Operations

### 긴 작업이나 무거운 작업은 어떻게 처리하나요?

**비동기 워커 티어로 enqueue**합니다.

web은 thin-BFF이므로 무거운/긴/OOM 위험 작업을 직접 실행하지 않습니다: `POST /api/jobs` → `worker_jobs`(queued) + SQS → ESM(킬스위치) → dispatcher Lambda(job_id 멱등) → Step Functions가 `$.runtime`에 따라 짧은 작업은 RunLambda, 긴/OOM 위험 작업은 `ecs:runTask.sync` Fargate로 라우팅 → 워커가 직접 running/succeeded 기록 → 실패 시 status_updater Lambda가 failed 기록 → reaper(EventBridge 5분)가 stale 작업을 정합화합니다.

:::tip
ESM에는 킬스위치가 있어 큐 소비를 즉시 중단할 수 있고, dispatcher는 job_id 기준 멱등이라 중복 디스패치가 안전하게 무시됩니다.
:::
