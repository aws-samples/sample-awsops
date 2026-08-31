---
sidebar_position: 12
title: EKS Container Cost
description: EKS Pod 成本分析、OpenCost 集成、CPU/Memory/Network/Storage/GPU 5 项成本列
---

import Screenshot from '@site/src/components/Screenshot';

# EKS Container Cost

用于分析 EKS Pod 成本的页面。支持两种数据源：OpenCost（默认）或基于 Request 的估算（回退）。

<Screenshot src="/screenshots/compute/eks-container-cost.png" alt="EKS Container Cost" />

## 主要功能

### 数据源显示
页面顶部会显示当前数据源：
- **绿色**: OpenCost (Prometheus) - 基于实际用量，CPU + Memory + Network + Storage + GPU
- **黄色**: Request-based estimation - 仅 CPU + Memory（建议安装 OpenCost）

### 统计卡片
- **Pod Cost (Daily)**: 每日 Pod 总成本（青色）
- **Pod Cost (Monthly)**: 月度估算成本（绿色）
- **Running Pods**: 运行中 Pod 数量 / 节点数量（紫色）
- **Top Namespace**: 成本最高的命名空间（橙色）

### Namespace Cost Distribution 图表
以饼图显示各命名空间的每日成本分布

### Node Daily Cost + Pod Count 图表
以双轴条形图显示各节点的每日成本和 Pod 数量

### Pods 标签页
| 列 | 说明 |
|------|------|
| Namespace | 命名空间 |
| Pod | Pod 名称 |
| Node | 节点名称 |
| CPU | CPU 成本 |
| Memory | Memory 成本 |
| Network* | 网络成本（仅 OpenCost） |
| Storage* | 存储成本（仅 OpenCost） |
| GPU* | GPU 成本（仅 OpenCost） |
| Total/Day | 每日总成本 |

*仅在 OpenCost 模式下显示

### Nodes 标签页
| 列 | 说明 |
|------|------|
| Node | 节点名称 |
| Instance Type | EC2 实例类型 |
| Hourly Rate | 每小时成本 |
| Daily Cost | 每日成本 |
| Pods | Pod 数量 |

## 数据源指示横幅

页面顶部以彩色横幅显示当前使用的计算方式：

| 横幅颜色 | 条件 | 消息 |
|----------|------|--------|
| 🟢 绿色 | `data.dataSource === 'opencost'` | "OpenCost (Prometheus) — Actual usage-based cost: CPU + Memory + Network + Storage + GPU" |
| 🟡 黄色 | `dataSource !== 'opencost'` | "Request-based estimation — CPU + Memory only. Install OpenCost for full cost data: scripts/07-setup-opencost.sh" |

横幅下方的卡片底部标签也会注明相同的来源：
- `Source: OpenCost (Prometheus actual usage × AWS pricing)` 或
- `Source: Request-based (Pod request ratio × EC2 node cost)`

## 标签页 — Pods vs Nodes

页面有 **Pods** / **Nodes** 两个标签页（`activeTab: 'pods' | 'nodes'`）。

| 标签页 | 标签颜色 | 内容 |
|----|---------|------|
| `pods` | cyan | 各 Pod 的 CPU/Memory(/Network/Storage/GPU) 成本 — 支持按命名空间/节点筛选 |
| `nodes` | purple | 各节点的实例类型、每小时单价、每日成本、Pod 数量 |

切换标签页时数据会被缓存，不会产生额外的调用。

## 两种成本计算方式

### Method A: Request-based（默认）
按 Pod 的资源请求比例分摊节点成本：
```
CPU Ratio = Pod CPU Request / Node Allocatable CPU
Memory Ratio = Pod Memory Request / Node Allocatable Memory
Pod Daily Cost = (CPU Ratio x 0.5 + Memory Ratio x 0.5) x Node Hourly Rate x 24h
```

**支持项目**: 仅 CPU、Memory
**数据源**: Steampipe kubernetes_pod, kubernetes_node

### Method B: OpenCost (Prometheus)
将实际用量指标与 AWS 价格信息相结合：
```
CPU Cost = Actual CPU Usage (cores) x AWS EC2 vCPU Price
Memory Cost = Actual Memory Usage (bytes) x AWS EC2 Memory Price
Network Cost = Cross-AZ/Region Transfer x Data Transfer Price
Storage Cost = PVC Provisioned Size x EBS Volume Price
Pod Total Cost = CPU + Memory + Network + Storage + GPU
```

**支持项目**: CPU、Memory、Network、Storage、GPU（5 项）
**数据源**: Prometheus + Metrics Server

## 安装 OpenCost

```bash
bash scripts/07-setup-opencost.sh
```

安装后在 `data/config.json` 中设置 `opencostEndpoint`，即可自动切换到 OpenCost 模式。

## 使用方法

1. 在侧边栏点击 **Compute > EKS Container Cost**
2. 在顶部横幅中确认数据源
3. 在统计卡片中了解整体成本状况
4. 在图表中识别成本较高的命名空间/节点
5. 切换 Pods/Nodes 标签页查看详细成本
6. 展开 "Cost Calculation Basis" 部分查看计算依据

## EC2 价格参考（ap-northeast-2，On-Demand）

| Instance Type | Hourly Rate |
|---------------|-------------|
| m5.large | $0.118 |
| m5.xlarge | $0.236 |
| m6g.large | $0.100 |
| c5.xlarge | $0.196 |
| r5.large | $0.152 |
| t3.large | $0.104 |
| t4g.large | $0.086 |

## 使用技巧

:::tip 建议安装 OpenCost
基于 Request 的方式仅考虑资源请求，与实际用量存在差异。安装 OpenCost 后可以精确分析 5 项成本项目。
:::

:::tip 没有 Request 的 Pod
没有资源请求的 Pod 在 Request 模式下会显示为 $0.00。作为最佳实践，请为所有 Pod 设置资源请求。
:::

:::tip Network Cost (OpenCost)
OpenCost 的 Network 成本仅包含 Cross-AZ 传输。同一 AZ 内的传输免费。
:::

:::info AI 分析
在 AI Assistant 中可以通过"EKS Pod 成本分析"、"按命名空间比较成本"、"成本优化方案"等方式进行分析。
:::

## 相关页面

- [EKS Overview](../compute/eks) - 集群整体状况
- [EKS Nodes](../compute/eks-nodes) - 节点资源状态
- [ECS Container Cost](../compute/ecs-container-cost) - ECS Fargate 成本
- [Cost](../monitoring/cost) - 整体 AWS 成本分析
