---
sidebar_position: 7
title: データソース
description: 外部データソース連携の管理 (Prometheus, Loki, Tempo, ClickHouse, Jaeger, Dynatrace, Datadog)
---

import Screenshot from '@site/src/components/Screenshot';
import DatasourceFlow from '@site/src/components/diagrams/DatasourceFlow';
import DatasourceExploreFlow from '@site/src/components/diagrams/DatasourceExploreFlow';

# データソース

外部のモニタリングおよびオブザーバビリティシステムを AWSops に連携し、統合管理できる Grafana スタイルのデータソース管理ページです。

<Screenshot src="/screenshots/monitoring/datasources.png" alt="Datasources" />

## 概要

AWSops のデータソース機能は、外部オブザーバビリティプラットフォームを中央で管理します。データソースを登録すると、ダッシュボードでクエリを実行したり、AI アシスタントが分析に活用したりできます。

<DatasourceFlow />

主な特徴:
- **7 種のデータソース**をサポート (Prometheus, Loki, Tempo, ClickHouse, Jaeger, Dynatrace, Datadog)
- **CRUD 管理**: データソースの追加、修正、削除（管理者専用）
- **接続テスト**: ワンクリックでの接続確認と応答時間の測定
- **クエリ実行**: 各データソース固有のクエリ言語をサポート
- **セキュリティ**: SSRF 防止、資格情報のマスキング

## 対応データソース

| データソース | クエリ言語 | デフォルトポート | 主な機能 |
|-----------|----------|----------|----------|
| **Prometheus** | PromQL | 9090 | メトリクス収集、アラート、時系列データ |
| **Loki** | LogQL | 3100 | ログ集約、ラベルベースの検索 |
| **Tempo** | TraceQL | 3200 | 分散トレーシング、スパン検索 |
| **ClickHouse** | SQL | 8123 | カラム指向分析、大量データ処理 |
| **Jaeger** | Trace ID | 16686 | 分散トレーシング、サービス依存関係 |
| **Dynatrace** | DQL | 443 | フルスタックモニタリング、AI ベースの分析 |
| **Datadog** | Query | 443 | インフラモニタリング、APM、ログ |

## データソースの追加

:::info 管理者専用
データソースの作成、修正、削除には管理者ロールが必要です。管理者は `data/config.json` の `adminEmails` に登録されたユーザーです。非管理者はページ表示時に **Access Denied** 画面が表示されます。
:::

:::info マルチアカウントとは無関係
外部データソースの設定は**グローバル**です — サイドバーの AccountSelector を切り替えても影響しません。Prometheus/Loki などは AWS アカウントと 1:1 のマッピングではないため、すべてのアカウントユーザーが同じデータソース一覧を参照します（ただし、Departments の `datasourceIds` による制限がある場合はそれに従います）。
:::

### 設定フィールド

| フィールド | 必須 | 説明 |
|------|------|------|
| **Name** | O | データソースの識別名 |
| **Type** | O | データソースのタイプ（7 種から選択） |
| **URL** | O | エンドポイント URL（例: `http://prometheus:9090`） |
| **Authentication** | - | 認証方式 (None, Basic, Bearer Token, Custom Header) |
| **Timeout** | - | リクエストタイムアウト（デフォルト: 30 秒） |
| **Cache TTL** | - | キャッシュ有効時間（デフォルト: 5 分） |
| **Database** | - | データベース名（ClickHouse 専用） |

### 追加手順

1. **Datasources** ページで **Add Datasource** ボタンをクリック
2. データソースのタイプを選択
3. 名前、URL、認証情報を入力
4. **Test Connection** で接続を確認
5. **Save** で保存

## 接続テスト

**Test Connection** ボタンをクリックすると、データソースごとに以下を確認します：

| データソース | テストエンドポイント | 確認内容 |
|-----------|-----------------|----------|
| Prometheus | `/-/healthy` | サーバー状態、応答時間 |
| Loki | `/ready` | サーバー準備状態、応答時間 |
| Tempo | `/ready` | サーバー準備状態、応答時間 |
| ClickHouse | `SELECT 1` | クエリ実行の可否、応答時間 |
| Jaeger | `/api/services` | サービス一覧の取得、応答時間 |
| Dynatrace | `/api/v2/entities` | API アクセスの可否、応答時間 |
| Datadog | `/api/v1/validate` | API キーの有効性、応答時間 |

テスト結果には、接続の成功/失敗ステータスと応答遅延時間 (ms) が表示されます。

## クエリの実行

各データソース固有のクエリ言語を使用して、直接クエリを実行できます。

### PromQL (Prometheus)

```promql
rate(http_requests_total{job="api-server"}[5m])
```

CPU 使用率、リクエストレート、エラーレートなどのメトリクスデータを時系列で取得します。

### LogQL (Loki)

```logql
{namespace="production"} |= "error" | json | line_format "{{.message}}"
```

ラベルベースのログ検索とパイプラインフィルタリングをサポートします。

### TraceQL (Tempo)

```
{span.http.status_code >= 500 && resource.service.name = "api"}
```

分散トレースを条件ベースで検索します。

### ClickHouse SQL

```sql
SELECT toStartOfHour(timestamp) AS hour, count() AS events
FROM logs
WHERE timestamp > now() - INTERVAL 24 HOUR
GROUP BY hour
ORDER BY hour
```

大量データに対する高速な分析クエリを実行します。

### Jaeger

サービス名または Trace ID で分散トレースを検索します。

### Dynatrace (DQL)

```
fetch logs | filter contains(content, "error") | limit 100
```

### Datadog

メトリクスクエリまたはログ検索構文を使用します。

## 認証設定

データソース接続時に 4 種類の認証方式をサポートします：

| 認証方式 | 説明 | 使用例 |
|----------|------|----------|
| **None** | 認証なし | 内部ネットワークの Prometheus/Loki |
| **Basic** | ユーザー名/パスワード | ClickHouse、認証が設定された Prometheus |
| **Bearer Token** | API トークン | Dynatrace, Datadog, Tempo |
| **Custom Header** | ユーザー定義ヘッダー | カスタムプロキシ、API ゲートウェイ |

:::tip 資格情報のマスキング
保存されたパスワードとトークンは UI でマスキング処理されます。修正時にのみ新しい値を入力できます。
:::

## セキュリティ

### SSRF 防止

データソースの URL に対して以下のセキュリティ検査が適用されます：

- **プライベート IP のブロック**: `10.x.x.x`、`172.16-31.x.x`、`192.168.x.x`、`127.0.0.1` などの内部 IP をブロック
- **メタデータエンドポイントのブロック**: `169.254.169.254`（EC2 インスタンスメタデータ）へのアクセスをブロック
- **リンクローカルアドレスのブロック**: `169.254.x.x` 帯域をブロック
- **プロトコル制限**: `http://` と `https://` のみ許可

:::caution SSRF 保護
外部データソースの URL はサーバーからリクエストを送信するため、SSRF（Server-Side Request Forgery）攻撃を防止する目的で内部ネットワークへのアクセスがブロックされます。
:::

### ClickHouse SQL インジェクション防止

ClickHouse のクエリ実行時に、危険な SQL 構文（DROP、ALTER、INSERT、UPDATE、DELETE、TRUNCATE など）がブロックされます。読み取り専用クエリ (SELECT) のみ許可されます。

## AI 連携

AI アシスタントは、登録されたデータソースを活用して分析を実行できます。

### 使用例

- 「Prometheus で過去 1 時間の CPU 使用率の推移を見せて」
- 「Loki で production ネームスペースのエラーログを検索して」
- 「ClickHouse で今日のイベント数を時間帯別に集計して」

### 動作方式

1. AI アシスタントが質問を分析して適切なデータソースを選択
2. データソースのタイプに合ったクエリを自動生成
3. クエリ結果をもとに分析とインサイトを提供

:::tip datasource ルート連携
データソース関連の質問は `datasource` ルートを通じて処理されます。AI が Steampipe データと外部データソースを併せて分析できます。
:::

## 設定リファレンス

### 共通設定

| 設定 | デフォルト値 | 説明 |
|------|--------|------|
| **timeout** | 30 秒 | リクエストタイムアウト（最大 120 秒） |
| **cacheTTL** | 300 秒（5 分） | クエリ結果キャッシュの有効時間 |

### ClickHouse 専用

| 設定 | デフォルト値 | 説明 |
|------|--------|------|
| **database** | `default` | 対象データベース名 |

### 制限事項

- 最大登録可能データソース数: 制限なし
- クエリ結果の最大行数: 1,000 行
- ClickHouse: SELECT クエリのみ許可（DDL/DML はブロック）
- URL: プライベート IP およびメタデータエンドポイントをブロック

## Explore ページ

Explore ページでは、登録されたデータソースに直接クエリを実行し、結果を可視化できます。AI クエリ生成とマルチシリーズチャートをサポートします。

<DatasourceExploreFlow />

### 主な機能

- **データソース選択ドロップダウン**: 登録されたすべてのデータソースからクエリ対象を選択します。
- **時間範囲プリセット**: 15m、1h、6h、24h、7d、30d から選択して照会期間を指定します。
- **ネイティブクエリエディタ**: データソースタイプ別の構文ハイライトが適用されたクエリエディタを提供します（PromQL、LogQL、SQL など）。
- **サンプルクエリチップ**: データソースタイプ別によく使われるクエリをワンクリックで入力できます。
- **結果メタデータ**: クエリ実行後、行数、実行時間 (ms)、クエリ言語が上部に表示されます。

### AI クエリ生成

**AI Assist** トグルを有効にすると、自然言語でクエリを作成できます。Bedrock Sonnet がデータソースタイプに合ったクエリを自動生成し、説明バナーを表示します。

**データソースタイプ別のサンプルプロンプト:**

| データソース | サンプルプロンプト |
|-----------|-------------|
| Prometheus | 「過去 1 時間の CPU 使用率上位 5 個の Pod」 |
| Loki | 「production ネームスペースで error レベルのログを検索」 |
| ClickHouse | 「今日の時間帯別イベント数を集計」 |
| Tempo | 「500 エラーが発生したトレースを検索」 |

**使用方法:**

1. AI Assist トグルを ON に切り替え
2. 自然言語で欲しいデータを説明
3. **Ctrl+Enter** または実行ボタンをクリック
4. Bedrock Sonnet が PromQL/LogQL/SQL クエリを生成
5. 生成されたクエリとともに説明バナーが表示される

:::tip AI Assist のショートカット
**Ctrl+Enter** ですばやくクエリを生成・実行できます。
:::

### マルチシリーズチャート

Prometheus データソースで最大 **8 個のシリーズ**を同時に可視化できます。

- **Line/Bar チャートのトグル**: データの特性に合ったチャートタイプを選択します。
- **カスタムカラーパレット**: 各シリーズに固有の色が自動割り当てされ、8 種のテーマカラーを使用します。
- **シリーズ数インジケーター**: チャート下部に現在レンダリング中のシリーズ数が表示されます。

:::info シリーズ制限
パフォーマンスのため、Prometheus のマルチシリーズチャートは最大 8 シリーズに制限されます。8 個を超える結果は上位 8 個のみ表示されます。
:::

## AIで診断

Datasources管理タブでは、各kindの**default**データソース行に**AIで診断**リンクが表示されます
(対応kind: Prometheus・ClickHouse・Loki・Mimir・Tempo)。クリックするとAIアシスタントに移動し、
セクション固定の診断プロンプトが入力欄に事前入力されます(Prometheus/ClickHouse → `/observability`、
Loki/Mimir/Tempo → `/monitoring`)。**自動送信はされません** — 内容を確認して送信すると新しい会話として
開始されます。エージェントは該当コネクタのクエリ/スキーマツールでデータソースの応答状態を確認します。

## Explore 機能まとめ

- kindごとの**サンプルクエリ・自然言語プロンプトチップ**(8 kind)
- **7d/30d 期間プリセット**(Prometheus/Mimir は30d、Lokiは7d — kind別上限)
- 結果**メタデータバー**(行/シリーズ数・往復ms・クエリ言語・形態)
- **Loki専用ログビューア**(新しい順・ラベルバッジ)、Tempo/Jaeger **durationバー**
- AI生成クエリの**出所バナー**、管理タブの**KPIタイル・更新ボタン**


## Allowed Networks

管理者は、SSRF 防止でブロックされるプライベートネットワークに対して、例外の許可リストを設定できます。

:::info 管理者専用
Allowed Networks の設定には管理者ロールが必要です。
:::

### 対応パターン

| パターンタイプ | 例 | 説明 |
|----------|------|------|
| **CIDR** | `10.0.0.0/16` | 特定のサブネット帯域を許可 |
| **単一 IP** | `10.0.1.50` | 特定の IP アドレスを許可 |
| **ホスト名** | `prometheus.internal` | 特定の内部ホスト名を許可 |

### SSRF 防止との関係

デフォルトでは、プライベート IP 帯域（`10.x.x.x`、`172.16-31.x.x`、`192.168.x.x`）は SSRF 防止のためにブロックされます。Allowed Networks に登録されたアドレスはこのブロックルールの例外として処理され、内部ネットワークに配置されたデータソースにも安全にアクセスできます。

:::caution セキュリティ上の注意
Allowed Networks に過度に広い CIDR 帯域を追加すると、SSRF 保護が弱まる可能性があります。必要な最小範囲のみ登録してください。
:::

### API エンドポイント
```bash
# 現在の許可リストの取得 (admin 専用)
curl '/awsops/api/datasources?action=allowlist'

# 許可リストの更新
curl -X POST '/awsops/api/datasources' \
  -H 'Content-Type: application/json' \
  -d '{"action":"update-allowlist","networks":["10.0.0.0/16","prometheus.internal"]}'

# 接続テスト
curl -X POST '/awsops/api/datasources' \
  -H 'Content-Type: application/json' \
  -d '{"action":"test-connection","datasourceId":"<id>"}'
```

## AI エージェント連携

登録されたデータソースは AI アシスタント (`/ai`) で自動的に活用されます。質問にデータソースのキーワードが含まれると、AI が自動でクエリを生成して実行します。

### 単一データソースクエリ

```
"Prometheus で CPU 使用量を確認して"
→ datasource ルート → PromQL 自動生成 → 結果分析
```

### マルチデータソース相関分析

複数のデータソースを同時に照会して相関分析ができます：

```
"Prometheus のメトリクスと Loki のエラーログを相関分析して"
→ Prometheus PromQL + Loki LogQL 並列実行 → 総合分析
```

### AWS リソースとのクロス分析

データソースクエリと AWS リソースを併せて分析し、根本原因を特定できます：

```
"Prometheus の CPU スパイクと CloudWatch アラームを比較して"
→ datasource + monitoring マルチルート → クロス相関分析
```

:::tip AI キーワード
AI アシスタントが認識するキーワード: **プロメテウス/prometheus**、**ロキ/loki**、**テンポ/tempo**、**クリックハウス/clickhouse**、**イェーガー/jaeger**、**ダイナトレース/dynatrace**、**データドッグ/datadog**
:::

## 関連ページ

- [モニタリングダッシュボード](./monitoring.md) - システムモニタリングの現況
- [CloudWatch](./cloudwatch) - AWS CloudWatch メトリクス
- [AI アシスタント](../overview/ai-assistant) - AI 分析機能
