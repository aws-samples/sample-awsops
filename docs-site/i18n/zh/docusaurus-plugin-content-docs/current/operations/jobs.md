---
sidebar_position: 3
title: 异步任务
description: 查看由后台 Worker 处理的异步任务执行记录
---

import Screenshot from '@site/src/components/Screenshot';

# 异步任务

此页面可查看报告生成等繁重、耗时的任务由后台 Worker 处理的执行记录。

<Screenshot src="/screenshots/operations/jobs.png" alt="异步任务列表" />

## 主要功能
### 任务列表表格
显示最近的任务，最多 50 条。繁重的任务不会在界面上立即执行，而是移交给后台 Worker，此页面以**只读**方式展示其处理结果。

| 列 | 说明 |
|------|------|
| **Type** | 任务类型 |
| **Status** | 处理状态。以彩色徽章显示 |
| **Runtime** | 任务执行的位置 |
| **Error** | 失败时的错误消息 |
| **Created** | 任务创建的时刻（KST） |

### Status 徽章
- **queued**：已注册到队列，等待处理的状态
- **running**：Worker 正在处理的状态
- **succeeded**：成功完成的状态
- **failed**：处理过程中失败的状态（可在 Error 列查看原因）
- **canceled**：已取消的状态

### Runtime
- **lambda**：处理短时任务的执行环境
- **fargate**：处理耗时较长或占用大量内存的任务的执行环境

## 使用方法
1. 在侧边栏点击**任务**
2. 在表格中查看最近任务的 **Status** 和 **Runtime** 徽章
3. 点击列标题按所需标准排序
4. 点击 **Refresh** 按钮重新加载最新记录。会一并显示上次刷新的时刻

## 使用技巧
:::tip 确认失败原因
**Status** 为 **failed** 的任务，可在 **Error** 列查看错误消息。
:::

:::info 只读界面
此页面仅查询任务执行记录。任务由其他功能（例如报告生成）在后台注册，处理结果会显示在这里。
:::

:::info 窄屏
当屏幕变窄时，表格会切换为卡片形式，在移动端也便于查看。
:::

## 相关页面
- [AI 诊断](./ai-diagnosis) - 在后台生成的诊断报告
