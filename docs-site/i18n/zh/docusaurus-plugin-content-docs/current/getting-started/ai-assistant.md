---
sidebar_position: 3
title: AI 助手快速入门
description: AWSops AI 助手基本使用方法
---

# AI 助手快速入门

AWSops AI 助手基于 Amazon Bedrock AgentCore，可以用自然语言就 AWS 基础设施进行提问和请求分析。

## 开始使用

### 1. 进入 AI Assistant 页面

在侧边栏点击 **AI Assistant**。

### 2. 输入问题

在界面底部的输入框中输入问题，按 **Enter** 或点击发送按钮。

### 3. 查看回答

AI 会分析问题并路由到合适的 Gateway，利用工具生成答案。

## 示例问题

### 查询资源状况

```
告诉我 EC2 实例的现状
```

```
确认一下有多少个 S3 存储桶
```

```
显示 Lambda 函数列表
```

### 网络分析

```
分析一下 VPC 网络配置
```

```
检查是否有安全组存在 0.0.0.0/0 入站规则
```

### 安全检查

```
检查是否存在安全问题
```

```
检查是否有未启用 MFA 的 IAM 用户
```

### 成本分析

```
显示本月的成本现状
```

```
按服务比较成本
```

### 容器状况

```
告诉我 EKS 集群的状态
```

```
确认一下 ECS 服务的现状
```

## 11 级路由

AI 助手会分析问题，并自动将其分类到 11 条专业路由中最合适的一条。

| 优先级 | 路由 | 用途 |
|---------|--------|------|
| 1 | code | Python 代码执行、计算、可视化 |
| 2 | network | VPC、TGW、VPN、Flow Logs 分析 |
| 3 | container | EKS、ECS、Istio 故障排查 |
| 4 | iac | CDK、CloudFormation、Terraform |
| 5 | data | DynamoDB、RDS、ElastiCache、MSK |
| 6 | security | IAM、策略模拟、安全摘要 |
| 7 | monitoring | CloudWatch、CloudTrail |
| 8 | cost | 成本分析、预测、预算 |
| 9 | datasource | 外部可观测性 — Prometheus/Loki/Tempo/ClickHouse/Jaeger/Dynatrace/Datadog（自然语言 → 查询） |
| 10 | aws-data | 资源列表/状况（Steampipe SQL） |
| 11 | general | 一般 AWS 问题、文档搜索 |

:::tip 查看路由
通过回答底部显示的路由信息，可以确认使用了哪个 Gateway。
例如：`Network Gateway (17 tools)`、`Bedrock + Steampipe SQL`
:::

## 理解回答

### 回答结构

```
┌────────────────────────────────────────────────────────┐
│  [AI 图标]                                             │
│                                                        │
│  回答内容（Markdown 格式）                             │
│  - 支持表格、列表、代码块                              │
│                                                        │
├────────────────────────────────────────────────────────┤
│  Network Gateway (17 tools)  │  Claude sonnet-4.6  │ 3.2s │
├────────────────────────────────────────────────────────┤
│  Tools: list_vpcs, get_vpc_network_details, ...        │
│  Queried: aws_vpc, aws_vpc_subnet                      │
└────────────────────────────────────────────────────────┘
```

### 显示信息

- **路由路径**：由哪个 Gateway 处理
- **模型**：使用的 Claude 模型（Sonnet/Opus）
- **响应时间**：处理所耗费的时间
- **使用的工具**：被调用的 MCP 工具列表
- **查询的资源**：在 Steampipe 中查询的表

### 实时流式输出

回答会实时流式传输并逐步显示在界面上。系统会根据路径自动选择最优的流式模式：

- **单一 Gateway 回答**：以打字效果自然呈现
- **多路由合成**：通过 Bedrock Converse API 实时流式输出合成结果
- **数据查询（aws-data）**：Bedrock 原生 token 流式输出

## 模型选择

可以在界面右上角的下拉菜单中选择模型：

- **Claude Sonnet 4.6**：响应快速，适合一般问题（默认值）
- **Claude Opus 4.8**：适合复杂分析、深度推理
- **Claude Haiku 4.5**：快速且低成本，适合简单问题和批量处理

## 关联问题

回答后会以按钮形式显示相关的后续问题。点击后该问题会自动填入输入框。

示例：
```
[显示 IAM 用户列表及 Access Key 状态]
[检查是否有未启用 MFA 的用户]
[检查是否有安全组存在 0.0.0.0/0 入站规则]
```

## 对话历史

### 会话内历史
当前会话的对话内容会保留在界面上。可以参考之前的对话进行后续提问。

### 已保存的历史
展开界面底部的**对话历史**面板，可以查看之前会话的对话记录并再次提问。

## 下一步

- [AI 助手详解](../overview/ai-assistant) - 11 级路由详解及高级功能
- [AgentCore 详解](../overview/agentcore) - AgentCore 架构及工具列表
