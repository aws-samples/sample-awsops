---
sidebar_position: 5
---

import Screenshot from '@site/src/components/Screenshot';

# ElastiCache

监控 ElastiCache 集群（Valkey、Redis、Memcached）并查看性能指标。

<Screenshot src="/screenshots/storage/elasticache.png" alt="ElastiCache" />

## 主要功能

### 统计卡片
- **Clusters**：集群总数（含 Replication Group 数）
- **Total Nodes**：节点总数
- **Valkey**：Valkey 引擎集群数
- **Redis**：Redis 引擎集群数
- **Memcached**：Memcached 引擎集群数
- **Repl Groups**：Replication Group 数
- **Node Types**：使用中的节点类型数

### 可视化图表
- **Engine Distribution**：Valkey、Redis、Memcached 按引擎的分布
- **Node Type Distribution**：按节点类型的分布

### Cache Nodes 指标表格
从 CloudWatch 收集的实时指标：
- **Cluster ID**：集群标识符
- **Engine**：引擎类型（以颜色区分）
- **Node ID**：节点标识符
- **Status**：节点状态
- **CPU**：CPU 使用率
- **Engine CPU**：引擎 CPU 使用率
- **Memory**：可用内存
- **Network In/Out**：网络流量
- **Connections**：当前连接数
- **AZ**：可用区
- **Endpoint**：节点端点

### 详情面板
点击集群后可查看的信息：
- 集群 ID、ARN、引擎、版本
- 节点类型、状态、节点数
- Replication Group 信息
- 网络设置（子网组、AZ）
- 安全设置（At-Rest/Transit 加密、Auth Token）
- 配置设置（快照保留、维护窗口）
- Security Group 及入站规则 — 每个 SG 会从已同步的 security_group 库存展开 protocol/port/来源（CIDR · SG · 前缀列表）（无实时 AWS 调用；未同步的 SG 显示 'not synced'）
- CloudWatch 指标图表

## 使用方法

### 查询集群列表
1. 在 Cache Clusters 表格中查看集群列表
2. 在搜索框输入集群 ID、引擎等
3. 点击行查看详细信息

### 监控节点性能
在 Cache Nodes 表格中：
1. 确认 CPU/Engine CPU 使用率
2. 监控 Memory 使用量
3. 确认 Network In/Out 流量
4. 监控 Connections 数

### 确认 Replication Group
在 Replication Groups 表格中：
- Group ID、状态
- Multi-AZ 设置
- Auto Failover 设置
- Cluster Mode 状态

## 使用技巧

:::tip 引擎选择指南
- **Valkey**：兼容 Redis 的开源引擎，针对 AWS 优化
- **Redis**：丰富的数据结构，支持 Pub/Sub
- **Memcached**：简单键值缓存，支持多线程
:::

:::info 建议加密
为了安全起见，请同时启用 At-Rest 加密和 Transit 加密。可在详情面板的 Security 部分查看当前加密设置。
:::

## AI 分析技巧

可以尝试向 AI 助手提出以下问题：

- "哪些 ElastiCache 集群未启用加密？"
- "分析一下 Redis 集群的内存使用率"
- "检查一下 Cache Hit Rate 较低的集群"
- "比较一下 ElastiCache 各节点类型的费用"

:::tip Data Gateway
AI 助手通过 Data Gateway（15 个工具）支持 ElastiCache 性能分析、缓存优化、费用分析等。
:::

## 相关页面

- [VPC](../network/vpc) - ElastiCache 所部署的 VPC 及 Security Group
- [CloudWatch](../monitoring/cloudwatch) - ElastiCache 相关告警
- [Cost Explorer](../monitoring/cost) - ElastiCache 费用分析
