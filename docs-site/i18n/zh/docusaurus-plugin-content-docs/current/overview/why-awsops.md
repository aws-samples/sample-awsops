---
sidebar_position: 0
title: 为什么选择 AWSops
description: 开源 AWS-Native 运维仪表板 — Steampipe 的速度、Well-Architected AI 诊断、多账户、OpenCost EKS 成本、外部可观测性自然语言查询
---

import Screenshot from '@site/src/components/Screenshot';

# 为什么选择 AWSops

:::note 本页部分内容基于 v1
本页的部分描述（内嵌 Steampipe 数据引擎、诊断 PPTX 导出等）源自 v1，正在逐步更新。
当前 v2 架构请以[AgentCore 概览](./agentcore.md)与 [FAQ](../faq/general.md) 为准。
:::


> **一句话总结** — AWSops 是**完全开源、仅用 AWS 托管服务实现的** AWS + Kubernetes 运维仪表板。通过 Steampipe 快速拉取 AWS API 并缓存在本地，再通过 Amazon Bedrock AgentCore 在同一个界面中提供 **Well-Architected 视角的 AI 诊断**。

<Screenshot src="/screenshots/overview/dashboard.png" alt="AWSops 仪表板 — 单一界面运维状况" />

将运维人员原本需要在数十个控制台之间来回切换查看的内容，整合为**一个仪表板 + 一个 AI 助手**。以下是在客户环境中引入时的核心差异点。

---

## 1. 完全开源 · AWS-Native（Architecture v1）

- **开源** — 全部源代码公开，可以直接拿来部署到自己的账户，并按内部需求修改。没有供应商锁定。
- **仅用 AWS 托管服务实现** — 不依赖额外的外部 SaaS，由以下部分构成：

| 层 | AWS 服务 |
|--------|-----------|
| 边缘·认证 | CloudFront + Lambda@Edge + Cognito |
| 计算 | EC2（t4g.2xlarge, ARM64 Graviton, Private Subnet）+ ALB |
| AI | **Amazon Bedrock AgentCore**（Runtime/Gateway/Code Interpreter/Memory）+ Bedrock 模型 |
| IaC | AWS CDK |

- 数据·AI·认证·边缘全部在 AWS 内部完成，因此**数据治理·合规非常简单**。

:::tip 会话要点
"这个仪表板本身就是按 AWS Well-Architected 构建的" — 因为开源，其实现可以直接验证，并且所有设计决策都以 32 个 ADR（Architecture Decision Record）文档化。
:::

---

## 2. Steampipe — 快速拉取 AWS API 并本地缓存

AWSops 的数据引擎是 [Steampipe](https://steampipe.io/)（内嵌 PostgreSQL，port 9193）。

- 用 SQL 即时查询 **380+ AWS 表 + 60+ Kubernetes 表** — 像操作 SQL 一样操作 AWS API。
- 结果通过 **node-cache 缓存 5 分钟**，仪表板核心 23 个查询由**缓存预热器每 4 分钟提前预热**，保证亚秒级响应。
- 所有查询只能通过 `src/lib/steampipe.ts` 的 **pg Pool**（max 10, 8 sequential batch）执行 — CLI（`steampipe query`）慢 660 倍，**在代码层面禁止**（ADR-001）。

→ 结果：不必反复刷新控制台，**所有资源在一个界面上即时**呈现。

---

## 3. AWS 资源基础仪表板（43 个页面）

EC2·Lambda·ECS/ECR·EKS（Pod/Node/Deployment/Service/Explorer）·VPC·CloudFront·WAF·EBS·S3·RDS·DynamoDB·ElastiCache·MSK·OpenSearch 等 **43 个页面**由实时图表和 React Flow 拓扑图构成。MSK·RDS·ElastiCache·OpenSearch 还内联显示 CloudWatch 指标。

---

## 4. Well-Architected AI 综合诊断

<Screenshot src="/screenshots/monitoring/ai-diagnosis.png" alt="AI 综合诊断 — Well-Architected Deep Dive 报告" />

`/ai-diagnosis` 是由 Amazon Bedrock **Claude Opus 4.8** 自动分析整体基础设施并生成正式报告的工具。

- **6 个 Well-Architected 支柱记分卡** — Executive Summary 为 Operational Excellence·Security·Reliability·Performance Efficiency·Cost Optimization·Sustainability 全部打分。
- **3 个支柱深度分析（15+1 个章节）** — 深入剖析 Cost Optimization·Security·Reliability（成本概览/计算/网络/存储、闲置资源、安全状况、网络·计算·EKS·数据库·MSK·存储分析等）。
- **DOCX / Markdown / PDF / PPTX** 导出 + **每周/双周/每月调度** + 完成时邮件通知。

:::note 诚实的范围
目前**深度章节集中在 Cost·Security·Reliability 3 个支柱**，6 个支柱的整体评估停留在 **Executive Summary 记分卡**级别。其余 3 个支柱的深度章节在路线图中。
:::

---

## 5. 成本效率（低 TCO）

运维工具本身的成本被设计得很低：

- **单台 EC2 t4g.2xlarge（ARM64 Graviton）** — 同机运行 Steampipe 内嵌 PostgreSQL，**没有额外的托管数据库成本**。
- **AgentCore 是无服务器的** — AI 运行时/网关仅在调用时计费。
- Bedrock 模型按任务选择 — 分类·路由用 **Sonnet 4.6**，深度诊断用 **Opus 4.8**，快速低成本任务用 **Haiku 4.5**，并应用提示词缓存（ADR-016）。

而且这个工具还能**降低客户基础设施的成本** — Cost Explorer 分析、闲置资源检测、FinOps 建议都包含在诊断报告中。

<Screenshot src="/screenshots/monitoring/cost.png" alt="Cost Explorer — 按服务/区域的成本分析" />

---

## 6. 多账户（单一窗口）

<Screenshot src="/screenshots/overview/accounts.png" alt="多账户管理" />

- Steampipe **Aggregator 模式** — `aws` = 全账户统一，`aws_<id>` = 单个账户。可以在顶部切换账户，也可以**合并查看全部**。
- 添加/删除账户只需修改 `data/config.json` 中的 `accounts[]` 数组 — **无需更改代码**（ADR-008）。跨账户使用 assume-role。

---

## 7. EKS 容器成本追踪（基于 OpenCost）

<Screenshot src="/screenshots/compute/eks-container-cost.png" alt="EKS 容器成本 — 基于 OpenCost/Prometheus" />

- 通过 **OpenCost + Prometheus** 按命名空间·Pod·节点追踪**基于实际用量的成本**（CPU·Memory·Storage·GPU）。
- 没有安装 OpenCost 时，也会通过**基于 Request 的回退**进行估算。
- ECS 则单独通过 **CloudWatch Container Insights + Fargate 价格**计算容器成本。

---

## 8. 外部可观测性集成（7 种）+ 🆕 自然语言查询

<Screenshot src="/screenshots/monitoring/datasources.png" alt="外部数据源集成" />

在 AWS 数据之外，还可将现有可观测性栈**作为数据源接入**（防 SSRF allowlist，ADR-011）：

| 种类 | 平台 |
|------|--------|
| Metrics | Prometheus · Dynatrace · Datadog |
| Logs | Loki · ClickHouse |
| Traces | Tempo · Jaeger |

**自然语言 → 查询自动生成** — 在 `/datasources/explore` 中输入"显示支付服务的 5xx 趋势"这样的自然语言，AI 会将其转换为 **PromQL / LogQL / TraceQL / SQL** 并执行。AI 助手的 `datasource` 路由会自动分类外部指标问题并使用同一引擎。

:::tip 会话要点
不必为每个可观测性工具记忆不同的查询语言，只需**一行自然语言**即可查询 Prometheus、Loki 或 Jaeger — 大幅降低运维人员的入门门槛。
:::

---

## 从代码中可以确认的其他优势

| 优势 | 内容 |
|------|------|
| **AI 工具架构** | 8 个基于角色的 AgentCore Gateway · **125 个 MCP 工具** · 19 个 Lambda |
| **多路由合成** | 分类器将问题分类到 11 个路由中的 1~3 个，**并行调用后综合**（ADR-002/025） |
| **告警流水线** | Webhook（CloudWatch SNS/Alertmanager/Grafana）→ 关联分析 → AI 自动诊断 → Slack（ADR-009） |
| **事件预扩容** | 分析历史指标 → Bedrock 生成多阶段预热计划·脚本（ADR-010，审核后执行） |
| **CIS 合规** | 使用 Powerpipe 进行 CIS v1.5~v4.0、**431 个控制项**基准测试 |
| **安全设计** | 外部调用 SSRF allowlist、管理员门控（adminEmails）、变更操作门控框架（ADR-029） |
| **设计透明性** | **32 个 ADR** — 所有重大决策以韩语/英语文档化 |

<Screenshot src="/screenshots/overview/agentcore.png" alt="AgentCore 仪表板 — Runtime/Gateway/工具状态" />

---

## 推荐演示流程（客户会话）

1. **仪表板** — 全账户/全资源尽在一个界面（演示多账户切换）
2. **AI 助手** — "找出开放了 0.0.0.0/0 的安全组"这样的自然语言查询 → 多路由运行
3. **AI 综合诊断** — 生成 Well-Architected 报告 → 导出 DOCX/PDF
4. **EKS 容器成本** — OpenCost 按命名空间的成本
5. **自然语言可观测性查询** — 在 `/datasources/explore` 中自动生成 PromQL
6. **成本/清单** — 趋势与节省要点

## 更多内容

- [仪表板概览](./dashboard) · [AI 助手](./ai-assistant) · [AgentCore 详解](./agentcore) · [账户管理](./accounts)
- [AI 综合诊断](../monitoring/ai-diagnosis) · [EKS 容器成本](../compute/eks-container-cost) · [外部数据源](../monitoring/datasources)
- [AWSops 介绍（完整架构）](../intro)
