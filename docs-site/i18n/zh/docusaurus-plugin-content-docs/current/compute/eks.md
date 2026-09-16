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
- 选择账户和区域
- 按 EKS 集群筛选
- 按 VPC 筛选
- 支持多选

切换账户或区域后，集群列表、统计和集群内资源会重新查询。请通过卡片上的 **Account** 和 **Region** 区分同名集群。

:::info 发现范围
页面显示的是所选范围中实际完成查询的结果。部分查询失败或达到获取上限时，结果并不完整。全区域（通配符）发现也仅覆盖已配置和已注册的区域，并不遍历 AWS 的所有区域。找不到集群时，请明确选择目标区域查询，不要把未显示理解为“集群不存在”。
:::

### EKS 集群卡片
以卡片形式显示每个集群的核心信息：
- Cluster Name、Status (ACTIVE)
- Kubernetes Version、VPC ID、Platform Version、Account、Region
- **Access Entry 状态徽章**：K8s Connected（绿色）/ 未注册（红色）
- **集群注册按钮（管理员）**：支持已注册且已启用的成员账户中的集群，可选择以下三种模式。
  - **Access Entry 查询注册（默认）**：检查目标集群中宿主 web 任务角色已有的 `STANDARD` Access Entry 后注册。所有者需预先创建 Entry 并关联只读的 `AmazonEKSAdminViewPolicy`。AWSops 不会在运行时新建 Entry 或其他 AWS 资源（ADR-005）。
  - **ServiceAccount 令牌**：保存所有者在目标集群中准备的只读 SA 令牌，用于 Kubernetes 认证。SA 认证不需要 IAM Access Entry，但获取成员账户的 EKS 元数据仍需要该账户中已注册的只读角色。
  - **显式 AssumeRole Kubernetes 认证**：指定角色 ARN，并按需提供 external ID。该角色必须可由 web 任务承担，且已获得目标集群内的读取权限。默认部署授权覆盖 `AWSopsReadOnlyRole`。输入校验并不强制使用这一个角色名，但其他角色仍需对应的 IAM 权限和信任配置，并非任意角色都能直接使用。
- **点击筛选**：点击集群卡片后仅筛选该集群（青色边框）

:::tip 集群访问权限
当已注册集群但无法从任何集群读取实时数据时，页面顶部会显示无法访问横幅，包含原始失败原因和本指南的链接。对于未连接的集群，请确认目标范围后配置查询注册 / SA 令牌 / AssumeRole。若查询注册返回 409，请将页面针对目标账户和区域生成的接入脚本交给集群所有者。
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
- **ENI 列表**：各网络接口的 IP 分配 + 实例网络流量磁贴（In/Out 字节·数据包 — 已完结的上一小时桶的累计与平均速率；CloudWatch 没有按 ENI 的维度，因此为实例级数值）
- **Pods 表格**：在该节点上运行的 Pod 列表

### 可视化图表

- **Pod Status Distribution**：Running、Pending、Failed、Succeeded 分布（饼图）
- **Pods per Namespace**：各命名空间的 Pod 数量（柱状图）

### Warning Events 表格
实时显示 Kubernetes Warning 事件：
- Kind、Object、Reason、Message、Count、Last Seen

## 跨账户接入

1. 在 **Accounts** 中注册并启用成员账户和目标区域，确保宿主 web 任务能够承担目标账户中已注册的只读角色。
2. 在 EKS 页面选择该账户和区域，并核对卡片上的 **Account** 和 **Region**。
3. 使用默认模式时，由集群所有者在目标账户和区域执行页面提供的命令，为**宿主 web 任务角色**创建 `STANDARD` Access Entry 并关联 `AmazonEKSAdminViewPolicy`。
4. 管理员点击**查询注册**。注册通过直接调用 `DescribeCluster` 确认目标集群，并保存应用内注册信息，不会创建 AWS 资源。

元数据查询使用目标账户中已注册的只读角色，但默认 Kubernetes bearer 令牌仍由宿主 web 任务角色的凭证签名。SA 令牌 / 显式 AssumeRole 是单独选择的 Kubernetes 认证覆盖配置，不能替代元数据查询权限。所有认证模式都要求 web 任务能够通过网络访问目标 Kubernetes API。

`make configure` → `eks.tf` 仅负责宿主侧的资源配置。对于成员账户或非部署区域，所有者执行命令后仍需手动查询注册，不能依赖 EventBridge 自动注册这些范围中的集群。

注册时，**404** 表示在所选目标账户和区域中找不到集群；**409** 表示默认模式所需的 Access Entry 缺失或无法确认；**503** 表示目标信息查询或注册存储不可用。不要把获取失败理解为正常的“0 个结果”。

## 使用方法

1. 在侧边栏中点击 **Compute > EKS**
2. 选择账户和区域，再点击集群卡片筛选特定集群
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
