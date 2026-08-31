---
sidebar_position: 3
---

import Screenshot from '@site/src/components/Screenshot';

# RDS

RDS(Relational Database Service)インスタンスをモニタリングし、パフォーマンスメトリクスを確認します。

<Screenshot src="/screenshots/storage/rds.png" alt="RDS" />

## 主な機能

### 統計カード
- **Total Instances**: RDS インスタンスの総数
- **Storage (GB)**: 割り当てられたストレージの総容量
- **Multi-AZ**: Multi-AZ 配置されたインスタンス数
- **Engines**: 使用中のデータベースエンジンの種類数

### 可視化チャート
- **Engine Distribution**: MySQL、PostgreSQL、Aurora などエンジン別の分布
- **Storage by Instance**: インスタンスごとのストレージ使用量

### インスタンスメトリクステーブル
CloudWatch から収集したリアルタイムメトリクスをテーブルで表示:
- **CPU**: CPU 使用率(プログレスバー + 数値)
- **Free Memory**: 空きメモリ
- **Connections**: 現在の接続数
- **Read/Write IOPS**: 読み取り/書き込み IOPS
- **Network In/Out**: ネットワークトラフィック
- **Free Storage**: 空きストレージ

### Security Group チェーン
詳細パネルで RDS に関連付けられた Security Group とインバウンドルールを確認:
- Security Group の ID、名前
- プロトコル、ポート範囲
- ソース IP または参照している Security Group

### 詳細パネル
インスタンスをクリックすると確認できる情報:
- インスタンス識別子、エンジン、バージョン、クラス
- ストレージ設定(タイプ、容量、暗号化)
- ネットワーク設定(VPC、サブネット、エンドポイント)
- バックアップ設定(保持期間、バックアップウィンドウ)
- セキュリティ機能(IAM 認証、Performance Insights など)
- CloudWatch メトリクスチャート

## 使い方

### インスタンス一覧の照会
1. 検索ボックスにインスタンス識別子、エンジンなどを入力
2. テーブルで状態、エンジン、クラスを確認
3. 行をクリックして詳細情報を照会

### パフォーマンスモニタリング
Instance Metrics テーブルで:
1. CPU 使用率を確認(80% 以上は注意)
2. Free Memory と Free Storage を確認
3. Connection 数をモニタリング
4. IOPS とネットワークトラフィックを確認

### Security Group の確認
詳細パネルの「Security Groups」セクションで:
1. 関連付けられた Security Group の一覧を確認
2. 各 SG のインバウンドルールを確認
3. 意図しない広範囲な許可がないか点検

## 活用のヒント

:::tip Multi-AZ の推奨
本番ワークロードには Multi-AZ 配置を推奨します。自動フェイルオーバーにより高可用性を確保できます。Multi-AZ カードで現在の配置状態を確認してください。
:::

:::info ストレージの自動拡張
Free Storage が少なくなってきたら、ストレージの自動拡張設定を検討してください。メトリクステーブルで各インスタンスの空きストレージをモニタリングできます。
:::

## AI 分析のヒント

AI アシスタントに次のように質問してみてください:

- 「RDS インスタンスのうち CPU 使用率が高いものは?」
- 「Multi-AZ が設定されていない本番データベースを確認して」
- 「RDS の接続数の推移を分析して」
- 「特定の RDS にアクセス可能な Security Group を分析」

:::tip Data Gateway
AI アシスタントは Data Gateway(15 個のツール)を通じて、RDS のパフォーマンス分析、クエリ最適化の提案、バックアップ状態の点検などをサポートします。Monitoring Gateway と連携して CloudWatch アラームの設定も分析できます。
:::

## 関連ページ

- [VPC](../network/vpc) - RDS がデプロイされた VPC および Security Group
- [CloudWatch](../monitoring/cloudwatch) - RDS 関連のアラーム
- [Cost Explorer](../monitoring/cost) - RDS のコスト分析
