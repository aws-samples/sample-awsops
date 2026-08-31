---
sidebar_position: 2
title: AI アシスタント
description: AWSops AI アシスタント詳細ガイド - 11 段階ルーティングと高度な機能
---

import Screenshot from '@site/src/components/Screenshot';
import AIStreamingFlow from '@site/src/components/diagrams/AIStreamingFlow';

# AI アシスタント

AI アシスタントは、Amazon Bedrock AgentCore をベースに、自然言語で AWS インフラを分析・管理できる機能です。

<Screenshot src="/screenshots/overview/ai-assistant.png" alt="AI アシスタント" />

## アーキテクチャ

![AI 意図分類フロー](/diagrams/ai-routing.png)

## 11 段階ルーティング

AI アシスタントは質問を分析し、最も適したルートに自動分類します。優先順位: `code` → `network` → `container` → `iac` → `data` → `security` → `monitoring` → `cost` → `datasource` → `aws-data` → `general`。

内部的には追加の分類ルートも存在します:
- `datasource-diag` — データソース接続診断（6 段階自動診断）
- `incident` — アラートベースの部分診断（alert-correlation から呼び出し）

### ルーティングテーブル

| 優先順位 | ルート | Gateway | ツール数 | 説明 |
|---------|--------|---------|--------|------|
| 1 | **code** | - | - | Python コード実行、計算、可視化 |
| 2 | **network** | Network | 17 | VPC、TGW、VPN、Flow Logs、Reachability |
| 3 | **container** | Container | 24 | EKS、ECS、Istio トラブルシューティング |
| 4 | **iac** | IaC | 12 | CDK、CloudFormation、Terraform |
| 5 | **data** | Data | 24 | DynamoDB、RDS、ElastiCache、MSK |
| 6 | **security** | Security | 14 | IAM、ポリシーシミュレーション、セキュリティ要約 |
| 7 | **monitoring** | Monitoring | 16 | CloudWatch、CloudTrail |
| 8 | **cost** | Cost | 9 | コスト分析、予測、予算 |
| 9 | **datasource** | - | 7 DS | 外部オブザーバビリティ（Prometheus/Loki/Tempo/ClickHouse/Jaeger/Dynatrace/Datadog）— 自然言語 → クエリ |
| 10 | **aws-data** | Ops | SQL | リソースの一覧/状況（Steampipe SQL） |
| 11 | **general** | Ops | 9 | 一般的な AWS の質問、ドキュメント検索 |

### ルート別詳細

#### 1. code - Code Interpreter

Python コードの実行が必要な場合に使用されます。

**質問例:**
- 「AWS のコストデータをチャートで可視化して」
- 「ランダムな数値の統計を計算して」
- 「JSON データをパースするコードを作って」

#### 2. network - Network Gateway

VPC ネットワーキング、Transit Gateway、VPN、トラフィック分析に使用されます。

**主なツール:**
- `list_vpcs`, `get_vpc_network_details`, `describe_network`
- `list_transit_gateways`, `get_tgw_routes`, `get_all_tgw_routes`
- `list_vpn_connections`, `list_network_firewalls`
- `analyze_reachability`, `query_flow_logs`

**質問例:**
- 「TGW のルートを分析して」
- 「VPN 接続の状態を診断して」
- 「EC2 間で通信可能か確認して」
- 「VPC Flow Logs から拒否されたトラフィックを照会して」

#### 3. container - Container Gateway

EKS、ECS、Istio サービスメッシュ関連のトラブルシューティングに使用されます。

**主なツール:**
- `list_eks_clusters`, `get_eks_vpc_config`, `get_eks_insights`
- `ecs_resource_management`, `ecs_troubleshooting_tool`
- `istio_overview`, `list_virtual_services`, `check_sidecar_injection`

**質問例:**
- 「EKS クラスターの状態を診断して」
- 「ECS サービスが正常か確認して」
- 「Istio の sidecar injection の状態を確認して」

#### 4. iac - IaC Gateway

Infrastructure as Code 関連の作業に使用されます。

**主なツール:**
- `validate_cloudformation_template`, `check_cloudformation_template_compliance`
- `search_cdk_documentation`, `cdk_best_practices`
- `SearchAwsProviderDocs`, `terraform_best_practices`

**質問例:**
- 「CDK のベストプラクティスを教えて」
- 「CloudFormation スタックのエラー原因を分析して」
- 「Terraform の VPC モジュールを検索して」

#### 5. data - Data Gateway

AWS のデータベースおよびストリーミングサービスに使用されます。

**主なツール:**
- `list_tables`, `describe_table`, `query_table`, `dynamodb_data_modeling`
- `list_db_instances`, `describe_db_instance`, `execute_sql`
- `list_cache_clusters`, `elasticache_best_practices`
- `list_clusters` (MSK), `msk_best_practices`

**質問例:**
- 「DynamoDB テーブルの詳細情報を見せて」
- 「RDS インスタンスの状態を確認して」
- 「ElastiCache のベストプラクティスを教えて」

#### 6. security - Security Gateway

IAM およびセキュリティ関連の分析に使用されます。

**主なツール:**
- `list_users`, `list_roles`, `list_policies`
- `list_access_keys`, `simulate_principal_policy`
- `get_account_security_summary`

**質問例:**
- 「IAM ユーザーの一覧と Access Key の状態を見せて」
- 「このロールが S3 にアクセスできるかシミュレーションして」
- 「アカウントのセキュリティ要約を教えて」

#### 7. monitoring - Monitoring Gateway

CloudWatch および CloudTrail の分析に使用されます。

**主なツール:**
- `get_metric_data`, `analyze_metric`, `get_active_alarms`
- `describe_log_groups`, `execute_log_insights_query`
- `lookup_events`, `lake_query`

**質問例:**
- 「EC2 の CPU 使用率の推移を見せて」
- 「CloudTrail から最近の IAM イベントを照会して」
- 「有効なアラームの一覧を見せて」

#### 8. cost - Cost Gateway

コスト分析および最適化に使用されます。

**主なツール:**
- `get_cost_and_usage`, `get_cost_and_usage_comparisons`
- `get_cost_forecast`, `get_pricing`
- `list_budgets`

**質問例:**
- 「今月のコストを分析して」
- 「サービス別のコストを比較して」
- 「来月のコストを予測して」

#### 9. datasource - 外部オブザーバビリティ（自然言語 → クエリ）

連携された外部オブザーバビリティプラットフォーム（Prometheus/Loki/Tempo/ClickHouse/Jaeger/Dynatrace/Datadog）に関する質問に使用されます。

**処理方式:**
1. Claude が自然言語の質問を該当プラットフォームのクエリ言語（PromQL/LogQL/TraceQL/SQL）に変換
2. SSRF allowlist を通過したデータソースにクエリを実行
3. 結果を分析して応答

**質問例:**
- 「決済サービスの 5xx の推移を見せて」（Prometheus）
- 「直近 1 時間のエラーログを探して」（Loki）
- 「遅いトレースを分析して」（Tempo/Jaeger）

#### 10. aws-data - Bedrock + Steampipe SQL

リソースの一覧、状況、件数の照会に使用されます。

**処理方式:**
1. Claude Sonnet が質問から SQL を生成
2. Steampipe pg Pool で直接クエリを実行
3. 結果を Bedrock が分析して応答

**質問例:**
- 「EC2 インスタンスの一覧を見せて」
- 「S3 バケットがいくつあるか確認して」
- 「VPC ネットワーク構成を分析して」
- 「全リソースを要約して」

#### 11. general - Ops Gateway

一般的な AWS の質問、ドキュメント検索、ベストプラクティスに使用されます。

**主なツール:**
- `search_documentation`, `read_documentation`
- `recommend`, `list_regions`, `get_regional_availability`

**質問例:**
- 「このサービスがソウルリージョンで利用可能か確認して」
- 「ECS と EKS の違いを教えて」
- 「サーバーレスアーキテクチャを推奨して」

## マルチルート

1 つの質問が複数のドメインにまたがる場合、最大 3 個のルートに分類されて並列処理されます。

**例:**
```
"VPC のセキュリティグループとコストを分析して"
→ ["network", "cost"]

"セキュリティを点検して IAM ユーザーも確認して"
→ ["security"]
```

:::info マルチルート応答
マルチルート処理時は、各 Gateway の応答が合成されて 1 つの統合された回答として提供されます。
:::

## SSE ストリーミング

応答は Server-Sent Events（SSE）でストリーミングされます。

### 進行状況の表示

```
質問を分析中...
→ Network Gateway を呼び出し中...
→ 応答を生成中...
```

### ストリーミングイベント

| イベント | 説明 | データ |
|--------|------|--------|
| `status` | 進行状況メッセージ | `{ step, message }` |
| `chunk` | リアルタイムテキストストリーミング | `{ delta: string }` |
| `done` | 完了した応答データ | `{ content, route, usedTools, ... }` |
| `error` | エラーメッセージ | `{ message }` |

### ストリーミングモード

応答経路に応じて、3 つのストリーミングモードが自動的に選択されます:

<AIStreamingFlow />

| モード | 適用経路 | 方式 |
|------|----------|------|
| **Real Streaming** | マルチルート合成 | Bedrock Converse API — トークン単位で即時送信 |
| **Simulated Streaming** | 単一 Gateway 応答 | 50 文字チャンク + 15ms ディレイ — タイピング効果 |
| **Direct Streaming** | aws-data（Steampipe+Bedrock） | Bedrock ネイティブストリーミング |

:::info マルチルート合成ストリーミング
2〜3 個のルートの並列実行結果を合成する際、Bedrock Converse Stream API（`ConverseStreamCommand`）を使用して合成過程をリアルタイムにストリーミングします。ユーザーは合成結果が生成されると同時に画面で確認できます。
:::

## ツール使用の表示

応答の下部に、使用された MCP ツールが表示されます。

```
Tools: list_vpcs, get_vpc_network_details, analyze_reachability
Queried: aws_vpc, aws_vpc_subnet, aws_vpc_security_group
```

## 会話履歴

### セッション内コンテキスト

現在のセッションの会話が維持され、フォローアップの質問が可能です。

```
ユーザー: "VPC の一覧を見せて"
AI: (VPC 一覧の応答)

ユーザー: "その中で default VPC の詳細情報を教えて"
AI: (以前のコンテキストを参照して default VPC の詳細を応答)
```

### 保存された履歴（AgentCore Memory）

会話履歴は AgentCore Memory Store にユーザーごとに保存されます。画面右側のパネルで確認し、クリックで復元できます。

| 機能 | API |
|------|-----|
| セッション一覧（最新 30 件） | `GET /awsops/api/agentcore?action=sessions&limit=30` |
| 単一セッションのロード | `GET /awsops/api/agentcore?action=session&id={sessionId}` |

- **保存情報**: 質問、応答、ルート、トークン使用量、タイムスタンプ
- **セッション ID**: クライアントでページ表示時に `s_{timestamp}_{rand}` の形式で生成され、応答に含まれてサーバーに記録
- **保持期間**: 365 日（`agentcore-memory.ts` の `eventExpiryDuration` 上限）
- **復元動作**: セッションをクリックすると、そのセッションのメッセージ配列で現在のチャット画面を上書きし、フォローアップの質問は同じ `sessionId` で継続呼び出し — Bedrock のコンテキストを維持

## セッション統計

画面下部に現在のセッションの統計が表示されます。

```
5 queries  │  avg 3.2s  │  100%  │  aws-data:3  security:1  network:1
```

- **queries**: 質問の総数
- **avg**: 平均応答時間
- **成功率**: 成功した応答の割合
- **ルート分布**: ルートごとの呼び出し回数

## 関連質問の推奨

応答後、関連するフォローアップの質問がルートごとに推奨されます。

| ルート | 推奨質問の例 |
|--------|--------------|
| security | 「IAM ユーザーの一覧と Access Key の状態を見せて」 |
| network | 「VPC のサブネットとルートテーブルを見せて」 |
| container | 「EKS ノードの CPU/メモリ使用率を確認して」 |
| cost | 「サービス別のコストを比較して」 |

## 次のステップ

- [AgentCore 詳細](../overview/agentcore) - Gateway およびツールの詳細情報
- [ダッシュボード](../overview/dashboard) - ダッシュボードに戻る
