---
sidebar_position: 5
---

import Screenshot from '@site/src/components/Screenshot';

# ElastiCache

ElastiCache クラスター(Valkey、Redis、Memcached)をモニタリングし、パフォーマンスメトリクスを確認します。

<Screenshot src="/screenshots/storage/elasticache.png" alt="ElastiCache" />

## 主な機能

### 統計カード
- **Clusters**: クラスターの総数(Replication Group 数を含む)
- **Total Nodes**: ノードの総数
- **Valkey**: Valkey エンジンのクラスター数
- **Redis**: Redis エンジンのクラスター数
- **Memcached**: Memcached エンジンのクラスター数
- **Repl Groups**: Replication Group の数
- **Node Types**: 使用中のノードタイプの数

### 可視化チャート
- **Engine Distribution**: Valkey、Redis、Memcached のエンジン別分布
- **Node Type Distribution**: ノードタイプ別の分布

### Cache Nodes メトリクステーブル
CloudWatch から収集したリアルタイムメトリクス:
- **Cluster ID**: クラスターの識別子
- **Engine**: エンジンの種類(色で区別)
- **Node ID**: ノードの識別子
- **Status**: ノードの状態
- **CPU**: CPU 使用率
- **Engine CPU**: エンジン CPU 使用率
- **Memory**: 空きメモリ
- **Network In/Out**: ネットワークトラフィック
- **Connections**: 現在の接続数
- **AZ**: アベイラビリティゾーン
- **Endpoint**: ノードのエンドポイント

### 詳細パネル
クラスターをクリックすると確認できる情報:
- クラスター ID、ARN、エンジン、バージョン
- ノードタイプ、状態、ノード数
- Replication Group の情報
- ネットワーク設定(サブネットグループ、AZ)
- セキュリティ設定(At-Rest/Transit 暗号化、Auth Token)
- 構成設定(スナップショット保持、メンテナンスウィンドウ)
- Security Group とインバウンドルール — 各 SG は同期済みの security_group インベントリから protocol/port/ソース（CIDR・SG・プレフィックスリスト）に展開されます（ライブ AWS 呼び出しなし。未同期の SG は 'not synced' 表示）
- CloudWatch メトリクスチャート

## 使い方

### クラスター一覧の照会
1. Cache Clusters テーブルでクラスター一覧を確認
2. 検索ボックスにクラスター ID、エンジンなどを入力
3. 行をクリックして詳細情報を照会

### ノードパフォーマンスのモニタリング
Cache Nodes テーブルで:
1. CPU/Engine CPU 使用率を確認
2. Memory 使用量をモニタリング
3. Network In/Out トラフィックを確認
4. Connections 数をモニタリング

### Replication Group の確認
Replication Groups テーブルで:
- Group ID、状態
- Multi-AZ の設定
- Auto Failover の設定
- Cluster Mode の状態

## 活用のヒント

:::tip エンジン選択ガイド
- **Valkey**: Redis 互換のオープンソース、AWS 最適化
- **Redis**: 豊富なデータ構造、Pub/Sub のサポート
- **Memcached**: シンプルなキー・バリューキャッシング、マルチスレッド対応
:::

:::info 暗号化の推奨
セキュリティのため、At-Rest 暗号化と Transit 暗号化の両方を有効化してください。詳細パネルの Security セクションで現在の暗号化設定を確認できます。
:::

## AI 分析のヒント

AI アシスタントに次のように質問してみてください:

- 「ElastiCache クラスターのうち暗号化が無効になっているものは?」
- 「Redis クラスターのメモリ使用率を分析して」
- 「Cache Hit Rate が低いクラスターを確認して」
- 「ElastiCache のノードタイプ別コストを比較して」

:::tip Data Gateway
AI アシスタントは Data Gateway(15 個のツール)を通じて、ElastiCache のパフォーマンス分析、キャッシュ最適化、コスト分析などをサポートします。
:::

## 関連ページ

- [VPC](../network/vpc) - ElastiCache がデプロイされた VPC および Security Group
- [CloudWatch](../monitoring/cloudwatch) - ElastiCache 関連のアラーム
- [Cost Explorer](../monitoring/cost) - ElastiCache のコスト分析
