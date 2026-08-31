---
sidebar_position: 3
title: CloudTrail
description: 查询 AWS API 活动日志并分析审计事件。
---

import Screenshot from '@site/src/components/Screenshot';

# CloudTrail

可查询记录 AWS 账户 API 活动的 CloudTrail 跟踪（trail）与事件的页面。

<Screenshot src="/screenshots/monitoring/cloudtrail.png" alt="CloudTrail" />

## 主要功能

### 跟踪摘要
- **Total Trails**: 跟踪总数
- **Active**: 已启用日志记录的跟踪数
- **Multi-Region**: 多区域跟踪数
- **Log Validated**: 已启用日志文件验证的跟踪数

### 选项卡结构
| 选项卡 | 内容 |
|---|------|
| Trails | 跟踪列表、配置、S3 存储桶 |
| Recent Events | 最近的 API 事件（所有事件） |
| Write Events | 仅筛选写入事件（资源变更审计） |

:::info Lazy Loading
Events 和 Write Events 选项卡仅在点击时才加载数据（`eventsLoaded` 标志）。进入页面时只查询 `summary` + `trailList`，当用户点击 Events/Writes 任一选项卡时，一次性加载两者 — 由于 CloudTrail Lookup API 调用次数多、响应时间长，这是为避免 CloudFront 30 秒超时而做的优化。
:::

:::tip 多账户
在多账户模式下，可通过侧边栏的 AccountSelector 切换目标账户，跟踪列表及事件中会自动添加 **Account** 列（通过 AccountBadge 显示别名 + 彩色圆点）。跟踪详情面板的标题中也会标明所属账户。
:::

### 跟踪详细信息
点击跟踪行后，可在滑出面板中查看：
- **Trail**: 名称、ARN、主区域、日志记录状态、是否为 Multi-Region
- **Storage**: S3 存储桶、前缀、SNS 主题、KMS 密钥
- **CloudWatch**: 日志组、IAM 角色、最后传送时间
- **Validation**: 日志文件验证、最后交付时间
- **Tags**: 资源标签

### 事件详细信息
点击事件行后可查看：
- **Event**: ID、名称、来源、时间、用户、Access Key
- **Resource**: 资源类型及名称
- **Raw Event**: JSON 格式的完整事件数据

## 使用方法

1. **Trails 选项卡**: 查看跟踪配置及状态
2. **Events 选项卡**: 查询最近的 API 活动（Read + Write）
3. **Write Events 选项卡**: 仅筛选资源变更事件进行审计
4. **查看详情**: 点击行查看完整信息

:::tip Read vs Write 事件
- **Read**: DescribeInstances、GetObject 等查询操作
- **Write**: CreateInstance、DeleteBucket 等变更操作
进行安全审计时，请重点检查 Write Events 选项卡。
:::

## 使用技巧

### 检查安全最佳实践
- **Multi-Region**: 要记录所有区域的活动则必不可少
- **Log Validation**: 检测日志文件被篡改
- **KMS 加密**: 对保存到 S3 的日志文件加密

### 检测可疑活动
在 Write Events 选项卡中检查以下内容：
- 非正常时间段的 API 调用
- 未知的用户名或 Access Key
- 大量删除（Delete*）事件
- IAM 相关变更事件

### 集成 CloudWatch Logs
在跟踪详情中，如果配置了 CloudWatch Log Group，即可使用实时告警和指标筛选器。

:::info 事件保留期
CloudTrail 事件历史默认保留 90 天。如需长期保留，请创建跟踪并保存到 S3。
:::

## AI 分析技巧

在 AI 助手中利用 Monitoring Gateway 的提问示例：

- "分析今天发生的安全相关事件"
- "显示特定用户的最近活动历史"
- "在删除事件中找出可疑模式"
- "检查这个跟踪配置是否符合安全最佳实践"

## 相关页面

- [CloudWatch](../monitoring/cloudwatch) - 告警管理
- [IAM](../security/iam) - 用户及角色管理
- [Compliance](../security/compliance) - CIS 基准
