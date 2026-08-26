---
sidebar_position: 8
title: AI 종합 진단
description: 15섹션 Bedrock Opus 진단 리포트, DOCX/MD/PDF 내보내기, 스케줄링, 이메일 알림
---

import Screenshot from '@site/src/components/Screenshot';

# AI 종합 진단

`/ai-diagnosis` 페이지는 Amazon Bedrock **Claude Opus 4.8**가 15섹션으로 AWS 인프라 전반을 자동 분석하는 종합 리포트 도구입니다.

<Screenshot src="/screenshots/monitoring/ai-diagnosis.png" alt="AI 종합 진단 페이지" />

## 개요

| 항목 | 값 |
|------|---|
| **모델** | `global.anthropic.claude-opus-4-8` (고정) |
| **섹션 수** | 15 (비용 4 + 인프라 6 + 보안/네트워크 2 + 요약 3) |
| **출력 포맷** | DOCX (A4 + TOC), Markdown, PDF (브라우저 print) |
| **저장 위치** | S3 리포트 버킷 + `data/reports/*.json` 캐시 |
| **진행 상태 폴링** | 5초 간격 SSE |
| **자동 스케줄** | 비활성 / 주간 / 격주 / 월간 (KST) |
| **이메일 알림** | 완료 시 등록된 수신자에 PDF 첨부 |

## 페이지 구성

### 1. 상단 액션 바
- **Run Diagnosis** 버튼 — 즉시 진단 시작 (전체 15섹션 평균 6~10분)
- **Schedule** 아이콘 — 자동 스케줄 패널 토글 (admin only)
- **Notification** 아이콘 — 이메일 알림 수신자 관리 (admin only)
- **DOCX 다운로드** — 가장 최근 완료 리포트를 즉시 다운로드

### 2. 좌측 TOC 사이드바
완료된 리포트를 펼치면 15섹션이 TOC로 표시되고, 클릭 시 해당 섹션으로 스크롤합니다. 다중 확장이 가능해 여러 섹션을 동시에 비교할 수 있습니다.

### 3. 리포트 이력 테이블
| 컬럼 | 설명 |
|------|------|
| 생성 시각 | YYYY-MM-DD HH:MM (KST) |
| 계정 | 대상 어카운트 별칭 (멀티 어카운트일 때) |
| 상태 | completed / generating / failed |
| 다운로드 | DOCX · MD · PDF |

페이지네이션: 한 페이지 5개, 날짜 범위 필터로 좁힐 수 있습니다.

## 15개 섹션 (실제 정의 순서)

`src/lib/report-prompts.ts`의 `REPORT_SECTIONS` 배열 순서 그대로:

| # | section ID | 한글 제목 | 영문 제목 |
|---|------------|-----------|-----------|
| 1 | `cost-overview` | 비용 현황 | Cost Overview |
| 2 | `cost-compute` | 컴퓨팅 비용 심층분석 | Compute Cost Deep Dive |
| 3 | `cost-network` | 네트워크 전송 비용 | Network & Data Transfer Cost |
| 4 | `cost-storage` | 스토리지 비용 심층분석 | Storage Cost Deep Dive |
| 5 | `idle-resources` | 유휴 리소스 & 낭비 | Idle Resources & Waste |
| 6 | `security-posture` | 보안 현황 | Security Posture |
| 7 | `network-architecture` | 네트워크 아키텍처 | Network Architecture |
| 8 | `compute-analysis` | 컴퓨팅 인프라 분석 | Compute Infrastructure |
| 9 | `eks-analysis` | EKS & 컨테이너 분석 | EKS & Container Analysis |
| 10 | `database-analysis` | 데이터베이스 분석 | Database Analysis |
| 11 | `msk-analysis` | MSK & 스트리밍 분석 | MSK & Streaming Analysis |
| 12 | `storage-analysis` | 스토리지 인프라 분석 | Storage Infrastructure |
| 13 | `executive-summary` | 종합 요약 | Executive Summary |
| 14 | `recommendations` | 권장사항 & 로드맵 | Recommendations & Roadmap |
| 15 | `appendix` | 부록: 리소스 인벤토리 | Appendix: Resource Inventory |

:::tip 실행 순서 vs 보고 순서
프롬프트 순서는 `cost-overview`부터 시작하지만, **Executive Summary**(13번)는 다른 섹션 결과를 요약하기 위해 마지막에 합성됩니다. TOC에는 정의 순서대로 표시됩니다.
:::

## 리포트 생성 흐름

1. **Run Diagnosis** 클릭 → POST `/awsops/api/report` (action: `generate`)
2. `collectReportData()`가 Steampipe + CloudWatch + Cost Explorer 데이터 수집
3. `REPORT_SECTIONS` 15개를 Opus에 순차 전송 (각 섹션 약 30~60초)
4. 페이지가 5초마다 GET `?action=status&id=<reportId>` 폴링 → 진행률 표시
5. 완료 시:
   - DOCX 자동 생성 → S3 업로드
   - Markdown은 즉시 사용 가능
   - PDF는 브라우저 Print 대화상자 트리거 방식
   - 이메일 알림이 켜져 있으면 수신자에게 발송

## 자동 스케줄링

스케줄 패널에서 다음 항목을 설정합니다 (admin 전용 — `adminEmails` 체크):

| 필드 | 값 |
|------|---|
| `enabled` | true/false |
| `frequency` | `weekly` / `biweekly` / `monthly` |
| `dayOfWeek` | 0(일)~6(토) — weekly/biweekly에서 사용 |
| `dayOfMonth` | 1~28 — monthly에서 사용 |
| `hour` | 0~23 (KST 기준, 기본 6시) |
| `accountId` | 특정 계정 한정 (비우면 전체) |
| `lang` | `ko` / `en` |

설정은 `data/report-schedule.json`에 저장되고, `startScheduler()`가 매 시간 `isDue()`로 확인해 트리거합니다. `nextRunAt`은 KST 기준으로 계산됩니다.

:::info biweekly 안전 장치
격주의 경우 직전 실행으로부터 13일 미만이고 다음 실행까지 7일 미만이면 자동으로 +7일 더해서 최소 격주 간격을 보장합니다 (`report-scheduler.ts:85-93`).
:::

## 이메일 알림

알림 패널에서 수신자 이메일 목록을 관리합니다. 진단 완료 시:
- 제목: `[AWSops] AI Diagnosis Report — {YYYY-MM-DD}`
- 본문: 섹션 개수, 주요 권장사항 요약, 다운로드 링크
- 첨부: PDF (선택 사항)

수신자 목록은 `data/report-schedule.json`의 `notifEmails` 필드에 함께 보존됩니다.

## 다운로드 포맷 상세

| 포맷 | 생성 경로 | 특징 |
|------|----------|------|
| **DOCX** | `lib/report-docx.ts` → API `download-docx` | A4 라이트 테마, TOC, 헤더/푸터/페이지 번호, 마크다운→문단/표/블릿 변환 |
| **Markdown** | API `download-md` | 원본 텍스트 (15섹션 모두 연결) |
| **PDF** | `/ai-diagnosis/report` 페이지 + 브라우저 Print | 화이트 배경, A4 페이지 브레이크, 별도 PDF 라이브러리 없음 (bundle size 보호) |

:::tip PDF 라이브러리를 추가하지 않는 이유
ADR-019: 별도 PDF 라이브러리(Puppeteer 등)는 Next.js 번들 크기와 EC2 메모리를 크게 늘립니다. 대신 인쇄용 페이지를 만들고 브라우저의 Print-to-PDF를 활용합니다 — 결과물 품질은 동등하면서 의존성이 0개입니다.
:::

## 알림 파이프라인과 연계

실시간 알림 시스템(CloudWatch / Alertmanager / Grafana)이 `critical`로 집계되면 **부분 진단**을 트리거할 수 있습니다 (`alert-diagnosis.ts`):

- 영향받은 서비스/리소스 범위로 섹션 자동 선택 (보통 3~5섹션)
- 1~2분 안에 완료
- 결과를 Slack 알림 스레드에 reply

자세한 흐름은 [알림 파이프라인](./alerts.md) 문서를 참고하세요.

## 트러블슈팅

| 증상 | 원인 | 해결 |
|------|------|------|
| 10분 이상 멈춤 | Steampipe 쿼리 타임아웃 | `nextjs` 로그에서 `statement_timeout` 확인 후 해당 섹션만 재실행 |
| DOCX 다운로드 실패 | S3 업로드 실패 (IAM) | EC2 인스턴스 프로파일에 `s3:PutObject` 권한 확인 |
| 매일 자정에 실행됨 | `dayOfMonth` 미설정 | monthly 사용 시 1~28 범위로 명시 |
| 이메일 안 옴 | SNS 토픽 구독 미확인 | 이메일 받은편지함에서 SNS confirm 클릭 |

## API 직접 호출

```bash
# 진단 시작
curl -X POST /awsops/api/report \
  -H 'Content-Type: application/json' \
  -d '{"action":"generate","lang":"ko"}'

# 진행 상태 확인
curl '/awsops/api/report?action=status&id=<reportId>'

# 목록 조회 (페이지네이션)
curl '/awsops/api/report?action=list&page=1&pageSize=5'

# 스케줄 변경
curl -X POST /awsops/api/report \
  -H 'Content-Type: application/json' \
  -d '{"action":"set-schedule","schedule":{"enabled":true,"frequency":"weekly","dayOfWeek":1,"hour":6,"lang":"ko"}}'
```

## 관련 페이지

- [알림 파이프라인](./alerts.md) — 부분 진단 트리거
- [Resource Inventory](./inventory.md) — Appendix 섹션 데이터 원본
- [Compliance](../security/compliance) — Security Posture 섹션 원본
- [Cost Explorer](./cost) — 비용 4섹션 원본

## 참고

- ADR-019: 진단 리포트 포맷 매트릭스
- ADR-014: 리포트 프록시 다운로드 URL
- ADR-016: Bedrock 모델 선택 전략 (Opus 4.8 고정)
- `src/lib/report-prompts.ts` — 15섹션 프롬프트 정의 (정확한 출력 구조)
- `src/lib/report-scheduler.ts` — 스케줄 계산 로직 (KST 기준)
