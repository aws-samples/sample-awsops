---
sidebar_position: 1
title: 一般 FAQ
description: AWSops とは何か、どのようにデプロイ・ログイン・運用されるのか、インフラを変更するのか、データはどこに保存されるのかなど、最もよくある質問に答えます。
---

# 一般 FAQ

AWSops ダッシュボードに関する一般的な質問と回答です。

## AWSops とは何ですか?

AWSops は、AWS と Kubernetes 環境のための**リアルタイム読み取り専用(read-only)運用ダッシュボード + AI 診断**ツールです。主な機能は次のとおりです:

- **リソースモニタリング**: EC2、Lambda、ECS、EKS、RDS、S3 など主要 AWS サービスの状況
- **ネットワーク / トポロジー可視化**: VPC・サブネット・Security Group、そして CloudFront → LB → Target Group → DB へと続くリソースグラフ
- **セキュリティ分析**: IAM 権限分析、コンプライアンス、脆弱性チェック
- **コスト管理**: Cost Explorer ベースのコスト分析とダッシュボード
- **AI アシスタント**: 自然言語クエリによる AWS リソース分析と問題解決(ストリーミング + ドメインルーティング + 会話の永続化)
- **AI 診断(Diagnosis)**: ワーカーが生成する読み取り専用の診断レポート(Light·Mid 8+1 セクション（計 9） / Deep 15+1 セクション（計 16）、DOCX・PDF エクスポート)

プラットフォームは **Terraform ベースの MSA** です — ライブ AWS クエリは **Amazon Bedrock AgentCore MCP ツール**が担当し、アプリの状態は **Aurora Serverless v2(PostgreSQL 17)**に永続化されます。

:::info
AWSops は**読み取り専用**の運用ツールです。インフラの状況を照会・可視化・診断しますが、AWS リソースを変更しません。詳細は下記の「AWSops は私のインフラを変更しますか?」を参照してください。
:::

## どのようにデプロイされ、どんな構造で動作しますか?

AWSops は **Terraform**(`terraform/foundation/`、部分 S3 backend)でプロビジョニングされるマイクロサービスアーキテクチャです。主要な構成は次のとおりです:

| レイヤー | 構成 |
|------|------|
| **IaC** | Terraform (S3 partial backend, `use_lockfile`)。CDK は廃止済み |
| **エッジ** | CloudFront(TLS) → VPC Origin(`https-only:443`) → 内部 ALB HTTPS:443(リージョン ACM) → Fargate。**公開 ALB なし** |
| **コンピュート** | ECS Fargate(arm64)。web は Next.js 14 thin-BFF、**ルートパス(`/`)**で配信 |
| **データ** | Aurora Serverless v2 (PostgreSQL 17)、node-pg でアクセス |
| **AI** | AgentCore Runtime + 9 個のセクションゲートウェイの MCP Lambda ツール(ライブクエリ) |
| **非同期ワーカー** | SQS → ESM(キルスイッチ) → dispatcher Lambda → Step Functions → Lambda または Fargate |

重い・長い・メモリ(OOM)リスクのある作業は web が直接処理せず、**非同期ワーカーティア**に送ります: `POST /api/jobs` → `worker_jobs` へキュー登録 → SQS → 冪等な dispatcher Lambda → Step Functions が作業の長さに応じて、短い作業は RunLambda、長い/OOM リスクのある作業は `ecs:runTask.sync` Fargate にルーティングします。失敗は status_updater Lambda が記録し、reaper(EventBridge 5 分)が stale な作業を整合化します。

:::tip
エッジは**エンドツーエンド TLS** です。CloudFront → 内部 ALB が TLS で接続され、ALB SG は CloudFront マネージド SG `CloudFront-VPCOrigins-Service-SG` からの 443 を許可します。別途の X-Custom-Secret ヘッダーやマネージド prefix list は使用しません。
:::

## AWSops は私のインフラを変更しますか?

**いいえ。** AWSops は**読み取り専用の運用ダッシュボード + AI 診断**ツールです。**AWS リソースの変更と自律実行(autonomy)は恒久的に凍結(do-not-enable)**されています。どの画面や AI 機能も EC2 を終了したり、SG を修正したり、インフラを変更したりしません。

AI アシスタントと診断はライブデータを**照会**して分析・診断するのみで、変更(mutation)を実行しません。約 160 個の AgentCore MCP Lambda ツールはすべて read-only です。

ガバナンスの下で許可される唯一の「書き込み」は**外部データ記録**です — たとえば外部システムにレポート・チケット・メッセージを残すことです。これは次のガードの下でのみ動作します:

- SSRF ガード(メタデータ/IMDS 遮断、destination allowlist)
- シークレットは Secrets Manager で管理
- DLP / redaction
- human-gate(人による承認)
- デフォルト flag-OFF

:::info
外部「書き込み」は**データレコード**(チケット・メッセージ・レポート)であり、**AWS リソースの変更ではありません**。AWS インフラ自体に対する変更権限は、いかなる経路でも付与されません。
:::

## どのようにログインしますか?

AWSops は**アプリ内ログインフォーム**(`/login`)を使用します。

1. ブラウザで AWSops にアクセスすると、未認証ユーザーはエッジ(Lambda@Edge)が `/login` にリダイレクトします。
2. `/login` フォームにメールアドレスとパスワードを入力すると、BFF が `POST /api/auth/login` を呼び出します。
3. BFF は公開 Cognito `InitiateAuth (USER_PASSWORD_AUTH)` で認証し、`awsops_token` Cookie(id_token、12 時間有効)を発行します。
4. 以降のすべてのリクエストは Lambda@Edge が **RS256 JWKS 署名検証**(iss/aud/token_use を含む)で検査します。

認証は Cognito User Pool + Lambda@Edge(`us-east-1`)で処理されます。Hosted UI PKCE フローはダークフォールバックとしてのみ保存されています。

**管理者権限**はサーバー側で fail-closed にゲートされます — Cognito `admins` グループのメンバー、または SSM 管理者メール allowlist に含まれるユーザーのみが管理者機能にアクセスできます。

## データはどこに保存されますか?

AWSops は EC2 インスタンス内の JSON ファイルではなく、**マネージド AWS サービス**に状態を保存します。

| ストレージ | 内容 |
|--------|------|
| **Aurora Serverless v2 (PostgreSQL 17)** | `worker_jobs`(非同期ジョブ)、チャットスレッド、AI 診断レポート、データソーススキーマキャッシュなどのアプリ状態 |
| **SSM Parameter Store** | AgentCore 設定の source of truth (`/ops/awsops-v2/agentcore/...` — runtime ARN、interpreter id、memory id など) |
| **S3** | AI 診断レポートのエクスポート(DOCX・PDF) |

ライブ AWS リソースデータは**保存せず**、AgentCore MCP ツールがクエリ時点で取得します。(Steampipe は flag-gated の**インベントリ sync**(`steampipe_enabled`、デフォルト OFF)としてのみ使われ、ライブクエリエンジンではありません。)

:::tip
アプリは Aurora に **node-pg**(`web/lib/db.ts` の共有プール)でアクセスします。v1 の `data/*.json` ファイルパターンはもう使用しません。
:::

## ライブ AWS データはどのように照会しますか?

ライブ AWS / Kubernetes データは **AgentCore MCP Lambda ツール**を通じて照会します。約 160 個の読み取り専用ツールが **9 個のセクションゲートウェイ**(network · container · data · security · cost · monitoring · iac · ops · external-obs)にわたって配置されています。

- すべてのツールは read-only です。
- ゲートウェイ数は **9 個**です (ADR-004 改訂 2026-06-24) — Prometheus·ClickHouse コネクタをホストする external-obs が 9 番目としてプロビジョニング・ルーティングされます。
- ローカル Steampipe(127.0.0.1:9193)サービスや 380 テーブルへの直接アクセスにはもう依存しません。

## 外部オブザーバビリティデータ(Prometheus / Loki / Tempo / ClickHouse / Datadog)も照会できますか?

**はい — 読み取り専用データソースプラットフォーム**を通じて可能です。外部オブザーバビリティバックエンドをコネクタとして接続し、メトリクス・ログ・トレースを照会できます。

サポート対象(例): Prometheus、Loki、Tempo、ClickHouse、Mimir など。

構成要素:

- **コネクタ Lambda** — 外部バックエンドに read-only でクエリ
- **Aurora スキーマキャッシュ** — コネクタスキーマをキャッシュ
- **`/datasources` Explore ページ** — UI で直接探索
- **NL→query チャット注入** — 自然言語の質問を AI アシスタントがデータソースクエリに変換

:::info
コネクタ入力は **SSRF ガード + サイズ制限**を受けます(パース前の `readJsonBounded`、メタデータ/IMDS 遮断)。データソースプラットフォームは外部データを**読み取るだけ**であり、AWS リソースを変更しません。
:::

## テーマとモバイルをサポートしていますか?

**テーマ — 3 種類のランタイムテーマセレクター**

- **Cobalt** (デフォルト)
- **Teal**
- **Dark**

テーマは localStorage に保存され、リロード時にちらつき(flash)なく適用されます。チャートやマーク(ロゴ)もテーマに反応して色が変わります。どこからでも **Cmd-K コマンドパレット**で素早くナビゲートできます。

**モバイル — レスポンシブレイアウト**

- 上部バー + 下部 5 タブ + ハンバーガードロワー
- テーブル → カード形式への切り替え
- チャット画面のフルスクリーン
- グリッドのリフローと詳細シート(detail sheet)

## 複数の AWS アカウントをサポートしていますか?

AWSops のライブ環境は単一アカウント(`123456789012`)で動作します。ライブ AWS クエリは AgentCore MCP ツールが実行ロール(execution role)で実行し、本当に別のアカウントへのクエリは、別途の cross-account assume 経路を通じてのみ行われます。(ホストアカウントを対象に選択した場合は実行ロールを直接使用するため、不要な self-assume は発生しません。)すべてのアクセスは読み取り専用です。
