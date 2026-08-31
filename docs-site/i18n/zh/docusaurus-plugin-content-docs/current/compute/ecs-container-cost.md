---
sidebar_position: 11
title: ECS Container Cost
description: ECS Fargate 任务成本分析、CloudWatch Container Insights 指标
---

import Screenshot from '@site/src/components/Screenshot';

# ECS Container Cost

:::caution v1 归档文档 — v2 中没有对应页面
本文档描述的是 v1 专用的 **ECS Container Cost** 页面（统计卡片、图表和 "Cost Calculation Basis" 折叠区）。**v2 中没有这样的专用页面/UI** —— `web/` 中不存在 `showBasis` 折叠开关，也没有对应的 StatsCard/图表。v2 中唯一对应的功能是 **`/inventory/ecs_task`** 库存视图中的 **Cost/Day、Cost/Mo** 两列，这些数值是根据任务定义分配的 cpu/memory 计算出的**静态估算值**，并非来自 CloudWatch Container Insights 的使用率指标（参见 `web/lib/inventory-derived.ts` 的 `ecs_task` deriver，约第 106-124 行）。下方的**价格常量与计算公式**（`$0.04656`/`$0.00511`，`(CPU units/1024)×单价×24 + (MB/1024)×单价×24`）与该静态估算的实际逻辑一致，是准确的 —— 请勿修改。但本文档中的统计卡片、图表、"Cost Calculation Basis" 折叠区，以及"基于 CloudWatch Container Insights 指标计算"的说法均为 v1 专属，v2 中不存在。
:::

用于分析 ECS Fargate 任务成本的页面。基于 Fargate 价格和 CloudWatch Container Insights 指标计算成本。

<Screenshot src="/screenshots/compute/ecs-container-cost.png" alt="ECS Container Cost" />

## 主要功能

### 统计卡片
- **Daily Cost (ECS)**: 每日总成本（青色）
- **Monthly Estimate**: 月度估算成本（绿色）
- **Running Tasks**: 运行中任务数量 - 区分 Fargate/EC2（紫色）
- **Top Cost Service**: 成本最高的服务（橙色）

### Service Cost Distribution 图表
以饼图显示各服务的每日成本分布

### Cost by Service (CPU vs Memory) 图表
以堆叠条形图对比各服务的 CPU 成本和 Memory 成本

### ECS Tasks 表格
| 列 | 说明 |
|------|------|
| Cluster | 集群名称 |
| Service | 服务名称 |
| Task ID | 任务 ID（前 12 位） |
| Type | 启动类型（FARGATE/EC2） |
| CPU (units) | CPU 单元及 vCPU 换算值 |
| Memory (MB) | 内存及 GB 换算值 |
| Daily Cost | 每日成本（仅 Fargate） |
| AZ | 可用区 |

## 成本计算方式

### Fargate 价格（v2 实际值 — ap-northeast-2（首尔）单价，`web/lib/inventory-derived.ts`）
| 资源 | 单价 | 计费单位 |
|--------|------|-----------|
| vCPU | $0.04656 | per vCPU-hour |
| Memory | $0.00511 | per GB-hour |
| Ephemeral Storage (>20GB) | $0.000111 | per GB-hour |

> 这是一个固定的静态估算常量，无论任务的实际 AWS 区域为何都会应用 —— deriver 不会查询每个任务行的区域列。

### 计算公式
```
CPU Cost = (CPU Units / 1024) x $0.04656/hr x 24hr
Memory Cost = (Memory MB / 1024) x $0.00511/hr x 24hr
Daily Cost = CPU Cost + Memory Cost
Monthly Estimate = Daily Cost x 30
```

### 计算示例
Fargate Task: 512 CPU units (0.5 vCPU) + 1024 MB (1 GB)
- CPU: 0.5 vCPU x $0.04656/hr x 24hr = **$0.5587/day**
- Memory: 1 GB x $0.00511/hr x 24hr = **$0.1226/day**
- Total: **$0.681/day ($20.44/month)**

## 计算依据折叠区（Cost Calculation Basis）

表格下方有一个 **▶ Cost Calculation Basis / 成本计算依据** 可折叠部分。切换 `showBasis` 时会内联展开以下内容：

- **Fargate Pricing 表**（v2 实际值，ap-northeast-2（首尔）单价 —— 该固定常量与任务的实际区域无关）
  - vCPU hourly rate: `$0.04656`
  - GB hourly rate: `$0.00511`
- 示例计算：0.5 vCPU × 1 GB 任务 → 换算为 `$0.681/day`
- 关于 Spot、ARM（Graviton）价格差异的参考说明

在 v1 中，价格值可通过 `data/config.json` 中的 `fargatePricing` 覆盖 — v2 没有这一机制。

## EKS Pod Cost 指引（Phase 2）

页面底部有一个引导至 EKS 容器成本分析的卡片 — 本页面仅限于 ECS Fargate，EKS Pod 级成本在单独的页面中介绍：

→ [EKS Container Cost](./eks-container-cost) — Pod / Node 标签页，OpenCost (Prometheus) 或基于 Request 的估算

## 使用方法

1. 在侧边栏点击 **Compute > Container Cost**
2. 在统计卡片中了解整体成本状况
3. 在图表中识别成本较高的服务
4. 在表格中查看各任务的详细成本
5. 展开 "Cost Calculation Basis" 部分查看计算依据

## 支持范围

| 项目 | 支持 |
|------|------|
| Fargate Launch Type | O（支持成本计算） |
| EC2 Launch Type | X（需要分摊节点成本，暂不支持） |
| Spot Fargate | -（按 On-Demand 价格计） |

## 使用技巧

:::tip EC2 Launch Type
EC2 类型任务会显示为 "N/A (EC2)"。EC2 成本需要分摊节点成本，目前暂不支持。
:::

:::tip 成本优化
如果在 CPU vs Memory 图表中某一方明显偏高，请考虑调整任务定义。Fargate 的 CPU 与 Memory 组合是受限的。
:::

:::tip 更改价格设置（仅限 v1）
`data/config.json` 的 `fargatePricing` 字段是 v1 的覆盖机制 — v2 中不存在。
:::

:::info AI 分析
在 AI Assistant 中可以通过"ECS 成本分析"、"成本最高的服务"、"Fargate 成本优化方案"等方式进行分析。
:::

## 相关页面

- [ECS](../compute/ecs) - ECS 集群及服务状态
- [EKS Container Cost](../compute/eks-container-cost) - EKS Pod 成本分析
- [Cost](../monitoring/cost) - 整体 AWS 成本分析
