---
sidebar_position: 2
title: CloudWatch
description: CloudWatch アラームを監視し、状態変化を追跡します。
---

import Screenshot from '@site/src/components/Screenshot';

# CloudWatch

AWS CloudWatch アラームの状態を一目で把握し、詳細設定を確認できるページです。

<Screenshot src="/screenshots/monitoring/cloudwatch.png" alt="CloudWatch" />

## 主な機能

### アラーム状態サマリー
- **OK**: 正常状態のアラーム数 (緑)
- **ALARM**: トリガーされたアラーム数 (赤)
- **INSUFFICIENT_DATA**: データ不足のアラーム数 (グレー)

### 可視化
- **Alarm State Distribution**: 状態別アラーム比率の円グラフ (セマンティックカラー: OK 緑 · ALARM 赤 · INSUFFICIENT_DATA グレー)
- アラームテーブルはデフォルトで **worst-first**（ALARM → INSUFFICIENT_DATA → OK、最新の状態変更を優先）に並び、列ヘッダーのソートが優先されます
- **Alarms by Namespace**: ネームスペース別アラーム数の棒グラフ

### アラーム一覧
| カラム | 説明 |
|------|------|
| Alarm Name | アラーム名 |
| Namespace | AWS サービスのネームスペース (AWS/EC2, AWS/RDS など) |
| Metric | 監視対象メトリクス |
| State | 現在の状態 (OK, ALARM, INSUFFICIENT_DATA) |
| Reason | 状態変更の理由 |
| Actions | アクションの有効化有無 |

### アラーム詳細情報
アラーム行をクリックするとスライドパネルで詳細情報を確認できます:
- **Alarm**: 名前、ARN、状態、状態の理由
- **Configuration**: 比較演算子、しきい値、評価期間、統計
- **Actions**: アラーム/OK/データ不足時に実行されるアクション一覧 (SNS, Lambda など)

## 使い方

1. **状態フィルタリング**: 上部の StatsCard をクリックして該当状態のアラームのみフィルタリング
2. **ネームスペース確認**: 棒グラフでアラームの多いサービスを識別
3. **詳細表示**: アラーム行をクリックして設定とアクションを確認
4. **リフレッシュ**: 右上のボタンで最新状態を照会

:::tip アラーム状態の意味
- **OK**: メトリクスがしきい値以内
- **ALARM**: メトリクスがしきい値を超過/未達 (設定による)
- **INSUFFICIENT_DATA**: メトリクスデータ不足またはアラーム作成直後
:::

## 活用のヒント

### ALARM 状態の即時確認
上部の赤い「ALARM」StatsCard に「Active alarms!」の表示がある場合は、直ちに確認が必要です。

### アクション設定の確認
アラーム詳細で Actions Enabled が「No」の場合、アラームがトリガーされても通知は送信されません。SNS トピックや Lambda 関数が連携されているか確認してください。

### INSUFFICIENT_DATA の解決
- 新規作成されたアラーム: メトリクス収集まで待機 (最大 5〜10 分)
- 既存のアラーム: メトリクスソースを確認 (EC2 停止、Lambda 非アクティブなど)

:::info アラーム評価期間
アラームが ALARM 状態になるには、連続した評価期間 (Evaluation Periods) の間しきい値を超過する必要があります。例: Period 300s、Eval Periods 3 = 15 分間連続で超過した場合にアラーム。
:::

## AI 分析のヒント

AI アシスタントで Monitoring Gateway を活用した質問の例:

- 「ALARM 状態のアラームの共通原因を分析して」
- 「過去 24 時間のアラーム状態変化の履歴を見せて」
- 「このアラームのしきい値が適切か分析して」
- 「アラームアクションに Lambda の代わりに SNS を使うほうがいい?」

## 関連ページ

- [Monitoring Overview](../monitoring) - パフォーマンスメトリクス
- [CloudTrail](../monitoring/cloudtrail) - API アクティビティ監査
- [Cost Explorer](../monitoring/cost) - コスト分析
