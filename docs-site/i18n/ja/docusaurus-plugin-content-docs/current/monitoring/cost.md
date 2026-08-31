---
sidebar_position: 4
title: Cost Explorer
description: AWS コストをサービス別、日別、月別に分析し、トレンドを把握します。
---

import Screenshot from '@site/src/components/Screenshot';

# Cost Explorer

AWS コストデータをさまざまな観点から分析し、可視化するページです。

<Screenshot src="/screenshots/monitoring/cost.png" alt="Cost" />

## データ可用性 & スナップショットフォールバック

ページロード時に Cost Explorer API の可用性を自動チェックし、利用不可の場合はローカルスナップショットにフォールバックします。

### 3 段階のロードフロー
1. **Cost 可用性チェック** → `/awsops/api/steampipe?action=cost-check`
2. 可能であればライブクエリを実行 (Cost Explorer API → Steampipe)
3. ライブが失敗した場合 → `/awsops/api/steampipe?action=cost-snapshot&accountId={id}` を呼び出し、`data/cost/` 配下の最後のキャッシュをロード

### UI 状態

| 状態 | 表示 |
|------|------|
| ライブ OK | 通常画面 (バナーなし) |
| スナップショットフォールバック | 黄色いバナー: `Last fetched: {snapshotDate}` |
| すべて失敗 | 赤いバナー: "No cached cost snapshots available. Visit this page when Cost Explorer is accessible to build a local cache." |

:::info MSP 自動検知
Host アカウントが MSP (Managed Service Provider) 環境の場合、Cost Explorer API が無効化されていることがあります — `02-setup-nextjs.sh` がインストール時点で検知し、`costEnabled: false` に設定します。この場合、ページは直ちにスナップショットフォールバックまたは空の状態になります。
:::

:::tip スナップショット自動ビルド
ライブクエリが成功するたびに、自動的に `data/cost/{accountId}.json` に結果が保存されます。MSP 環境や一時的に権限が欠けている場合でも、直前のデータで照会を継続できるようにするセーフガードです。
:::

## 主な機能

### コストサマリー
- **This Month**: 今月の累積コスト
- **Last Month**: 先月の総コスト
- **Projected**: 月末の予想コスト (現在の日付を基準に推定)
- **Daily Avg**: 1 日あたりの平均コスト
- **MoM Change**: 前月比の変化率
- **Services**: コストが発生したサービス数

### 期間フィルター
| オプション | 説明 |
|------|------|
| This Month | 今月のみ |
| 3 Months | 直近 3 か月 |
| 6 Months | 直近 6 か月 |
| 1 Year | 直近 1 年 |

### サービスフィルター
特定のサービスのみを選択して分析できます。複数のサービスを選択すると、それらのサービスの合計が表示されます。

### 可視化
- **Daily Cost Trend**: 直近 30 日の日別コスト推移
- **Monthly Cost Trend**: 月別コスト推移
- **Cost by Service (Top 8)**: 上位 8 サービスの割合の円グラフ
- **Top 10 Services**: 上位 10 サービスの棒グラフ

### サービス詳細
サービス行をクリックするとスライドパネルで確認できます:
- サービス別の総コスト
- 月別コスト推移の折れ線グラフ
- 月別の詳細内訳

## 使い方

1. **期間の選択**: 分析する期間を選択 (1m, 3m, 6m, 12m)
2. **サービスフィルター**: Services ボタンで特定のサービスのみフィルタリング
3. **チャートの確認**: コスト推移およびサービス別分布を確認
4. **詳細分析**: サービス行をクリックして月別の詳細を確認

:::tip MSP 環境の自動検知
Managed Service Provider (MSP) 環境では Cost Explorer API へのアクセスが制限されることがあります。AWSops はこれを自動的に検知し、代替データを表示します。
:::

## 活用のヒント

### コスト急増の原因把握
1. MoM Change が高い場合 (>10%)、サービステーブルの Change カラムを確認
2. Change が 20% 以上のサービスをクリックして月別推移を確認
3. 特定の月に急増していれば、その期間のリソース変更履歴を確認

### 予算管理
Projected の値で月末の予想コストを確認してください。予算を超過しそうな場合は:
- 未使用リソースの整理
- Reserved Instance/Savings Plans の検討
- リソースサイズの最適化

### コスト最適化対象の識別
Share カラムでコスト比重の高いサービスを、優先的な最適化対象として検討してください。

:::info Cost Explorer 非対応環境
Cost Explorer が無効化された環境では、スナップショットデータを表示します。「Showing cached data」バナーが表示され、最後のキャッシュ時点も併せて表示されます。
:::

### costEnabled トグル
サイドバー下部の **Cost** トグルで Cost Explorer 機能のオン/オフを切り替えられます。MSP 環境などで API 呼び出しを減らしたい場合は無効化してください。

## AI 分析のヒント

AI アシスタントで Cost Gateway (11 個のツール) を活用した質問の例:

- 「今月のコストが増加した原因を分析して」
- 「EC2 コストの最適化案をおすすめして」
- 「Reserved Instance へ移行した場合の削減効果を計算して」
- 「サービス別コスト予測を 3 か月分見せて」
- 「タグ別のコストを分析して」

## 関連ページ

- [Resource Inventory](../monitoring/inventory) - リソース数量およびコスト影響
- [ECS Container Cost](../compute/ecs-container-cost) - ECS コンテナコスト
- [EKS Container Cost](../compute/eks-container-cost) - EKS コンテナコスト
