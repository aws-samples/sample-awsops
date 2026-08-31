---
sidebar_position: 7
---

import Screenshot from '@site/src/components/Screenshot';

# MSK

监控 Amazon MSK（Managed Streaming for Apache Kafka）集群并查看 Broker 性能。

<Screenshot src="/screenshots/storage/msk.png" alt="MSK" />

## 主要功能

### 统计卡片
- **Total Clusters**：集群总数（含活动集群数）
- **Active**：处于活动状态的集群数
- **Total Brokers**：Broker 节点总数
- **Enhanced Monitoring**：已启用增强监控的集群数
- **In-Transit Encrypted**：已启用传输中加密的集群数
- **Avg Brokers/Cluster**：每个集群的平均 Broker 数

### 可视化图表
- **Cluster State**：ACTIVE、CREATING 等按状态的分布
- **Kafka Version**：按 Kafka 版本的分布

### Broker Nodes 指标表格
从 CloudWatch 收集的按 Broker 的实时指标：
- **Cluster**：集群名称
- **Type**：BROKER 或 CONTROLLER
- **ID**：Broker ID
- **Instance**：实例类型
- **VPC IP**：Broker 的 VPC IP 地址
- **ENI**：关联的 ENI ID
- **CPU**：CPU 使用率（User + System）
- **Memory**：内存使用率
- **Network In/Out**：网络流量（KB/s）
- **Endpoint**：Broker 端点

### 详情面板
点击集群后可查看的信息：
- 集群名称、状态、类型
- Kafka 版本、Broker 数
- Enhanced Monitoring 设置
- 存储模式
- Broker 配置（实例类型、EBS 大小、AZ 分布）
- Security Group、Subnet 信息
- 加密设置（In-Transit、At-Rest、KMS）
- 认证设置（IAM、SCRAM、TLS）
- Bootstrap Brokers（Plaintext、TLS）
- Broker 节点详细信息
- Open Monitoring（JMX/Node Exporter）
- 日志设置

## 使用方法

### 查询集群列表
1. 在搜索框输入集群名称、Kafka 版本等
2. 在表格中确认状态、实例类型、Broker 数
3. 点击行查看详细信息

### 监控 Broker 性能
在 Broker Nodes 表格中：
1. 确认 **CPU** 使用率（超过 80% 需注意）
2. 监控 **Memory** 使用率（超过 85% 警告）
3. 确认 **Network In/Out** 流量
4. 确认各集群的 Broker 分布

### 确认 Bootstrap Brokers
在详情面板中确认 Bootstrap Brokers 端点：
- **Plaintext**：用于无加密连接
- **TLS**：用于 TLS 加密连接

## 使用技巧

:::tip Broker 数量规划
请综合考虑分区数和复制因子来规划合适的 Broker 数量。通常建议 3 个以上的 Broker，并为实现高可用而跨多个 AZ 分布部署。
:::

:::info KRaft 模式
在 Kafka 3.x 及以上版本中，可使用 KRaft 模式替代 ZooKeeper。若 Broker Nodes 表格中显示 CONTROLLER 类型的节点，则表示处于 KRaft 模式。
:::

## AI 分析技巧

可以尝试向 AI 助手提出以下问题：

- "哪些 MSK Broker 的 CPU 使用率较高？"
- "检查一下未启用传输中加密的集群"
- "分析 MSK 集群的网络流量趋势"
- "哪些集群需要升级 Kafka 版本？"

:::tip Data Gateway
AI 助手通过 Data Gateway（15 个工具）支持 MSK 集群分析、Broker 性能调优、主题管理等。
:::

## 相关页面

- [VPC](../network/vpc) - MSK 所部署的 VPC 及 Security Group
- [CloudWatch](../monitoring/cloudwatch) - MSK 相关告警
- [Cost Explorer](../monitoring/cost) - MSK 费用分析
