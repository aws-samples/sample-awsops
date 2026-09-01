---
sidebar_position: 4
title: ECR
description: ECR 存储库、镜像、漏洞扫描信息
---

import Screenshot from '@site/src/components/Screenshot';

# ECR (Elastic Container Registry)

用于查看 ECR 存储库和镜像信息的页面。

:::info v2 中的呈现方式
此界面并非独立页面，而是通过 v2 的通用清单视图（`/inventory/ecr`，侧边栏「计算」分组）提供。以下内容基于 v2 清单视图的实际配置（`web/lib/inventory-types.ts` 中的 `HIGHLIGHTS.ecr`/`INVENTORY_TYPES.ecr`），而非 v1 的专用 ECR 页面。
:::

<Screenshot src="/screenshots/compute/ecr.png" alt="ECR" />

## 主要功能

### 高亮卡片
- **Scan on Push**：已启用镜像推送时自动扫描的存储库数量
- **标签不可变**：已设置标签不可变（IMMUTABLE）的存储库数量
- **标签可变**：已设置标签可变（MUTABLE）的存储库数量

不存在显示存储库总数的卡片（请通过表格行数确认）。

### 存储库表格
| 列 | 说明 |
|------|------|
| URI | 存储库 URI（镜像推送/拉取地址） |
| Tag mutability | 标签是否可更改（MUTABLE/IMMUTABLE） |
| Scan on Push (Basic) | 仓库级基础推送扫描设置（Yes/No） |
| Created | 创建日期 |

加密类型**并非表格列** —— 请在下方详情面板中查看。Scan on Push (Basic) 列仅反映仓库级基础扫描设置，不反映注册表级 Inspector 增强扫描。

### 详情面板
点击存储库可以查看详细信息：
- **Identity 部分**：Name、Account、Region、ARN、Registry ID、URI、Created
- **Config 部分**：Tag Mutability、Image Scanning Configuration（包含 Scan on Push）、Lifecycle Policy
- **Security 部分**：Encryption Configuration（AES256/KMS）
- **Tags 部分**：存储库上设置的标签

## 使用方法

1. 在侧边栏中点击 **Compute > ECR**
2. 通过顶部高亮卡片了解 Scan on Push 与标签不可变的整体状况
3. 点击存储库查看详细的 URI、Scan on Push 与 Encryption 设置

## 安全设置指南

### Scan on Push
- **建议**：在所有存储库中启用
- 镜像推送时自动执行漏洞扫描
- 发现的 CVE 可在 Security 页面查看

### Immutable Tags
- **建议**：在生产存储库中启用
- 已推送的标签无法被覆盖
- 有利于部署追踪和回滚

### Encryption
- **AES256**：默认 AWS 托管加密
- **KMS**：使用客户托管密钥（CMK）时

## 使用技巧

:::tip 启用 Scan on Push
如果高亮卡片中的 Scan on Push 数量少于存储库总数，说明部分存储库未启用扫描。可在各存储库详情面板的 Config 部分逐一确认。
:::

:::tip 复制镜像 URI
在详情面板的 URI 字段中，可以查看用于 `docker pull` 或 `docker push` 的完整地址。
:::

:::info AI 分析
在 AI Assistant 中可以通过"ECR 存储库列表"、"帮我找出未启用扫描的存储库"、"帮我分析容器镜像漏洞"等进行分析。
:::

## 相关页面

- [ECS](../compute/ecs) - 使用 ECR 镜像的 ECS 服务
- [EKS](../compute/eks) - 使用 ECR 镜像的 EKS 集群
- [Security](../security) - 查看镜像漏洞（CVE）
