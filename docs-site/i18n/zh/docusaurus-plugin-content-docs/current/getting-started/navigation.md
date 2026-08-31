---
sidebar_position: 2
title: 界面布局与主题
description: 侧边栏导航、命令面板（Cmd-K）、主题、移动端布局
---

import Screenshot from '@site/src/components/Screenshot';

# 界面布局与主题

本页面帮助您熟悉侧边栏导航、命令面板、主题、移动端布局等 AWSops 的界面构成。

<Screenshot src="/screenshots/getting-started/command-palette.png" alt="命令面板 (Cmd-K)" />

## 主要功能

### 左侧边栏

界面左侧的固定区域，是通往所有页面的基本导航。

- **页眉**：**AWSops** 标识和**한국어/English/中文/日本語**语言选择器
- **顶部固定菜单**：**概览（Overview）**、**AI 诊断**、**助手（Assistant）**、**作业（Jobs）**、**成本（Cost）**、**Bedrock**、**拓扑（Topology）**、**安全（Security）**、**合规（Compliance）**、**集成（Integrations）**。**自定义智能体**不直接显示在侧边栏，而是通过**集成 > Agents & Skills** 标签页中的链接进入。
- **资源清单分组**：其下依次为 **Compute**（EKS、EC2、Lambda、ECS Clusters、ECS Tasks、ECR）、**Storage & DB**、**Network**、**Security**、**Monitoring** 分组
- **页脚**：已登录用户信息与**登出（Sign out）**、区域/连接状态，以及主题选择器
- 当前正在查看的页面会以高亮显示

### 命令面板（Cmd-K）

只用键盘即可快速跳转到任何位置的搜索框。

- 在任何页面按 **Cmd-K**（macOS）或 **Ctrl-K**（Windows/Linux）打开
- 输入页面名称、资源类型或路径的一部分进行筛选
- 用**上/下方向键**移动条目，按 **Enter** 执行，按 **Esc** 关闭
- 除了页面跳转，还可以通过 **Theme: Cobalt / Teal / Dark** 条目直接切换主题

### 主题

在右下角（侧边栏页脚）的 3 种主题选择器中选择界面配色。

| 主题 | 说明 |
|------|------|
| **Cobalt** | 默认值。明亮的钴蓝色系 |
| **Teal** | 明亮的青色系 |
| **Dark** | 深色暗黑模式 |

- 所选主题会保存在浏览器中，刷新后仍然保持
- 图表和 **AWSops** 标识的颜色也会随所选主题一同变化

<Screenshot src="/screenshots/getting-started/theme-dark.png" alt="Dark 主题" />

### 移动端布局

当屏幕宽度变窄时（小于 1024px），会自动切换为移动端布局。

- **顶部栏**：汉堡菜单、页面标题、搜索（命令面板）图标
- **底部标签栏**：**Overview · Cost · Inventory · Assistant · More** 共 5 个标签
- 点击 **More** 标签或汉堡菜单会打开包含完整菜单的**滑动抽屉**

<Screenshot src="/screenshots/getting-started/mobile.png" alt="移动端布局" />

## 使用方法

1. 在桌面端点击**左侧边栏**的菜单跳转到所需页面。
2. 按 **Cmd-K**（或 **Ctrl-K**）打开命令面板，输入页面名称后按 **Enter** 跳转。
3. 在侧边栏页脚的主题选择器中点击 **Cobalt / Teal / Dark** 之一。
4. 在移动端通过底部标签在主要页面间切换，通过 **More** 打开其余菜单。
5. 在任何页面都可以通过悬浮的 **AI 助手浮动按钮**打开聊天窗口。

:::tip 最快的跳转方式
页面较多时，与其浏览侧边栏，不如用 **Cmd-K** 输入名称的一部分更快。在面板中输入 `Theme:` 还可以立即切换主题。
:::

:::info 显示时间说明
应用中显示的所有时间均以 **KST（Asia/Seoul）** 为准。
:::

## 相关页面

- [仪表板](../overview/dashboard) - 全部资源摘要与起始页面
