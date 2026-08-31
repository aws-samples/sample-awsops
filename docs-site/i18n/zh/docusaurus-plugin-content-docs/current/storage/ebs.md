---
sidebar_position: 1
---

import Screenshot from '@site/src/components/Screenshot';

# EBS

管理和监控 EBS（Elastic Block Store）卷及快照。

<Screenshot src="/screenshots/storage/ebs.png" alt="EBS" />

## 主要功能

### 统计卡片
- **Total Volumes**：卷总数（区分 in-use/available）
- **Total Size**：总存储容量（区分使用中/闲置容量）
- **Encrypted**：已加密卷的比例
- **Unencrypted**：未加密卷数（安全警告）
- **Snapshots**：快照数量及加密状态
- **Idle Volumes**：闲置卷数（成本优化对象）

### 可视化图表
- **Volume Type**：gp3、gp2、io1、io2 等按类型的分布
- **State**：in-use、available 等按状态的分布
- **Encryption**：是否加密的分布

### 卷/快照标签页
以标签页分开查看卷和快照：
- **Volumes 标签页**：卷列表、类型、大小、IOPS、关联的 EC2
- **Snapshots 标签页**：快照列表、创建日期、加密状态

### 详情面板
点击卷后可在右侧面板中查看：
- 卷 ID、名称、类型、大小
- IOPS、Throughput、AZ
- Multi-Attach 设置
- 加密状态及 KMS 密钥
- 关联的 EC2 实例信息
- 该卷的快照列表

## 使用方法

### 查询卷
1. 在 Volumes 标签页查看全部卷列表
2. 在搜索框输入卷 ID、名称、类型等进行筛选
3. 点击表格行查看详细信息

### 查询快照
1. 点击 Snapshots 标签页
2. 按快照 ID、卷 ID、名称搜索
3. 确认创建日期、加密状态

### 确认 EC2 关联
在卷详情面板的 "Attached Resources" 部分：
- 关联的 EC2 实例 ID
- 设备路径（例如：/dev/xvda）
- 实例名称、类型、状态

## 使用技巧

:::tip 闲置卷管理
处于 "available" 状态的卷未关联到 EC2，只会产生费用。请在 Idle Volumes 卡片中确认闲置卷，并删除不需要的卷。
:::

:::info 建议加密
为了满足安全合规要求，建议对所有 EBS 卷进行加密。可在 Unencrypted 卡片中确认未加密的卷，然后创建加密快照并从中恢复，以应用加密。
:::

## AI 分析技巧

可以尝试向 AI 助手提出以下问题：

- "列出未加密的 EBS 卷"
- "闲置 EBS 卷的总容量和预计费用是多少？"
- "从 gp2 迁移到 gp3 能节省多少费用？"
- "检查一下关联到特定 EC2 的卷的 IOPS 设置"

:::tip Data Gateway
AI 助手通过 Data Gateway（15 个工具）支持 EBS 卷分析、快照管理、成本优化等。
:::

## 相关页面

- [EC2](../compute/ec2) - EBS 卷所关联的实例
- [Cost Explorer](../monitoring/cost) - EBS 费用分析
- [Security](../security) - 未加密卷的安全检查
