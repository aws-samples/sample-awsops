---
sidebar_position: 4
title: 部署指南
description: AWSops 部署步骤及要求
---

import DeploymentPipeline from '@site/src/components/diagrams/DeploymentPipeline';

# 部署指南

介绍将 AWSops 部署到新 AWS 账户的完整流程。

<DeploymentPipeline />

## Prerequisites

| 项目 | 要求 |
|------|----------|
| **AWS 账户** | 适当的 IAM 权限（Admin 或 PowerUser） |
| **CDK CLI** | 安装在本地机器（`npm install -g aws-cdk`） |
| **Docker** | 支持 arm64 构建（`docker buildx`） |
| **Node.js** | v20 或更高 |
| **AWS CLI** | v2，已完成配置文件设置 |

## 快速安装

:::tip install-all.sh
这是一个自动依次执行 Step 1 → 2 → 3 → 10 的便捷脚本。请在部署 CDK 基础设施（Step 0）之后使用。

```bash
bash scripts/install-all.sh
```
:::

## 部署步骤

### Step 0: 部署 CDK 基础设施（本地）

```bash
cd infra-cdk && cdk deploy --all
```

CDK 部署的资源：
- **VPC**：10.10.0.0/16，2 AZ，NAT Gateway，Public + Private Subnet（可通过 CDK 上下文参数 `newVpcCidr` 更改）
- **EC2**：t4g.2xlarge（ARM64 Graviton），100GB GP3，Private Subnet
- **ALB**：Internet-facing，Custom Header 验证
- **CloudFront**：CACHING_DISABLED，ALB Origin
- **Cognito**：User Pool + Lambda@Edge（us-east-1）

### Step 1: 安装 Steampipe（EC2）

```bash
bash scripts/01-install-base.sh
```

安装 Steampipe + AWS/K8s/Trivy 插件。可在 PostgreSQL port 9193 上使用 380+ 个 AWS 表。

### Step 2: 配置 Next.js（EC2）

```bash
bash scripts/02-setup-nextjs.sh
```

安装 Next.js 14 应用，注册 Steampipe 服务，自动检测 MSP 环境。

### Step 3: 生产构建（EC2）

```bash
bash scripts/03-build-deploy.sh
```

通过 `npm run build` + `npm start` 运行生产服务器。

### Step 4: 配置 EKS 访问（EC2）

```bash
bash scripts/04-setup-eks-access.sh
```

执行访问 EKS 集群所需的配置：
- 安装 **kubectl**（ARM64 二进制文件）
- 自动发现区域内的 EKS 集群
- 配置 **kubeconfig**（`aws eks update-kubeconfig`）
- 注册 EKS 访问条目（access entry）
- 配置 Steampipe **Kubernetes** 插件 + **Trivy** 插件连接

:::info 没有 EKS 的环境
在没有 EKS 集群的账户中可以跳过此步骤。只有 Kubernetes 相关页面会被禁用。
:::

### Step 5: Cognito 认证（EC2）

```bash
bash scripts/05-setup-cognito.sh
```

创建 Cognito User Pool 用户并配置应用客户端。

### Step 6a-6f: AgentCore（EC2）

可以通过**包装脚本**依次执行 6a → 6e：

```bash
bash scripts/06-setup-agentcore.sh
```

| 脚本 | 说明 |
|----------|------|
| `06a-setup-agentcore-runtime.sh` | IAM 角色、ECR、Docker arm64 构建、Runtime Endpoint |
| `06b-setup-agentcore-gateway.sh` | 创建 8 个 Gateway（MCP） |
| `06c-setup-agentcore-tools.sh` | 向 19 Lambda + 8 Gateway 注册 125 个工具 |
| `06d-setup-agentcore-interpreter.sh` | 创建 Code Interpreter |
| `06e-setup-agentcore-config.sh` | 自动配置 `route.ts` / `agent.py`（ARN、Gateway URL 等） |
| `06f-setup-agentcore-memory.sh` | 创建 Memory Store（保留 365 天）— **需要手动执行** |
| `07-setup-opencost.sh` | Prometheus + OpenCost（EKS 成本分析） |

### Step 8: 集成 CloudFront 认证（EC2）

```bash
bash scripts/08-setup-cloudfront-auth.sh
```

将 Lambda@Edge 连接到 CloudFront viewer-request。

### Step 9: 启动服务（EC2）

```bash
bash scripts/09-start-all.sh
```

依次启动以下服务：
- **Steampipe** 服务（PostgreSQL port 9193）
- **Next.js** 生产服务器（port 3000）
- **OpenCost**（EKS 成本分析，如已配置 EKS）

### Step 10: 停止服务（EC2）

```bash
bash scripts/10-stop-all.sh
```

安全地停止所有正在运行的 AWSops 服务。用于维护或更新时。

### Step 11: 验证与健康检查（EC2）

```bash
bash scripts/11-verify.sh
```

执行 5 个阶段的自动验证：
1. **服务状态** — 检查 Steampipe、Next.js 进程
2. **Steampipe 表** — 检查 18 个核心表是否存在
3. **页面访问** — 验证 20+ 个页面的 HTTP 响应代码
4. **API 响应** — 检查主要 API 端点是否正常工作
5. **配置文件** — 验证 `data/config.json` 的有效性

:::tip 部署后必做
在 Step 3 之后或更新之后，请运行 `11-verify.sh` 确认所有组件正常。它也包含在 `install-all.sh` 中。
:::

### Step 12: 多账户配置（EC2，可选）

```bash
bash scripts/12-setup-multi-account.sh
```

用于在一个 AWSops 实例中管理多个 AWS 账户的配置：
- 配置 Steampipe **Aggregator** 连接（`aws` = 整合所有账户）
- 创建跨账户 **IAM 角色**并配置信任关系
- 更新 `data/config.json` 中的 `accounts[]` 数组

:::info 可选步骤
在单账户环境中不需要此步骤。仅在需要多账户时执行。
:::

## 配置文件

部署完成后会自动生成 `data/config.json`。部署到新账户时只需更新此文件。

```json
{
  "costEnabled": true,
  "agentRuntimeArn": "arn:aws:bedrock-agentcore:REGION:ACCOUNT:runtime/RUNTIME_ID",
  "codeInterpreterName": "awsops_code_interpreter_XXXXX",
  "memoryId": "awsops_memory_XXXXX",
  "memoryName": "awsops_memory",
  "adminEmails": ["admin@example.com"],
  "accounts": [
    {
      "accountId": "111111111111",
      "alias": "Host",
      "connectionName": "aws_111111111111",
      "region": "ap-northeast-2",
      "isHost": true,
      "features": { "costEnabled": true, "eksEnabled": true, "k8sEnabled": true }
    },
    {
      "accountId": "222222222222",
      "alias": "Staging",
      "connectionName": "aws_222222222222",
      "region": "ap-northeast-2",
      "isHost": false,
      "features": { "costEnabled": false, "eksEnabled": false, "k8sEnabled": false }
    }
  ],
  "customerLogo": "default.png"
}
```

:::tip 无需修改代码
按账户部署时只需更改 `data/config.json`。不需要修改源代码。
:::

## 已知问题

:::warning 部署注意事项

**1. Memory Store 需要手动执行**
`06f-setup-agentcore-memory.sh` 不包含在包装脚本（`06-setup-agentcore.sh`）中，请务必手动执行：
```bash
bash scripts/06f-setup-agentcore-memory.sh
```

**2. systemd 服务配置**
默认生成的 systemd 服务文件中可能残留对 `proxy.js` 的引用。正确的启动命令是 `npm run start`；在 nvm 环境中必须使用 Node.js 的完整路径（`/home/ec2-user/.nvm/versions/node/v20.x.x/bin/node`）。

**3. 必须使用 Docker arm64**
AgentCore Runtime Docker 镜像必须以 arm64 构建：
```bash
docker buildx build --platform linux/arm64 --load -t awsops-agent .
```
:::

## 相关页面

- [认证流程](./auth) - Cognito 认证详解
- [AgentCore](../overview/agentcore) - AgentCore 架构详解
- [仪表板](../overview/dashboard) - 系统架构概览
