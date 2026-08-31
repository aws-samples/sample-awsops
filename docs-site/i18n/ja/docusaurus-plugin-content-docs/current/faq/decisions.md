---
sidebar_position: 7
title: 主要意思決定 FAQ
description: AWSops の中核アーキテクチャ意思決定(ADR)を運用者視点の Q&A で整理します — 読み取り専用姿勢、外部書き込みガバナンス、AI ルーティング・診断、インフラ構造、コスト・セキュリティ・運用の決定。
---

# 主要意思決定 FAQ

AWSops が「なぜこのように動作するのか」を決定した中核的な設計判断(ADR、Architecture Decision Records)を、運用者が最もよく尋ねる質問の形式で整理しました。各回答には根拠となった ADR 番号を併記します。

すべての意思決定記録と詳細な文脈は `docs/decisions/`(ADR 001~044)で確認でき、インデックスと訂正ノートは `docs/decisions/CLAUDE.md` にあります。

:::info
AWSops の最も重要な原則は**読み取り専用(read-only)**です。ただし、この制約は正確には **AWS リソースの変更 + 自律実行(autonomy)**に紐づいています (ADR-041)。外部オブザーバビリティの**データ読み取り**と、ガバナンス下の外部**データ記録(書き込み)**はこの制約に該当しません — データ演算であり、AWS リソースの変更ではないからです。
:::

## セキュリティ / Security

### AWSops は AWS リソースを直接変更したり、自動で対処したりしますか?

**いいえ。AWS リソースの変更と自律実行は恒久的に凍結(do-not-enable)されています。**

もともと変更作業フレームワーク(ADR-029)と実行 substrate(SSM Automation + Change Manager × P2 ワーカーのハイブリッド、ADR-036)が設計されましたが、**2026-06-11 の 3-AI 合意で両方とも撤回(REVERSED)**されました。コードはダーク(dark)状態で保存されますが、フラグは恒久 OFF であり、有効化しません。

- EC2 の終了、SG の修正、スケーリング、デプロイのような **AWS リソースの変更は、どの画面・AI 機能でも実行されません。**
- 約 160 個の AgentCore MCP Lambda ツールはすべて read-only です。

:::info
「凍結」の範囲は **AWS リソース限定**です (ADR-029/036 2026-06-16 スコープ訂正、ADR-041 keystone)。統制層とワーカー実行分岐は非 AWS の外部データ書き込みに再利用され得ますが、AWS リソース自動化 substrate 自体は凍結を維持します。
:::

### Slack・Jira のような外部システムへの記録の書き込みも禁止されていますか?

**いいえ — ガバナンスの下で許可されています。** これは**データレコード**であり、AWS リソースの変更ではないからです (ADR-040、ADR-041)。

2026-06-11 の撤回以降、ADR-040 が**非 AWS リソースの外部 knowledge/comms write**(Slack・Notion・Confluence・Jira・ServiceNow の記録・メッセージ)に限って狭い carve-out を設け、ADR-041 がこれを keystone として再整合しました: read-only 制約 = AWS リソースの変更 + 自律、**外部データ統合(read+write)は除外**。

- 外部システムにレポート・チケット・メッセージを残すことは、ガバナンス統制の下で可能です。
- AWS インフラ自体に対する変更権限は、**いかなる経路でも**付与されません。

### 外部に書き込むとき、内部情報が漏洩するリスクはありませんか?

外部データ書き込みは ADR-040 の **7 大ハード条件**の下でのみ動作するよう設計されています。主要なガードは次のとおりです:

- **DLP / redaction** — 外部に出る内容から機微情報を除去(反対票の主要な懸念だっただけに強く明記)
- **宛先 allowlist** — 承認された外部宛先にのみ送信
- **SSRF ガード** — メタデータ/IMDS 遮断、内部エンドポイント遮断
- **シークレットは Secrets Manager** で管理
- **human-gate** — 人の承認後に送信(または draft-only フォールバック)
- **非 AWS リソース専用** + **デフォルト flag-OFF**

:::tip
2026-06-11 の合意が external-endpoint/egress/SSRF を scope-creep と明記していた点との整合のため、ADR-041 はこの解除を「clarification」ではなく **owner-override** として明記しています(addendum 反映)。つまり外部書き込みは「例外許可」ではなく、**統制 mandate** の下でのデータ write 標準です。
:::

### ログインはどのように決定されましたか?

AWSops は**アプリ内ログインフォーム**(`/login`)を使用します (ADR-042)。

自前の `/login` フォームが BFF `POST /api/auth/login` を呼び出す → 無署名の公開 Cognito `InitiateAuth(USER_PASSWORD_AUTH)` で認証 → `awsops_token` Cookie(id_token、12 時間)を発行。以降のすべてのリクエストは Lambda@Edge が **RS256 JWKS 署名検証**で検査します。Hosted UI PKCE フローはダークフォールバックとしてのみ保存されています。

この決定は ADR-037 ファウンデーションの上に ADR-020(Cognito + Lambda@Edge)を洗練させたもので、最小権限(REFRESH 未付与)に従います。

### 管理者権限はどのように統制されますか?

**サーバー側 fail-closed ゲート**です (ADR-023)。

管理者機能は Cognito `admins` **グループのメンバー**、または SSM **管理者メール allowlist** に含まれるユーザーにのみ許可されます。どちらでも確認できない場合はデフォルトで遮断(fail-closed)されます。

## アーキテクチャ / Architecture

### インフラ構造はなぜ単一 EC2 ではないのですか?

AWSops は v1 の**単一 EC2 モノリシック**を **Terraform ベースの MSA** に再構築しました (ADR-037、ADR-030)。

- **IaC**: Terraform(部分 S3 backend)。CDK は廃止されました (ADR-024 → ADR-037 が承継)。
- **コンピュート**: ECS Fargate(arm64)。web は Next.js 14 thin-BFF としてルートパスで配信されます。
- **非同期ワーカー**: 重い・長い/OOM リスクのある作業は web が直接処理せず、SQS → ESM(キルスイッチ) → dispatcher Lambda(冪等) → Step Functions → Lambda または `ecs:runTask.sync` Fargate に送ります。

ADR-037 は ADR-024 を全面承継し、ADR-030 のメカニズムを洗練しました(ライブ Steampipe なし、flag-gated インベントリ sync のみ確定)。

### データはなぜ Aurora に保存するのですか?

EC2 インスタンス内の JSON ファイルではなく、**Aurora Serverless v2(PostgreSQL 17)**に永続化します (ADR-030)。

`worker_jobs`(非同期ジョブ)、チャットスレッド、AI 診断レポート、データソーススキーマキャッシュなどのアプリ状態がすべて Aurora に保存され、アプリは node-pg でアクセスします。これによりインスタンスの再起動・入れ替えでも状態が維持されます。(Aurora・二重 ECR の意図は ADR-030 で有効であり、4 コンテナ/Service Connect/CDK メカニズムは ADR-037 が承継しました。)

### Neptune のようなグラフ DB を導入しますか?

**現時点ではいいえ — 延期(deferred)されました** (ADR-043)。

トポロジー・リソースグラフは Postgres の再帰 CTE で十分に処理できるため **Postgres-first** の原則を維持し、Neptune はオプションとしてのみ残してフラグ OFF です。(2026-06-17 addendum: 5 ファミリー合意で Postgres-first を再確認。トポロジー UI は現行のクライアントビルドを維持し、サーバー materialize はコンシューマー登場時に配線。)

## AI

### 障害を AI が自動で分析し、対処までしますか?

**分析(RCA)は はい、自動対処(mitigation)は いいえ** (ADR-032、DOWNGRADED 2026-06-11)。

ADR-032 はもともとイベントトリガーの自律インシデントライフサイクル(マルチエージェント Lead/Sub)を定義していましたが、2026-06-11 の合意で**自律 mitigation/action は廃止**され、**read-only の Triage・調査・RCA のみ維持**されます(勧告専用、有効化時 analysis-only)。分析結果をもとに人が判断して対処します。

### RCA(原因分析)の結果はどこに記録されますか?

OpsCenter / Incident Manager への双方向ライトバックで記録するよう設計されています (ADR-034、KEPT)。

ただし、ADR-034 は現在 frozen な 029/036 substrate role を継承しているため、**自足(self-contained)role の分離と `rca_writeback_enabled` の有効化までは flag-OFF・do-not-enable** です。ADR-041 coherence addendum(2026-06-17)はこのライトバックを **AWS ネイティブ観測メタデータ write(第 3 ティア)**と明示 — FROZEN ではなくデータのようにガバナンスされますが、role 分離が先行する必要があります。

### AI ルーティングはどのように動作しますか?

**ADR-038 ハイブリッドルーティング**です — 正規表現 fast-path + Haiku 4.5 分類器 + プロンプトキャッシング。**2026-06-10 に有効化 LIVE**。

ゲートスコアが hybrid 69.2% → **96.9%(+27.7pp) PASSED** と検証されました。以前の 11/18-route Sonnet レジストリ方式ではなく、高速な正規表現で明確なクエリを先に捉え、曖昧なら Haiku 分類器でルーティングします。(分類器のタイムアウトは 3.5s に訂正 — グローバル cross-region プロファイルでは 1s は不足。)

### 繰り返される質問に AI コストがかかり続けますか?

**プロンプトキャッシングと作業深度別のモデル選択で最適化**されます (ADR-038、ADR-033)。

- **プロンプトキャッシング** — 約 59% のヒット率で、繰り返しコンテキストの再計算を削減します (ADR-038)。
- **作業深度別モデル** — AI 診断は Light·Mid(8+1 セクション)は Sonnet デフォルト、Deep(15+1 セクション)は Sonnet デフォルト・Opus 選択(cost-gate)。分類・ルーティングには低コストの Haiku 4.5 を使用します (ADR-033)。
- ADR-033 は Aurora durable token budget(予算永続化)を定義しました — v1 に実装済みで、現在のウェブチャット経路への連携は今後の課題です。

### ゲートウェイは 9 個に増えたのですか?

**はい — 9 個です** (ADR-004 改訂、2026-06-24)。

network · container · data · security · cost · monitoring · iac · ops の 8 個の AWS ドメインゲートウェイに加え、外部オブザーバビリティコネクタ（Prometheus·ClickHouse）をホストする **external-obs ゲートウェイ**が 9 番目としてプロビジョニング・ルーティングされます（9 プロビジョニング / 9 ルーティング）。その他の外部連携は別の **Integrations 軸**（ADR-007/017）です。

### 自分でエージェントやツールを追加構成できますか?

**キュレーションされたコネクタに限って可能です** (ADR-039、ADR-031、ADR-041)。

ADR-039 マルチエージェントプラットフォームはフロンティアエージェント(DevOps/Security/FinOps + N)と Integrations 軸を導入し、管理者構成の Agent Space(ADR-031 Phase 1/2)は LIVE です。ただし:

- **任意形態の BYO-MCP(ADR-031 Phase 3)は廃止**されました (2026-06-11 撤回)。コネクタは**キュレーションされた形態**のみ許可されます (ADR-041)。
- **変更(mutating)ツール(ADR-031 Phase 4)**のうち、非 AWS の外部データ write のみ ADR-040 ガバナンスで狭く許可され、AWS リソースの変更は廃止を維持します。

### Kubernetes(EKS)の診断も AI が自動で行いますか?

**read-only 診断のみ提供します** (ADR-035、DOWNGRADED 2026-06-11)。

K8sGPT ハイブリッド(MCP で AgentCore に統合されるインクラスター K8s 診断、Haiku 4.5)は **read-only の Result-CRD 統合(GET-only)のみ維持**され、自動対処につながる配線(H3a → 032/034/029 提案)は廃止されました。EKS クエリは task-role Access Entry + View policy ベースで、すべて読み取り専用です。

## 運用 / Operations

### 長い作業や重い作業はどのように処理しますか?

**非同期ワーカーティアへ enqueue** します (ADR-037)。

web は thin-BFF であるため、重い/長い/OOM リスクのある作業を直接実行しません: `POST /api/jobs` → `worker_jobs`(queued) + SQS → ESM(キルスイッチ) → dispatcher Lambda(job_id 冪等) → Step Functions が `$.runtime` に応じて、短い作業は RunLambda、長い/OOM リスクのある作業は `ecs:runTask.sync` Fargate にルーティング → ワーカーが自ら running/succeeded を記録 → 失敗時は status_updater Lambda が failed を記録 → reaper(EventBridge 5 分)が stale な作業を整合化します。

:::tip
ESM にはキルスイッチがあり、キューの消費を即座に停止できます。dispatcher は job_id 基準で冪等であるため、重複ディスパッチは安全に無視されます。
:::

### これらの決定はどこで詳しく確認できますか?

すべての ADR(001~044)は `docs/decisions/` にあり、インデックス・ステータス・撤回/訂正ノートは `docs/decisions/CLAUDE.md` で確認できます。2026-06-11 の高リスク撤回合意文書は `docs/reviews/2026-06-11-high-risk-adr-reversal-consensus.md` に、外部書き込み解除の合意は `docs/reviews/2026-06-14-external-write-unfreeze-consensus.md` にあります。
