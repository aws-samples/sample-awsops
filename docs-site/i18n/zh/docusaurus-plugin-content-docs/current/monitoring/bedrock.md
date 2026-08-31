---
sidebar_position: 2
title: Bedrock
description: Amazon Bedrock 模型使用量、成本、令牌监控
---

# Bedrock Monitoring

实时监控 Amazon Bedrock 各模型使用量、令牌成本以及 Prompt Caching 节省效果的仪表板。

import Screenshot from '@site/src/components/Screenshot';

<Screenshot src="/screenshots/monitoring/bedrock.png" alt="Bedrock Monitoring" />

## 主要功能

### 统计卡片（8 个）

| 卡片 | 说明 |
|------|------|
| Total Cost | 所选期间内全部模型成本合计 |
| Invocations | 模型调用总次数 |
| Input Tokens | 输入令牌总数 |
| Output Tokens | 输出令牌总数 |
| Avg Latency | 平均响应延迟时间（秒） |
| Errors | 客户端（4xx）+ 服务器（5xx）错误合计 |
| Cache Savings | 通过 Prompt Caching 节省的成本 + 缓存命中率（%） |
| Models Used | 期间内使用的模型数 |

### 图表（3 个）

- **Cost by Model**（饼图）: 各模型成本占比
- **Invocations by Model**（柱状图）: 各模型调用次数对比
- **Token Usage Over Time**（折线图）: 按时间段的令牌使用趋势

### Account Total vs AWSops 使用量

将账户整体（基于 CloudWatch）与 AWSops 应用内部使用量并排对比：

- **Account Total**: 从 CloudWatch `AWS/Bedrock` 命名空间收集的账户整体 Invocations、Input/Output Tokens、估算成本
- **AWSops App**: 通过仪表板 AI 助手产生的累计调用次数、令牌使用量、各模型分布

### Prompt Caching 摘要

可一目了然地查看已启用 Prompt Caching 的模型的缓存效果：
- Cache Read/Write 令牌数
- 缓存命中率（%）
- 缓存成本及节省额

### 各模型详细信息

在表格中点击模型行后会打开滑出面板：
- **Cost Breakdown**: Input/Output/Cache Read/Cache Write 成本明细
- **Usage**: Invocations、令牌数、延迟时间、错误次数
- **Pricing**: 各模型每 1M 令牌的价格信息
- **时间序列图表**: 调用趋势、令牌使用趋势

### 时间范围选择

使用右上角的时间范围按钮更改查询期间：
- **1h**: 最近 1 小时（5 分钟间隔）
- **6h**: 最近 6 小时（5 分钟间隔）
- **24h**: 最近 24 小时（1 小时间隔）
- **7d**: 最近 7 天（1 天间隔）— 默认值
- **30d**: 最近 30 天（1 天间隔）

## AI 页面令牌成本显示

在 AI 助手页面（`/ai`）中，每条响应都会显示令牌使用量和成本：
- Input/Output 令牌数
- 基于各模型价格的成本计算
- 使用与 Bedrock 仪表板相同的价格表

## 数据来源

- **CloudWatch**: `AWS/Bedrock` 命名空间中的 `Invocations`、`InputTokenCount`、`OutputTokenCount`、`InvocationLatency`、`InvocationClientErrors`、`InvocationServerErrors`、`CacheReadInputTokenCount`、`CacheWriteInputTokenCount` 指标
- **AWSops 统计**: `agentcore-stats.ts` 中的累计调用/令牌数据

## 使用技巧

:::tip 成本优化
如果 Prompt Caching 命中率较低，将重复出现的系统提示词或上下文组织为可缓存的形式，可以大幅降低成本。
:::

:::info Cross-Region Inference
跨区域推理模型 ID（例如 `us.anthropic.claude-*`）也会被自动识别并应用正确的价格。
:::

## 相关页面

- [Monitoring Overview](./monitoring.md) - 基础设施性能监控
- [Cost Explorer](./cost.md) - AWS 整体成本分析
- [AI Assistant](../overview/ai-assistant.md) - AI 助手使用指南
