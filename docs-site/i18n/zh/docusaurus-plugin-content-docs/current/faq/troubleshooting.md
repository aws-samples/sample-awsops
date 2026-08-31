---
sidebar_position: 2
title: 故障排除 FAQ
description: 使用 AWSops 仪表盘时可能遇到的问题及解决方法（访问、认证、数据、AI 诊断）
---

# 故障排除 FAQ

以下是使用 AWSops 仪表盘时可能遇到的问题及其解决方法。AWSops 是运行在 ECS Fargate 上的 Next.js thin-BFF，所有实时 AWS 查询都通过 AgentCore MCP 工具进行，状态保存在 Aurora（PostgreSQL）中。大多数问题可归为以下三类之一：访问路径（边缘）、认证（Cognito）、数据连接（Aurora · 权限）。

## 站点返回 504 或无法访问

当 CloudFront 无法响应或出现 504 Gateway Timeout 时，说明边缘路径（CloudFront → VPC Origin → 内部 ALB → Fargate）中的某处连接中断了。AWSops 没有公开 ALB，因此排查顺序如下。

1. **Fargate 任务状态** — 确认 ECS 服务的任务处于 RUNNING 且在目标组中为 healthy。如果任务在 UNHEALTHY 状态中循环，请参阅下面的"ECS 任务 UNHEALTHY"条目。
2. **TLS end-to-end** — CloudFront → ALB 区段的 TLS 必须无中断地贯通。VPC Origin 必须为 `https-only`（443），且 Origin 域名必须设置为**公开 FQDN**（如 `awsops.example.com`），使 SNI 与 ALB 证书匹配。
3. **ALB 证书 / 监听器** — 内部 ALB 必须以 HTTPS:443 + **区域 ACM 证书**监听（CloudFront 的证书在 us-east-1，但 ALB 使用区域 ACM）。
4. **ALB 安全组** — 这是最常见的 504 原因。ALB SG 必须允许来自 **CloudFront 托管安全组** `CloudFront-VPCOrigins-Service-SG` 的 443。如果仅允许 VPC CIDR，流量会被拦截并产生 504。

:::tip
504 几乎总是由于 **ALB SG 未允许 CloudFront 托管 SG** 导致的。VPC-CIDR-only 规则不起作用。请首先确认已允许来自 CloudFront 托管 SG（`CloudFront-VPCOrigins-Service-SG`）的 443 入站。
:::

:::info
VPC Origin 的协议无法 in-place 变更。要修改 `https-only` 设置，需要在 Terraform 中使用 `create_before_destroy` + 资源替换（`-replace`）。
:::

## 无法登录

AWSops 使用自托管登录表单（`/login`）。以未认证状态访问受保护页面时，边缘（Lambda@Edge）会自动重定向到 `/login`。

1. **使用登录表单** — 在 `/login` 输入用户名和密码后，BFF（`POST /api/auth/login`）调用 Cognito `InitiateAuth(USER_PASSWORD_AUTH)`，成功时签发 `awsops_token` Cookie（id_token，有效期 12 小时）。
2. **凭证错误** — 用户名/密码错误，或用户不存在于 Cognito User Pool 中时，登录会被拒绝。密码重置或用户创建请联系管理员。
3. **检查 Cookie** — 如果已登录却不断被送回 `/login`，请确认 `awsops_token` Cookie 是否正确设置。该 Cookie 是 HttpOnly，无法用 JavaScript 读取，请在浏览器开发者工具 → Application → Cookies 中确认。若已过期（12 小时），重新登录即可。
4. **登出后重新登录** — 如果会话紊乱，请登出（删除 Cookie → `/login`）后重新登录。没有单独的 Hosted UI `/logout` 往返。

:::info
边缘执行的不是简单的过期检查，而是 **RS256 JWKS 签名校验**（包含 iss/aud/token_use）。如果令牌被伪造或由其他 User Pool 签发，将被拒绝。Cognito Hosted UI PKCE 流程（`/_callback`）仅作为暗备份保留，常规登录使用 `/login` 表单。
:::

## 访问管理员页面（设置·自定义）时返回 403

管理员功能在登录之外，还受**服务端管理员门禁**的额外保护。必须满足以下条件之一才能通过。

- 登录用户属于 Cognito 的 **admins 组**，或
- 用户邮箱包含在 SSM 的**管理员邮箱允许列表**中。

如果两者都为空，所有用户都会以 fail-closed 方式收到 403（安全默认值）。将用户加入管理员组，或将邮箱注册到 SSM 允许列表即可解决。

## 数据不显示

数据显示为空的原因大致有三类：(a) 未连接到承载应用状态的 Aurora，(b) 实时 AWS 查询权限不足，(c) 清单同步未执行。

1. **检查会话/认证** — 首先确认登录会话是否有效。令牌过期后 API 调用会被拒绝，页面可能显示为空（参阅上面的"无法登录"）。
2. **检查 Aurora 连接** — 聊天线程、诊断报告、作业队列等应用状态都保存在 Aurora 中。通过 `/api/db` 健康检查确认 DB ping 是否正常。若失败，则是 DB 本身或网络/密钥的问题。
3. **实时 AWS 查询权限** — EC2/IAM 等实时 AWS 数据通过 AgentCore MCP 工具（只读）查询。如果只有特定分区为空，可能是该服务的 `Describe*`/`List*` 权限被拦截（SCP/IAM）。Cost 数据需要 **Cost Explorer 权限**，指标需要 **CloudWatch 权限**。
4. **清单同步** — 如果清单页面的表格为空，可能是清单同步（`steampipe_enabled` 标志，默认 OFF）未执行。清单同步是独立的批量同步功能，与实时查询（MCP）相互独立。

:::tip
如果"仅特定页面"为空 → 很可能是该服务的 **AWS API 权限**（SCP/IAM）问题。如果"所有页面"都为空 → 很可能是**会话过期**或 **Aurora 连接**问题。
:::

## 因 SCP 拦截导致部分数据缺失

当 SCP（Service Control Policy）或 IAM 边界拦截了特定 AWS API 时，可能仅有相应数据部分缺失。

| 被拦截的 API 示例 | 影响 |
|-----------------|------|
| `iam:ListMFADevices` | 无法查询 MFA 状态 |
| `ce:GetCostAndUsage` | 无法查询 Cost 数据 |
| `cloudwatch:GetMetricData` | 无法查询指标/图表 |

AWSops 是只读的，对于被拦截的 API，相应条目会显示为空值，其余部分正常工作。如果需要缺失的数据，请为相应 API 添加读取权限。在不变更权限的情况下，若可以用自然语言进行部分查询，向 AI 助手提问即可获得可用范围内数据的回答。

## 页面加载缓慢

AWSops Web 在 ECS Fargate 上以**预先构建的 standalone 镜像**运行。与在主机上用 `npm run dev` 运行的旧版不同，运行时不会插入额外的构建步骤。如果特定页面仍然缓慢，请检查以下几点。

1. **重型任务交给异步 Worker** — 长时间/大容量/有 OOM 风险的任务（如 AI 综合诊断、报告导出）不由 Web 直接处理，而是入队到异步 Worker 队列。页面上会显示作业状态，完成后填充结果。不立即响应是正常的。
2. **实时 AWS 查询延迟** — Cost Explorer 或 CloudWatch 等 AWS API 的响应可能较慢（数十秒级）。此时页面本身正常，只是数据填充需要时间。
3. **新任务滚动更新** — 部署刚结束时（`make deploy` 触发的 ECS 滚动更新期间）响应可能暂时变慢。滚动结束且 `/api/health` 稳定后即恢复正常。

## ECS 任务在 UNHEALTHY 状态中循环（面向运维人员）

部署后 Fargate 任务持续变为 UNHEALTHY 并被 circuit breaker 回滚时，几乎总是以下三种情况之一。

1. **缺少 `HOSTNAME=0.0.0.0` 运行时 env** — 将 Next.js standalone 部署为容器时，必须在任务定义的 `environment` 中显式声明 `HOSTNAME=0.0.0.0`。仅有镜像 ENV 是不够的 — ECS 会用 ENI IP 覆盖 HOSTNAME，应用无法绑定到 0.0.0.0/loopback，健康检查失败。
2. **健康检查路径不匹配** — 容器与目标组的健康检查路径必须与应用的 `/api/health` 完全一致。不一致时会发生 circuit breaker 循环。
3. **Fargate Worker Dockerfile 使用 `CMD`（禁止 ENTRYPOINT）** — Fargate Worker 镜像必须使用 `CMD`。若使用 exec-form `ENTRYPOINT`，Step Functions 的 `containerOverrides.command` 会被 append 到 ENTRYPOINT，导致 argv 重复、argparse 失败。

:::tip
最常见的原因是没有将 `HOSTNAME=0.0.0.0` 显式声明为**任务定义的运行时 env（而非镜像）**。如果健康检查立即失败，请从这一项开始检查。
:::

## ECS 任务启动时出现 ResourceInitializationError（面向运维人员）

如果任务连启动都无法完成，以 `ResourceInitializationError` 失败，则是注入 Aurora 密钥的 `secrets` valueFrom 的权限问题。

ECS `secrets` valueFrom（Aurora 密钥等）需要**执行角色（execution role）**权限 — 不是 task role。请确认执行角色对该密钥拥有 `secretsmanager:GetSecretValue` 权限。

## AI 综合诊断失败或卡住

AI 诊断不是由 Web 直接执行的，而是由**异步 Worker 层**在后台生成的只读报告（Light·Mid 8+1 个分区（共 9） / Deep 15+1 个分区（共 16））。因此"没有响应"并不等于"失败"。

1. **先检查作业状态** — 请求诊断后，作业会注册到队列并由 Worker 处理。请在报告页面确认作业状态（queued → running → succeeded/failed）。如果是 running，说明正在正常进行中。
2. **以 failed 结束的情况** — Worker 失败时状态会记录为 failed。再次请求相同的诊断即可重试（作业以 job_id 为基准幂等）。
3. **deep + Opus 模型** — 在 deep 诊断（15+1 个分区）中选择 Opus 模型时，会应用成本门禁且耗时更长。想要快速查看，请使用默认 Sonnet 的 Light/Mid 诊断。
4. **数据权限** — 诊断需要读取实时 AWS 数据，因此被拦截 API（Cost/CloudWatch 等）对应的分区可能显示为空（参阅上面的"SCP 拦截"）。这不是诊断本身的失败，而是数据可用性问题。

:::info
长时间停滞（stale）的作业会由 reaper（5 分钟周期）自动校正。即使 Worker 死亡导致状态未更新的作业，最终也会被清理为 failed — 如果等待很久仍未变为 succeeded，请重试。
:::

## AI 助手响应异常或出现权限错误

AI 助手使用只读工具（约 160 个）查询实时 AWS 数据，会话保存在 Aurora 中。

1. **只读行为** — AWSops 不会更改 AWS 资源。对"请修改/删除资源"的请求被拒绝，或仅以诊断/指引回应，都是正常的（永久 read-only 策略）。
2. **权限错误** — 如果特定查询以 AccessDenied 失败，说明该服务的读取权限被拦截。被拦截的范围会从回答中排除，仅以可用数据作答。
3. **会话消失** — 会话持久化在 Aurora 中，可从侧边栏重新打开。如果看不到，可能是会话（登录）发生变化或已过期。

## 数据源（Prometheus/Loki 等）无法连接

`/datasources` 中的只读连接器（Prometheus · Loki · Tempo · ClickHouse · Mimir 等）通过连接器 Lambda 查询外部可观测性后端。

1. **端点可达性** — 连接器必须能在网络上到达相应端点。private 端点需要 VPC 路径。
2. **SSRF 防护** — 连接器输入应用了 SSRF 防御。到元数据/IMDS 地址等内部地址的连接会被拦截。指向公司内部地址时可能被阻止。
3. **凭证** — 需要认证的后端使用保存在 Secrets Manager 中的凭证。出现 401/403 时请确认密钥是否正确。
4. **响应大小** — 连接器输入有大小限制（解析前应用 bound）。过大的负载会被拒绝。

## 通知无法发送到外部（Slack/工单）

外部记录/工单/消息写入是在治理约束下运行的可选功能，默认可能处于标志 OFF 状态。

1. **功能是否已启用** — 外部写入以治理（目的地允许列表 · 密钥 · DLP/脱敏 · 人工门禁 · 标志）为前提。若处于禁用状态，消息不会发送。
2. **目的地允许列表** — 如果目标（频道/端点）不在允许列表中，发送会被拦截。
3. **凭证** — 外部服务令牌/Webhook 保存在 Secrets Manager 中。若过期/有拼写错误，发送会失败。

:::info
外部写入是**数据记录（消息·工单）**的创建，而不是 AWS 资源变更。AWS 资源变更与自主执行已永久冻结。
:::
