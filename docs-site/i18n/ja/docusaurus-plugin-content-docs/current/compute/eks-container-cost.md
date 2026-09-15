---
sidebar_position: 12
title: EKS Container Cost
description: EKS Pod のコスト分析、OpenCost 統合、CPU/Memory/Network/Storage/GPU の 5 つのコストカラム
---

import Screenshot from '@site/src/components/Screenshot';

# EKS Container Cost

EKS Pod のコストを分析するページです。OpenCost（デフォルト）または Request ベースの推定（フォールバック）の 2 つのデータソースをサポートします。

<Screenshot src="/screenshots/compute/eks-container-cost.png" alt="EKS Container Cost" />

## 主な機能

### データソース表示
ページ上部に現在のデータソースが表示されます:
- **緑**: OpenCost (Prometheus) - 実際の使用量ベース、CPU + Memory + Network + Storage + GPU
- **黄**: Request-based estimation - CPU + Memory のみ（OpenCost のインストール推奨）

### 統計カード
- **Pod Cost (Daily)**: 日次の合計 Pod コスト（シアン）
- **Pod Cost (Monthly)**: 月間推定コスト（緑）
- **Running Pods**: 実行中の Pod 数 / ノード数（紫）
- **Top Namespace**: 最もコストが高いネームスペース（オレンジ）

### Namespace Cost Distribution チャート
ネームスペースごとの日次コスト分布を円グラフで表示

### Node Daily Cost + Pod Count チャート
ノードごとの日次コストと Pod 数を表示します。v2 では 2 軸の代わりに**シリーズごとに自スケールするグループバー**（コストトラック + Pod 数トラック、ラベルに実数値/単位）でレンダリングされます — `/eks/cost` のノードコストテーブルの上、コスト上位 15。pod→node 帰属が不完全なクラスターは、そのノードの Pod 値が「—」で表示されます（表示値が過少集計になり得るため、確定値として描画しません）。

### Pods タブ
| カラム | 説明 |
|------|------|
| Namespace | ネームスペース |
| Pod | Pod 名 |
| Node | ノード名 |
| CPU | CPU コスト |
| Memory | Memory コスト |
| Network* | ネットワークコスト（OpenCost のみ） |
| Storage* | ストレージコスト（OpenCost のみ） |
| GPU* | GPU コスト（OpenCost のみ） |
| Total/Day | 日次の合計コスト |

*OpenCost モードでのみ表示

### Nodes タブ
| カラム | 説明 |
|------|------|
| Node | ノード名 |
| Instance Type | EC2 インスタンスタイプ |
| Hourly Rate | 時間あたりのコスト |
| Daily Cost | 日次コスト |
| Pods | Pod 数 |

## データソースインジケーターバナー

ページ上部に、現在使用中の計算方式を色付きバナーで表示します:

| バナー色 | 条件 | メッセージ |
|----------|------|--------|
| 🟢 緑 | `data.dataSource === 'opencost'` | "OpenCost (Prometheus) — Actual usage-based cost: CPU + Memory + Network + Storage + GPU" |
| 🟡 黄 | `dataSource !== 'opencost'` | "Request-based estimation — CPU + Memory only. Install OpenCost for full cost data: scripts/07-setup-opencost.sh" |

バナー下のカード下部ラベルも同じソースを明示します:
- `Source: OpenCost (Prometheus actual usage × AWS pricing)` または
- `Source: Request-based (Pod request ratio × EC2 node cost)`

## タブ — Pods vs Nodes

ページには **Pods** / **Nodes** の 2 つのタブがあります（`activeTab: 'pods' | 'nodes'`）。

| タブ | ラベル色 | 内容 |
|----|---------|------|
| `pods` | cyan | Pod ごとの CPU/Memory(/Network/Storage/GPU) コスト — ネームスペース・ノードでのフィルタリング |
| `nodes` | purple | ノードごとのインスタンスタイプ、時間あたりの単価、日次コスト、Pod 数 |

タブ切り替え時のデータはキャッシュされ、追加の呼び出しは発生しません。

## 2 つのコスト計算方式

### Method A: Request-based（デフォルト）
Pod のリソースリクエスト比率でノードコストを配分します:
```
CPU Ratio = Pod CPU Request / Node Allocatable CPU
Memory Ratio = Pod Memory Request / Node Allocatable Memory
Pod Daily Cost = (CPU Ratio x 0.5 + Memory Ratio x 0.5) x Node Hourly Rate x 24h
```

**サポート項目**: CPU、Memory のみ
**データソース**: Steampipe kubernetes_pod, kubernetes_node

### Method B: OpenCost (Prometheus)
実際の使用量メトリクスと AWS の価格情報を組み合わせます:
```
CPU Cost = Actual CPU Usage (cores) x AWS EC2 vCPU Price
Memory Cost = Actual Memory Usage (bytes) x AWS EC2 Memory Price
Network Cost = Cross-AZ/Region Transfer x Data Transfer Price
Storage Cost = PVC Provisioned Size x EBS Volume Price
Pod Total Cost = CPU + Memory + Network + Storage + GPU
```

**サポート項目**: CPU、Memory、Network、Storage、GPU（5 つ）
**データソース**: Prometheus + Metrics Server

## OpenCost のインストール

```bash
bash scripts/07-setup-opencost.sh
```

インストール後、`data/config.json` に `opencostEndpoint` を設定すると自動的に OpenCost モードに切り替わります。

## 使い方

1. サイドバーで **Compute > EKS Container Cost** をクリックします
2. 上部バナーでデータソースを確認します
3. 統計カードで全体のコスト状況を把握します
4. チャートでコストの高いネームスペース/ノードを特定します
5. Pods/Nodes タブを切り替えて詳細なコストを確認します
6. "Cost Calculation Basis" セクションを展開して計算根拠を確認します

## EC2 価格の参考（ap-northeast-2、On-Demand）

| Instance Type | Hourly Rate |
|---------------|-------------|
| m5.large | $0.118 |
| m5.xlarge | $0.236 |
| m6g.large | $0.100 |
| c5.xlarge | $0.196 |
| r5.large | $0.152 |
| t3.large | $0.104 |
| t4g.large | $0.086 |

## 活用のヒント

:::tip OpenCost のインストール推奨
Request ベースはリソースリクエストのみを考慮するため、実際の使用量とは差があります。OpenCost をインストールすると 5 つのコスト項目を正確に分析できます。
:::

:::tip Request のない Pod
リソースリクエストのない Pod は、Request モードでは $0.00 と表示されます。ベストプラクティスとして、すべての Pod にリソースリクエストを設定してください。
:::

:::tip Network Cost (OpenCost)
OpenCost の Network コストには Cross-AZ 転送のみが含まれます。同一 AZ 内の転送は無料です。
:::

:::info AI 分析
AI Assistant で「EKS Pod のコスト分析」「ネームスペース別のコスト比較」「コスト最適化の方法」などの分析ができます。
:::

## 関連ページ

- [EKS Overview](../compute/eks) - クラスター全体の状況
- [EKS Nodes](../compute/eks-nodes) - ノードリソースの状態
- [ECS Container Cost](../compute/ecs-container-cost) - ECS Fargate のコスト
- [Cost](../monitoring/cost) - AWS 全体のコスト分析
