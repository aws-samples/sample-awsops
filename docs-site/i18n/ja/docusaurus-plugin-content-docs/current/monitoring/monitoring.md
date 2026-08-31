---
sidebar_position: 1
title: Monitoring Overview
description: EC2, RDS, EBS, K8s リソースの CPU、メモリ、ネットワーク、Disk I/O メトリクスをリアルタイムで監視します。
---

import Screenshot from '@site/src/components/Screenshot';

# Monitoring Overview

AWS インフラ全般のパフォーマンスメトリクスを 1 つの画面で総合的に監視できるページです。

<Screenshot src="/screenshots/monitoring/monitoring.png" alt="Monitoring" />

## 主な機能

### 総合ダッシュボード
- **EC2 CPU**: インスタンス別の平均/最大 CPU 使用率
- **Network I/O**: インスタンス別のネットワーク In/Out トラフィック (MB/h)
- **K8s Memory**: ノード別のメモリ容量、割り当て量、Pod 数
- **EBS IOPS**: ボリューム別の Read/Write IOPS
- **RDS**: データベースの CPU、コネクション、FreeableMemory

### タブ別詳細表示
ページ上部には 5 つのタブが常に表示され、カウントがラベルと一緒に表示されます。

| タブ | ラベル | 内容 | データ照会 |
|---|------|------|------------|
| `ec2` | `EC2 CPU ({n})` | インスタンス別の平均/最大 CPU、クリックで時系列詳細ビュー | ページロード時に一括 |
| `network` | `Network ({n})` | Network In/Out (MB/h)、行クリックでインスタンス別 24h グラフ | **オンデマンド** — タブ表示時にインスタンスごとに `fetchNetwork()` を順次呼び出し |
| `memory` | `Memory ({n} nodes)` | K8s ノードメモリ + RDS FreeableMemory の統合 | ページロード時に一括 |
| `ebs` | `EBS IOPS ({n})` | ボリューム別の Read/Write IOPS、時間別推移 | ページロード時に一括 |
| `rds` | `RDS ({n})` | CPU + Connection + FreeableMemory | ページロード時に一括 |

:::info Network タブの動作方式
Network タブは表示時点でインスタンスごとに CloudWatch `NetworkIn/Out` を**順次**呼び出します (`useEffect` で `activeTab === 'network'` を検知)。インスタンスが多いと、すべてのグラフが埋まるまで数十秒かかることがあります — 他のタブでは呼び出さないため、普段のロードコストを抑えています。
:::

:::info EBS IOPS タブ
ページの `ebsLatest` データは dashboard pre-warm キャッシュ (`cache-warmer.ts`) から取得します。リフレッシュボタンは `bustCache=true` でキャッシュを無効化します。
:::

### インスタンス詳細メトリクス
EC2 インスタンス行をクリックすると詳細メトリクスビューに移動します:
- CPUUtilization, NetworkIn/Out, DiskReadOps, DiskWriteOps
- 期間フィルター: 1h, 6h, 24h, 7d, 30d
- メトリクス別の平均/最大値を表示

## 使い方

1. **タブ選択**: 監視するリソースタイプを選択 (EC2 CPU, Network, Memory, EBS, RDS)
2. **テーブルソート**: カラムヘッダーのクリックでソート
3. **詳細表示**: 行クリックでスライドパネルまたは詳細ビューを表示
4. **リフレッシュ**: 右上のリフレッシュボタンで最新データを照会

:::tip パフォーマンスしきい値の色
- **緑**: 正常 (CPU < 50%)
- **オレンジ**: 注意 (CPU 50-80%)
- **赤**: 警告 (CPU > 80%)
:::

## 活用のヒント

### 高 CPU インスタンスの識別
上部 StatsCard の「High CPU (>80%)」カードですぐに確認できます。数字をクリックすると該当インスタンスにフィルタリングされます。

### K8s メモリ予約率の確認
Memory タブで K8s ノードの Reserved % カラムを確認してください。システム予約メモリが過度に高いと、Pod のスケジューリングに影響する可能性があります。

### RDS メモリのモニタリング
RDS 行をクリックすると FreeableMemory グラフを確認できます。継続的に低い値の場合は、インスタンスサイズの増強が必要かもしれません。

:::info CloudWatch 詳細モニタリング
EC2 の詳細メトリクスは、CloudWatch 詳細モニタリングが有効なインスタンスでのみ 1 分単位のデータを提供します。基本モニタリングは 5 分単位です。
:::

## AI 分析のヒント

AI アシスタントで Monitoring Gateway (17 個のツール) を活用すると、より深い分析が可能です:

- 「EC2 CPU 使用率が高いインスタンスの原因を分析して」
- 「過去 7 日間のネットワークトラフィックのパターンを分析して」
- 「RDS コネクション数急増の原因を見つけて」
- 「K8s ノードのメモリ不足の予想時期を教えて」

## 関連ページ

- [CloudWatch](./monitoring/cloudwatch) - アラーム管理
- [Cost Explorer](./monitoring/cost) - コスト分析
- [Resource Inventory](./monitoring/inventory) - リソース数量の推移
