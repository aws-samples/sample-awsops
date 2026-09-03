---
sidebar_position: 5
title: EKS Overview
description: EKS 集群概况、节点资源、Pod 状态摘要
---

import Screenshot from '@site/src/components/Screenshot';

# EKS Overview

用于一站式查看 EKS 集群整体概况、节点资源和 Pod 状态的页面。

<Screenshot src="/screenshots/compute/eks.png" alt="EKS Overview" />

## 主要功能

### 集群筛选
- 按 EKS 集群筛选
- 按 VPC 筛选
- 支持多选

### EKS 集群卡片
以卡片形式显示每个集群的核心信息：
- Cluster Name、Status (ACTIVE)
- Kubernetes Version、VPC ID、Platform Version、Region
- **Access Entry 状态徽章**：K8s Connected（绿色）/ 未注册（红色）
- **集群注册按钮（管理员）**：以三种模式注册未连接的集群 — Access Entry 查询注册（确认已存在的 Access Entry 后注册 — 运行时绝不新建 Access Entry [ADR-005]；不存在时返回 409 并给出 Terraform/CLI 上线脚本）、ServiceAccount 令牌（在集群内创建只读 SA 并粘贴其令牌 — 无需 AWS 侧配置）、AssumeRole（通过已在该集群持有 Access Entry 的 IAM 角色进行 K8s 认证 — 角色 ARN + external ID；角色名必须为 `AWSopsReadOnlyRole`[web 任务的 sts:AssumeRole 权限固定为该名称]，且集群本身必须属于宿主账户，注册路由会按宿主账户的集群列表校验）。Terraform 路径为 `make configure` 的 EKS 多选 → `eks.tf` 为 web 任务角色授予 Access Entry + AmazonEKSAdminViewPolicy
- **点击筛选**：点击集群卡片后仅筛选该集群（青色边框）

:::tip 集群访问权限
当已注册集群但无法从任何集群读取实时数据时，页面顶部会显示无法访问横幅，包含原始失败原因和本指南的链接。未连接的集群无法查询数据 — 请通过集群注册按钮（查询注册 / SA 令牌 / AssumeRole）或 Terraform 上线（`make configure` → `eks.tf`）进行连接。若查询注册返回 409，将屏幕上显示的上线脚本交给集群所有者即可。
:::

### 统计卡片（点击跳转）
点击每个卡片可跳转到详情页面：
- **Nodes** → 节点详情（`/eks/nodes`）
- **Pods** → Pod 详情（`/eks/pods`）
- **Deployments** → 部署详情（`/eks/deployments`）
- **Services** → 服务详情（`/eks/services`）

### 节点卡片网格
以可视化方式显示每个节点的资源使用量：
- 节点名称、Pod 数量、状态（Ready/NotReady）
- **CPU 使用量条**：Pod 请求量 / 总容量（百分比）
- **Memory 使用量条**：Pod 请求量 / 总容量（百分比）
- 80% 以上：红色，50% 以上：橙色，其他：青色/紫色

### 节点详情视图
点击节点卡片可跳转到详情页面：
- **CPU/Memory/Pod Info 卡片**：Capacity、Allocatable、Requested、Available
- **ENI 列表**：各网络接口的 IP 分配
- **Pods 表格**：在该节点上运行的 Pod 列表

### 可视化图表

- **Pod Status Distribution**：Running、Pending、Failed、Succeeded 分布（饼图）
- **Pods per Namespace**：各命名空间的 Pod 数量（柱状图）

### Warning Events 表格
实时显示 Kubernetes Warning 事件：
- Kind、Object、Reason、Message、Count、Last Seen

## 使用方法

1. 在侧边栏中点击 **Compute > EKS**
2. 点击集群卡片筛选特定集群
3. 点击统计卡片跳转到 Pods/Nodes/Deployments/Services 详情页面
4. 在节点卡片中识别资源使用率较高的节点
5. 点击节点查看详细资源和 Pod 列表
6. 通过 Warning Events 监控问题事件

## 使用技巧

:::tip 节点资源监控
如果节点卡片的 CPU/Memory 条显示为红色（80% 以上），则存在资源不足的风险。请考虑添加节点或重新调度 Pod。
:::

:::tip ENI IP 使用量
在节点详情视图中，如果某个 ENI 的 IP Slots Used 接近 15/15，新 Pod 的调度可能会失败。
:::

:::info AI 分析
在 AI Assistant 中可以通过"EKS 集群状态"、"各节点 CPU 使用量"、"帮我分析 Warning 事件"等进行分析。
:::

## 相关页面

- [EKS 认证设置](./eks-auth) - Access Entry / aws-auth 认证指南
- [EKS Explorer](./eks-explorer) - K9s 风格终端 UI
- [EKS Pods](./eks-pods) - Pod 详细列表
- [EKS Nodes](./eks-nodes) - 节点详细列表
- [EKS Deployments](./eks-deployments) - 部署列表
- [EKS Services](./eks-services) - 服务列表
- [EKS Container Cost](./eks-container-cost) - Pod 成本分析（OpenCost）
