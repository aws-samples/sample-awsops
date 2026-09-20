---
sidebar_position: 0
title: なぜ AWSops なのか
description: オープンソースの AWS-Native 運用ダッシュボード — Steampipe の速度、Well-Architected AI 診断、マルチアカウント、OpenCost EKS コスト、外部オブザーバビリティの自然言語クエリ
---

import Screenshot from '@site/src/components/Screenshot';

# なぜ AWSops なのか

:::note 一部の内容は v1 基準です
このページの記述の一部（組み込み Steampipe データエンジン、診断 PPTX エクスポートなど）は
v1 時点のもので、段階的に更新中です。現行 v2 アーキテクチャは
[AgentCore 概要](./agentcore.md)と[FAQ](../faq/general.md)を参照してください。
:::


> **一言で言うと** — AWSops は**完全オープンソースであり、AWS マネージドサービスのみで実装された** AWS + Kubernetes 運用ダッシュボードです。Steampipe で AWS API を高速に取得してローカルにキャッシュし、Amazon Bedrock AgentCore による **Well-Architected 観点の AI 診断**まで 1 つの画面で提供します。

<Screenshot src="/screenshots/overview/dashboard.png" alt="AWSops ダッシュボード — 単一画面の運用状況" />

オペレーターが数十のコンソールを行き来しながら見ていたものを、**1 つのダッシュボード + 1 つの AI アシスタント**に統合しました。以下は、顧客環境に導入する際に鍵となる差別化ポイントです。

---

## 1. 完全オープンソース · AWS-Native (Architecture v1)

- **オープンソース** — 全ソースが公開されているため、そのまま自社アカウントにデプロイし、社内の要件に合わせて修正できます。ベンダーロックインがありません。
- **AWS マネージドサービスのみで実装** — 外部 SaaS への依存なしに、以下で構成されます:

| レイヤー | AWS サービス |
|--------|-----------|
| エッジ・認証 | CloudFront + Lambda@Edge + Cognito |
| コンピュート | EC2 (t4g.2xlarge, ARM64 Graviton, Private Subnet) + ALB |
| AI | **Amazon Bedrock AgentCore**（Runtime/Gateway/Code Interpreter/Memory）+ Bedrock モデル |
| IaC | AWS CDK |

- データ・AI・認証・エッジがすべて AWS の中で完結するため、**データガバナンス・コンプライアンスがシンプル**です。

:::tip セッションポイント
「このダッシュボード自体が AWS Well-Architected に作られている」— オープンソースなのでその実装を直接検証でき、32 個の ADR（Architecture Decision Record）ですべての設計判断が文書化されています。
:::

---

## 2. Steampipe — AWS API を高速に取得してローカルキャッシュ

AWSops のデータエンジンは [Steampipe](https://steampipe.io/)（組み込み PostgreSQL、port 9193）です。

- **380+ の AWS テーブル + 60+ の Kubernetes テーブル**を SQL で即座に照会 — AWS API を SQL のように扱います。
- 結果は **node-cache で 5 分キャッシュ**され、ダッシュボードの主要 23 クエリは**キャッシュウォーマーが 4 分間隔で事前にウォームアップ**してサブ秒応答を保証します。
- すべてのクエリは `src/lib/steampipe.ts` の **pg Pool**（max 10、8 sequential batch）を通じてのみ実行 — CLI（`steampipe query`）は 660 倍遅いため**コードレベルで禁止**（ADR-001）。

→ 結果: コンソールを何度もリロードする代わりに、**1 つの画面で全リソースが即座に**表示されます。

---

## 3. AWS リソースの基本ダッシュボード（43 ページ）

EC2・Lambda・ECS/ECR・EKS（Pod/Node/Deployment/Service/Explorer）・VPC・CloudFront・WAF・EBS・S3・RDS・DynamoDB・ElastiCache・MSK・OpenSearch など **43 ページ**が、リアルタイムチャートと React Flow トポロジーマップで構成されます。MSK・RDS・ElastiCache・OpenSearch・EBS は CloudWatch メトリクスまでインライン表示します。

---

## 4. Well-Architected AI 総合診断

<Screenshot src="/screenshots/monitoring/ai-diagnosis.png" alt="AI 総合診断 — Well-Architected Deep Dive レポート" />

`/ai-diagnosis` は、Amazon Bedrock **Claude Opus 4.8** がインフラ全体を自動分析して正式なレポートを作成するツールです。

- **6 つの Well-Architected ピラーのスコアカード** — Executive Summary が Operational Excellence・Security・Reliability・Performance Efficiency・Cost Optimization・Sustainability の全体にスコアを付けます。
- **3 ピラーの詳細分析（15+1 セクション）** — Cost Optimization・Security・Reliability を深く掘り下げます（コスト概要/コンピューティング/ネットワーク/ストレージ、アイドルリソース、セキュリティ状況、ネットワーク・コンピューティング・EKS・DB・MSK・ストレージ分析など）。
- **DOCX / Markdown / PDF / PPTX** エクスポート + **週次/隔週/月次スケジュール** + 完了時のメール通知。

:::note 正直なスコープ
現在、**詳細セクションは Cost・Security・Reliability の 3 ピラー**に集中しており、6 ピラー全体は **Executive Summary スコアカード**レベルで総合評価します。残り 3 ピラーの詳細セクションはロードマップです。
:::

---

## 5. コスト効率（低い TCO）

運用ツール自体のコストが低くなるよう設計されています:

- **単一 EC2 t4g.2xlarge (ARM64 Graviton)** — Steampipe の組み込み PostgreSQL を同居させ、**別途のマネージド DB コストがありません**。
- **AgentCore はサーバーレス** — AI ランタイム/ゲートウェイは呼び出し時のみ課金。
- Bedrock モデルはタスクに合わせて選択 — 分類・ルーティングは **Sonnet 4.6**、詳細診断は **Opus 4.8**、高速で低コストなタスクは **Haiku 4.5**、プロンプトキャッシング適用（ADR-016）。

さらに、このツールは**顧客インフラのコストも削減**します — Cost Explorer 分析、アイドルリソース検出、FinOps 推奨が診断レポートに含まれます。

<Screenshot src="/screenshots/monitoring/cost.png" alt="Cost Explorer — サービス/リージョン別コスト分析" />

---

## 6. マルチアカウント（単一画面）

<Screenshot src="/screenshots/overview/accounts.png" alt="マルチアカウント管理" />

- Steampipe **Aggregator パターン** — `aws` = 全アカウント統合、`aws_<id>` = 個別アカウント。上部でアカウントを切り替えるか、**全体をまとめて**表示します。
- アカウントの追加/削除は `data/config.json` の `accounts[]` 配列を修正するだけ — **コード変更不要**（ADR-008）。クロスアカウントは assume-role。

---

## 7. EKS コンテナコスト追跡（OpenCost ベース）

<Screenshot src="/screenshots/compute/eks-container-cost.png" alt="EKS コンテナコスト — OpenCost/Prometheus ベース" />

- **OpenCost + Prometheus** で、ネームスペース・Pod・ノード単位の**実使用量ベースのコスト**（CPU・Memory・Storage・GPU）を追跡します。
- OpenCost がない場合は **Request ベースのフォールバック**で推定します。
- ECS は別途 **CloudWatch Container Insights + Fargate 料金**でコンテナコストを算出します。

---

## 8. 外部オブザーバビリティ統合（7 種）+ 🆕 自然言語クエリ

<Screenshot src="/screenshots/monitoring/datasources.png" alt="外部データソース統合" />

AWS データに加え、既存のオブザーバビリティスタックを**データソースとして連携**します（SSRF 防止 allowlist、ADR-011）:

| 種類 | プラットフォーム |
|------|--------|
| Metrics | Prometheus · Dynatrace · Datadog |
| Logs | Loki · ClickHouse |
| Traces | Tempo · Jaeger |

**自然言語 → クエリ自動生成** — `/datasources/explore` で「決済サービスの 5xx の推移を見せて」のような自然言語を入力すると、AI が **PromQL / LogQL / TraceQL / SQL** に変換して実行します。AI アシスタントの `datasource` ルートが外部メトリクスに関する質問を自動分類し、同じエンジンを使用します。

:::tip セッションポイント
オブザーバビリティツールごとに異なるクエリ言語を覚える必要なく、**自然言語 1 行**で Prometheus でも Loki でも Jaeger でも照会 — オペレーターの参入障壁を大きく下げます。
:::

---

## コードで確認できる追加の強み

| 強み | 内容 |
|------|------|
| **AI ツールアーキテクチャ** | 8 つのロールベース AgentCore Gateway · **125 MCP ツール** · 19 Lambda |
| **マルチルート合成** | 分類器が質問を 11 ルートのうち 1〜3 個に分類して**並列呼び出し後に総合**（ADR-002/025） |
| **アラートパイプライン** | Webhook（CloudWatch SNS/Alertmanager/Grafana）→ 相関分析 → AI 自動診断 → Slack（ADR-009） |
| **イベント事前スケーリング** | 過去メトリクスの分析 → Bedrock が多段階ウォームアッププラン・スクリプトを生成（ADR-010、レビュー後実行） |
| **CIS コンプライアンス** | Powerpipe で CIS v1.5〜v4.0、**431 個のコントロール**をベンチマーク |
| **セキュリティ設計** | 外部呼び出しの SSRF allowlist、管理者ゲート（adminEmails）、変更操作ゲートフレームワーク（ADR-029） |
| **設計の透明性** | **32 個の ADR** — すべての主要な決定が韓国語/英語で文書化 |

<Screenshot src="/screenshots/overview/agentcore.png" alt="AgentCore ダッシュボード — Runtime/Gateway/ツールの状態" />

---

## 推奨デモフロー（顧客セッション）

1. **ダッシュボード** — 全アカウント/全リソースを 1 画面に（マルチアカウント切り替えのデモ）
2. **AI アシスタント** — 「セキュリティグループのうち 0.0.0.0/0 が開いているものを探して」のような自然言語クエリ → マルチルート動作
3. **AI 総合診断** — Well-Architected レポート生成 → DOCX/PDF エクスポート
4. **EKS コンテナコスト** — OpenCost ネームスペース別コスト
5. **自然言語オブザーバビリティクエリ** — `/datasources/explore` で PromQL 自動生成
6. **コスト/インベントリ** — 推移と削減ポイント

## さらに見る

- [ダッシュボード概要](./dashboard) · [AI アシスタント](./ai-assistant) · [AgentCore 詳細](./agentcore) · [アカウント管理](./accounts)
- [AI 総合診断](../monitoring/ai-diagnosis) · [EKS コンテナコスト](../compute/eks-container-cost) · [外部データソース](../monitoring/datasources)
- [AWSops の紹介（アーキテクチャ全体）](../intro)
