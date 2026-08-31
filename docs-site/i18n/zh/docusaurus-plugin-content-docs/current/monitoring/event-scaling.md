---
sidebar_position: 10
title: 事件预扩容
description: ADR-010 Phase 1+2 — 流量事件登记、历史指标分析、基于 AI 的预热脚本生成
---

import Screenshot from '@site/src/components/Screenshot';

# 事件预扩容 (Event Pre-Scaling)

`/event-scaling` 页面为即将到来的流量事件（黑色星期五、开票抢购、直播等）生成**基于 AI 的预热计划**。这是 ADR-010 Phase 1+2 的实现，**仅执行到计划生成 + 脚本导出为止**，**执行由运维人员手动审核后自行完成**。

<Screenshot src="/screenshots/overview/event-scaling.png" alt="事件预扩容页面" />

## 概览

| 项目 | 值 |
|------|---|
| **模型** | Bedrock Claude Sonnet 4.6 (`global.anthropic.claude-sonnet-4-6-v1`) |
| **权限** | 仅限 admin — `data/config.json` 的 `adminEmails` |
| **状态机** | planned → analyzing → plan-ready → approved / cancelled |
| **执行** | **无** — 导出为 bash 脚本，由人工直接执行 |
| **存储位置** | `data/event-scaling/<eventId>.json` |
| **支持的资源** | KEDA、HPA、Aurora replica/ACU、MSK broker/partition、ASG、EC2、EBS IOPS、ALB |

:::caution Phase 2 的局限
生成的脚本**仅供人工审核使用**。AWSops 不会直接执行基础设施变更（KEDA 部署、AWS API 调用）。自动执行 + IAM 扩展 + KEDA 集成将在 ADR-029 Phase 3 门控（Proposed）中另行处理。
:::

## 工作流

```
[New Event] → [Save] → [Analyze] → [Review Plan] → [Approve | Cancel]
              POST     POST        UI 展开          POST approve / DELETE
              create   analyze
                       ├ metrics  fetch
                       └ bedrock  generate
```

### 1. 事件登记（`planned`）
通过 **+ New Event** 按钮输入以下字段：

| 字段 | 说明 |
|------|------|
| Event Name | 用于识别的标签（例："Black Friday 2026"） |
| Description | 自由文本备注 |
| Event Start / End | KST 时间 (ISO 8601) — 峰值窗口 |
| Pattern Type | `flash-sale`、`sustained-peak`、`gradual-ramp`、`ticket-drop` |
| Expected Peak Multiplier | 相对平时的倍数（例：`10` = 10 倍） |
| Duration Minutes | 峰值持续时间 |
| Ramp-Up Minutes | 预热窗口 |
| Custom Metrics | CloudWatch metric 名称，逗号分隔（可选） |
| Reference Event | 过去相似事件的名称 + 时间（指标回溯基准） |
| Target Account | 多账户时限定 |

### 2. 指标采集 + 分析（`analyzing` → `plan-ready`）
点击 **Analyze** 按钮后会依次执行以下步骤：

1. 在 Reference Event 时点的 ±60 分钟窗口（默认）内采集 CloudWatch 指标 → `MetricsSnapshot`
2. 使用 Steampipe 对当前资源状态做快照
3. 将两个数据集发送到 Bedrock Sonnet 4.6 → 生成多阶段预热计划
4. 解析响应末尾的 `PLAN_JSON: { ... }` 标记，提取结构化的 `ScalingPlan`

耗时：通常 30~90 秒。

### 3. 计划审核 + 批准（`plan-ready` → `approved`）
右侧面板展开并显示以下内容：

- **阶段 (Phase)** — 按 T-4h、T-30m 等时点分组
- **目标 (ScalingTarget)** — 资源类型、当前值 → 目标值、单位、理由
- **脚本** — bash/kubectl 代码（按阶段下载或整体 ZIP）
- **预估额外成本** — USD（模型估算的值）
- **模型元数据** — modelId、input/output token
- **Raw analysis** — Bedrock Markdown 原文（用于审计）

**Approve** 按钮不是执行，而是**"审核完成"的标记**。会记录 `approvedBy` + `approvedAt`。

### 4. 取消 / 删除
- **Cancel** — 仅将状态改为 `cancelled`（保留记录）
- **Cancel (hard)** — 使用 `?hard=true` 标志删除 JSON 文件

## 支持的资源类型

| Type | 脚本生成器 (`event-scaling-scripts.ts`) | 说明 |
|------|------|------|
| `keda` | `kubectl scale` + ScaledObject 补丁 | EKS 工作负载预扩容 |
| `hpa` | `kubectl patch hpa` | 调整 minReplicas/maxReplicas |
| `aurora-replica` | AWS CLI `modify-db-cluster` | 增加 Reader 节点数量 |
| `aurora-acu` | AWS CLI `modify-db-cluster` | Serverless v2 ACU 上限 |
| `msk-broker` | AWS CLI `update-broker-count` | 追加 MSK Broker |
| `msk-partition` | `kafka-topics.sh --alter` | 增加 Topic 分区 |
| `asg` | AWS CLI `update-auto-scaling-group` | 调整 Desired/Max |
| `ec2` | AWS CLI `run-instances` | 预先启动额外实例 |
| `ebs-iops` | AWS CLI `modify-volume` | 提高 gp3 IOPS/throughput |
| `alb-capacity` | （仅备注） | ALB 自动扩容预热 |

所有脚本均供**审核后手动执行** — 包含 `set -euo pipefail` + `--dry-run` 注释。

## API

```bash
# 列表
curl '/awsops/api/event-scaling?action=list&accountId=111111111111'

# 单条详情
curl '/awsops/api/event-scaling?action=detail&id=<eventId>'

# 登记
curl -X POST '/awsops/api/event-scaling?action=create' \
  -H 'Content-Type: application/json' \
  -d '{"name":"BF2026","eventStart":"2026-11-27T13:00:00+09:00","eventEnd":"2026-11-27T18:00:00+09:00","pattern":{"type":"flash-sale","expectedPeakMultiplier":10,"durationMinutes":120,"rampUpMinutes":60}}'

# 指标 + 分析
curl -X POST '/awsops/api/event-scaling?action=analyze&id=<eventId>'

# 批准标记
curl -X POST '/awsops/api/event-scaling?action=approve&id=<eventId>'

# 下载脚本 (text/x-shellscript)
curl '/awsops/api/event-scaling?action=script&id=<eventId>' -o warmup.sh

# 取消
curl -X DELETE '/awsops/api/event-scaling?id=<eventId>'
```

## 模式指南

| 模式 | 使用示例 | 推荐 ramp-up |
|------|---------|-------------|
| `flash-sale` | 黑色星期五、商城促销开抢 | 30~60 分钟 |
| `sustained-peak` | 直播、会议 | 60~120 分钟 |
| `gradual-ramp` | 营销活动、新闻邮件发送 | 120~240 分钟 |
| `ticket-drop` | 演唱会开票、限量版发售 | 15~30 分钟 |

## 故障排查

| 症状 | 原因 | 解决方法 |
|------|------|------|
| Reference Event 指标为空 | 当时不存在该资源或 IAM 权限不足 | 确认 EC2 实例配置文件包含 `cloudwatch:GetMetricStatistics` |
| `PLAN_JSON` 解析失败 | Bedrock 响应被截断 (max tokens) | 调高 `eventScalingMaxTokens` 配置、减少阶段数 |
| Approve 后未自动执行 | Phase 2 的预期行为 | 导出脚本后手动执行（计划在 Phase 3 中改变） |
| 多账户未隔离 | 缺少 `accountId` | 登记时指定 Target Account |

## 相关页面

- [Resource Inventory](./inventory) — 事前掌握资源现状
- [Monitoring](./monitoring.md) — 查看平时指标
- [Cost Explorer](./cost) — 验证预扩容的成本影响
- [AI 综合诊断](./ai-diagnosis) — 事件后复盘报告

## 参考

- **ADR-010 Phase 1+2** — 事件登记 + AI 计划生成（当前实现）
- **ADR-029** — Phase 3 mutating action 门控 (Proposed)
- `src/lib/event-scaling.ts` — 数据模型 + JSON 持久化
- `src/lib/event-scaling-prompts.ts` — Bedrock 提示词 + `PLAN_JSON` 标记解析
- `src/lib/event-scaling-scripts.ts` — 按资源生成安全的 bash 脚本
