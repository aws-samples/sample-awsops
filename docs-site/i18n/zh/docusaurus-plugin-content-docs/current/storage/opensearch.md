---
sidebar_position: 6
---

import Screenshot from '@site/src/components/Screenshot';

# OpenSearch

监控 Amazon OpenSearch Service 域并查看集群状态。

<Screenshot src="/screenshots/storage/opensearch.png" alt="OpenSearch" />

## 主要功能

### 统计卡片
- **Total Domains**：域总数（含活动域数）
- **Processing**：正在更新配置的域数
- **Node-to-Node Enc**：已启用节点间加密的域数
- **At-Rest Enc**：已启用静态数据加密的域数
- **VPC Domains**：部署在 VPC 内的域数
- **Public Domains**：允许公开访问的域数

### 可视化图表
- **Engine Version**：OpenSearch/Elasticsearch 按版本的分布
- **Encryption Status**：加密设置状态分布

### Domain Metrics 表格
从 CloudWatch 收集的实时指标：
- **Domain**：域名称
- **Engine**：引擎版本
- **Cluster Status**：GREEN/YELLOW/RED 状态
- **CPU**：CPU 使用率
- **JVM Memory**：JVM 内存压力
- **Nodes**：节点数
- **Documents**：可检索的文档数
- **Free Storage**：可用存储
- **Search Rate/Latency**：搜索请求数及延迟
- **Index Rate/Latency**：索引请求数及延迟

### 详情面板
点击域后可查看的信息：
- 域名称、ID、引擎版本
- 状态、IP 类型、端点
- 集群配置（实例类型、节点数、Master 设置）
- EBS 存储设置
- 加密设置（Node-to-Node、At-Rest、KMS 密钥）
- Advanced Security 设置
- VPC/网络配置
- 服务软件版本
- 日志发布设置

## 使用方法

### 查询域列表
1. 在搜索框输入域名称、引擎版本
2. 在表格中确认状态、实例类型、节点数
3. 点击行查看详细信息

### 监控集群状态
在 Domain Metrics 表格中：
1. 确认 **Cluster Status**（GREEN 为正常）
2. 监控 CPU 及 JVM Memory 压力
3. 确认 Search/Index Latency
4. 监控 Free Storage

### 确认安全设置
1. 通过加密卡片掌握整体加密状态
2. 区分确认 VPC/Public 域
3. 在详情面板中确认 Fine-Grained Access Control

## 使用技巧

:::tip Cluster Status 管理
- **GREEN**：所有分片均已正常分配
- **YELLOW**：部分副本分片未分配（功能正常）
- **RED**：部分主分片未分配（可能丢失数据）

RED 状态需要立即处理。
:::

:::info 建议部署在 VPC 内
为了安全起见，建议将 OpenSearch 域部署在 VPC 内。若 Public Domains 卡片显示为红色，请考虑迁移到 VPC。
:::

## AI 分析技巧

可以尝试向 AI 助手提出以下问题：

- "哪些 OpenSearch 域的集群状态为 YELLOW/RED？"
- "检查一下未启用节点间加密的域"
- "分析 OpenSearch 搜索延迟较高的域"
- "介绍一下 OpenSearch 索引性能优化的方法"

:::tip Data Gateway
AI 助手通过 Data Gateway（15 个工具）支持 OpenSearch 集群分析、索引优化、搜索性能调优等。
:::

## 相关页面

- [VPC](../network/vpc) - OpenSearch 所部署的 VPC 及 Security Group
- [CloudWatch](../monitoring/cloudwatch) - OpenSearch 相关告警
- [Cost Explorer](../monitoring/cost) - OpenSearch 费用分析
