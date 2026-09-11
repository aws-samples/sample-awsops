---
sidebar_position: 3
title: ECS
description: ECS クラスター、サービス、タスクの監視
---

import Screenshot from '@site/src/components/Screenshot';

# ECS (Elastic Container Service)

ECS クラスター、サービス、タスクの状態を監視できるページです。

:::info v2 での提供方法
v1 ではクラスター/サービス/タスクを 1 ページで統合監視していました。v2 は 3 つの独立したインベントリルート（`/inventory/ecs_cluster`、`/inventory/ecs_service`、`/inventory/ecs_task` — それぞれ独立したテーブル・フィルター・詳細パネル）を基本とし、これに**統合概要ページ `/inventory/ecs`**（サイドバー「ECS 概要」）が加わり、サマリー KPI（クラスタ/サービス/タスク数 + Desired 未達タスク）、クラスタテーブル、サービステーブルを 1 画面で表示します。概要は読み取り専用のグランスレイヤーです — 検索/ファセット/詳細は 3 つのタイプページにあり、各テーブルヘッダーの「すべて表示」から移動できます。500 行以上はサンプル表記（サンプル、またはサービス sync の直近 run が成功状態でない場合は、サービス由来の running/desired・未達タスク集計を保留します。タスク数 KPI は別途 summary の全量集計で、ecs_task の sync run 状態でゲートされます）、sync が成功状態でない場合は状態別の注記（失敗=古いデータの注記、部分収集、実行中）、未収集時は「未収集」と表示されます。
:::

<Screenshot src="/screenshots/compute/ecs.png" alt="ECS" />

## 主な機能

### ECS Clusters (`/inventory/ecs_cluster`)
ハイライトカードは専用の KPI バンド — ACTIVE クラスター数、実行中タスク合計、アクティブサービス合計、コンテナインスタンス合計 — と、実行中タスク数基準の Top-N 棒グラフを表示します。

テーブルのカラム:
| カラム | 説明 |
|------|------|
| Status | ステータス(ACTIVE、INACTIVE) |
| Running | 実行中のタスク数 |
| Pending | 待機中のタスク数 |
| Services | アクティブなサービス数 |
| Instances | 登録済みコンテナインスタンス数 |
| MTD Cost ($) | 月初来累計コスト |

詳細パネル: Identity(Name、Account、Region、ARN)/ Tasks & Services / Config(Settings、Container Insights など)/ Tags の各セクション。Settings は項目ごとのラベル–値の行（例: containerInsights disabled）で表示されます。

### ECS Services (`/inventory/ecs_service`)
ハイライトカードは Desired/Running/Pending の合計と、クラスターの distinct 数を表示します。

テーブルのカラム:
| カラム | 説明 |
|------|------|
| Service | サービス名 |
| Status | ステータス(ACTIVE、DRAINING) |
| Desired | 希望するタスク数 |
| Running | 実行中のタスク数 |
| Pending | 待機中のタスク数 |
| Launch | 起動タイプ(FARGATE、EC2) |
| Strategy | スケジューリング戦略 |
| Cluster | 所属クラスター |
| Task def | タスク定義 |
| Created | 作成日 |

### ECS Tasks (`/inventory/ecs_task`)
ハイライトカードは RUNNING 数、Fargate タスク数、日次コストの合計(推定値)、クラスターの distinct 数を表示します。コストはタスク定義の cpu/memory から算出した静的な推定値です。計算方法の詳細は [ECS Container Cost](../compute/ecs-container-cost) を参照してください。

テーブルのカラム: Task、Cluster、Group、Status、Launch、CPU、Memory、Cost/Day、Cost/Mo、AZ、Started。

## 使い方

1. サイドバーで **Compute > ECS Clusters / Services / Tasks** のうち必要なルートをクリックします
2. 上部のハイライトカードでそのリソースの全体状況を把握します
3. Services ページで Desired と Running を比較し、Clusters ページでクラスターごとの状態を確認します
4. 行をクリックして詳細パネルで設定内容を確認します

## Fargate vs EC2 Launch Type

| 区分 | Fargate | EC2 |
|------|---------|-----|
| インフラ管理 | サーバーレス(AWS 管理) | 自己管理が必要 |
| コスト | vCPU/Memory ベース | EC2 インスタンス費用 |
| スケーリング | 自動 | Auto Scaling の設定が必要 |
| コスト分析 | ECS Tasks ビューの Cost/Day、Cost/Mo カラム(静的推定値) | 未対応 |

## 利用のヒント

:::tip サービス状態の確認
Services テーブルで Running が Desired より少ない場合、タスクのデプロイに問題がある可能性があります。タスクの失敗原因を確認してください。
:::

:::tip Pending Tasks の監視
Pending Tasks が長時間続く場合、リソース不足やスケジューリングの問題が疑われます。
:::

:::info AI 分析
AI Assistant で「ECS クラスターの一覧」「Fargate サービスを見せて」「タスクのデプロイ失敗原因を分析して」などで分析できます。
:::

## 関連ページ

- [ECR](../compute/ecr) - コンテナイメージレジストリ
- [ECS Container Cost](../compute/ecs-container-cost) - ECS タスクのコスト分析
- [VPC](../network/vpc) - ECS のネットワーク構成
