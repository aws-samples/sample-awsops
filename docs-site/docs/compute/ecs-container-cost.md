---
sidebar_position: 11
title: ECS Container Cost
description: ECS Fargate 태스크 비용 분석, CloudWatch Container Insights 메트릭
---

import Screenshot from '@site/src/components/Screenshot';

# ECS Container Cost

:::caution v1 아카이브 문서 — v2 대응 기능은 /inventory/ecs_task
이 문서는 v1의 전용 **ECS Container Cost** 페이지(통계 카드, 차트, "Cost Calculation Basis" 토글 포함)를 설명합니다. **v2에 전용 페이지는 없고 대응 기능이 `/inventory/ecs_task` 인벤토리 뷰에 있습니다**: **Cost/Day, Cost/Mo** 컬럼, '일일 비용 합 (est.)' KPI 타일, 그리고 테이블 하단의 접이식 **비용 계산 근거** 패널(v1 'Cost Calculation Basis' 대응). 컬럼 값은 CloudWatch Container Insights의 사용량 메트릭이 아니라 **태스크 정의에 할당된 cpu/memory로 계산한 정적(static) 추정치**입니다(`web/lib/inventory-derived.ts`의 `ecs_task` deriver — 단가 상수는 `web/lib/cost-basis.ts` 단일 소스). 아래 **가격 상수·계산 공식**(`$0.04656`/`$0.00511`, `(CPU units/1024)×단가×24 + (MB/1024)×단가×24`)은 그 정적 추정치를 만드는 실제 로직과 일치해 정확합니다 — 손대지 마세요. 이 문서의 파이 차트와 "CloudWatch Container Insights 메트릭 기반으로 계산"이라는 서술은 v1 전용이며 v2에는 없습니다(v2 추정은 정적 상수 기반이며, 임시 스토리지 단가는 미반영). 단, **Cost by Service (CPU vs Memory)** 차트는 v2에도 있습니다 — `/inventory/ecs_task`에 서비스별 그룹 바(FARGATE 태스크만, 정적 추정 기반, 상위 10개)로 표시됩니다.
:::

ECS Fargate 태스크의 비용을 분석하는 페이지입니다. Fargate 가격과 CloudWatch Container Insights 메트릭을 기반으로 비용을 계산합니다.

<Screenshot src="/screenshots/compute/ecs-container-cost.png" alt="ECS Container Cost" />

## 주요 기능

### 통계 카드
- **Daily Cost (ECS)**: 일일 총 비용 (시안)
- **Monthly Estimate**: 월간 추정 비용 (녹색)
- **Running Tasks**: 실행 중 태스크 수 - Fargate/EC2 구분 (보라색)
- **Top Cost Service**: 가장 비용이 높은 서비스 (주황색)

### Service Cost Distribution 차트
서비스별 일일 비용 분포를 파이 차트로 표시

### Cost by Service (CPU vs Memory) 차트
서비스별 CPU 비용과 Memory 비용을 비교합니다. v2에서는 스택 바 대신 **공용 스케일 그룹 바**(두 $ 시리즈가 하나의 스케일 공유 — 실제 비율 유지)로 렌더링되며, 클러스터/서비스 라벨·FARGATE 한정·상위 10·500행 초과 시 '표본 기준' 표기가 적용됩니다.

### ECS Tasks 테이블
| 컬럼 | 설명 |
|------|------|
| Cluster | 클러스터 이름 |
| Service | 서비스 이름 |
| Task ID | 태스크 ID (앞 12자리) |
| Type | 실행 타입 (FARGATE/EC2) |
| CPU (units) | CPU 유닛 및 vCPU 환산값 |
| Memory (MB) | 메모리 및 GB 환산값 |
| Daily Cost | 일일 비용 (Fargate만) |
| AZ | 가용 영역 |

## 비용 계산 방식

### Fargate 가격 (v2 실제 값 — ap-northeast-2(서울) 단가, `web/lib/inventory-derived.ts`)
| 리소스 | 단가 | 과금 단위 |
|--------|------|-----------|
| vCPU | $0.04656 | per vCPU-hour |
| Memory | $0.00511 | per GB-hour |
| Ephemeral Storage (>20GB) | $0.000111 | per GB-hour |

> 이 값은 태스크의 실제 리전과 무관하게 항상 적용되는 고정 정적 추정 상수입니다 — deriver는 각 태스크 행의 리전 컬럼을 조회하지 않습니다.

### 계산 공식
```
CPU Cost = (CPU Units / 1024) x $0.04656/hr x 24hr
Memory Cost = (Memory MB / 1024) x $0.00511/hr x 24hr
Daily Cost = CPU Cost + Memory Cost
Monthly Estimate = Daily Cost x 30
```

### 계산 예시
Fargate Task: 512 CPU units (0.5 vCPU) + 1024 MB (1 GB)
- CPU: 0.5 vCPU x $0.04656/hr x 24hr = **$0.5587/day**
- Memory: 1 GB x $0.00511/hr x 24hr = **$0.1226/day**
- Total: **$0.681/day ($20.44/month)**

## 계산 근거 토글 (Cost Calculation Basis)

테이블 하단에 **▶ Cost Calculation Basis / 비용 계산 근거** 접기 가능 섹션이 있습니다. `showBasis` 토글 시 다음을 인라인으로 확장합니다:

- **Fargate Pricing 표** (v2 실제 값, ap-northeast-2(서울) 단가 — 태스크의 실제 리전과 무관하게 적용되는 고정 상수)
  - vCPU hourly rate: `$0.04656`
  - GB hourly rate: `$0.00511`
- 예시 계산: 0.5 vCPU × 1 GB 태스크 → `$0.681/day` 환산
- Spot, ARM(Graviton) 변동분에 대한 참고 노트

가격 값은 v1에서 `data/config.json`의 `fargatePricing`으로 오버라이드할 수 있었습니다 — v2에는 이 메커니즘이 없습니다.

## EKS Pod Cost 포인터 (Phase 2)

페이지 하단에 EKS 컨테이너 비용 분석으로 안내하는 카드가 있습니다 — 이 페이지는 ECS Fargate에 한정되며, EKS Pod 단위 비용은 별도 페이지에서 다룹니다:

→ [EKS Container Cost](./eks-container-cost) — Pod / Node 탭, OpenCost (Prometheus) 또는 Request-based 추정

## 사용 방법

1. 사이드바에서 **Compute > Container Cost**를 클릭합니다
2. 통계 카드에서 전체 비용 현황을 파악합니다
3. 차트에서 비용이 높은 서비스를 식별합니다
4. 테이블에서 태스크별 상세 비용을 확인합니다
5. "Cost Calculation Basis" 섹션을 펼쳐 계산 근거를 확인합니다

## 지원 범위

| 항목 | 지원 |
|------|------|
| Fargate Launch Type | O (비용 계산 지원) |
| EC2 Launch Type | X (노드 비용 분배 필요, 미지원) |
| Spot Fargate | - (On-Demand 가격 기준) |

## 사용 팁

:::tip EC2 Launch Type
EC2 타입 태스크는 "N/A (EC2)"로 표시됩니다. EC2 비용은 노드 비용 분배가 필요하여 현재 미지원입니다.
:::

:::tip 비용 최적화
CPU vs Memory 차트에서 한쪽이 크게 높으면 태스크 정의 조정을 검토하세요. Fargate는 CPU와 Memory 조합이 제한되어 있습니다.
:::

:::tip 가격 설정 변경 (v1 전용)
`data/config.json`의 `fargatePricing` 필드는 v1의 오버라이드 메커니즘입니다 — v2에는 존재하지 않습니다.
:::

:::info AI 분석
AI Assistant에서 "ECS 비용 분석", "가장 비용 높은 서비스", "Fargate 비용 최적화 방안" 등으로 분석할 수 있습니다.
:::

## 관련 페이지

- [ECS](../compute/ecs) - ECS 클러스터 및 서비스 상태
- [EKS Container Cost](../compute/eks-container-cost) - EKS Pod 비용 분석
- [Cost](../monitoring/cost) - 전체 AWS 비용 분석
