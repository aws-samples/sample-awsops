---
sidebar_position: 4
title: Cost Explorer
description: 按服务、按天、按月分析 AWS 成本并掌握趋势。
---

import Screenshot from '@site/src/components/Screenshot';

# Cost Explorer

从多种视角分析并可视化 AWS 成本数据的页面。

<Screenshot src="/screenshots/monitoring/cost.png" alt="Cost" />

## 数据可用性 & 快照回退

页面加载时会自动检查 Cost Explorer API 的可用性，不可用时回退到本地快照。

### 3 阶段加载流程
1. **Cost 可用性检查** → `/awsops/api/steampipe?action=cost-check`
2. 可用时执行实时查询（Cost Explorer API → Steampipe）
3. 实时查询失败时 → 调用 `/awsops/api/steampipe?action=cost-snapshot&accountId={id}`，加载 `data/cost/` 下的最后一次缓存

### UI 状态

| 状态 | 显示 |
|------|------|
| 实时 OK | 正常界面（无横幅） |
| 快照回退 | 黄色横幅：`Last fetched: {snapshotDate}` |
| 全部失败 | 红色横幅："No cached cost snapshots available. Visit this page when Cost Explorer is accessible to build a local cache." |

:::info MSP 自动检测
如果 Host 账户处于 MSP（Managed Service Provider）环境，Cost Explorer API 可能已被禁用 — `02-setup-nextjs.sh` 会在安装时检测到并设置为 `costEnabled: false`。这种情况下页面会立即进入快照回退或空状态。
:::

:::tip 快照自动构建
每次实时查询成功时，结果会自动保存到 `data/cost/{accountId}.json`。这是一个安全机制，即使在 MSP 环境或权限暂时缺失的情况下，也能继续用上一次的数据进行查询。
:::

## 主要功能

### 成本摘要
- **This Month**: 本月累计成本
- **Last Month**: 上月总成本
- **Projected**: 月末预计成本（按当前日期估算）
- **Daily Avg**: 日均成本
- **MoM Change**: 环比变化率
- **Services**: 产生成本的服务数

### 期间筛选
| 选项 | 说明 |
|------|------|
| This Month | 仅本月 |
| 3 Months | 最近 3 个月 |
| 6 Months | 最近 6 个月 |
| 1 Year | 最近 1 年 |

### 服务筛选
可以仅选择特定服务进行分析。选择多个服务时，会显示这些服务的合计。

### 可视化
- **Daily Cost Trend**: 最近 30 天的每日成本趋势
- **Monthly Cost Trend**: 月度成本趋势
- **Cost by Service (Top 8)**: 前 8 个服务的占比饼图
- **Top 10 Services**: 前 10 个服务的柱状图

### 服务详情
点击服务行后，可在滑出面板中查看：
- 各服务总成本
- 月度成本趋势折线图
- 月度详细明细

## 使用方法

1. **选择期间**: 选择要分析的期间（1m、3m、6m、12m）
2. **服务筛选**: 使用 Services 按钮仅筛选特定服务
3. **查看图表**: 查看成本趋势及各服务分布
4. **详细分析**: 点击服务行查看月度详情

:::tip MSP 环境自动检测
在 Managed Service Provider（MSP）环境中，Cost Explorer API 的访问可能受限。AWSops 会自动检测并显示替代数据。
:::

## 使用技巧

### 定位成本激增原因
1. 如果 MoM Change 较高（>10%），在服务表格中查看 Change 列
2. 点击 Change 超过 20% 的服务，查看月度趋势
3. 如果在特定月份激增，检查该期间的资源变更历史

### 预算管理
通过 Projected 值确认月末预计成本。如果可能超出预算：
- 清理未使用的资源
- 评估 Reserved Instance/Savings Plans
- 优化资源规格

### 识别成本优化对象
请在 Share 列中优先将成本占比高的服务作为优化对象进行评估。

:::info 不支持 Cost Explorer 的环境
在 Cost Explorer 被禁用的环境中会显示快照数据。将显示 "Showing cached data" 横幅，并同时显示最后一次缓存的时间。
:::

### costEnabled 开关
可通过侧边栏底部的 **Cost** 开关启用或禁用 Cost Explorer 功能。在 MSP 环境等场景下如需减少 API 调用，请禁用它。

## AI 分析技巧

在 AI 助手中利用 Cost Gateway（11 个工具）的提问示例：

- "分析本月成本增加的原因"
- "推荐 EC2 成本优化方案"
- "计算转换为 Reserved Instance 的节省效果"
- "显示各服务未来 3 个月的成本预测"
- "按标签分析成本"

## 相关页面

- [Resource Inventory](../monitoring/inventory) - 资源数量及成本影响
- [ECS Container Cost](../compute/ecs-container-cost) - ECS 容器成本
- [EKS Container Cost](../compute/eks-container-cost) - EKS 容器成本
