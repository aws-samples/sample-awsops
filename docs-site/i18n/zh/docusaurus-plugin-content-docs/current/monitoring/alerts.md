---
sidebar_position: 9
title: 告警管道
description: 接收 CloudWatch / Alertmanager / Grafana Webhook、告警关联分析、自动 AI 诊断、Slack 通知
---

# 告警管道

:::caution 旧版页面（基于 v1）
本页面基于 v1 时期的告警管道（告警联动诊断从 15 个分区的固定目录中选择分区、`src/` 路径）编写。
当前 v2 的诊断采用 **Light / Mid / Deep（15+1 个分区，共 16 渲染）** 的层级结构 — 最新行为请参见
[FAQ · AI 助手](../faq/ai-assistant.md)。
:::


这是一条将外部告警系统的事件接收到 AWSops 中，一次性完成**关联分析 → 自动 AI 诊断 → Slack 通知**的管道。

## 支持的来源

| 来源 | 接收方式 | 规范化 |
|------|----------|--------|
| **CloudWatch Alarms** | SNS → SQS → EC2 轮询 | CloudWatch 事件 Schema |
| **Prometheus Alertmanager** | 直接 Webhook (HMAC) | Alertmanager v4 Schema |
| **Grafana Alerting** | 直接 Webhook (HMAC) | Grafana unified alerting |
| **Generic JSON** | 直接 Webhook (HMAC) | 自定义 Schema 映射 |

## 架构概览

```
[CloudWatch Alarm] → SNS Topic → SQS Queue
                                    ↓
                            [EC2 Poller (15s)]
                                    ↓
[Alertmanager/Grafana/Generic] → POST /awsops/api/alert-webhook
                                    ↓
                            [alert-correlation.ts]
                                    ↓
                         [alert-diagnosis.ts (AI)]
                                    ↓
                          [Slack/SNS 发送]
```

详细的设置步骤见服务器端的[运维手册](https://github.com/Atom-oh/awsops/tree/main/docs/runbooks/alert-pipeline-troubleshoot.md)。

## Webhook 端点

### POST /awsops/api/alert-webhook

| 参数 | 位置 | 说明 |
|---------|------|------|
| `X-Alert-Source` | Header | `cloudwatch`、`alertmanager`、`grafana`、`generic` |
| `X-Signature-256` | Header | HMAC-SHA256 签名（共享密钥） |
| Body | JSON | 各来源的原始 Payload |

### HMAC 签名

共享密钥保存在 `data/config.json` 的 `alertWebhookSecret` 中。发送方必须使用 HMAC-SHA256 对 raw body 进行签名，并通过 `X-Signature-256: sha256=<hex>` 头发送。

```bash
# Alertmanager webhook_configs 示例
- url: https://awsops.example.com/awsops/api/alert-webhook
  http_config:
    authorization:
      type: HMAC
      credentials: "<共享密钥>"
```

### GET /awsops/api/alert-webhook

查询活跃事件（incident）列表。仪表板顶部的 🚨 徽章以及主页的 "Recent Incidents" 卡片会以 30 秒的周期轮询此 API。

```json
{
  "activeCounts": { "total": 3, "critical": 1, "warning": 2 },
  "activeIncidents": [
    {
      "id": "inc-20260422-093015",
      "severity": "critical",
      "status": "investigating",
      "alertCount": 7,
      "affectedServices": ["payment-api", "order-service"],
      "topAlertName": "HTTPErrorRateHigh"
    }
  ]
}
```

## 关联分析引擎

`src/lib/alert-correlation.ts` 按以下标准将各条告警分组为**事件（incident）**：

| 标准 | 默认值 | 说明 |
|------|--------|------|
| **时间窗口** | 5 分钟 | 合并同一服务在 5 分钟内产生的告警 |
| **共同服务** | 1 个以上 | `labels.service` 或 `resource` 一致 |
| **共同命名空间** | 1 个以上 | K8s 告警的 `labels.namespace` 一致 |
| **去重** | 1 分钟 | 抑制 1 分钟内相同 `fingerprint` 的重复告警 |
| **严重度升级** | `warning` → `critical` | 5 分钟内累计 3 条 warning → 升级为 critical |

## 自动 AI 诊断

严重度为 `critical` 的事件会自动触发部分 AI 诊断：

1. **构建 AlertContext**：提取受影响的服务、资源、命名空间、触发时刻（since）
2. **限定范围采集**：将 CloudWatch 指标查询过滤为以 `since` 为基准的 ±10 分钟、仅限相关资源
3. **选择相关分区**：在 15 个分区中仅执行 Compute / Network / Container 等 3~5 个
4. **变更检测**：与 Terraform state / CloudTrail 最近变更进行比对
5. **Bedrock 分析**：使用 Claude Sonnet 推断根本原因 + 提出 Next Steps

:::tip 与完整诊断的区别
[AI 综合诊断](./ai-diagnosis.md)会以全部资源为基准运行全部 15 个分区，而 Alert-Triggered Diagnosis **仅限于触发告警的范围**，可在 1~2 分钟内完成。
:::

## Slack 通知

### Block Kit 消息

按严重度路由到以下频道（`data/config.json` 的 `slackChannels`）：

| 严重度 | 默认频道 | 颜色 |
|-------|---------|------|
| `critical` | `#incidents` | 红色 |
| `warning` | `#alerts` | 橙色 |
| `info` | `#alerts-low` | 蓝色 |

### 线程更新

事件的首次通知以**主消息**发布，后续事件（追加告警合并、AI 诊断结果、解决通知）以**同一线程内的 reply** 发布。Slack Webhook 模式和 Bot Token 模式下均可工作。

### 解决通知

收到 CloudWatch `OK` 状态或 Alertmanager `resolved` 事件时，会在原线程中追加 ✅ 解决通知。

## 告警知识库

诊断记录会永久保存在 `data/alert-diagnosis/` 下：

| 文件 | 内容 |
|------|------|
| `incidents/<id>.json` | 单个事件 + AI 诊断结果 |
| `summary-<YYYY-MM>.json` | 月度统计（top services、alert names、resolution time） |

在 UI 的 **Knowledge Base** 标签页中可以搜索过去的相似事件，且发生新事件时会基于相似度自动推荐。

## 告警噪声控制

### Silence 窗口
可以对特定标签组合在一定时间内进行抑制：

```json
{
  "silences": [
    {
      "matcher": { "service": "batch-job", "alertname": "HighCPU" },
      "startsAt": "2026-04-22T00:00:00Z",
      "endsAt":   "2026-04-22T06:00:00Z",
      "reason": "夜间批处理窗口"
    }
  ]
}
```

### 重复抑制
相同 `fingerprint` + 1 分钟以内 → 自动忽略。

## 使用技巧

### 发送测试事件
```bash
curl -X POST https://awsops.example.com/awsops/api/alert-webhook \
  -H 'X-Alert-Source: generic' \
  -H "X-Signature-256: sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $2}')" \
  -H 'Content-Type: application/json' \
  -d "$BODY"
```

### 查看活跃事件
点击仪表板页头的 🚨 徽章会跳转到 `/ai-diagnosis` 页面，可查看进行中事件的详情视图。

### 收不到告警时
服务器端运维手册 [alert-pipeline-troubleshoot.md](https://github.com/Atom-oh/awsops/tree/main/docs/runbooks/alert-pipeline-troubleshoot.md) 中提供了按症状分类的检查清单。

## 相关页面

- [AI 综合诊断](./ai-diagnosis.md) — 全部 15 个分区的诊断
- [CloudWatch](./cloudwatch) — 告警来源
- [外部数据源](./datasources) — Alertmanager/Grafana 查询源头

## 参考

- ADR-009: 告警触发 AI 诊断
- ADR-012: SNS 通知策略
- ADR-013: 自动采集调查代理
