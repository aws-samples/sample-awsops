---
sidebar_position: 2
title: AI 助手
description: AWSops AI 助手详细指南 - 11 级路由及高级功能
---

import Screenshot from '@site/src/components/Screenshot';
import AIStreamingFlow from '@site/src/components/diagrams/AIStreamingFlow';

# AI 助手

AI 助手是基于 Amazon Bedrock AgentCore、可以用自然语言分析和管理 AWS 基础设施的功能。

<Screenshot src="/screenshots/overview/ai-assistant.png" alt="AI 助手" />

## 架构

![AI 意图分类流程](/diagrams/ai-routing.png)

## 11 级路由

AI 助手会分析问题并自动分类到最合适的路由。优先级：`code` → `network` → `container` → `iac` → `data` → `security` → `monitoring` → `cost` → `datasource` → `aws-data` → `general`。

内部还存在额外的分类路由：
- `datasource-diag` — 数据源连接诊断（6 步自动诊断）
- `incident` — 基于告警的局部诊断（由 alert-correlation 调用）

### 路由表

| 优先级 | 路由 | Gateway | 工具数 | 说明 |
|---------|--------|---------|--------|------|
| 1 | **code** | - | - | Python 代码执行、计算、可视化 |
| 2 | **network** | Network | 17 | VPC、TGW、VPN、Flow Logs、Reachability |
| 3 | **container** | Container | 24 | EKS、ECS、Istio 故障排查 |
| 4 | **iac** | IaC | 12 | CDK、CloudFormation、Terraform |
| 5 | **data** | Data | 24 | DynamoDB、RDS、ElastiCache、MSK |
| 6 | **security** | Security | 14 | IAM、策略模拟、安全摘要 |
| 7 | **monitoring** | Monitoring | 16 | CloudWatch、CloudTrail |
| 8 | **cost** | Cost | 9 | 成本分析、预测、预算 |
| 9 | **datasource** | - | 7 DS | 外部可观测性（Prometheus/Loki/Tempo/ClickHouse/Jaeger/Dynatrace/Datadog）— 自然语言 → 查询 |
| 10 | **aws-data** | Ops | SQL | 资源列表/状况（Steampipe SQL） |
| 11 | **general** | Ops | 9 | 一般 AWS 问题、文档搜索 |

### 各路由详解

#### 1. code - Code Interpreter

需要执行 Python 代码时使用。

**示例问题：**
- "将 AWS 成本数据可视化为图表"
- "计算随机数字的统计信息"
- "编写解析 JSON 数据的代码"

#### 2. network - Network Gateway

用于 VPC 网络、Transit Gateway、VPN、流量分析。

**主要工具：**
- `list_vpcs`、`get_vpc_network_details`、`describe_network`
- `list_transit_gateways`、`get_tgw_routes`、`get_all_tgw_routes`
- `list_vpn_connections`、`list_network_firewalls`
- `analyze_reachability`、`query_flow_logs`

**示例问题：**
- "分析 TGW 路由"
- "诊断 VPN 连接状态"
- "确认 EC2 之间能否通信"
- "从 VPC Flow Logs 中查询被拒绝的流量"

#### 3. container - Container Gateway

用于 EKS、ECS、Istio 服务网格相关的故障排查。

**主要工具：**
- `list_eks_clusters`、`get_eks_vpc_config`、`get_eks_insights`
- `ecs_resource_management`、`ecs_troubleshooting_tool`
- `istio_overview`、`list_virtual_services`、`check_sidecar_injection`

**示例问题：**
- "诊断 EKS 集群状态"
- "确认 ECS 服务是否正常"
- "检查 Istio sidecar injection 状态"

#### 4. iac - IaC Gateway

用于 Infrastructure as Code 相关工作。

**主要工具：**
- `validate_cloudformation_template`、`check_cloudformation_template_compliance`
- `search_cdk_documentation`、`cdk_best_practices`
- `SearchAwsProviderDocs`、`terraform_best_practices`

**示例问题：**
- "告诉我 CDK 最佳实践"
- "分析 CloudFormation 堆栈错误的原因"
- "搜索 Terraform VPC 模块"

#### 5. data - Data Gateway

用于 AWS 数据库及流式服务。

**主要工具：**
- `list_tables`、`describe_table`、`query_table`、`dynamodb_data_modeling`
- `list_db_instances`、`describe_db_instance`、`execute_sql`
- `list_cache_clusters`、`elasticache_best_practices`
- `list_clusters`（MSK）、`msk_best_practices`

**示例问题：**
- "显示 DynamoDB 表的详细信息"
- "确认 RDS 实例状态"
- "告诉我 ElastiCache 最佳实践"

#### 6. security - Security Gateway

用于 IAM 及安全相关的分析。

**主要工具：**
- `list_users`、`list_roles`、`list_policies`
- `list_access_keys`、`simulate_principal_policy`
- `get_account_security_summary`

**示例问题：**
- "显示 IAM 用户列表和 Access Key 状态"
- "模拟一下这个角色能否访问 S3"
- "告诉我账户安全摘要"

#### 7. monitoring - Monitoring Gateway

用于 CloudWatch 及 CloudTrail 分析。

**主要工具：**
- `get_metric_data`、`analyze_metric`、`get_active_alarms`
- `describe_log_groups`、`execute_log_insights_query`
- `lookup_events`、`lake_query`

**示例问题：**
- "显示 EC2 CPU 使用率趋势"
- "从 CloudTrail 查询最近的 IAM 事件"
- "显示已激活的告警列表"

#### 8. cost - Cost Gateway

用于成本分析及优化。

**主要工具：**
- `get_cost_and_usage`、`get_cost_and_usage_comparisons`
- `get_cost_forecast`、`get_pricing`
- `list_budgets`

**示例问题：**
- "分析本月成本"
- "按服务比较成本"
- "预测下个月的成本"

#### 9. datasource - 外部可观测性（自然语言 → 查询）

用于针对已集成的外部可观测性平台（Prometheus/Loki/Tempo/ClickHouse/Jaeger/Dynatrace/Datadog）的问题。

**处理方式：**
1. Claude 将自然语言问题转换为相应平台的查询语言（PromQL/LogQL/TraceQL/SQL）
2. 对通过 SSRF allowlist 的数据源执行查询
3. 分析结果并做出回答

**示例问题：**
- "显示支付服务的 5xx 趋势"（Prometheus）
- "查找最近 1 小时的错误日志"（Loki）
- "分析慢的 trace"（Tempo/Jaeger）

#### 10. aws-data - Bedrock + Steampipe SQL

用于查询资源列表、状况、数量。

**处理方式：**
1. Claude Sonnet 根据问题生成 SQL
2. 直接在 Steampipe pg Pool 中执行查询
3. 由 Bedrock 分析结果并做出回答

**示例问题：**
- "显示 EC2 实例列表"
- "确认有多少个 S3 存储桶"
- "分析 VPC 网络配置"
- "汇总全部资源"

#### 11. general - Ops Gateway

用于一般 AWS 问题、文档搜索、最佳实践。

**主要工具：**
- `search_documentation`、`read_documentation`
- `recommend`、`list_regions`、`get_regional_availability`

**示例问题：**
- "确认这个服务在首尔区域是否可用"
- "告诉我 ECS 和 EKS 的区别"
- "推荐无服务器架构"

## 多路由

当一个问题涉及多个领域时，最多会被分类到 3 个路由并行处理。

**示例：**
```
"分析 VPC 安全组和成本"
→ ["network", "cost"]

"做一次安全检查并确认 IAM 用户"
→ ["security"]
```

:::info 多路由响应
进行多路由处理时，各 Gateway 的响应会被合成为一个统一的答案。
:::

## SSE 流式传输

响应通过 Server-Sent Events (SSE) 流式传输。

### 进度状态显示

```
正在分析问题...
→ 正在调用 Network Gateway...
→ 正在生成响应...
```

### 流式事件

| 事件 | 说明 | 数据 |
|--------|------|--------|
| `status` | 进度状态消息 | `{ step, message }` |
| `chunk` | 实时文本流 | `{ delta: string }` |
| `done` | 已完成的响应数据 | `{ content, route, usedTools, ... }` |
| `error` | 错误消息 | `{ message }` |

### 流式模式

根据响应路径自动选择 3 种流式模式之一：

<AIStreamingFlow />

| 模式 | 适用路径 | 方式 |
|------|----------|------|
| **Real Streaming** | 多路由合成 | Bedrock Converse API — 按 token 即时发送 |
| **Simulated Streaming** | 单一 Gateway 响应 | 50 字符分块 + 15ms 延迟 — 打字效果 |
| **Direct Streaming** | aws-data（Steampipe+Bedrock） | Bedrock 原生流式传输 |

:::info 多路由合成流式传输
在合成 2~3 个路由的并行执行结果时，使用 Bedrock Converse Stream API（`ConverseStreamCommand`）实时流式呈现合成过程。用户可以在合成结果生成的同时立即在屏幕上看到。
:::

## 工具使用显示

响应底部会显示所使用的 MCP 工具。

```
Tools: list_vpcs, get_vpc_network_details, analyze_reachability
Queried: aws_vpc, aws_vpc_subnet, aws_vpc_security_group
```

## 对话历史

### 会话内上下文

当前会话中的对话会被保持，可以进行后续提问。

```
用户: "显示 VPC 列表"
AI: (VPC 列表响应)

用户: "告诉我其中 default VPC 的详细信息"
AI: (参照之前的上下文给出 default VPC 详细响应)
```

### 已保存历史（AgentCore Memory）

对话历史按用户保存在 AgentCore Memory Store 中。可以在屏幕右侧面板查看，并通过点击恢复。

| 功能 | API |
|------|-----|
| 会话列表（最近 30 个） | `GET /awsops/api/agentcore?action=sessions&limit=30` |
| 加载单个会话 | `GET /awsops/api/agentcore?action=session&id={sessionId}` |

- **保存信息**：问题、响应、路由、token 使用量、时间戳
- **会话 ID**：客户端在进入页面时以 `s_{timestamp}_{rand}` 形式生成，包含在响应中并记录到服务器
- **保留期限**：365 天（`agentcore-memory.ts` 的 `eventExpiryDuration` 上限）
- **恢复行为**：点击会话时用该会话的消息数组覆盖当前对话窗口，后续提问以同一 `sessionId` 连续调用 — 保持 Bedrock 上下文

## 会话统计

屏幕底部显示当前会话的统计信息。

```
5 queries  │  avg 3.2s  │  100%  │  aws-data:3  security:1  network:1
```

- **queries**：总提问数
- **avg**：平均响应时间
- **成功率**：成功响应的比例
- **路由分布**：各路由的调用次数

## 相关问题推荐

回答结束后会按路由推荐相关的后续问题。

| 路由 | 推荐问题示例 |
|--------|--------------|
| security | "显示 IAM 用户列表和 Access Key 状态" |
| network | "显示 VPC 子网和路由表" |
| container | "确认 EKS 节点的 CPU/内存使用率" |
| cost | "按服务比较成本" |

## 下一步

- [AgentCore 详解](../overview/agentcore) - Gateway 及工具详细信息
- [仪表板](../overview/dashboard) - 返回仪表板
