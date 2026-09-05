---
sidebar_position: 11
title: ECS Container Cost
description: ECS Fargate タスクのコスト分析、CloudWatch Container Insights メトリクス
---

import Screenshot from '@site/src/components/Screenshot';

# ECS Container Cost

:::caution v1 アーカイブ文書 — v2 の対応機能は /inventory/ecs_task にあります
この文書は v1 専用の **ECS Container Cost** ページ（統計カード、チャート、"Cost Calculation Basis" トグルを含む）について説明しています。**v2 に専用ページはなく、対応機能は `/inventory/ecs_task` インベントリビューにあります**（**Cost/Day・Cost/Mo** 列、「日次コスト合計 (est.)」KPI タイル、テーブル下部の折りたたみ式**コスト計算根拠**パネル — v1 の 'Cost Calculation Basis' に対応）。列の値は CloudWatch Container Insights の使用率メトリクスではなく、**タスク定義に割り当てられた cpu/memory から算出した静的な推定値**です（`web/lib/inventory-derived.ts` の `ecs_task` deriver — 単価定数は単一ソース `web/lib/cost-basis.ts` 由来）。以下の**価格定数・計算式**（`$0.04656`/`$0.00511`、`(CPU units/1024)×単価×24 + (MB/1024)×単価×24`）はこの静的推定値の実際のロジックと一致しており正確です — 変更しないでください。ただし、この文書にある円グラフと「CloudWatch Container Insights メトリクスに基づいて計算」という記述は v1 専用であり、v2 には存在しません（v2 の推定は静的定数ベースで、一時ストレージ単価は反映されません）。なお **Cost by Service (CPU vs Memory)** チャートは v2 にも存在します — `/inventory/ecs_task` にサービス別グループバー（FARGATE タスクのみ、静的推定、上位 10）として表示されます。
:::

ECS Fargate タスクのコストを分析するページです。Fargate の価格と CloudWatch Container Insights メトリクスに基づいてコストを計算します。

<Screenshot src="/screenshots/compute/ecs-container-cost.png" alt="ECS Container Cost" />

## 主な機能

### 統計カード
- **Daily Cost (ECS)**: 日次の合計コスト（シアン）
- **Monthly Estimate**: 月間推定コスト（緑）
- **Running Tasks**: 実行中のタスク数 - Fargate/EC2 の区分（紫）
- **Top Cost Service**: 最もコストが高いサービス（オレンジ）

### Service Cost Distribution チャート
サービスごとの日次コスト分布を円グラフで表示

### Cost by Service (CPU vs Memory) チャート
サービスごとの CPU コストと Memory コストを比較します。v2 では積み上げバーの代わりに**共通スケールのグループバー**（2 つの $ シリーズが 1 つのスケールを共有 — 実際の比率を保持）でレンダリングされ、クラスター/サービスラベル・FARGATE 限定・上位 10・500 行超過時の「サンプル基準」表記が適用されます。

### ECS Tasks テーブル
| カラム | 説明 |
|------|------|
| Cluster | クラスター名 |
| Service | サービス名 |
| Task ID | タスク ID（先頭 12 桁） |
| Type | 起動タイプ（FARGATE/EC2） |
| CPU (units) | CPU ユニットおよび vCPU 換算値 |
| Memory (MB) | メモリおよび GB 換算値 |
| Daily Cost | 日次コスト（Fargate のみ） |
| AZ | アベイラビリティゾーン |

## コスト計算方式

### Fargate 価格（v2 実際の値 — ap-northeast-2（ソウル）単価、`web/lib/inventory-derived.ts`）
| リソース | 単価 | 課金単位 |
|--------|------|-----------|
| vCPU | $0.04656 | per vCPU-hour |
| Memory | $0.00511 | per GB-hour |
| Ephemeral Storage (>20GB) | $0.000111 | per GB-hour |

> これはタスクの実際のリージョンに関係なく常に適用される固定の静的推定定数です — deriver は各タスク行のリージョン列を参照しません。

### 計算式
```
CPU Cost = (CPU Units / 1024) x $0.04656/hr x 24hr
Memory Cost = (Memory MB / 1024) x $0.00511/hr x 24hr
Daily Cost = CPU Cost + Memory Cost
Monthly Estimate = Daily Cost x 30
```

### 計算例
Fargate Task: 512 CPU units (0.5 vCPU) + 1024 MB (1 GB)
- CPU: 0.5 vCPU x $0.04656/hr x 24hr = **$0.5587/day**
- Memory: 1 GB x $0.00511/hr x 24hr = **$0.1226/day**
- Total: **$0.681/day ($20.44/month)**

## 計算根拠トグル（Cost Calculation Basis）

テーブル下部に **▶ Cost Calculation Basis / 비용 계산 근거** の折りたたみ可能なセクションがあります。`showBasis` のトグルで次をインラインに展開します:

- **Fargate Pricing 表**（v2 実際の値、ap-northeast-2（ソウル）単価 — タスクの実際のリージョンに関係なく適用される固定定数）
  - vCPU hourly rate: `$0.04656`
  - GB hourly rate: `$0.00511`
- 計算例: 0.5 vCPU × 1 GB のタスク → `$0.681/day` に換算
- Spot、ARM (Graviton) の変動分に関する参考ノート

価格の値は v1 では `data/config.json` の `fargatePricing` でオーバーライドできました — v2 にはこの仕組みはありません。

## EKS Pod Cost へのポインター（Phase 2）

ページ下部に EKS コンテナコスト分析へ案内するカードがあります — このページは ECS Fargate に限定されており、EKS Pod 単位のコストは別ページで扱います:

→ [EKS Container Cost](./eks-container-cost) — Pod / Node タブ、OpenCost (Prometheus) または Request-based 推定

## 使い方

1. サイドバーで **Compute > Container Cost** をクリックします
2. 統計カードで全体のコスト状況を把握します
3. チャートでコストの高いサービスを特定します
4. テーブルでタスクごとの詳細なコストを確認します
5. "Cost Calculation Basis" セクションを展開して計算根拠を確認します

## サポート範囲

| 項目 | サポート |
|------|------|
| Fargate Launch Type | O（コスト計算対応） |
| EC2 Launch Type | X（ノードコストの配分が必要、未対応） |
| Spot Fargate | -（On-Demand 価格基準） |

## 活用のヒント

:::tip EC2 Launch Type
EC2 タイプのタスクは "N/A (EC2)" と表示されます。EC2 のコストはノードコストの配分が必要なため、現在は未対応です。
:::

:::tip コスト最適化
CPU vs Memory チャートで一方が大きく高い場合は、タスク定義の調整を検討してください。Fargate は CPU と Memory の組み合わせが制限されています。
:::

:::tip 価格設定の変更（v1 専用）
`data/config.json` の `fargatePricing` フィールドは v1 のオーバーライド機構です — v2 には存在しません。
:::

:::info AI 分析
AI Assistant で「ECS のコスト分析」「最もコストの高いサービス」「Fargate コスト最適化の方法」などの分析ができます。
:::

## 関連ページ

- [ECS](../compute/ecs) - ECS クラスターおよびサービスの状態
- [EKS Container Cost](../compute/eks-container-cost) - EKS Pod のコスト分析
- [Cost](../monitoring/cost) - AWS 全体のコスト分析
