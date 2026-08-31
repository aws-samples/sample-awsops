---
sidebar_position: 5
title: Resource Inventory
description: 跟踪 AWS 资源数量趋势并估算成本影响。
---

import Screenshot from '@site/src/components/Screenshot';

# Resource Inventory

按天跟踪 AWS 资源数量变化并估算成本影响的页面。

<Screenshot src="/screenshots/monitoring/inventory.png" alt="Inventory" />

## 主要功能

### 摘要统计
- **Resource Types**: 正在跟踪的资源类型数
- **Total Count**: 资源总数
- **7d Net Change**: 7 天内的净变化量

### 资源趋势图
- 通过多折线图可视化各资源类型的数量趋势
- 期间切换：30 天 / 90 天
- 通过资源类型开关选择要显示的资源

### Core Resources（默认显示）
- EC2 Instances
- RDS Instances
- S3 Buckets
- EBS Volumes
- Lambda Functions

### Other Resources
- VPCs、Subnets、NAT Gateways
- ALBs、NLBs、Route Tables
- IAM Users、IAM Roles
- ECS Tasks、ECS Services
- DynamoDB Tables
- EKS Nodes、K8s Pods、K8s Deployments
- ElastiCache Clusters
- CloudFront Distributions
- WAF Web ACLs
- ECR Repositories
- Public S3 Buckets、Open Security Groups、Unencrypted EBS

### 资源表格
| 列 | 说明 |
|------|------|
| Resource | 资源类型 |
| Current | 当前数量 |
| 7d Ago | 7 天前数量 |
| 30d Ago | 30 天前数量 |
| 7d Change | 7 天变化量及变化率 |
| 30d Change | 30 天变化量及变化率 |

### 成本影响估算
根据资源数量变化估算每月成本影响：
- RDS Instances: $200/月（估算）
- ElastiCache Clusters: $150/月
- EKS Nodes: $100/月
- NAT Gateways: $45/月
- EC2 Instances: $80/月
- 其他资源按各自权重计算

## 使用方法

1. **查看趋势**: 在图表中查看资源数量的变化模式
2. **更改期间**: 使用 30d/90d 开关调整分析期间
3. **选择资源**: 使用切换按钮只显示关注的资源
4. **表格分析**: 查看详细数值及变化率
5. **成本影响**: 查看底部的成本估算区域

:::tip 基于快照的数据
Resource Inventory 会在仪表板加载时自动保存快照。无需额外的 API 查询即可积累历史数据，因此不会影响性能。
:::

## 使用技巧

### 跟踪资源增长
请在 7d Change 或 30d Change 列中查看以橙色（增长）显示的资源。意料之外的增长可能是成本激增的原因。

### 安全资源监控
请注意以下资源的变化：
- **Public S3 Buckets**: 增加时存在数据暴露风险
- **Open Security Groups**: 增加时存在安全漏洞
- **Unencrypted EBS**: 合规性问题

### 解读成本影响
在 Cost Impact Estimation 区域中：
- 正数（+）: 预计成本增加
- 负数（-）: 预计成本减少

实际成本可能因实例类型、使用量等因素而有所不同。

:::info 数据保留
快照数据保存在 `data/inventory/` 目录中。超过 90 天的数据会被排除在分析之外，但文件会保留。
:::

## AI 分析技巧

使用 AI 助手的提问示例：

- "分析过去 30 天增长最多的资源"
- "如果这个资源增长趋势持续下去，每月成本会是多少？"
- "汇总安全相关资源的变化"
- "推荐需要清理的资源项"

## 相关页面

- [Cost Explorer](../monitoring/cost) - 实际成本分析
- [Security Overview](../security) - 安全资源详情
- [Monitoring Overview](../monitoring) - 性能监控
