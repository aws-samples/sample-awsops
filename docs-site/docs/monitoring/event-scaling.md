---
sidebar_position: 10
title: 이벤트 사전 스케일링
description: ADR-010 Phase 1+2 — 트래픽 이벤트 등록, 과거 메트릭 분석, AI 기반 워밍업 스크립트 생성
---

import Screenshot from '@site/src/components/Screenshot';

# 이벤트 사전 스케일링 (Event Pre-Scaling)

`/event-scaling` 페이지는 다가오는 트래픽 이벤트(블랙프라이데이, 티켓 오픈, 라이브 방송 등)에 대비한 **AI 기반 사전 워밍업 계획**을 생성합니다. ADR-010 Phase 1+2 구현이며, **계획 생성 + 스크립트 내보내기까지만** 수행하고 **실행은 운영자가 직접 수동 검토 후 실행**합니다.

<Screenshot src="/screenshots/overview/event-scaling.png" alt="이벤트 사전 스케일링 페이지" />

## 개요

| 항목 | 값 |
|------|---|
| **모델** | Bedrock Claude Sonnet 4.6 (`global.anthropic.claude-sonnet-4-6-v1`) |
| **권한** | admin 전용 — `data/config.json`의 `adminEmails` |
| **상태 머신** | planned → analyzing → plan-ready → approved / cancelled |
| **실행** | **없음** — bash 스크립트로 export, 사람이 직접 실행 |
| **저장 위치** | `data/event-scaling/<eventId>.json` |
| **지원 리소스** | KEDA, HPA, Aurora replica/ACU, MSK broker/partition, ASG, EC2, EBS IOPS, ALB |

:::caution Phase 2 한계
생성된 스크립트는 **사람의 검토용**입니다. AWSops는 인프라 변경(KEDA 배포, AWS API 호출)을 직접 실행하지 않습니다. 자동 실행 + IAM 확장 + KEDA 통합은 ADR-029 Phase 3 게이트(Proposed)에서 별도로 다룹니다.
:::

## 워크플로우

```
[New Event] → [Save] → [Analyze] → [Review Plan] → [Approve | Cancel]
              POST     POST        UI 확장          POST approve / DELETE
              create   analyze
                       ├ metrics  fetch
                       └ bedrock  generate
```

### 1. 이벤트 등록 (`planned`)
**+ New Event** 버튼으로 다음 필드를 입력합니다:

| 필드 | 설명 |
|------|------|
| Event Name | 식별용 라벨 (예: "Black Friday 2026") |
| Description | 자유 텍스트 메모 |
| Event Start / End | KST 시각 (ISO 8601) — 피크 윈도우 |
| Pattern Type | `flash-sale`, `sustained-peak`, `gradual-ramp`, `ticket-drop` |
| Expected Peak Multiplier | 평시 대비 배수 (예: `10` = 10배) |
| Duration Minutes | 피크 지속 시간 |
| Ramp-Up Minutes | 사전 워밍업 윈도우 |
| Custom Metrics | CloudWatch metric 이름 콤마 구분 (선택) |
| Reference Event | 과거 유사 이벤트 이름 + 일시 (메트릭 회수 기준) |
| Target Account | 멀티 어카운트 시 한정 |

### 2. 메트릭 수집 + 분석 (`analyzing` → `plan-ready`)
**Analyze** 버튼을 누르면 다음이 순차 실행됩니다:

1. Reference Event 시점의 ±60분 윈도우(기본)에서 CloudWatch 메트릭 수집 → `MetricsSnapshot`
2. Steampipe로 현재 리소스 상태 스냅샷
3. 두 데이터셋을 Bedrock Sonnet 4.6에 전송 → 다단계 워밍업 플랜 생성
4. 응답 끝의 `PLAN_JSON: { ... }` 마커를 파싱하여 구조화된 `ScalingPlan` 추출

소요 시간: 보통 30~90초.

### 3. 플랜 검토 + 승인 (`plan-ready` → `approved`)
오른쪽 패널이 펼쳐지며 다음을 보여줍니다:

- **단계 (Phase)** — T-4h, T-30m 등 시점별로 그룹화
- **타깃 (ScalingTarget)** — 리소스 타입, 현재값 → 목표값, 단위, 사유
- **스크립트** — bash/kubectl 코드 (단계별 다운로드 또는 전체 ZIP)
- **예상 추가 비용** — USD (모델이 추정한 값)
- **모델 메타** — modelId, input/output 토큰
- **Raw analysis** — Bedrock 마크다운 원본 (감사 목적)

**Approve** 버튼은 실행이 아니라 **"검토 완료" 마킹**입니다. `approvedBy` + `approvedAt`이 기록됩니다.

### 4. 취소 / 삭제
- **Cancel** — 상태만 `cancelled`로 변경 (기록 보존)
- **Cancel (hard)** — `?hard=true` 플래그로 JSON 파일 삭제

## 지원 리소스 타입

| Type | 스크립트 생성기 (`event-scaling-scripts.ts`) | 설명 |
|------|------|------|
| `keda` | `kubectl scale` + ScaledObject 패치 | EKS 워크로드 사전 스케일 |
| `hpa` | `kubectl patch hpa` | minReplicas/maxReplicas 조정 |
| `aurora-replica` | AWS CLI `modify-db-cluster` | 리더 노드 수 증가 |
| `aurora-acu` | AWS CLI `modify-db-cluster` | Serverless v2 ACU 상한 |
| `msk-broker` | AWS CLI `update-broker-count` | MSK 브로커 추가 |
| `msk-partition` | `kafka-topics.sh --alter` | 토픽 파티션 증가 |
| `asg` | AWS CLI `update-auto-scaling-group` | Desired/Max 조정 |
| `ec2` | AWS CLI `run-instances` | 추가 인스턴스 사전 기동 |
| `ebs-iops` | AWS CLI `modify-volume` | gp3 IOPS/throughput 증가 |
| `alb-capacity` | (메모만) | ALB 자동 스케일 사전 워밍업 |

모든 스크립트는 **검토 후 수동 실행**용입니다 — `set -euo pipefail` + `--dry-run` 주석 포함.

## API

```bash
# 목록
curl '/awsops/api/event-scaling?action=list&accountId=111111111111'

# 단건 상세
curl '/awsops/api/event-scaling?action=detail&id=<eventId>'

# 등록
curl -X POST '/awsops/api/event-scaling?action=create' \
  -H 'Content-Type: application/json' \
  -d '{"name":"BF2026","eventStart":"2026-11-27T13:00:00+09:00","eventEnd":"2026-11-27T18:00:00+09:00","pattern":{"type":"flash-sale","expectedPeakMultiplier":10,"durationMinutes":120,"rampUpMinutes":60}}'

# 메트릭 + 분석
curl -X POST '/awsops/api/event-scaling?action=analyze&id=<eventId>'

# 승인 마킹
curl -X POST '/awsops/api/event-scaling?action=approve&id=<eventId>'

# 스크립트 다운로드 (text/x-shellscript)
curl '/awsops/api/event-scaling?action=script&id=<eventId>' -o warmup.sh

# 취소
curl -X DELETE '/awsops/api/event-scaling?id=<eventId>'
```

## 패턴 가이드

| 패턴 | 사용 예 | 추천 ramp-up |
|------|---------|-------------|
| `flash-sale` | 블랙프라이데이, 쇼핑몰 세일 오픈 | 30~60분 |
| `sustained-peak` | 라이브 스트리밍, 컨퍼런스 | 60~120분 |
| `gradual-ramp` | 마케팅 캠페인, 뉴스레터 발송 | 120~240분 |
| `ticket-drop` | 콘서트 티켓 오픈, 한정판 출시 | 15~30분 |

## 트러블슈팅

| 증상 | 원인 | 해결 |
|------|------|------|
| Reference Event 메트릭 빈 값 | 해당 시점에 리소스가 없었거나 IAM 부족 | EC2 인스턴스 프로파일에 `cloudwatch:GetMetricStatistics` 확인 |
| `PLAN_JSON` 파싱 실패 | Bedrock 응답이 잘림 (max tokens) | `eventScalingMaxTokens` config 상향, 단계 수 줄이기 |
| Approve 후 자동 실행 안 됨 | Phase 2 의도된 동작 | 스크립트 export 후 수동 실행 (Phase 3에서 변경 예정) |
| 멀티 어카운트 분리 안 됨 | `accountId` 누락 | 등록 시 Target Account 지정 |

## 관련 페이지

- [Resource Inventory](./inventory) — 사전 리소스 현황 파악
- [Monitoring](./monitoring.md) — 평시 메트릭 확인
- [Cost Explorer](./cost) — 사전 스케일링 비용 영향 검증
- [AI 종합 진단](./ai-diagnosis) — 이벤트 후 회고 리포트

## 참고

- **ADR-010 Phase 1+2** — 이벤트 등록 + AI 플랜 생성 (현재 구현)
- **ADR-029** — Phase 3 mutating action 게이트 (Proposed)
- `src/lib/event-scaling.ts` — 데이터 모델 + JSON 영속화
- `src/lib/event-scaling-prompts.ts` — Bedrock 프롬프트 + `PLAN_JSON` 마커 파싱
- `src/lib/event-scaling-scripts.ts` — 자원별 안전한 bash 스크립트 생성
