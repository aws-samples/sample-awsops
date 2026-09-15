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
- **クラスター登録ボタン（管理者）**: 未接続クラスターを 3 つのモードで登録 — Access Entry 照会登録（既存の Access Entry を確認して登録 — 実行時に Access Entry を新規作成しない [ADR-005]。存在しない場合は 409 と Terraform/CLI オンボーディングスクリプトを案内）、ServiceAccount トークン（クラスター内に読み取り専用 SA を作成しトークンを貼り付け — AWS 側の設定不要）、AssumeRole（そのクラスターに既に Access Entry を持つ IAM ロールで K8s 認証 — ロール ARN + external ID。ロール名は必ず `AWSopsReadOnlyRole`[web タスクの sts:AssumeRole 権限がこの名前に固定]、クラスター自体はホストアカウント所属である必要があり、登録ルートがホストのクラスター一覧で検証）。Terraform 経路は `make configure` の EKS 複数選択 → `eks.tf` が web タスクロールに Access Entry + AmazonEKSAdminViewPolicy を付与
- **クリックフィルタリング**: クラスターカードをクリックすると該当クラスターのみにフィルタリング(シアンの枠線)

:::tip クラスターへのアクセス権限
クラスターが登録されているのにどのクラスターからもライブデータを読み取れない場合、ページ上部に失敗理由（生のエラー）と本ガイドへのリンクを含むアクセス不可バナーが表示されます。未接続のクラスターはデータを取得できません — クラスター登録ボタン（照会登録 / SA トークン / AssumeRole）または Terraform オンボーディング（`make configure` → `eks.tf`）で接続してください。照会登録が 409 を返した場合は、画面に表示されるオンボーディングスクリプトをクラスター所有者に渡してください。
:::

### 統計カード(クリックで移動)
各カードをクリックすると詳細ページに移動します:
- **Nodes** → ノード詳細(`/eks/nodes`)
- **Pods** → Pod 詳細(`/eks/pods`)
- **Deployments** → デプロイメント詳細(`/eks/deployments`)
- **Services** → サービス詳細(`/eks/services`)

### ノードカードグリッド
各ノードのリソース使用量を視覚的に表示:
- ノード名、Pod 数、状態(Ready/NotReady)
- **CPU 使用量バー**: Pod のリクエスト量 / 全体容量(パーセント)
- **Memory 使用量バー**: Pod のリクエスト量 / 全体容量(パーセント)
- 80% 以上: 赤、50% 以上: オレンジ、それ以外: シアン/紫

### ノード詳細ビュー
ノードカードをクリックすると詳細ページに移動:
- **CPU/Memory/Pod Info カード**: Capacity、Allocatable、Requested、Available
- **ENI 一覧**: ネットワークインターフェイス別の IP 割り当て + インスタンスネットワークトラフィックタイル（In/Out バイト・パケット — 完結した直前 1 時間バケットの累計と平均レート；CloudWatch に ENI 別の次元がないためインスタンスレベルの値）
- **Pods テーブル**: 該当ノードで実行中の Pod 一覧

### 可視化チャート

- **Pod Status Distribution**: Running、Pending、Failed、Succeeded の分布(円グラフ)
- **Pods per Namespace**: ネームスペース別の Pod 数(棒グラフ)

### Warning Events テーブル
Kubernetes の Warning イベントをリアルタイムで表示:
- Kind、Object、Reason、Message、Count、Last Seen

## 使い方

1. サイドバーで **Compute > EKS** をクリックします
2. クラスターカードをクリックして特定のクラスターにフィルタリングします
3. 統計カードをクリックすると Pods/Nodes/Deployments/Services の詳細ページに移動します
4. ノードカードでリソース使用率の高いノードを特定します
5. ノードをクリックして詳細リソースと Pod 一覧を確認します
6. Warning Events で問題のあるイベントを監視します

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
