---
sidebar_position: 3
title: AI 助手 FAQ
description: AWSops AI 助手——关于混合路由、AgentCore MCP 工具、Aurora 对话记录、AI 综合诊断、只读策略的问题与解答。
---

# AI 助手 FAQ

关于 AWSops AI 助手的问题与解答。

<details>
<summary>可以提出哪些问题？</summary>

AI 助手回答横跨 **9 个分区领域**（另有本地专项分区）的 AWS/Kubernetes 运维问题。需要哪个领域会被自动判别（参见下文"路由"），用自然语言提问即可。

| 领域 | 示例问题 |
|--------|-----------|
| **Network** | "从 EC2 A 到 B 连不通"、"帮我检查 VPC 对等连接的路由"、"帮我分析 Security Group 规则" |
| **Container** | "EKS Pod 处于 Pending 状态"、"ECS 服务部署失败的原因是什么？" |
| **Data** | "RDS 连接很慢"、"DynamoDB throttling 的原因是什么？"、"ElastiCache 内存不足" |
| **Security** | "帮我分析这个 IAM 策略的权限"、"模拟 S3 存储桶的访问权限"、"cross-account 角色配置" |
| **Monitoring** | "如何设置 CloudWatch 告警"、"在 CloudTrail 中查找特定事件"、"分析 EC2 CPU 趋势" |
| **Cost** | "分析本月成本"、"成本激增的原因是什么？"、"成本优化建议" |
| **IaC** | "帮我审查这段 Terraform"、"CloudFormation 堆栈创建失败的原因是什么？" |
| **Observability** | "显示服务 p99 延迟（Prometheus）"、"在 ClickHouse 追踪中查找慢调用" |
| **Ops** | 不完全符合上述分类的一般 AWS 运维问题 |

如果已连接数据源（外部可观测性），还可以将自然语言直接转换为 PromQL/LogQL 等进行查询——详情请参阅下文"外部可观测性"以及[数据源开发 FAQ](./datasource-development)。

</details>

<details>
<summary>问题是如何被路由到合适领域的？</summary>

AI 助手使用**混合路由**（ADR-038，LIVE）。不再是把所有问题都抛给大模型的固定路由注册表。

**3 阶段流水线**

1. **正则 fast-path** — 明确的信号（"EKS pod"、"IAM policy"、"cost spike" 等）仅凭模式匹配即可立即确定领域，无需调用模型即完成路由（延迟·成本为 0）。
2. **Haiku 4.5 分类器** — 若 fast-path 未能确定，则由轻量快速的 Haiku 模型对问题进行分类并发送到合适的分区。
3. **提示词缓存** — 缓存系统提示词/工具定义，降低重复调用的延迟与 token 成本（缓存命中率约 59%）。

:::tip
如果想显式选择领域，请在输入框输入斜杠（`/`）。参见下文"斜杠指定领域"条目。
:::

</details>

<details>
<summary>AWS 数据是如何实时获取的？</summary>

实时 AWS 查询通过 **AgentCore MCP（Model Context Protocol）Lambda 工具**完成。助手直接用工具查询回答问题所需的数据，然后进行分析。

- **约 160 个只读工具**分布在 **9 个分区网关**（Network / Container / Data / Security / Monitoring / Cost / IaC / Ops / External-Obs — 依 ADR-004 修订）中。工具数量为约数，仍在持续演进。
- 外部可观测性连接器（Prometheus·ClickHouse）已提升为 **external-obs 网关**，作为第九个网关参与路由（ADR-004 修订 2026-06-24，9 配置 / 9 路由）。其余外部集成属于独立的 **Integrations 轴**（ADR-007/017）。
- Steampipe 仅作为**由 flag 门控的库存同步**（`steampipe_enabled`，默认 OFF）用途存在。它不是实时查询引擎，也不是常驻的本地服务。

:::info 技术细节
网关↔Lambda 的关系、MCP 协议内部机制、如何添加新工具，请参阅 [AgentCore & Memory FAQ](./agentcore-memory)。
:::

</details>

<details>
<summary>可以用斜杠（/）直接指定领域吗？</summary>

可以。自动路由是默认行为，但在输入框输入斜杠（`/`）即可直接选择分区领域（`/network`、`/cost`、`/security` 等）。显式选择后会跳过路由判别，直接发送到该分区。

**自动领域徽章**

即使不手动选择，响应中也会显示**领域徽章**，展示问题被路由到了哪个领域。如果去了与意图不符的领域，可以用斜杠重新指定，或把问题改得更具体。

</details>

<details>
<summary>对话记录会被保存吗？</summary>

会。对话以线程为单位持久保存在 **Aurora**（PostgreSQL）中。基于文件的按用户内存（`data/memory/`）已不再使用。

- **Claude 应用风格侧边栏** — 在左侧侧边栏浏览历史线程，可以开始新对话或继续之前的对话。
- **专用页面 + 抽屉共享同一份记录** — 完整页面（`/assistant`）和可在任意位置调出的可调整大小聊天抽屉共享**同一线程记录**。在抽屉中开始的对话可以在完整页面上无缝继续。
- **深链接** — 通过 `?thread=<id>` 查询参数可直接打开特定线程，便于向同事分享对话链接。
- 响应以 Markdown 渲染，流式输出期间文本也会实时显示。

</details>

<details>
<summary>助手会去改动资源吗？</summary>

**不会。** AWSops 是**只读运维仪表板 + AI 诊断**。助手**不会**创建·修改·删除·重启 AWS 资源。

- **AWS 资源变更与自主执行已永久冻结**（do-not-enable）——这是依据 2026-06-11 高风险 ADR 撤销共识确立的政策。
- 助手只提供诊断·根因分析（RCA）·建议。实际变更由用户在 AWS 控制台/IaC 中自行执行。
- 不过在**外部数据**方面，在治理之下可以**读取**外部可观测性数据，并**写入**外部记录/工单/消息（ADR-041）。这需经过 SSRF 防护·Secrets Manager·DLP/redaction·目的地 allowlist·human-gate·flag-OFF 管控，属于**外部系统的数据记录，而非 AWS 资源变更**。

:::tip
"助手帮我重启这个实例"之类的变更请求不会被执行。请改为提问"帮我诊断为什么这个实例不稳定"。
:::

</details>

<details>
<summary>AI 综合诊断（AI Diagnosis）是什么？</summary>

**AI 综合诊断**是由 worker 层异步执行的**只读**诊断报告。由于是繁重的多阶段采集·分析任务，不会像聊天那样内联处理，而是作为后台任务放入队列执行。

**两种深度（tier）**

| Tier | 章节数 | 默认模型 |
|------|---------|-----------|
| **Light** | 8+1 个章节（共 9 渲染 — 目前与 Mid 相同） | Sonnet |
| **Mid** | 8+1 个章节（共 9 渲染） | Sonnet |
| **Deep** | 15+1 个章节（base 8 + deep 专用 7 + intended-vs-actual，共 16 渲染） | Sonnet 默认，**Opus 可选**（仅 deep，受 cost-gate 约束） |

**功能**

- **自动标题** + **标签**（自动建议 + 手动添加）+ 标题修改。
- **软删除** — 即使删除也会保留记录，只有所有者或 admin 可以删除。
- **导出** — 生成 DOCX / PDF 并存储到 S3，在应用内代理下载（内嵌含韩文在内的 CJK 字体）。
- 生成时间以 **KST** 显示。

诊断复用既有的采集工具，且始终**只读**——不会变更任何 AWS 资源。

</details>

<details>
<summary>可以执行代码吗？</summary>

可以。通过 **Code Interpreter** 可以执行 Python 代码。数据分析·可视化类问题会自动利用它。

**支持**

- Python 3.x 执行环境、主要库（pandas、numpy、matplotlib 等）
- 生成图表/图形、在临时目录内进行文件读写

**限制**

- 沙箱环境（限制网络访问）· 执行时间限制
- 不直接调用 AWS API——助手先用 MCP 工具查询数据，然后用代码分析这些数据。

**示例问题**

- "用饼图展示按 EC2 实例类型划分的成本"
- "按时段分析最近 30 天的 CloudTrail 事件"
- "计算 Lambda 函数内存使用量的统计数据"

</details>

<details>
<summary>AI 给出错误答案时怎么办？</summary>

AI 助手基于 Amazon Bedrock（Claude Sonnet / Opus / Haiku）。

**数据准确性**

- AWS 资源数据通过 AgentCore MCP 工具**实时**查询。
- 即使数据本身准确，AI 的**解读**也可能出错。

**应对方法**

1. **通过追加提问确认** — "那个信息的来源是什么？"、"再详细解释一下"
2. **直接确认** — 在仪表板对应页面或 AWS 控制台验证
3. **提供反馈** — 说"错了"、"再确认一下"会触发重新分析。指出的错误越具体，结果越准确。

**AI 的局限**

- 可能无法即时感知正在发生的故障（实时事件）。
- 最新的 AWS 功能可能不在训练数据中。
- 可能无法考虑账户特有的配置或 SCP 限制。

</details>

<details>
<summary>响应缓慢时怎么办？</summary>

以下是 AI 响应延迟的常见原因与解决方案。

**1. AgentCore Runtime 冷启动** — 首个请求需要时间启动容器（数十秒），之后的请求处于 Warm 状态会更快。

**2. 复杂问题** — 涉及多个领域的问题耗时较长。"分析网络并且也看看成本" → 请拆分为两个问题。

**3. 大量数据查询** — CloudTrail 事件、大规模资源列表等请指定时间范围/过滤条件（例如："最近 1 小时"、"仅 production 标签"）。

**4. 网络路径** — CloudFront → 内部 ALB → Fargate → AgentCore。请确认 CloudFront Origin 超时设置（建议 60 秒）。

**流式响应**

响应以流式输出，无需等待全部完成即可实时显示。

:::info 技术细节
TTFT（Time To First Token）的构成要素与改进方法请参阅[架构 Deep Dive](./architecture)。
:::

</details>
