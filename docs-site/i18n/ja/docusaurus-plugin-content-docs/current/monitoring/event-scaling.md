---
sidebar_position: 10
title: イベント事前スケーリング
description: ADR-010 Phase 1+2 — トラフィックイベント登録、過去メトリクス分析、AI ベースのウォームアップスクリプト生成
---

import Screenshot from '@site/src/components/Screenshot';

# イベント事前スケーリング (Event Pre-Scaling)

`/event-scaling` ページは、今後のトラフィックイベント（ブラックフライデー、チケット販売開始、ライブ配信など）に備えた **AI ベースの事前ウォームアップ計画**を生成します。ADR-010 Phase 1+2 の実装であり、**計画生成 + スクリプトのエクスポートまでのみ**を実行し、**実行はオペレーターが手動レビュー後に直接実行**します。

<Screenshot src="/screenshots/overview/event-scaling.png" alt="イベント事前スケーリングページ" />

## 概要

| 項目 | 値 |
|------|---|
| **モデル** | Bedrock Claude Sonnet 4.6 (`global.anthropic.claude-sonnet-4-6-v1`) |
| **権限** | admin 専用 — `data/config.json` の `adminEmails` |
| **ステートマシン** | planned → analyzing → plan-ready → approved / cancelled |
| **実行** | **なし** — bash スクリプトとして export し、人が直接実行 |
| **保存場所** | `data/event-scaling/<eventId>.json` |
| **対応リソース** | KEDA、HPA、Aurora replica/ACU、MSK broker/partition、ASG、EC2、EBS IOPS、ALB |

:::caution Phase 2 の制限
生成されたスクリプトは**人によるレビュー用**です。AWSops はインフラ変更（KEDA デプロイ、AWS API 呼び出し）を直接実行しません。自動実行 + IAM 拡張 + KEDA 統合は ADR-029 Phase 3 ゲート（Proposed）で別途扱います。
:::

## ワークフロー

```
[New Event] → [Save] → [Analyze] → [Review Plan] → [Approve | Cancel]
              POST     POST        UI 展開          POST approve / DELETE
              create   analyze
                       ├ metrics  fetch
                       └ bedrock  generate
```

### 1. イベント登録 (`planned`)
**+ New Event** ボタンで以下のフィールドを入力します：

| フィールド | 説明 |
|------|------|
| Event Name | 識別用ラベル（例: "Black Friday 2026"） |
| Description | 自由テキストのメモ |
| Event Start / End | KST 時刻 (ISO 8601) — ピークウィンドウ |
| Pattern Type | `flash-sale`, `sustained-peak`, `gradual-ramp`, `ticket-drop` |
| Expected Peak Multiplier | 平常時比の倍率（例: `10` = 10 倍） |
| Duration Minutes | ピークの継続時間 |
| Ramp-Up Minutes | 事前ウォームアップウィンドウ |
| Custom Metrics | CloudWatch metric 名のカンマ区切り（任意） |
| Reference Event | 過去の類似イベント名 + 日時（メトリクス取得の基準） |
| Target Account | マルチアカウント時の限定 |

### 2. メトリクス収集 + 分析 (`analyzing` → `plan-ready`)
**Analyze** ボタンを押すと以下が順次実行されます：

1. Reference Event 時点の ±60 分ウィンドウ（デフォルト）で CloudWatch メトリクスを収集 → `MetricsSnapshot`
2. Steampipe で現在のリソース状態スナップショットを取得
3. 2 つのデータセットを Bedrock Sonnet 4.6 に送信 → 多段階ウォームアッププランを生成
4. レスポンス末尾の `PLAN_JSON: { ... }` マーカーをパースして構造化された `ScalingPlan` を抽出

所要時間: 通常 30〜90 秒。

### 3. プランのレビュー + 承認 (`plan-ready` → `approved`)
右側パネルが展開され、以下が表示されます：

- **フェーズ (Phase)** — T-4h、T-30m など時点別にグループ化
- **ターゲット (ScalingTarget)** — リソースタイプ、現在値 → 目標値、単位、理由
- **スクリプト** — bash/kubectl コード（フェーズ別ダウンロードまたは全体 ZIP）
- **予想追加コスト** — USD（モデルが推定した値）
- **モデルメタ情報** — modelId、input/output トークン
- **Raw analysis** — Bedrock マークダウンの原文（監査目的）

**Approve** ボタンは実行ではなく**「レビュー完了」のマーキング**です。`approvedBy` + `approvedAt` が記録されます。

### 4. キャンセル / 削除
- **Cancel** — 状態のみ `cancelled` に変更（記録は保持）
- **Cancel (hard)** — `?hard=true` フラグで JSON ファイルを削除

## 対応リソースタイプ

| Type | スクリプト生成器 (`event-scaling-scripts.ts`) | 説明 |
|------|------|------|
| `keda` | `kubectl scale` + ScaledObject パッチ | EKS ワークロードの事前スケール |
| `hpa` | `kubectl patch hpa` | minReplicas/maxReplicas の調整 |
| `aurora-replica` | AWS CLI `modify-db-cluster` | リーダーノード数の増加 |
| `aurora-acu` | AWS CLI `modify-db-cluster` | Serverless v2 ACU 上限 |
| `msk-broker` | AWS CLI `update-broker-count` | MSK ブローカーの追加 |
| `msk-partition` | `kafka-topics.sh --alter` | トピックパーティションの増加 |
| `asg` | AWS CLI `update-auto-scaling-group` | Desired/Max の調整 |
| `ec2` | AWS CLI `run-instances` | 追加インスタンスの事前起動 |
| `ebs-iops` | AWS CLI `modify-volume` | gp3 IOPS/throughput の増加 |
| `alb-capacity` | （メモのみ） | ALB 自動スケールの事前ウォームアップ |

すべてのスクリプトは**レビュー後の手動実行**用です — `set -euo pipefail` + `--dry-run` コメント付き。

## API

```bash
# 一覧
curl '/awsops/api/event-scaling?action=list&accountId=111111111111'

# 単一の詳細
curl '/awsops/api/event-scaling?action=detail&id=<eventId>'

# 登録
curl -X POST '/awsops/api/event-scaling?action=create' \
  -H 'Content-Type: application/json' \
  -d '{"name":"BF2026","eventStart":"2026-11-27T13:00:00+09:00","eventEnd":"2026-11-27T18:00:00+09:00","pattern":{"type":"flash-sale","expectedPeakMultiplier":10,"durationMinutes":120,"rampUpMinutes":60}}'

# メトリクス + 分析
curl -X POST '/awsops/api/event-scaling?action=analyze&id=<eventId>'

# 承認のマーキング
curl -X POST '/awsops/api/event-scaling?action=approve&id=<eventId>'

# スクリプトのダウンロード (text/x-shellscript)
curl '/awsops/api/event-scaling?action=script&id=<eventId>' -o warmup.sh

# キャンセル
curl -X DELETE '/awsops/api/event-scaling?id=<eventId>'
```

## パターンガイド

| パターン | 使用例 | 推奨 ramp-up |
|------|---------|-------------|
| `flash-sale` | ブラックフライデー、EC サイトのセール開始 | 30〜60 分 |
| `sustained-peak` | ライブストリーミング、カンファレンス | 60〜120 分 |
| `gradual-ramp` | マーケティングキャンペーン、ニュースレター配信 | 120〜240 分 |
| `ticket-drop` | コンサートチケット販売開始、限定版リリース | 15〜30 分 |

## トラブルシューティング

| 症状 | 原因 | 解決策 |
|------|------|------|
| Reference Event のメトリクスが空 | 該当時点にリソースが存在しなかったか IAM 不足 | EC2 インスタンスプロファイルに `cloudwatch:GetMetricStatistics` を確認 |
| `PLAN_JSON` のパース失敗 | Bedrock レスポンスが途切れた (max tokens) | `eventScalingMaxTokens` config を引き上げ、フェーズ数を減らす |
| Approve 後に自動実行されない | Phase 2 の意図された動作 | スクリプトを export 後に手動実行（Phase 3 で変更予定） |
| マルチアカウントで分離されない | `accountId` の欠落 | 登録時に Target Account を指定 |

## 関連ページ

- [Resource Inventory](./inventory) — 事前のリソース状況の把握
- [Monitoring](./monitoring.md) — 平常時メトリクスの確認
- [Cost Explorer](./cost) — 事前スケーリングのコスト影響の検証
- [AI 総合診断](./ai-diagnosis) — イベント後の振り返りレポート

## 参考

- **ADR-010 Phase 1+2** — イベント登録 + AI プラン生成（現在の実装）
- **ADR-029** — Phase 3 mutating action ゲート (Proposed)
- `src/lib/event-scaling.ts` — データモデル + JSON 永続化
- `src/lib/event-scaling-prompts.ts` — Bedrock プロンプト + `PLAN_JSON` マーカーのパース
- `src/lib/event-scaling-scripts.ts` — リソース別の安全な bash スクリプト生成
