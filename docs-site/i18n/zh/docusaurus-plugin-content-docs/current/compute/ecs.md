---
sidebar_position: 3
title: ECS
description: ECS 集群、服务、任务监控
---

import Screenshot from '@site/src/components/Screenshot';

# ECS (Elastic Container Service)

用于监控 ECS 集群、服务和任务状态的页面。

:::info v2 中的呈现方式
v1 曾在一个页面中统一监控集群/服务/任务，但**v2 将其拆分为 3 个独立的清单路由** —— `/inventory/ecs_cluster`、`/inventory/ecs_service`、`/inventory/ecs_task`。侧边栏只是将三者归入「计算」分组下一并显示 —— 每个都是拥有各自表格、筛选器和详情面板的独立页面。以下内容基于这一 3-路由结构，而非 v1 的统一页面。
:::

<Screenshot src="/screenshots/compute/ecs.png" alt="ECS" />

## 主要功能

### ECS Clusters（`/inventory/ecs_cluster`）
高亮卡片显示状态与区域分布，以及按运行中任务数排名的 Top-N 柱状图。

表格列：
| 列 | 说明 |
|------|------|
| Status | 状态（ACTIVE、INACTIVE） |
| Running | 运行中的任务数量 |
| Pending | 等待中的任务数量 |
| Services | 活跃服务数量 |
| Instances | 已注册容器实例数量 |
| MTD Cost ($) | 本月至今累计成本 |

详情面板：Identity（Name、Account、Region、ARN）/ Tasks & Services / Config（Settings、Container Insights 等）/ Tags 各部分。

### ECS Services（`/inventory/ecs_service`）
高亮卡片显示 Desired/Running/Pending 总和及集群去重数量。

表格列：
| 列 | 说明 |
|------|------|
| Service | 服务名称 |
| Status | 状态（ACTIVE、DRAINING） |
| Desired | 期望任务数量 |
| Running | 运行中的任务数量 |
| Pending | 等待中的任务数量 |
| Launch | 启动类型（FARGATE、EC2） |
| Strategy | 调度策略 |
| Cluster | 所属集群 |
| Task def | 任务定义 |
| Created | 创建日期 |

### ECS Tasks（`/inventory/ecs_task`）
高亮卡片显示 RUNNING 数量、Fargate 任务数量、每日成本合计（估算值）以及集群去重数量。成本是根据任务定义分配的 cpu/memory 计算出的静态估算值，详细计算方式请参见 [ECS Container Cost](../compute/ecs-container-cost)。

表格列：Task、Cluster、Group、Status、Launch、CPU、Memory、Cost/Day、Cost/Mo、AZ、Started。

## 使用方法

1. 在侧边栏中点击 **Compute > ECS Clusters / Services / Tasks** 中所需的路由
2. 通过顶部高亮卡片了解该资源的整体状况
3. 在 Services 页面比较 Desired 与 Running，在 Clusters 页面查看各集群的状态
4. 点击行以在详情面板中查看具体设置

## Fargate vs EC2 Launch Type

| 项目 | Fargate | EC2 |
|------|---------|-----|
| 基础设施管理 | 无服务器（AWS 托管） | 需要自行管理 |
| 成本 | 基于 vCPU/Memory | EC2 实例费用 |
| 扩缩容 | 自动 | 需要配置 Auto Scaling |
| 成本分析 | ECS Tasks 视图的 Cost/Day、Cost/Mo 列（静态估算值） | 不支持 |

## 使用技巧

:::tip 检查服务状态
在 Services 表格中，如果 Running 少于 Desired，任务部署可能存在问题。请检查任务失败的原因。
:::

:::tip 监控 Pending Tasks
如果 Pending Tasks 长时间未消退，可以怀疑存在资源不足或调度问题。
:::

:::info AI 分析
在 AI Assistant 中可以通过"ECS 集群列表"、"显示 Fargate 服务"、"帮我分析任务部署失败的原因"等进行分析。
:::

## 相关页面

- [ECR](../compute/ecr) - 容器镜像注册表
- [ECS Container Cost](../compute/ecs-container-cost) - ECS 任务成本分析
- [VPC](../network/vpc) - ECS 网络配置
