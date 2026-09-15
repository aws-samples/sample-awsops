---
sidebar_position: 2
title: 커스텀 에이전트
description: AI 어시스턴트의 에이전트·스킬·연동·도구 구성을 관리하는 관리자 화면
---

import Screenshot from '@site/src/components/Screenshot';

# 커스텀 에이전트

AI 어시스턴트가 어떻게 동작할지 에이전트·스킬·연동·도구를 직접 구성할 수 있는 페이지입니다.

<Screenshot src="/screenshots/operations/custom-agents.png" alt="커스텀 에이전트 & 스킬" />

:::info 관리자 전용
이 페이지는 **관리자**만 접근할 수 있습니다(Cognito 관리자 그룹 또는 SSM 관리자 허용 목록). 권한이 없는 사용자에게는 접근 거부 화면이 표시됩니다.
:::

## 주요 기능

### New Agent (새 에이전트)
어시스턴트의 응답 방식을 정의하는 새 에이전트를 만듭니다.

- **name**: 에이전트 이름(kebab-case)
- **description**: 에이전트 설명
- **persona**: 시스템 프롬프트(에이전트의 말투·관점)
- **gateway**: 담당 영역 — **network**, **container**, **iac**, **data**, **security**, **monitoring**, **cost**, **ops**
- **routing keywords**: 질문을 이 에이전트로 보내는 라우팅 키워드(쉼표 구분)
- **agent type**: 역할 유형 — **generic**, **on_demand**, **triage**, **rca**, **mitigation**, **evaluation**

### New Skill (새 스킬)
여러 에이전트가 공유하는 재사용 가능한 스킬을 만듭니다.

- **name** / **description**: 스킬 이름과 설명
- **instructions**: 스킬 수행 지침
- **agent types (targeting)**: 이 스킬을 적용할 대상 에이전트 유형(체크박스 다중 선택)

### Agents / Skills 목록
- 새로 만든 에이전트·스킬은 **비활성(Disabled)** 상태로 시작하며, 목록에서 토글해 활성화합니다.
- 기본 제공 항목에는 **built-in** 라벨이 표시되며 토글 대상이 아닙니다.

### Integrations (advanced)
읽기 전용 관측성 데이터소스(**Prometheus**, **Loki**, **Tempo**, **Mimir**, **ClickHouse**)와 커넥터(**Notion** 등)는 이제 이 페이지가 아니라 **연동(Integrations) 허브**(`/integrations`)의 **데이터소스** / **커넥터** 탭에서 연결·자격 증명 등록·스키마 캐시를 관리합니다. 이 섹션에는 그 범주에 들지 않는 **커스텀 egress/ingress 연동**을 직접 등록하는 **Register integration**만 남아 있습니다.

### Agent Space
계정에서 활성화할 에이전트·스킬·연동과 **도구 허용 목록(tool allowlist)** 을 고른 뒤 저장합니다. 저장할 때마다 버전이 올라갑니다.

## 사용 방법
1. 사이드바 **연동**(`/integrations`) → **Agents & Skills** 탭의 링크로 이 페이지(`/customization`)에 들어갑니다(사이드바에 직접 노출되지 않음)
2. **New Agent**에서 name·description·persona를 입력하고 **gateway**·**agent type**을 선택한 뒤 라우팅 키워드를 적고 생성합니다
3. 필요하면 **New Skill**에서 스킬을 만들고 적용할 **agent types**를 선택합니다
4. 아래 **Agents** / **Skills** 목록에서 새 항목을 토글해 활성화합니다
5. 데이터소스·커넥터 연결은 사이드바 **연동**(`/integrations`)에서 진행합니다 — 이 페이지의 **Integrations (advanced)** 섹션은 그 범주 밖의 커스텀 연동 등록용입니다
6. **Agent Space**에서 활성화할 항목과 도구 허용 목록을 고르고 **Save Agent Space**로 저장합니다

:::tip 비활성으로 시작합니다
새로 만든 에이전트·스킬은 자동으로 활성화되지 않습니다. 목록에서 토글하고 **Agent Space**에 포함해 저장해야 어시스턴트에 반영됩니다.
:::

:::info 자격 증명은 다시 보이지 않습니다
연동 자격 증명은 저장 후 화면에 표시되지 않습니다. 변경하려면 값을 다시 입력해 **Update**하세요.
:::

## 관련 페이지
- [데이터소스 탐색](../observability/datasources) - 연동 허브에서 연결한 관측성 데이터소스 탐색
- [AI 어시스턴트](../overview/assistant) - 구성한 에이전트와 대화

## 정책 호환성과 배포

기본 라우팅/수집기 키(`security`, `aws-data` 등)는 커스텀 이름으로 사용할 수 없습니다(400). 기존 충돌 행은 보존되지만 라우팅에서 제외되므로 이름과 스킬 연결을 검토하세요. 게이트웨이 도구는 `target___tool` 식별자를 사용하며, 축약 이름은 해당 게이트웨이에서 유일하게 일치할 때만 허용됩니다. 저장된 cap의 미일치는 deny-all이 될 수 있습니다. cap은 선언된 도구를 줄이기만 하며, 외부 연동만 선언한 에이전트에 게이트웨이 도구를 추가하지 않습니다.

한 번 설정한 도구 제한은 스킬 내용을 비우거나 비활성화·분리해도 유지됩니다. 새 migration은 현재 연결(비활성 포함)을 backfill하며, API는 제한 이력을 초기화하지 않습니다. migration 전에 제거된 과거 제한은 복원할 수 없으므로 기존 구성을 검토하세요. 유지된 도구 제한이 없고 현재 cap·도구 연동도 없는 경우에만 기존 무제한 모드를 유지합니다.

`01M2K0BTQ4P4QHHFHR44ZK1YW6_agent_tool_policy_history.sql`을 검토된 별도 migration 경로로 적용한 뒤 Web을 배포하세요. 자동 Web migration은 이 ALTER/trigger를 거부합니다. 초기 커스텀 정책 조회 실패는 `/api/chat` 503이며, hybrid 모드의 명시적 기본 pin만 예외입니다(기본 hybrid=false에서는 예외 없음, 제품 도움말도 초기 실패 시 503). 초기 조회가 성공한 뒤 최종 enablement만 실패하면 custom pin은 호출 없이 사용 불가를 알리고, 자동 라우팅은 기본 경로와 저장되는 안내를 사용합니다. 제품 도움말은 이 최종 조회를 건너뜁니다. `/api/customization` GET 조회 실패도 503입니다.
