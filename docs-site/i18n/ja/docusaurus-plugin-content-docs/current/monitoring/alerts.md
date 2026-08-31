---
sidebar_position: 9
title: アラートパイプライン
description: CloudWatch / Alertmanager / Grafana Webhook 受信、アラート相関分析、自動 AI 診断、Slack 通知
---

# アラートパイプライン

:::caution レガシーページ（v1 基準）
このページは v1 時代のアラートパイプライン（アラート連動診断が 15 セクション固定カタログから
セクションを選択する構造・`src/` パス）を基準に書かれています。現行 v2 の診断は **Light / Mid /
Deep（15+1 セクション、計 16 レンダー）** のティア構造です — 最新の動作は
[FAQ · AI アシスタント](../faq/ai-assistant.md)を参照してください。
:::


外部アラートシステムのイベントを AWSops で受信し、**相関分析 → 自動 AI 診断 → Slack 通知**まで一括で処理するパイプラインです。

## 対応ソース

| ソース | 受信方式 | 正規化 |
|------|----------|--------|
| **CloudWatch Alarms** | SNS → SQS → EC2 ポーリング | CloudWatch イベントスキーマ |
| **Prometheus Alertmanager** | 直接 Webhook (HMAC) | Alertmanager v4 スキーマ |
| **Grafana Alerting** | 直接 Webhook (HMAC) | Grafana unified alerting |
| **Generic JSON** | 直接 Webhook (HMAC) | カスタムスキーママッピング |

## 構成概要

```
[CloudWatch Alarm] → SNS Topic → SQS Queue
                                    ↓
                            [EC2 Poller (15s)]
                                    ↓
[Alertmanager/Grafana/Generic] → POST /awsops/api/alert-webhook
                                    ↓
                            [alert-correlation.ts]
                                    ↓
                         [alert-diagnosis.ts (AI)]
                                    ↓
                          [Slack/SNS 発送]
```

詳細な設定手順はサーバー側の[ランブック](https://github.com/Atom-oh/awsops/tree/main/docs/runbooks/alert-pipeline-troubleshoot.md)にあります。

## Webhook エンドポイント

### POST /awsops/api/alert-webhook

| パラメータ | 位置 | 説明 |
|---------|------|------|
| `X-Alert-Source` | Header | `cloudwatch`, `alertmanager`, `grafana`, `generic` |
| `X-Signature-256` | Header | HMAC-SHA256 署名（共有シークレット） |
| Body | JSON | ソース別の元ペイロード |

### HMAC 署名

共有シークレットは `data/config.json` の `alertWebhookSecret` に保存します。送信側は raw body を HMAC-SHA256 で署名し、`X-Signature-256: sha256=<hex>` ヘッダーとして送信する必要があります。

```bash
# Alertmanager webhook_configs の例
- url: https://awsops.example.com/awsops/api/alert-webhook
  http_config:
    authorization:
      type: HMAC
      credentials: "<共有シークレット>"
```

### GET /awsops/api/alert-webhook

アクティブなインシデント一覧を取得します。ダッシュボード上部の 🚨 バッジおよびホーム画面の「Recent Incidents」カードがこの API を 30 秒周期でポーリングします。

```json
{
  "activeCounts": { "total": 3, "critical": 1, "warning": 2 },
  "activeIncidents": [
    {
      "id": "inc-20260422-093015",
      "severity": "critical",
      "status": "investigating",
      "alertCount": 7,
      "affectedServices": ["payment-api", "order-service"],
      "topAlertName": "HTTPErrorRateHigh"
    }
  ]
}
```

## 相関分析エンジン

`src/lib/alert-correlation.ts` が以下の基準で個別アラートを**インシデント**にグループ化します：

| 基準 | デフォルト値 | 説明 |
|------|--------|------|
| **時間ウィンドウ** | 5 分 | 同一サービスで 5 分以内に発生したアラートをマージ |
| **共通サービス** | 1 件以上 | `labels.service` または `resource` が一致 |
| **共通ネームスペース** | 1 件以上 | K8s アラートの `labels.namespace` が一致 |
| **重複排除** | 1 分 | 同一 `fingerprint` のアラートを 1 分以内は重複抑制 |
| **重大度エスカレーション** | `warning` → `critical` | warning 3 件が 5 分以内 → critical に昇格 |

## 自動 AI 診断

重大度 `critical` のインシデントは自動的に部分 AI 診断をトリガーします：

1. **AlertContext のビルド**: 影響を受けたサービス、リソース、ネームスペース、発火時刻（since）を抽出
2. **スコープ限定の収集**: CloudWatch メトリクスクエリを `since` 基準の ±10 分、該当リソースのみにフィルタリング
3. **関連セクションの選択**: 15 セクションのうち Compute / Network / Container など 3〜5 個のみ実行
4. **変更検知**: Terraform state / CloudTrail の最近の変更と比較
5. **Bedrock 分析**: Claude Sonnet で根本原因の推定 + Next Steps の提案

:::tip フル診断との違い
[AI 総合診断](./ai-diagnosis.md)は 15 セクション全体を全リソース対象で実行しますが、Alert-Triggered Diagnosis は**発火したアラートの範囲のみ**に限定され、1〜2 分以内に完了します。
:::

## Slack 通知

### Block Kit メッセージ

重大度に応じて以下のチャンネルにルーティングされます（`data/config.json` の `slackChannels`）：

| 重大度 | デフォルトチャンネル | 色 |
|-------|---------|------|
| `critical` | `#incidents` | 赤 |
| `warning` | `#alerts` | オレンジ |
| `info` | `#alerts-low` | 青 |

### スレッド更新

インシデントの最初の通知は**メインメッセージ**として、後続イベント（追加アラートのマージ、AI 診断結果、解決通知）は**同一スレッドへの reply** として投稿されます。Slack Webhook モードと Bot Token モードの両方で動作します。

### 解決通知

CloudWatch の `OK` 状態または Alertmanager の `resolved` イベントを受信すると、元のスレッドに ✅ 解決通知を追加します。

## アラートナレッジベース

`data/alert-diagnosis/` の下に診断記録が永続保存されます：

| ファイル | 内容 |
|------|------|
| `incidents/<id>.json` | 個別インシデント + AI 診断結果 |
| `summary-<YYYY-MM>.json` | 月間統計（top services、alert names、resolution time） |

UI の **Knowledge Base** タブで過去の類似インシデントを検索でき、新しいインシデント発生時には類似度ベースで自動推薦されます。

## アラートノイズ制御

### Silence ウィンドウ
特定のラベル組み合わせを一定時間抑制できます：

```json
{
  "silences": [
    {
      "matcher": { "service": "batch-job", "alertname": "HighCPU" },
      "startsAt": "2026-04-22T00:00:00Z",
      "endsAt":   "2026-04-22T06:00:00Z",
      "reason": "夜間バッチウィンドウ"
    }
  ]
}
```

### 重複抑制
同一 `fingerprint` + 1 分以内 → 自動的に無視。

## 使用のヒント

### テストイベントの送信
```bash
curl -X POST https://awsops.example.com/awsops/api/alert-webhook \
  -H 'X-Alert-Source: generic' \
  -H "X-Signature-256: sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $2}')" \
  -H 'Content-Type: application/json' \
  -d "$BODY"
```

### アクティブなインシデントの確認
ダッシュボードヘッダーの 🚨 バッジをクリックすると `/ai-diagnosis` ページへ移動し、進行中のインシデントの詳細ビューを確認できます。

### 通知が届かないとき
サーバー側ランブック [alert-pipeline-troubleshoot.md](https://github.com/Atom-oh/awsops/tree/main/docs/runbooks/alert-pipeline-troubleshoot.md) に症状別のチェックリストがあります。

## 関連ページ

- [AI 総合診断](./ai-diagnosis.md) — 15 セクションのフル診断
- [CloudWatch](./cloudwatch) — アラームのソース
- [外部データソース](./datasources) — Alertmanager/Grafana クエリの源泉

## 参考

- ADR-009: アラートトリガー AI 診断
- ADR-012: SNS 通知戦略
- ADR-013: 自動収集調査エージェント
