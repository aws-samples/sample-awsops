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
- 期间切换：14 天（默认）/ 30 天 / 90 天
- 通过资源类型开关选择要显示的资源
- 跟随顶部的账户选择进行账户级过滤（各账户历史自该功能部署后开始积累，无区域维度）。当所比较的两天在某类型的账户覆盖上不一致时（某账户在该类型的 sync 中缺席），净变化 / 变化表 / 成本影响会显示 '—'，而不是编造数字。收窄区域范围时（快照没有区域维度），净变化 KPI 显示 '—'，成本影响面板隐藏
- 派生安全序列（Public S3 Buckets / Open Security Groups / Unencrypted EBS）在每次 sync 时按与安全页面相同的判定标准记录，并且不计入总数（total），以避免与原始资源重复计算；Public S3 Buckets 序列仅覆盖主机账户（S3 公开配置采集是主机 SDK 扫描 — 与安全页面的范围一致）

### 序列开关组
图表序列按最新快照数量动态排序，而不是固定列表：
- **Core Resources**: 数量前 5 的实际资源类型 — 默认显示
- **Other Resources**: 其后的最多 3 个类型 — 默认隐藏（点击标签显示）
- 其余类型不出现在图表中，但全部列在下方的数量变化表中
### 安全序列（默认隐藏，独立开关组）
- Public S3 Buckets、Open Security Groups、Unencrypted EBS — 采用安全页面判定标准的派生计数，不计入总数

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
- ElastiCache Clusters: $100/月
- NAT Gateways: $45/月
- EC2 Instances: $80/月
- 其他资源按各自权重计算

## 使用方法

1. **查看趋势**: 在图表中查看资源数量的变化模式
2. **更改期间**: 使用 14d（默认）/30d/90d 开关调整分析期间
3. **选择资源**: 使用切换按钮只显示关注的资源
4. **表格分析**: 查看详细数值及变化率
5. **成本影响**: 查看底部的成本估算区域

:::tip 基于快照的数据
快照在每次库存 sync 运行时按账户写入 Aurora（`inventory_snapshots`）。SDK 采集部分失败的运行完全不写入快照；而部分账户不可达的运行仍会为每个可达账户写入新行，仅保留不可达账户的上一行 — 因此某个（账户, 类型）的当日数据点可能缺失——与仪表板加载无关，读取时也不会产生额外的 AWS API 调用。
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
快照数据保存在 Aurora 的 `inventory_snapshots` 表中。趋势查询最多读取最近 90 天（更早的行不在查询范围内）。
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
