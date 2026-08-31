---
sidebar_position: 4
title: デプロイガイド
description: AWSops のデプロイ手順と要件
---

import DeploymentPipeline from '@site/src/components/diagrams/DeploymentPipeline';

# デプロイガイド

AWSops を新しい AWS アカウントにデプロイするための全プロセスを説明します。

<DeploymentPipeline />

## Prerequisites

| 項目 | 要件 |
|------|----------|
| **AWS アカウント** | 適切な IAM 権限 (Admin または PowerUser) |
| **CDK CLI** | ローカルマシンにインストール (`npm install -g aws-cdk`) |
| **Docker** | arm64 ビルド対応 (`docker buildx`) |
| **Node.js** | v20 以上 |
| **AWS CLI** | v2、プロファイル設定済み |

## クイックインストール

:::tip install-all.sh
Step 1 → 2 → 3 → 10 を自動で順次実行する便利スクリプトです。CDK インフラ (Step 0) のデプロイ後に使用してください。

```bash
bash scripts/install-all.sh
```
:::

## デプロイ手順

### Step 0: CDK インフラのデプロイ (ローカル)

```bash
cd infra-cdk && cdk deploy --all
```

CDK がデプロイするリソース:
- **VPC**: 10.10.0.0/16、2 AZ、NAT Gateway、Public + Private Subnet (CDK コンテキストパラメータ `newVpcCidr` で変更可能)
- **EC2**: t4g.2xlarge (ARM64 Graviton)、100GB GP3、Private Subnet
- **ALB**: Internet-facing、Custom Header 検証
- **CloudFront**: CACHING_DISABLED、ALB Origin
- **Cognito**: User Pool + Lambda@Edge (us-east-1)

### Step 1: Steampipe のインストール (EC2)

```bash
bash scripts/01-install-base.sh
```

Steampipe + AWS/K8s/Trivy プラグインをインストール。PostgreSQL port 9193 で 380+ の AWS テーブルが使用可能になります。

### Step 2: Next.js の設定 (EC2)

```bash
bash scripts/02-setup-nextjs.sh
```

Next.js 14 アプリのインストール、Steampipe サービスの登録、MSP 環境の自動検出を行います。

### Step 3: プロダクションビルド (EC2)

```bash
bash scripts/03-build-deploy.sh
```

`npm run build` + `npm start` でプロダクションサーバーを起動します。

### Step 4: EKS アクセス設定 (EC2)

```bash
bash scripts/04-setup-eks-access.sh
```

EKS クラスターへのアクセスに必要な設定を行います:
- **kubectl** のインストール (ARM64 バイナリ)
- リージョン内の EKS クラスターの自動検出
- **kubeconfig** の設定 (`aws eks update-kubeconfig`)
- EKS アクセスエントリ (access entry) の登録
- Steampipe **Kubernetes** プラグイン + **Trivy** プラグインの接続設定

:::info EKS がない環境
EKS クラスターがないアカウントではこのステップをスキップできます。Kubernetes 関連のページのみ無効になります。
:::

### Step 5: Cognito 認証 (EC2)

```bash
bash scripts/05-setup-cognito.sh
```

Cognito User Pool のユーザー作成とアプリクライアントの設定を行います。

### Step 6a-6f: AgentCore (EC2)

**ラッパースクリプト**で 6a → 6e を順次実行できます:

```bash
bash scripts/06-setup-agentcore.sh
```

| スクリプト | 説明 |
|----------|------|
| `06a-setup-agentcore-runtime.sh` | IAM ロール、ECR、Docker arm64 ビルド、Runtime Endpoint |
| `06b-setup-agentcore-gateway.sh` | 8 つの Gateway を作成 (MCP) |
| `06c-setup-agentcore-tools.sh` | 19 Lambda + 8 Gateway に 125 のツールを登録 |
| `06d-setup-agentcore-interpreter.sh` | Code Interpreter を作成 |
| `06e-setup-agentcore-config.sh` | `route.ts` / `agent.py` の自動設定 (ARN、Gateway URL など) |
| `06f-setup-agentcore-memory.sh` | Memory Store を作成 (365 日保持) — **手動実行が必要** |
| `07-setup-opencost.sh` | Prometheus + OpenCost (EKS コスト分析) |

### Step 8: CloudFront 認証連携 (EC2)

```bash
bash scripts/08-setup-cloudfront-auth.sh
```

Lambda@Edge を CloudFront viewer-request に接続します。

### Step 9: サービスの起動 (EC2)

```bash
bash scripts/09-start-all.sh
```

次のサービスを順番に起動します:
- **Steampipe** サービス (PostgreSQL port 9193)
- **Next.js** プロダクションサーバー (port 3000)
- **OpenCost** (EKS コスト分析、EKS が設定されている場合)

### Step 10: サービスの停止 (EC2)

```bash
bash scripts/10-stop-all.sh
```

実行中のすべての AWSops サービスを安全に停止します。メンテナンスやアップデート時に使用します。

### Step 11: 検証とヘルスチェック (EC2)

```bash
bash scripts/11-verify.sh
```

5 段階の自動検証を行います:
1. **サービス状態** — Steampipe、Next.js のプロセス確認
2. **Steampipe テーブル** — 18 のコアテーブルの存在確認
3. **ページアクセス** — 20+ ページの HTTP レスポンスコード検証
4. **API 応答** — 主要な API エンドポイントの動作確認
5. **設定ファイル** — `data/config.json` の妥当性検証

:::tip デプロイ後の必須作業
Step 3 の後、またはアップデート後に `11-verify.sh` を実行し、すべての構成要素が正常であることを確認してください。`install-all.sh` にも含まれています。
:::

### Step 12: マルチアカウント設定 (EC2、任意)

```bash
bash scripts/12-setup-multi-account.sh
```

複数の AWS アカウントをひとつの AWSops インスタンスで管理するための設定です:
- Steampipe **Aggregator** の接続設定 (`aws` = 全アカウント統合)
- クロスアカウント **IAM ロール**の作成と信頼関係の設定
- `data/config.json` の `accounts[]` 配列の更新

:::info 任意のステップ
単一アカウント環境ではこのステップは不要です。マルチアカウントが必要な場合のみ実行してください。
:::

## 設定ファイル

デプロイ完了後、`data/config.json` が自動生成されます。新しいアカウントにデプロイする際はこのファイルのみ更新すれば十分です。

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

:::tip コード修正は不要
アカウントごとのデプロイでは `data/config.json` のみ変更すれば十分です。ソースコードの修正は必要ありません。
:::

## 既知の問題

:::warning デプロイ時の注意事項

**1. Memory Store の手動実行が必要**
`06f-setup-agentcore-memory.sh` はラッパースクリプト (`06-setup-agentcore.sh`) に含まれていないため、必ず手動で実行してください:
```bash
bash scripts/06f-setup-agentcore-memory.sh
```

**2. systemd サービス設定**
デフォルトで生成される systemd サービスファイルに `proxy.js` への参照が残っている場合があります。正しい起動コマンドは `npm run start` であり、nvm 環境では Node.js のフルパス (`/home/ec2-user/.nvm/versions/node/v20.x.x/bin/node`) を使用する必要があります。

**3. Docker arm64 必須**
AgentCore Runtime の Docker イメージは必ず arm64 でビルドする必要があります:
```bash
docker buildx build --platform linux/arm64 --load -t awsops-agent .
```
:::

## 関連ページ

- [認証フロー](./auth) - Cognito 認証の詳細
- [AgentCore](../overview/agentcore) - AgentCore アーキテクチャの詳細
- [ダッシュボード](../overview/dashboard) - システムアーキテクチャの概要
