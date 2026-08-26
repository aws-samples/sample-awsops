# Runbook: 알림 파이프라인 문제 해결 / Alert Pipeline Troubleshooting

ADR-009 알림 트리거 AI 진단 파이프라인의 운영 이슈 대응.
Operational triage for the ADR-009 alert-triggered AI diagnosis pipeline.

## 정상 플로우 / Happy Path
```
CloudWatch Alarm → SNS Topic → SQS Queue → alert-sqs-poller.ts (EC2)
                                         ↓
                                 alert-correlation.ts (30s buffer)
                                         ↓
                                 alert-diagnosis.ts (Bedrock Sonnet)
                                         ↓
                                 Slack / SNS email / knowledge base
```

## 증상별 대응 / Symptoms & Diagnosis

### 1. 알림이 도착하지 않음 / Alerts never arrive

**확인 / Check**:
```bash
# SQS 큐에 메시지가 쌓이는지 / Are messages landing in SQS?
aws sqs get-queue-attributes --queue-url "$ALERT_QUEUE_URL" \
  --attribute-names ApproximateNumberOfMessages

# Poller 프로세스 확인 / Poller process alive?
pgrep -af alert-sqs-poller

# Next.js 로그 / App logs
tail -100 /tmp/awsops-server.log | grep -i alert
```

**원인 / Causes**:
- `data/config.json` 의 `alertDiagnosis.enabled` 가 false
- SNS → SQS 구독이 끊어짐 (`aws sns list-subscriptions-by-topic`)
- DLQ에 메시지가 리다이렉트됨 (`aws sqs get-queue-attributes --attribute-names All` on DLQ)

### 2. 상관 분석이 동작하지 않음 / Correlation not grouping

**확인 / Check**:
```bash
curl -s http://localhost:3000/awsops/api/alert-webhook | jq '.activeIncidents'
```

여러 알림이 같은 서비스/리소스를 건드리는데도 별도 인시던트로 남아 있다면:
If multiple alerts touch the same service/resource but remain separate:

- `correlationWindowSeconds` (기본 30초) 이내에 도착했는가?
- 알림 라벨에 `service`, `namespace`, 리소스 ID가 있는가?
- `alert-correlation.ts` 의 매칭 룰을 확인 (resource > service > namespace > time)

### 3. Bedrock 분석이 실패 / Bedrock analysis fails

**확인 / Check**:
```bash
grep -i "AlertDiagnosis" /tmp/awsops-server.log | tail -20
```

**원인 / Causes**:
- 모델 ID 오류 → `src/lib/alert-diagnosis.ts:18` 가 `global.anthropic.claude-sonnet-4-6`인지 확인 (커밋 ba03173 참고)
- 토큰 한도 초과 → 컨텍스트가 60KB를 넘음 → `MAX_CONTEXT_CHARS` 조정
- IAM 권한 → EC2 인스턴스 롤에 `bedrock:InvokeModel` 필요

### 4. Slack 알림이 오지 않음 / Slack notifications missing

**확인 / Check**:
```bash
curl -s http://localhost:3000/awsops/api/alert-webhook | jq '.enabled, .sources'
```

- `getSlackConfig()` 가 `null`을 리턴하면 → `data/config.json` 의 `slack` 블록 확인
- 웹훅 모드: 대시보드 URL 확인 (Block Kit 액션 버튼 링크가 404면 잘못된 도메인)
- Bot 토큰 모드: `https://slack.com/api/auth.test` 로 토큰 직접 검증

### 5. Active incident 배지가 사라지지 않음 / Active badge stuck

Header/대시보드의 active 카운트는 **인메모리** — 서버 재시작 시 초기화됨.
The Header badge reads from in-memory incidents — restart clears stale state.

```bash
# 수동 초기화 / Force clean
kill $(pgrep -f "next-server") && sleep 2
nohup npm run start > /tmp/awsops-server.log 2>&1 &
```

## 관련 파일 / Related Files
- `src/lib/alert-sqs-poller.ts` — 폴링 루프
- `src/lib/alert-correlation.ts` — 상관 분석
- `src/lib/alert-diagnosis.ts` — Bedrock 오케스트레이션
- `src/lib/alert-knowledge.ts` — `data/alert-diagnosis/` 저장 + 월별 summary
- `src/app/api/alert-webhook/route.ts` — 웹훅 수신 + GET 상태

## 참고 / Reference
- ADR-008 — AI 진단 파이프라인 / AI diagnosis pipeline (구 009 알림 트리거 진단 + 013 자동 수집 조사): `docs/decisions/008-ai-diagnosis-pipeline.md`
- ADR-013 — 알림·통보 / alerting & notification (알림 수신·웹훅·SNS): `docs/decisions/013-alerting-notification.md`
