# AI 라우트 테스트 가이드 / AI Route Test Guide

AWSops 대시보드 AI 채팅의 9개 라우트와 100개 질문을 검증하는 테스트 스크립트 사용법입니다.
(Guide for the AI route test script — validates 9 routes with 100 questions.)

## 빠른 시작 / Quick Start

```bash
# 배포 인스턴스에서 실행 / Run on deployment instance
cd ~/awsops
python3 scripts/test-ai-routes.py
```

## 실행 모드 / Run Modes

### 1. 대화형 메뉴 (기본) / Interactive Menu (Default)

```bash
python3 scripts/test-ai-routes.py
```

카테고리를 선택하고, 단일 카테고리 선택 시 개별 질문까지 선택할 수 있습니다.
(Select categories, then individual questions within a single category.)

```
  카테고리 선택 / Select category:

   #   Category       Questions  Description
   ---------------------------------------------------------
   0   ALL                  100  전체 실행 / Run all
   Q   QUICK                  9  카테고리별 1개 / 1 per category

   1   security            12  IAM 보안 점검, 사용자/역할/정책 분석
   2   infra               19  VPC, EKS, ECS, TGW, 네트워크 진단
   3   cost                11  비용 분석, 비교, 예측, FinOps
   4   monitoring          13  CloudWatch 알람/메트릭, CloudTrail 감사
   5   data                13  DynamoDB, RDS, ElastiCache, MSK
   6   aws-data            13  Steampipe SQL로 리소스 조회
   7   iac                  9  CDK, Terraform, CloudFormation
   8   code                 8  Python 코드 실행 (Code Interpreter)
   9   general              6  AWS 문서, 리전 가용성, 추천

  선택: 1          ← security 카테고리 → 개별 질문 선택 가능
  선택: 1,3        ← security + cost 전체 실행
  선택: Q          ← 카테고리별 1개씩 빠른 테스트 (9개)
  선택: 0          ← 전체 100개 실행
```

### 2. 전체 실행 / Run All

```bash
python3 scripts/test-ai-routes.py --all
```

100개 질문을 순차적으로 실행합니다. 예상 소요 시간: 약 20-40분.
(Runs all 100 questions sequentially. Estimated time: 20-40 minutes.)

### 3. 빠른 테스트 / Quick Test

```bash
python3 scripts/test-ai-routes.py --quick
```

각 카테고리에서 1개씩, 총 9개 질문만 실행합니다. 예상 소요 시간: 약 2-5분.
(Runs 1 question per category, 9 total. Estimated time: 2-5 minutes.)

### 4. 카테고리 지정 / Select Category

```bash
# 단일 카테고리 / Single category
python3 scripts/test-ai-routes.py --cat security

# 복수 카테고리 / Multiple categories
python3 scripts/test-ai-routes.py --cat cost,infra,monitoring
```

### 5. 옵션 / Options

```bash
# URL 변경 (기본: http://localhost:3000/awsops/api/ai)
python3 scripts/test-ai-routes.py --url http://localhost:3000/awsops/api/ai

# 타임아웃 변경 (기본: 90초)
python3 scripts/test-ai-routes.py --timeout 120

# 조합 사용 / Combine options
python3 scripts/test-ai-routes.py --cat security --timeout 120
```

## 출력 해석 / Reading Output

### 테스트 진행 중 / During Test

```
  [01/09] 보안 요약          보안 이슈가 있는지 확인해줘        12.3s  📗 route=security   ✓  2847ch AgentCore → Security Ga
  [02/09] VPC 현황            VPC 현황과 서브넷 구성을 알려줘      8.5s  📗 route=infra      ✓  1523ch AgentCore → Infra Gatew
  [03/09] 비용 분석           이번 달 비용을 서비스별로 분석해줘   15.2s  📙 route=cost       ✓   892ch AgentCore → Cost Gatewa
         ⚠ fail pattern: '도구가 실행 역할'
  [04/09] 파이썬 코드         피보나치 수열 처음 20개를 파이썬으    90.0s  ❌ timed out
```

### 아이콘 의미 / Icon Legend

| 아이콘 | 의미 / Meaning |
|-------|---------------|
| 📗 | API 성공 + 내용 검증 통과 (OK) |
| 📙 | API 성공이지만 내용에 문제 (WARN — 실패 패턴, 짧은 응답, 태그 노출) |
| ❌ | API 호출 실패 (FAIL — 타임아웃, 연결 오류 등) |
| ✓ | 라우트 분류 정확 (의도한 라우트로 분류됨) |
| ✗ | 라우트 분류 오류 (다른 라우트로 분류됨) |

### 요약 / Summary

```
  SUMMARY / 요약
  ==========================================================================================
  API Status:   8 passed / 1 failed / 9 total
  Content:      📗 7 valid / 📙 1 issues / ❌ 1 errors
  Route match:  8/9 (89%)
  Avg time:     11.2s
  Min / Max:    5.3s / 25.1s
  Total time:   101.2s

  Route           Count      Avg  Match    📗    📙    ❌
  -------------------------------------------------------
  aws-data            1     8.2s      1     1     0     0
  cost                1    15.2s      1     0     1     0
  infra               1     8.5s      1     1     0     0
  security            1    12.3s      1     1     0     0
  ...
```

## 내용 검증 규칙 / Content Validation Rules

스크립트는 HTTP 200 응답 외에 **내용 품질**도 검증합니다.
(The script validates response **content quality** beyond HTTP 200.)

### 실패 패턴 감지 / Fail Pattern Detection

다음 문구가 응답에 포함되면 📙 (WARN)으로 표시됩니다:
(Responses containing these patterns are marked as 📙 WARN:)

| 패턴 / Pattern | 의미 / Meaning |
|---------------|---------------|
| `직접 실행할 수 없` | AI가 도구 호출 실패하여 일반 응답으로 폴백 |
| `도구가 실행 역할` | AgentCore 자격 증명 오류 |
| `연결 불가` / `연결 오류` | MCP Gateway 연결 실패 |
| `credentials` | IAM 권한 문제 |
| `tool_call>` / `tool_response>` | 원시 태그가 사용자에게 노출됨 |

### 기타 검증 / Other Checks

- **최소 응답 길이**: 100자 미만이면 경고
- **코드 라우트**: ```` ``` ```` 코드 블록 또는 "output"이 없으면 경고

## 결과 파일 / Result Files

모든 테스트 실행 후 상세 결과가 JSON으로 저장됩니다.
(Detailed results are saved as JSON after every test run.)

```
/tmp/ai-test-results-20260310-173045.json
```

JSON 구조:
```json
{
  "timestamp": "2026-03-10T17:30:45",
  "url": "http://localhost:3000/awsops/api/ai",
  "summary": {
    "passed": 8, "failed": 1, "total": 9,
    "content_valid": 7, "content_issues": 1,
    "route_match": 8,
    "avg_time_sec": 11.2
  },
  "results": [
    {
      "label": "보안 요약",
      "question": "보안 이슈가 있는지 확인해줘",
      "expected_route": "security",
      "route": "security",
      "status": "OK",
      "time": 12.3,
      "content_valid": true,
      "content_issues": [],
      "content_length": 2847,
      "content_preview": "## AWS 계정 보안 요약 ..."
    }
  ]
}
```

## 카테고리별 질문 수 / Questions per Category

| # | Category | Questions | 라우트 | 주요 도구 |
|---|----------|-----------|--------|----------|
| 1 | security | 12 | Security Gateway | IAM 사용자/역할/정책, 시뮬레이션 |
| 2 | infra | 19 | Infra Gateway | VPC, TGW, EKS, ECS, Istio |
| 3 | cost | 11 | Cost Gateway | Cost Explorer, 예측, 예산 |
| 4 | monitoring | 13 | Monitoring Gateway | CloudWatch, CloudTrail |
| 5 | data | 13 | Data Gateway | DynamoDB, RDS, ElastiCache, MSK |
| 6 | aws-data | 13 | Bedrock + Steampipe | SQL 생성 → pg Pool 직접 쿼리 |
| 7 | iac | 9 | IaC Gateway | CDK, Terraform, CloudFormation |
| 8 | code | 8 | Code Interpreter | Python 코드 실행 |
| 9 | general | 6 | Ops Gateway | AWS 문서, 리전, 추천 |
| | **합계** | **104** | | |

## 트러블슈팅 / Troubleshooting

### 연결 거부 (Connection refused)
```
❌ <urlopen error [Errno 111] Connection refused>
```
→ Next.js 서버가 실행 중인지 확인: `curl http://localhost:3000/awsops`

### 모든 질문에서 📙 (WARN)
```
⚠ fail pattern: '도구가 실행 역할'
```
→ Docker 이미지 재빌드 + Runtime 업데이트 필요 (6e → Docker rebuild → update-agent-runtime)

### 타임아웃 (> 90초)
```
❌ <urlopen error timed out>
```
→ `--timeout 120` 옵션 사용 또는 AgentCore Runtime cold start 대기

### 라우트 분류 오류 (✗)
```
route=general    ✗
```
→ 의도 분류기가 해당 질문을 다른 라우트로 분류함. 정상 동작이지만 정확도 개선이 필요할 수 있음.
