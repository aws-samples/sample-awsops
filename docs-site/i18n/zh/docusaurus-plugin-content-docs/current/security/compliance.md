---
sidebar_position: 3
---

import Screenshot from '@site/src/components/Screenshot';

# CIS Compliance

CIS Compliance 页面基于 AWS CIS（Center for Internet Security）基准评估安全合规状态。使用 Powerpipe 自动检查数百个控制项。

<Screenshot src="/screenshots/security/compliance.png" alt="Compliance" />

## 支持的基准

支持以下 CIS AWS Foundations Benchmark 版本：

| 版本 | 控制项数 | 备注 |
|------|----------|------|
| CIS v4.0.0 | 最新 | 2024 年发布 |
| CIS v3.0.0 | 默认选择 | 推荐版本 |
| CIS v2.0.0 | 旧版 | |
| CIS v1.5.0 | 旧版 | |

:::tip 版本选择
如无特殊需求，建议使用 CIS v3.0.0。它既反映了最新的安全建议，又足够稳定。
:::

## 运行基准检查

1. 从下拉框中选择基准版本
2. 点击 **Run Benchmark** 按钮
3. 运行期间会显示进度状态（约需 2-5 分钟）

:::info 运行时间
基准检查会执行数百次 AWS API 调用。根据 AWS 资源数量，可能需要 2-5 分钟。
:::

## 结果摘要

### 统计卡片

| 指标 | 说明 |
|------|------|
| Pass Rate | 通过率（OK / 全部） |
| Total Controls | 已检查的控制项总数 |
| OK | 通过的控制项 |
| Alarm | 失败的控制项（需要采取措施） |
| Skipped | 跳过的控制项 |
| Errors | 执行错误 |

### 通过率标准

| 通过率 | 状态 | 含义 |
|--------|------|------|
| 80% 以上 | 绿色 | 良好 |
| 50-79% | 橙色 | 需要改进 |
| 50% 以下 | 红色 | 需要严肃处理 |

## 可视化图表

### Compliance Status（饼图）
显示按控制项状态的分布：

- **OK**（绿色）：通过
- **Alarm**（红色）：失败 - 需要采取措施
- **Skip**（灰色）：跳过 - 不适用
- **Error**（橙色）：执行错误
- **Info**（青色）：信息性

### Alarms by Section（柱状图）
比较各章节的失败（Alarm）数量。请优先关注失败最多的章节。Alarm 为 0 的章节不显示柱；所有章节均为 0 时不显示该图表。柱值按**受检资源（finding）**统计，因此可能大于按控制项统计的 Alarm KPI 磁贴（卡片标注 'per finding'）；告警章节超过 10 个时仅显示前 10（标注 Top 10 of N）。

## 完成邮件通知

基准测试运行**成功**完成后（失败的运行不发送邮件），会发送一封 SNS 邮件，包含基准名称、范围（scope）、总数/通过/失败（Alarm）数量、通过率以及 `/compliance` 链接。它复用 AI 诊断通知的同一 SNS 主题/订阅（由 `diagnosis_notify_enabled` 控制），管理员暂停开关（诊断邮件暂停）也会同时静默此邮件。同一基准的邮件限制为每 60 分钟一封（重复运行不会重复群发）。通知失败不会影响基准结果（尽力而为）。

## 各章节详情

CIS 基准由以下主要章节组成：

| 章节 | 主要检查项目 |
|------|--------------|
| 1. Identity and Access Management | 根账户、MFA、密码策略、IAM 用户 |
| 2. Storage | S3 存储桶加密、阻止公开访问 |
| 3. Logging | CloudTrail、Config、VPC Flow Logs |
| 4. Monitoring | CloudWatch 告警、指标过滤器 |
| 5. Networking | Security Group、NACL、VPC 设置 |

### 章节卡片

每个章节卡片可以查看以下信息：

- 章节标题
- OK / ALARM / SKIP 数量
- 通过率百分比
- 进度条（可视化状态显示）

点击章节卡片会展开该章节的控制项列表。

## 控制项详情

### 控制项列表

点击章节会显示下级控制项列表：

| 图标 | 状态 |
|-------|------|
| 绿色对勾 | OK - 通过 |
| 红色 X | ALARM - 失败 |
| 橙色警告 | ERROR - 错误 |
| 灰色减号 | SKIP - 跳过 |
| 青色信息 | INFO - 信息 |

### 控制项详情面板

点击控制项后，可在滑出面板中查看详细信息：

- **Control ID**：CIS 控制项编号（例如 1.1、2.1.1）
- **Title**：控制项标题
- **Status**：检查结果状态
- **Reason**：通过/失败原因
- **Resource**：检查对象资源的 ARN
- **Description**：控制项说明及建议事项

:::tip 处理失败项
对于 ALARM 状态的控制项，请确认 Reason 和 Resource 后采取措施。大多数控制项都可以在 AWS 控制台或 CLI 中简单修复。
:::

## 结果保存

基准检查结果会缓存在服务器上。即使刷新页面，也会保留最后一次运行的结果。

需要新的结果时，请再次点击 **Run Benchmark** 按钮。
