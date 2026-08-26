---
sidebar_position: 3
title: AI Assistant FAQ
description: AWSops AI assistant — hybrid routing, AgentCore MCP tools, Aurora-persisted conversations, AI Diagnosis, and the read-only posture.
---

# AI Assistant FAQ

Questions and answers about the AWSops AI assistant.

<details>
<summary>What questions can I ask?</summary>

The AI assistant answers AWS/Kubernetes operations questions across **8 section domains**. Which domain it needs is determined automatically (see "routing" below) — just ask in natural language.

| Domain | Example questions |
|--------|-------------------|
| **Network** | "I can't connect from EC2 A to B", "Check VPC peering routing", "Analyze Security Group rules" |
| **Container** | "EKS Pod is Pending", "What caused the ECS service deployment failure?" |
| **Data** | "RDS connection is slow", "What's causing DynamoDB throttling?", "ElastiCache memory shortage" |
| **Security** | "Analyze permissions in this IAM policy", "Simulate S3 bucket access", "Set up cross-account roles" |
| **Monitoring** | "How to set up CloudWatch alarms", "Find a specific event in CloudTrail", "Analyze EC2 CPU trends" |
| **Cost** | "Analyze this month's costs", "What caused the cost spike?", "Recommend cost optimizations" |
| **IaC** | "Review this Terraform", "Why did the CloudFormation stack creation fail?" |
| **Ops** | General AWS operations questions that don't fit the above |

If you've connected datasources (external observability), you can also query them by translating natural language directly into PromQL/LogQL and the like — see "external observability" below and the [Datasource Development FAQ](./datasource-development).

</details>

<details>
<summary>How does a question get routed to the right domain?</summary>

The AI assistant uses **hybrid routing** (ADR-038, LIVE). It is no longer a fixed route registry that sends every question to a large model.

**Three-stage pipeline**

1. **Regex fast-path** — clear signals ("EKS pod", "IAM policy", "cost spike", etc.) are matched by pattern alone and routed instantly, with no model call (zero latency / cost).
2. **Haiku 4.5 classifier** — if the fast-path doesn't decide, a lightweight, fast Haiku model classifies the question and sends it to the right section.
3. **Prompt caching** — system prompts / tool definitions are cached to cut latency and token cost on repeat calls (cache hit rate ~59%).

:::tip
Want to pick a domain explicitly? Type a slash (`/`) in the input box. See the "slash domain selection" item below.
:::

</details>

<details>
<summary>How does it fetch AWS data in real time?</summary>

Live AWS queries go through **AgentCore MCP (Model Context Protocol) Lambda tools**. The assistant queries exactly the data it needs to answer, then analyzes it.

- **~120 read-only tools** are spread across **8 section gateways** (Network / Container / Data / Security / Monitoring / Cost / IaC / Ops). The tool count is approximate and evolving.
- External observability is the separate **Integrations axis** (ADR-039), not a 9th gateway — the gateway count stays at 8 (ADR-004).
- Steampipe exists only as a **flag-gated inventory sync** (`steampipe_enabled`, default OFF). It is not the live query engine, and not an always-on local service.

:::info Technical Details
The gateway↔Lambda relationship, MCP protocol internals, and how to add new tools are covered in the [AgentCore & Memory FAQ](./agentcore-memory).
:::

</details>

<details>
<summary>Can I pick a domain explicitly with a slash (/)?</summary>

Yes. Automatic routing is the default, but typing a slash (`/`) in the input box lets you select a section domain directly (`/network`, `/cost`, `/security`, etc.). An explicit pick skips routing detection and goes straight to that section.

**Automatic domain badge**

Even when you don't pick one, each response shows a **domain badge** indicating which domain it was routed to. If it went somewhere unintended, re-specify with a slash or make your question more specific.

</details>

<details>
<summary>Is conversation history saved?</summary>

Yes. Conversations are persisted as threads in **Aurora** (PostgreSQL). The file-based per-user memory (`data/memory/`) is no longer used.

- **Claude-app-style sidebar** — browse past threads in the left sidebar, start a new conversation, or continue an earlier one.
- **A dedicated page and a drawer share one history** — the full page (`/assistant`) and the resizable chat drawer (available anywhere) share the **same thread history**. A conversation started in the drawer continues seamlessly on the full page.
- **Deep-linking** — open a specific thread directly with `?thread=<id>`, making it easy to share a conversation link with a teammate.
- Responses render as Markdown, with text streamed in real time.

</details>

<details>
<summary>Does the assistant ever change resources?</summary>

**No.** AWSops is a **read-only operations dashboard + AI diagnosis**. The assistant does **not** create, modify, delete, or restart AWS resources.

- **AWS-resource mutation and autonomy are permanently frozen** (do-not-enable) — per the 2026-06-11 high-risk ADR reversal consensus.
- The assistant only provides diagnosis, root-cause analysis (RCA), and recommendations. You make any actual change yourself in the AWS Console / IaC.
- On the **external-data** side only, governed external observability **reads** and external record/ticket/message **writes** are permitted (ADR-041). These pass through SSRF guard · Secrets Manager · DLP/redaction · destination allowlist · human-gate · flag-OFF controls, and are **data records in external systems, not AWS-resource changes**.

:::tip
A mutation request like "assistant, restart this instance" will not be executed. Ask instead, "diagnose why this instance is unstable."
:::

</details>

<details>
<summary>What is AI Diagnosis?</summary>

**AI Diagnosis** is a **read-only** diagnostic report run asynchronously by the worker tier. Because it's a heavy multi-step collection-and-analysis job, it isn't handled inline like chat — it's enqueued as a background job and executed.

**Two depth tiers**

| Tier | Sections | Default model |
|------|----------|---------------|
| **Base** | 8 sections | Sonnet |
| **Deep** | 15 sections (base 8 + 6 deep-only + synthesis) | Sonnet by default, **Opus selectable** (deep-only, behind a cost gate) |

**Features**

- **Auto-title** + **tags** (auto-suggested + manual) + title editing.
- **Soft delete** — deleting preserves history; only the owner or an admin can delete.
- **Export** — generated as DOCX / PDF, stored in S3, and proxy-downloaded from the app (CJK fonts embedded, including Korean).
- Generation timestamps are shown in **KST**.

Diagnosis reuses the existing collection tools and is strictly **read-only** — it changes no AWS resources.

</details>

<details>
<summary>Can code be executed?</summary>

Yes. Python code can be executed through the **Code Interpreter**, used automatically for data-analysis and visualization questions.

**Supported**

- Python 3.x runtime, key libraries (pandas, numpy, matplotlib, etc.)
- Chart/graph generation, file I/O within a temporary directory

**Limitations**

- Sandbox environment (network access restricted) · execution time limits
- Does not call AWS APIs directly — the assistant queries data first via MCP tools, then analyzes that data with code.

**Example questions**

- "Show EC2 cost by instance type as a pie chart"
- "Analyze CloudTrail events over the last 30 days by time period"
- "Calculate Lambda function memory usage statistics"

</details>

<details>
<summary>What if the AI gives an incorrect answer?</summary>

The AI assistant is based on Amazon Bedrock (Claude Sonnet / Opus / Haiku).

**Data accuracy**

- AWS resource data is queried **in real time** via AgentCore MCP tools.
- The data itself is accurate, but the AI's **interpretation** may be wrong.

**How to handle it**

1. **Verify with follow-up questions** — "What's the source of that?", "Explain in more detail."
2. **Verify directly** — check the relevant dashboard page or the AWS Console.
3. **Provide feedback** — say "That's wrong" or "Please check again" to trigger re-analysis. The more specific the error you point out, the more accurate the response.

**AI limitations**

- Cannot immediately detect ongoing incidents (real-time events).
- Latest AWS features may not be in the training data.
- May not account for account-specific configurations or SCP restrictions.

</details>

<details>
<summary>What to do when responses are slow?</summary>

Common causes of AI response delays and their fixes.

**1. AgentCore Runtime cold start** — the first request takes time to spin up the container (tens of seconds); subsequent requests are fast (Warm state).

**2. Complex questions** — questions spanning multiple domains take longer. "Analyze the network and also check costs" → split into two questions.

**3. Large data queries** — CloudTrail events, large resource lists, etc. — specify a time range/filter (e.g. "last 1 hour", "production tag only").

**4. Network path** — CloudFront → internal ALB → Fargate → AgentCore. Check the CloudFront Origin Timeout setting (60 seconds recommended).

**Streaming responses**

Responses are streamed and displayed in real time without waiting for the complete answer.

:::info Technical Details
TTFT (Time To First Token) components and optimization strategies are covered in the [Architecture Deep Dive](./architecture).
:::

</details>
