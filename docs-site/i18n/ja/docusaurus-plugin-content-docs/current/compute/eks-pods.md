---
sidebar_position: 7
title: EKS Pods
description: Kubernetes Pod の一覧、ステータス、コンテナ情報
---

import Screenshot from '@site/src/components/Screenshot';

# EKS Pods

Kubernetes Pod の詳細な一覧とステータスを確認できるページです。

<Screenshot src="/screenshots/compute/eks-pods.png" alt="EKS Pods" />

## 主な機能

### 統計カード
- **Total Pods**: 全 Pod 数（シアン）
- **Running**: 実行中の Pod 数（緑）
- **Pending**: 待機中の Pod 数（オレンジ）
- **Failed**: 失敗した Pod 数（赤）

### Pod Status Distribution チャート
Pod のステータス別分布を円グラフで可視化します:
- **Running**: 正常に実行中
- **Pending**: スケジューリング待機またはイメージプル中
- **Failed**: 実行失敗
- **Succeeded**: 完了（Job など）

### Pod 一覧テーブル
| カラム | 説明 |
|------|------|
| Name | Pod 名 |
| Namespace | ネームスペース |
| Status | ステータス（StatusBadge） |
| Node | 実行中のノード |
| Created | 作成時刻 |

### ステータス別の色
- **Running**: 緑
- **Pending**: オレンジ
- **Failed**: 赤
- **Succeeded**: シアン
- **Unknown**: グレー

## 使い方

1. サイドバーで **Compute > K8s > Pods** をクリックします
2. 統計カードで全体の Pod ステータス分布を確認します
3. Pending または Failed の Pod があれば原因を調査します
4. テーブルで特定 Pod のノード配置を確認します

## Pod ステータスの理解

| ステータス | 説明 | 対応 |
|------|------|------|
| Pending | スケジューリング待機、イメージプル中、リソース不足 | ノードリソース、イメージへのアクセス権限を確認 |
| Running | 正常に実行中 | - |
| Succeeded | 完了（Job、CronJob） | 正常終了 |
| Failed | コンテナの異常終了 | ログの確認、リソース制限の見直し |
| Unknown | ノードとの通信問題 | ノードの状態を確認 |

## 活用のヒント

:::tip Pending Pod の診断
Pending 状態が長く続く場合は、次を確認してください:
- ノードリソース不足（CPU/Memory）
- イメージプル失敗（imagePullBackOff）
- PVC のバインド待ち
- nodeSelector/affinity 条件の不一致
:::

:::tip Failed Pod の分析
Failed の Pod はコンテナログとイベントを確認してください:
- OOMKilled: メモリ制限の超過
- CrashLoopBackOff: 繰り返しのクラッシュ
- Error: アプリケーションエラー
:::

:::info AI 分析
AI Assistant で「Pending Pod の一覧」「Failed Pod の原因分析」「特定ネームスペースの Pod 状態」などの分析ができます。
:::

## 関連ページ

- [EKS Overview](../compute/eks) - クラスター全体の状況
- [EKS Nodes](../compute/eks-nodes) - ノードリソースの確認
- [EKS Explorer](../compute/eks-explorer) - 詳細なリソース探索
- [EKS Container Cost](../compute/eks-container-cost) - Pod のコスト分析
