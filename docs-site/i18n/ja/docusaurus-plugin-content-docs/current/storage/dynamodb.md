---
sidebar_position: 4
---

import Screenshot from '@site/src/components/Screenshot';

# DynamoDB

DynamoDB テーブルを管理し、キャパシティと設定をモニタリングします。

<Screenshot src="/screenshots/storage/dynamodb.png" alt="DynamoDB" />

## 主な機能

### 統計カード
- **Tables**: テーブルの総数
- **Active**: アクティブ状態のテーブル数
- **Total Items**: すべてのテーブルの合計アイテム数
- **Total Size**: すべてのテーブルの合計データサイズ

### 可視化チャート
- **Table Status**: ACTIVE、CREATING などステータス別の分布
- **Items per Table**: テーブルごとのアイテム数の分布

### テーブル一覧
- テーブル名
- ステータス(ACTIVE、CREATING など)
- アイテム数
- データサイズ
- 課金モード(On-Demand/Provisioned)
- リージョン

### 詳細パネル
テーブルをクリックすると確認できる情報:
- テーブル名、ARN、ステータス
- アイテム数、データサイズ
- 課金モード
- 作成日、リージョン
- キースキーマ(Partition Key、Sort Key)
- 読み取り/書き込みキャパシティ
- Point-in-Time Recovery の設定
- 暗号化設定 (SSE)
- タグ

## 使い方

### テーブル一覧の照会
1. テーブル一覧で全テーブルを確認
2. ステータスバッジでテーブルの状態を把握
3. 行をクリックして詳細情報を照会

### キャパシティモードの確認
課金カラムでキャパシティモードを確認:
- **On-Demand**: 使用量ベースの課金 (PAY_PER_REQUEST)
- **Provisioned**: 事前に設定したキャパシティベースの課金

### キースキーマの確認
詳細パネルの「Keys」セクションで:
- HASH (Partition Key) を確認
- RANGE (Sort Key) を確認(存在する場合)

## 活用のヒント

:::tip On-Demand vs Provisioned
トラフィックパターンが予測不可能または変動が激しい場合は On-Demand モードが適しています。安定したトラフィックパターンであれば Provisioned モードでコストを削減できます。
:::

:::info Point-in-Time Recovery
重要なデータが保存されているテーブルでは PITR(Point-in-Time Recovery)を有効化してください。詳細パネルの Settings セクションで現在の設定を確認できます。
:::

## AI 分析のヒント

AI アシスタントに次のように質問してみてください:

- 「DynamoDB テーブルのうち PITR が無効になっているものは?」
- 「On-Demand モードのテーブルのコストを分析して」
- 「DynamoDB テーブルのキャパシティ使用量の推移を見せて」
- 「グローバルテーブルの設定状態を確認して」

:::tip Data Gateway
AI アシスタントは Data Gateway(15 個のツール)を通じて、DynamoDB テーブルの分析、キャパシティプランニング、インデックス最適化などをサポートします。
:::

## 関連ページ

- [Cost Explorer](../monitoring/cost) - DynamoDB のコスト分析
- [IAM](../security/iam) - DynamoDB へのアクセス権限
- [CloudWatch](../monitoring/cloudwatch) - DynamoDB 関連のアラーム
