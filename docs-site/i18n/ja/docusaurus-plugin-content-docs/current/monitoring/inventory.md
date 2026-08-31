---
sidebar_position: 5
title: Resource Inventory
description: AWS リソース数量の推移を追跡し、コスト影響を推定します。
---

import Screenshot from '@site/src/components/Screenshot';

# Resource Inventory

AWS リソースの数量変化を日次で追跡し、コスト影響を推定するページです。

<Screenshot src="/screenshots/monitoring/inventory.png" alt="Inventory" />

## 主な機能

### サマリー統計
- **Resource Types**: 追跡中のリソースタイプ数
- **Total Count**: 全リソース数
- **7d Net Change**: 7 日間の純変化量

### リソース推移グラフ
- マルチラインチャートでリソースタイプ別の数量推移を可視化
- 期間トグル: 30 日 / 90 日
- リソースタイプのトグルで表示するリソースを選択

### Core Resources (デフォルト表示)
- EC2 Instances
- RDS Instances
- S3 Buckets
- EBS Volumes
- Lambda Functions

### Other Resources
- VPCs, Subnets, NAT Gateways
- ALBs, NLBs, Route Tables
- IAM Users, IAM Roles
- ECS Tasks, ECS Services
- DynamoDB Tables
- EKS Nodes, K8s Pods, K8s Deployments
- ElastiCache Clusters
- CloudFront Distributions
- WAF Web ACLs
- ECR Repositories
- Public S3 Buckets, Open Security Groups, Unencrypted EBS

### リソーステーブル
| カラム | 説明 |
|------|------|
| Resource | リソースタイプ |
| Current | 現在の数量 |
| 7d Ago | 7 日前の数量 |
| 30d Ago | 30 日前の数量 |
| 7d Change | 7 日間の変化量および変化率 |
| 30d Change | 30 日間の変化量および変化率 |

### コスト影響の推定
リソース数量の変化にともなう月間コスト影響を推定します:
- RDS Instances: $200/月 (推定)
- ElastiCache Clusters: $150/月
- EKS Nodes: $100/月
- NAT Gateways: $45/月
- EC2 Instances: $80/月
- その他リソース別の重み付けを適用

## 使い方

1. **推移の確認**: グラフでリソース数量の変化パターンを確認
2. **期間の変更**: 30d/90d トグルで分析期間を調整
3. **リソースの選択**: トグルボタンで関心のあるリソースのみ表示
4. **テーブル分析**: 詳細な数値と変化率を確認
5. **コスト影響**: 下部のコスト推定セクションを確認

:::tip スナップショットベースのデータ
Resource Inventory はダッシュボードのロード時に自動でスナップショットを保存します。追加の API クエリなしで履歴データを蓄積するため、パフォーマンスへの影響はありません。
:::

## 活用のヒント

### リソース増加の追跡
7d Change または 30d Change カラムでオレンジ色 (増加) で表示されるリソースを確認してください。想定外の増加はコスト急増の原因になり得ます。

### セキュリティリソースのモニタリング
次のリソースの変化に注意してください:
- **Public S3 Buckets**: 増加時はデータ露出リスク
- **Open Security Groups**: 増加時はセキュリティ脆弱性
- **Unencrypted EBS**: コンプライアンス上の問題

### コスト影響の解釈
Cost Impact Estimation セクションでは:
- 正の値 (+): 想定コスト増加
- 負の値 (-): 想定コスト減少

実際のコストはインスタンスタイプや使用量などによって異なる場合があります。

:::info データ保管
スナップショットデータは `data/inventory/` ディレクトリに保存されます。90 日以上経過したデータは分析から除外されますが、ファイルは保持されます。
:::

## AI 分析のヒント

AI アシスタントを活用した質問の例:

- 「過去 30 日間で最も増加したリソースを分析して」
- 「このリソース増加トレンドが続くと月のコストはいくらになる?」
- 「セキュリティ関連リソースの変化を要約して」
- 「リソース整理が必要な項目をおすすめして」

## 関連ページ

- [Cost Explorer](../monitoring/cost) - 実際のコスト分析
- [Security Overview](../security) - セキュリティリソースの詳細
- [Monitoring Overview](../monitoring) - パフォーマンスモニタリング
