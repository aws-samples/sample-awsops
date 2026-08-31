---
sidebar_position: 1
title: 常见问题（一般）
description: 解答最常见的问题——AWSops 是什么、如何部署·登录·运维、是否会变更基础设施、数据存储在哪里等。
---

# 常见问题（一般）

关于 AWSops 仪表板的一般问题与解答。

## AWSops 是什么？

AWSops 是面向 AWS 与 Kubernetes 环境的**实时只读（read-only）运维仪表板 + AI 诊断**工具。主要功能如下：

- **资源监控**：EC2、Lambda、ECS、EKS、RDS、S3 等主要 AWS 服务的现状
- **网络 / 拓扑可视化**：VPC·子网·Security Group，以及从 CloudFront → LB → Target Group → DB 贯通的资源图
- **安全分析**：IAM 权限分析、合规、漏洞检查
- **成本管理**：基于 Cost Explorer 的成本分析与仪表板
- **AI 助手**：通过自然语言查询进行 AWS 资源分析与问题排查（流式输出 + 领域路由 + 对话持久化）
- **AI 诊断（Diagnosis）**：由 worker 生成的只读诊断报告（Light·Mid 8+1 个章节（共 9） / Deep 15+1 个章节（共 16），支持 DOCX·PDF 导出）

平台是**基于 Terraform 的 MSA**——实时 AWS 查询由 **Amazon Bedrock AgentCore MCP 工具**负责，应用状态持久化在 **Aurora Serverless v2（PostgreSQL 17）**中。

:::info
AWSops 是**只读**运维工具。它查询·可视化·诊断基础设施现状，但不会变更 AWS 资源。详情请参阅下文"AWSops 会变更我的基础设施吗？"。
:::

## 如何部署，采用什么架构运行？

AWSops 是由 **Terraform**（`terraform/foundation/`，部分 S3 backend）预置的微服务架构。核心组成如下：

| 层 | 组成 |
|------|------|
| **IaC** | Terraform（S3 partial backend，`use_lockfile`）。CDK 已废弃 |
| **边缘** | CloudFront（TLS）→ VPC Origin（`https-only:443`）→ 内部 ALB HTTPS:443（区域 ACM）→ Fargate。**没有公开 ALB** |
| **计算** | ECS Fargate（arm64）。web 是 Next.js 14 thin-BFF，在**根路径（`/`）**提供服务 |
| **数据** | Aurora Serverless v2（PostgreSQL 17），通过 node-pg 访问 |
| **AI** | AgentCore Runtime + 9 个分区网关的 MCP Lambda 工具（实时查询） |
| **异步 worker** | SQS → ESM（kill-switch）→ dispatcher Lambda → Step Functions → Lambda 或 Fargate |

繁重、耗时或有内存（OOM）风险的任务不会由 web 直接处理，而是发送到**异步 worker 层**：`POST /api/jobs` → 写入 `worker_jobs` 队列 → SQS → 幂等 dispatcher Lambda → Step Functions 按任务时长路由，短任务走 RunLambda，长/有 OOM 风险的任务走 `ecs:runTask.sync` Fargate。失败由 status_updater Lambda 记录，reaper（EventBridge 5 分钟）对 stale 任务进行对账。

:::tip
边缘是**端到端 TLS**。CloudFront → 内部 ALB 通过 TLS 连接，ALB SG 允许来自 CloudFront 托管 SG `CloudFront-VPCOrigins-Service-SG` 的 443 流量。不使用额外的 X-Custom-Secret 头或托管 prefix list。
:::

## AWSops 会变更我的基础设施吗？

**不会。** AWSops 是**只读运维仪表板 + AI 诊断**工具。**AWS 资源变更与自主执行（autonomy）已永久冻结（do-not-enable）**。任何页面或 AI 功能都不会终止 EC2、修改 SG 或变更基础设施。

AI 助手与诊断只是**查询**实时数据进行分析·诊断，不执行变更（mutation）。约 160 个 AgentCore MCP Lambda 工具全部为 read-only。

在治理下唯一被允许的"写入"是**外部数据记录**——例如在外部系统中留下报告·工单·消息。该功能仅在以下防护下运行：

- SSRF 防护（阻断 metadata/IMDS，destination allowlist）
- 密钥由 Secrets Manager 管理
- DLP / redaction
- human-gate（人工批准）
- 默认 flag-OFF

:::info
外部"写入"是**数据记录**（工单·消息·报告），**而非 AWS 资源变更**。对 AWS 基础设施本身的变更权限不会通过任何途径授予。
:::

## 如何登录？

AWSops 使用**应用内登录表单**（`/login`）。

1. 通过浏览器访问 AWSops 时，未认证用户会被边缘（Lambda@Edge）重定向到 `/login`。
2. 在 `/login` 表单输入邮箱·密码后，BFF 调用 `POST /api/auth/login`。
3. BFF 通过公开 Cognito `InitiateAuth (USER_PASSWORD_AUTH)` 认证，并签发 `awsops_token` Cookie（id_token，有效期 12 小时）。
4. 此后所有请求都由 Lambda@Edge 进行 **RS256 JWKS 签名验证**（含 iss/aud/token_use）检查。

认证由 Cognito User Pool + Lambda@Edge（`us-east-1`）处理。Hosted UI PKCE 流程仅作为暗备（dark fallback）保留。

**管理员权限**在服务端以 fail-closed 方式把关——只有 Cognito `admins` 组成员或包含在 SSM 管理员邮箱 allowlist 中的用户才能访问管理功能。

## 数据存储在哪里？

AWSops 不使用 EC2 实例内的 JSON 文件，而是将状态存储在**托管 AWS 服务**中。

| 存储 | 内容 |
|--------|------|
| **Aurora Serverless v2（PostgreSQL 17）** | `worker_jobs`（异步任务）、聊天线程、AI 诊断报告、数据源 schema 缓存等应用状态 |
| **SSM Parameter Store** | AgentCore 配置的 source of truth（`/ops/awsops-v2/agentcore/...` — runtime ARN、interpreter id、memory id 等） |
| **S3** | AI 诊断报告导出文件（DOCX·PDF） |

实时 AWS 资源数据**不做存储**，由 AgentCore MCP 工具在查询时即时获取。（Steampipe 仅用作 flag-gated 的**库存 sync**（`steampipe_enabled`，默认 OFF），不是实时查询引擎。）

:::tip
应用通过 **node-pg**（`web/lib/db.ts` 的共享连接池）访问 Aurora。v1 的 `data/*.json` 文件模式已不再使用。
:::

## 如何查询实时 AWS 数据？

实时 AWS / Kubernetes 数据通过 **AgentCore MCP Lambda 工具**查询。约 160 个只读工具分布在 **9 个分区网关**（network · container · data · security · cost · monitoring · iac · ops · external-obs）中。

- 所有工具均为 read-only。
- 网关数量为 **9 个**（ADR-004 修订 2026-06-24）— 承载 Prometheus·ClickHouse 连接器的 external-obs 作为第九个网关被配置并参与路由。
- 不再依赖本地 Steampipe（127.0.0.1:9193）服务或对 380 个表的直接访问。

## 可以查询外部可观测性数据（Prometheus / Loki / Tempo / ClickHouse / Datadog）吗？

**可以——通过只读数据源平台**实现。可将外部可观测性后端作为连接器接入，查询指标·日志·链路追踪。

支持对象（示例）：Prometheus、Loki、Tempo、ClickHouse、Mimir 等。

组成要素：

- **连接器 Lambda** — 以 read-only 方式查询外部后端
- **Aurora schema 缓存** — 缓存连接器的 schema
- **`/datasources` Explore 页面** — 直接在 UI 中探索
- **NL→query 聊天注入** — AI 助手将自然语言问题转换为数据源查询

:::info
连接器输入受 **SSRF 防护 + 大小限制**约束（解析前 `readJsonBounded`，阻断 metadata/IMDS）。数据源平台对外部数据**只读**，不会变更 AWS 资源。
:::

## 支持主题和移动端吗？

**主题 — 3 种运行时主题选择器**

- **Cobalt**（默认值）
- **Teal**
- **Dark**

主题保存在 localStorage 中，刷新时无闪烁（flash）地应用，图表与标识（logo）也会随主题变换颜色。在任何位置都可以通过 **Cmd-K 命令面板**快速导航。

**移动端 — 响应式布局**

- 顶栏 + 底部 5 个标签页 + 汉堡抽屉
- 表格 → 切换为卡片形式
- 聊天页面全屏
- 网格重排（reflow）与详情面板（detail sheet）

## 支持多个 AWS 账户吗？

AWSops 线上环境以单账户（`123456789012`）运行。实时 AWS 查询由 AgentCore MCP 工具以执行角色（execution role）执行，对真正的其他账户的查询仅通过独立的 cross-account assume 路径进行。（选择宿主账户为目标时直接使用执行角色，因此不会发生不必要的 self-assume。）所有访问均为只读。
