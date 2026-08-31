---
sidebar_position: 5
title: EKS 认证配置
description: 在 AWSops EC2 实例上访问 EKS 集群的认证配置指南
---

# EKS 认证配置

:::caution v1 归档文档 — 不适用于 v2
本页描述的是 v1（EC2 实例 + Steampipe）架构的认证步骤。v2 基于 ECS Fargate，EKS 认证改为由 `terraform/foundation/eks.tf` 为 **web 任务角色授予 Access Entry + `AmazonEKSAdminViewPolicy`**。请不要将本页的命令（SSH、`AmazonEKSClusterAdminPolicy`、`data/config.json` 等）应用于 v2 环境。
:::

AWSops 的 Kubernetes 仪表板（`/k8s/*`）通过 Steampipe 的 `kubernetes` 插件查询 EKS 集群数据。为此，**AWSops EC2 实例角色必须通过 EKS 集群的认证**。

## 认证结构

```
EC2 实例角色 (IAM Role)
  → kubeconfig (aws eks update-kubeconfig)
    → EKS API Server
      → Access Entry 或 aws-auth ConfigMap 验证
        → 允许访问 Kubernetes API
          → Steampipe kubernetes 插件 → 仪表板显示
```

## 事前确认

### 1. 确认 EC2 实例角色 ARN

通过 SSH 连接到 AWSops EC2 后执行：

```bash
# 确认 EC2 实例角色 ARN
aws sts get-caller-identity --query "Arn" --output text

# 输出示例: arn:aws:sts::123456789012:assumed-role/AwsopsEc2Role/i-0abc123
# → IAM Role ARN: arn:aws:iam::123456789012:role/AwsopsEc2Role
```

:::tip ARN 转换
需要将 `sts:assumed-role` 格式转换为 `iam:role` 格式：
- `arn:aws:sts::ACCOUNT:assumed-role/ROLE_NAME/i-xxx`
- → `arn:aws:iam::ACCOUNT:role/ROLE_NAME`
:::

### 2. 确认 EKS 集群认证模式

```bash
aws eks describe-cluster --name CLUSTER_NAME \
  --query 'cluster.accessConfig.authenticationMode' \
  --output text
```

| 认证模式 | 说明 | 推荐方法 |
|-----------|------|----------|
| `API` | 仅使用 Access Entry API | **方法 1** |
| `API_AND_CONFIG_MAP` | 同时使用 Access Entry + aws-auth | **方法 1**（推荐） |
| `CONFIG_MAP` | 仅使用 aws-auth ConfigMap | **方法 2** |

## 方法 1：Access Entry API

:::info 权限要求
以下命令需要**针对 EKS 集群的 `eks:CreateAccessEntry` 和 `eks:AssociateAccessPolicy` 权限**。请使用创建该集群的账号或具有管理员权限的 IAM 主体执行。
:::

### Step 1：创建 Access Entry

```bash
aws eks create-access-entry \
  --cluster-name CLUSTER_NAME \
  --principal-arn arn:aws:iam::ACCOUNT_ID:role/ROLE_NAME \
  --type STANDARD
```

### Step 2：关联 ClusterAdmin 策略

```bash
aws eks associate-access-policy \
  --cluster-name CLUSTER_NAME \
  --principal-arn arn:aws:iam::ACCOUNT_ID:role/ROLE_NAME \
  --policy-arn arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy \
  --access-scope type=cluster
```

:::tip 最小权限原则
如果只需要只读访问，可以使用 `AmazonEKSViewPolicy` 代替 `AmazonEKSClusterAdminPolicy`。但 Steampipe 的部分 CRD 表查询可能会受到限制。
:::

### Step 3：生成 kubeconfig

在 AWSops EC2 上执行：

```bash
aws eks update-kubeconfig \
  --name CLUSTER_NAME \
  --region ap-northeast-2
```

### Step 4：配置 Steampipe K8s 插件

```bash
cat > ~/.steampipe/config/kubernetes.spc << 'EOF'
connection "kubernetes" {
  plugin = "kubernetes"
  custom_resource_tables = ["*"]
}
EOF

# 重启 Steampipe 服务
sudo systemctl restart steampipe
```

### Step 5：连接测试

```bash
# kubectl 测试
kubectl get nodes

# Steampipe 测试
steampipe query "SELECT name, phase FROM kubernetes_namespace LIMIT 5"
```

## 方法 2：aws-auth ConfigMap

在 `CONFIG_MAP` 模式的集群中，需要将 IAM 角色直接添加到 `kube-system` 命名空间的 `aws-auth` ConfigMap 中。

:::info 权限要求
`kubectl edit` 命令必须由**已经通过集群认证的管理员**执行。请使用创建集群的 IAM 主体或现有 `system:masters` 组的成员执行。
:::

### Step 1：编辑 aws-auth ConfigMap

```bash
kubectl edit configmap aws-auth -n kube-system
```

### Step 2：在 mapRoles 中添加 EC2 角色

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: aws-auth
  namespace: kube-system
data:
  mapRoles: |
    # 保留现有角色
    - rolearn: arn:aws:iam::ACCOUNT_ID:role/EXISTING_ROLE
      username: existing-user
      groups:
        - system:masters
    # 添加 AWSops EC2 角色
    - rolearn: arn:aws:iam::ACCOUNT_ID:role/ROLE_NAME
      username: awsops-ec2
      groups:
        - system:masters
```

:::caution aws-auth 编辑注意事项
错误修改 `aws-auth` ConfigMap 可能导致集群访问被阻断。编辑前请务必备份：
```bash
kubectl get configmap aws-auth -n kube-system -o yaml > aws-auth-backup.yaml
```
:::

### Step 3：kubeconfig + Steampipe 配置

与方法 1 的 Step 3~5 相同。

## 多集群配置

如需监控多个 EKS 集群，请对每个集群重复认证配置：

```bash
# 为每个集群添加 kubeconfig
aws eks update-kubeconfig --name cluster-1 --region ap-northeast-2
aws eks update-kubeconfig --name cluster-2 --region ap-northeast-2

# kubeconfig 中会注册多个上下文
kubectl config get-contexts
```

Steampipe 查询的是 `current-context` 对应的集群。如需更改默认上下文：

```bash
kubectl config use-context arn:aws:eks:ap-northeast-2:ACCOUNT:cluster/CLUSTER_NAME
sudo systemctl restart steampipe
```

## 跨账号 EKS 访问

如需访问其他 AWS 账号的 EKS 集群：

1. 在**目标账号**中为 AWSops EC2 角色创建 Access Entry（参见上文方法 1）
2. 可能需要通过**目标账号**的 IAM 角色配置 `AssumeRole`
3. 在 kubeconfig 中添加 `--role-arn` 选项：

```bash
aws eks update-kubeconfig \
  --name CLUSTER_NAME \
  --region ap-northeast-2 \
  --role-arn arn:aws:iam::TARGET_ACCOUNT:role/EKSAccessRole
```

## 自动配置脚本

AWSops 包含自动化上述过程的脚本：

```bash
bash scripts/04-setup-eks-access.sh
```

该脚本会自动执行以下操作：
1. 安装 kubectl
2. 探测 EKS 集群（当前区域 + 6 个额外区域）
3. 生成 kubeconfig
4. 检测认证模式后注册 Access Entry 或提示 aws-auth 配置
5. 配置 Steampipe kubernetes 插件
6. 连接测试

## 故障排查

### "error: You must be logged in to the server"

kubeconfig 缺失或已过期：
```bash
aws eks update-kubeconfig --name CLUSTER_NAME --region REGION
```

### "AccessDeniedException: User is not authorized"

EC2 角色没有调用 EKS API 的权限。请在 IAM 策略中添加以下内容：
```json
{
  "Effect": "Allow",
  "Action": [
    "eks:DescribeCluster",
    "eks:ListClusters"
  ],
  "Resource": "*"
}
```

### "error: exec plugin: invalid apiVersion"

可能正在使用 AWS CLI v1。请升级到 v2：
```bash
aws --version  # 确认为 aws-cli/2.x
```

### Steampipe 中看不到 K8s 表

请检查 Steampipe K8s 插件配置：
```bash
cat ~/.steampipe/config/kubernetes.spc
# 确认 plugin = "kubernetes"
sudo systemctl restart steampipe
```

## 相关页面

- [EKS Overview](./eks) — EKS 集群仪表板
- [EKS Explorer](./eks-explorer) — K9s 风格终端 UI
- [部署指南](../getting-started/deployment) — 完整部署流程
