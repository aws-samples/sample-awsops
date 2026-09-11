---
sidebar_position: 4
title: Topology
description: React Flow ベースの AWS インフラおよび Kubernetes クラスターの可視化
---

import Screenshot from '@site/src/components/Screenshot';

# Topology

AWS インフラと Kubernetes クラスターの関係を視覚的に探索するページです。

<Screenshot src="/screenshots/network/topology.png" alt="Topology" />

## 主な機能

### ビューの切り替え

上部のトグルで 2 つのビューを切り替えます:

| ビュー | 対象 | 用途 |
|----|------|------|
| **Infrastructure** | AWS リソース | VPC、EC2、RDS、ELB などの関係を可視化 |
| **Kubernetes** | EKS ワークロード | Pod、Service、Ingress、Node の関係 |

### Infrastructure ビュー

2 つの表示モードを提供します:

**Map View(デフォルト)**
- 5 カラムレイアウトでリソース階層を表示
- External (IGW/TGW) → VPCs → Subnets → Compute → NAT
- クリック/検索で関連リソースをハイライト

**Graph View**
- React Flow ベースのノード・エッジグラフ
- ドラッグでノードを移動
- ズーム/パンで探索
- MiniMap で全体構造を確認

### Kubernetes ビュー

4 カラムのリソースマップで EKS ワークロードを表示します:

| カラム | リソース | 説明 |
|------|--------|------|
| **Ingress** | K8s Ingress | 外部トラフィックのエントリーポイント |
| **Services** | K8s Service | ロードバランシング、ClusterIP/NodePort/LoadBalancer |
| **Pods** | K8s Pod | 実行中のコンテナ |
| **Nodes** | EKS Node | ワーカーノード(EC2) |

### インタラクション機能

**検索**
- Infrastructure: EC2、Subnet、VPC を名前/ID/CIDR で検索
- Kubernetes: Pod、Service、Namespace を検索
- マッチしたリソースと関連リソースを自動でハイライト

**クリック選択**
- リソースをクリックして選択
- 選択したリソースに接続されたすべてのリソースをハイライト
- もう一度クリックすると選択解除

**Graph View 専用**
- マウスホイール: ズームイン/アウト
- ドラッグ: キャンバスの移動
- ノードのドラッグ: ノード位置の調整
- Controls: ズームリセット、画面フィット
- MiniMap: 全体構造のプレビュー

## 使い方

### インフラ構造の把握

1. **Infrastructure** ビューを選択
2. **Map View** で階層構造を確認
3. VPC → Subnet → EC2 の流れを把握
4. IGW/TGW で外部接続を確認

### 特定リソースの追跡

1. 検索ボックスにリソース名/ID を入力
2. マッチしたリソースのハイライトを確認
3. 関連する VPC、Subnet も併せてハイライト
4. 「Clear search」ボタンでリセット

### K8s トラフィックフローの分析

1. **Kubernetes** ビューを選択
2. Ingress → Service → Pod → Node の流れを確認
3. Service をクリックして接続された Pod を確認
4. 検索で特定のワークロードを追跡

### Graph View の活用

1. Infrastructure ビューで **Graph View** を選択
2. React Flow グラフがレンダリングされる
3. ノードをドラッグしてレイアウトを調整
4. MiniMap で全体構造を確認

## 活用のヒント

:::tip ネットワーク経路の追跡
特定の EC2 から外部インターネットまでの経路を追跡するには:
1. 検索ボックスに EC2 名を入力
2. ハイライトされた Subnet を確認
3. Subnet が NAT Gateway または IGW に接続されているか確認
4. Private Subnet なら NAT、Public Subnet なら IGW の経路
:::

:::tip K8s Service のデバッグ
「Service に Pod が接続されていない」問題の解決:
1. Kubernetes ビューで Service をクリック
2. 接続された Pod を確認(0 pods なら問題あり)
3. Pod の labels と Service の selector が一致しているか確認
4. Pod があれば Node まで追跡してリソースの状態を確認
:::

:::info 色の凡例
| 色 | Infrastructure | Kubernetes |
|------|---------------|------------|
| Cyan | VPC, IGW | Ingress |
| Green | Subnet | Node |
| Purple | EC2 | Pod |
| Pink | ELB | - |
| Orange | RDS, NAT | Service |
| Red | TGW | - |

マップ上部の情報行の凡例チップは現在のグラフに存在する種類のみ表示します。カード名の横のステータスドットも凡例に表示されます — **ok**（緑）/ **warn**（オレンジ）/ **bad**（赤）/ **neutral**（グレー）。
:::

## 関連ページ

- [VPC](../network/vpc) - VPC の詳細情報およびリソースマップ
- [EKS Overview](../compute/eks) - EKS クラスターの詳細
- [EC2](../compute/ec2) - EC2 インスタンスの詳細情報
