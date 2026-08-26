---
sidebar_position: 2
title: 문제 해결 FAQ
description: AWSops 대시보드 사용 중 발생하는 문제와 해결 방법 (접속, 인증, 데이터, AI 진단)
---

# 문제 해결 FAQ

AWSops 대시보드 사용 중 발생할 수 있는 문제와 해결 방법입니다. AWSops는 ECS Fargate에서 동작하는 Next.js thin-BFF이며, 모든 라이브 AWS 조회는 AgentCore MCP 도구를 통해 이루어지고, 상태는 Aurora(PostgreSQL)에 저장됩니다. 대부분의 문제는 접속 경로(엣지), 인증(Cognito), 데이터 연결(Aurora · 권한) 중 하나로 분류됩니다.

## 사이트가 504 또는 접속 불가예요

CloudFront가 응답하지 못하거나 504 Gateway Timeout이 발생하는 경우, 엣지 경로(CloudFront → VPC Origin → 내부 ALB → Fargate) 어딘가에서 연결이 끊긴 것입니다. AWSops는 공개 ALB가 없으므로, 점검 순서는 다음과 같습니다.

1. **Fargate 태스크 상태** — ECS 서비스의 태스크가 RUNNING이고 타깃 그룹에서 healthy인지 확인합니다. 태스크가 UNHEALTHY로 순환 중이면 아래의 "ECS 태스크가 UNHEALTHY" 항목을 보세요.
2. **TLS end-to-end** — CloudFront → ALB 구간은 TLS가 끊김 없이 이어져야 합니다. VPC Origin이 `https-only`(443)여야 하고, Origin 도메인이 **공개 FQDN**(예: `awsops.example.com`)으로 설정되어 SNI가 ALB 인증서와 일치해야 합니다.
3. **ALB 인증서 / 리스너** — 내부 ALB는 HTTPS:443 + **리전 ACM 인증서**로 리스닝해야 합니다(CloudFront 인증서는 us-east-1이지만 ALB는 리전 ACM).
4. **ALB 보안 그룹** — 가장 흔한 504 원인입니다. ALB SG는 **CloudFront 관리형 보안 그룹** `CloudFront-VPCOrigins-Service-SG`에서 443을 허용해야 합니다. VPC CIDR만 허용하면 트래픽이 차단되어 504가 발생합니다.

:::tip
504는 거의 항상 **ALB SG가 CloudFront 관리형 SG를 허용하지 않아서** 발생합니다. VPC-CIDR-only 규칙은 동작하지 않습니다. CloudFront 관리형 SG(`CloudFront-VPCOrigins-Service-SG`)에서 443 인바운드가 허용되어 있는지 가장 먼저 확인하세요.
:::

:::info
VPC Origin의 프로토콜은 in-place로 변경할 수 없습니다. `https-only` 설정을 바꾸려면 Terraform에서 `create_before_destroy` + 리소스 교체(`-replace`)가 필요합니다.
:::

## 로그인이 안 돼요

AWSops는 자체 호스팅 로그인 폼(`/login`)을 사용합니다. 미인증 상태로 보호된 페이지에 접근하면 엣지(Lambda@Edge)가 자동으로 `/login`으로 리다이렉트합니다.

1. **로그인 폼 사용** — `/login`에서 사용자명과 비밀번호를 입력하면 BFF(`POST /api/auth/login`)가 Cognito `InitiateAuth(USER_PASSWORD_AUTH)`를 호출하고, 성공 시 `awsops_token` 쿠키(id_token, 12시간 유효)를 발급합니다.
2. **자격 증명 오류** — 사용자명/비밀번호가 틀렸거나 사용자가 Cognito User Pool에 없으면 로그인이 거부됩니다. 비밀번호 재설정이나 사용자 생성은 관리자에게 요청하세요.
3. **쿠키 확인** — 로그인은 됐는데 계속 `/login`으로 돌아온다면, `awsops_token` 쿠키가 제대로 설정됐는지 확인합니다. 쿠키는 HttpOnly라 JavaScript로 읽을 수 없으니, 브라우저 개발자 도구 → Application → Cookies에서 확인하세요. 만료(12시간)됐다면 재로그인하면 됩니다.
4. **로그아웃 후 재로그인** — 세션이 꼬였다면 로그아웃(쿠키 삭제 → `/login`)한 뒤 다시 로그인하세요. 별도의 Hosted UI `/logout` 왕복은 없습니다.

:::info
엣지는 단순 만료 체크가 아니라 **RS256 JWKS 서명 검증**(iss/aud/token_use 포함)을 수행합니다. 토큰이 위조되었거나 다른 User Pool에서 발급되었으면 거부됩니다. Cognito Hosted UI PKCE 플로우(`/_callback`)는 다크 폴백으로만 남아 있으며, 일반 로그인은 `/login` 폼을 사용합니다.
:::

## 관리자 화면(설정·커스터마이징)에 접근하면 403이 떠요

관리자 기능은 로그인 여부와 별개로 **서버 측 관리자 게이트**로 한 번 더 보호됩니다. 다음 중 하나를 만족해야 통과합니다.

- 로그인 사용자가 Cognito의 **admins 그룹**에 속함, 또는
- 사용자 이메일이 SSM의 **관리자 이메일 허용 목록**에 포함됨.

둘 다 비어 있으면 모든 사용자가 fail-closed로 403을 받습니다(안전 기본값). 관리자 그룹에 사용자를 추가하거나 SSM 허용 목록에 이메일을 등록하면 해결됩니다.

## 데이터가 표시되지 않아요

데이터가 비어 보이는 원인은 크게 세 가지입니다: (a) 앱 상태를 담는 Aurora에 연결되지 않음, (b) 라이브 AWS 조회 권한 부족, (c) 인벤토리 동기화 미실행.

1. **세션/인증 확인** — 먼저 로그인 세션이 유효한지 확인하세요. 토큰이 만료되면 API 호출이 거부되어 화면이 비어 보일 수 있습니다(위의 "로그인이 안 돼요" 참고).
2. **Aurora 연결 확인** — 채팅 스레드, 진단 리포트, 작업 큐 등 앱 상태는 모두 Aurora에 저장됩니다. `/api/db` 헬스 체크로 DB ping이 정상인지 확인하세요. 실패하면 DB 자체 또는 네트워크/시크릿 문제입니다.
3. **라이브 AWS 조회 권한** — EC2/IAM 같은 실시간 AWS 데이터는 AgentCore MCP 도구(읽기 전용)를 통해 조회합니다. 특정 섹션만 비어 있다면 해당 서비스의 `Describe*`/`List*` 권한이 막혔을 수 있습니다(SCP/IAM). Cost 데이터는 **Cost Explorer 권한**, 메트릭은 **CloudWatch 권한**이 필요합니다.
4. **인벤토리 동기화** — 인벤토리 페이지의 표가 비어 있다면, 인벤토리 동기화(`steampipe_enabled` 플래그, 기본 OFF)가 실행되지 않은 것일 수 있습니다. 인벤토리 동기화는 별도의 배치 동기화 기능이며, 라이브 조회(MCP)와는 독립적입니다.

:::tip
"특정 페이지만" 비어 있으면 → 그 서비스의 **AWS API 권한**(SCP/IAM) 문제일 가능성이 높습니다. "모든 페이지가" 비어 있으면 → **세션 만료** 또는 **Aurora 연결** 문제일 가능성이 높습니다.
:::

## SCP 차단으로 일부 데이터가 누락돼요

SCP(Service Control Policy)나 IAM 경계로 특정 AWS API가 차단되면, 해당 데이터만 부분적으로 누락될 수 있습니다.

| 차단된 API 예시 | 영향 |
|-----------------|------|
| `iam:ListMFADevices` | MFA 상태 조회 불가 |
| `ce:GetCostAndUsage` | Cost 데이터 조회 불가 |
| `cloudwatch:GetMetricData` | 메트릭/그래프 조회 불가 |

AWSops는 읽기 전용이므로 차단된 API에 대해서는 해당 항목을 빈 값으로 표시하고 나머지는 정상 동작합니다. 누락된 데이터가 필요하면 해당 API에 대한 읽기 권한을 추가하세요. 권한 변경 없이 자연어로 부분 조회가 가능한 경우, AI 어시스턴트에 질의하면 사용 가능한 범위의 데이터로 답합니다.

## 페이지 로딩이 느려요

AWSops 웹은 ECS Fargate에서 **미리 빌드된 standalone 이미지**로 실행됩니다. 호스트에서 `npm run dev`로 돌던 레거시와 달리, 별도의 빌드 단계가 런타임에 끼어들지 않습니다. 그래도 특정 페이지가 느리다면 다음을 확인하세요.

1. **무거운 작업은 비동기 워커로** — 장시간/대용량/OOM 위험 작업(예: AI 종합 진단, 리포트 내보내기)은 웹이 직접 처리하지 않고 비동기 워커 큐로 enqueue됩니다. 화면에는 작업 상태가 표시되며, 완료 후 결과가 채워집니다. 즉시 응답하지 않는 것이 정상입니다.
2. **라이브 AWS 조회 지연** — Cost Explorer나 CloudWatch 같은 AWS API는 응답이 느릴 수 있습니다(수십 초 단위). 이 경우 화면은 정상이지만 데이터 채워지는 데 시간이 걸립니다.
3. **새 태스크 롤링** — 배포 직후(`make deploy`로 ECS 롤링 중)에는 일시적으로 응답이 느릴 수 있습니다. 롤링이 끝나고 `/api/health`가 안정화되면 정상화됩니다.

## ECS 태스크가 UNHEALTHY로 순환해요 (운영자용)

배포 후 Fargate 태스크가 계속 UNHEALTHY가 되며 circuit breaker로 롤백되는 경우, 거의 항상 다음 세 가지 중 하나입니다.

1. **`HOSTNAME=0.0.0.0` 런타임 env 누락** — Next.js standalone을 컨테이너로 배포할 때는 태스크 정의의 `environment`에 `HOSTNAME=0.0.0.0`을 명시해야 합니다. 이미지 ENV만으로는 부족합니다 — ECS가 HOSTNAME을 ENI IP로 덮어쓰면 앱이 0.0.0.0/loopback에 바인딩되지 않아 헬스 체크가 실패합니다.
2. **헬스 체크 경로 불일치** — 컨테이너와 타깃 그룹의 헬스 체크 경로가 앱의 `/api/health`와 정확히 일치해야 합니다. 불일치하면 circuit breaker 루프가 발생합니다.
3. **Fargate 워커 Dockerfile은 `CMD`(ENTRYPOINT 금지)** — Fargate 워커 이미지는 `CMD`를 사용해야 합니다. exec-form `ENTRYPOINT`를 쓰면 Step Functions의 `containerOverrides.command`가 ENTRYPOINT에 append되어 argv가 중복되고 argparse가 실패합니다.

:::tip
가장 흔한 원인은 `HOSTNAME=0.0.0.0`을 **이미지가 아닌 태스크 정의 런타임 env**로 명시하지 않은 것입니다. 헬스 체크가 즉시 실패한다면 이 항목부터 확인하세요.
:::

## ECS 태스크가 시작 시 ResourceInitializationError가 떠요 (운영자용)

태스크가 시작조차 못 하고 `ResourceInitializationError`로 실패한다면, Aurora 시크릿을 주입하는 `secrets` valueFrom의 권한 문제입니다.

ECS `secrets` valueFrom(Aurora 시크릿 등)은 **실행 역할(execution role)** 권한이 필요합니다 — task role이 아닙니다. 실행 역할에 해당 시크릿에 대한 `secretsmanager:GetSecretValue` 권한이 있는지 확인하세요.

## AI 종합 진단이 실패하거나 멈춰요

AI 진단은 웹이 직접 실행하지 않고 **비동기 워커 티어**가 백그라운드에서 생성하는 읽기 전용 리포트입니다(base 8섹션 / deep 15섹션). 따라서 "응답이 없다"가 곧 "실패"는 아닙니다.

1. **작업 상태 먼저 확인** — 진단을 요청하면 작업이 큐에 등록되고 워커가 처리합니다. 리포트 화면의 작업 상태(queued → running → succeeded/failed)를 확인하세요. running이면 정상 진행 중입니다.
2. **failed로 끝난 경우** — 워커가 실패하면 상태가 failed로 기록됩니다. 같은 진단을 다시 요청하면 재시도됩니다(작업은 job_id 기준 멱등).
3. **deep + Opus 모델** — deep 진단(15섹션)에서 Opus 모델을 선택하면 비용 게이트가 적용되고 시간이 더 걸립니다. 빠르게 보려면 기본 Sonnet으로 base 진단을 사용하세요.
4. **데이터 권한** — 진단은 라이브 AWS 데이터를 읽으므로, 차단된 API(Cost/CloudWatch 등) 섹션은 데이터가 비어 보일 수 있습니다(위의 "SCP 차단" 참고). 이는 진단 자체의 실패가 아니라 데이터 가용성 문제입니다.

:::info
오래 멈춰 있는(stale) 작업은 reaper(5분 주기)가 자동으로 정합화합니다. 워커가 죽어 상태가 갱신되지 않은 작업도 결국 failed로 정리됩니다 — 한참 기다려도 succeeded가 안 되면 재시도하세요.
:::

## AI 어시스턴트 응답이 이상하거나 권한 오류가 나요

AI 어시스턴트는 읽기 전용 도구(약 120개)로 라이브 AWS 데이터를 조회하고, 대화는 Aurora에 저장됩니다.

1. **읽기 전용 동작** — AWSops는 AWS 리소스를 변경하지 않습니다. "리소스를 수정/삭제해 달라"는 요청은 거부되거나 진단/안내로만 응답하는 것이 정상입니다(영구 read-only 정책).
2. **권한 오류** — 특정 조회가 AccessDenied로 실패하면, 해당 서비스의 읽기 권한이 막힌 것입니다. 차단된 범위는 답변에서 제외되며, 가능한 데이터로만 응답합니다.
3. **대화가 사라짐** — 대화는 Aurora에 영속되어 사이드바에서 다시 열 수 있습니다. 보이지 않으면 세션(로그인)이 바뀌었거나 만료된 것일 수 있습니다.

## 데이터소스(Prometheus/Loki 등) 연결이 안 돼요

`/datasources`의 읽기 전용 커넥터(Prometheus · Loki · Tempo · ClickHouse · Mimir 등)는 커넥터 Lambda를 통해 외부 관측성 백엔드를 조회합니다.

1. **엔드포인트 도달성** — 커넥터가 해당 엔드포인트에 네트워크로 도달할 수 있어야 합니다. private 엔드포인트는 VPC 경로가 필요합니다.
2. **SSRF 가드** — 커넥터 입력은 SSRF 방어가 적용됩니다. 메타데이터/IMDS 주소 등 내부 주소로의 연결은 차단됩니다. 사내 내부 주소를 가리키면 막힐 수 있습니다.
3. **자격 증명** — 인증이 필요한 백엔드는 Secrets Manager에 저장된 자격 증명을 사용합니다. 401/403이 나면 시크릿이 올바른지 확인하세요.
4. **응답 크기** — 커넥터 입력은 크기 제한이 있습니다(파싱 전 bound 적용). 과도하게 큰 페이로드는 거부됩니다.

## 알림이 외부(Slack/티켓)로 전달되지 않아요

외부 기록/티켓/메시지 쓰기는 거버넌스 하에 동작하는 선택 기능이며, 기본적으로 플래그 OFF일 수 있습니다.

1. **기능 활성화 여부** — 외부 쓰기는 거버넌스(목적지 허용 목록 · 시크릿 · DLP/마스킹 · 휴먼 게이트 · 플래그)를 전제로 합니다. 비활성 상태라면 메시지가 발송되지 않습니다.
2. **목적지 허용 목록** — 대상(채널/엔드포인트)이 허용 목록에 없으면 전송이 차단됩니다.
3. **자격 증명** — 외부 서비스 토큰/웹훅은 Secrets Manager에 저장됩니다. 만료/오타가 있으면 전송이 실패합니다.

:::info
외부 쓰기는 **데이터 레코드(메시지·티켓)** 작성이며, AWS 리소스 변경이 아닙니다. AWS 리소스 변경과 자율 실행은 영구 동결되어 있습니다.
:::
