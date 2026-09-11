---
sidebar_position: 1
title: 数据源探索
description: 使用原生查询语言只读查询已连接的可观测性数据源
---

import Screenshot from '@site/src/components/Screenshot';

# 数据源探索

本页面可使用各数据源的原生查询语言，对已连接的可观测性数据源进行只读查询。

<Screenshot src="/screenshots/observability/datasources.png" alt="集成中心 — 数据源标签页" />

## 主要功能

### 支持的数据源与查询语言
使用与数据源类型匹配的原生语言直接查询已连接的数据源。所有查询均为**只读**。

| 数据源 | 查询语言 | 示例 |
|-----------|----------|------|
| **Prometheus** | **PromQL** | `rate(node_cpu_seconds_total[5m])` |
| **Mimir** | **PromQL** | `up` |
| **Loki** | **LogQL** | `{job="varlogs"} \|= "error"` |
| **Tempo** | **TraceQL** | `{ duration > 500ms }` |
| **ClickHouse** | **SQL**（只读） | `SELECT count() FROM system.tables` |

### 选择数据源
- 在下拉菜单中选择要查询的数据源。每个条目会同时显示 **slug** 和**类型（kind）**。
- 已预先采集 schema 的数据源会带有 **schema 已缓存**标记。该缓存可帮助 **AI 生成**功能使用真实的名称。

### 时间范围（range）开关
- 选择 **Prometheus**、**Mimir**、**Loki** 等支持范围查询的类型时，会出现**时间范围 (range)** 复选框。
- 关闭时为单一时间点（instant）查询，开启时为时间序列（range）查询。

### 结果展示
- 时间序列（matrix/range）结果会绘制为**时间序列面积图**。
- 单一时间点、日志、跟踪、SQL 结果以可排序的**表格**显示。
- 结果达到上限时会明确显示**结果已截断**警告，无数据时会显示**无结果**提示。

### 用 AI 生成查询
- 用自然语言描述所需内容并点击 **AI 生成**，系统会参考缓存的 schema 将其转换为对应语言的查询并填入输入框。
- 生成的查询**不会自动执行。** 需要检查后手动点击**执行**才会进行查询。

## 使用方法
1. 在侧边栏点击**集成**，然后在**数据源**标签页中打开要查询的数据源的 **浏览 →**
2. 在顶部下拉菜单中选择要查询的**数据源**
3. （可选）如果数据源支持范围查询，开启**时间范围 (range)**
4. 在输入框中直接输入对应语言的查询，或先用自然语言描述再通过 **AI 生成**填充查询
5. 检查查询后点击**执行**（或在输入框中按 **Enter**）进行查询
6. 查看以图表或表格形式呈现的结果

:::info 没有数据源时
如果没有任何已连接的数据源，下拉菜单为空，并显示 **"没有已配置的数据源 — 请在 Datasources 标签页中添加。"** 提示。数据源连接和凭证注册在**集成（Integrations）中心**（`/integrations` → 数据源标签页）中进行。
:::

:::tip 快速执行
在输入框中按 **Enter** 会立即执行。在自然语言描述框中按 **Enter** 会触发 **AI 生成**。
:::

:::tip 结果被截断时
如果看到**结果已截断（达到上限）**警告，请缩小查询范围或条件后重新查询。
:::

## AI 分析技巧
- "过去 5 分钟所有节点的 CPU 使用率" → 生成 PromQL 查询
- "包含 error 的最近日志" → 生成 LogQL 查询
- "耗时超过 500ms 的跟踪" → 生成 TraceQL 查询
- "各表的行数" → 生成只读 SQL

## AI 诊断

在 Datasources 管理页中,每个 kind 的**默认(default)**数据源行会显示 **AI 诊断** 链接
(支持的 kind: Prometheus、ClickHouse、Loki、Mimir、Tempo)。点击后会跳转到 AI 助手,
输入框中会预填一条已固定分区的诊断提示(Prometheus/ClickHouse → `/observability`,
Loki/Mimir/Tempo → `/monitoring`)。**不会自动发送** — 请确认内容后自行发送,并会以新会话开始。
代理会使用该连接器的查询/模式工具检查数据源的响应状态。

## Explore 功能摘要

- 按 kind 提供**示例查询·自然语言提示词标签**(共 8 种 kind)
- **7d/30d 时间范围预设**(Prometheus/Mimir 最长 30d,Loki 7d — 按 kind 设上限)
- 结果**元数据栏**(行/序列数 · 往返 ms · 查询语言 · 形态)
- **Loki 专用日志查看器**(最新优先、标签徽章),Tempo/Jaeger **耗时条**
- AI 生成查询**来源横幅**;管理页 **KPI 卡片与刷新按钮**

## 相关页面
- [自定义智能体](../operations/custom-agents) - 智能体·技能配置（数据源/连接器已移至集成中心）
- [AI 助手](../overview/assistant) - 对话式 AI 运维助手
