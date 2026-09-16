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
- アカウント・リージョンの選択
- EKS クラスター別のフィルタリング
- VPC 別のフィルタリング
- 複数選択に対応

アカウント・リージョンを変更すると、クラスター一覧・統計・クラスター内リソースを再取得します。同名クラスターはカードの **Account** と **Region** で区別してください。

:::info 検出範囲
表示は選択して実際に照会した範囲の結果です。一部の照会失敗や取得上限に達した場合、結果は不完全です。全リージョン（ワイルドカード）の検出も設定済み・登録済みのリージョンだけが対象で、AWS の全リージョンを網羅しません。見つからない場合は対象リージョンを明示して照会し、未表示を「クラスターが存在しない」と解釈しないでください。
:::

### EKS クラスターカード
各クラスターの主要情報をカード形式で表示:
- Cluster Name、Status (ACTIVE)
- Kubernetes Version、VPC ID、Platform Version、Account、Region
- **Access Entry ステータスバッジ**: K8s Connected(緑)/ 未登録(赤)
- **クラスター登録ボタン（管理者）**: 登録済みで有効なメンバーアカウントのクラスターにも対応し、次の 3 モードから選択します。
  - **Access Entry 照会登録（既定）**: 対象クラスターにあるホストの web タスクロールの `STANDARD` Access Entry を確認して登録します。所有者が事前に Entry と読み取り用の `AmazonEKSAdminViewPolicy` を付与します。AWSops が実行時に Entry や AWS リソースを新規作成することはありません（ADR-005）。
  - **ServiceAccount トークン**: 所有者が対象クラスターに用意した読み取り専用 SA のトークンを保存し、Kubernetes 認証に使用します。SA 認証に IAM Access Entry は不要ですが、メンバーアカウントの EKS メタデータ取得には、そのアカウントの登録済み読み取りロールが引き続き必要です。
  - **明示的な AssumeRole による Kubernetes 認証**: ロール ARN と、必要に応じて external ID を指定します。そのロールは web タスクから引き受け可能で、対象クラスター内の読み取り権限が必要です。既定のデプロイ権限は `AWSopsReadOnlyRole` を対象にします。入力検証がこの名前だけを要求するわけではありませんが、別名のロールには対応する IAM 権限・信頼設定が必要で、任意のロールがそのまま使えるわけではありません。
- **クリックフィルタリング**: クラスターカードをクリックすると該当クラスターのみにフィルタリング(シアンの枠線)

:::tip クラスターへのアクセス権限
クラスターが登録されているのにどのクラスターからもライブデータを読み取れない場合、ページ上部に失敗理由（生のエラー）と本ガイドへのリンクを含むアクセス不可バナーが表示されます。未接続のクラスターは、対象スコープを確認して照会登録 / SA トークン / AssumeRole を設定してください。照会登録が 409 を返した場合は、画面に表示される対象アカウント・リージョン用のオンボーディングスクリプトをクラスター所有者に渡してください。
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

## クロスアカウントのオンボーディング

1. **Accounts** でメンバーアカウントと対象リージョンを登録・有効化し、ホストの web タスクが対象アカウントの登録済み読み取りロールを引き受けられるようにします。
2. EKS ページでそのアカウント・リージョンを選択し、カードの **Account** と **Region** を確認します。
3. 既定モードでは、クラスター所有者が対象アカウント・リージョンで案内コマンドを実行し、**ホストの web タスクロール**に `STANDARD` Access Entry と `AmazonEKSAdminViewPolicy` を付与します。
4. 管理者が **照会登録** をクリックします。登録は対象クラスターを直接 `DescribeCluster` で確認し、アプリの登録情報を保存します。AWS リソースは作成しません。

メタデータ取得は対象アカウントの登録済み読み取りロールを使用しますが、既定の Kubernetes bearer トークンはホストの web タスクロールの認証情報で署名します。SA トークン / 明示的な AssumeRole は別途選択する Kubernetes 認証の上書きで、メタデータ取得権限の代わりにはなりません。どの認証モードでも、web タスクから対象 Kubernetes API へのネットワーク到達性が必要です。

`make configure` → `eks.tf` はホスト側のプロビジョニング専用です。メンバーアカウントやデプロイ先以外のリージョンは、所有者のコマンド実行後に手動で照会登録してください。これらのスコープで EventBridge による自動登録は前提にできません。

登録時の **404** は選択した対象アカウント・リージョンでクラスターが見つからないこと、**409** は既定モードの Access Entry がないか確認できないこと、**503** は対象情報の照会や登録ストレージが利用できないことを示します。取得不能を正常な「0 件」と解釈しないでください。

## 使い方

1. サイドバーで **Compute > EKS** をクリックします
2. アカウント・リージョンを選択し、クラスターカードをクリックして特定のクラスターにフィルタリングします
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
