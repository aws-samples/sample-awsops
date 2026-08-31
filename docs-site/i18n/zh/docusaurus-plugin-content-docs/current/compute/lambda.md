---
sidebar_position: 2
title: Lambda 函数
description: Lambda 函数列表、运行时分布、内存/超时设置查看
---

import Screenshot from '@site/src/components/Screenshot';

# Lambda 函数

用于查看 AWS Lambda 函数列表和配置信息的页面。

<Screenshot src="/screenshots/compute/lambda.png" alt="Lambda 函数" />

## 主要功能

### 统计卡片
- **Total Functions**：全部 Lambda 函数数量（青色）
- **Runtimes**：正在使用的运行时种类数（紫色）
- **Avg Memory (MB)**：平均内存分配量（绿色）
- **Long Timeout (>5m)**：超时设置超过 5 分钟的函数数量（橙色）

### 可视化图表
- **Runtime Distribution**：各运行时的函数分布饼图（Python、Node.js、Java 等）
- **Memory Allocation**：各内存设置的函数分布柱状图

### 函数列表表格
| 列 | 说明 |
|------|------|
| Function Name | 函数名称 |
| Runtime | 运行时（包含 deprecated 标记） |
| Memory (MB) | 分配的内存 |
| Timeout (s) | 超时设置 |
| Code Size | 代码大小 |
| Last Modified | 最后修改日期 |
| Region | 区域 |

### Deprecated 运行时标记
以下运行时会以橙色显示 "deprecated" 标签：
- Python 2.7、3.6、3.7
- Node.js 10.x、12.x、14.x
- .NET Core 2.1、3.1
- Ruby 2.5、2.7
- Java 8、Go 1.x

### 详情面板
点击函数可以查看详细信息：
- **Function 部分**：Name、ARN、Runtime、Handler、Architectures、Package Type、Code Size
- **Deployment 部分**：Version、State、Last Update、Layers 信息
- **Configuration 部分**：Memory、Timeout 设置
- **Network 部分**：VPC 连接信息（VPC ID、Subnets、Security Groups）

## 使用方法

1. 在侧边栏中点击 **Compute > Lambda**
2. 在 Runtime Distribution 图表中查看运行时分布
3. 在 Memory Allocation 图表中了解内存设置模式
4. 识别使用 deprecated 运行时的函数并制定升级计划
5. 点击函数查看详细配置

## 使用技巧

:::tip 管理 Deprecated 运行时
Runtime 列中显示橙色 "deprecated" 标签的函数，其 AWS 支持已终止或即将终止。建议尽快升级。
:::

:::tip 检查 Long Timeout 函数
超时设置超过 5 分钟的函数，需要从成本优化和错误处理的角度进行审查。
:::

:::info AI 分析
在 AI Assistant 中可以通过"Lambda 函数列表"、"使用 Python 运行时的函数"、"帮我找出使用 deprecated 运行时的函数"等进行分析。
:::

## 相关页面

- [CloudWatch](../monitoring/cloudwatch) - Lambda 执行日志及告警
- [IAM](../security/iam) - 查看 Lambda 执行角色
- [VPC](../network/vpc) - 连接 VPC 的 Lambda 网络配置
