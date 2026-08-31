---
sidebar_position: 5
title: EKS Overview
description: EKS クラスターの状況、ノードリソース、Pod 状態の要約
---

import Screenshot from '@site/src/components/Screenshot';

# EKS Overview

EKS クラスターの全体状況、ノードリソース、Pod の状態を一目で確認できるページです。

<Screenshot src="/screenshots/compute/eks.png" alt="EKS Overview" />

## 主な機能

### クラスターフィルター
- EKS クラスター別のフィルタリング
- VPC 別のフィルタリング
- 複数選択に対応

### EKS クラスターカード
各クラスターの主要情報をカード形式で表示:
- Cluster Name、Status (ACTIVE)
- Kubernetes Version、VPC ID、Platform Version、Region
- **Access Entry ステータスバッジ**: K8s Connected(緑)/ 未登録(赤)
- **Register ViewPolicy ボタン**: 未登録クラスターに Access Entry + AdminViewPolicy を自動登録
- **クリックフィルタリング**: クラスターカードをクリックすると該当クラスターのみにフィルタリング(シアンの枠線)

:::tip クラスターへのアクセス権限
Access Entry が未登録のクラスターはデータを取得できません。「Register ViewPolicy」ボタンで登録するか、クラスターの所有者に[認証ガイド](./eks-auth)を参照して登録を依頼してください。
:::

### 統計カード(クリックで移動)
各カードをクリックすると詳細ページに移動します:
- **Nodes** → ノード詳細(`/k8s/nodes`)
- **Pods** → Pod 詳細(`/k8s/pods`)
- **Deployments** → デプロイメント詳細(`/k8s/deployments`)
- **Services** → サービス詳細(`/k8s/services`)

### ノードカードグリッド
各ノードのリソース使用量を視覚的に表示:
- ノード名、Pod 数、状態(Ready/NotReady)
- **CPU 使用量バー**: Pod のリクエスト量 / 全体容量(パーセント)
- **Memory 使用量バー**: Pod のリクエスト量 / 全体容量(パーセント)
- 80% 以上: 赤、50% 以上: オレンジ、それ以外: シアン/紫

### ノード詳細ビュー
ノードカードをクリックすると詳細ページに移動:
- **CPU/Memory/Pod Info カード**: Capacity、Allocatable、Requested、Available
- **ENI 一覧**: ネットワークインターフェイス別の IP 割り当て、トラフィック(NetworkIn/Out)
- **Pods テーブル**: 該当ノードで実行中の Pod 一覧

### 可視化チャート(タブ切り替え)

**Pod Analysis タブ:**
- **Pod Status Distribution**: Running、Pending、Failed、Succeeded の分布(円グラフ)
- **Pods per Namespace**: ネームスペース別の Pod 数(棒グラフ)

**Service Resources タブ:**
- **CPU per Service (millicores)**: Service に属する Pod の CPU リクエスト量の合計(棒グラフ)
- **Memory per Service (MiB)**: Service に属する Pod の Memory リクエスト量の合計(棒グラフ)

### Warning Events テーブル
Kubernetes の Warning イベントをリアルタイムで表示:
- Kind、Object、Reason、Message、Count、Last Seen

## 使い方

1. サイドバーで **Compute > EKS** をクリックします
2. クラスターカードをクリックして特定のクラスターにフィルタリングします
3. 統計カードをクリックすると Pods/Nodes/Deployments/Services の詳細ページに移動します
4. ノードカードでリソース使用率の高いノードを特定します
5. ノードをクリックして詳細リソースと Pod 一覧を確認します
6. **Service Resources** タブで Service 別の CPU/Memory 割り当て量を分析します
7. Warning Events で問題のあるイベントを監視します

## 利用のヒント

:::tip ノードリソースの監視
ノードカードの CPU/Memory バーが赤(80% 以上)の場合、リソース不足のリスクがあります。ノードの追加または Pod の再配置を検討してください。
:::

:::tip ENI の IP 使用量
ノード詳細ビューで ENI ごとの IP Slots Used が 15/15 に近い場合、新しい Pod のスケジューリングが失敗する可能性があります。
:::

:::info AI 分析
AI Assistant で「EKS クラスターの状態」「ノード別 CPU 使用量」「Warning イベントを分析して」などで分析できます。
:::

## 関連ページ

- [EKS 認証設定](./eks-auth) - Access Entry / aws-auth の認証ガイド
- [EKS Explorer](./eks-explorer) - K9s スタイルのターミナル UI
- [EKS Pods](./eks-pods) - Pod の詳細一覧
- [EKS Nodes](./eks-nodes) - ノードの詳細一覧
- [EKS Deployments](./eks-deployments) - デプロイメント一覧
- [EKS Services](./eks-services) - サービス一覧
- [EKS Container Cost](./eks-container-cost) - Pod のコスト分析(OpenCost)
