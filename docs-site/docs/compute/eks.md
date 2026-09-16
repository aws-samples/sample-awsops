---
sidebar_position: 5
title: EKS Overview
description: 선택 범위의 EKS 클러스터 등록, 노드 리소스 및 Pod 상태
---

import Screenshot from '@site/src/components/Screenshot';

# EKS Overview

선택한 계정·리전 범위의 EKS 클러스터와 Kubernetes 리소스를 조회합니다. AWSops의 클라우드·클러스터 조회는 읽기 전용이며, 등록은 앱 설정만 저장합니다(ADR-005).

<Screenshot src="/screenshots/compute/eks.png" alt="EKS Overview" />

## 주요 기능

### 계정·리전·클러스터 필터

상단에서 계정과 리전을 선택한 뒤 클러스터 또는 VPC로 범위를 좁힙니다. 다중 선택을 지원하며, 필터를 바꾸면 다른 클러스터를 등록하지 않아도 목록과 집계가 갱신됩니다. 계정·리전을 포함한 식별자로 동명 클러스터를 구분합니다.

:::info 관측 범위
숫자와 차트는 선택 범위에서 실제 확인한 리소스를 나타냅니다. 부분 실패와 조회 한도를 안내하며, 관측하지 못한 리소스가 없다는 의미는 아닙니다. 전체 리전 탐색은 현재 설정된 리전과 등록 클러스터의 리전을 대상으로 하므로, 특정 리전을 조회하려면 범위를 좁히세요.
:::

### 클러스터 카드와 연결 상태

카드에는 Cluster Name, Status, Kubernetes Version, Account, Region, VPC ID, Platform Version을 표시합니다. Connected **배지**는 기본 Access Entry 경로나 저장된 인증 정보가 설정됐다는 뜻이며, 저장된 인증 정보의 유효성이나 도달성을 보장하지 않습니다. 개수는 라이브 조회 성공 후 표시됩니다. Connected **KPI**는 표시 범위에서 라이브 조회에 성공한 클러스터 수입니다.

### 교차 계정 조회 등록

1. **Accounts**에서 대상 계정을 등록·활성화하고 리전을 설정합니다. 신뢰 정책이 요구하면 external ID를 입력합니다. 일반적인 대상 역할은 `AWSopsReadOnlyRole`이며, web 태스크가 AssumeRole할 수 있고 EKS 메타데이터를 읽을 권한이 있어야 합니다.
2. 대상 계정과 리전을 선택합니다. **멤버 계정**에서는 메타데이터 조회와 기본 Kubernetes 토큰 서명에 모두 그 계정에 등록된 읽기 역할을 사용합니다. 호스트 계정 클러스터의 기본 인증은 web 태스크 역할을 유지합니다. 호스트 태스크 역할의 bearer 토큰을 멤버 클러스터에 보내지 않습니다.
3. 클러스터 소유자가 해당 클러스터에 사용할 역할의 `STANDARD` Access Entry와 필요한 읽기 정책(안내의 `AmazonEKSAdminViewPolicy` 등)을 설정합니다. 멤버 클러스터에서는 호스트 web 태스크 역할이 아니라 **등록된 멤버 역할**이 대상입니다. 기존 호스트 역할의 Access Entry만으로는 새로운 기본 멤버 인증을 허용하지 않습니다.
4. **조회 등록**을 누릅니다. 앱은 `DescribeCluster`로 선택한 클러스터를 직접 확인하고 해당 역할의 기존 Access Entry를 점검합니다. 호스트 클러스터 목록으로 검증하거나 AWS 리소스를 만들지 않습니다. 등록과 상세 이동에는 계정·리전 정보가 유지됩니다.

표시되는 온보딩 명령은 소유자가 실행하며 앱이 실행하지 않습니다. `make configure` → `eks.tf`는 호스트 계정의 Terraform 프로비저닝 경로입니다. 멤버 계정·기본 리전 외 클러스터는 소유자가 권한을 준비한 뒤 수동으로 조회 등록해야 하며, 호스트 EventBridge 관찰자가 멤버 등록을 자동 처리하지 않습니다.

### 명시적 인증 옵션

- **ServiceAccount 토큰**: 대상 클러스터 내부에서 허용된 읽기 전용 SA 인증을 사용합니다. Kubernetes 인증에 IAM Access Entry가 필요하지 않지만, 대상 계정의 메타데이터 조회 설정과 API 서버 연결은 여전히 필요합니다.
- **AssumeRole**: web 태스크가 AssumeRole할 수 있고 대상 Kubernetes API 접근이 허용된 역할을 사용합니다. 멤버 클러스터의 역할 ARN은 반드시 해당 멤버 계정 소속이어야 하며, 호스트·다른 계정 역할은 거부합니다. 필요하면 external ID를 입력합니다. 기본 배포는 `AWSopsReadOnlyRole`의 AssumeRole을 허용하므로 다른 역할은 운영자의 별도 권한 설정이 필요합니다.

### 등록 오류

`404`는 선택한 클러스터를 찾지 못한 경우입니다. `409`는 필요한 Access Entry가 없거나 확인할 수 없는 경우이며, `403`은 계정·리전 또는 역할이 허용되지 않은 경우일 수 있습니다. `503`은 조회나 저장소 사용 불가를 뜻합니다. 이를 성공적으로 조회한 빈 함대로 해석하지 마세요. 표시된 대상을 확인하고 해당 소유자에게 온보딩 안내를 전달하세요.

### 라이브 리소스와 상세 페이지

- **Nodes / Pods / Deployments / Services**에서 선택 범위의 리소스를 조회합니다.
- 노드 패널은 Capacity, Allocatable, 요청량과 Pod 정보를 보여줍니다. 요청 비율은 예약량이며 실제 CPU·메모리 사용률이 아닙니다.
- ENI 상세는 해당 범위의 EC2 인벤토리와 사용 가능한 인스턴스 단위 CloudWatch 트래픽을 표시합니다.
- Pod 상태·네임스페이스·인스턴스 타입 차트와 Warning Events는 관측한 데이터를 요약하며, 미도달 클러스터를 안내합니다.
- 연결된 카드 제목으로 상세 화면을 엽니다. OpenCost 상태·설정과 리소스 요청도 클러스터 식별자를 유지합니다.

:::tip 접근 권한과 데이터 가용성
설정된 배지만으로 토큰, 읽기 정책 또는 네트워크 경로의 유효성을 알 수 없습니다. 실제 라이브 조회 결과와 실패 안내를 확인하세요. 기본 멤버 인증에는 등록된 멤버 역할의 접근 권한이 필요하며, 호스트 역할의 클러스터 접근을 넓혀 해결하지 마세요.
:::

## 관련 페이지

- [EKS 인증 아카이브와 현재 안내](./eks-auth)
- [EKS Explorer](./eks-explorer)
- [EKS Nodes](./eks-nodes)
- [EKS Pods](./eks-pods)
- [EKS Deployments](./eks-deployments)
- [EKS Services](./eks-services)
- [EKS Container Cost](./eks-container-cost)
