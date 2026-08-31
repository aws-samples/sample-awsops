---
sidebar_position: 9
title: アラートパイプライン設定
description: Webhook 受信 + HMAC 認証 + 相関分析 + AI 自動診断 + Slack 通知の設定（admin 専用）
---

import Screenshot from '@site/src/components/Screenshot';

# アラートパイプライン設定 (Alert Settings)

`/alert-settings` ページは、アラート Webhook の受信から AI 診断の自動トリガー、Slack 通知の送信までのパイプライン全体を 1 か所で構成します。**admin 専用**ページで、`data/config.json` の `adminEmails` チェック後にアクセスできます。

<Screenshot src="/screenshots/overview/alert-settings.png" alt="アラートパイプライン設定（Access Denied 画面 — admin 専用）" />

:::caution Admin 専用
admin 以外のユーザーには上のスクリーンショットのように **Access Denied** 画面が表示されます。admin ユーザーの画面については本ドキュメントのテキスト説明を参照してください。
:::

## パイプライン全体の流れ

```
[External]                       [AWSops]
CloudWatch SNS  ─┐
Alertmanager    ─┤              ┌─→ Correlation ─→ Diagnosis ─→ Slack
Grafana         ─┼─→ Webhook ───┤                  (Bedrock      (Block Kit)
SQS poller      ─┤    + HMAC    ├─→ Knowledge      Opus)
Generic JSON    ─┘              │   Base
                                └─→ Stats
```

## ページ構成

### 1. Master Toggle
パイプライン全体の有効/無効。無効の場合、Webhook は受信しますが診断はトリガーしません。

### 2. Alert Sources（5 種）

| ソース | ラベル | ペイロード正規化 | 認証 |
|------|------|----------------|------|
| `cloudwatch` | CloudWatch Alarm (SNS) | `normalizeCloudWatchAlarm()` | SNS subscription の確認 |
| `alertmanager` | Prometheus Alertmanager | `normalizeAlertmanager()` | HMAC-SHA256 シークレット |
| `grafana` | Grafana Alerting | `normalizeGrafana()` | HMAC-SHA256 シークレット |
| `sqs` | AWS SQS Queue | SNS→SQS メッセージ本文 | IAM (SQS ポーラー) |
| `generic` | Generic Webhook | `normalizeGeneric()` | HMAC-SHA256 シークレット |

各ソースごとに以下を設定します：
- **Enabled** トグル
- **Secret** — HMAC 署名検証用（ローテーション時は active+standby の 2 つを保管）
- **(SQS only)** Queue URL + Region

### 3. Webhook URL
ページ上部に以下の形式の URL が表示されます（コピー用）：

```
https://<your-host>/awsops/api/alert-webhook?source=alertmanager
```

送信側では同じシークレットで HMAC を計算し、`X-AWSops-Signature` ヘッダーに添付する必要があります。

### 4. Diagnosis Config (Advanced)

| フィールド | デフォルト値 | 説明 |
|------|--------|------|
| `correlationWindowSeconds` | 30 | 同一アラートのグループ化時間ウィンドウ |
| `deduplicationWindowMinutes` | 15 | 同一 incident の重複を無視する時間ウィンドウ |
| `cooldownMinutes` | 5 | 同じリソースの再診断の最小間隔 |
| `maxConcurrentInvestigations` | 3 | 同時 Bedrock 呼び出しの上限（コスト制御） |
| `investigationTimeoutSeconds` | 120 | Bedrock レスポンスのタイムアウト |
| `includeChangeDetection` | true | git/CloudTrail の最近の変更を自動で含める |
| `knowledgeBaseEnabled` | true | 過去の類似事例を検索して添付 |
| `minimumSeverity` | `warning` | 自動診断をトリガーする最小重大度 |

`minimumSeverity = critical` に設定すると、critical のみ AI 診断が自動実行されます（コスト最適化）。

### 5. Slack 設定

| フィールド | 説明 |
|------|------|
| `enabled` | Slack 送信のマスタートグル |
| `method` | `bot` (Bot Token) / `webhook` (Incoming Webhook) |
| `botToken` | Slack Bot Token (`xoxb-...`) |
| `webhookUrl` | Webhook URL（`method=webhook` の場合） |
| `defaultChannel` | `#ops-alerts` などのフォールバックチャンネル |
| `channelMapping` | 重大度別のチャンネルルーティング |
| `threadUpdates` | 同じ incident の後続通知をスレッドにまとめる |

**デフォルトのチャンネルマッピング:**
```
critical → #ops-critical
warning  → #ops-alerts
info     → #ops-general
```

**Test Slack** ボタンでダミーメッセージを送信し、接続確認ができます。

### 6. Diagnosis History
下部の診断履歴セクションには以下が表示されます：

- 最近の incident 一覧（incidentId、timestamp、alertNames、rootCause、confidence）
- 統計: 総 incident 数、重大度別分布、カテゴリ別分布、Top アラート名、平均処理時間
- 各行を展開すると Bedrock 診断のマークダウン全文を確認可能

## 相関分析の動作方式

`alert-correlation.ts` が以下の基準でアラートをグループ化します：

1. **時間ベース** — `correlationWindowSeconds`（デフォルト 30s）以内に到着したアラート
2. **サービスベース** — `service` ラベルが同じアラート（例: `eks`, `rds`）
3. **リソースベース** — `resourceArn`/`namespace`/`instanceId` が同じアラート
4. **重大度エスカレーション** — 同じグループで `warning` が累積すると `critical` に昇格
5. **重複排除** — `deduplicationWindowMinutes`（デフォルト 15m）以内の同一シグネチャは単一の incident に統合

グループ化された incident が `minimumSeverity` 以上であれば `alert-diagnosis.ts` が自動トリガーされます。

## AI 診断の流れ

1. 影響を受けたサービス/リソース/ネームスペースに診断スコープを限定
2. コレクター（`src/lib/collectors/*.ts`）と外部データソース（Prometheus、Loki など）を並列呼び出し
3. 変更検知（`includeChangeDetection`）が有効なら最近の git コミット・CloudTrail イベントを添付
4. ナレッジベース（`knowledgeBaseEnabled`）から類似事例 5 件を検索してコンテキストとして添付
5. Bedrock Claude Opus で分析 → マークダウンレスポンス + 根拠メタデータ
6. Slack に Block Kit カードを送信（スレッド更新が有効なら reply として）

## HMAC シークレットのローテーション

1. 新しいシークレットを **Standby** スロットに入力して保存
2. 送信側を新しいシークレットに切り替え（両方のシークレットが有効）
3. 送信側の切り替え完了後、ページの **Promote** ボタンで standby → active に昇格
4. 旧シークレットを廃棄

このフローは、無停止でシークレットを交換するための active+standby 2 キーポリシーです。

## API

```bash
# 設定の取得
curl '/awsops/api/steampipe?action=config'

# admin の確認
curl '/awsops/api/steampipe?action=admin-check'

# 診断履歴
curl '/awsops/api/alert-webhook'

# Slack テストメッセージ
curl -X POST '/awsops/api/notification' \
  -H 'Content-Type: application/json' \
  -d '{"action":"test","channel":"#ops-alerts"}'

# ダミーアラートの送信 (テスト用)
curl -X POST '/awsops/api/alert-webhook?source=generic' \
  -H 'X-AWSops-Signature: <hmac>' \
  -H 'Content-Type: application/json' \
  -d '{"source":"manual","title":"Test alert","severity":"warning","message":"Hello"}'
```

## トラブルシューティング

| 症状 | 原因 | 解決策 |
|------|------|------|
| 401 Unauthorized | HMAC 検証の失敗 | シークレットの同期を確認、ヘッダー名は `X-AWSops-Signature` |
| 診断がトリガーされない | severity が minimum 未満 | `minimumSeverity` を下げるか、アラート severity のマッピングを確認 |
| Slack メッセージが届かない | Bot Token の権限不足 | OAuth scope に `chat:write`、`chat:write.public` を追加 |
| Bedrock タイムアウト | `investigationTimeoutSeconds` が短い | 120 秒 → 180 秒に引き上げ、データソースの応答時間を確認 |
| 重複アラートの殺到 | `deduplicationWindowMinutes` が短い | 15 分 → 30 分に引き上げ、同じ source の cooldown を別途設定 |

## 関連ページ

- [AI 総合診断](./ai-diagnosis) — alert-triggered 部分診断のベース
- [External Datasources](./datasources) — 診断時に並列呼び出しされる外部データ
- [Monitoring](./monitoring.md) — アラームのソース（CloudWatch metrics 画面）
- [AgentCore](../overview/agentcore) — 診断を実行する AI Runtime

## 参考

- ADR-022: アラート相関分析ポリシー
- ADR-026: HMAC シークレット active+standby 2 キーポリシー
- `src/lib/alert-types.ts` — 5 種のソース正規化ロジック
- `src/lib/alert-correlation.ts` — グループ化/重複排除/エスカレーション
- `src/lib/alert-diagnosis.ts` — Bedrock 診断オーケストレーション
- `src/lib/slack-notification.ts` — Block Kit メッセージ + チャンネルルーティング
