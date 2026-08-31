---
sidebar_position: 7
title: 重要决策 FAQ
description: 以运维人员视角的 Q&A 形式整理 AWSops 的核心架构决策（ADR）——只读姿态、外部写入治理、AI 路由·诊断、基础设施结构、成本·安全·运维决策。
---

# 重要决策 FAQ

本页将决定 AWSops "为何如此运作"的核心设计判断（ADR，Architecture Decision Records）整理为运维人员最常问的问题形式。每个答案都同时标注了作为依据的 ADR 编号。

完整的决策记录与详细背景可在 `docs/decisions/`（ADR 001~044）中查阅，索引与更正说明位于 `docs/decisions/CLAUDE.md`。

:::info
AWSops 最重要的原则是**只读（read-only）**。不过，该约束精确绑定于 **AWS 资源变更 + 自主执行（autonomy）**（ADR-041）。外部可观测性**数据读取**以及治理之下的外部**数据记录（写入）**不属于该约束——因为它们是数据操作，而非 AWS 资源变更。
:::

## 安全 / Security

### AWSops 会直接变更 AWS 资源或自动采取措施吗？

**不会。AWS 资源变更与自主执行已被永久冻结（do-not-enable）。**

最初设计了变更操作框架（ADR-029）与执行 substrate（SSM Automation + Change Manager × P2 worker 混合，ADR-036），但 **2026-06-11 的 3-AI 共识将两者一并撤销（REVERSED）**。代码以暗（dark）状态保留，但 flag 永久 OFF，不会启用。

- 终止 EC2、修改 SG、扩缩容、部署等 **AWS 资源变更不会通过任何页面·AI 功能执行。**
- 约 160 个 AgentCore MCP Lambda 工具全部为 read-only。

:::info
"冻结"的范围**仅限 AWS 资源**（ADR-029/036 2026-06-16 范围更正，ADR-041 keystone）。管控层与 worker 执行分支可复用于非 AWS 的外部数据写入，但 AWS 资源自动化 substrate 本身维持冻结。
:::

### 向 Slack·Jira 等外部系统写入记录也被禁止吗？

**不——在治理之下是允许的。** 因为这是**数据记录**，而非 AWS 资源变更（ADR-040、ADR-041）。

2026-06-11 撤销之后，ADR-040 针对**非 AWS 资源的外部 knowledge/comms write**（Slack·Notion·Confluence·Jira·ServiceNow 的记录·消息）设置了狭窄的 carve-out，ADR-041 将其作为 keystone 重新校准：read-only 约束 = AWS 资源变更 + 自主执行，**外部数据集成（read+write）除外**。

- 在外部系统中留下报告·工单·消息，在治理管控之下是可行的。
- 对 AWS 基础设施本身的变更权限**不会通过任何途径**授予。

### 向外部写入时没有内部信息泄露的风险吗？

外部数据写入被设计为只能在 ADR-040 的**七大硬性条件**之下运行。核心防护如下：

- **DLP / redaction** — 从流向外部的内容中去除敏感信息（这曾是反对票的核心担忧，因此被着重明示）
- **目的地 allowlist** — 仅向已批准的外部目的地发送
- **SSRF 防护** — 阻断 metadata/IMDS，阻断内部端点
- **密钥由 Secrets Manager** 管理
- **human-gate** — 人工批准后发送（或 draft-only 回退）
- **仅限非 AWS 资源** + **默认 flag-OFF**

:::tip
为与 2026-06-11 共识将 external-endpoint/egress/SSRF 明示为 scope-creep 的立场保持一致，ADR-041 将此项解除明确记为 **owner-override** 而非 'clarification'（已反映在 addendum 中）。也就是说，外部写入不是"例外许可"，而是**管控 mandate** 之下的数据写入标准。
:::

### 登录方式是如何决定的？

AWSops 使用**应用内登录表单**（`/login`）（ADR-042）。

自有 `/login` 表单调用 BFF `POST /api/auth/login` → 通过无签名公开 Cognito `InitiateAuth(USER_PASSWORD_AUTH)` 认证 → 签发 `awsops_token` Cookie（id_token，12 小时）。此后所有请求由 Lambda@Edge 进行 **RS256 JWKS 签名验证**检查。Hosted UI PKCE 流程仅作为暗备（dark fallback）保留。

该决策是在 ADR-037 基础之上对 ADR-020（Cognito + Lambda@Edge）的精炼，遵循最小权限（不授予 REFRESH）。

### 管理员权限如何管控？

采用**服务端 fail-closed 把关**（ADR-023）。

管理功能仅对 Cognito `admins` **组成员**或包含在 SSM **管理员邮箱 allowlist** 中的用户开放。若两条路径均无法确认，则默认拦截（fail-closed）。

## 架构 / Architecture

### 基础设施结构为什么不是单台 EC2？

AWSops 将 v1 的**单台 EC2 单体架构**重构为**基于 Terraform 的 MSA**（ADR-037、ADR-030）。

- **IaC**：Terraform（部分 S3 backend）。CDK 已废弃（ADR-024 → 由 ADR-037 承继）。
- **计算**：ECS Fargate（arm64）。web 作为 Next.js 14 thin-BFF 在根路径提供服务。
- **异步 worker**：繁重或长时/有 OOM 风险的任务不由 web 直接处理，而是发送到 SQS → ESM（kill-switch）→ dispatcher Lambda（幂等）→ Step Functions → Lambda 或 `ecs:runTask.sync` Fargate。

ADR-037 全面承继了 ADR-024，并精炼了 ADR-030 的机制（无实时 Steampipe，仅确定 flag-gated 库存 sync）。

### 数据为什么存储在 Aurora？

数据不放在 EC2 实例内的 JSON 文件，而是持久化到 **Aurora Serverless v2（PostgreSQL 17）**（ADR-030）。

`worker_jobs`（异步任务）、聊天线程、AI 诊断报告、数据源 schema 缓存等应用状态全部存储在 Aurora 中，应用通过 node-pg 访问。由此即使实例重启·替换，状态也得以保留。（Aurora·双 ECR 的意图在 ADR-030 中仍然有效，4 容器/Service Connect/CDK 机制由 ADR-037 承继。）

### 会引入 Neptune 之类的图数据库吗？

**目前不会——已推迟（deferred）**（ADR-043）。

拓扑·资源图用 Postgres 递归 CTE 即可充分处理，因此维持 **Postgres-first** 原则，Neptune 仅作为选项保留且 flag 为 OFF。（2026-06-17 addendum：经 5 族共识重申 Postgres-first；拓扑 UI 维持现行客户端构建，服务端 materialize 待消费方出现时再接线。）

## AI

### AI 会自动分析故障并直接处置吗？

**分析（RCA）会，自动处置（mitigation）不会**（ADR-032，DOWNGRADED 2026-06-11）。

ADR-032 最初定义了事件触发的自主事故生命周期（多 Agent Lead/Sub），但依据 2026-06-11 共识，**自主 mitigation/action 已废弃**，**仅保留 read-only Triage·调查·RCA**（仅供建议，启用时为 analysis-only）。由人基于分析结果进行判断和处置。

### RCA（根因分析）结果记录在哪里？

按设计通过 OpsCenter / Incident Manager 双向写回（write-back）记录（ADR-034，KEPT）。

但由于 ADR-034 目前继承了已冻结的 029/036 substrate role，**在完成自足（self-contained）role 分离并启用 `rca_writeback_enabled` 之前，维持 flag-OFF·do-not-enable**。ADR-041 coherence addendum（2026-06-17）将此写回明示为 **AWS 原生可观测元数据 write（第三层级）**——不属于 FROZEN，而是像数据一样受治理，但 role 分离必须先行。

### AI 路由是如何运作的？

采用 **ADR-038 混合路由**——正则 fast-path + Haiku 4.5 分类器 + 提示词缓存。**2026-06-10 启用 LIVE**。

门禁得分经验证从 hybrid 69.2% → **96.9%（+27.7pp）PASSED**。它不同于以往的 11/18-route Sonnet 注册表方式，而是先用快速正则捕获明确的查询，模糊时再由 Haiku 分类器路由。（分类器超时更正为 3.5s——在全局 cross-region profile 下 1s 不够。）

### 重复的问题会持续产生 AI 成本吗？

**通过提示词缓存与按任务深度选择模型进行优化**（ADR-038、ADR-033）。

- **提示词缓存** — 以约 59% 命中率减少重复上下文的重新计算（ADR-038）。
- **按任务深度选择模型** — AI 诊断的 Light·Mid（8+1 章节，共 9）默认 Sonnet，Deep（15+1 章节，共 16）默认 Sonnet·可选 Opus（cost-gate）。分类·路由使用低成本的 Haiku 4.5（ADR-033）。
- ADR-033 定义了 Aurora durable token budget（预算持久化）——已在 v1 实现，与当前 web 聊天路径的对接是后续课题。

### 网关增加到 9 个了吗？

**是的——共 9 个**（ADR-004 修订，2026-06-24）。

在 network · container · data · security · cost · monitoring · iac · ops 这 8 个 AWS 领域网关之外，承载外部可观测性连接器（Prometheus·ClickHouse）的 **external-obs 网关**作为第九个被配置并参与路由（9 配置 / 9 路由）。其余外部集成属于独立的 **Integrations 轴**（ADR-007/017）。

### 我可以自行追加配置 Agent 或工具吗？

**仅限经过策划（curated）的连接器**（ADR-039、ADR-031、ADR-041）。

ADR-039 多 Agent 平台引入了前沿 Agent（DevOps/Security/FinOps + N）与 Integrations 轴，管理员配置的 Agent Space（ADR-031 Phase 1/2）已 LIVE。不过：

- **任意形态的 BYO-MCP（ADR-031 Phase 3）已废弃**（2026-06-11 撤销）。连接器仅允许**经过策划的形态**（ADR-041）。
- **变更（mutating）工具（ADR-031 Phase 4）**中，仅非 AWS 外部数据 write 在 ADR-040 治理下被狭窄地允许，AWS 资源变更维持废弃。

### Kubernetes（EKS）诊断也由 AI 自动完成吗？

**仅提供 read-only 诊断**（ADR-035，DOWNGRADED 2026-06-11）。

K8sGPT 混合方案（通过 MCP 集成到 AgentCore 的集群内 K8s 诊断，Haiku 4.5）**仅保留 read-only Result-CRD 集成（GET-only）**，通往自动处置的接线（H3a → 032/034/029 提案）已废弃。EKS 查询基于 task-role Access Entry + View policy，全部为只读。

## 运维 / Operations

### 长任务或繁重任务如何处理？

**enqueue 到异步 worker 层**（ADR-037）。

web 是 thin-BFF，因此不直接执行繁重/长时/有 OOM 风险的任务：`POST /api/jobs` → `worker_jobs`（queued）+ SQS → ESM（kill-switch）→ dispatcher Lambda（按 job_id 幂等）→ Step Functions 依据 `$.runtime` 将短任务路由到 RunLambda，长/有 OOM 风险的任务路由到 `ecs:runTask.sync` Fargate → worker 自行记录 running/succeeded → 失败时由 status_updater Lambda 记录 failed → reaper（EventBridge 5 分钟）对 stale 任务进行对账。

:::tip
ESM 带有 kill-switch，可立即停止队列消费；dispatcher 按 job_id 幂等，重复分发会被安全忽略。
:::

### 在哪里可以更详细地查看这些决策？

完整 ADR（001~044）位于 `docs/decisions/`，索引·状态·撤销/更正说明可在 `docs/decisions/CLAUDE.md` 中查阅。2026-06-11 高风险撤销共识文档位于 `docs/reviews/2026-06-11-high-risk-adr-reversal-consensus.md`，外部写入解除共识位于 `docs/reviews/2026-06-14-external-write-unfreeze-consensus.md`。
