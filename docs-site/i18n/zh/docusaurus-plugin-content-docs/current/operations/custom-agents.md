---
sidebar_position: 2
title: 自定义代理
description: 管理 AI 助手的代理、技能、集成与工具配置的管理员界面
---

import Screenshot from '@site/src/components/Screenshot';

# 自定义代理

此页面可直接配置 AI 助手如何运作的代理、技能、集成与工具。

<Screenshot src="/screenshots/operations/custom-agents.png" alt="自定义代理 & 技能" />

:::info 仅限管理员
只有**管理员**才能访问此页面（Cognito 管理员组或 SSM 管理员允许列表）。无权限的用户将看到访问被拒绝的界面。
:::

## 主要功能

### New Agent（新建代理）
创建定义助手响应方式的新代理。

- **name**：代理名称（kebab-case）
- **description**：代理说明
- **persona**：系统提示词（代理的语气·视角）
- **gateway**：负责领域 — **network**、**container**、**iac**、**data**、**security**、**monitoring**、**cost**、**ops**
- **routing keywords**：将问题路由到此代理的路由关键词（逗号分隔）
- **agent type**：角色类型 — **generic**、**on_demand**、**triage**、**rca**、**mitigation**、**evaluation**

### New Skill（新建技能）
创建可供多个代理共享的可复用技能。

- **name** / **description**：技能名称与说明
- **instructions**：技能执行指令
- **agent types (targeting)**：应用此技能的目标代理类型（复选框多选）

### Agents / Skills 列表
- 新建的代理和技能以**禁用（Disabled）**状态开始，需在列表中切换开关来启用。
- 内置项目会显示 **built-in** 标签，不属于切换对象。

### Integrations (advanced)
只读可观测性数据源（**Prometheus**、**Loki**、**Tempo**、**Mimir**、**ClickHouse**）和连接器（**Notion** 等）现在不在此页面，而是在**集成（Integrations）中心**（`/integrations`）的**数据源** / **连接器**标签页中管理连接、凭证注册和 schema 缓存。此部分仅保留用于直接注册不属于上述范畴的**自定义 egress/ingress 集成**的 **Register integration**。

### Agent Space
选择要在账户中启用的代理、技能、集成以及**工具允许列表（tool allowlist）**后保存。每次保存版本号都会递增。

## 使用方法
1. 通过侧边栏**集成**（`/integrations`）→ **Agents & Skills** 标签页中的链接进入此页面（`/customization`）（不在侧边栏直接显示）
2. 在 **New Agent** 中输入 name、description、persona，选择 **gateway** 和 **agent type**，填写路由关键词后创建
3. 如有需要，在 **New Skill** 中创建技能并选择要应用的 **agent types**
4. 在下方 **Agents** / **Skills** 列表中切换新项目的开关以启用
5. 数据源和连接器的连接在侧边栏**集成**（`/integrations`）中进行 — 此页面的 **Integrations (advanced)** 部分用于注册该范畴之外的自定义集成
6. 在 **Agent Space** 中选择要启用的项目和工具允许列表，并通过 **Save Agent Space** 保存

:::tip 以禁用状态开始
新建的代理和技能不会自动启用。需要在列表中切换开关，并将其纳入 **Agent Space** 保存后才会反映到助手中。
:::

:::info 凭证不会再次显示
集成凭证保存后不会显示在界面上。如需变更，请重新输入值并 **Update**。
:::

## 相关页面
- [数据源浏览](../observability/datasources) - 浏览在集成中心连接的可观测性数据源
- [AI 助手](../overview/assistant) - 与配置好的代理对话
