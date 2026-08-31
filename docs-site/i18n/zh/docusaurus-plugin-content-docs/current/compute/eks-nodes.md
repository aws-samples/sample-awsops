---
sidebar_position: 8
title: EKS Nodes
description: Kubernetes 节点列表、容量、已分配资源、状态
---

import Screenshot from '@site/src/components/Screenshot';

# EKS Nodes

用于详细查看 Kubernetes 节点的容量、可分配资源和 Pod 请求量的页面。

<Screenshot src="/screenshots/compute/eks-nodes.png" alt="EKS Nodes" />

## 主要功能

### 统计卡片
- **Total Nodes**：全部节点数量（青色）
- **Ready**：Ready 状态的节点数量（绿色）
- **Total CPU**：全部 vCPU 容量总和（紫色）
- **Total Memory**：全部内存容量总和（橙色）

### CPU Usage per Node 图表
以三段式柱状图显示各节点的 CPU 资源状态：
- **Requested**（青/橙/红）：Pod 请求的 CPU
- **Available**（绿色半透明）：还可分配的 CPU
- **System Reserved**（灰色）：系统预留的 CPU

按每个节点显示：
- 节点名称、Pod 请求量 / 总容量、百分比
- Pod 数量、请求 vCPU、可用 vCPU、预留 vCPU

### Memory Usage per Node 图表
以相同的三段式柱状图显示各节点的 Memory 资源状态：
- **Requested**（紫/橙/红）：Pod 请求的 Memory
- **Available**（绿色半透明）：还可分配的 Memory
- **System Reserved**（灰色）：系统预留的 Memory

### 容量图表
- **CPU Capacity per Node (vCPU)**：各节点 CPU 容量柱状图
- **Memory Capacity per Node (GiB)**：各节点内存容量柱状图

### 节点表格
| 列 | 说明 |
|------|------|
| Name | 节点名称 |
| Status | Ready / NotReady |
| CPU Capacity | 全部 CPU 容量 |
| Memory Capacity | 全部内存容量 |
| Allocatable CPU | 可分配的 CPU |
| Allocatable Memory | 可分配的内存 |
| Created | 创建时间 |

## 理解资源概念

![节点资源层级](/diagrams/eks-node-resources.png)

| 术语 | 说明 |
|------|------|
| Capacity | 节点的全部物理资源 |
| Allocatable | 可分配给 Pod 的资源（Capacity - System Reserved） |
| Requested | 当前所有 Pod 请求的资源总和 |
| Available | 还可继续分配的资源（Allocatable - Requested） |
| System Reserved | 为 kubelet、OS 等系统预留的资源 |

## 使用方法

1. 在侧边栏中点击 **Compute > K8s > Nodes**
2. 通过统计卡片了解节点整体状况
3. 在 CPU/Memory Usage 图表中识别资源使用率较高的节点
4. 对使用率 80% 以上（红色）的节点考虑扩容
5. 在表格中查看每个节点的详细容量

## 使用技巧

:::tip 资源使用率阈值
- **80% 以上（红色）**：需立即处理 - 添加节点或重新调度 Pod
- **50-80%（橙色）**：需监控 - 关注增长趋势
- **50% 以下（青/紫）**：正常 - 有富余资源
:::

:::tip Available vs Capacity
Available 可能为负数。这表示 Pod 只设置了 Request 而未设置 Limit，处于超额分配（overcommit）状态。
:::

:::info AI 分析
在 AI Assistant 中可以通过"节点资源使用量"、"CPU 使用率 80% 以上的节点"、"帮我分析是否需要节点扩容"等进行分析。
:::

## 相关页面

- [EKS Overview](../compute/eks) - 集群整体概况
- [EKS Pods](../compute/eks-pods) - 查看 Pod 状态
- [EC2](../compute/ec2) - 节点对应的 EC2 实例
- [EKS Container Cost](../compute/eks-container-cost) - 节点/Pod 成本分析
