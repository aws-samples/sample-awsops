---
sidebar_position: 7
title: EKS Pods
description: Kubernetes Pod 列表、状态、容器信息
---

import Screenshot from '@site/src/components/Screenshot';

# EKS Pods

用于查看 Kubernetes Pod 详细列表和状态的页面。

<Screenshot src="/screenshots/compute/eks-pods.png" alt="EKS Pods" />

## 主要功能

### 统计卡片
- **Total Pods**: 全部 Pod 数量（青色）
- **Running**: 正在运行的 Pod 数量（绿色）
- **Pending**: 等待中的 Pod 数量（橙色）
- **Failed**: 失败的 Pod 数量（红色）

### Pod Status Distribution 图表
以饼图可视化各状态的 Pod 分布：
- **Running**: 正常运行中
- **Pending**: 等待调度或正在拉取镜像
- **Failed**: 运行失败
- **Succeeded**: 已完成（Job 等）

### Pod 列表表格
| 列 | 说明 |
|------|------|
| Name | Pod 名称 |
| Namespace | 命名空间 |
| Status | 状态（StatusBadge） |
| Node | 运行所在的节点 |
| Created | 创建时间 |

### 各状态颜色
- **Running**: 绿色
- **Pending**: 橙色
- **Failed**: 红色
- **Succeeded**: 青色
- **Unknown**: 灰色

## 使用方法

1. 在侧边栏点击 **Compute > K8s > Pods**
2. 在统计卡片中查看整体 Pod 状态分布
3. 如有 Pending 或 Failed Pod，调查其原因
4. 在表格中确认特定 Pod 的节点分布

## 理解 Pod 状态

| 状态 | 说明 | 处理措施 |
|------|------|------|
| Pending | 等待调度、镜像拉取中、资源不足 | 检查节点资源、镜像访问权限 |
| Running | 正常运行中 | - |
| Succeeded | 已完成（Job、CronJob） | 正常结束 |
| Failed | 容器异常终止 | 查看日志、检查资源限制 |
| Unknown | 节点通信问题 | 检查节点状态 |

## 使用技巧

:::tip Pending Pod 诊断
如果 Pending 状态持续较长时间，请检查以下事项：
- 节点资源不足（CPU/Memory）
- 镜像拉取失败（imagePullBackOff）
- 等待 PVC 绑定
- nodeSelector/affinity 条件不满足
:::

:::tip Failed Pod 分析
对于 Failed Pod，请查看容器日志和事件：
- OOMKilled: 超出内存限制
- CrashLoopBackOff: 反复崩溃
- Error: 应用程序错误
:::

:::info AI 分析
在 AI Assistant 中可以通过"Pending Pod 列表"、"Failed Pod 原因分析"、"特定命名空间 Pod 状态"等方式进行分析。
:::

## 相关页面

- [EKS Overview](../compute/eks) - 集群整体状况
- [EKS Nodes](../compute/eks-nodes) - 查看节点资源
- [EKS Explorer](../compute/eks-explorer) - 详细资源探索
- [EKS Container Cost](../compute/eks-container-cost) - Pod 成本分析
