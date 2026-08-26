---
sidebar_position: 2
title: EKS / Kubernetes
description: EKS 클러스터 함대와 인-클러스터 리소스를 읽기 전용으로 조회
---

import Screenshot from '@site/src/components/Screenshot';

# EKS / Kubernetes

EKS 클러스터 함대와 클러스터 내부 리소스를 읽기 전용으로 한눈에 조회할 수 있는 페이지입니다.

<Screenshot src="/screenshots/resources/eks.png" alt="EKS 클러스터 함대" />

## 주요 기능

### KPI 카드
함대 전체의 핵심 지표를 상단 카드로 보여줍니다.

| 카드 | 의미 |
|------|------|
| **Clusters** | 계정에서 발견된 전체 클러스터 수 |
| **Connected** | 조회가 연결된(데이터 수집 가능) 클러스터 수 |
| **Nodes** | 연결된 클러스터의 노드 합계 (`ready` 수 표시) |
| **Pods** | Pod 합계 (`running` 수 표시) |
| **Deployments** | Deployment 합계 |
| **Services** | Service 합계 |

### 클러스터 카드
클러스터마다 카드 한 장으로 **Status**, **Version**, **Region**, **VPC**, **Platform** 정보를 표시합니다. 연결 상태는 배지로 구분됩니다.

- **Connected**: 조회가 연결되어 노드/Pod/Deployment 개수까지 표시됩니다 (카드 제목 클릭 시 상세로 이동)
- **Entry 있음**: Access Entry는 있으나 아직 조회 등록되지 않음
- **미연결**: Access Entry가 없어 조회 불가
- **확인 불가**: 접근 상태를 판별하지 못함

연결된 클러스터를 조회하려면 **EKS Access Entry**가 필요합니다. 관리자는 조회 접근을 **등록/해제**하거나, 직접 클러스터에 적용할 수 있는 **온보딩 스크립트**를 확인할 수 있습니다. AWSops는 클러스터를 변경하지 않으며 모든 동작은 읽기 전용입니다.

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
클러스터가 **Connected** 로 보이려면 **EKS Access Entry** 가 필요합니다. 미연결 클러스터는 온보딩 스크립트가 함께 제공되며, 등록/해제는 관리자만 수행할 수 있습니다. 표시되는 시각은 KST(Asia/Seoul) 기준입니다.
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
