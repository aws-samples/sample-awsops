---
sidebar_position: 6
---

import Screenshot from '@site/src/components/Screenshot';

# OpenSearch

Amazon OpenSearch Service ドメインをモニタリングし、クラスターの状態を確認します。

<Screenshot src="/screenshots/storage/opensearch.png" alt="OpenSearch" />

## 主な機能

### 統計カード
- **Total Domains**: ドメインの総数(アクティブなドメイン数を含む)
- **Processing**: 構成更新中のドメイン数
- **Node-to-Node Enc**: ノード間暗号化が有効なドメイン数
- **At-Rest Enc**: 保存データの暗号化が有効なドメイン数
- **VPC Domains**: VPC 内にデプロイされたドメイン数
- **Public Domains**: パブリックアクセスが許可されたドメイン数

### 可視化チャート
- **Engine Version**: OpenSearch/Elasticsearch のバージョン別分布
- **Encryption Status**: 暗号化設定の状態分布

### Domain Metrics テーブル
CloudWatch から収集したリアルタイムメトリクス:
- **Domain**: ドメイン名
- **Engine**: エンジンバージョン
- **Cluster Status**: GREEN/YELLOW/RED の状態
- **CPU**: CPU 使用率
- **JVM Memory**: JVM メモリプレッシャー
- **Nodes**: ノード数
- **Documents**: 検索可能なドキュメント数
- **Free Storage**: 空きストレージ
- **Search Rate/Latency**: 検索リクエスト数とレイテンシー
- **Index Rate/Latency**: インデックスリクエスト数とレイテンシー

### 詳細パネル
ドメインをクリックすると確認できる情報:
- ドメイン名、ID、エンジンバージョン
- 状態、IP タイプ、エンドポイント
- クラスター構成(インスタンスタイプ、ノード数、Master の設定)
- EBS ストレージの設定
- 暗号化設定(Node-to-Node、At-Rest、KMS キー)
- Advanced Security の設定
- VPC/ネットワーク構成
- サービスソフトウェアのバージョン
- ログパブリッシング設定

## 使い方

### ドメイン一覧の照会
1. 検索ボックスにドメイン名、エンジンバージョンを入力
2. テーブルで状態、インスタンスタイプ、ノード数を確認
3. 行をクリックして詳細情報を照会

### クラスター状態のモニタリング
Domain Metrics テーブルで:
1. **Cluster Status** を確認(GREEN が正常)
2. CPU と JVM Memory のプレッシャーをモニタリング
3. Search/Index Latency を確認
4. Free Storage をモニタリング

### セキュリティ設定の確認
1. 暗号化カードで全体の暗号化状態を把握
2. VPC/Public ドメインの区分を確認
3. 詳細パネルで Fine-Grained Access Control を確認

## 活用のヒント

:::tip Cluster Status の管理
- **GREEN**: すべてのシャードが正常に割り当て済み
- **YELLOW**: 一部のレプリカシャードが未割り当て(機能は正常)
- **RED**: 一部のプライマリシャードが未割り当て(データ損失の可能性)

RED 状態は即時の対応が必要です。
:::

:::info VPC デプロイの推奨
セキュリティのため、OpenSearch ドメインは VPC 内にデプロイすることを推奨します。Public Domains カードが赤色で表示された場合は、VPC への移行を検討してください。
:::

## AI 分析のヒント

AI アシスタントに次のように質問してみてください:

- 「OpenSearch クラスターの状態が YELLOW/RED のドメインは?」
- 「ノード間暗号化が無効になっているドメインを確認して」
- 「OpenSearch の検索レイテンシーが高いドメインを分析」
- 「OpenSearch のインデックスパフォーマンスの最適化方法を教えて」

:::tip Data Gateway
AI アシスタントは Data Gateway(15 個のツール)を通じて、OpenSearch クラスターの分析、インデックス最適化、検索パフォーマンスのチューニングなどをサポートします。
:::

## 関連ページ

- [VPC](../network/vpc) - OpenSearch がデプロイされた VPC および Security Group
- [CloudWatch](../monitoring/cloudwatch) - OpenSearch 関連のアラーム
- [Cost Explorer](../monitoring/cost) - OpenSearch のコスト分析
