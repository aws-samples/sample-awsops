---
sidebar_position: 5
title: EKS Overview
description: EKS 클러스터 현황, 노드 리소스, Pod 상태 요약
---

import Screenshot from '@site/src/components/Screenshot';

# EKS Overview

EKS 클러스터의 전체 현황과 노드 리소스, Pod 상태를 한눈에 확인할 수 있는 페이지입니다.

<Screenshot src="/screenshots/compute/eks.png" alt="EKS Overview" />

## 주요 기능

### 클러스터 필터
- EKS 클러스터별 필터링
- VPC별 필터링
- 다중 선택 지원

### EKS 클러스터 카드
각 클러스터의 핵심 정보를 카드 형태로 표시:
- Cluster Name, Status (ACTIVE)
- Kubernetes Version, Account, VPC ID, Platform Version, Region
- **Access Entry 상태 배지**: K8s Connected (초록) / 미등록 (빨강)
- **클러스터 등록 버튼(관리자)**: 기존 Access Entry 확인 후 조회 등록, ServiceAccount 토큰, 또는 명시적 AssumeRole 인증을 지원합니다. AWSops는 등록 정보만 저장하며 AWS 역할·Access Entry·정책을 생성하지 않습니다.
- **클릭 필터링**: 클러스터 카드를 클릭하면 해당 클러스터만 필터링 (시안 테두리)

:::tip 클러스터 접근 권한
등록된 클러스터의 라이브 데이터를 읽지 못하면 실패 원인과 이 가이드 링크가 표시됩니다. 기본 조회 등록에는 대상 클러스터의 web 태스크 역할 Access Entry가 필요하고, 명시적 SA/AssumeRole 인증에는 해당 인증 주체의 Kubernetes 권한이 필요합니다. 409 안내 명령은 선택한 클러스터의 소유자가 실행해야 하며, 실행 후 조회 등록을 다시 누르세요.
:::

### 교차 계정 클러스터 연결

1. **Accounts**에서 대상 계정을 등록·활성화하고 조회할 리전을 설정합니다. 클러스터 메타데이터 조회에는 등록된 대상 계정의 읽기 전용 역할(기본 `AWSopsReadOnlyRole`)을 사용합니다.
2. 상단 계정·리전 필터에서 대상 범위를 선택합니다. 필터를 바꾸면 등록 작업 없이 목록과 집계가 갱신되며, 카드의 **Account**와 **Region**으로 동명 클러스터를 구분합니다.
3. 기본 **Access Entry 조회 등록**을 사용할 때는 클러스터 소유자가 대상 클러스터에 **호스트 계정의 web 태스크 역할**을 `STANDARD` Access Entry로 등록하고 필요한 읽기 정책을 연결해야 합니다. 메타데이터를 읽는 대상 역할과 기본 Kubernetes 인증 역할은 별개입니다.
4. **조회 등록**을 누릅니다. 선택한 계정·리전에서 해당 클러스터를 직접 확인하며, 호스트 계정의 클러스터 목록으로 검증하지 않습니다. 등록과 상세 조회는 같은 계정·리전 식별자를 유지합니다.

**ServiceAccount 토큰**은 클러스터 안에서 허용한 읽기 전용 SA의 토큰으로 Kubernetes를 인증합니다. 이 경우 IAM Access Entry는 필요하지 않지만 대상 계정의 메타데이터 조회 설정은 여전히 필요합니다. **AssumeRole 인증**은 web 태스크가 AssumeRole할 수 있고 대상 클러스터의 Kubernetes 접근 권한을 가진 역할을 사용합니다. 기본 배포의 AssumeRole 권한은 `AWSopsReadOnlyRole`을 대상으로 하므로 다른 역할은 운영자가 별도로 허용해야 합니다. 두 방식 모두 클러스터 API에 대한 네트워크 연결이 필요합니다.

`make configure` → `eks.tf`는 **호스트 계정의 Terraform 온보딩 경로**입니다. 멤버 계정·기본 리전 외 클러스터는 소유자가 안내 명령을 실행한 뒤 수동으로 조회 등록합니다. 호스트 EventBridge 관찰자가 자동 등록해 줄 것으로 가정하지 마세요.

:::info 조회 범위와 실패 구분
전체 리전 탐색은 현재 설정된 리전과 이미 등록된 클러스터의 리전을 대상으로 하며, 모든 AWS 리전을 빠짐없이 탐색했다는 의미가 아닙니다. 부분 수집·조회 한도 안내가 있으면 범위를 좁혀 다시 확인하세요. `404`는 선택한 대상 클러스터를 찾지 못한 경우, `409`는 Access Entry가 없거나 확인할 수 없는 경우입니다. `503` 등 조회 실패를 클러스터가 없는 것으로 해석하지 마세요.
:::

### 통계 카드 (클릭 이동)
각 카드를 클릭하면 상세 페이지로 이동합니다:
- **Nodes** → 노드 상세 (`/eks/nodes`)
- **Pods** → Pod 상세 (`/eks/pods`)
- **Deployments** → 디플로이먼트 상세 (`/eks/deployments`)
- **Services** → 서비스 상세 (`/eks/services`)

### 노드 카드 그리드
각 노드의 리소스 사용량을 시각적으로 표시:
- 노드 이름, Pod 수, 상태 (Ready/NotReady)
- **CPU 사용량 바**: Pod 요청량 / 전체 용량 (퍼센트)
- **Memory 사용량 바**: Pod 요청량 / 전체 용량 (퍼센트)
- 80% 이상: 빨간색, 50% 이상: 주황색, 그 외: 시안/보라색

### 노드 상세 뷰
노드 카드를 클릭하면 상세 페이지로 이동:
- **CPU/Memory/Pod Info 카드**: Capacity, Allocatable, Requested, Available
- **ENI 목록**: 네트워크 인터페이스별 IP 할당 + 인스턴스 네트워크 트래픽 타일(In/Out 바이트·패킷 — 완결된 직전 1시간 버킷의 누적과 평균 rate; CloudWatch에 ENI별 차원이 없어 인스턴스 레벨로 표시)
- **Pods 테이블**: 해당 노드에서 실행 중인 Pod 목록

### 시각화 차트

- **Pod Status Distribution**: Running, Pending, Failed, Succeeded 분포 (파이 차트)
- **Pods per Namespace**: 네임스페이스별 Pod 수 (바 차트)

### Warning Events 테이블
Kubernetes Warning 이벤트를 실시간으로 표시:
- Kind, Object, Reason, Message, Count, Last Seen

## 사용 방법

1. 사이드바에서 **Compute > EKS**를 클릭합니다
2. 클러스터 카드를 클릭하여 특정 클러스터로 필터링합니다
3. 통계 카드를 클릭하면 Pods/Nodes/Deployments/Services 상세 페이지로 이동합니다
4. 노드 카드에서 리소스 사용률이 높은 노드를 식별합니다
5. 노드를 클릭하여 상세 리소스와 Pod 목록을 확인합니다
6. Warning Events에서 문제 이벤트를 모니터링합니다

## 사용 팁

:::tip 노드 리소스 모니터링
노드 카드의 CPU/Memory 바가 빨간색(80% 이상)이면 리소스 부족 위험이 있습니다. 노드 추가 또는 Pod 재배치를 검토하세요.
:::

:::tip ENI IP 사용량
노드 상세 뷰에서 ENI별 IP Slots Used가 15/15에 가까우면 새 Pod 스케줄링이 실패할 수 있습니다.
:::

:::info AI 분석
AI Assistant에서 "EKS 클러스터 상태", "노드별 CPU 사용량", "Warning 이벤트 분석해줘" 등으로 분석할 수 있습니다.
:::

## 관련 페이지

- [EKS 인증 설정](./eks-auth) - Access Entry / aws-auth 인증 가이드
- [EKS Explorer](./eks-explorer) - K9s 스타일 터미널 UI
- [EKS Pods](./eks-pods) - Pod 상세 목록
- [EKS Nodes](./eks-nodes) - 노드 상세 목록
- [EKS Deployments](./eks-deployments) - 디플로이먼트 목록
- [EKS Services](./eks-services) - 서비스 목록
- [EKS Container Cost](./eks-container-cost) - Pod 비용 분석 (OpenCost)
