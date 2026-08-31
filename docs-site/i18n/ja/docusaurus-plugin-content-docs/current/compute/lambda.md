---
sidebar_position: 2
title: Lambda 関数
description: Lambda 関数の一覧、ランタイム分布、メモリ/タイムアウト設定の確認
---

import Screenshot from '@site/src/components/Screenshot';

# Lambda 関数

AWS Lambda 関数の一覧と構成情報を確認できるページです。

<Screenshot src="/screenshots/compute/lambda.png" alt="Lambda 関数" />

## 主な機能

### 統計カード
- **Total Functions**: Lambda 関数の総数(シアン)
- **Runtimes**: 使用中のランタイムの種類数(紫)
- **Avg Memory (MB)**: 平均メモリ割り当て量(緑)
- **Long Timeout (>5m)**: タイムアウトが 5 分を超える関数の数(オレンジ)

### 可視化チャート
- **Runtime Distribution**: ランタイム別の関数分布の円グラフ(Python、Node.js、Java など)
- **Memory Allocation**: メモリ設定別の関数分布の棒グラフ

### 関数一覧テーブル
| カラム | 説明 |
|------|------|
| Function Name | 関数名 |
| Runtime | ランタイム(deprecated 表示を含む) |
| Memory (MB) | 割り当てられたメモリ |
| Timeout (s) | タイムアウト設定 |
| Code Size | コードサイズ |
| Last Modified | 最終更新日 |
| Region | リージョン |

### Deprecated ランタイムの表示
次のランタイムはオレンジ色の「deprecated」ラベルが表示されます:
- Python 2.7、3.6、3.7
- Node.js 10.x、12.x、14.x
- .NET Core 2.1、3.1
- Ruby 2.5、2.7
- Java 8、Go 1.x

### 詳細パネル
関数をクリックすると詳細情報を確認できます:
- **Function セクション**: Name、ARN、Runtime、Handler、Architectures、Package Type、Code Size
- **Deployment セクション**: Version、State、Last Update、Layers 情報
- **Configuration セクション**: Memory、Timeout 設定
- **Network セクション**: VPC 接続情報(VPC ID、Subnets、Security Groups)

## 使い方

1. サイドバーで **Compute > Lambda** をクリックします
2. Runtime Distribution チャートでランタイムの分布を確認します
3. Memory Allocation チャートでメモリ設定のパターンを把握します
4. deprecated ランタイムの関数を特定し、アップグレード計画を立てます
5. 関数をクリックして詳細な構成を確認します

## 利用のヒント

:::tip Deprecated ランタイムの管理
Runtime カラムでオレンジ色の「deprecated」ラベルが表示されている関数は、AWS のサポートが終了済みか終了予定です。早めのアップグレードを推奨します。
:::

:::tip Long Timeout 関数の点検
タイムアウトが 5 分以上の関数は、コスト最適化とエラー処理の観点から見直しが必要です。
:::

:::info AI 分析
AI Assistant で「Lambda 関数の一覧」「Python ランタイムを使用する関数」「deprecated ランタイムの関数を探して」などで分析できます。
:::

## 関連ページ

- [CloudWatch](../monitoring/cloudwatch) - Lambda の実行ログとアラーム
- [IAM](../security/iam) - Lambda 実行ロールの確認
- [VPC](../network/vpc) - VPC 接続 Lambda のネットワーク構成
