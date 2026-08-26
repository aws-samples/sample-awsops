---
sidebar_position: 2
title: 화면 구성과 테마
description: 사이드바 내비게이션, 명령 팔레트(Cmd-K), 테마, 모바일 레이아웃
---

import Screenshot from '@site/src/components/Screenshot';

# 화면 구성과 테마

사이드바 내비게이션, 명령 팔레트, 테마, 모바일 레이아웃 등 AWSops의 화면 구성을 익힐 수 있는 페이지입니다.

<Screenshot src="/screenshots/getting-started/command-palette.png" alt="명령 팔레트 (Cmd-K)" />

## 주요 기능

### 왼쪽 사이드바

화면 왼쪽의 고정 영역으로, 모든 페이지로 이동하는 기본 내비게이션입니다.

- **헤더**: **AWSops** 마크와 **한/EN** 언어 전환 토글
- **상단 고정 메뉴**: **개요(Overview)**, **AI 진단**, **어시스턴트(Assistant)**, **작업(Jobs)**, **비용(Cost)**, **Bedrock**, **토폴로지(Topology)**, **보안(Security)**, **컴플라이언스(Compliance)**, **연동(Integrations)**. **커스텀 에이전트**는 사이드바에 직접 노출되지 않고 **연동 > Agents & Skills** 탭의 링크로 들어갑니다.
- **리소스 인벤토리 그룹**: 그 아래로 **Compute**(EKS, EC2, Lambda, ECS Clusters, ECS Tasks, ECR), **Storage & DB**, **Network**, **Security**, **Monitoring** 그룹이 이어집니다
- **푸터**: 로그인한 사용자 정보와 **로그아웃(Sign out)**, 리전/연결 상태, 그리고 테마 선택기
- 현재 보고 있는 페이지는 하이라이트로 표시됩니다

### 명령 팔레트 (Cmd-K)

키보드만으로 어디든 빠르게 이동하는 검색창입니다.

- **Cmd-K**(macOS) 또는 **Ctrl-K**(Windows/Linux)로 어느 페이지에서나 엽니다
- 페이지 이름, 리소스 종류, 경로 일부를 입력해 필터링합니다
- **위/아래 화살표**로 항목을 이동하고 **Enter**로 실행, **Esc**로 닫습니다
- 페이지 이동뿐 아니라 **Theme: Cobalt / Teal / Dark** 항목으로 테마도 바로 전환할 수 있습니다

### 테마

오른쪽 아래(사이드바 푸터)의 3종 테마 선택기에서 화면 색상을 고릅니다.

| 테마 | 설명 |
|------|------|
| **Cobalt** | 기본값. 밝은 코발트 계열 |
| **Teal** | 밝은 틸 계열 |
| **Dark** | 어두운 다크 모드 |

- 선택한 테마는 브라우저에 저장되어 새로고침 후에도 유지됩니다
- 차트와 **AWSops** 마크 색상도 선택한 테마에 맞춰 함께 바뀝니다

<Screenshot src="/screenshots/getting-started/theme-dark.png" alt="Dark 테마" />

### 모바일 레이아웃

화면 폭이 좁아지면(1024px 미만) 자동으로 모바일 레이아웃으로 전환됩니다.

- **상단 바**: 햄버거 메뉴, 페이지 제목, 검색(명령 팔레트) 아이콘
- **하단 탭 바**: **Overview · Cost · Inventory · Assistant · More**의 5개 탭
- **More** 탭이나 햄버거를 누르면 전체 메뉴가 담긴 **슬라이드 드로어**가 열립니다

<Screenshot src="/screenshots/getting-started/mobile.png" alt="모바일 레이아웃" />

## 사용 방법

1. 데스크톱에서는 **왼쪽 사이드바**의 메뉴를 클릭해 원하는 페이지로 이동합니다.
2. **Cmd-K**(또는 **Ctrl-K**)를 눌러 명령 팔레트를 열고, 페이지 이름을 입력한 뒤 **Enter**로 이동합니다.
3. 사이드바 푸터의 테마 선택기에서 **Cobalt / Teal / Dark** 중 하나를 클릭합니다.
4. 모바일에서는 하단 탭으로 주요 페이지를 오가고, **More**로 나머지 메뉴를 엽니다.
5. 어느 페이지에서나 떠 있는 **AI 어시스턴트 플로팅 버튼**으로 채팅 창을 열 수 있습니다.

:::tip 가장 빠른 이동
페이지가 많을 때는 사이드바를 훑기보다 **Cmd-K**로 이름 일부만 입력하는 편이 빠릅니다. 팔레트에서 `Theme:`를 입력하면 테마도 즉시 바꿀 수 있습니다.
:::

:::info 표시 시각 안내
앱에 표시되는 모든 시각은 **KST(Asia/Seoul)** 기준입니다.
:::

## 관련 페이지

- [대시보드](../overview/dashboard) - 전체 리소스 요약과 시작 지점
