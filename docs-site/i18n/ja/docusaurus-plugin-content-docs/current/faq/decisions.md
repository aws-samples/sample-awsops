---
sidebar_position: 7
title: 設計原則 FAQ
description: AWSops がなぜこのように動作するのかを運用者視点の Q&A で整理します — 読み取り専用姿勢、外部書き込みガバナンス、AI ルーティング・診断、インフラ構造、コスト・セキュリティ・運用の原則。
---

# 設計原則 FAQ

AWSops が「なぜこのように動作するのか」を決める中核的な設計原則を、運用者が最もよく尋ねる質問の形式で整理しました。

:::info
AWSops の最も重要な原則は**読み取り専用(read-only)**です。ただし、この制約は正確には **AWS リソースの変更 + 自律実行(autonomy)**に紐づいています。外部オブザーバビリティの**データ読み取り**と、ガバナンス下の外部**データ記録(書き込み)**はこの制約に該当しません — データ演算であり、AWS リソースの変更ではないからです。
:::

## セキュリティ / Security

### AWSops は AWS リソースを直接変更したり、自動で対処したりしますか?

**いいえ。AWS リソースの変更と自律実行は恒久的に凍結(do-not-enable)されています。**

変更作業フレームワークと実行 substrate(SSM Automation + Change Manager × ワーカー)のコードはダーク(dark)状態で保存されますが、フラグは恒久 OFF であり、有効化しません。

- EC2 の終了、SG の修正、スケーリング、デプロイのような **AWS リソースの変更は、どの画面・AI 機能でも実行されません。**
- 約 160 個の AgentCore MCP Lambda ツールはすべて read-only です。

:::info
「凍結」の範囲は **AWS リソース限定**です。統制層とワーカー実行分岐は非 AWS の外部データ書き込みに再利用され得ますが、AWS リソース自動化 substrate 自体は凍結を維持します。
:::

### Slack・Jira のような外部システムへの記録の書き込みも禁止されていますか?

**いいえ — ガバナンスの下で許可されています。** これは**データレコード**であり、AWS リソースの変更ではないからです。

**非 AWS リソースの外部 knowledge/comms write**(Slack・Notion・Confluence・Jira・ServiceNow の記録・メッセージ)は狭く許可されています。read-only 制約は AWS リソースの変更 + 自律に適用され、**外部データ統合(read+write)は除外**されます。

- 外部システムにレポート・チケット・メッセージを残すことは、ガバナンス統制の下で可能です。
- AWS インフラ自体に対する変更権限は、**いかなる経路でも**付与されません。

### 外部に書き込むとき、内部情報が漏洩するリスクはありませんか?

外部データ書き込みは**ハード条件**の下でのみ動作するよう設計されています。主要なガードは次のとおりです:

- **DLP / redaction** — 外部に出る内容から機微情報を除去
- **宛先 allowlist** — 承認された外部宛先にのみ送信
- **SSRF ガード** — メタデータ/IMDS 遮断、内部エンドポイント遮断
- **シークレットは Secrets Manager** で管理
- **human-gate** — 人の承認後に送信(または draft-only フォールバック)
- **非 AWS リソース専用** + **デフォルト flag-OFF**

:::tip
外部書き込みは「例外許可」ではなく、**統制 mandate** の下でのデータ write 標準です。
:::

### ログインはどのように動作しますか?

AWSops は**アプリ内ログインフォーム**(`/login`)を使用します。

自前の `/login` フォームが BFF `POST /api/auth/login` を呼び出す → 無署名の公開 Cognito `InitiateAuth(USER_PASSWORD_AUTH)` で認証 → `awsops_token` Cookie(id_token、12 時間)を発行。以降のすべてのリクエストは Lambda@Edge が **RS256 JWKS 署名検証**で検査します。Hosted UI PKCE フローはダークフォールバックとしてのみ保存されています。

Cognito + Lambda@Edge の構成は最小権限(REFRESH 未付与)に従います。

### 管理者権限はどのように統制されますか?

**サーバー側 fail-closed ゲート**です。

管理者機能は Cognito `admins` **グループのメンバー**、または SSM **管理者メール allowlist** に含まれるユーザーにのみ許可されます。どちらでも確認できない場合はデフォルトで遮断(fail-closed)されます。

## アーキテクチャ / Architecture

### インフラ構造はなぜ単一 EC2 ではないのですか?

AWSops は v1 の**単一 EC2 モノリシック**を **Terraform ベースの MSA** に再構築しました。

- **IaC**: Terraform(部分 S3 backend)。CDK は廃止されました。
- **コンピュート**: ECS Fargate(arm64)。web は Next.js 15 thin-BFF としてルートパスで配信されます。
- **非同期ワーカー**: 重い・長い/OOM リスクのある作業は web が直接処理せず、SQS → ESM(キルスイッチ) → dispatcher Lambda(冪等) → Step Functions → Lambda または `ecs:runTask.sync` Fargate に送ります。

ライブ Steampipe のクエリ経路はなく、flag-gated インベントリ sync のみがあります。

### データはなぜ Aurora に保存するのですか?

EC2 インスタンス内の JSON ファイルではなく、**Aurora Serverless v2(PostgreSQL 17)**に永続化します。

`worker_jobs`(非同期ジョブ)、チャットスレッド、AI 診断レポート、データソーススキーマキャッシュなどのアプリ状態がすべて Aurora に保存され、アプリは node-pg でアクセスします。これによりインスタンスの再起動・入れ替えでも状態が維持されます。

### Neptune のようなグラフ DB を導入しますか?

**現時点ではいいえ — 延期(deferred)されました。**

トポロジー・リソースグラフは Postgres の再帰 CTE で十分に処理できるため **Postgres-first** の原則を維持し、Neptune はオプションとしてのみ残してフラグ OFF です。トポロジー UI は現行のクライアントビルドを維持し、サーバー materialize はコンシューマーが現れた時点で配線します。

## AI

### 障害を AI が自動で分析し、対処までしますか?

**分析(RCA)は はい、自動対処(mitigation)は いいえ。**

自律 mitigation/action は提供せず、**read-only の Triage・調査・RCA のみ提供**します(勧告専用、有効化時 analysis-only)。分析結果をもとに人が判断して対処します。

### RCA(原因分析)の結果はどこに記録されますか?

OpsCenter / Incident Manager への双方向ライトバックで記録するよう設計されています。

ただし、このライトバックは現在、凍結された自動化 substrate の role を継承しているため、**自足(self-contained)role の分離と `rca_writeback_enabled` の有効化までは flag-OFF・do-not-enable** です。このライトバックは **AWS ネイティブ観測メタデータ write** に分類され、凍結対象ではなくデータのようにガバナンスされますが、role 分離が先行する必要があります。

### AI ルーティングはどのように動作しますか?

**ハイブリッドルーティング**です — 正規表現 fast-path + Haiku 4.5 分類器 + プロンプトキャッシングで動作します。

ゲートスコアが hybrid 69.2% → **96.9%(+27.7pp) PASSED** と検証されました。高速な正規表現で明確なクエリを先に捉え、曖昧なら Haiku 分類器でルーティングします。分類器のタイムアウトは 3.5s です(グローバル cross-region プロファイルでは 1s は不足)。

### 繰り返される質問に AI コストがかかり続けますか?

**プロンプトキャッシングと作業深度別のモデル選択で最適化**されます。

- **プロンプトキャッシング** — 約 59% のヒット率で、繰り返しコンテキストの再計算を削減します。
- **作業深度別モデル** — AI 診断は Light·Mid(8+1 セクション)は Sonnet デフォルト、Deep(15+1 セクション)は Sonnet デフォルト・Opus 選択(cost-gate)。分類・ルーティングには低コストの Haiku 4.5 を使用します。
- Aurora durable token budget(予算永続化)は v1 に実装済みで、現在のウェブチャット経路への連携は今後の課題です。

### ゲートウェイはいくつありますか?

**9 個です。**

network · container · data · security · cost · monitoring · iac · ops の 8 個の AWS ドメインゲートウェイに加え、外部オブザーバビリティコネクタ（Prometheus·ClickHouse）をホストする **external-obs ゲートウェイ**が 9 番目としてプロビジョニング・ルーティングされます（9 プロビジョニング / 9 ルーティング）。その他の外部連携は別の **Integrations 軸**です。

### 自分でエージェントやツールを追加構成できますか?

**ガバナンスされたコネクタに限って可能です。**キュレーションされたコネクタ、公式プリセット、または管理者が登録する `custom_mcp` 連携です。

マルチエージェントプラットフォームはフロンティアエージェント(DevOps/Security/FinOps + N)と Integrations 軸を提供し、管理者構成の Agent Space は LIVE です。ただし:

- **任意形態の BYO-MCP は提供しません。**ガバナンス制御のない MCP エンドポイント経路は許可されません。
- 管理者専用の `custom_mcp` 連携は、これらの制御を備えたガバナンス経路です: 管理者のみが登録、アカウントごとの有効化、管理者が指定する公開ツール上限(空の場合はツールを公開しない)、接続時に Secrets Manager から読み取る認証情報、接続時の SSRF チェック。公式プリセットのホスト固定は変わりません。
- **変更(mutating)ツール**のうち、非 AWS の外部データ write のみ外部書き込みガバナンスで狭く許可され、AWS リソースの変更は提供しません。

### Kubernetes(EKS)の診断も AI が自動で行いますか?

**read-only 診断のみ提供します。**

K8sGPT ハイブリッド(MCP で AgentCore に統合されるインクラスター K8s 診断、Haiku 4.5)は **read-only の Result-CRD 統合(GET-only)のみ提供**し、自動対処につながる配線はありません。EKS クエリはすべて読み取り専用です。既定の認証主体は、ホストクラスターでは web タスクロール、メンバークラスターでは登録済みメンバー読み取りロール（通常 `AWSopsReadOnlyRole`）で、それぞれ対象クラスターの Access Entry と読み取りポリシーが必要です。メンバーのメタデータ取得と既定の Kubernetes トークン署名はともにメンバーロールの認証情報を使い、以前のホストロールの Entry だけでは許可されません。保存された SA トークンまたは明示的な AssumeRole 認証は別途許可された Kubernetes ID を使用し、メンバークラスターの AssumeRole は同じメンバーアカウントのロールに限られます。SA 認証に IAM Access Entry は不要ですが、メタデータ取得権限は必要です。どの方式も自動修復を有効にしません。

## 運用 / Operations

### 長い作業や重い作業はどのように処理しますか?

**非同期ワーカーティアへ enqueue** します。

web は thin-BFF であるため、重い/長い/OOM リスクのある作業を直接実行しません: `POST /api/jobs` → `worker_jobs`(queued) + SQS → ESM(キルスイッチ) → dispatcher Lambda(job_id 冪等) → Step Functions が `$.runtime` に応じて、短い作業は RunLambda、長い/OOM リスクのある作業は `ecs:runTask.sync` Fargate にルーティング → ワーカーが自ら running/succeeded を記録 → 失敗時は status_updater Lambda が failed を記録 → reaper(EventBridge 5 分)が stale な作業を整合化します。

:::tip
ESM にはキルスイッチがあり、キューの消費を即座に停止できます。dispatcher は job_id 基準で冪等であるため、重複ディスパッチは安全に無視されます。
:::
