---
sidebar_position: 9
title: EKS Deployments
description: Kubernetes Deployment 列表、副本状态、更新策略
---

import Screenshot from '@site/src/components/Screenshot';

# EKS Deployments

用于查看 Kubernetes Deployment 副本状态和可用性的页面。

<Screenshot src="/screenshots/compute/eks-deployments.png" alt="EKS Deployments" />

## 主要功能

### 统计卡片
- **Total Deployments**: 全部 Deployment 数量（青色）
- **Fully Available**: 期望副本全部可用的 Deployment 数量（绿色）
- **Partially Available**: 仅部分副本可用的 Deployment 数量（橙色）

### Replica Comparison 图表
直观对比 Desired 与 Available 副本：
- **青色半透明条**: Desired（期望副本数）
- **绿色条**: Available（实际可用副本数）
- 每个 Deployment 显示 `available/desired` 数值

### Deployment 表格
| 列 | 说明 |
|------|------|
| Name | Deployment 名称 |
| Namespace | 命名空间 |
| Desired | 期望副本数 |
| Available | 可用副本数 |
| Ready | Ready 状态的副本数 |
| Created | 创建时间 |

## 理解副本状态

| 状态 | 说明 | 处理措施 |
|------|------|------|
| Desired = Available = Ready | 完全正常 | - |
| Available < Desired | 部分 Pod 不可用 | 检查 Pod 状态 |
| Ready < Available | 健康检查失败 | 查看应用程序日志 |
| Available = 0 | 所有 Pod 不可用 | 需要紧急处理 |

## 使用方法

1. 在侧边栏点击 **Compute > K8s > Deployments**
2. 在统计卡片中查看 Partially Available 数量
3. 在 Replica Comparison 图表中识别有问题的 Deployment
4. 在表格中确认详细的副本数量

## Deployment 更新策略

### RollingUpdate（默认）
- 逐步创建新版本 Pod 并终止旧版本
- `maxSurge`: 可同时额外创建的 Pod 数量
- `maxUnavailable`: 可同时不可用的 Pod 数量

### Recreate
- 先终止所有旧版本 Pod，再创建新版本
- 会产生停机时间，用于防止资源冲突的场景

## 使用技巧

:::tip Partially Available 诊断
如果 Available 少于 Desired：
1. 检查 Pod 状态（Pending、Failed）
2. 确认节点资源是否不足
3. 检查镜像拉取错误
4. 确认 Readiness Probe 是否失败
:::

:::tip 滚动发布监控
部署过程中 Available 可能暂时低于 Desired。如果部署完成后仍有差异，则说明存在问题。
:::

:::info AI 分析
在 AI Assistant 中可以通过"Deployment 状态"、"找出副本不一致的 Deployment"、"分析部署失败原因"等方式进行分析。
:::

## 相关页面

- [EKS Overview](../compute/eks) - 集群整体状况
- [EKS Pods](../compute/eks-pods) - 查看 Deployment 的 Pod
- [EKS Explorer](../compute/eks-explorer) - 查看 ReplicaSet 详情
- [EKS Services](../compute/eks-services) - 关联 Deployment 的 Service
