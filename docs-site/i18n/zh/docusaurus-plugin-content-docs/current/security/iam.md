---
sidebar_position: 1
---

import Screenshot from '@site/src/components/Screenshot';

# IAM

IAM（Identity and Access Management）页面可一目了然地查看 AWS 账户的用户、角色和策略。这是**仅限 admin** 的页面，只有在 `data/config.json` 的 `adminEmails` 中注册的用户才能访问。

<Screenshot src="/screenshots/security/iam.png" alt="IAM" />

:::caution 仅限 Admin
进入页面时通过 `/awsops/api/steampipe?action=admin-check` 验证权限。普通用户会看到 **Access Denied** 界面。由于 IAM 用户/角色/策略属于敏感信息，这是有意的行为。
:::

## 多账户行为
在多账户环境中，可通过侧边栏的 **AccountSelector** 切换目标账户。数据表格检测到 `data[0].account_id` 时会自动添加 **Account** 列，并以 `AccountBadge` 显示别名+彩色圆点。

## 主要功能

### 摘要统计

在页面顶部可以查看 IAM 资源现状：

- **Users**：IAM 用户总数
- **Roles**：IAM 角色总数
- **Custom Policies**：客户管理型策略数
- **MFA Not Enabled**：未启用 MFA 的用户数

:::tip MFA 安全建议
如果存在未启用 MFA 的用户，顶部会显示警告横幅。建议为所有 IAM 用户启用 MFA。
:::

### MFA 状态图表

以饼图可视化 MFA 启用现状：

- **绿色**：已启用 MFA 的用户
- **红色**：未启用 MFA 的用户

## IAM 用户列表

以表格形式显示所有 IAM 用户：

| 列 | 说明 |
|------|------|
| Username | 用户名 |
| User ID | AWS 分配的唯一 ID |
| Created | 用户创建日期 |
| Password Last Used | 最后一次密码使用日期（控制台登录） |

### 用户详情

在表格中点击用户后，可在滑出面板中查看详细信息：

- 用户名、ID、ARN
- 路径（Path）
- 创建日期及最后一次密码使用日期
- 标签信息

## IAM 角色列表

以表格形式显示所有 IAM 角色：

| 列 | 说明 |
|------|------|
| Role Name | 角色名称 |
| Role ID | AWS 分配的唯一 ID |
| Path | 角色路径 |
| Description | 角色说明 |
| Created | 角色创建日期 |
| Max Session | 最大会话持续时间 |

### 角色详情

在表格中点击角色后，可以查看详细信息：

**基本信息**
- 角色名称、ID、ARN、路径
- 说明及创建日期
- 最大会话持续时间
- 权限边界（Permissions Boundary）ARN

**最后使用信息**
- 最后使用日期时间
- 最后使用区域

**实例配置文件**
- 关联的实例配置文件 ARN 列表

**信任策略**
- 以 JSON 形式显示 `AssumeRolePolicyDocument`
- 确认哪些实体（服务、账户、用户）可以代入此角色

:::info 信任策略分析
信任策略定义了可以代入（Assume）角色的主体。请在 `Principal` 字段中确认被允许的服务、账户 ID 和用户 ARN。
:::

## 数据刷新

点击右上角的刷新按钮，会以 `bustCache=true` 使 5 分钟缓存失效并查询最新数据。

## 查询结构

页面调用的 SQL 查询（`src/lib/queries/iam.ts`）：

| 查询键 | 用途 |
|---------|------|
| `summary` | Users / Roles / Custom Policies / MFA Not Enabled 计数 |
| `userList` | 用户列表 + account_id 列 |
| `roleList` | 角色列表 + account_id 列 |
| `userDetail` | 点击时的动态 SQL（名称替换） |
| `roleDetail` | 点击时的动态 SQL — 包含信任策略 + 实例配置文件 |

:::info 规避 SCP 阻断列
`iam_user` 的 `mfa_enabled` 与 `iam_role` 的 `attached_policy_arns` 为逐行水合列。对 `iam_role`，若水合查询失败（SCP 阻断 `ListAttachedRolePolicies`，或所有已连接账户的角色总数超过限流预算导致超时），同步会**去掉水合列重试一次** — 基础 iam_role 库存照常刷新，只有策略列表列缺失（水合失败本身不会使 run 记为 failed，最终 run 状态仍遵循正常生命周期 — 若同时有不可达账户则记为 partial，后续阶段出错则记为 failed），S3 详情的访问角色部分将其显示为“未同步”；运维人员可按 `inventory_sync_hydrate_fallback` 日志事件中按原因给出的建议恢复水合（超时 → 调高限流器 `fill_rate`[ADR-021]；SCP/IAM 拒绝 → 授予 `iam:ListAttachedRolePolicies` — 调整速率无法解决拒绝）。在查询路径上，当基础查询也失败时，该类型的整个同步 run 记录为 failed（并非按账户 partial），跳过清理并保留冻结所有账户的最近成功行（ADR-010 2026-09-02 修订披露的语义；在通用库存页面显示 run 状态为后续事项）。`iam_user` 的 `mfa_enabled` 无回退保留，被阻断时仍适用整类型语义。MFA 统计在单独的 `summary` 查询中汇总。
:::

## 相关页面
- [Security](./security.md) — Public S3、Open SG、未加密 EBS 等综合安全诊断
- [Compliance](./compliance) — CIS 基准（包含大量 IAM 控制项）
- [Accounts](../overview/accounts) — 添加账户 + Department（Cognito 组）管理

## 参考
- `src/lib/queries/iam.ts` — SQL 查询定义
- ADR-024：仅限 admin 页面门控（`adminEmails` 矩阵）
