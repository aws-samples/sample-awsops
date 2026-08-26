---
sidebar_position: 1
---

import Screenshot from '@site/src/components/Screenshot';

# IAM

IAM(Identity and Access Management) 페이지에서는 AWS 계정의 사용자, 역할, 정책을 한눈에 확인합니다. **admin 전용** 페이지로 `data/config.json`의 `adminEmails`에 등록된 사용자만 접근 가능합니다.

<Screenshot src="/screenshots/security/iam.png" alt="IAM" />

:::caution Admin 전용
페이지 진입 시 `/awsops/api/steampipe?action=admin-check`로 권한을 확인합니다. 일반 사용자는 **Access Denied** 화면을 봅니다. IAM 사용자/역할/정책은 민감 정보이므로 의도된 동작입니다.
:::

## 멀티 어카운트 동작
멀티 어카운트 환경에서는 사이드바의 **AccountSelector**로 대상 계정을 전환할 수 있습니다. 데이터 테이블은 `data[0].account_id`를 감지하면 **Account** 컬럼을 자동 추가하고 `AccountBadge`로 별칭+컬러 도트를 표시합니다.

## 주요 기능

### 요약 통계

페이지 상단에서 IAM 리소스 현황을 확인할 수 있습니다:

- **Users**: 총 IAM 사용자 수
- **Roles**: 총 IAM 역할 수
- **Custom Policies**: 고객 관리형 정책 수
- **MFA Not Enabled**: MFA가 활성화되지 않은 사용자 수

:::tip MFA 보안 권고
MFA가 활성화되지 않은 사용자가 있으면 상단에 경고 배너가 표시됩니다. 모든 IAM 사용자에게 MFA를 활성화하는 것을 권장합니다.
:::

### MFA 상태 차트

파이 차트로 MFA 활성화 현황을 시각화합니다:

- **녹색**: MFA 활성화된 사용자
- **빨간색**: MFA 미활성화 사용자

## IAM 사용자 목록

모든 IAM 사용자를 테이블 형태로 표시합니다:

| 컬럼 | 설명 |
|------|------|
| Username | 사용자 이름 |
| User ID | AWS에서 부여한 고유 ID |
| Created | 사용자 생성일 |
| Password Last Used | 마지막 비밀번호 사용일 (콘솔 로그인) |

### 사용자 상세 정보

테이블에서 사용자를 클릭하면 슬라이드 패널에서 상세 정보를 확인할 수 있습니다:

- 사용자 이름, ID, ARN
- 경로(Path)
- 생성일 및 마지막 비밀번호 사용일
- 태그 정보

## IAM 역할 목록

모든 IAM 역할을 테이블 형태로 표시합니다:

| 컬럼 | 설명 |
|------|------|
| Role Name | 역할 이름 |
| Role ID | AWS에서 부여한 고유 ID |
| Path | 역할 경로 |
| Description | 역할 설명 |
| Created | 역할 생성일 |
| Max Session | 최대 세션 지속 시간 |

### 역할 상세 정보

테이블에서 역할을 클릭하면 상세 정보를 확인할 수 있습니다:

**기본 정보**
- 역할 이름, ID, ARN, 경로
- 설명 및 생성일
- 최대 세션 지속 시간
- 권한 경계(Permissions Boundary) ARN

**마지막 사용 정보**
- 마지막 사용 일시
- 마지막 사용 리전

**인스턴스 프로파일**
- 연결된 인스턴스 프로파일 ARN 목록

**트러스트 정책**
- `AssumeRolePolicyDocument`를 JSON 형태로 표시
- 어떤 엔티티(서비스, 계정, 사용자)가 이 역할을 수임할 수 있는지 확인

:::info 트러스트 정책 분석
트러스트 정책은 역할을 수임(Assume)할 수 있는 주체를 정의합니다. `Principal` 필드에서 허용된 서비스, 계정 ID, 사용자 ARN을 확인하세요.
:::

## 데이터 새로고침

우측 상단의 새로고침 버튼을 클릭하면 `bustCache=true`로 5분 캐시를 무효화하고 최신 데이터를 조회합니다.

## 쿼리 구조

페이지가 호출하는 SQL 쿼리(`src/lib/queries/iam.ts`):

| 쿼리 키 | 용도 |
|---------|------|
| `summary` | Users / Roles / Custom Policies / MFA Not Enabled 카운트 |
| `userList` | 사용자 목록 + account_id 컬럼 |
| `roleList` | 역할 목록 + account_id 컬럼 |
| `userDetail` | 클릭 시 동적 SQL (이름 치환) |
| `roleDetail` | 클릭 시 동적 SQL — 트러스트 정책 + 인스턴스 프로파일 포함 |

:::info SCP 차단 컬럼 회피
`mfa_enabled`, `attached_policy_arns`는 목록 쿼리에서 제외됩니다 (조직 SCP가 `ListMFADevices`, `ListAttachedUserPolicies`를 차단하는 환경 대응). MFA 통계는 별도 `summary` 쿼리에서 집계합니다.
:::

## 관련 페이지
- [Security](./security.md) — Public S3, Open SG, 미암호화 EBS 등 종합 보안 진단
- [Compliance](./compliance) — CIS 벤치마크 (IAM 통제 다수 포함)
- [Accounts](../overview/accounts) — 어카운트 추가 + Department(Cognito 그룹) 관리

## 참고
- `src/lib/queries/iam.ts` — SQL 쿼리 정의
- ADR-024: admin 전용 페이지 게이트 (`adminEmails` 매트릭스)
