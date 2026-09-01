---
sidebar_position: 4
title: ECR
description: ECR 리포지토리, 이미지, 취약점 스캔 정보
---

import Screenshot from '@site/src/components/Screenshot';

# ECR (Elastic Container Registry)

ECR 리포지토리와 이미지 정보를 확인할 수 있는 페이지입니다.

:::info v2 조회 방식
이 화면은 별도의 전용 페이지가 아니라 v2의 공용 인벤토리 뷰(`/inventory/ecr`, 사이드바 "컴퓨트" 그룹)를 통해 제공됩니다. 아래 내용은 v1의 전용 ECR 페이지가 아니라 v2 인벤토리 뷰의 실제 구성(`web/lib/inventory-types.ts`의 `HIGHLIGHTS.ecr`/`INVENTORY_TYPES.ecr`)을 기준으로 작성되었습니다.
:::

<Screenshot src="/screenshots/compute/ecr.png" alt="ECR" />

## 주요 기능

### 하이라이트 카드
- **Scan on Push**: 이미지 푸시 시 자동 스캔이 활성화된 리포지토리 수
- **태그 불변**: 태그 불변성(IMMUTABLE)이 설정된 리포지토리 수
- **태그 변경 가능**: 태그 변경 가능(MUTABLE)이 설정된 리포지토리 수

전체 리포지토리 수 카드는 따로 없습니다(테이블 행 수로 확인).

### 리포지토리 테이블
| 컬럼 | 설명 |
|------|------|
| URI | 리포지토리 URI (이미지 푸시/풀 주소) |
| Tag mutability | 태그 변경 가능 여부 (MUTABLE/IMMUTABLE) |
| Scan on Push (Basic) | 리포지토리 수준 기본 스캔 설정 (Yes/No) |
| Created | 생성일 |

Encryption 타입은 **테이블 컬럼이 아닙니다** — 아래 상세 패널로 확인합니다. Scan on Push (Basic) 컬럼은 리포지토리 수준 기본 스캔 설정이며, 레지스트리 수준 Inspector 확장 스캔은 반영하지 않습니다.

### 상세 패널
리포지토리를 클릭하면 상세 정보를 확인할 수 있습니다:
- **Identity 섹션**: Name, Account, Region, ARN, Registry ID, URI, Created
- **Config 섹션**: Tag Mutability, Image Scanning Configuration(Scan on Push 포함), Lifecycle Policy
- **Security 섹션**: Encryption Configuration (AES256/KMS)
- **Tags 섹션**: 리포지토리에 설정된 태그

## 사용 방법

1. 사이드바에서 **Compute > ECR**을 클릭합니다
2. 상단 하이라이트 카드에서 Scan on Push / 태그 불변 현황을 파악합니다
3. 리포지토리를 클릭하여 상세 URI, Scan on Push, Encryption 설정을 확인합니다

## 보안 설정 가이드

### Scan on Push
- **권장**: 모든 리포지토리에서 활성화
- 이미지 푸시 시 자동으로 취약점 스캔 실행
- 발견된 CVE는 Security 페이지에서 확인 가능

### Immutable Tags
- **권장**: 프로덕션 리포지토리에서 활성화
- 한번 푸시된 태그는 덮어쓸 수 없음
- 배포 추적과 롤백에 유리

### Encryption
- **AES256**: 기본 AWS 관리형 암호화
- **KMS**: 고객 관리형 키 (CMK) 사용 시

## 사용 팁

:::tip Scan on Push 활성화
상단 하이라이트 카드의 Scan on Push 수가 전체 리포지토리 수보다 적다면 일부 리포지토리에서 스캔이 비활성화되어 있다는 뜻입니다. 리포지토리 상세 패널의 Config 섹션에서 개별로 확인할 수 있습니다.
:::

:::tip 이미지 URI 복사
상세 패널의 URI 필드에서 `docker pull` 또는 `docker push`에 사용할 전체 주소를 확인할 수 있습니다.
:::

:::info AI 분석
AI Assistant에서 "ECR 리포지토리 목록", "스캔 비활성화된 리포지토리 찾아줘", "컨테이너 이미지 취약점 분석해줘" 등으로 분석할 수 있습니다.
:::

## 관련 페이지

- [ECS](../compute/ecs) - ECR 이미지를 사용하는 ECS 서비스
- [EKS](../compute/eks) - ECR 이미지를 사용하는 EKS 클러스터
- [Security](../security) - 이미지 취약점 (CVE) 확인
