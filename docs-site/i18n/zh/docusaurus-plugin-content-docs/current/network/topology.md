---
sidebar_position: 4
title: Topology
description: 基于 React Flow 的 AWS 基础设施与 Kubernetes 集群可视化
---

import Screenshot from '@site/src/components/Screenshot';

# Topology

用于以可视化方式探索 AWS 基础设施与 Kubernetes 集群之间关系的页面。

<Screenshot src="/screenshots/network/topology.png" alt="Topology" />

## 主要功能

### 视图切换

通过顶部开关在两种视图之间切换：

| 视图 | 对象 | 用途 |
|----|------|------|
| **Infrastructure** | AWS 资源 | 可视化 VPC、EC2、RDS、ELB 等的关系 |
| **Kubernetes** | EKS 工作负载 | Pod、Service、Ingress、Node 的关系 |

### Infrastructure 视图

提供两种显示模式：

**Map View（默认）**
- 以 5 列布局展示资源层级
- External (IGW/TGW) → VPCs → Subnets → Compute → NAT
- 通过点击/搜索高亮相关资源

**Graph View**
- 基于 React Flow 的节点-边图
- 拖拽移动节点
- 通过缩放/平移进行探索
- 使用 MiniMap 查看整体结构

### Kubernetes 视图

以 4 列资源图展示 EKS 工作负载：

| 列 | 资源 | 说明 |
|------|--------|------|
| **Ingress** | K8s Ingress | 外部流量入口 |
| **Services** | K8s Service | 负载均衡、ClusterIP/NodePort/LoadBalancer |
| **Pods** | K8s Pod | 正在运行的容器 |
| **Nodes** | EKS Node | 工作节点（EC2） |

### 交互功能

**搜索**
- Infrastructure：按 EC2、Subnet、VPC 的名称/ID/CIDR 搜索
- Kubernetes：搜索 Pod、Service、Namespace
- 自动高亮匹配的资源及其关联资源

**点击选择**
- 点击资源进行选择
- 高亮所选资源及与其相连的所有资源
- 再次点击可取消选择

**Graph View 专属**
- 鼠标滚轮：放大/缩小
- 拖拽：移动画布
- 拖拽节点：调整节点位置
- Controls：重置缩放、适配屏幕
- MiniMap：预览整体结构

## 使用方法

### 了解基础设施结构

1. 选择 **Infrastructure** 视图
2. 使用 **Map View** 查看层级结构
3. 理清 VPC → Subnet → EC2 的流向
4. 通过 IGW/TGW 确认外部连接

### 追踪特定资源

1. 在搜索框中输入资源名称/ID
2. 查看高亮显示的匹配资源
3. 关联的 VPC、Subnet 也会一并高亮
4. 使用 "Clear search" 按钮重置

### 分析 K8s 流量走向

1. 选择 **Kubernetes** 视图
2. 确认 Ingress → Service → Pod → Node 的流向
3. 点击 Service 查看关联的 Pod
4. 通过搜索追踪特定工作负载

### 使用 Graph View

1. 在 Infrastructure 视图中选择 **Graph View**
2. 渲染 React Flow 图
3. 拖拽节点调整布局
4. 使用 MiniMap 查看整体结构

## 使用技巧

:::tip 追踪网络路径
要追踪从特定 EC2 到外部互联网的路径：
1. 在搜索框中输入 EC2 名称
2. 确认高亮显示的 Subnet
3. 确认该 Subnet 是连接到 NAT Gateway 还是 IGW
4. Private Subnet 走 NAT 路径，Public Subnet 走 IGW 路径
:::

:::tip 调试 K8s Service
解决 "Service 没有关联的 Pod" 问题：
1. 在 Kubernetes 视图中点击 Service
2. 查看关联的 Pod（若为 0 pods 则存在问题）
3. 确认 Pod 的 labels 与 Service 的 selector 是否匹配
4. 若存在 Pod，则追踪至 Node 查看资源状态
:::

:::info 颜色图例
| 颜色 | Infrastructure | Kubernetes |
|------|---------------|------------|
| Cyan | VPC, IGW | Ingress |
| Green | Subnet | Node |
| Purple | EC2 | Pod |
| Pink | ELB | - |
| Orange | RDS, NAT | Service |
| Red | TGW | - |

地图上方信息行中的图例仅显示当前图中存在的类型。卡片名称旁的状态点也会出现在图例中 — **ok**（绿）/ **warn**（橙）/ **bad**（红）/ **neutral**（灰）。
:::

## 相关页面

- [VPC](../network/vpc) - VPC 详细信息与资源图
- [EKS Overview](../compute/eks) - EKS 集群详情
- [EC2](../compute/ec2) - EC2 实例详细信息
