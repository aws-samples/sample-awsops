---
sidebar_position: 4
---

import Screenshot from '@site/src/components/Screenshot';

# DynamoDB

管理 DynamoDB 表并监控容量和配置。

<Screenshot src="/screenshots/storage/dynamodb.png" alt="DynamoDB" />

## 主要功能

### 统计卡片
- **Tables**：表总数
- **Active**：处于活动状态的表数
- **Total Items**：所有表的总条目数
- **Total Size**：所有表的总数据大小

### 可视化图表
- **Table Status**：ACTIVE、CREATING 等按状态的分布
- **Items per Table**：按表的条目数分布

### 表列表
- 表名称
- 状态（ACTIVE、CREATING 等）
- 条目数
- 数据大小
- 计费模式（On-Demand/Provisioned）
- 区域

### 详情面板
点击表后可查看的信息：
- 表名称、ARN、状态
- 条目数、数据大小
- 计费模式
- 创建日期、区域
- 键结构（Partition Key、Sort Key）
- 读/写容量
- Point-in-Time Recovery 设置
- 加密设置（SSE）
- 标签

## 使用方法

### 查询表列表
1. 在表列表中查看全部表
2. 通过状态徽章掌握表的状态
3. 点击行查看详细信息

### 确认容量模式
在计费列中确认容量模式：
- **On-Demand**：按使用量计费（PAY_PER_REQUEST）
- **Provisioned**：按预置容量计费

### 确认键结构
在详情面板的 "Keys" 部分：
- 确认 HASH（Partition Key）
- 确认 RANGE（Sort Key）（如果存在）

## 使用技巧

:::tip On-Demand vs Provisioned
当流量模式难以预测或波动较大时，On-Demand 模式更为合适。若流量模式稳定，则可通过 Provisioned 模式节省成本。
:::

:::info Point-in-Time Recovery
对于存放重要数据的表，请启用 PITR（Point-in-Time Recovery）。可在详情面板的 Settings 部分查看当前设置。
:::

## AI 分析技巧

可以尝试向 AI 助手提出以下问题：

- "哪些 DynamoDB 表未启用 PITR？"
- "分析一下 On-Demand 模式表的费用"
- "展示 DynamoDB 表容量使用量的变化趋势"
- "检查一下全局表的配置状态"

:::tip Data Gateway
AI 助手通过 Data Gateway（15 个工具）支持 DynamoDB 表分析、容量规划、索引优化等。
:::

## 相关页面

- [Cost Explorer](../monitoring/cost) - DynamoDB 费用分析
- [IAM](../security/iam) - DynamoDB 访问权限
- [CloudWatch](../monitoring/cloudwatch) - DynamoDB 相关告警
