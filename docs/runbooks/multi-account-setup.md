# Runbook: 멀티 어카운트 설정 / Multi-Account Setup

Steampipe Aggregator 패턴으로 새 AWS 계정을 추가.
Adding a new AWS account using the Steampipe Aggregator pattern.

## 선행 조건 / Prerequisites
- Host 계정이 이미 배포됨 (Step 0~11 완료)
- 신규 계정에 교차 계정 IAM 역할 생성 가능 (AdministratorAccess 권한)
- 신규 계정 번호, alias, 리전 확인

## 절차 / Procedure

### 1. IAM 역할 (신규 계정)
신규 계정에 다음 trust policy로 역할 생성:
```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "AWS": "arn:aws:iam::<HOST_ACCOUNT>:root" },
    "Action": "sts:AssumeRole",
    "Condition": {
      "StringEquals": { "sts:ExternalId": "awsops-<unique-id>" }
    }
  }]
}
```
권한 정책 / Permissions: `ReadOnlyAccess` (또는 더 엄격한 커스텀)

### 2. Steampipe 커넥션 추가 (Host EC2)
```bash
sudo tee -a ~/.steampipe/config/aws.spc <<EOF
connection "aws_<ACCOUNT_ID>" {
  plugin      = "aws"
  regions     = ["ap-northeast-2"]
  default_region = "ap-northeast-2"
  profile     = "awsops-<ACCOUNT_ID>"
}
EOF
```

`~/.aws/config`:
```
[profile awsops-<ACCOUNT_ID>]
role_arn = arn:aws:iam::<ACCOUNT_ID>:role/<ROLE_NAME>
source_profile = default
external_id = awsops-<unique-id>
region = ap-northeast-2
```

### 3. Aggregator 커넥션 재구성
```bash
# aws.spc 최상단의 aggregator 블록
connection "aws" {
  plugin      = "aws"
  type        = "aggregator"
  connections = ["aws_<HOST_ID>", "aws_<NEW_ACCOUNT_ID>"]
}
```

### 4. Steampipe 재시작
```bash
steampipe service restart
steampipe query "SELECT account_id FROM aws_account" --output csv
# 모든 계정이 리스트되어야 함 / should list all accounts
```

### 5. `data/config.json` 업데이트
```json
{
  "accounts": [
    { "accountId": "<HOST_ID>", "alias": "Host", "connectionName": "aws_<HOST_ID>",
      "region": "ap-northeast-2", "isHost": true,
      "features": { "costEnabled": true, "eksEnabled": true, "k8sEnabled": true } },
    { "accountId": "<NEW_ACCOUNT_ID>", "alias": "Staging", "connectionName": "aws_<NEW_ACCOUNT_ID>",
      "region": "ap-northeast-2", "isHost": false,
      "features": { "costEnabled": false, "eksEnabled": false, "k8sEnabled": false } }
  ]
}
```

### 6. Next.js 재시작
```bash
kill $(pgrep -f "next-server") && sleep 2
nohup npm run start > /tmp/awsops-server.log 2>&1 &
```

## 검증 / Verification
- 대시보드 상단에 어카운트 선택 드롭다운이 나타남
- 각 어카운트 선택 시 리소스가 필터링되는지 확인
- `/accounts` 페이지에서 연결 테스트 (admin 전용)

## 문제 해결 / Troubleshooting

### AssumeRole 실패
```bash
aws sts assume-role --role-arn "arn:aws:iam::<ID>:role/<ROLE>" \
  --role-session-name test --external-id "awsops-<id>"
```
에러 메시지로 trust policy, external ID, 권한 범위 확인.

### Cost 데이터 없음
신규 계정의 `features.costEnabled=false` 이면 의도적. Cost Explorer API 권한은 management account에서만 호출 가능 — organization 관리 계정만 `true` 로 설정.

### 쿼리가 느려짐
Aggregator는 모든 연결을 순차 쿼리하므로 N배 느려짐. 페이지에서 `useAccount()` 로 특정 계정 선택 시 `aws_<ID>` 스코프로 직접 쿼리됨.

## 관련 파일 / Related Files
- `scripts/12-setup-multi-account.sh` — 자동화 스크립트
- `src/lib/steampipe.ts` — `buildSearchPath()`, `runCostQueriesPerAccount()`
- `src/lib/app-config.ts` — `accounts[]` 접근
- `src/contexts/AccountContext.tsx` — `useAccount()` 훅

## 참고 / Reference
- ADR-011 — 멀티 어카운트 / multi-account (구 008): `docs/decisions/011-multi-account.md`
