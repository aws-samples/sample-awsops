---
sidebar_position: 7
title: 数据源
description: 外部数据源集成管理 (Prometheus, Loki, Tempo, ClickHouse, Jaeger, Dynatrace, Datadog)
---

import Screenshot from '@site/src/components/Screenshot';
import DatasourceFlow from '@site/src/components/diagrams/DatasourceFlow';
import DatasourceExploreFlow from '@site/src/components/diagrams/DatasourceExploreFlow';

# 数据源

这是一个 Grafana 风格的数据源管理页面，可将外部监控与可观测性系统集成到 AWSops 中进行统一管理。

<Screenshot src="/screenshots/monitoring/datasources.png" alt="Datasources" />

## 概览

AWSops 数据源功能对外部可观测性平台进行集中管理。注册数据源后，可在仪表板中执行查询，AI 助手也可以将其用于分析。

<DatasourceFlow />

主要特点：
- 支持 **7 种数据源**（Prometheus、Loki、Tempo、ClickHouse、Jaeger、Dynatrace、Datadog）
- **CRUD 管理**：添加、修改、删除数据源（仅限管理员）
- **连接测试**：一键连接确认与响应时间测量
- **查询执行**：支持各数据源专有的查询语言
- **安全**：SSRF 防护、凭证掩码

## 支持的数据源

| 数据源 | 查询语言 | 默认端口 | 主要功能 |
|-----------|----------|----------|----------|
| **Prometheus** | PromQL | 9090 | 指标采集、告警、时序数据 |
| **Loki** | LogQL | 3100 | 日志聚合、基于标签的搜索 |
| **Tempo** | TraceQL | 3200 | 分布式追踪、Span 搜索 |
| **ClickHouse** | SQL | 8123 | 列式分析、海量数据处理 |
| **Jaeger** | Trace ID | 16686 | 分布式追踪、服务依赖 |
| **Dynatrace** | DQL | 443 | 全栈监控、基于 AI 的分析 |
| **Datadog** | Query | 443 | 基础设施监控、APM、日志 |

## 添加数据源

:::info 仅限管理员
数据源的创建、修改、删除需要管理员角色。管理员是登记在 `data/config.json` 的 `adminEmails` 中的用户。非管理员进入页面时会显示 **Access Denied** 画面。
:::

:::info 与多账户无关
外部数据源设置是**全局的** — 切换侧边栏的 AccountSelector 不会产生影响。Prometheus/Loki 等与 AWS 账户不是 1:1 映射，因此所有账户的用户看到的是相同的数据源列表（但若 Departments 设置了 `datasourceIds` 限制，则遵循该限制）。
:::

### 配置字段

| 字段 | 必填 | 说明 |
|------|------|------|
| **Name** | O | 数据源识别名称 |
| **Type** | O | 数据源类型（从 7 种中选择） |
| **URL** | O | 端点 URL（例：`http://prometheus:9090`） |
| **Authentication** | - | 认证方式（None、Basic、Bearer Token、Custom Header） |
| **Timeout** | - | 请求超时（默认值：30 秒） |
| **Cache TTL** | - | 缓存有效时间（默认值：5 分钟） |
| **Database** | - | 数据库名称（ClickHouse 专用） |

### 添加步骤

1. 在 **Datasources** 页面点击 **Add Datasource** 按钮
2. 选择数据源类型
3. 输入名称、URL、认证信息
4. 通过 **Test Connection** 确认连接
5. 点击 **Save** 保存

## 连接测试

点击 **Test Connection** 按钮后，按数据源类型确认以下内容：

| 数据源 | 测试端点 | 确认内容 |
|-----------|-----------------|----------|
| Prometheus | `/-/healthy` | 服务器状态、响应时间 |
| Loki | `/ready` | 服务器就绪状态、响应时间 |
| Tempo | `/ready` | 服务器就绪状态、响应时间 |
| ClickHouse | `SELECT 1` | 查询是否可执行、响应时间 |
| Jaeger | `/api/services` | 服务列表查询、响应时间 |
| Dynatrace | `/api/v2/entities` | API 是否可访问、响应时间 |
| Datadog | `/api/v1/validate` | API 密钥有效性、响应时间 |

测试结果会显示连接成功/失败状态以及响应延迟时间 (ms)。

## 查询执行

可以使用各数据源专有的查询语言直接执行查询。

### PromQL (Prometheus)

```promql
rate(http_requests_total{job="api-server"}[5m])
```

以时间序列查询 CPU 使用率、请求率、错误率等指标数据。

### LogQL (Loki)

```logql
{namespace="production"} |= "error" | json | line_format "{{.message}}"
```

支持基于标签的日志搜索和管道过滤。

### TraceQL (Tempo)

```
{span.http.status_code >= 500 && resource.service.name = "api"}
```

按条件搜索分布式 Trace。

### ClickHouse SQL

```sql
SELECT toStartOfHour(timestamp) AS hour, count() AS events
FROM logs
WHERE timestamp > now() - INTERVAL 24 HOUR
GROUP BY hour
ORDER BY hour
```

对海量数据执行快速分析查询。

### Jaeger

按服务名称或 Trace ID 搜索分布式 Trace。

### Dynatrace (DQL)

```
fetch logs | filter contains(content, "error") | limit 100
```

### Datadog

使用指标查询或日志搜索语法。

## 认证设置

数据源连接支持 4 种认证方式：

| 认证方式 | 说明 | 使用示例 |
|----------|------|----------|
| **None** | 无认证 | 内部网络中的 Prometheus/Loki |
| **Basic** | 用户名/密码 | ClickHouse、启用了认证的 Prometheus |
| **Bearer Token** | API 令牌 | Dynatrace、Datadog、Tempo |
| **Custom Header** | 自定义头 | 自定义代理、API 网关 |

:::tip 凭证掩码
保存的密码和令牌在 UI 中会被掩码处理。仅在修改时才能输入新值。
:::

## 安全

### SSRF 防护

对数据源 URL 应用以下安全检查：

- **拦截私有 IP**：拦截 `10.x.x.x`、`172.16-31.x.x`、`192.168.x.x`、`127.0.0.1` 等内部 IP
- **拦截元数据端点**：拦截对 `169.254.169.254`（EC2 实例元数据）的访问
- **拦截链路本地地址**：拦截 `169.254.x.x` 网段
- **协议限制**：仅允许 `http://` 和 `https://`

:::caution SSRF 保护
外部数据源 URL 由服务器发出请求，因此为防止 SSRF（Server-Side Request Forgery）攻击，会拦截对内部网络的访问。
:::

### ClickHouse SQL 注入防护

执行 ClickHouse 查询时会拦截危险的 SQL 语句（DROP、ALTER、INSERT、UPDATE、DELETE、TRUNCATE 等）。仅允许只读查询 (SELECT)。

## AI 集成

AI 助手可以利用已注册的数据源执行分析。

### 使用示例

- "在 Prometheus 中显示过去 1 小时的 CPU 使用率趋势"
- "在 Loki 中搜索 production 命名空间的错误日志"
- "在 ClickHouse 中按小时统计今天的事件数"

### 工作方式

1. AI 助手分析问题并选择合适的数据源
2. 自动生成符合数据源类型的查询
3. 基于查询结果提供分析与洞察

:::tip datasource 路由集成
与数据源相关的问题通过 `datasource` 路由处理。AI 可以将 Steampipe 数据与外部数据源结合分析。
:::

## 配置参考

### 通用配置

| 配置 | 默认值 | 说明 |
|------|--------|------|
| **timeout** | 30 秒 | 请求超时（最长 120 秒） |
| **cacheTTL** | 300 秒（5 分钟） | 查询结果缓存有效时间 |

### ClickHouse 专用

| 配置 | 默认值 | 说明 |
|------|--------|------|
| **database** | `default` | 目标数据库名称 |

### 限制事项

- 可注册数据源的最大数量：无限制
- 查询结果最大行数：1,000 行
- ClickHouse：仅允许 SELECT 查询（拦截 DDL/DML）
- URL：拦截私有 IP 及元数据端点

## Explore 页面

在 Explore 页面中可以对已注册的数据源直接执行查询并可视化结果。支持 AI 查询生成和多序列图表。

<DatasourceExploreFlow />

### 主要功能

- **数据源选择下拉框**：在所有已注册的数据源中选择查询目标。
- **时间范围预设**：从 15m、1h、6h、24h、7d、30d 中选择以指定查询区间。
- **原生查询编辑器**：提供按数据源类型应用语法高亮的查询编辑器（PromQL、LogQL、SQL 等）。
- **示例查询标签**：可一键输入按数据源类型常用的查询。
- **结果元数据**：查询执行后，行数、执行时间 (ms)、查询语言会显示在顶部。

### AI 查询生成

启用 **AI Assist** 开关后，可以用自然语言编写查询。Bedrock Sonnet 会自动生成符合数据源类型的查询并显示说明横幅。

**按数据源类型的示例提示词：**

| 数据源 | 示例提示词 |
|-----------|-------------|
| Prometheus | "过去 1 小时 CPU 使用率排名前 5 的 Pod" |
| Loki | "在 production 命名空间中搜索 error 级别日志" |
| ClickHouse | "按小时统计今天的事件数" |
| Tempo | "搜索发生 500 错误的 Trace" |

**使用方法：**

1. 将 AI Assist 开关切换为 ON
2. 用自然语言描述想要的数据
3. 按 **Ctrl+Enter** 或点击执行按钮
4. Bedrock Sonnet 生成 PromQL/LogQL/SQL 查询
5. 生成的查询会连同说明横幅一起显示

:::tip AI Assist 快捷键
使用 **Ctrl+Enter** 可快速生成并执行查询。
:::

### 多序列图表

在 Prometheus 数据源中最多可同时可视化 **8 个序列**。

- **Line/Bar 图表切换**：选择符合数据特性的图表类型。
- **自定义调色板**：每个序列自动分配专属颜色，使用 8 种主题色。
- **序列数指示器**：图表底部显示当前正在渲染的序列数量。

:::info 序列限制
出于性能考虑，Prometheus 多序列图表限制为最多 8 个序列。超过 8 个的结果仅显示前 8 个。
:::

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


## Allowed Networks

管理员可以针对被 SSRF 防护拦截的私有网络设置例外允许列表。

:::info 仅限管理员
Allowed Networks 设置需要管理员角色。
:::

### 支持的模式

| 模式类型 | 示例 | 说明 |
|----------|------|------|
| **CIDR** | `10.0.0.0/16` | 允许特定子网网段 |
| **单一 IP** | `10.0.1.50` | 允许特定 IP 地址 |
| **主机名** | `prometheus.internal` | 允许特定内部主机名 |

### 与 SSRF 防护的关系

默认情况下，私有 IP 网段（`10.x.x.x`、`172.16-31.x.x`、`192.168.x.x`）会因 SSRF 防护而被拦截。登记在 Allowed Networks 中的地址会作为该拦截规则的例外处理，从而可以安全地访问位于内部网络的数据源。

:::caution 安全注意
在 Allowed Networks 中添加过宽的 CIDR 网段会削弱 SSRF 保护。请只登记必要的最小范围。
:::

### API 端点
```bash
# 查询当前允许列表 (仅限 admin)
curl '/awsops/api/datasources?action=allowlist'

# 更新允许列表
curl -X POST '/awsops/api/datasources' \
  -H 'Content-Type: application/json' \
  -d '{"action":"update-allowlist","networks":["10.0.0.0/16","prometheus.internal"]}'

# 连接测试
curl -X POST '/awsops/api/datasources' \
  -H 'Content-Type: application/json' \
  -d '{"action":"test-connection","datasourceId":"<id>"}'
```

## AI 代理集成

已注册的数据源会在 AI 助手（`/ai`）中自动使用。当问题中包含数据源关键词时，AI 会自动生成并执行查询。

### 单一数据源查询

```
"帮我在 Prometheus 中确认 CPU 使用量"
→ datasource 路由 → 自动生成 PromQL → 分析结果
```

### 多数据源关联分析

可以同时查询多个数据源进行关联分析：

```
"帮我对 Prometheus 指标和 Loki 错误日志做相关性分析"
→ Prometheus PromQL + Loki LogQL 并行执行 → 综合分析
```

### 与 AWS 资源交叉分析

可以将数据源查询与 AWS 资源结合分析以找出根本原因：

```
"帮我比较 Prometheus CPU 尖峰和 CloudWatch 告警"
→ datasource + monitoring 多路由 → 交叉相关分析
```

:::tip AI 关键词
AI 助手识别的关键词：**프로메테우스/prometheus**、**로키/loki**、**템포/tempo**、**클릭하우스/clickhouse**、**예거/jaeger**、**다이나트레이스/dynatrace**、**데이터독/datadog**
:::

## 相关页面

- [监控仪表板](./monitoring.md) - 系统监控现状
- [CloudWatch](./cloudwatch) - AWS CloudWatch 指标
- [AI 助手](../overview/ai-assistant) - AI 分析功能
