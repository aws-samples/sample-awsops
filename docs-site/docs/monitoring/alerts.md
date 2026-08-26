---
sidebar_position: 9
title: 알림 파이프라인
description: CloudWatch / Alertmanager / Grafana 웹훅 수신, 알림 상관 분석, 자동 AI 진단, Slack 알림
---

# 알림 파이프라인

외부 알림 시스템의 이벤트를 AWSops로 수신하여 **상관 분석 → 자동 AI 진단 → Slack 알림**까지 한 번에 처리하는 파이프라인입니다.

## 지원 소스

| 소스 | 수신 방식 | 정규화 |
|------|----------|--------|
| **CloudWatch Alarms** | SNS → SQS → EC2 폴링 | CloudWatch 이벤트 스키마 |
| **Prometheus Alertmanager** | 직접 웹훅 (HMAC) | Alertmanager v4 스키마 |
| **Grafana Alerting** | 직접 웹훅 (HMAC) | Grafana unified alerting |
| **Generic JSON** | 직접 웹훅 (HMAC) | 커스텀 스키마 매핑 |

## 구성 개요

```
[CloudWatch Alarm] → SNS Topic → SQS Queue
                                    ↓
                            [EC2 Poller (15s)]
                                    ↓
[Alertmanager/Grafana/Generic] → POST /awsops/api/alert-webhook
                                    ↓
                            [alert-correlation.ts]
                                    ↓
                         [alert-diagnosis.ts (AI)]
                                    ↓
                          [Slack/SNS 발송]
```

자세한 설정 단계는 서버 측 [런북](https://github.com/Atom-oh/awsops/tree/main/docs/runbooks/alert-pipeline-troubleshoot.md)에 있습니다.

## 웹훅 엔드포인트

### POST /awsops/api/alert-webhook

| 파라미터 | 위치 | 설명 |
|---------|------|------|
| `X-Alert-Source` | Header | `cloudwatch`, `alertmanager`, `grafana`, `generic` |
| `X-Signature-256` | Header | HMAC-SHA256 서명 (공유 시크릿) |
| Body | JSON | 소스별 원본 페이로드 |

### HMAC 서명

공유 시크릿은 `data/config.json`의 `alertWebhookSecret`에 저장합니다. 발신 측은 raw body를 HMAC-SHA256으로 서명하여 `X-Signature-256: sha256=<hex>` 헤더로 전송해야 합니다.

```bash
# Alertmanager webhook_configs 예시
- url: https://awsops.example.com/awsops/api/alert-webhook
  http_config:
    authorization:
      type: HMAC
      credentials: "<공유-시크릿>"
```

### GET /awsops/api/alert-webhook

활성 인시던트 목록을 조회합니다. 대시보드 상단의 🚨 배지 및 홈 화면의 "Recent Incidents" 카드가 이 API를 30초 주기로 폴링합니다.

```json
{
  "activeCounts": { "total": 3, "critical": 1, "warning": 2 },
  "activeIncidents": [
    {
      "id": "inc-20260422-093015",
      "severity": "critical",
      "status": "investigating",
      "alertCount": 7,
      "affectedServices": ["payment-api", "order-service"],
      "topAlertName": "HTTPErrorRateHigh"
    }
  ]
}
```

## 상관 분석 엔진

`src/lib/alert-correlation.ts`가 다음 기준으로 개별 알림을 **인시던트**로 그룹화합니다:

| 기준 | 기본값 | 설명 |
|------|--------|------|
| **시간 윈도우** | 5분 | 동일 서비스에서 5분 내 발생한 알림 병합 |
| **공통 서비스** | 1개 이상 | `labels.service` 또는 `resource`가 일치 |
| **공통 네임스페이스** | 1개 이상 | K8s 알림의 `labels.namespace` 일치 |
| **중복 제거** | 1분 | 동일 `fingerprint` 알림 1분 내 중복 억제 |
| **심각도 에스컬레이션** | `warning` → `critical` | warning 3건 5분 내 → critical 승격 |

## 자동 AI 진단

심각도 `critical` 인시던트는 자동으로 부분 AI 진단을 트리거합니다:

1. **AlertContext 빌드**: 영향받은 서비스, 리소스, 네임스페이스, 발화 시각(since)을 추출
2. **스코프 제한 수집**: CloudWatch 메트릭 쿼리를 `since` 기준 ±10분, 해당 리소스로만 필터링
3. **관련 섹션 선택**: 15섹션 중 Compute / Network / Container 등 3~5개만 실행
4. **변경 감지**: Terraform state / CloudTrail 최근 변경과 비교
5. **Bedrock 분석**: Claude Sonnet으로 근본 원인 추정 + Next Steps 제안

:::tip 전체 진단과의 차이
[AI 종합 진단](./ai-diagnosis.md)은 15개 섹션 전체를 전 리소스 기준으로 돌리지만, Alert-Triggered Diagnosis는 **발화한 알림 범위로만** 제한되어 1~2분 내 완료됩니다.
:::

## Slack 알림

### Block Kit 메시지

심각도에 따라 다음 채널로 라우팅됩니다 (`data/config.json`의 `slackChannels`):

| 심각도 | 기본 채널 | 색상 |
|-------|---------|------|
| `critical` | `#incidents` | 빨강 |
| `warning` | `#alerts` | 주황 |
| `info` | `#alerts-low` | 파랑 |

### 스레드 업데이트

인시던트 최초 알림은 **메인 메시지**로, 후속 이벤트(추가 알림 병합, AI 진단 결과, 해결 알림)는 **동일 스레드에 reply**로 게시됩니다. Slack Webhook 모드와 Bot Token 모드 모두에서 동작합니다.

### 해결 알림

CloudWatch `OK` 상태 또는 Alertmanager `resolved` 이벤트 수신 시 원래 스레드에 ✅ 해결 알림을 추가합니다.

## 알림 지식 베이스

`data/alert-diagnosis/` 아래에 진단 기록이 영구 저장됩니다:

| 파일 | 내용 |
|------|------|
| `incidents/<id>.json` | 개별 인시던트 + AI 진단 결과 |
| `summary-<YYYY-MM>.json` | 월간 통계 (top services, alert names, resolution time) |

UI의 **Knowledge Base** 탭에서 과거 유사 인시던트를 검색할 수 있으며, 새 인시던트 발생 시 유사도 기반으로 자동 추천됩니다.

## 알림 소음 제어

### Silence 창
특정 레이블 조합을 일정 시간 억제할 수 있습니다:

```json
{
  "silences": [
    {
      "matcher": { "service": "batch-job", "alertname": "HighCPU" },
      "startsAt": "2026-04-22T00:00:00Z",
      "endsAt":   "2026-04-22T06:00:00Z",
      "reason": "야간 배치 윈도우"
    }
  ]
}
```

### 중복 억제
동일 `fingerprint` + 1분 이내 → 자동 무시.

## 사용 팁

### 테스트 이벤트 발송
```bash
curl -X POST https://awsops.example.com/awsops/api/alert-webhook \
  -H 'X-Alert-Source: generic' \
  -H "X-Signature-256: sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $2}')" \
  -H 'Content-Type: application/json' \
  -d "$BODY"
```

### 활성 인시던트 확인
대시보드 헤더의 🚨 배지를 클릭하면 `/ai-diagnosis` 페이지로 이동해 진행 중인 인시던트의 상세 뷰를 확인할 수 있습니다.

### 알림이 오지 않을 때
서버 측 런북 [alert-pipeline-troubleshoot.md](https://github.com/Atom-oh/awsops/tree/main/docs/runbooks/alert-pipeline-troubleshoot.md)에 증상별 체크리스트가 있습니다.

## 관련 페이지

- [AI 종합 진단](./ai-diagnosis.md) — 15섹션 전체 진단
- [CloudWatch](./cloudwatch) — 알람 원본
- [외부 데이터소스](./datasources) — Alertmanager/Grafana 쿼리 원천

## 참고

- ADR-009: 알림 트리거 AI 진단
- ADR-012: SNS 알림 전략
- ADR-013: 자동 수집 조사 에이전트
