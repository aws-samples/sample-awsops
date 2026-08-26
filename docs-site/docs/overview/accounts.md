---
sidebar_position: 4
title: 계정 관리
description: 멀티 계정 AWS 모니터링을 위한 계정 추가, 제거, 테스트 관리 페이지
---

import Screenshot from '@site/src/components/Screenshot';
import MultiAccountSetupFlow from '@site/src/components/diagrams/MultiAccountSetupFlow';

# 계정 관리

계정 관리 페이지는 AWSops의 멀티 계정 모니터링을 위한 관리자 전용 페이지입니다. Host 계정 자동 감지, Target 계정 추가/삭제, 연결 테스트, 기능 감지를 한 곳에서 수행할 수 있습니다.

<Screenshot src="/screenshots/overview/accounts.png" alt="계정 관리" />

:::tip 고객 세션 포인트
Steampipe Aggregator로 **전 계정을 단일 창**에서 조회 — 계정 추가/삭제는 `data/config.json`의 `accounts[]`만 수정하면 되고 **코드 변경이 없습니다**. → [왜 AWSops인가](./why-awsops)
:::

## 설정 흐름

아래 다이어그램은 Host 계정과 Target 계정의 등록 과정, 그리고 Admin 접근 제어 흐름을 보여줍니다. 각 노드에 마우스를 올리면 상세 설명이 표시됩니다.

<MultiAccountSetupFlow />

## 주요 기능

### Host 계정 설정

계정이 하나도 등록되지 않은 상태에서 페이지에 접근하면 Host 계정 등록 배너가 표시됩니다.

| 항목 | 설명 |
|------|------|
| **자동 감지** | EC2 인스턴스 크레덴셜로 STS GetCallerIdentity 호출 |
| **기능 감지** | Cost Explorer, EKS, K8s API를 프로빙하여 사용 가능한 기능 자동 설정 |
| **Alias 입력** | Host 계정의 표시 이름 지정 (기본값: "Host") |
| **config.json 등록** | `data/config.json`의 `accounts[]` 배열에 `isHost: true`로 등록 |

### 등록된 계정 관리

등록된 모든 계정이 테이블 형태로 표시됩니다.

| 컬럼 | 설명 |
|------|------|
| **Alias** | 계정 표시 이름 |
| **Account ID** | 12자리 AWS 계정 ID |
| **Region** | 기본 리전 |
| **Type** | Host 또는 Target |
| **Features** | Cost, EKS, K8s 활성화 상태 (배지 형태) |
| **Actions** | 연결 테스트, 삭제 (Host 계정은 삭제 불가) |

### 새 계정 추가

Target 계정을 추가하려면 아래 정보를 입력합니다.

| 필드 | 형식 | 설명 |
|------|------|------|
| **Account ID** | 12자리 숫자 | AWS 계정 ID |
| **Alias** | 영문/숫자/공백/하이픈/언더스코어 | 대시보드에 표시될 이름 |
| **Region** | 선택 | 10개 주요 리전 중 선택 |
| **Role Name** | 문자열 | 교차 계정 IAM 역할 이름 (기본: `AWSopsReadOnlyRole`) |

추가 전에 반드시 **Test Connection**으로 AssumeRole 연결을 확인하세요.

### Target 계정 CloudFormation 배포

새 계정을 추가하기 전에, 해당 계정에서 교차 계정 IAM 역할을 먼저 생성해야 합니다.

```bash
aws cloudformation deploy \
  --template-file infra-cdk/cfn-target-account-role.yaml \
  --stack-name awsops-target-role \
  --parameter-overrides HostAccountId=<HOST_ACCOUNT_ID> \
  --capabilities CAPABILITY_NAMED_IAM
```

이 명령은 다음을 생성합니다:
- **AWSopsReadOnlyRole**: Host 계정에서 AssumeRole 가능한 읽기 전용 역할
- **Trust Policy**: Host 계정 ID를 Principal로 지정
- **권한**: ReadOnlyAccess + 필요한 추가 정책

## Admin 접근 제어

계정 관리 페이지는 관리자만 접근할 수 있습니다.

| 항목 | 설명 |
|------|------|
| **설정 위치** | `data/config.json`의 `adminEmails` 배열 |
| **빈 배열** | `[]`인 경우 모든 인증된 사용자에게 접근 허용 |
| **검증 흐름** | JWT에서 이메일 추출 → `adminEmails` 배열 매칭 → 허용/거부 |
| **속도 제한** | 사용자당 분당 5회 요청 제한 |
| **API 보호** | add-account, remove-account, init-host 모두 동일한 admin 검사 적용 |

```json
{
  "adminEmails": ["admin@example.com", "ops@example.com"]
}
```

:::warning Admin 미설정 시
`adminEmails`가 빈 배열이면 인증된 사용자 누구나 계정을 추가/삭제할 수 있습니다. 프로덕션 환경에서는 반드시 관리자 이메일을 지정하세요.
:::

## 사용 방법

1. **Host 계정 등록**: 최초 접근 시 표시되는 배너에서 Alias를 입력하고 "Detect & Register Host" 클릭
2. **Target 계정 준비**: Target 계정에서 CloudFormation 스택 배포
3. **연결 테스트**: Account ID를 입력하고 "Test Connection"으로 AssumeRole 검증
4. **계정 추가**: Alias, Region을 입력하고 "Add Account" 클릭
5. **확인**: 등록된 계정 테이블에서 Features 배지 확인
6. **Steampipe 설정**: 새 계정의 Steampipe connection 구성 (Aggregator에 자동 추가)

## Departments (Cognito 그룹 기반 접근 제어)

`/accounts` 페이지 하단의 **Departments** 섹션에서 Cognito 그룹별로 페이지·계정·EKS 클러스터·외부 데이터소스 접근 권한을 세분화할 수 있습니다.

| 필드 | 설명 |
|------|------|
| `name` | 부서명 (예: "FinOps", "SecOps") |
| `cognitoGroup` | Cognito User Pool 그룹명 (정확 일치) |
| `accounts` | 접근 가능 계정 ID 배열 — `["*"]`이면 전체 |
| `pages` | 접근 가능 페이지 경로 배열 (`/ec2`, `/cost` 등) — `["*"]`이면 전체 |
| `eksClusterNames` | 접근 가능 EKS 클러스터 이름 — `["*"]`이면 전체 |
| `datasourceIds` | 접근 가능 외부 데이터소스 ID — `["*"]`이면 전체 |

### 동작 방식
- Cognito JWT의 `cognito:groups` 클레임을 읽어 매칭되는 Department의 제한을 적용합니다.
- 매칭되는 Department가 없으면 admin 여부에 따라 동작 (admin은 전체 접근, 비 admin은 차단).
- 빈 배열은 "전체 비활성" → **`["*"]`을 명시**해야 전체 허용입니다.

### API
```bash
# 부서 목록 조회
curl '/awsops/api/steampipe?action=config' | jq '.departments'

# 부서 저장 (admin 전용)
curl -X POST '/awsops/api/steampipe?action=save-departments' \
  -H 'Content-Type: application/json' \
  -d '{"departments":[{"name":"FinOps","cognitoGroup":"finops","accounts":["*"],"pages":["/cost","/inventory","/bedrock"],"eksClusterNames":["*"],"datasourceIds":["*"]}]}'
```

:::caution Departments를 비우면 비활성화
`departments` 배열이 비어 있으면 부서 기반 접근 제어가 **완전히 비활성**됩니다 — 모든 로그인 사용자가 admin/일반 정책만으로 접근 권한이 결정됩니다.
:::

## 사용 팁

:::tip 기능 배지
계정이 등록되면 Cost, EKS, K8s 기능이 자동 감지됩니다. 배지가 표시되지 않는 기능은 해당 계정에서 해당 서비스가 활성화되지 않았거나 권한이 부족한 경우입니다.
:::

:::info Steampipe Aggregator 패턴
`aws` connection은 모든 등록 계정의 데이터를 통합 조회합니다. 개별 계정 조회는 `aws_{accountId}` connection을 사용하며, AccountSelector 드롭다운에서 선택할 수 있습니다.
:::

:::tip 계정 삭제 시
Target 계정을 삭제해도 해당 계정의 CloudFormation 스택은 자동으로 삭제되지 않습니다. 필요한 경우 Target 계정에서 별도로 스택을 삭제하세요.
:::

## AI 분석 팁

AI 어시스턴트에 다음과 같이 질문하면 등록된 계정 관련 정보를 빠르게 확인할 수 있습니다:

- "등록된 계정 목록 보여줘"
- "Cost Explorer 활성화된 계정은?"
- "EKS 클러스터가 있는 계정은?"
- "Staging 계정의 리소스 현황 알려줘"
- "모든 계정의 EC2 인스턴스 수를 비교해줘"

## 관련 페이지

- [대시보드](../overview/dashboard) - 멀티 계정 통합 대시보드
- [AI 어시스턴트](../overview/ai-assistant) - AI 기반 계정 분석
- [AgentCore](../overview/agentcore) - 교차 계정 도구 실행
