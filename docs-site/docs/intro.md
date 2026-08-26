---
sidebar_position: 1
title: AWSops 소개
description: AWS·Kubernetes 운영을 실시간으로 보고, 묻고, 진단하는 통합 대시보드
---

import Screenshot from '@site/src/components/Screenshot';

# AWSops 소개

AWSops는 AWS와 Kubernetes 운영 현황을 **실시간으로 보고, 자연어로 묻고, AI로 진단**할 수 있는 통합 운영 대시보드입니다. 리소스 인벤토리·비용·토폴로지·EKS를 한 화면에서 살펴보고, 궁금한 점은 AI 어시스턴트에게 물어보며, 계정 전반의 운영 상태는 AI 진단 리포트로 받아볼 수 있습니다.

<Screenshot src="/screenshots/overview/dashboard.png" alt="AWSops 대시보드" />

## 무엇을 할 수 있나요

- **한눈에 보는 대시보드** — 컴퓨트·스토리지·네트워크·보안·비용 KPI와 분포 차트를 메인 화면에 모아 봅니다.
- **AI 어시스턴트** — 운영 질문을 자연어로 묻고, 질문이 자동으로 적절한 도메인으로 라우팅된 답변을 마크다운으로 받습니다.
- **AI 진단** — 계정 운영 상태를 분석한 종합 리포트를 깊이별로 생성하고 MD·DOCX·PDF로 내보냅니다.
- **리소스 인벤토리** — EC2·Lambda·RDS·S3·VPC·IAM 등 20여 종의 리소스를 정렬·검색·상세 조회합니다.
- **토폴로지** — Route53 → CloudFront → LB → Target Group → 타깃으로 이어지는 요청 흐름을 그래프로 탐색합니다.
- **EKS / Kubernetes** — 클러스터 함대와 노드·파드·디플로이먼트를 읽기 전용으로 살펴봅니다.
- **비용 분석** — 서비스별 비용 분해와 추이, Bedrock 모델 사용량을 확인합니다.
- **데이터소스 탐색** — 연결된 관측성 데이터소스를 네이티브 쿼리 언어로 조회합니다.

:::info 읽기 전용 운영 대시보드
AWSops는 AWS 리소스를 **변경하지 않습니다.** 현황을 관찰하고 분석·진단하는 데 집중하며, 설치나 변경이 필요한 작업(예: OpenCost)은 사용자가 직접 실행할 수 있도록 안내·스크립트를 제공합니다.
:::

## 다음 단계

- [로그인](./getting-started/login) — 대시보드 접속 방법
- [화면 구성과 테마](./getting-started/navigation) — 사이드바·명령 팔레트·테마·모바일
- [대시보드](./overview/dashboard) — 메인 화면 살펴보기
- [AI 어시스턴트](./overview/assistant) — 자연어로 질문하기
- [AI 진단](./operations/ai-diagnosis) — 종합 진단 리포트 만들기
