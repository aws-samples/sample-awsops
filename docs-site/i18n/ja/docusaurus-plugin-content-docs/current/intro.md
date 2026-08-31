---
sidebar_position: 1
title: AWSops の紹介
description: AWS・Kubernetes の運用をリアルタイムに見て、問いかけ、診断できる統合ダッシュボード
---

import Screenshot from '@site/src/components/Screenshot';

# AWSops の紹介

AWSops は、AWS と Kubernetes の運用状況を**リアルタイムに見て、自然言語で問いかけ、AI で診断**できる統合運用ダッシュボードです。リソースインベントリ・コスト・トポロジー・EKS をひとつの画面で確認し、疑問点は AI アシスタントに質問し、アカウント全体の運用状態は AI 診断レポートとして受け取ることができます。

<Screenshot src="/screenshots/overview/dashboard.png" alt="AWSops ダッシュボード" />

## できること

- **一目でわかるダッシュボード** — コンピュート・ストレージ・ネットワーク・セキュリティ・コストの KPI と分布チャートをメイン画面に集約して表示します。
- **AI アシスタント** — 運用に関する質問を自然言語で行うと、質問が自動的に適切なドメインへルーティングされ、回答が Markdown で返されます。
- **AI 診断** — アカウントの運用状態を分析した総合レポートを深度別に生成し、MD・DOCX・PDF でエクスポートします。
- **リソースインベントリ** — EC2・Lambda・RDS・S3・VPC・IAM など 20 種類超のリソースをソート・検索・詳細表示します。
- **トポロジー** — Route53 → CloudFront → LB → Target Group → ターゲットへと続くリクエストフローをグラフで探索します。
- **EKS / Kubernetes** — クラスターフリートとノード・ポッド・デプロイメントを読み取り専用で確認します。
- **コスト分析** — サービス別のコスト内訳と推移、Bedrock モデルの使用量を確認します。
- **データソース探索** — 接続された可観測性データソースをネイティブクエリ言語で照会します。

:::info 読み取り専用の運用ダッシュボード
AWSops は AWS リソースを**変更しません。** 現状の観察と分析・診断に集中し、インストールや変更が必要な作業(例: OpenCost)についてはユーザー自身が実行できるようガイドとスクリプトを提供します。
:::

## 次のステップ

- [ログイン](./getting-started/login) — ダッシュボードへのアクセス方法
- [画面構成とテーマ](./getting-started/navigation) — サイドバー・コマンドパレット・テーマ・モバイル
- [ダッシュボード](./overview/dashboard) — メイン画面を見てみる
- [AI アシスタント](./overview/assistant) — 自然言語で質問する
- [AI 診断](./operations/ai-diagnosis) — 総合診断レポートを作成する
