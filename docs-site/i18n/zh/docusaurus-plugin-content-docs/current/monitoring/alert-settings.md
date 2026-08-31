---
sidebar_position: 9
title: 告警管道设置
description: Webhook 接收 + HMAC 认证 + 关联分析 + AI 自动诊断 + Slack 通知设置（仅限 admin）
---

import Screenshot from '@site/src/components/Screenshot';

# 告警管道设置 (Alert Settings)

`/alert-settings` 页面在一处集中配置从告警 Webhook 接收、AI 诊断自动触发到 Slack 通知发送的整条管道。这是**仅限 admin** 的页面，须通过 `data/config.json` 的 `adminEmails` 校验后才能访问。

<Screenshot src="/screenshots/overview/alert-settings.png" alt="告警管道设置（Access Denied 画面 — 仅限 admin）" />

:::caution 仅限 Admin
非 admin 用户会看到如上截图所示的 **Access Denied** 画面。admin 用户的界面请参考本文档的文字说明。
:::

## 管道整体流程

```
[External]                       [AWSops]
CloudWatch SNS  ─┐
Alertmanager    ─┤              ┌─→ Correlation ─→ Diagnosis ─→ Slack
Grafana         ─┼─→ Webhook ───┤                  (Bedrock      (Block Kit)
SQS poller      ─┤    + HMAC    ├─→ Knowledge      Opus)
Generic JSON    ─┘              │   Base
                                └─→ Stats
```

## 页面构成

### 1. Master Toggle
启用/禁用整条管道。禁用时仍会接收 Webhook，但不会触发诊断。

### 2. Alert Sources（5 种）

| 来源 | 标签 | Payload 规范化 | 认证 |
|------|------|----------------|------|
| `cloudwatch` | CloudWatch Alarm (SNS) | `normalizeCloudWatchAlarm()` | SNS subscription 确认 |
| `alertmanager` | Prometheus Alertmanager | `normalizeAlertmanager()` | HMAC-SHA256 密钥 |
| `grafana` | Grafana Alerting | `normalizeGrafana()` | HMAC-SHA256 密钥 |
| `sqs` | AWS SQS Queue | SNS→SQS 消息正文 | IAM（SQS 轮询器） |
| `generic` | Generic Webhook | `normalizeGeneric()` | HMAC-SHA256 密钥 |

对每个来源配置以下内容：
- **Enabled** 开关
- **Secret** — 用于 HMAC 签名验证（轮换时保留 active+standby 两个）
- **（仅 SQS）** Queue URL + Region

### 3. Webhook URL
页面顶部会显示如下格式的 URL（可复制）：

```
https://<your-host>/awsops/api/alert-webhook?source=alertmanager
```

发送方须使用相同的密钥计算 HMAC，并附加到 `X-AWSops-Signature` 头中。

### 4. Diagnosis Config (Advanced)

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `correlationWindowSeconds` | 30 | 同一告警分组的时间窗口 |
| `deduplicationWindowMinutes` | 15 | 忽略相同 incident 重复的时间窗口 |
| `cooldownMinutes` | 5 | 同一资源重新诊断的最小间隔 |
| `maxConcurrentInvestigations` | 3 | 并发 Bedrock 调用上限（成本控制） |
| `investigationTimeoutSeconds` | 120 | Bedrock 响应超时 |
| `includeChangeDetection` | true | 自动包含 git/CloudTrail 最近变更 |
| `knowledgeBaseEnabled` | true | 检索过去相似案例后附加 |
| `minimumSeverity` | `warning` | 自动诊断触发的最低严重度 |

将 `minimumSeverity = critical` 设置后，只有 critical 才会自动执行 AI 诊断（成本优化）。

### 5. Slack 设置

| 字段 | 说明 |
|------|------|
| `enabled` | Slack 发送的主开关 |
| `method` | `bot` (Bot Token) / `webhook` (Incoming Webhook) |
| `botToken` | Slack Bot Token (`xoxb-...`) |
| `webhookUrl` | Webhook URL（`method=webhook` 时） |
| `defaultChannel` | `#ops-alerts` 等兜底频道 |
| `channelMapping` | 按严重度的频道路由 |
| `threadUpdates` | 将同一 incident 的后续通知汇集到线程中 |

**默认频道映射：**
```
critical → #ops-critical
warning  → #ops-alerts
info     → #ops-general
```

通过 **Test Slack** 按钮发送测试消息即可确认连接。

### 6. Diagnosis History
底部的诊断历史区块显示以下内容：

- 最近的 incident 列表（incidentId、timestamp、alertNames、rootCause、confidence）
- 统计：incident 总数、按严重度分布、按类别分布、Top 告警名称、平均处理时间
- 展开每一行即可查看完整的 Bedrock 诊断 Markdown

## 关联分析的工作方式

`alert-correlation.ts` 按以下标准对告警进行分组：

1. **基于时间** — 在 `correlationWindowSeconds`（默认 30s）内到达的告警
2. **基于服务** — `service` 标签相同的告警（例：`eks`、`rds`）
3. **基于资源** — `resourceArn`/`namespace`/`instanceId` 相同的告警
4. **严重度升级** — 同一组内 `warning` 累积后升级为 `critical`
5. **去重** — 在 `deduplicationWindowMinutes`（默认 15m）内相同签名合并为单一 incident

分组后的 incident 达到 `minimumSeverity` 以上时，`alert-diagnosis.ts` 会自动触发。

## AI 诊断流程

1. 将诊断范围限定为受影响的服务/资源/命名空间
2. 并行调用采集器（`src/lib/collectors/*.ts`）和外部数据源（Prometheus、Loki 等）
3. 若启用变更检测（`includeChangeDetection`），附加最近的 git 提交·CloudTrail 事件
4. 若启用知识库（`knowledgeBaseEnabled`），检索 5 条相似案例作为上下文附加
5. 使用 Bedrock Claude Opus 分析 → Markdown 响应 + 依据元数据
6. 向 Slack 发送 Block Kit 卡片（若启用了线程更新，则以 reply 形式）

## HMAC 密钥轮换

1. 在 **Standby** 槽位输入新密钥并保存
2. 将发送方切换到新密钥（两个密钥同时有效）
3. 发送方切换完成后，在页面上通过 **Promote** 按钮将 standby → active 提升
4. 废弃旧密钥

该流程是为实现不停机更换密钥而设计的 active+standby 双密钥策略。

## API

```bash
# 查询设置
curl '/awsops/api/steampipe?action=config'

# 确认 admin
curl '/awsops/api/steampipe?action=admin-check'

# 诊断历史
curl '/awsops/api/alert-webhook'

# Slack 测试消息
curl -X POST '/awsops/api/notification' \
  -H 'Content-Type: application/json' \
  -d '{"action":"test","channel":"#ops-alerts"}'

# 发送模拟告警 (用于测试)
curl -X POST '/awsops/api/alert-webhook?source=generic' \
  -H 'X-AWSops-Signature: <hmac>' \
  -H 'Content-Type: application/json' \
  -d '{"source":"manual","title":"Test alert","severity":"warning","message":"Hello"}'
```

## 故障排查

| 症状 | 原因 | 解决方法 |
|------|------|------|
| 401 Unauthorized | HMAC 验证失败 | 确认密钥同步，头名称为 `X-AWSops-Signature` |
| 诊断未触发 | severity 低于最低值 | 调低 `minimumSeverity` 或检查告警 severity 映射 |
| 收不到 Slack 消息 | Bot Token 权限不足 | 在 OAuth scope 中添加 `chat:write`、`chat:write.public` |
| Bedrock 超时 | `investigationTimeoutSeconds` 过短 | 从 120 秒调高到 180 秒，检查数据源响应时间 |
| 重复告警泛滥 | `deduplicationWindowMinutes` 过短 | 从 15 分钟调高到 30 分钟，为同一 source 单独设置 cooldown |

## 相关页面

- [AI 综合诊断](./ai-diagnosis) — alert-triggered 部分诊断的基础
- [External Datasources](./datasources) — 诊断时并行调用的外部数据
- [Monitoring](./monitoring.md) — 告警来源（CloudWatch metrics 画面）
- [AgentCore](../overview/agentcore) — 执行诊断的 AI Runtime

## 参考

- ADR-022: 告警关联分析策略
- ADR-026: HMAC 密钥 active+standby 双密钥策略
- `src/lib/alert-types.ts` — 5 种来源的规范化逻辑
- `src/lib/alert-correlation.ts` — 分组/去重/升级
- `src/lib/alert-diagnosis.ts` — Bedrock 诊断编排
- `src/lib/slack-notification.ts` — Block Kit 消息 + 频道路由
