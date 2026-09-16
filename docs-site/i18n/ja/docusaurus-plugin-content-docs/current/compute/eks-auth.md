---
sidebar_position: 5
title: EKS 認証設定
description: AWSops EC2 インスタンスから EKS クラスターにアクセスするための認証設定ガイド
---

# EKS 認証設定


:::caution v1 アーカイブ文書 — v2 には適用されません
このページは v1（EC2 インスタンス + Steampipe）の認証手順を保管したものです。v2 は ECS Fargate ベースで、ホストアカウントの Terraform オンボーディングには `terraform/foundation/eks.tf` を使います。メンバーアカウント登録と現在の web タスクロールの Access Entry・認証方式は、[EKS Overview のクロスアカウント接続ガイド](./eks)を参照してください。このアーカイブの SSH、`AmazonEKSClusterAdminPolicy`、`data/config.json` のコマンドを v2 に適用しないでください。
:::

AWSops の Kubernetes ダッシュボード（`/k8s/*`）は、Steampipe の `kubernetes` プラグインを通じて EKS クラスターのデータを照会します。そのためには、**AWSops EC2 インスタンスロールが EKS クラスターに認証**されている必要があります。

## 認証の構造

```
EC2 インスタンスロール (IAM Role)
  → kubeconfig (aws eks update-kubeconfig)
    → EKS API Server
      → Access Entry または aws-auth ConfigMap で検証
        → Kubernetes API アクセスを許可
          → Steampipe kubernetes プラグイン → ダッシュボード表示
```

## 事前確認

### 1. EC2 インスタンスロール ARN の確認

AWSops EC2 に SSH 接続後、実行します:

```bash
# EC2 インスタンスロール ARN の確認
aws sts get-caller-identity --query "Arn" --output text

# 出力例: arn:aws:sts::123456789012:assumed-role/AwsopsEc2Role/i-0abc123
# → IAM Role ARN: arn:aws:iam::123456789012:role/AwsopsEc2Role
```

:::tip ARN の変換
`sts:assumed-role` 形式を `iam:role` 形式に変換する必要があります:
- `arn:aws:sts::ACCOUNT:assumed-role/ROLE_NAME/i-xxx`
- → `arn:aws:iam::ACCOUNT:role/ROLE_NAME`
:::

### 2. EKS クラスター認証モードの確認

```bash
aws eks describe-cluster --name CLUSTER_NAME \
  --query 'cluster.accessConfig.authenticationMode' \
  --output text
```

| 認証モード | 説明 | 推奨方法 |
|-----------|------|----------|
| `API` | Access Entry API のみ使用 | **方法 1** |
| `API_AND_CONFIG_MAP` | Access Entry + aws-auth の両方を使用 | **方法 1**（推奨） |
| `CONFIG_MAP` | aws-auth ConfigMap のみ使用 | **方法 2** |

## 方法 1: Access Entry API

:::info 権限の要件
以下のコマンドは、**EKS クラスターに対する `eks:CreateAccessEntry` および `eks:AssociateAccessPolicy` 権限**が必要です。クラスターを作成したアカウント、または管理者権限を持つ IAM プリンシパルで実行してください。
:::

### Step 1: Access Entry の作成

```bash
aws eks create-access-entry \
  --cluster-name CLUSTER_NAME \
  --principal-arn arn:aws:iam::ACCOUNT_ID:role/ROLE_NAME \
  --type STANDARD
```

### Step 2: ClusterAdmin ポリシーの関連付け

```bash
aws eks associate-access-policy \
  --cluster-name CLUSTER_NAME \
  --principal-arn arn:aws:iam::ACCOUNT_ID:role/ROLE_NAME \
  --policy-arn arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy \
  --access-scope type=cluster
```

:::tip 最小権限の原則
読み取り専用アクセスのみが必要な場合は、`AmazonEKSClusterAdminPolicy` の代わりに `AmazonEKSViewPolicy` を使用できます。ただし、Steampipe の一部の CRD テーブル照会が制限される場合があります。
:::

### Step 3: kubeconfig の作成

AWSops EC2 で実行します:

```bash
aws eks update-kubeconfig \
  --name CLUSTER_NAME \
  --region ap-northeast-2
```

### Step 4: Steampipe K8s プラグインの設定

```bash
cat > ~/.steampipe/config/kubernetes.spc << 'EOF'
connection "kubernetes" {
  plugin = "kubernetes"
  custom_resource_tables = ["*"]
}
EOF

# Steampipe サービスの再起動
sudo systemctl restart steampipe
```

### Step 5: 接続テスト

```bash
# kubectl テスト
kubectl get nodes

# Steampipe テスト
steampipe query "SELECT name, phase FROM kubernetes_namespace LIMIT 5"
```

## 方法 2: aws-auth ConfigMap

`CONFIG_MAP` モードのクラスターでは、`kube-system` ネームスペースの `aws-auth` ConfigMap に IAM ロールを直接追加する必要があります。

:::info 権限の要件
`kubectl edit` コマンドは、**すでにクラスターに認証済みの管理者**が実行する必要があります。クラスターを作成した IAM プリンシパル、または既存の `system:masters` グループのメンバーで実行してください。
:::

### Step 1: aws-auth ConfigMap の編集

```bash
kubectl edit configmap aws-auth -n kube-system
```

### Step 2: mapRoles に EC2 ロールを追加

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: aws-auth
  namespace: kube-system
data:
  mapRoles: |
    # 既存のロールを維持
    - rolearn: arn:aws:iam::ACCOUNT_ID:role/EXISTING_ROLE
      username: existing-user
      groups:
        - system:masters
    # AWSops EC2 ロールを追加
    - rolearn: arn:aws:iam::ACCOUNT_ID:role/ROLE_NAME
      username: awsops-ec2
      groups:
        - system:masters
```

:::caution aws-auth 編集時の注意
`aws-auth` ConfigMap を誤って変更すると、クラスターへのアクセスが遮断される可能性があります。編集前に必ずバックアップしてください:
```bash
kubectl get configmap aws-auth -n kube-system -o yaml > aws-auth-backup.yaml
```
:::

### Step 3: kubeconfig + Steampipe の設定

方法 1 の Step 3〜5 と同じです。

## マルチクラスター設定

複数の EKS クラスターをモニタリングするには、各クラスターに対して認証設定を繰り返します:

```bash
# 各クラスターの kubeconfig を追加
aws eks update-kubeconfig --name cluster-1 --region ap-northeast-2
aws eks update-kubeconfig --name cluster-2 --region ap-northeast-2

# kubeconfig に複数のコンテキストが登録される
kubectl config get-contexts
```

Steampipe は `current-context` のクラスターを照会します。デフォルトのコンテキストを変更するには:

```bash
kubectl config use-context arn:aws:eks:ap-northeast-2:ACCOUNT:cluster/CLUSTER_NAME
sudo systemctl restart steampipe
```

## クロスアカウント EKS アクセス

別の AWS アカウントの EKS クラスターにアクセスするには:

1. **対象アカウント**で AWSops EC2 ロールに対する Access Entry を作成（上記の方法 1 参照）
2. **対象アカウント**の IAM ロールを通じた `AssumeRole` の設定が必要になる場合があります
3. kubeconfig に `--role-arn` オプションを追加:

```bash
aws eks update-kubeconfig \
  --name CLUSTER_NAME \
  --region ap-northeast-2 \
  --role-arn arn:aws:iam::TARGET_ACCOUNT:role/EKSAccessRole
```

## 自動設定スクリプト

AWSops には、上記の手順を自動化するスクリプトが含まれています:

```bash
bash scripts/04-setup-eks-access.sh
```

このスクリプトは以下を自動的に実行します:
1. kubectl のインストール
2. EKS クラスターの探索（現在のリージョン + 追加 6 リージョン）
3. kubeconfig の作成
4. 認証モードを検出し、Access Entry の登録または aws-auth の案内
5. Steampipe kubernetes プラグインの設定
6. 接続テスト

## トラブルシューティング

### "error: You must be logged in to the server"

kubeconfig が存在しないか、期限切れです:
```bash
aws eks update-kubeconfig --name CLUSTER_NAME --region REGION
```

### "AccessDeniedException: User is not authorized"

EC2 ロールに EKS API 呼び出しの権限がありません。IAM ポリシーに次を追加してください:
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

AWS CLI v1 を使用している可能性があります。v2 にアップグレードしてください:
```bash
aws --version  # aws-cli/2.x を確認
```

### Steampipe で K8s テーブルが表示されない

Steampipe K8s プラグインの設定を確認してください:
```bash
cat ~/.steampipe/config/kubernetes.spc
# plugin = "kubernetes" を確認
sudo systemctl restart steampipe
```

## 関連ページ

- [EKS Overview](./eks) — EKS クラスターダッシュボード
- [EKS Explorer](./eks-explorer) — K9s スタイルのターミナル UI
- [デプロイガイド](../getting-started/deployment) — 全体のデプロイ手順
