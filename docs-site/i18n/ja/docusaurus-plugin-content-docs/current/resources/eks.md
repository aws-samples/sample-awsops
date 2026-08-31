---
sidebar_position: 2
title: EKS / Kubernetes
description: EKS クラスターフリートとクラスター内リソースを読み取り専用で照会
---

import Screenshot from '@site/src/components/Screenshot';

# EKS / Kubernetes

EKS クラスターフリートとクラスター内部のリソースを、読み取り専用で一目で照会できるページです。

<Screenshot src="/screenshots/resources/eks.png" alt="EKS クラスターフリート" />

## 主な機能

### KPI カード
フリート全体の主要指標を上部のカードで表示します。

| カード | 意味 |
|------|------|
| **Clusters** | アカウントで検出されたクラスターの総数 |
| **Connected** | 照会が接続されている（データ収集可能な）クラスター数 |
| **Nodes** | 接続済みクラスターのノード合計（`ready` 数を表示） |
| **Pods** | Pod の合計（`running` 数を表示） |
| **Deployments** | Deployment の合計 |
| **Services** | Service の合計 |

### クラスターカード
クラスターごとに 1 枚のカードで **Status**、**Version**、**Region**、**VPC**、**Platform** の情報を表示します。接続状態はバッジで区別されます。

- **Connected**: 照会が接続され、ノード/Pod/Deployment の数まで表示されます（カードのタイトルをクリックすると詳細へ移動）
- **Entry あり**: Access Entry はあるが、まだ照会登録されていない
- **未接続**: Access Entry がなく照会不可
- **確認不可**: アクセス状態を判別できなかった

接続済みクラスターを照会するには **EKS Access Entry** が必要です。管理者は照会アクセスを**登録/解除**したり、クラスターに直接適用できる**オンボーディングスクリプト**を確認したりできます。AWSops はクラスターを変更せず、すべての動作は読み取り専用です。

### フリートリソースの要約
接続済みクラスターがある場合、カードの下に追加の可視化が表示されます。

- **ノードリソース**: ノードごとの **CPU / Mem / Disk** 使用量メーター（Pod リクエスト合計に対するノードの allocatable 基準）
- **Pod Status / Instance Types / Pods per Namespace** チャート
- **Warning Events** テーブル（最近のクラスター警告を新しい順に表示）

### クラスター詳細
クラスターカードをクリックすると詳細画面（`/eks/<cluster>`）に移動します。**Nodes / Pods / Deployments / Services / Events / Diagnosis** タブを提供し、検索ボックスとネームスペースフィルターで絞り込めます。行をクリックすると詳細パネルが開きます。

<Screenshot src="/screenshots/resources/eks-cluster.png" alt="クラスター詳細（Nodes タブ + OpenCost）" />

- **OpenCost パネル**: インストール状態を検出し、ユーザーが自身のクラスターに直接適用できるように **values.yaml** / **install.sh** のダウンロードを提供します（読み取り専用 — AWSops はクラスターに書き込みません）。管理者はチャートバージョン・values override を保存できます。
- **Diagnosis タブ**: K8sGPT ベースの診断で、有効化しても読み取り専用です。決定論的な分析結果（FACT）と AI 仮説を分けて表示し、AI 仮説は検証してから対処する必要があります。

## 使い方
1. サイドバーの **Compute** グループで **EKS** をクリックします
2. 上部の KPI カードでフリートの規模と接続状態を確認します
3. **Connected** クラスターカードのタイトルをクリックして詳細に入ります
4. 詳細画面でタブを切り替えて **Nodes / Pods / Deployments / Services / Events / Diagnosis** を照会します
5. 検索ボックスにキーワードを入力するか、ネームスペースフィルターで範囲を絞ります
6. 行をクリックして詳細パネルですべての属性を確認します
7. 必要に応じて **OpenCost パネル**から **values.yaml** / **install.sh** をダウンロードして自身でインストールします

:::tip クイック検索
検索ボックスには名前の一部を入力するだけで構いません。ネームスペースフィルターは **Pods / Deployments / Services** タブで併用できます。
:::

:::info 接続条件
クラスターが **Connected** と表示されるには **EKS Access Entry** が必要です。未接続のクラスターにはオンボーディングスクリプトが併せて提供され、登録/解除は管理者のみが実行できます。表示される時刻は KST（Asia/Seoul）基準です。
:::

## AI 分析のヒント
フローティングボタン（ChatDrawer）や **Assistant** ページで、次のように質問してみてください。

- 「再起動回数が多い Pod を探して」
- 「CPU リクエスト率が最も高いノードはどこ？」
- 「最近の Warning イベントの原因を説明して」
- 「Deployment の中で利用可能なレプリカが不足しているものはある？」

## 関連ページ
- [リソースインベントリ](./inventory) - アカウント全体のリソースインベントリ
- [トポロジー](./topology) - リソースの接続関係の可視化
