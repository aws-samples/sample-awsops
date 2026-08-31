---
sidebar_position: 2
title: EKS / Kubernetes
description: 以只读方式查看 EKS 集群舰队与集群内资源
---

import Screenshot from '@site/src/components/Screenshot';

# EKS / Kubernetes

此页面可以只读方式一目了然地查看 EKS 集群舰队与集群内部资源。

<Screenshot src="/screenshots/resources/eks.png" alt="EKS 集群舰队" />

## 主要功能

### KPI 卡片
以顶部卡片展示整个舰队的核心指标。

| 卡片 | 含义 |
|------|------|
| **Clusters** | 账户中发现的集群总数 |
| **Connected** | 已连接查询（可采集数据）的集群数 |
| **Nodes** | 已连接集群的节点合计（显示 `ready` 数量） |
| **Pods** | Pod 合计（显示 `running` 数量） |
| **Deployments** | Deployment 合计 |
| **Services** | Service 合计 |

### 集群卡片
每个集群以一张卡片显示 **Status**、**Version**、**Region**、**VPC**、**Platform** 信息。连接状态以徽章区分。

- **Connected**：查询已连接，可显示节点/Pod/Deployment 数量（点击卡片标题可进入详情）
- **有 Entry**：存在 Access Entry 但尚未注册查询
- **未连接**：没有 Access Entry，无法查询
- **无法确认**：无法判别访问状态

要查询已连接的集群，需要 **EKS Access Entry**。管理员可以**注册/解除**查询访问，或查看可直接应用到集群的**入驻脚本**。AWSops 不会变更集群，所有操作均为只读。

### 舰队资源摘要
存在已连接的集群时，卡片下方会出现额外的可视化内容。

- **节点资源**：各节点的 **CPU / Mem / Disk** 使用量仪表（以 Pod 请求合计相对节点 allocatable 为基准）
- **Pod Status / Instance Types / Pods per Namespace** 图表
- **Warning Events** 表格（按最新顺序显示最近的集群警告）

### 集群详情
点击集群卡片可进入详情界面（`/eks/<cluster>`）。提供 **Nodes / Pods / Deployments / Services / Events / Diagnosis** 标签页，可通过搜索框和命名空间过滤器缩小范围。点击行会打开详情面板。

<Screenshot src="/screenshots/resources/eks-cluster.png" alt="集群详情（Nodes 标签页 + OpenCost）" />

- **OpenCost 面板**：检测安装状态，并提供 **values.yaml** / **install.sh** 下载，供用户直接应用到自己的集群（只读 — AWSops 不会写入集群）。管理员可保存 Chart 版本和 values override。
- **Diagnosis 标签页**：基于 K8sGPT 的诊断，即使启用也是只读。将确定性分析结果（FACT）与 AI 假设分开展示，AI 假设需经验证后再采取措施。

## 使用方法
1. 在侧边栏 **Compute** 分组中点击 **EKS**
2. 通过顶部 KPI 卡片确认舰队规模和连接状态
3. 点击 **Connected** 集群卡片的标题进入详情
4. 在详情中切换标签页查看 **Nodes / Pods / Deployments / Services / Events / Diagnosis**
5. 在搜索框输入关键词或使用命名空间过滤器缩小范围
6. 点击行，在详情面板中查看全部属性
7. 如有需要，从 **OpenCost 面板**下载 **values.yaml** / **install.sh** 自行安装

:::tip 快速搜索
搜索框中只输入名称的一部分即可。命名空间过滤器可在 **Pods / Deployments / Services** 标签页中配合使用。
:::

:::info 连接条件
集群要显示为 **Connected**，需要 **EKS Access Entry**。未连接的集群会一并提供入驻脚本，注册/解除仅限管理员执行。显示的时刻以 KST（Asia/Seoul）为准。
:::

## AI 分析技巧
可以在浮动按钮（ChatDrawer）或 **Assistant** 页面提出如下问题。

- "帮我找出重启次数多的 Pod"
- "CPU 请求率最高的节点是哪个？"
- "解释一下最近 Warning 事件的原因"
- "有没有可用副本不足的 Deployment？"

## 相关页面
- [资源清单](./inventory) - 账户全量资源清单
- [拓扑](./topology) - 资源连接关系可视化
