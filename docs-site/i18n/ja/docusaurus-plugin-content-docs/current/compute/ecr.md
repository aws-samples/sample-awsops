---
sidebar_position: 4
title: ECR
description: ECR リポジトリ、イメージ、脆弱性スキャン情報
---

import Screenshot from '@site/src/components/Screenshot';

# ECR (Elastic Container Registry)

ECR リポジトリとイメージ情報を確認できるページです。

:::info v2 での提供方法
この画面は専用ページではなく、v2 の共通インベントリビュー（`/inventory/ecr`、サイドバーの「コンピュート」グループ）から提供されます。以下の内容は v1 の専用 ECR ページではなく、v2 インベントリビューの実際の構成（`web/lib/inventory-types.ts` の `HIGHLIGHTS.ecr`/`INVENTORY_TYPES.ecr`）に基づいています。
:::

<Screenshot src="/screenshots/compute/ecr.png" alt="ECR" />

## 主な機能

### ハイライトカード
- **Scan on Push**: イメージのプッシュ時に自動スキャンが有効化されているリポジトリ数
- **タグ不変**: タグ不変性(IMMUTABLE)が設定されているリポジトリ数
- **タグ変更可能**: タグ変更可能(MUTABLE)が設定されているリポジトリ数

リポジトリの総数を表示するカードはありません(テーブルの行数で確認します)。

### リポジトリテーブル
| カラム | 説明 |
|------|------|
| URI | リポジトリ URI(イメージのプッシュ/プル用アドレス) |
| Tag mutability | タグの変更可否(MUTABLE/IMMUTABLE) |
| Scan on Push (Basic) | リポジトリレベルの基本スキャン設定 (Yes/No) |
| Created | 作成日 |

暗号化タイプは**テーブルのカラムではありません** — 下の詳細パネルで確認します。Scan on Push (Basic) カラムはリポジトリレベルの基本スキャン設定のみを反映し、レジストリレベルの Inspector 拡張スキャンは反映しません。

### 詳細パネル
リポジトリをクリックすると詳細情報を確認できます:
- **Identity セクション**: Name、Account、Region、ARN、Registry ID、URI、Created
- **Config セクション**: Tag Mutability、Image Scanning Configuration(Scan on Push を含む)、Lifecycle Policy
- **Security セクション**: Encryption Configuration(AES256/KMS)
- **Tags セクション**: リポジトリに設定されたタグ

## 使い方

1. サイドバーで **Compute > ECR** をクリックします
2. 上部のハイライトカードで Scan on Push とタグ不変性の状況を把握します
3. リポジトリをクリックして詳細な URI、Scan on Push、Encryption 設定を確認します

## セキュリティ設定ガイド

### Scan on Push
- **推奨**: すべてのリポジトリで有効化
- イメージのプッシュ時に自動で脆弱性スキャンを実行
- 検出された CVE は Security ページで確認可能

### Immutable Tags
- **推奨**: 本番用リポジトリで有効化
- 一度プッシュされたタグは上書きできません
- デプロイの追跡とロールバックに有利

### Encryption
- **AES256**: デフォルトの AWS マネージド暗号化
- **KMS**: カスタマーマネージドキー(CMK)を使用する場合

## 利用のヒント

:::tip Scan on Push の有効化
ハイライトカードの Scan on Push 数がリポジトリ総数より少ない場合、一部のリポジトリでスキャンが無効になっています。各リポジトリの詳細パネルの Config セクションで個別に確認してください。
:::

:::tip イメージ URI のコピー
詳細パネルの URI フィールドで、`docker pull` または `docker push` に使用する完全なアドレスを確認できます。
:::

:::info AI 分析
AI Assistant で「ECR リポジトリの一覧」「スキャンが無効なリポジトリを探して」「コンテナイメージの脆弱性を分析して」などで分析できます。
:::

## 関連ページ

- [ECS](../compute/ecs) - ECR イメージを使用する ECS サービス
- [EKS](../compute/eks) - ECR イメージを使用する EKS クラスター
- [Security](../security) - イメージ脆弱性(CVE)の確認
