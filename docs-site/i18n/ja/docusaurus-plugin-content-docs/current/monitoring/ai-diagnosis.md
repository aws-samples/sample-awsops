---
sidebar_position: 8
title: AI 総合診断
description: （v1 レガシーページ）15 セクション診断レポート — 現行 v2 は Light/Mid/Deep（15+1）ティア、FAQ 参照
---

import Screenshot from '@site/src/components/Screenshot';

# AI 総合診断

:::caution レガシーページ（v1 基準）
このページは v1 時代の AI 診断画面（15 セクション固定カタログ・`src/` パス）を基準に書かれています。
現行 v2 は **Light / Mid / Deep（15+1 セクション、計 16 レンダー）** のティア構造です — 最新の動作は
[FAQ · AI アシスタント](../faq/ai-assistant.md)を参照してください。
:::


`/ai-diagnosis` ページは、Amazon Bedrock **Claude Opus 4.8** が 15 セクションで AWS インフラ全体を自動分析する総合レポートツールです。

<Screenshot src="/screenshots/monitoring/ai-diagnosis.png" alt="AI 総合診断ページ" />

## 概要

| 項目 | 値 |
|------|---|
| **モデル** | `global.anthropic.claude-opus-4-8`（固定） |
| **セクション数** | 15（コスト 4 + インフラ 6 + セキュリティ/ネットワーク 2 + サマリー 3） |
| **出力フォーマット** | DOCX (A4 + TOC)、Markdown、PDF（ブラウザ print） |
| **保存場所** | S3 レポートバケット + `data/reports/*.json` キャッシュ |
| **進捗ポーリング** | 5 秒間隔の SSE |
| **自動スケジュール** | 無効 / 週次 / 隔週 / 月次 (KST) |
| **メール通知** | 完了時に登録された受信者へ PDF 添付 |

## ページ構成

### 1. 上部アクションバー
- **Run Diagnosis** ボタン — 即時診断開始（全 15 セクションで平均 6〜10 分）
- **Schedule** アイコン — 自動スケジュールパネルのトグル (admin only)
- **Notification** アイコン — メール通知受信者の管理 (admin only)
- **DOCX ダウンロード** — 直近の完了レポートを即座にダウンロード

### 2. 左側 TOC サイドバー
完了したレポートを展開すると 15 セクションが TOC として表示され、クリックすると該当セクションへスクロールします。複数展開が可能で、複数のセクションを同時に比較できます。

### 3. レポート履歴テーブル
| カラム | 説明 |
|------|------|
| 生成時刻 | YYYY-MM-DD HH:MM (KST) |
| アカウント | 対象アカウントのエイリアス（マルチアカウントの場合） |
| ステータス | completed / generating / failed |
| ダウンロード | DOCX · MD · PDF |

ページネーション: 1 ページ 5 件、日付範囲フィルターで絞り込めます。

## 15 セクション（実際の定義順）

`src/lib/report-prompts.ts` の `REPORT_SECTIONS` 配列の順序どおり：

| # | section ID | 日本語タイトル | 英語タイトル |
|---|------------|-----------|-----------|
| 1 | `cost-overview` | コスト状況 | Cost Overview |
| 2 | `cost-compute` | コンピューティングコスト詳細分析 | Compute Cost Deep Dive |
| 3 | `cost-network` | ネットワーク転送コスト | Network & Data Transfer Cost |
| 4 | `cost-storage` | ストレージコスト詳細分析 | Storage Cost Deep Dive |
| 5 | `idle-resources` | アイドルリソース & 無駄 | Idle Resources & Waste |
| 6 | `security-posture` | セキュリティ状況 | Security Posture |
| 7 | `network-architecture` | ネットワークアーキテクチャ | Network Architecture |
| 8 | `compute-analysis` | コンピューティングインフラ分析 | Compute Infrastructure |
| 9 | `eks-analysis` | EKS & コンテナ分析 | EKS & Container Analysis |
| 10 | `database-analysis` | データベース分析 | Database Analysis |
| 11 | `msk-analysis` | MSK & ストリーミング分析 | MSK & Streaming Analysis |
| 12 | `storage-analysis` | ストレージインフラ分析 | Storage Infrastructure |
| 13 | `executive-summary` | 総合サマリー | Executive Summary |
| 14 | `recommendations` | 推奨事項 & ロードマップ | Recommendations & Roadmap |
| 15 | `appendix` | 付録: リソースインベントリ | Appendix: Resource Inventory |

:::tip 実行順序 vs 報告順序
プロンプトの順序は `cost-overview` から始まりますが、**Executive Summary**（13 番）は他のセクションの結果を要約するために最後に合成されます。TOC には定義順で表示されます。
:::

## レポート生成の流れ

1. **Run Diagnosis** をクリック → POST `/awsops/api/report`（action: `generate`）
2. `collectReportData()` が Steampipe + CloudWatch + Cost Explorer のデータを収集
3. `REPORT_SECTIONS` の 15 個を Opus に順次送信（各セクション約 30〜60 秒）
4. ページが 5 秒ごとに GET `?action=status&id=<reportId>` をポーリング → 進捗率を表示
5. 完了時:
   - DOCX を自動生成 → S3 へアップロード
   - Markdown は即座に利用可能
   - PDF はブラウザの Print ダイアログをトリガーする方式
   - メール通知が有効なら受信者へ送信

## 自動スケジューリング

スケジュールパネルで以下の項目を設定します（admin 専用 — `adminEmails` チェック）：

| フィールド | 値 |
|------|---|
| `enabled` | true/false |
| `frequency` | `weekly` / `biweekly` / `monthly` |
| `dayOfWeek` | 0（日）〜6（土）— weekly/biweekly で使用 |
| `dayOfMonth` | 1〜28 — monthly で使用 |
| `hour` | 0〜23（KST 基準、デフォルト 6 時） |
| `accountId` | 特定アカウントに限定（空欄なら全体） |
| `lang` | `ko` / `en` |

設定は `data/report-schedule.json` に保存され、`startScheduler()` が毎時 `isDue()` で確認してトリガーします。`nextRunAt` は KST 基準で計算されます。

:::info biweekly のセーフガード
隔週の場合、直前の実行から 13 日未満かつ次の実行まで 7 日未満であれば、自動的に +7 日を加算して最小の隔週間隔を保証します (`report-scheduler.ts:85-93`)。
:::

## メール通知

通知パネルで受信者メールの一覧を管理します。診断完了時：
- 件名: `[AWSops] AI Diagnosis Report — {YYYY-MM-DD}`
- 本文: セクション数、主要な推奨事項のサマリー、ダウンロードリンク
- 添付: PDF（任意）

受信者リストは `data/report-schedule.json` の `notifEmails` フィールドに併せて保存されます。

## ダウンロードフォーマット詳細

| フォーマット | 生成経路 | 特徴 |
|------|----------|------|
| **DOCX** | `lib/report-docx.ts` → API `download-docx` | A4 ライトテーマ、TOC、ヘッダー/フッター/ページ番号、マークダウン→段落/表/箇条書き変換 |
| **Markdown** | API `download-md` | 元テキスト（15 セクションをすべて連結） |
| **PDF** | `/ai-diagnosis/report` ページ + ブラウザ Print | ホワイト背景、A4 ページブレーク、別途 PDF ライブラリなし（bundle size 保護） |

:::tip PDF ライブラリを追加しない理由
ADR-019: 別途の PDF ライブラリ（Puppeteer など）は Next.js のバンドルサイズと EC2 メモリを大幅に増加させます。代わりに印刷用ページを作成し、ブラウザの Print-to-PDF を活用します — 成果物の品質は同等でありながら依存関係は 0 個です。
:::

## アラートパイプラインとの連携

リアルタイムアラートシステム（CloudWatch / Alertmanager / Grafana）が `critical` として集計されると、**部分診断**をトリガーできます (`alert-diagnosis.ts`)：

- 影響を受けたサービス/リソースの範囲でセクションを自動選択（通常 3〜5 セクション）
- 1〜2 分以内に完了
- 結果を Slack 通知スレッドに reply

詳細な流れは[アラートパイプライン](./alerts.md)のドキュメントを参照してください。

## トラブルシューティング

| 症状 | 原因 | 解決策 |
|------|------|------|
| 10 分以上停止 | Steampipe クエリのタイムアウト | `nextjs` ログで `statement_timeout` を確認後、該当セクションのみ再実行 |
| DOCX ダウンロード失敗 | S3 アップロード失敗 (IAM) | EC2 インスタンスプロファイルに `s3:PutObject` 権限を確認 |
| 毎日 0 時に実行される | `dayOfMonth` 未設定 | monthly 使用時は 1〜28 の範囲で明示 |
| メールが届かない | SNS トピックの購読未確認 | メール受信トレイで SNS confirm をクリック |

## API の直接呼び出し

```bash
# 診断を開始
curl -X POST /awsops/api/report \
  -H 'Content-Type: application/json' \
  -d '{"action":"generate","lang":"ko"}'

# 進行状況の確認
curl '/awsops/api/report?action=status&id=<reportId>'

# 一覧の取得 (ページネーション)
curl '/awsops/api/report?action=list&page=1&pageSize=5'

# スケジュールの変更
curl -X POST /awsops/api/report \
  -H 'Content-Type: application/json' \
  -d '{"action":"set-schedule","schedule":{"enabled":true,"frequency":"weekly","dayOfWeek":1,"hour":6,"lang":"ko"}}'
```

## 関連ページ

- [アラートパイプライン](./alerts.md) — 部分診断のトリガー
- [Resource Inventory](./inventory.md) — Appendix セクションのデータソース
- [Compliance](../security/compliance) — Security Posture セクションのソース
- [Cost Explorer](./cost) — コスト 4 セクションのソース

## 参考

- ADR-019: 診断レポートのフォーマットマトリクス
- ADR-014: レポートのプロキシダウンロード URL
- ADR-016: Bedrock モデル選択戦略（Opus 4.8 固定）
- `src/lib/report-prompts.ts` — 15 セクションのプロンプト定義（正確な出力構造）
- `src/lib/report-scheduler.ts` — スケジュール計算ロジック（KST 基準）
