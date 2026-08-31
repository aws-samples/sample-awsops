---
sidebar_position: 10
title: EKS Services
description: Kubernetes Service 列表、类型、端点信息
---

import Screenshot from '@site/src/components/Screenshot';

# EKS Services

用于查看 Kubernetes Service 列表和网络配置的页面。

<Screenshot src="/screenshots/compute/eks-services.png" alt="EKS Services" />

## 主要功能

### 统计卡片
- **Total Services**: 全部 Service 数量（青色）
- **ClusterIP**: ClusterIP 类型服务数量（绿色）
- **NodePort**: NodePort 类型服务数量（紫色）
- **LoadBalancer**: LoadBalancer 类型服务数量（橙色）

### Service Type Distribution 图表
以饼图可视化各服务类型的分布：
- ClusterIP、NodePort、LoadBalancer、Other（ExternalName 等）

### Service 表格
| 列 | 说明 |
|------|------|
| Name | Service 名称 |
| Namespace | 命名空间 |
| Type | 服务类型 |
| Cluster IP | 集群内部 IP |
| External IP | 外部 IP（LoadBalancer 类型） |
| Created | 创建时间 |

## 理解 Service 类型

### ClusterIP（默认）
- 仅可在集群内部访问
- 用于内部服务间通信
- 例：后端 API、数据库

### NodePort
- 可通过所有节点的特定端口从外部访问
- 端口范围：30000-32767
- 主要用于开发/测试环境

### LoadBalancer
- 自动创建云负载均衡器（AWS ELB/NLB）
- 将外部流量路由到服务
- 用于生产环境的对外服务

### ExternalName
- 将外部 DNS 名称映射为集群内部名称
- 创建 CNAME 记录

## 使用方法

1. 在侧边栏点击 **Compute > K8s > Services**
2. 在统计卡片中了解服务类型分布
3. 确认 LoadBalancer 服务的 External IP
4. 在表格中查看各服务的 Cluster IP

## AWS 集成

### LoadBalancer 类型 + AWS
- 创建 Service 时自动预置 AWS ELB/NLB
- 通过 Annotation 控制配置：
  - `service.beta.kubernetes.io/aws-load-balancer-type: nlb`
  - `service.beta.kubernetes.io/aws-load-balancer-internal: "true"`

### 成本注意事项
- 每个 LoadBalancer 类型服务都会产生 AWS ELB 费用
- 多个服务共用单个 ALB：AWS Load Balancer Controller + Ingress

## 使用技巧

:::tip 检查 LoadBalancer External IP
如果 External IP 显示为 `<pending>`：
- AWS Load Balancer 正在预置中
- 检查子网标签是否缺失
- 检查 IAM 权限
:::

:::tip 访问 ClusterIP 服务
ClusterIP 服务无法从集群外部直接访问。如需外部访问，请使用 LoadBalancer 或 Ingress。
:::

:::info AI 分析
在 AI Assistant 中可以通过"Service 列表"、"LoadBalancer 服务现状"、"找出没有 External IP 的 LoadBalancer"等方式进行分析。
:::

## 相关页面

- [EKS Overview](../compute/eks) - 集群整体状况
- [EKS Deployments](../compute/eks-deployments) - Service 关联的 Deployment
- [VPC](../network/vpc) - 网络配置及负载均衡器
- [EKS Explorer](../compute/eks-explorer) - 查看 Ingress 详情
