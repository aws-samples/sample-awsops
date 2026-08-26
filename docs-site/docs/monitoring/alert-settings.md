---
sidebar_position: 9
title: 알림 파이프라인 설정
description: 웹훅 수신 + HMAC 인증 + 상관 분석 + AI 자동 진단 + Slack 알림 설정 (admin 전용)
---

import Screenshot from '@site/src/components/Screenshot';

# 알림 파이프라인 설정 (Alert Settings)

`/alert-settings` 페이지는 알림 웹훅 수신부터 AI 진단 자동 트리거, Slack 알림 발송까지의 전체 파이프라인을 한 곳에서 구성합니다. **admin 전용** 페이지로 `data/config.json`의 `adminEmails` 검사 후 접근 가능합니다.

<Screenshot src="/screenshots/overview/alert-settings.png" alt="알림 파이프라인 설정 (Access Denied 화면 — admin 전용)" />

:::caution Admin 전용
admin이 아닌 사용자에게는 위 스크린샷처럼 **Access Denied** 화면이 표시됩니다. admin 사용자의 화면은 본 문서의 텍스트 설명을 참고하세요.
:::

## 파이프라인 전체 흐름

```
[External]                       [AWSops]
CloudWatch SNS  ─┐
Alertmanager    ─┤              ┌─→ Correlation ─→ Diagnosis ─→ Slack
Grafana         ─┼─→ Webhook ───┤                  (Bedrock      (Block Kit)
SQS poller      ─┤    + HMAC    ├─→ Knowledge      Opus)
Generic JSON    ─┘              │   Base
                                └─→ Stats
```

## 페이지 구성

### 1. Master Toggle
전체 파이프라인 활성/비활성. 비활성 시 웹훅은 받지만 진단은 트리거하지 않습니다.

### 2. Alert Sources (5종)

| 소스 | 라벨 | 페이로드 정규화 | 인증 |
|------|------|----------------|------|
| `cloudwatch` | CloudWatch Alarm (SNS) | `normalizeCloudWatchAlarm()` | SNS subscription 확인 |
| `alertmanager` | Prometheus Alertmanager | `normalizeAlertmanager()` | HMAC-SHA256 시크릿 |
| `grafana` | Grafana Alerting | `normalizeGrafana()` | HMAC-SHA256 시크릿 |
| `sqs` | AWS SQS Queue | SNS→SQS 메시지 본문 | IAM (SQS 폴러) |
| `generic` | Generic Webhook | `normalizeGeneric()` | HMAC-SHA256 시크릿 |

각 소스별로 다음을 설정합니다:
- **Enabled** 토글
- **Secret** — HMAC 서명 검증용 (회전 시 active+standby 2개 보관)
- **(SQS only)** Queue URL + Region

### 3. Webhook URL
페이지 상단에 다음 형식의 URL이 표시됩니다 (복사용):

```
https://<your-host>/awsops/api/alert-webhook?source=alertmanager
```

송신 측에서는 동일한 시크릿으로 HMAC을 계산해 `X-AWSops-Signature` 헤더에 첨부해야 합니다.

### 4. Diagnosis Config (Advanced)

| 필드 | 기본값 | 설명 |
|------|--------|------|
| `correlationWindowSeconds` | 30 | 동일 알림 그룹화 시간창 |
| `deduplicationWindowMinutes` | 15 | 동일 incident 중복 무시 시간창 |
| `cooldownMinutes` | 5 | 같은 리소스 재진단 최소 간격 |
| `maxConcurrentInvestigations` | 3 | 동시 Bedrock 호출 상한 (비용 제어) |
| `investigationTimeoutSeconds` | 120 | Bedrock 응답 타임아웃 |
| `includeChangeDetection` | true | git/CloudTrail 최근 변경 자동 포함 |
| `knowledgeBaseEnabled` | true | 과거 유사 사례 검색 후 첨부 |
| `minimumSeverity` | `warning` | 자동 진단 트리거 최소 심각도 |

`minimumSeverity = critical`로 설정하면 critical만 AI 진단이 자동 실행됩니다 (비용 최적화).

### 5. Slack 설정

| 필드 | 설명 |
|------|------|
| `enabled` | Slack 발송 마스터 토글 |
| `method` | `bot` (Bot Token) / `webhook` (Incoming Webhook) |
| `botToken` | Slack Bot Token (`xoxb-...`) |
| `webhookUrl` | Webhook URL (`method=webhook`일 때) |
| `defaultChannel` | `#ops-alerts` 등 폴백 채널 |
| `channelMapping` | 심각도별 채널 라우팅 |
| `threadUpdates` | 같은 incident 후속 알림을 스레드로 묶기 |

**기본 채널 매핑:**
```
critical → #ops-critical
warning  → #ops-alerts
info     → #ops-general
```

**Test Slack** 버튼으로 더미 메시지를 발송해 연결 확인이 가능합니다.

### 6. Diagnosis History
하단의 진단 이력 섹션은 다음을 보여줍니다:

- 최근 incident 목록 (incidentId, timestamp, alertNames, rootCause, confidence)
- 통계: 총 incident 수, 심각도별 분포, 카테고리별 분포, Top 알림 이름, 평균 처리 시간
- 각 행을 펼치면 Bedrock 진단 마크다운 전체를 확인 가능

## 상관 분석 동작 방식

`alert-correlation.ts`가 다음 기준으로 알림을 그룹화합니다:

1. **시간 기반** — `correlationWindowSeconds`(기본 30s) 안에 도착한 알림
2. **서비스 기반** — `service` 라벨이 같은 알림 (예: `eks`, `rds`)
3. **리소스 기반** — `resourceArn`/`namespace`/`instanceId`가 같은 알림
4. **심각도 에스컬레이션** — 같은 그룹에서 `warning`이 누적되면 `critical`로 승격
5. **중복 제거** — `deduplicationWindowMinutes`(기본 15m) 안에 동일 시그너처는 단일 incident로 합침

그룹화된 incident가 `minimumSeverity` 이상이면 `alert-diagnosis.ts`가 자동 트리거됩니다.

## AI 진단 흐름

1. 영향받은 서비스/리소스/네임스페이스로 진단 스코프 한정
2. 컬렉터(`src/lib/collectors/*.ts`)와 외부 데이터소스(Prometheus, Loki 등) 병렬 호출
3. 변경 감지(`includeChangeDetection`)가 켜져 있으면 최근 git 커밋·CloudTrail 이벤트 첨부
4. 지식베이스(`knowledgeBaseEnabled`)에서 유사 사례 5건 검색해 컨텍스트로 첨부
5. Bedrock Claude Opus로 분석 → 마크다운 응답 + 근거 메타데이터
6. Slack에 Block Kit 카드 발송 (스레드 업데이트가 켜져 있으면 reply로)

## HMAC 시크릿 회전

1. 새 시크릿을 **Standby** 슬롯에 입력 후 저장
2. 송신 측을 새 시크릿으로 전환 (양쪽 시크릿 모두 유효)
3. 송신 측 전환 완료 후, 페이지에서 **Promote** 버튼으로 standby → active 승격
4. 구 시크릿 폐기

이 흐름은 무중단으로 시크릿을 교체하기 위한 active+standby 2-키 정책입니다.

## API

```bash
# 설정 조회
curl '/awsops/api/steampipe?action=config'

# admin 확인
curl '/awsops/api/steampipe?action=admin-check'

# 진단 이력
curl '/awsops/api/alert-webhook'

# Slack 테스트 메시지
curl -X POST '/awsops/api/notification' \
  -H 'Content-Type: application/json' \
  -d '{"action":"test","channel":"#ops-alerts"}'

# 더미 알림 송신 (테스트용)
curl -X POST '/awsops/api/alert-webhook?source=generic' \
  -H 'X-AWSops-Signature: <hmac>' \
  -H 'Content-Type: application/json' \
  -d '{"source":"manual","title":"Test alert","severity":"warning","message":"Hello"}'
```

## 트러블슈팅

| 증상 | 원인 | 해결 |
|------|------|------|
| 401 Unauthorized | HMAC 검증 실패 | 시크릿 동기화 확인, 헤더 이름은 `X-AWSops-Signature` |
| 진단이 트리거 안 됨 | severity가 minimum 미만 | `minimumSeverity` 낮추거나 알림 severity 매핑 확인 |
| Slack 메시지 안 옴 | Bot Token 권한 부족 | OAuth scope에 `chat:write`, `chat:write.public` 추가 |
| Bedrock 타임아웃 | `investigationTimeoutSeconds` 짧음 | 120초 → 180초 상향, 데이터소스 응답 시간 확인 |
| 중복 알림 폭주 | `deduplicationWindowMinutes` 짧음 | 15분 → 30분 상향, 같은 source의 cooldown 별도 설정 |

## 관련 페이지

- [AI 종합 진단](./ai-diagnosis) — alert-triggered 부분 진단의 베이스
- [External Datasources](./datasources) — 진단 시 병렬 호출되는 외부 데이터
- [Monitoring](./monitoring.md) — 알람 원본 (CloudWatch metrics 화면)
- [AgentCore](../overview/agentcore) — 진단을 수행하는 AI Runtime

## 참고

- ADR-022: 알림 상관 분석 정책
- ADR-026: HMAC 시크릿 active+standby 2-키 정책
- `src/lib/alert-types.ts` — 5가지 소스 정규화 로직
- `src/lib/alert-correlation.ts` — 그룹화/중복 제거/에스컬레이션
- `src/lib/alert-diagnosis.ts` — Bedrock 진단 오케스트레이션
- `src/lib/slack-notification.ts` — Block Kit 메시지 + 채널 라우팅
