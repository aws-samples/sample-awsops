---
sidebar_position: 3
title: ECS
description: ECS 集群、服务、任务监控
---

import Screenshot from '@site/src/components/Screenshot';

# ECS (Elastic Container Service)

用于监控 ECS 集群、服务和任务状态的页面。

:::info v2 中的呈现方式
v1 曾在一个页面中统一监控集群/服务/任务。v2 以 3 个独立的清单路由为主（`/inventory/ecs_cluster`、`/inventory/ecs_service`、`/inventory/ecs_task` —— 各自拥有表格、筛选器和详情面板），并新增了**统一概览页 `/inventory/ecs`**（侧边栏「ECS 概览」），在一个屏幕上展示摘要 KPI（集群/服务/任务数 + 低于期望数的任务）、集群表格和服务表格。概览是只读速览层 —— 搜索/分面/详情在三个类型页面上，可通过各表头的「查看全部」跳转。达到或超过 500 行会标注为样本（样本或服务同步的最近一次 run 非成功状态时，会暂缓基于服务的 running/desired·未达任务汇总；任务数 KPI 来自单独的全量 summary 汇总，并由 ecs_task 同步 run 状态把关），同步未处于成功状态时会显示对应状态的提示（失败=过期数据提示、部分采集、进行中），未采集时显示「尚未采集」。
:::

<Screenshot src="/screenshots/compute/ecs.png" alt="ECS" />

## 主要功能

### ECS Clusters（`/inventory/ecs_cluster`）
高亮卡片显示专用 KPI 面板 —— ACTIVE 集群数、运行中任务总数、活跃服务总数、容器实例总数 —— 以及按运行中任务数排名的 Top-N 柱状图。

表格列：
| 列 | 说明 |
|------|------|
| Status | 状态（ACTIVE、INACTIVE） |
| Running | 运行中的任务数量 |
| Pending | 等待中的任务数量 |
| Services | 活跃服务数量 |
| Instances | 已注册容器实例数量 |
| MTD Cost ($) | 本月至今累计成本 |

详情面板：Identity（Name、Account、Region、ARN）/ Tasks & Services / Config（Settings、Container Insights 等）/ Tags 各部分。Settings 以逐项标签–值行显示（如 containerInsights disabled）。

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
