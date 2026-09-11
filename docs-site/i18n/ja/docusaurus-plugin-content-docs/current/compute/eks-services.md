---
sidebar_position: 10
title: EKS Services
description: Kubernetes Service の一覧、タイプ、エンドポイント情報
---

import Screenshot from '@site/src/components/Screenshot';

# EKS Services

Kubernetes Service の一覧とネットワーク設定を確認できるページです。

<Screenshot src="/screenshots/compute/eks-services.png" alt="EKS Services" />

## 主な機能

### 統計カード
- **Total Services**: 全 Service 数（シアン）
- **ClusterIP**: ClusterIP タイプのサービス数（緑）
- **NodePort**: NodePort タイプのサービス数（紫）
- **LoadBalancer**: LoadBalancer タイプのサービス数（オレンジ）

### Service Type Distribution チャート
サービスタイプ別の分布を円グラフで可視化します:
- ClusterIP、NodePort、LoadBalancer、Other（ExternalName など）

### Service Resources チャート
サービス別リソース要求量の top-15 バーチャート 2 つ:
- **CPU per Service (millicores)** / **Memory per Service (MiB)** — 各 Service のセレクタを同じ（クラスター, ネームスペース）の **Running Pod** に結合し、スケジューラ有効要求量（アプリコンテナ合計と init コンテナ最大値の大きい方 + overhead）を合算
- 値は要求量（予約）であり実使用量ではありません（キャプションに明記）
- セレクタのないサービス（ExternalName／手動 Endpoints）や一致する Running Pod のないサービスは 0 として描画せず**除外**され、Pod 取得に失敗したクラスターはチャートから除外されキャプションに名前が表示されます

### Service テーブル
| カラム | 説明 |
|------|------|
| Name | Service 名 |
| Namespace | ネームスペース |
| Type | サービスタイプ |
| Cluster IP | クラスター内部 IP |
| External IP | 外部 IP（LoadBalancer タイプ） |
| Created | 作成時刻 |

## Service タイプの理解

### ClusterIP（デフォルト）
- クラスター内部からのみアクセス可能
- 内部サービス間の通信に使用
- 例: バックエンド API、データベース

### NodePort
- すべてのノードの特定ポートで外部アクセス可能
- ポート範囲: 30000-32767
- 開発・テスト環境で主に使用

### LoadBalancer
- クラウドロードバランサーを自動作成（AWS ELB/NLB）
- 外部トラフィックをサービスへルーティング
- 本番環境の外部向けサービスに使用

### ExternalName
- 外部の DNS 名をクラスター内部の名前にマッピング
- CNAME レコードを作成

## 使い方

1. サイドバーで **Compute > K8s > Services** をクリックします
2. 統計カードでサービスタイプの分布を把握します
3. LoadBalancer サービスの External IP を確認します
4. テーブルでサービスごとの Cluster IP を確認します

## AWS 統合

### LoadBalancer タイプ + AWS
- Service 作成時に AWS ELB/NLB を自動プロビジョニング
- Annotation で設定を制御:
  - `service.beta.kubernetes.io/aws-load-balancer-type: nlb`
  - `service.beta.kubernetes.io/aws-load-balancer-internal: "true"`

### コストの考慮事項
- LoadBalancer タイプはそれぞれ AWS ELB のコストが発生
- 複数のサービスで単一の ALB を使用: AWS Load Balancer Controller + Ingress

## 活用のヒント

:::tip LoadBalancer External IP の確認
External IP が `<pending>` の場合:
- AWS Load Balancer のプロビジョニング中
- サブネットタグの欠落を確認
- IAM 権限を確認
:::

:::tip ClusterIP サービスへのアクセス
ClusterIP サービスはクラスター外部から直接アクセスできません。外部アクセスが必要な場合は LoadBalancer または Ingress を使用してください。
:::

:::info AI 分析
AI Assistant で「Service の一覧」「LoadBalancer サービスの状況」「External IP のない LoadBalancer を探して」などの分析ができます。
:::

## 関連ページ

- [EKS Overview](../compute/eks) - クラスター全体の状況
- [EKS Deployments](../compute/eks-deployments) - Service が接続された Deployment
- [VPC](../network/vpc) - ネットワーク構成とロードバランサー
- [EKS Explorer](../compute/eks-explorer) - Ingress の詳細確認
