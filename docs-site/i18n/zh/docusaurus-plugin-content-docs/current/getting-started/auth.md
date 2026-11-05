---
sidebar_position: 5
title: 认证流程
description: Cognito 认证架构及流程详解
---

import AuthFlow from '@site/src/components/diagrams/AuthFlow';

# 认证流程

AWSops 通过 Amazon Cognito + Lambda@Edge + CloudFront 组合处理认证。

<AuthFlow />

## Cognito 配置

| 项目 | 设置 |
|------|------|
| **User Pool** | `awsops-user-pool`（禁用自助注册） |
| **登录方式** | 电子邮件或用户名 |
| **密码策略** | 8 个字符以上，必须包含大小写字母和数字 |
| **OAuth** | Authorization Code Grant，OpenID/Email/Profile |
| **令牌有效期** | 1 小时 |
| **登录 UI** | 自定义登录页面（`/awsops/login`）— 不使用 Cognito Hosted UI |
| **认证流程** | `USER_PASSWORD_AUTH`（InitiateAuth）via `/api/auth` |

## 认证流程详解

### 首次访问（无 Cookie）

1. 浏览器访问 `/awsops`
2. CloudFront 通过 viewer-request 事件调用 Lambda@Edge
3. Lambda@Edge 检查 `awsops_token` Cookie → 不存在/已过期
4. **302 重定向到自定义登录页面 `/awsops/login`**（不是 Cognito Hosted UI）
5. 用户输入电子邮件/密码 → `POST /awsops/api/auth`（`action: login`）
6. 服务器调用 Cognito **InitiateAuth（`USER_PASSWORD_AUTH`）** → 获取 IdToken
7. 设置 `awsops_token` HttpOnly·Secure·SameSite=Lax Cookie（1 小时）
8. 之后经过认证的请求经由 CloudFront → ALB → EC2 转发

### 再次访问（有效 Cookie）

1. 浏览器携带 `awsops_token` Cookie 访问
2. Lambda@Edge 验证 JWT → 有效
3. 请求直接经由 CloudFront → ALB → EC2 转发

## Lambda@Edge

| 项目 | 设置 |
|------|------|
| **区域** | us-east-1（Lambda@Edge 必需） |
| **运行时** | Python 3.12（部署处理程序；CDK 存根为 Node.js 20） |
| **触发器** | CloudFront viewer-request |
| **功能** | 验证 `awsops_token` JWT Cookie，未认证时重定向到 `/awsops/login` |

:::warning 登出
HttpOnly Cookie 无法通过 JavaScript（`document.cookie`）删除。AWSops 通过 `POST /api/auth` 在服务器端删除 Cookie。
:::

## 相关页面

- [登录](./login) - 登录方法
- [部署指南](./deployment) - Cognito 部署步骤
- [仪表板](../overview/dashboard) - 系统架构概览
