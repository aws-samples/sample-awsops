---
sidebar_position: 3
title: ECS
description: ECS 클러스터, 서비스, 태스크 모니터링
---

import Screenshot from '@site/src/components/Screenshot';

# ECS (Elastic Container Service)

ECS 클러스터, 서비스, 태스크의 상태를 모니터링할 수 있는 페이지입니다.

:::info v2 조회 방식
v1은 클러스터/서비스/태스크를 한 페이지에서 통합 조회했지만, **v2는 이를 3개의 독립된 인벤토리 라우트로 분리**합니다 — `/inventory/ecs_cluster`, `/inventory/ecs_service`, `/inventory/ecs_task`. 사이드바에서는 "컴퓨트" 그룹 아래 세 항목으로 함께 묶여 있을 뿐, 각각 별도 테이블/필터/상세 패널을 가진 별개 페이지입니다. 아래 내용은 v1의 통합 페이지가 아니라 이 3-라우트 구조를 기준으로 작성되었습니다.
:::

<Screenshot src="/screenshots/compute/ecs.png" alt="ECS" />

## 주요 기능

### ECS Clusters (`/inventory/ecs_cluster`)
하이라이트 카드는 전용 KPI 밴드를 보여줍니다 — ACTIVE 클러스터 수, 실행 태스크 합계, 활성 서비스 합계, 컨테이너 인스턴스 합계 — 그리고 실행 중 태스크 수 기준 Top-N 바 차트를 함께 표시합니다.

테이블 컬럼:
| 컬럼 | 설명 |
|------|------|
| Status | 상태 (ACTIVE, INACTIVE) |
| Running | 실행 중인 태스크 수 |
| Pending | 대기 중인 태스크 수 |
| Services | 활성 서비스 수 |
| Instances | 등록된 컨테이너 인스턴스 수 |
| MTD Cost ($) | 월간 누적 비용 |

상세 패널: Identity(Name, Account, Region, ARN) / Tasks & Services / Config(Settings, Container Insights 등) / Tags 섹션.

### ECS Services (`/inventory/ecs_service`)
하이라이트 카드는 Desired/Running/Pending 합계와 클러스터 distinct 수를 보여줍니다.

테이블 컬럼:
| 컬럼 | 설명 |
|------|------|
| Service | 서비스 이름 |
| Status | 상태 (ACTIVE, DRAINING) |
| Desired | 원하는 태스크 수 |
| Running | 실행 중인 태스크 수 |
| Pending | 대기 중인 태스크 수 |
| Launch | 실행 타입 (FARGATE, EC2) |
| Strategy | 스케줄링 전략 |
| Cluster | 소속 클러스터 |
| Task def | 태스크 정의 |
| Created | 생성일 |

### ECS Tasks (`/inventory/ecs_task`)
하이라이트 카드는 RUNNING 수, Fargate 태스크 수, 일일 비용 합(추정치), 클러스터 distinct 수를 보여줍니다. 비용은 태스크 정의의 cpu/memory로 계산한 정적 추정치이며 자세한 계산 방식은 [ECS Container Cost](../compute/ecs-container-cost)를 참고하세요.

테이블 컬럼: Task, Cluster, Group, Status, Launch, CPU, Memory, Cost/Day, Cost/Mo, AZ, Started.

## 사용 방법

1. 사이드바에서 **Compute > ECS Clusters / Services / Tasks** 중 원하는 라우트를 클릭합니다
2. 상단 하이라이트 카드에서 해당 리소스의 전체 현황을 파악합니다
3. Services 페이지에서 Desired vs Running을 비교하고, Clusters 페이지에서 클러스터별 상태를 확인합니다
4. 행을 클릭하여 상세 패널에서 세부 설정을 확인합니다

## Fargate vs EC2 Launch Type

| 구분 | Fargate | EC2 |
|------|---------|-----|
| 인프라 관리 | 서버리스 (AWS 관리) | 직접 관리 필요 |
| 비용 | vCPU/Memory 기반 | EC2 인스턴스 비용 |
| 스케일링 | 자동 | Auto Scaling 설정 필요 |
| 비용 분석 | ECS Tasks 뷰의 Cost/Day, Cost/Mo 컬럼(정적 추정치) | 미지원 |

## 사용 팁

:::tip 서비스 상태 확인
Services 테이블에서 Running이 Desired보다 적으면 태스크 배포에 문제가 있을 수 있습니다. 태스크 실패 원인을 확인하세요.
:::

:::tip Pending Tasks 모니터링
Pending Tasks가 오래 유지되면 리소스 부족이나 스케줄링 문제를 의심해 볼 수 있습니다.
:::

:::info AI 분석
AI Assistant에서 "ECS 클러스터 목록", "Fargate 서비스 보여줘", "태스크 배포 실패 원인 분석해줘" 등으로 분석할 수 있습니다.
:::

## 관련 페이지

- [ECR](../compute/ecr) - 컨테이너 이미지 레지스트리
- [ECS Container Cost](../compute/ecs-container-cost) - ECS 태스크 비용 분석
- [VPC](../network/vpc) - ECS 네트워크 구성
