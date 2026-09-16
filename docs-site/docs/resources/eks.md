---
sidebar_position: 2
title: EKS / Kubernetes
description: EKS 클러스터 함대와 인-클러스터 리소스를 읽기 전용으로 조회
---

import Screenshot from '@site/src/components/Screenshot';

# EKS / Kubernetes

EKS 클러스터 함대와 클러스터 내부 리소스를 읽기 전용으로 한눈에 조회할 수 있는 페이지입니다.

<Screenshot src="/screenshots/resources/eks.png" alt="EKS 클러스터 함대" />

:::info 계정·리전 범위
상단 필터는 EKS 목록과 리소스 조회에 적용됩니다. 부분 수집·조회 실패·한도 안내가 있으면 표시된 숫자는 확인된 결과이며 전체 부재를 뜻하지 않습니다. 전체 리전 탐색은 설정된 리전과 이미 등록된 클러스터의 리전으로 제한됨을 안내합니다.
:::

## 주요 기능

### KPI 카드
함대 전체의 핵심 지표를 상단 카드로 보여줍니다.

| 카드 | 의미 |
|------|------|
| **Clusters** | 선택한 계정·리전 범위에서 발견된 클러스터 수(부분 수집 안내 확인) |
| **Connected** | 현재 표시 범위에서 라이브 리소스 조회에 성공한 클러스터 수(설정 상태 배지와 구분) |
| **Nodes** | 연결된 클러스터의 노드 합계 (`ready` 수 표시) |
| **Pods** | Pod 합계 (`running` 수 표시) |
| **Deployments** | Deployment 합계 |
| **Services** | Service 합계 |

### 클러스터 카드
클러스터마다 카드 한 장으로 **Status**, **Version**, **Account**, **Region**, **VPC**, **Platform** 정보를 표시합니다. 연결 상태는 배지로 구분됩니다.

- **Connected**: 기본 Access Entry 경로 또는 저장된 인증 정보로 조회가 설정된 상태입니다. 배지 자체는 인증 정보의 유효성이나 네트워크 도달성을 보장하지 않습니다. 노드/Pod/Deployment 개수는 라이브 조회가 성공했을 때 표시됩니다(카드 제목으로 상세 이동).
- **Entry 있음**: Access Entry는 있으나 아직 조회 등록되지 않음
- **미연결**: 기본 Access Entry 연결이 없고 저장된 SA 토큰·AssumeRole 인증 설정도 없음
- **확인 불가**: 접근 상태를 판별하지 못함

등록·활성화된 멤버 계정도 조회할 수 있습니다. 기본 인증 주체는 호스트 클러스터의 **web 태스크 역할** 또는 멤버 클러스터의 **등록된 멤버 읽기 역할**(일반적으로 `AWSopsReadOnlyRole`)입니다. 멤버에서는 메타데이터 조회와 Kubernetes 토큰 서명에 모두 멤버 역할 자격증명을 사용하며, 해당 역할의 EKS Access Entry와 읽기 정책이 필요합니다. 기존 호스트 역할 Entry만으로는 허용되지 않습니다. 명시적 **SA 토큰 / AssumeRole** 인증도 지원합니다. SA 인증에는 IAM Access Entry가 필요하지 않지만 메타데이터 조회 권한은 여전히 필요합니다. AssumeRole은 web 태스크가 사용할 수 있고 클러스터에서 읽기 권한이 있어야 하며, 멤버 클러스터의 역할 ARN은 같은 멤버 계정에 속해야 합니다. 관리자는 조회를 **등록/해제**하거나 소유자가 적용할 **온보딩 스크립트**를 확인할 수 있습니다. AWSops는 클러스터를 변경하지 않으며 조회는 읽기 전용입니다.

### 함대 리소스 요약
연결된 클러스터가 있으면 카드 아래에 추가 시각화가 나타납니다.

- **노드 리소스**: 노드별 **CPU / Mem / Disk** 사용량 미터 (Pod 요청 합계 대비 노드 allocatable 기준)
- **Pod Status / Instance Types / Pods per Namespace** 차트
- **Warning Events** 테이블 (최근 클러스터 경고를 최신순으로 표시)

### 클러스터 상세
클러스터 카드를 클릭하면 상세 화면(`/eks/<cluster>`)으로 이동합니다. **Nodes / Pods / Deployments / Services / Events / Diagnosis** 탭을 제공하며, 검색창과 네임스페이스 필터로 좁혀 볼 수 있습니다. 행을 클릭하면 상세 패널이 열립니다.

<Screenshot src="/screenshots/resources/eks-cluster.png" alt="클러스터 상세 (Nodes 탭 + OpenCost)" />

- **OpenCost 패널**: 설치 상태를 감지하고, 사용자가 자신의 클러스터에 직접 적용할 수 있도록 **values.yaml** / **install.sh** 다운로드를 제공합니다 (읽기 전용 — AWSops가 클러스터에 쓰지 않습니다). 관리자는 차트 버전·values override를 저장할 수 있습니다.
- **Diagnosis 탭**: K8sGPT 기반 진단으로, 활성화 시에도 읽기 전용입니다. 결정론적 분석 결과(FACT)와 AI 가설을 분리해 보여주며, AI 가설은 검증 후 조치해야 합니다.

## 사용 방법
1. 사이드바 **Compute** 그룹에서 **EKS**를 클릭합니다
2. 상단 KPI 카드로 함대 규모와 연결 상태를 확인합니다
3. **Connected** 클러스터 카드 제목을 클릭해 상세로 들어갑니다
4. 상세에서 탭을 전환해 **Nodes / Pods / Deployments / Services / Events / Diagnosis** 를 조회합니다
5. 검색창에 키워드를 입력하거나 네임스페이스 필터로 범위를 좁힙니다
6. 행을 클릭해 상세 패널에서 전체 속성을 확인합니다
7. 필요하면 **OpenCost 패널**에서 **values.yaml** / **install.sh** 를 내려받아 직접 설치합니다

:::tip 빠른 검색
검색창에는 이름 일부만 입력해도 됩니다. 네임스페이스 필터는 **Pods / Deployments / Services** 탭에서 함께 사용할 수 있습니다.
:::

:::info 연결 조건
기본 인증에는 호스트의 web 태스크 역할 또는 멤버 계정의 등록된 읽기 역할에 대한 EKS Access Entry가 필요하며, 명시적 SA 토큰·AssumeRole 인증도 지원합니다. 실제 조회 성공 여부와 부분 수집 안내를 함께 확인하세요. 미연결 클러스터는 온보딩 스크립트가 함께 제공되며, 등록/해제는 관리자만 수행할 수 있습니다. 표시되는 시각은 KST(Asia/Seoul) 기준입니다.
:::

## AI 분석 팁
플로팅 버튼(ChatDrawer)이나 **Assistant** 페이지에서 다음과 같이 질문해 보세요.

- "재시작 횟수가 많은 Pod를 찾아줘"
- "CPU 요청률이 가장 높은 노드는 어디야?"
- "최근 Warning 이벤트의 원인을 설명해줘"
- "Deployment 중 가용 레플리카가 부족한 것이 있어?"

## 관련 페이지
- [리소스 인벤토리](./inventory) - 계정 전체 리소스 인벤토리
- [토폴로지](./topology) - 리소스 연결 관계 시각화
