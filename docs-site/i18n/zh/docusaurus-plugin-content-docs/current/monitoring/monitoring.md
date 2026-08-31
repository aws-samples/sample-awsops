---
sidebar_position: 1
title: Monitoring Overview
description: 实时监控 EC2、RDS、EBS、K8s 资源的 CPU、内存、网络、Disk I/O 指标。
---

import Screenshot from '@site/src/components/Screenshot';

# Monitoring Overview

可在一个界面上全面监控整个 AWS 基础设施性能指标的页面。

<Screenshot src="/screenshots/monitoring/monitoring.png" alt="Monitoring" />

## 主要功能

### 综合仪表板
- **EC2 CPU**: 各实例的平均/最大 CPU 使用率
- **Network I/O**: 各实例的网络 In/Out 流量（MB/h）
- **K8s Memory**: 各节点的内存容量、分配量、Pod 数
- **EBS IOPS**: 各卷的 Read/Write IOPS
- **RDS**: 数据库 CPU、连接数、FreeableMemory

### 按选项卡查看详情
页面顶部始终显示 5 个选项卡，标签中同时显示计数。

| 选项卡 | 标签 | 内容 | 数据查询 |
|---|------|------|------------|
| `ec2` | `EC2 CPU ({n})` | 各实例的平均/最大 CPU，点击后进入时间序列详情视图 | 页面加载时批量 |
| `network` | `Network ({n})` | Network In/Out（MB/h），点击行后显示各实例 24h 图表 | **按需** — 进入选项卡时按实例依次调用 `fetchNetwork()` |
| `memory` | `Memory ({n} nodes)` | K8s 节点内存 + RDS FreeableMemory 整合 | 页面加载时批量 |
| `ebs` | `EBS IOPS ({n})` | 各卷的 Read/Write IOPS、按小时趋势 | 页面加载时批量 |
| `rds` | `RDS ({n})` | CPU + Connection + FreeableMemory | 页面加载时批量 |

:::info Network 选项卡工作方式
Network 选项卡在进入时会按实例**依次**调用 CloudWatch `NetworkIn/Out`（在 `useEffect` 中检测 `activeTab === 'network'`）。实例较多时，填满所有图表可能需要几十秒 — 在其他选项卡不会调用，从而降低平时的加载成本。
:::

:::info EBS IOPS 选项卡
页面的 `ebsLatest` 数据来自 dashboard 预热缓存（`cache-warmer.ts`）。刷新按钮通过 `bustCache=true` 使缓存失效。
:::

### 实例详细指标
点击 EC2 实例行后会进入详细指标视图：
- CPUUtilization、NetworkIn/Out、DiskReadOps、DiskWriteOps
- 期间筛选：1h、6h、24h、7d、30d
- 显示各指标的平均/最大值

## 使用方法

1. **选择选项卡**: 选择要监控的资源类型（EC2 CPU、Network、Memory、EBS、RDS）
2. **表格排序**: 点击列标题进行排序
3. **查看详情**: 点击行后显示滑出面板或详情视图
4. **刷新**: 使用右上角的刷新按钮获取最新数据

:::tip 性能阈值颜色
- **绿色**: 正常（CPU < 50%）
- **橙色**: 注意（CPU 50-80%）
- **红色**: 警告（CPU > 80%）
:::

## 使用技巧

### 识别高 CPU 实例
可通过顶部 StatsCard 的 "High CPU (>80%)" 卡片立即确认。点击数字即可筛选出相应实例。

### 检查 K8s 内存预留率
请在 Memory 选项卡中查看 K8s 节点的 Reserved % 列。系统预留内存过高可能会影响 Pod 调度。

### RDS 内存监控
点击 RDS 行后可查看 FreeableMemory 图表。若数值持续偏低，可能需要扩大实例规格。

:::info CloudWatch 详细监控
EC2 详细指标仅在启用了 CloudWatch 详细监控的实例上提供 1 分钟粒度的数据。基础监控为 5 分钟粒度。
:::

## AI 分析技巧

在 AI 助手中利用 Monitoring Gateway（17 个工具）可进行更深入的分析：

- "分析 EC2 CPU 使用率高的实例的原因"
- "分析过去 7 天的网络流量模式"
- "找出 RDS 连接数激增的原因"
- "告诉我 K8s 节点内存预计何时不足"

## 相关页面

- [CloudWatch](./monitoring/cloudwatch) - 告警管理
- [Cost Explorer](./monitoring/cost) - 成本分析
- [Resource Inventory](./monitoring/inventory) - 资源数量趋势
