---
sidebar_position: 2
title: CloudWatch
description: 监控 CloudWatch 告警并跟踪状态变化。
---

import Screenshot from '@site/src/components/Screenshot';

# CloudWatch

可一目了然地掌握 AWS CloudWatch 告警状态并查看详细配置的页面。

<Screenshot src="/screenshots/monitoring/cloudwatch.png" alt="CloudWatch" />

## 主要功能

### 告警状态摘要
- **OK**: 处于正常状态的告警数（绿色）
- **ALARM**: 已触发的告警数（红色）
- **INSUFFICIENT_DATA**: 数据不足的告警数（橙色）

### 可视化
- **Alarm State Distribution**: 按状态划分的告警比例饼图
- **Alarms by Namespace**: 按命名空间划分的告警数量柱状图

### 告警列表
| 列 | 说明 |
|------|------|
| Alarm Name | 告警名称 |
| Namespace | AWS 服务命名空间（AWS/EC2、AWS/RDS 等） |
| Metric | 监控目标指标 |
| State | 当前状态（OK、ALARM、INSUFFICIENT_DATA） |
| Reason | 状态变更原因 |
| Actions | 操作是否启用 |

### 告警详细信息
点击告警行后，可在滑出面板中查看详细信息：
- **Alarm**: 名称、ARN、状态、状态原因
- **Configuration**: 比较运算符、阈值、评估周期、统计方式
- **Actions**: 告警/OK/数据不足时执行的操作列表（SNS、Lambda 等）

## 使用方法

1. **按状态筛选**: 点击顶部的 StatsCard 即可只筛选出该状态的告警
2. **查看命名空间**: 在柱状图中识别告警较多的服务
3. **查看详情**: 点击告警行查看配置和操作
4. **刷新**: 使用右上角按钮获取最新状态

:::tip 告警状态含义
- **OK**: 指标处于阈值范围内
- **ALARM**: 指标超出/低于阈值（取决于配置）
- **INSUFFICIENT_DATA**: 指标数据不足，或告警刚创建不久
:::

## 使用技巧

### 立即确认 ALARM 状态
如果顶部红色的 "ALARM" StatsCard 上显示 "Active alarms!"，需要立即确认。

### 检查操作配置
在告警详情中，如果 Actions Enabled 为 "No"，即使告警被触发也不会发送通知。请确认是否已关联 SNS 主题或 Lambda 函数。

### 解决 INSUFFICIENT_DATA
- 新创建的告警：等待指标收集完成（最多 5-10 分钟）
- 已有告警：检查指标来源（EC2 已停止、Lambda 未激活等）

:::info 告警评估周期
告警要进入 ALARM 状态，指标必须在连续的评估周期（Evaluation Periods）内持续超出阈值。例如：Period 300s、Eval Periods 3 = 连续超出 15 分钟时触发告警。
:::

## AI 分析技巧

在 AI 助手中利用 Monitoring Gateway 的提问示例：

- "分析处于 ALARM 状态的告警的共同原因"
- "显示过去 24 小时告警状态变化历史"
- "分析这个告警阈值是否合适"
- "告警操作用 SNS 代替 Lambda 会更好吗？"

## 相关页面

- [Monitoring Overview](../monitoring) - 性能指标
- [CloudTrail](../monitoring/cloudtrail) - API 活动审计
- [Cost Explorer](../monitoring/cost) - 成本分析
