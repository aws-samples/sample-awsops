---
sidebar_position: 5
title: EKS Overview
description: 指定范围的 EKS 集群注册、节点资源和 Pod 状态
---

import Screenshot from '@site/src/components/Screenshot';

# EKS Overview

查看所选账户和区域范围内的 EKS 集群与 Kubernetes 资源。AWSops 以只读方式查询云端和集群资源；注册仅保存应用设置（ADR-005）。

<Screenshot src="/screenshots/compute/eks.png" alt="EKS Overview" />

## 主要功能

### 账户、区域和集群筛选

在顶部筛选器中选择账户和区域，再按集群或 VPC 缩小范围。支持多选。更改选项会刷新列表和汇总，不会注册其他集群。包含账户和区域的标识可区分同名集群。

:::info 观测范围
数量和图表描述的是所选范围内成功观测到的资源。页面会明确提示部分失败和查询上限，这些情况不能证明未观测到的资源不存在。目前，全区域发现覆盖已配置的区域以及已注册集群所在的区域；请缩小选择范围以查询特定区域。
:::

### 集群卡片与连接状态

卡片显示 Cluster Name、Status、Kubernetes Version、Account、Region、VPC ID 和 Platform Version。Connected **徽章**表示已配置默认 Entry 路径或已保存认证设置；它不会验证已保存的凭证，也不保证可达性。数量会在实时读取成功后显示。Connected **KPI** 统计显示范围内实时读取成功的集群数。

### 跨账户查询注册

1. 在 **Accounts** 中注册并启用目标账户，配置其区域，并在信任策略要求时提供 external ID。通常使用的目标角色是 `AWSopsReadOnlyRole`；该角色必须可由 web 任务承担，并获准读取 EKS 元数据。
2. 选择目标账户和区域。对于**成员账户**，默认元数据发现和 Kubernetes 令牌签名都使用该账户已注册的只读角色。宿主账户的集群仍以 web 任务角色作为默认身份。AWSops 不会向成员集群发送宿主任务角色的 bearer 令牌。
3. 集群所有者在该集群上为适用角色创建 `STANDARD` Access Entry，并关联所需的只读策略，例如指南中的 `AmazonEKSAdminViewPolicy`。对于成员集群，该角色是**已注册的成员角色**，而非宿主 web 任务角色。仅有旧的宿主主体 Entry 无法授权新的默认成员访问路径。
4. 选择**查询注册**。应用通过 `DescribeCluster` 直接验证所选集群，并检查对应的现有 Access Entry。它不会搜索宿主集群列表，也不会创建 AWS 资源。注册和详情导航会保留账户与区域信息。

页面显示的接入命令由所有者执行，应用不会执行。`make configure` → `eks.tf` 仍是宿主账户的 Terraform 资源配置路径。成员账户或非默认区域的集群，需要在所有者准备好访问权限后手动查询注册；宿主 EventBridge 观察器并不是自动注册成员集群的机制。

### 显式认证选项

- **ServiceAccount 令牌**：使用已在目标集群内授权的只读 SA 身份。其 Kubernetes 认证不需要 IAM Access Entry，但仍需要目标账户元数据发现权限和 API 服务器连通性。
- **AssumeRole**：使用 web 任务可以承担且目标 Kubernetes API 已授权的角色。对于成员集群，角色 ARN 必须属于同一成员账户；宿主或其他账户的角色会被拒绝。按需提供 external ID。默认部署授权承担 `AWSopsReadOnlyRole`；其他角色需要运维人员单独授权。

### 注册错误

`404` 表示找不到所选集群。`409` 表示所需的 Access Entry 不存在或无法验证。`403` 可能表示账户、区域或角色身份不被允许。`503` 表示发现服务或存储不可用。这些错误并不表示查询成功且集群列表为空。请核对显示的目标，并将其接入指南交给集群所有者。

### 实时资源与详情页面

- **Nodes / Pods / Deployments / Services** 分别打开对应范围的资源页面。
- 节点面板显示 capacity、allocatable 资源、请求量和 Pod 信息；请求比率表示预留量，而非实测 CPU/内存使用率。
- ENI 详情使用限定范围的 EC2 清单，并在可用时使用实例级 CloudWatch 流量数据。
- Pod 状态、命名空间、实例类型图表和 Warning Events 汇总观测数据。不可达集群仍会明确显示。
- 点击已连接卡片的标题可打开集群详情。OpenCost 状态、配置和资源请求会保留集群标识。

:::tip 访问与数据可用性
仅有已配置徽章不能证明令牌、只读策略或网络路径有效。请检查实际实时读取结果和失败提示。成员集群的默认模式应向已注册的成员角色授予访问权限，不要通过扩大宿主角色的集群访问权限来修复失败。
:::

## 相关页面

- [EKS 认证归档与现行指南入口](./eks-auth)
- [EKS Explorer](./eks-explorer)
- [EKS Nodes](./eks-nodes)
- [EKS Pods](./eks-pods)
- [EKS Deployments](./eks-deployments)
- [EKS Services](./eks-services)
- [EKS Container Cost](./eks-container-cost)
