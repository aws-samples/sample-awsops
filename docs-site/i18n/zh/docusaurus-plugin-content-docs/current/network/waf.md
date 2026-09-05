---
sidebar_position: 3
title: WAF
description: 监控 AWS WAF Web ACL、规则组和 IP Sets
---

import Screenshot from '@site/src/components/Screenshot';

# WAF

用于监控 AWS Web Application Firewall 并查看规则的页面。

<Screenshot src="/screenshots/network/waf.png" alt="WAF" />

## 主要功能

### 汇总统计

在顶部卡片中查看 WAF 资源状况：

| 指标 | 说明 | 颜色 |
|------|------|------|
| **Web ACLs** | Web ACL 总数 | cyan |
| **Rule Groups** | 规则组总数 | purple |
| **IP Sets** | IP 集合总数 | orange |

在 v2 中，这三项计数显示为 **Security 组概览（`/inventory/g/security`）的按类型磁贴**，Rule Groups（`/inventory/waf_rule_group`）和 IP Sets（`/inventory/waf_ip_set`）各有专用库存页面（scope 环形图、WCU 柱状图、IPv4/IPv6 分布、地址数）— terraform apply + 下次同步后显示数据。

### Web ACL 列表

在表格中查看所有 Web ACL：

- **Name**：Web ACL 名称
- **ID**：唯一标识符
- **Scope**：REGIONAL 或 CLOUDFRONT
- **Capacity**：WCU（Web ACL Capacity Units）使用量
- **Description**：描述
- **Region**：区域（CLOUDFRONT 为 Global）

### 详情面板

点击 Web ACL 行可查看详细信息：

**Web ACL 部分**
- Name、ID、ARN
- Scope、Capacity
- Description
- Default Action（Allow/Block）

**Rules 部分**
- 规则名称及 Priority
- Action（Allow、Block、Count）
- Managed Rule Group 引用

## 使用方法

### 查看 Web ACL 状况

1. 访问 WAF 页面
2. 通过顶部汇总卡片了解资源总数
3. 在表格中查看 Web ACL 列表
4. 通过 Scope 区分 Regional/CloudFront

### 分析 Web ACL 规则

1. 在表格中点击 Web ACL 行
2. 在详情面板中查看 Rules 部分
3. 查看每条规则的：
   - **Name**：规则名称
   - **Priority**：评估顺序（数值越小越先评估）
   - **Action**：匹配时的动作

### 理解 Scope

| Scope | 关联对象 | 区域 |
|-------|----------|------|
| **REGIONAL** | ALB、API Gateway、AppSync | 特定区域 |
| **CLOUDFRONT** | CloudFront Distribution | us-east-1 (Global) |

## 使用技巧

:::tip 善用 AWS Managed Rules
AWS 提供多种 Managed Rule Group：
- **AWSManagedRulesCommonRuleSet**：应对 OWASP Top 10
- **AWSManagedRulesSQLiRuleSet**：拦截 SQL Injection
- **AWSManagedRulesKnownBadInputsRuleSet**：拦截已知恶意输入

Managed Rules 由 AWS 持续更新，可减轻手动管理负担。
:::

:::info WCU（Web ACL Capacity Units）
每条规则都会消耗 WCU。Web ACL 的默认上限为 1,500 WCU。若 Capacity 值过高，可减少规则数量，或向 AWS Support 申请提升上限。
:::

:::tip 设置 Default Action
- **Allow（默认）**：未匹配任何规则时允许（显式拦截方式）
- **Block（默认）**：未匹配任何规则时拦截（显式允许方式）

大多数情况下推荐 **Allow** 默认设置 + 添加拦截规则的方式。
:::

## 相关页面

- [CloudFront](../network/cloudfront) - 关联了 WAF 的 CDN 分配
- [VPC](../network/vpc) - 查看 ALB 所在的 VPC
- [Compliance](../security/compliance) - WAF 相关合规检查
