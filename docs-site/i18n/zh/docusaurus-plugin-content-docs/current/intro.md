---
sidebar_position: 1
title: AWSops 简介
description: 实时查看、提问并诊断 AWS·Kubernetes 运维的统一仪表板
---

import Screenshot from '@site/src/components/Screenshot';

# AWSops 简介

AWSops 是一个可以**实时查看 AWS 与 Kubernetes 运维状态、用自然语言提问、并通过 AI 进行诊断**的统一运维仪表板。您可以在一个界面中查看资源清单、成本、拓扑和 EKS，将疑问交给 AI 助手解答，并通过 AI 诊断报告了解整个账户的运维状况。

<Screenshot src="/screenshots/overview/dashboard.png" alt="AWSops 仪表板" />

## 能做什么

- **一目了然的仪表板** — 在主界面集中查看计算、存储、网络、安全、成本 KPI 与分布图表。
- **AI 助手** — 用自然语言提出运维问题，问题会自动路由到合适的领域，并以 Markdown 形式返回答案。
- **AI 诊断** — 按不同深度生成分析账户运维状态的综合报告，并导出为 MD、DOCX、PDF。
- **资源清单** — 对 EC2、Lambda、RDS、S3、VPC、IAM 等 20 多种资源进行排序、搜索和详情查看。
- **拓扑** — 以图形方式探索 Route53 → CloudFront → LB → Target Group → 目标的请求流。
- **EKS / Kubernetes** — 以只读方式查看集群舰队以及节点、Pod、Deployment。
- **成本分析** — 查看按服务分解的成本与趋势，以及 Bedrock 模型使用量。
- **数据源探索** — 使用原生查询语言查询已连接的可观测性数据源。

:::info 只读运维仪表板
AWSops **不会更改 AWS 资源。** 它专注于观察、分析和诊断现状；对于需要安装或变更的操作（例如 OpenCost），会提供指引和脚本供用户自行执行。
:::

## 下一步

- [登录](./getting-started/login) — 如何访问仪表板
- [界面布局与主题](./getting-started/navigation) — 侧边栏、命令面板、主题、移动端
- [仪表板](./overview/dashboard) — 了解主界面
- [AI 助手](./overview/assistant) — 用自然语言提问
- [AI 诊断](./operations/ai-diagnosis) — 生成综合诊断报告
