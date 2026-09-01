---
sidebar_position: 1
title: EC2 实例
description: EC2 实例列表、状态监控、详细信息查看
---

import Screenshot from '@site/src/components/Screenshot';

# EC2 实例

用于实时监控 EC2 实例状态并查看详细信息的页面。

:::info v2 中的呈现方式
此界面并非独立页面，而是通过 v2 的通用清单视图（`/inventory/ec2`，侧边栏「计算」分组）提供。以下内容基于 v2 清单视图的实际配置（`web/lib/inventory-types.ts` 中的 `HIGHLIGHTS.ec2`/`INVENTORY_TYPES.ec2`），而非 v1 的专用 EC2 页面。
:::

<Screenshot src="/screenshots/compute/ec2.png" alt="EC2 实例" />

## 主要功能

### 高亮卡片
页面顶部的 5 个高亮卡片显示核心指标：
- **实例中**：`instance_state` 为 running 的实例数量
- **已停止**：`instance_state` 为 stopped 的实例数量
- **公共 IP**：已分配公共 IP 的实例数量
- **类型种类数**：正在使用的实例类型（`instance_type`）的去重计数
- **运行中 vCPU 总数**: running 实例的实际 vCPU 总和（`cpu_options` 核心 × 线程 — 按实例实际值统计，而非类型默认值）

### 可视化图表
- 按实例类型（`instance_type`）和状态（`instance_state`）分布的环形图
- 按内存（MiB）排名的 Top-N 柱状图

### 实例列表表格
以表格形式显示所有 EC2 实例：
- Name、Type、State、Pricing、Private/Public IP、Subnet、VPC、Launch Time
- 根据状态（running/stopped 等）显示不同颜色的徽章

### 筛选与搜索
- **搜索框**：在 ID、Name、IP 等所有字段中进行文本搜索
- **State 筛选**：按 running、stopped 等状态筛选
- **Type 筛选**：按 t3.micro、m5.large 等实例类型筛选
- **VPC 筛选**：按 VPC ID 筛选
- **Clear all**：重置所有筛选条件

### 详情面板
在表格中点击实例行后，右侧会打开详情面板：
- **Instance 部分**：Instance ID、AMI、Architecture、Platform、Key Pair、IAM Role 等
- **Compute 部分**：vCPUs、Cores、Threads/Core、Memory、Network Performance
- **Network 部分**：VPC、Subnet、AZ、Private/Public IP、DNS、Network Interfaces
- **Security Groups 部分**：已关联的安全组列表
- **Storage 部分**：Root Device、Block Device Mappings
- **Tags 部分**：实例上设置的标签列表

## 使用方法

1. 在侧边栏中点击 **Compute > EC2**
2. 通过顶部高亮卡片了解整体状况
3. 使用筛选功能查找所需实例
4. 在表格中点击实例查看详细信息
5. 通过刷新按钮加载最新数据

## 使用技巧

:::tip 快速搜索
在搜索框中只输入 IP 地址的一部分，也可以快速找到对应实例。
:::

:::tip 组合筛选
同时使用多个筛选条件可以更精确地查找实例。例如，可以只查看"处于 running 状态的 t3.large 实例"。
:::

:::info AI 分析
在 AI Assistant 中可以通过"显示 EC2 实例列表"、"有多少个 running 状态的实例？"等问题进行分析。
:::

## 相关页面

- [VPC](../network/vpc) - 查看网络配置
- [EBS](../storage/ebs) - 查看已挂载的卷
- [Monitoring](../monitoring) - 查看 CPU/内存指标
