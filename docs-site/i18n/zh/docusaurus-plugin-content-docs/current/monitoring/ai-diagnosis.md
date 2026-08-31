---
sidebar_position: 8
title: AI 综合诊断
description: （v1 旧版页面）15 分区诊断报告 — 当前 v2 采用 Light/Mid/Deep（15+1）层级，参见 FAQ
---

import Screenshot from '@site/src/components/Screenshot';

# AI 综合诊断

:::caution 旧版页面（基于 v1）
本页面基于 v1 时期的 AI 诊断界面（15 个分区的固定目录、`src/` 路径）编写。
当前 v2 采用 **Light / Mid / Deep（15+1 个分区，共 16 渲染）** 的层级结构 — 最新行为请参见
[FAQ · AI 助手](../faq/ai-assistant.md)。
:::


`/ai-diagnosis` 页面是由 Amazon Bedrock **Claude Opus 4.8** 按 15 个分区对整个 AWS 基础设施进行自动分析的综合报告工具。

<Screenshot src="/screenshots/monitoring/ai-diagnosis.png" alt="AI 综合诊断页面" />

## 概览

| 项目 | 值 |
|------|---|
| **模型** | `global.anthropic.claude-opus-4-8`（固定） |
| **分区数** | 15（成本 4 + 基础设施 6 + 安全/网络 2 + 摘要 3） |
| **输出格式** | DOCX (A4 + TOC)、Markdown、PDF（浏览器 print） |
| **存储位置** | S3 报告存储桶 + `data/reports/*.json` 缓存 |
| **进度轮询** | 5 秒间隔 SSE |
| **自动调度** | 禁用 / 每周 / 隔周 / 每月 (KST) |
| **邮件通知** | 完成时向已登记的收件人发送附带 PDF 的邮件 |

## 页面构成

### 1. 顶部操作栏
- **Run Diagnosis** 按钮 — 立即开始诊断（全部 15 个分区平均 6~10 分钟）
- **Schedule** 图标 — 切换自动调度面板（admin only）
- **Notification** 图标 — 管理邮件通知收件人（admin only）
- **DOCX 下载** — 立即下载最近完成的报告

### 2. 左侧 TOC 边栏
展开已完成的报告后，15 个分区会以 TOC 形式显示，点击即滚动到对应分区。支持多重展开，可同时比较多个分区。

### 3. 报告历史表格
| 列 | 说明 |
|------|------|
| 生成时间 | YYYY-MM-DD HH:MM (KST) |
| 账户 | 目标账户别名（多账户时） |
| 状态 | completed / generating / failed |
| 下载 | DOCX · MD · PDF |

分页：每页 5 条，可按日期范围过滤缩小范围。

## 15 个分区（实际定义顺序）

按 `src/lib/report-prompts.ts` 的 `REPORT_SECTIONS` 数组顺序排列：

| # | section ID | 中文标题 | 英文标题 |
|---|------------|-----------|-----------|
| 1 | `cost-overview` | 成本现状 | Cost Overview |
| 2 | `cost-compute` | 计算成本深度分析 | Compute Cost Deep Dive |
| 3 | `cost-network` | 网络传输成本 | Network & Data Transfer Cost |
| 4 | `cost-storage` | 存储成本深度分析 | Storage Cost Deep Dive |
| 5 | `idle-resources` | 闲置资源与浪费 | Idle Resources & Waste |
| 6 | `security-posture` | 安全现状 | Security Posture |
| 7 | `network-architecture` | 网络架构 | Network Architecture |
| 8 | `compute-analysis` | 计算基础设施分析 | Compute Infrastructure |
| 9 | `eks-analysis` | EKS 与容器分析 | EKS & Container Analysis |
| 10 | `database-analysis` | 数据库分析 | Database Analysis |
| 11 | `msk-analysis` | MSK 与流处理分析 | MSK & Streaming Analysis |
| 12 | `storage-analysis` | 存储基础设施分析 | Storage Infrastructure |
| 13 | `executive-summary` | 综合摘要 | Executive Summary |
| 14 | `recommendations` | 建议与路线图 | Recommendations & Roadmap |
| 15 | `appendix` | 附录：资源清单 | Appendix: Resource Inventory |

:::tip 执行顺序 vs 报告顺序
提示词顺序从 `cost-overview` 开始，但 **Executive Summary**（第 13 项）为了汇总其他分区的结果会在最后合成。TOC 中按定义顺序显示。
:::

## 报告生成流程

1. 点击 **Run Diagnosis** → POST `/awsops/api/report`（action: `generate`）
2. `collectReportData()` 采集 Steampipe + CloudWatch + Cost Explorer 数据
3. 将 `REPORT_SECTIONS` 的 15 个分区依次发送给 Opus（每个分区约 30~60 秒）
4. 页面每 5 秒轮询 GET `?action=status&id=<reportId>` → 显示进度
5. 完成时：
   - 自动生成 DOCX → 上传 S3
   - Markdown 可立即使用
   - PDF 采用触发浏览器 Print 对话框的方式
   - 若启用了邮件通知，则向收件人发送

## 自动调度

在调度面板中设置以下项目（仅限 admin — `adminEmails` 校验）：

| 字段 | 值 |
|------|---|
| `enabled` | true/false |
| `frequency` | `weekly` / `biweekly` / `monthly` |
| `dayOfWeek` | 0(日)~6(六) — 用于 weekly/biweekly |
| `dayOfMonth` | 1~28 — 用于 monthly |
| `hour` | 0~23（以 KST 为准，默认 6 点） |
| `accountId` | 限定特定账户（留空则全部） |
| `lang` | `ko` / `en` |

设置保存在 `data/report-schedule.json` 中，`startScheduler()` 每小时通过 `isDue()` 检查并触发。`nextRunAt` 以 KST 为基准计算。

:::info biweekly 安全机制
隔周模式下，如果距离上次执行不足 13 天且距离下次执行不足 7 天，会自动加 7 天以保证至少隔周的间隔（`report-scheduler.ts:85-93`）。
:::

## 邮件通知

在通知面板中管理收件人邮箱列表。诊断完成时：
- 主题：`[AWSops] AI Diagnosis Report — {YYYY-MM-DD}`
- 正文：分区数量、主要建议摘要、下载链接
- 附件：PDF（可选）

收件人列表一并保存在 `data/report-schedule.json` 的 `notifEmails` 字段中。

## 下载格式详情

| 格式 | 生成路径 | 特点 |
|------|----------|------|
| **DOCX** | `lib/report-docx.ts` → API `download-docx` | A4 浅色主题、TOC、页眉/页脚/页码、Markdown→段落/表格/项目符号转换 |
| **Markdown** | API `download-md` | 原始文本（15 个分区全部拼接） |
| **PDF** | `/ai-diagnosis/report` 页面 + 浏览器 Print | 白色背景、A4 分页、无额外 PDF 库（保护 bundle size） |

:::tip 为什么不添加 PDF 库
ADR-019：额外的 PDF 库（Puppeteer 等）会显著增大 Next.js 打包体积和 EC2 内存占用。取而代之的是构建打印专用页面并利用浏览器的 Print-to-PDF — 产出质量相当而依赖为 0。
:::

## 与告警管道的联动

当实时告警系统（CloudWatch / Alertmanager / Grafana）汇总为 `critical` 时，可以触发**部分诊断**（`alert-diagnosis.ts`）：

- 按受影响的服务/资源范围自动选择分区（通常 3~5 个分区）
- 1~2 分钟内完成
- 结果以 reply 形式发布到 Slack 通知线程

详细流程请参考[告警管道](./alerts.md)文档。

## 故障排查

| 症状 | 原因 | 解决方法 |
|------|------|------|
| 卡住超过 10 分钟 | Steampipe 查询超时 | 在 `nextjs` 日志中确认 `statement_timeout` 后仅重跑该分区 |
| DOCX 下载失败 | S3 上传失败 (IAM) | 确认 EC2 实例配置文件包含 `s3:PutObject` 权限 |
| 每天午夜执行 | 未设置 `dayOfMonth` | 使用 monthly 时在 1~28 范围内明确指定 |
| 收不到邮件 | 未确认 SNS 主题订阅 | 在邮箱收件箱中点击 SNS confirm |

## 直接调用 API

```bash
# 开始诊断
curl -X POST /awsops/api/report \
  -H 'Content-Type: application/json' \
  -d '{"action":"generate","lang":"ko"}'

# 查看进度
curl '/awsops/api/report?action=status&id=<reportId>'

# 查询列表 (分页)
curl '/awsops/api/report?action=list&page=1&pageSize=5'

# 更改调度
curl -X POST /awsops/api/report \
  -H 'Content-Type: application/json' \
  -d '{"action":"set-schedule","schedule":{"enabled":true,"frequency":"weekly","dayOfWeek":1,"hour":6,"lang":"ko"}}'
```

## 相关页面

- [告警管道](./alerts.md) — 部分诊断触发
- [Resource Inventory](./inventory.md) — Appendix 分区的数据来源
- [Compliance](../security/compliance) — Security Posture 分区的来源
- [Cost Explorer](./cost) — 成本 4 分区的来源

## 参考

- ADR-019: 诊断报告格式矩阵
- ADR-014: 报告代理下载 URL
- ADR-016: Bedrock 模型选择策略（固定 Opus 4.8）
- `src/lib/report-prompts.ts` — 15 分区提示词定义（精确的输出结构）
- `src/lib/report-scheduler.ts` — 调度计算逻辑（以 KST 为准）
