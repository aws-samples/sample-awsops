---
sidebar_position: 6
title: EKS Explorer
description: K9s スタイルのターミナル UI で Kubernetes リソースを探索
---

import Screenshot from '@site/src/components/Screenshot';

# EKS Explorer

K9s スタイルのターミナル UI で Kubernetes リソースを探索できるページです。

<Screenshot src="/screenshots/compute/eks-explorer.png" alt="EKS Explorer" />

## 主な機能

### 上部バー
- **K9s | Explorer**: 現在のページを表示
- **クラスター選択**: ドロップダウンでクラスターを選択
- **リソース数**: 現在表示中のリソースの個数
- **Auto Refresh**: 30 秒ごとの自動更新トグル
- **Refresh**: 手動更新ボタン

### ノードヘッダー(折りたたみ/展開)
クリックするとノード一覧とリソース使用量を表示:
- ノード別の CPU/Memory 使用量バー
- ノード数の表示

### リソースタブ
10 種類の Kubernetes リソースをタブで切り替え:

| タブ | リソース | 主なカラム |
|----|--------|-----------|
| Pods | Pod | NAME, NAMESPACE, STATUS, NODE, AGE |
| Deploy | Deployment | NAME, NAMESPACE, DESIRED, AVAILABLE, READY |
| SVC | Service | NAME, NAMESPACE, TYPE, CLUSTER-IP, AGE |
| RS | ReplicaSet | NAME, NAMESPACE, DESIRED, READY, AVAILABLE |
| DS | DaemonSet | NAME, NAMESPACE, DESIRED, CURRENT, READY |
| STS | StatefulSet | NAME, NAMESPACE, DESIRED, READY |
| Jobs | Job | NAME, NAMESPACE, ACTIVE, SUCCEEDED, FAILED |
| CM | ConfigMap | NAME, NAMESPACE, AGE |
| Sec | Secret | NAME, NAMESPACE, TYPE, AGE |
| PVC | PersistentVolumeClaim | NAME, NAMESPACE, STATUS, STORAGECLASS, CAPACITY |

### フィルター
- **Search**: テキスト検索(すべてのフィールド)
- **Namespace**: ネームスペースフィルター
- **Status**: ステータスフィルター(Running、Pending など)
- **Node**: ノードフィルター(Pod タブ)
- **Clear**: フィルターのリセット

### ページネーション
- 1 ページあたりの行数: 25、50、100、200
- ページ移動: Prev / Next

### 詳細パネル
リソースをクリックすると右側に詳細パネルが開きます:
- YAML 形式の詳細情報
- リソースタイプごとに最適化された情報を表示

### ステータスバー
- キーボードショートカットの案内(Tab、Enter、Esc、/)
- Auto-refresh の状態表示
- 現在のリソースタイプとネームスペース

## 使い方

1. サイドバーで **Compute > K8s > Explorer** をクリックします
2. 上部でクラスターを選択します
3. タブをクリックしてリソースタイプを切り替えます
4. 検索とフィルターで目的のリソースを探します
5. リソースをクリックして詳細情報を確認します

## キーボードショートカット

| キー | 動作 |
|----|------|
| Tab | リソースタブの切り替え |
| Enter | 選択したリソースの詳細表示 |
| Esc | 詳細パネルを閉じる |
| / | 検索ボックスにフォーカス |

## 利用のヒント

:::tip ネームスペースフィルターの活用
特定のネームスペースのリソースだけを表示するには、ネームスペースのドロップダウンを使用してください。システムネームスペース(kube-system)を除外して、アプリケーションのネームスペースのみを表示できます。
:::

:::tip Auto Refresh
運用監視の際に Auto 30s を有効にすると、30 秒ごとに自動でデータが更新されます。
:::

:::info AI 分析
AI Assistant で「kube-system ネームスペースの Pod 一覧」「Pending 状態の Pod を探して」「特定ノードの Pod を分析して」などで分析できます。
:::

## 関連ページ

- [EKS Overview](../compute/eks) - クラスター全体の状況
- [EKS Pods](../compute/eks-pods) - Pod の詳細ダッシュボード
- [EKS Deployments](../compute/eks-deployments) - デプロイメントの詳細
- [EKS Services](../compute/eks-services) - サービスの詳細
