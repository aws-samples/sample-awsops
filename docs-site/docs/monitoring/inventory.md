---
sidebar_position: 5
title: Resource Inventory
description: AWS 리소스 수량 추이를 추적하고 비용 영향을 추정합니다.
---

import Screenshot from '@site/src/components/Screenshot';

# Resource Inventory

AWS 리소스의 수량 변화를 일별로 추적하고 비용 영향을 추정하는 페이지입니다.

<Screenshot src="/screenshots/monitoring/inventory.png" alt="Inventory" />

## 주요 기능

### 요약 통계
- **Resource Types**: 추적 중인 리소스 유형 수
- **Total Count**: 전체 리소스 수
- **7d Net Change**: 7일간 순 변화량

### 리소스 추이 그래프
- 멀티 라인 차트로 리소스 유형별 수량 추이 시각화
- 기간 토글: 14일(기본) / 30일 / 90일
- 리소스 유형 토글로 표시할 리소스 선택
- 상단 계정 선택을 따라 계정별로 스코프됩니다(계정별 이력은 해당 기능 배포 이후부터 축적, 리전 차원은 없음). 비교하는 두 시점의 타입별 계정 커버리지가 다르면(특정 계정이 그 타입 sync에서 침묵) 순증감·변화·비용 영향은 수치를 지어내지 않고 '—'로 표시됩니다. 리전 스코프를 좁히면(스냅샷에 리전 차원이 없으므로) 순증감 KPI는 '—', 비용 영향 패널은 숨겨집니다
- 파생 보안 시리즈(Public S3 Buckets / Open Security Groups / Unencrypted EBS)는 보안 페이지와 동일한 판정 기준으로 매 sync마다 기록되며, 원본 리소스와의 이중 계산을 피하기 위해 전체 합계(total)에는 포함되지 않습니다. Public S3 Buckets 시리즈는 호스트 계정 전용입니다(S3 공개 설정 수집이 호스트 SDK 수집이기 때문 — 보안 페이지와 동일한 범위)

### 시리즈 토글 그룹
차트 시리즈는 고정 목록이 아니라 최신 스냅샷 수량 기준으로 동적으로 순위가 매겨집니다:
- **Core Resources**: 수량 상위 5개 실제 리소스 타입 — 기본 표시
- **Other Resources**: 다음 순위 최대 3개 타입 — 기본 숨김(칩 클릭으로 표시)
- 나머지 타입은 차트에는 표시되지 않지만 아래 수량 변화 테이블에는 전부 나열됩니다
### 보안 시리즈 (기본 숨김, 별도 토글 그룹)
- Public S3 Buckets, Open Security Groups, Unencrypted EBS — 보안 페이지와 동일 판정 기준의 파생 카운트, 전체 합계(total) 미포함

### 리소스 테이블
| 컬럼 | 설명 |
|------|------|
| Resource | 리소스 유형 |
| Current | 현재 수량 |
| 7d Ago | 7일 전 수량 |
| 30d Ago | 30일 전 수량 |
| 7d Change | 7일간 변화량 및 변화율 |
| 30d Change | 30일간 변화량 및 변화율 |

### 비용 영향 추정
리소스 수량 변화에 따른 월간 비용 영향을 추정합니다:
- RDS Instances: $200/월 (추정)
- ElastiCache Clusters: $100/월
- NAT Gateways: $45/월
- EC2 Instances: $80/월
- 기타 리소스별 가중치 적용

## 사용 방법

1. **추이 확인**: 그래프에서 리소스 수량 변화 패턴 확인
2. **기간 변경**: 14d(기본)/30d/90d 토글로 분석 기간 조정
3. **리소스 선택**: 토글 버튼으로 관심 리소스만 표시
4. **테이블 분석**: 상세 수치 및 변화율 확인
5. **비용 영향**: 하단의 비용 추정 섹션 확인

:::tip 스냅샷 기반 데이터
스냅샷은 인벤토리 sync 실행마다 계정별로 Aurora(`inventory_snapshots`)에 기록됩니다. SDK 수집이 부분 실패한 run은 스냅샷을 전혀 쓰지 않고, 일부 계정만 도달 불가한 run은 도달 가능한 계정의 행은 새로 쓰되 도달 불가 계정의 직전 행만 보존합니다 — 그래서 특정 (계정, 타입) 일자 포인트가 비어 있을 수 있습니다 — 대시보드 로드와는 무관하며, 조회 시 추가 AWS API 호출이 없습니다.
:::

## 사용 팁

### 리소스 증가 추적
7d Change 또는 30d Change 컬럼에서 주황색(증가)으로 표시되는 리소스를 확인하세요. 예상치 못한 증가는 비용 급증의 원인일 수 있습니다.

### 보안 리소스 모니터링
다음 리소스의 변화에 주의하세요:
- **Public S3 Buckets**: 증가 시 데이터 노출 위험
- **Open Security Groups**: 증가 시 보안 취약점
- **Unencrypted EBS**: 컴플라이언스 이슈

### 비용 영향 해석
Cost Impact Estimation 섹션에서:
- 양수(+): 예상 비용 증가
- 음수(-): 예상 비용 감소

실제 비용은 인스턴스 유형, 사용량 등에 따라 다를 수 있습니다.

:::info 데이터 보관
스냅샷 데이터는 Aurora `inventory_snapshots` 테이블에 저장됩니다. 추이 조회는 최근 90일까지만 읽습니다(그보다 오래된 행은 조회 대상에서 제외).
:::

## AI 분석 팁

AI 어시스턴트를 활용한 질문 예시:

- "지난 30일간 가장 많이 증가한 리소스 분석해줘"
- "이 리소스 증가 추세가 계속되면 월 비용이 얼마나 될까?"
- "보안 관련 리소스 변화 요약해줘"
- "리소스 정리가 필요한 항목 추천해줘"

## 관련 페이지

- [Cost Explorer](../monitoring/cost) - 실제 비용 분석
- [Security Overview](../security) - 보안 리소스 상세
- [Monitoring Overview](../monitoring) - 성능 모니터링
