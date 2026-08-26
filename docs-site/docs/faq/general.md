---
sidebar_position: 1
title: 일반 FAQ
description: AWSops가 무엇인지, 어떻게 배포·로그인·운영되는지, 인프라를 변경하는지, 데이터는 어디에 저장되는지 등 가장 자주 묻는 질문에 답합니다.
---

# 일반 FAQ

AWSops 대시보드에 대한 일반적인 질문과 답변입니다.

## AWSops는 무엇인가요?

AWSops는 AWS와 Kubernetes 환경을 위한 **실시간 읽기 전용(read-only) 운영 대시보드 + AI 진단** 도구입니다. 주요 기능은 다음과 같습니다:

- **리소스 모니터링**: EC2, Lambda, ECS, EKS, RDS, S3 등 주요 AWS 서비스 현황
- **네트워크 / 토폴로지 시각화**: VPC·서브넷·Security Group, 그리고 CloudFront → LB → Target Group → DB로 이어지는 리소스 그래프
- **보안 분석**: IAM 권한 분석, 컴플라이언스, 취약점 점검
- **비용 관리**: Cost Explorer 기반 비용 분석 및 대시보드
- **AI 어시스턴트**: 자연어 질의로 AWS 리소스 분석 및 문제 해결 (스트리밍 + 도메인 라우팅 + 대화 영속화)
- **AI 진단(Diagnosis)**: 워커가 생성하는 읽기 전용 진단 리포트 (base 8섹션 / deep 15섹션, DOCX·PDF 내보내기)

플랫폼은 **Terraform 기반 MSA**입니다 — 라이브 AWS 조회는 **Amazon Bedrock AgentCore MCP 도구**가 담당하고, 앱 상태는 **Aurora Serverless v2(PostgreSQL 17)**에 영속화됩니다.

:::info
AWSops는 **읽기 전용** 운영 도구입니다. 인프라 현황을 조회·시각화·진단하지만, AWS 리소스를 변경하지 않습니다. 자세한 내용은 아래 "AWSops가 내 인프라를 변경하나요?"를 참고하세요.
:::

## 어떻게 배포되고 어떤 구조로 동작하나요?

AWSops는 **Terraform**(`terraform/foundation/`, 부분 S3 backend)으로 프로비저닝되는 마이크로서비스 아키텍처입니다. 핵심 구성은 다음과 같습니다:

| 계층 | 구성 |
|------|------|
| **IaC** | Terraform (S3 partial backend, `use_lockfile`). CDK는 폐기됨 |
| **엣지** | CloudFront(TLS) → VPC Origin(`https-only:443`) → 내부 ALB HTTPS:443(리전 ACM) → Fargate. **공개 ALB 없음** |
| **컴퓨트** | ECS Fargate(arm64). web은 Next.js 14 thin-BFF, **루트 경로(`/`)** 서빙 |
| **데이터** | Aurora Serverless v2 (PostgreSQL 17), node-pg로 접근 |
| **AI** | AgentCore Runtime + 8개 섹션 게이트웨이의 MCP Lambda 도구(라이브 조회) |
| **비동기 워커** | SQS → ESM(킬스위치) → dispatcher Lambda → Step Functions → Lambda 또는 Fargate |

무겁거나 길거나 메모리(OOM) 위험이 있는 작업은 web이 직접 처리하지 않고 **비동기 워커 티어**로 보냅니다: `POST /api/jobs` → `worker_jobs` 큐 적재 → SQS → 멱등 dispatcher Lambda → Step Functions가 작업 길이에 따라 짧은 작업은 RunLambda, 긴/OOM 위험 작업은 `ecs:runTask.sync` Fargate로 라우팅합니다. 실패는 status_updater Lambda가 기록하고, reaper(EventBridge 5분)가 stale 작업을 정합화합니다.

:::tip
엣지는 **단대단 TLS**입니다. CloudFront → 내부 ALB가 TLS로 연결되며, ALB SG는 CloudFront 관리형 SG `CloudFront-VPCOrigins-Service-SG`로부터 443을 허용합니다. 별도의 X-Custom-Secret 헤더나 관리형 prefix list는 사용하지 않습니다.
:::

## AWSops가 내 인프라를 변경하나요?

**아니요.** AWSops는 **읽기 전용 운영 대시보드 + AI 진단** 도구입니다. **AWS 리소스 변경과 자율 실행(autonomy)은 영구적으로 동결(do-not-enable)**되어 있습니다. 어떤 화면이나 AI 기능도 EC2를 종료하거나, SG를 수정하거나, 인프라를 변경하지 않습니다.

AI 어시스턴트와 진단은 라이브 데이터를 **조회**하여 분석·진단할 뿐, 변경(mutation)을 수행하지 않습니다. 약 120개의 AgentCore MCP 도구는 모두 read-only입니다.

거버넌스 하에 허용되는 유일한 "쓰기"는 **외부 데이터 기록**입니다 — 예를 들어 외부 시스템에 리포트·티켓·메시지를 남기는 것입니다. 이는 다음 가드 하에서만 동작합니다:

- SSRF 가드(메타데이터/IMDS 차단, destination allowlist)
- 시크릿은 Secrets Manager로 관리
- DLP / redaction
- human-gate(사람 승인)
- 기본 flag-OFF

:::info
외부 "쓰기"는 **데이터 레코드**(티켓·메시지·리포트)이지 **AWS 리소스 변경이 아닙니다**. AWS 인프라 자체에 대한 변경 권한은 어떤 경로로도 부여되지 않습니다.
:::

## 어떻게 로그인하나요?

AWSops는 **인앱 로그인 폼**(`/login`)을 사용합니다.

1. 브라우저로 AWSops에 접속하면, 미인증 사용자는 엣지(Lambda@Edge)가 `/login`으로 리다이렉트합니다.
2. `/login` 폼에 이메일·비밀번호를 입력하면 BFF가 `POST /api/auth/login`을 호출합니다.
3. BFF는 공개 Cognito `InitiateAuth (USER_PASSWORD_AUTH)`로 인증하고 `awsops_token` 쿠키(id_token, 12시간 유효)를 발급합니다.
4. 이후 모든 요청은 Lambda@Edge가 **RS256 JWKS 서명 검증**(iss/aud/token_use 포함)으로 검사합니다.

인증은 Cognito User Pool + Lambda@Edge(`us-east-1`)로 처리됩니다. Hosted UI PKCE 플로우는 다크 폴백으로만 보존됩니다.

**관리자 권한**은 서버 측에서 fail-closed로 게이트됩니다 — Cognito `admins` 그룹 멤버이거나 SSM 관리자 이메일 allowlist에 포함된 사용자만 관리자 기능에 접근할 수 있습니다.

## 데이터는 어디에 저장되나요?

AWSops는 EC2 인스턴스 내 JSON 파일이 아니라 **관리형 AWS 서비스**에 상태를 저장합니다.

| 저장소 | 내용 |
|--------|------|
| **Aurora Serverless v2 (PostgreSQL 17)** | `worker_jobs`(비동기 작업), 채팅 스레드, AI 진단 리포트, 데이터소스 스키마 캐시 등 앱 상태 |
| **SSM Parameter Store** | AgentCore 설정의 source of truth (`/ops/awsops-v2/agentcore/...` — runtime ARN, interpreter id, memory id 등) |
| **S3** | AI 진단 리포트 내보내기(DOCX·PDF) |

라이브 AWS 리소스 데이터는 **저장하지 않고** AgentCore MCP 도구가 조회 시점에 가져옵니다. (Steampipe는 flag-gated **인벤토리 sync**(`steampipe_enabled`, 기본 OFF)로만 쓰이며, 라이브 쿼리 엔진이 아닙니다.)

:::tip
앱은 Aurora에 **node-pg**(`web/lib/db.ts`의 공유 풀)로 접근합니다. v1의 `data/*.json` 파일 패턴은 더 이상 사용하지 않습니다.
:::

## 라이브 AWS 데이터는 어떻게 조회하나요?

라이브 AWS / Kubernetes 데이터는 **AgentCore MCP Lambda 도구**를 통해 조회합니다. 약 120개의 읽기 전용 도구가 **8개 섹션 게이트웨이**(network · container · data · security · cost · monitoring · iac · ops)에 걸쳐 배치되어 있습니다.

- 모든 도구는 read-only입니다.
- 게이트웨이 수는 **8개**로 유지됩니다 (ADR-004). 외부 관측성은 별도의 "Integrations 축"이며 9번째 게이트웨이가 아닙니다.
- 더 이상 로컬 Steampipe(127.0.0.1:9193) 서비스나 380개 테이블 직접 접근에 의존하지 않습니다.

## 외부 관측성 데이터(Prometheus / Loki / Tempo / ClickHouse / Datadog)도 조회할 수 있나요?

**예 — 읽기 전용 데이터소스 플랫폼**을 통해 가능합니다. 외부 관측성 백엔드를 커넥터로 연결해 메트릭·로그·트레이스를 조회할 수 있습니다.

지원 대상(예): Prometheus, Loki, Tempo, ClickHouse, Mimir 등.

구성 요소:

- **커넥터 Lambda** — 외부 백엔드에 read-only로 질의
- **Aurora 스키마 캐시** — 커넥터 스키마를 캐시
- **`/datasources` Explore 페이지** — UI에서 직접 탐색
- **NL→query 챗 주입** — 자연어 질문을 AI 어시스턴트가 데이터소스 질의로 변환

:::info
커넥터 입력은 **SSRF 가드 + 크기 제한**을 받습니다(파싱 전 `readJsonBounded`, 메타데이터/IMDS 차단). 데이터소스 플랫폼은 외부 데이터를 **읽기만** 하며, AWS 리소스를 변경하지 않습니다.
:::

## 테마와 모바일을 지원하나요?

**테마 — 3종 런타임 테마 선택기**

- **Cobalt** (기본값)
- **Teal**
- **Dark**

테마는 localStorage에 저장되어 새로고침 시 깜빡임(flash) 없이 적용되며, 차트와 마크(로고)도 테마에 반응해 색상이 바뀝니다. 어디서든 **Cmd-K 명령 팔레트**로 빠르게 탐색할 수 있습니다.

**모바일 — 반응형 레이아웃**

- 상단 바 + 하단 5개 탭 + 햄버거 드로어
- 테이블 → 카드 형태로 전환
- 챗 화면 풀스크린
- 그리드 리플로우 및 상세 시트(detail sheet)

## 여러 AWS 계정을 지원하나요?

AWSops 라이브 환경은 단일 계정(`123456789012`)으로 동작합니다. 라이브 AWS 조회는 AgentCore MCP 도구가 실행 역할(execution role)로 수행하며, 진짜 다른 계정에 대한 조회는 별도의 cross-account assume 경로를 통해서만 이루어집니다. (호스트 계정을 대상으로 선택하면 실행 역할을 직접 사용하므로 불필요한 self-assume가 발생하지 않습니다.) 모든 접근은 읽기 전용입니다.
