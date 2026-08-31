---
sidebar_position: 7
---

import Screenshot from '@site/src/components/Screenshot';

# MSK

Amazon MSK(Managed Streaming for Apache Kafka)クラスターをモニタリングし、ブローカーのパフォーマンスを確認します。

<Screenshot src="/screenshots/storage/msk.png" alt="MSK" />

## 主な機能

### 統計カード
- **Total Clusters**: クラスターの総数(アクティブなクラスター数を含む)
- **Active**: アクティブ状態のクラスター数
- **Total Brokers**: ブローカーノードの総数
- **Enhanced Monitoring**: 拡張モニタリングが有効なクラスター数
- **In-Transit Encrypted**: 転送中の暗号化が有効なクラスター数
- **Avg Brokers/Cluster**: クラスターあたりの平均ブローカー数

### 可視化チャート
- **Cluster State**: ACTIVE、CREATING などステータス別の分布
- **Kafka Version**: Kafka バージョン別の分布

### Broker Nodes メトリクステーブル
CloudWatch から収集したブローカーごとのリアルタイムメトリクス:
- **Cluster**: クラスター名
- **Type**: BROKER または CONTROLLER
- **ID**: ブローカー ID
- **Instance**: インスタンスタイプ
- **VPC IP**: ブローカーの VPC IP アドレス
- **ENI**: 関連付けられた ENI ID
- **CPU**: CPU 使用率(User + System)
- **Memory**: メモリ使用率
- **Network In/Out**: ネットワークトラフィック (KB/s)
- **Endpoint**: ブローカーのエンドポイント

### 詳細パネル
クラスターをクリックすると確認できる情報:
- クラスター名、状態、タイプ
- Kafka バージョン、ブローカー数
- Enhanced Monitoring の設定
- ストレージモード
- ブローカー構成(インスタンスタイプ、EBS サイズ、AZ 分布)
- Security Group、Subnet の情報
- 暗号化設定(In-Transit、At-Rest、KMS)
- 認証設定(IAM、SCRAM、TLS)
- Bootstrap Brokers (Plaintext, TLS)
- ブローカーノードの詳細情報
- Open Monitoring (JMX/Node Exporter)
- ロギング設定

## 使い方

### クラスター一覧の照会
1. 検索ボックスにクラスター名、Kafka バージョンなどを入力
2. テーブルで状態、インスタンスタイプ、ブローカー数を確認
3. 行をクリックして詳細情報を照会

### ブローカーパフォーマンスのモニタリング
Broker Nodes テーブルで:
1. **CPU** 使用率を確認(80% 以上は注意)
2. **Memory** 使用率をモニタリング(85% 以上は警告)
3. **Network In/Out** トラフィックを確認
4. クラスターごとのブローカー分布を確認

### Bootstrap Brokers の確認
詳細パネルで Bootstrap Brokers のエンドポイントを確認:
- **Plaintext**: 暗号化なしの接続用
- **TLS**: TLS 暗号化接続用

## 活用のヒント

:::tip ブローカー数の計画
パーティション数とレプリケーションファクターを考慮して、適切なブローカー数を計画してください。一般的に 3 台以上のブローカーを推奨し、高可用性のために複数の AZ に分散配置します。
:::

:::info KRaft モード
Kafka 3.x 以降では ZooKeeper の代わりに KRaft モードを使用できます。Broker Nodes テーブルに CONTROLLER タイプのノードが表示されていれば KRaft モードです。
:::

## AI 分析のヒント

AI アシスタントに次のように質問してみてください:

- 「MSK ブローカーのうち CPU 使用率が高いものは?」
- 「転送中の暗号化が無効になっているクラスターを確認して」
- 「MSK クラスターのネットワークトラフィック推移を分析」
- 「Kafka バージョンのアップグレードが必要なクラスターは?」

:::tip Data Gateway
AI アシスタントは Data Gateway(15 個のツール)を通じて、MSK クラスターの分析、ブローカーのパフォーマンスチューニング、トピック管理などをサポートします。
:::

## 関連ページ

- [VPC](../network/vpc) - MSK がデプロイされた VPC および Security Group
- [CloudWatch](../monitoring/cloudwatch) - MSK 関連のアラーム
- [Cost Explorer](../monitoring/cost) - MSK のコスト分析
