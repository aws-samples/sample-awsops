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
| **ClickHouse** | **SQL**（只读） | `SHOW TABLES` |
| **Jaeger** | 按服务搜索 | `service=frontend&limit=20` |
| **Dynatrace** | Metrics v2 metricSelector | `builtin:host.cpu.usage:avg` |
| **Datadog** | 指标查询 | `avg:system.cpu.user{*}` |

### 选择数据源
- 在下拉菜单中选择数据源。每项显示**实例名称**和**类型（kind）**。
- AI 生成使用单独采集的 schema 缓存。数据源及各类型的默认连接为共享连接，选择 AWS 账户不会改变其数据范围。
- 只有管理员可配置和测试连接。私有端点需要运维人员配置网络和 DNS；已配置与已验证查询访问是不同状态。
- Timeout 区分 Prometheus/Mimir/ClickHouse 的服务器执行限制（默认 10 秒）和其他类型的 HTTP 响应限制（默认 12 秒）。保存值为 1–60 秒，表单显示实际最大 55 秒。Mimir API 前缀默认为 `/prometheus`，根路径 API 使用空值。

### 时间范围（range）开关
- 时间选择器为 **Prometheus/Mimir** 提供即时查询或最长 30 天，为 **Loki** 提供即时查询或最长 7 天。
- **Tempo/Jaeger** 默认查询 1 小时，最长 7 天；**Dynatrace/Datadog** 默认 1 小时，最长 30 天。所选时间范围会传递到实际搜索请求。
- **ClickHouse** 的时间条件需写入 SQL。AI 查询生成不会改变所选请求时间范围。

### 结果展示
- 时间序列（matrix/range）结果会绘制为**时间序列面积图**。
- 单一时间点、日志、跟踪、SQL 结果以可排序的**表格**显示。
- 实际被截断的结果会显示**结果已截断**警告。搜索达到上限而无法确认完整性的结果标为**部分结果**；已确认的空响应会显示**无结果**提示。
- 未确认或部分响应不能证明数据为空。Jaeger 搜索达到上限时，也不能证明已返回全部跟踪。

### 用 AI 生成查询
- 用自然语言描述所需内容并点击 **AI 生成**，系统会参考缓存的 schema 将其转换为对应语言的查询并填入输入框。
- 生成的查询**不会自动执行。** 需要检查后手动点击**执行**才会进行查询。

## 使用方法
1. 在侧边栏点击**集成**，然后在**数据源**标签页中打开要查询的数据源的 **浏览 →**
2. 在顶部下拉菜单中选择要查询的**数据源**
3. （可选）若数据源支持时间范围，在选择器中选择查询期间
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
