---
sidebar_position: 4
title: Topology
description: React Flow 기반 AWS 인프라 및 Kubernetes 클러스터 시각화
---

import Screenshot from '@site/src/components/Screenshot';

# Topology

AWS 인프라와 Kubernetes 클러스터의 관계를 시각적으로 탐색하는 페이지입니다.

<Screenshot src="/screenshots/network/topology.png" alt="Topology" />

## 주요 기능

### 뷰 전환

상단에서 네 가지 탭을 선택합니다:

| 뷰 | 대상 | 용도 |
|----|------|------|
| **VPC 연결** | VPC 연결 구성 | TGW·피어링 연결 조회 |
| **배치 그래프 (기본)** | 저장된 AWS 리소스 | VPC·서브넷별 필터와 페이지 탐색 |
| **인프라 맵** | 저장된 AWS 리소스 | 리소스 계층 보기 |
| **K8s 맵** | EKS 워크로드 | Pod·Service·Ingress·Node 관계 |

### Infrastructure 뷰

두 가지 표시 모드를 제공합니다:

**Map View**
- 5컬럼 레이아웃으로 리소스 계층 표시
- External (IGW/TGW) → VPCs → Subnets → Compute → NAT
- 클릭/검색으로 관련 리소스 하이라이트

**Graph View**
- **배치 그래프**가 기본 탭이며, 저장된 리소스가 가장 많은 VPC부터 표시합니다.
- VPC·서브넷·리소스 종류로 필터링합니다. 자동 VPC 선택 상태에서 검색하면 전체 VPC에서 찾으며, 직접 고른 VPC 범위는 유지합니다. 범위가 바뀌면 유효하지 않은 서브넷·종류 필터는 해제됩니다.
- 페이지당 리소스는 최대 4개, 좁은 화면에서는 1개입니다. 연결 대상이 많으면 리소스 수를 줄이고 캔버스 높이를 늘립니다. 이전/다음 버튼으로 나머지 리소스를 확인하세요.
- 보안 그룹 연결은 기본적으로 숨기며 체크박스로 표시합니다. 각 페이지는 해당 리소스의 원본 배치 연결을 유지합니다.
- 표시 리소스 수의 분모는 현재 필터에 맞는 리소스 수입니다. 저장된 전체 노드·엣지 수와 수집 경고는 별도로 표시하며, 배치 연결은 실제 통신 경로를 증명하지 않습니다.

### 수집 근거와 조회 상태

인프라 관계 그래프와 개별 리소스의 관계 그래프는 표시된 노드와 별도로 수집 근거를 보여 줍니다.

- 원본 수집·최근 성공 시각과 저장된 그래프의 시각을 구분합니다. 이전 결과 보존, 불완전한 수집 범위와 잘림도 표시하며, 현재 AWS 상태를 증명하지는 않습니다.
- 수집 상태가 아직 기록되지 않았다는 안내는 중립적인 정보입니다. 빈 화면만으로 리소스가 없다고 판단하지 말고 수집 상태를 확인하세요.
- **새로고침**은 저장된 그래프를 다시 조회합니다. 새 수집이나 그래프 재생성을 시작하지 않습니다.
- 그래프 조회 불가는 조회 실패이며 수집 결과와 구분됩니다. 사용 가능한 경우 새로고침으로 다시 조회하세요. 세션이 만료되면 **로그인** 안내를 따르세요. 접근 거부와 요청 거절도 별도로 표시됩니다.
- 응답 건수나 탐색 범위 상한으로 생긴 잘림은 노드가 없는 경우에도 표시됩니다. 표시 범위 밖의 리소스나 연결이 없다는 뜻은 아닙니다.


### Kubernetes 뷰

4컬럼 리소스 맵으로 EKS 워크로드를 표시합니다:

| 컬럼 | 리소스 | 설명 |
|------|--------|------|
| **Ingress** | K8s Ingress | 외부 트래픽 진입점 |
| **Services** | K8s Service | 로드밸런싱, ClusterIP/NodePort/LoadBalancer |
| **Pods** | K8s Pod | 실행 중인 컨테이너 |
| **Nodes** | EKS Node | 워커 노드 (EC2) |

### 상호작용 기능

**검색**
- Infrastructure: EC2, Subnet, VPC 이름/ID/CIDR 검색
- Kubernetes: Pod, Service, Namespace 검색
- 매칭된 리소스와 연관 리소스 자동 하이라이트

**클릭 선택**
- 리소스 클릭으로 선택
- 선택된 리소스와 연결된 모든 리소스 하이라이트
- 다시 클릭하면 선택 해제

**Graph View 전용**
- 마우스 휠: 줌 인/아웃
- 드래그: 캔버스 이동
- 노드 드래그: 노드 위치 조정
- Controls: 줌 리셋, 화면 맞춤

## 사용 방법

### 인프라 구조 파악

1. **Infrastructure** 뷰 선택
2. **Map View**로 계층 구조 확인
3. VPC → Subnet → EC2 흐름 파악
4. IGW/TGW로 외부 연결 확인

### 특정 리소스 추적

1. 검색창에 리소스 이름/ID 입력
2. 매칭된 리소스 하이라이트 확인
3. 연관된 VPC, Subnet도 함께 하이라이트
4. "Clear search" 버튼으로 초기화

### K8s 트래픽 흐름 분석

1. **Kubernetes** 뷰 선택
2. Ingress → Service → Pod → Node 흐름 확인
3. Service 클릭으로 연결된 Pod 확인
4. 검색으로 특정 워크로드 추적

### Graph View 활용

1. **배치 그래프** 탭에서 VPC·서브넷·리소스 종류를 지정합니다. VPC가 확인되지 않은 리소스도 보려면 **전체 VPC**를 선택합니다.
2. 검색어를 입력하고 **이전 리소스**/**다음 리소스**로 페이지를 이동합니다.
3. 필요하면 **보안 그룹 연결 표시**를 켭니다. 연결이 많으면 페이지 크기와 캔버스 높이가 자동 조절됩니다.
4. 줌/팬과 페이지 스크롤로 연결을 확인하고, 현재 범위와 수집 상태를 함께 검토합니다.

## 사용 팁

:::tip 네트워크 경로 추적
특정 EC2에서 외부 인터넷까지의 경로를 추적하려면:
1. 검색창에 EC2 이름 입력
2. 하이라이트된 Subnet 확인
3. Subnet이 NAT Gateway 또는 IGW에 연결되어 있는지 확인
4. Private Subnet이면 NAT, Public Subnet이면 IGW 경로
:::

:::tip K8s Service 디버깅
"Service에 Pod가 연결되지 않음" 문제 해결:
1. Kubernetes 뷰에서 Service 클릭
2. 연결된 Pod 확인 (0 pods면 문제)
3. Pod의 labels와 Service의 selector 일치 여부 확인
4. Pod가 있으면 Node까지 추적하여 리소스 상태 확인
:::

:::info 색상 범례
| 색상 | Infrastructure | Kubernetes |
|------|---------------|------------|
| Cyan | VPC, IGW | Ingress |
| Green | Subnet | Node |
| Purple | EC2 | Pod |
| Pink | ELB | - |
| Orange | RDS, NAT | Service |
| Red | TGW | - |

맵 상단 정보 줄의 범례 칩은 현재 그래프에 존재하는 종류만 표시합니다. 카드 이름 옆의 상태 점(dot)도 범례로 표시됩니다 — **ok**(초록) / **warn**(주황) / **bad**(빨강) / **neutral**(회색).
:::

## 관련 페이지

- [VPC](../network/vpc) - VPC 상세 정보 및 리소스 맵
- [EKS Overview](../compute/eks) - EKS 클러스터 상세
- [EC2](../compute/ec2) - EC2 인스턴스 상세 정보
