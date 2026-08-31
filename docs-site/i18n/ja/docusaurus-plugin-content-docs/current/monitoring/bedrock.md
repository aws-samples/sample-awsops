---
sidebar_position: 2
title: Bedrock
description: Amazon Bedrock モデルの使用量、コスト、トークンのモニタリング
---

# Bedrock Monitoring

Amazon Bedrock のモデル別使用量、トークンコスト、Prompt Caching による削減効果をリアルタイムで監視するダッシュボードです。

import Screenshot from '@site/src/components/Screenshot';

<Screenshot src="/screenshots/monitoring/bedrock.png" alt="Bedrock Monitoring" />

## 主な機能

### 統計カード (8 枚)

| カード | 説明 |
|------|------|
| Total Cost | 選択期間内の全モデルのコスト合計 |
| Invocations | モデル呼び出しの総回数 |
| Input Tokens | 入力トークンの総数 |
| Output Tokens | 出力トークンの総数 |
| Avg Latency | 平均応答遅延時間 (秒) |
| Errors | クライアント (4xx) + サーバー (5xx) エラーの合計 |
| Cache Savings | Prompt Caching で削減されたコスト + キャッシュヒット率 (%) |
| Models Used | 期間内に使用されたモデル数 |

### チャート (3 種)

- **Cost by Model** (円グラフ): モデル別コストの割合
- **Invocations by Model** (棒グラフ): モデル別呼び出し回数の比較
- **Token Usage Over Time** (折れ線グラフ): 時間帯別トークン使用量の推移

### Account Total と AWSops 使用量の比較

アカウント全体 (CloudWatch ベース) と AWSops アプリ内部の使用量を並べて比較します:

- **Account Total**: CloudWatch `AWS/Bedrock` ネームスペースから収集したアカウント全体の Invocations、Input/Output Tokens、推定コスト
- **AWSops App**: ダッシュボードの AI アシスタントを通じた累積呼び出し数、トークン使用量、モデル別分布

### Prompt Caching サマリー

Prompt Caching が有効なモデルのキャッシング効果を一目で確認できます:
- Cache Read/Write トークン数
- キャッシュヒット率 (%)
- キャッシュコストと削減額

### モデル別詳細情報

テーブルでモデル行をクリックするとスライドパネルが開きます:
- **Cost Breakdown**: Input/Output/Cache Read/Cache Write コストの詳細
- **Usage**: Invocations、トークン数、遅延時間、エラー件数
- **Pricing**: モデル別の 1M トークンあたりの価格情報
- **時系列チャート**: 呼び出し推移、トークン使用量の推移

### 時間範囲の選択

右上の時間範囲ボタンで照会期間を変更します:
- **1h**: 直近 1 時間 (5 分間隔)
- **6h**: 直近 6 時間 (5 分間隔)
- **24h**: 直近 24 時間 (1 時間間隔)
- **7d**: 直近 7 日 (1 日間隔) — デフォルト
- **30d**: 直近 30 日 (1 日間隔)

## AI ページのトークンコスト表示

AI アシスタントページ (`/ai`) では、各応答にトークン使用量とコストが表示されます:
- Input/Output トークン数
- モデル別価格に基づくコスト計算
- Bedrock ダッシュボードと同一の価格テーブルを使用

## データソース

- **CloudWatch**: `AWS/Bedrock` ネームスペースの `Invocations`、`InputTokenCount`、`OutputTokenCount`、`InvocationLatency`、`InvocationClientErrors`、`InvocationServerErrors`、`CacheReadInputTokenCount`、`CacheWriteInputTokenCount` メトリクス
- **AWSops 統計**: `agentcore-stats.ts` の累積呼び出し/トークンデータ

## 活用のヒント

:::tip コスト最適化
Prompt Caching のヒット率が低い場合、繰り返し使われるシステムプロンプトやコンテキストをキャッシング可能な形に構成すると、コストを大幅に削減できます。
:::

:::info Cross-Region Inference
クロスリージョン推論モデル ID (例: `us.anthropic.claude-*`) も自動的に認識し、正しい価格を適用します。
:::

## 関連ページ

- [Monitoring Overview](./monitoring.md) - インフラのパフォーマンスモニタリング
- [Cost Explorer](./cost.md) - AWS 全体のコスト分析
- [AI Assistant](../overview/ai-assistant.md) - AI アシスタント利用ガイド
