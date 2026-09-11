---
sidebar_position: 8
title: EKS Nodes
description: Kubernetes ノードの一覧、容量、割り当てリソース、状態
---

import Screenshot from '@site/src/components/Screenshot';

# EKS Nodes

Kubernetes ノードの容量、割り当て可能リソース、Pod のリクエスト量を詳しく確認できるページです。

<Screenshot src="/screenshots/compute/eks-nodes.png" alt="EKS Nodes" />

## 主な機能

### 統計カード
- **Total Nodes**: ノードの総数(シアン)
- **Ready**: Ready 状態のノード数(緑)
- **Total CPU**: 全体の vCPU 容量の合計(紫)
- **Total Memory**: 全体のメモリ容量の合計(オレンジ) — allocatable 合計と reserved %（Capacity − Allocatable）をヒントとして併記（allocatable が未報告の場合はヒント省略）

### CPU Usage per Node チャート
ノード別の CPU リソースの状態を 3 段階の棒グラフで表示:
- **Requested**(シアン/オレンジ/赤): Pod がリクエストした CPU
- **Available**(緑・半透明): 追加で割り当て可能な CPU
- **System Reserved**(グレー): システムが予約した CPU

ノードごとに表示:
- ノード名、Pod のリクエスト量 / 全体容量、パーセント
- Pod 数、リクエスト vCPU、利用可能 vCPU、予約 vCPU

### Memory Usage per Node チャート
ノード別の Memory リソースの状態を同じ 3 段階の棒グラフで表示:
- **Requested**(紫/オレンジ/赤): Pod がリクエストした Memory
- **Available**(緑・半透明): 追加で割り当て可能な Memory
- **System Reserved**(グレー): システムが予約した Memory

### 容量チャート
- **CPU Capacity per Node (vCPU)**: ノード別の CPU 容量の棒グラフ
- **Memory Capacity per Node (GiB)**: ノード別のメモリ容量の棒グラフ

### ノードテーブル
| カラム | 説明 |
|------|------|
| Name | ノード名 |
| Status | Ready / NotReady |
| CPU Capacity | 全体の CPU 容量 |
| Memory Capacity | 全体のメモリ容量 |
| Allocatable CPU | 割り当て可能な CPU |
| Allocatable Memory | 割り当て可能なメモリ |
| Created | 作成時刻 |

### ノードドリルダウン Pods テーブル
ノードをクリックすると、そのノードにスケジュールされた Pods テーブルが開きます — Namespace / Pod / Status / Owner / **Pod IP** / **Service Account** / Restarts / CPU / Mem / Age 列（不明の場合は「-」。例: 終了した Pod には IP がありません）。

## リソースの概念を理解する

![ノードリソースの階層](/diagrams/eks-node-resources.png)

| 用語 | 説明 |
|------|------|
| Capacity | ノードの物理リソース全体 |
| Allocatable | Pod に割り当て可能なリソース(Capacity - System Reserved) |
| Requested | 現在の Pod がリクエストしたリソースの合計 |
| Available | 追加で割り当て可能なリソース(Allocatable - Requested) |
| System Reserved | kubelet、OS などシステム用に予約されたリソース |

## 使い方

1. サイドバーで **Compute > K8s > Nodes** をクリックします
2. 統計カードでノード全体の状況を把握します
3. CPU/Memory Usage チャートでリソース使用率の高いノードを特定します
4. 80% 以上(赤)のノードはスケーリングを検討します
5. テーブルで各ノードの詳細な容量を確認します

## 利用のヒント

:::tip リソース使用率のしきい値
- **80% 以上(赤)**: 即時対応が必要 - ノードの追加または Pod の再配置
- **50-80%(オレンジ)**: 監視が必要 - 増加傾向を確認
- **50% 未満(シアン/紫)**: 正常 - リソースに余裕あり
:::

:::tip Available vs Capacity
Available は負の値になることがあります。これは Pod が Limit なしで Request のみを設定し、オーバーコミットされた状態です。
:::

:::info AI 分析
AI Assistant で「ノードのリソース使用量」「CPU 80% 以上のノード」「ノードのスケーリングが必要か分析して」などで分析できます。
:::

## 関連ページ

- [EKS Overview](../compute/eks) - クラスター全体の状況
- [EKS Pods](../compute/eks-pods) - Pod の状態確認
- [EC2](../compute/ec2) - ノードの基盤となる EC2 インスタンス
- [EKS Container Cost](../compute/eks-container-cost) - ノード/Pod のコスト分析
