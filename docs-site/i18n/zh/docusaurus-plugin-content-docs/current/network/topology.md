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

在顶部选择四个标签页之一：

| 视图 | 对象 | 用途 |
|----|------|------|
| **VPC 连接** | VPC 连接配置 | 查看 TGW 和对等连接 |
| **资源布局图（默认）** | 已保存的 AWS 资源 | 按 VPC 和子网筛选、翻页 |
| **基础设施地图** | 已保存的 AWS 资源 | 查看资源层级 |
| **K8s 地图** | EKS 工作负载 | Pod、Service、Ingress 和 Node 关系 |

### Infrastructure 视图

提供两种显示模式：

**Map View**
- 以 5 列布局展示资源层级
- External (IGW/TGW) → VPCs → Subnets → Compute → NAT
- 通过点击/搜索高亮相关资源

**Graph View**
- **资源布局图**是默认标签页，首先显示已保存资源最多的 VPC。
- 按 VPC、子网和资源类型筛选。自动选择 VPC 时，搜索会覆盖所有 VPC；手动选择的范围会保留。范围改变时，无效的子网和类型筛选会清除。
- 每页最多显示四个资源，窄屏每页显示一个。连接目标较多时会减少每页资源数并增加画布高度。使用上一页/下一页查看其余资源。
- 安全组连接默认隐藏，可通过复选框显示。每页保留所选资源的原始布局连接。
- 资源计数的分母是符合当前筛选条件的资源数。已保存的节点/边总数与收集警告单独显示。布局连接不能证明实际通信路径。

### 收集依据与读取状态

基础设施关系图和单个资源的关系图会在显示节点之外，单独显示收集依据。

- 源数据收集时间、上次成功收集时间与已保存图的时间代表不同事件。保留的旧结果、覆盖范围不完整和截断也会显示，但不能证明AWS当前的实时状态。
- 尚未记录收集状态是中性提示。空白图本身不能证明资源不存在，请检查收集状态。
- **刷新**会重新读取已保存的图，不会启动新的收集或重新生成图。
- 图读取不可用表示读取失败，与收集结果分开显示。刷新可用时可重试。会话过期时，请按照**登录**提示操作。访问被拒绝和请求被拒绝也会分别显示。
- 响应数量或遍历范围上限导致的截断，即使没有显示节点也会提示。这不代表显示范围之外的资源或连接不存在。


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

1. 选择**资源布局图**并指定 VPC、子网和资源类型。选择**所有 VPC**可包含没有已确认 VPC 的资源。
2. 输入搜索内容，使用**上一页资源**/**下一页资源**翻页。
3. 按需启用**显示安全组连接**。连接目标较多时会自动调整每页资源数和画布高度。
4. 使用缩放、平移和页面滚动检查连接，同时查看所选范围与收集状态。

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
