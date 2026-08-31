---
sidebar_position: 9
title: EKS Deployments
description: Kubernetes Deployment の一覧、レプリカ状態、更新戦略
---

import Screenshot from '@site/src/components/Screenshot';

# EKS Deployments

Kubernetes Deployment のレプリカ状態と可用性を確認できるページです。

<Screenshot src="/screenshots/compute/eks-deployments.png" alt="EKS Deployments" />

## 主な機能

### 統計カード
- **Total Deployments**: 全 Deployment 数（シアン）
- **Fully Available**: 望ましいレプリカがすべて利用可能な Deployment 数（緑）
- **Partially Available**: 一部のレプリカのみ利用可能な Deployment 数（オレンジ）

### Replica Comparison チャート
Desired と Available のレプリカを視覚的に比較します:
- **シアンの半透明バー**: Desired（望ましいレプリカ数）
- **緑のバー**: Available（実際に利用可能なレプリカ数）
- Deployment ごとに `available/desired` の数値を表示

### Deployment テーブル
| カラム | 説明 |
|------|------|
| Name | Deployment 名 |
| Namespace | ネームスペース |
| Desired | 望ましいレプリカ数 |
| Available | 利用可能なレプリカ数 |
| Ready | Ready 状態のレプリカ数 |
| Created | 作成時刻 |

## レプリカ状態の理解

| 状態 | 説明 | 対応 |
|------|------|------|
| Desired = Available = Ready | 完全に正常 | - |
| Available < Desired | 一部の Pod が利用不可 | Pod の状態を確認 |
| Ready < Available | ヘルスチェック失敗 | アプリケーションログを確認 |
| Available = 0 | すべての Pod が利用不可 | 緊急対応が必要 |

## 使い方

1. サイドバーで **Compute > K8s > Deployments** をクリックします
2. 統計カードで Partially Available の数を確認します
3. Replica Comparison チャートで問題のある Deployment を特定します
4. テーブルで詳細なレプリカ数を確認します

## Deployment の更新戦略

### RollingUpdate（デフォルト）
- 新バージョンの Pod を段階的に作成し、旧バージョンを終了
- `maxSurge`: 同時に作成できる追加 Pod 数
- `maxUnavailable`: 同時に利用不可にできる Pod 数

### Recreate
- すべての旧バージョン Pod を終了してから新バージョンを作成
- ダウンタイムが発生、リソース競合を防ぐ場合に使用

## 活用のヒント

:::tip Partially Available の診断
Available が Desired より少ない場合:
1. Pod の状態を確認（Pending、Failed）
2. ノードリソース不足の有無を確認
3. イメージプルエラーを確認
4. Readiness Probe の失敗を確認
:::

:::tip ロールアウトのモニタリング
デプロイ中は Available が一時的に Desired を下回ることがあります。デプロイ完了後も差がある場合は問題です。
:::

:::info AI 分析
AI Assistant で「Deployment の状態」「レプリカが不一致の Deployment を探して」「デプロイ失敗の原因を分析して」などの分析ができます。
:::

## 関連ページ

- [EKS Overview](../compute/eks) - クラスター全体の状況
- [EKS Pods](../compute/eks-pods) - Deployment の Pod を確認
- [EKS Explorer](../compute/eks-explorer) - ReplicaSet の詳細確認
- [EKS Services](../compute/eks-services) - Deployment に接続された Service
