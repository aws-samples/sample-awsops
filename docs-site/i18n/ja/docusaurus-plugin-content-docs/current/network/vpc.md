---
sidebar_position: 1
title: VPC / Network
description: VPC、Subnet、Security Group、Transit Gateway、ELB、NAT Gateway、Internet Gateway のモニタリング
---

import Screenshot from '@site/src/components/Screenshot';

# VPC / Network

AWS ネットワークインフラをひと目で把握できる統合モニタリングページです。

<Screenshot src="/screenshots/network/vpc.png" alt="VPC" />

## 主な機能

### タブベースのリソース分類

8 つのタブでネットワークリソースを体系的に管理します:

| タブ | リソース | 主な情報 |
|---|--------|----------|
| **VPCs** | Virtual Private Cloud | CIDR、テナンシー、DNS 設定 |
| **Subnets** | サブネット | AZ、CIDR、パブリック/プライベート、VPC別サブネット数バー |
| **Security Groups** | セキュリティグループ | インバウンド/アウトバウンドルール |
| **Route Tables** | ルートテーブル | ルート、サブネットの関連付け |
| **Transit Gateway** | TGW | VPC アタッチメント、ルートテーブル |
| **ELB** | ロードバランサー | ALB/NLB、ターゲットグループ、リスナー |
| **NAT** | NAT Gateway | EIP、接続状態 |
| **IGW** | Internet Gateway | VPC アタッチメント |

### リソースマップ (Resource Map)

VPC 内のすべてのリソースの関係を視覚的に表現します:

- **5 カラムレイアウト**: External (IGW/TGW) → VPCs → Subnets → Compute → NAT
- **インタラクション**: クリックして関連リソースをハイライト
- **検索**: EC2、Subnet、VPC を名前/ID/CIDR で検索

### 詳細パネル

リソースの行をクリックするとスライドパネルで詳細情報を確認できます:

- Transit Gateway: ルートテーブル、ルート、接続された VPC
- Security Group: インバウンド/アウトバウンドルールの全リスト
- ELB: ターゲットグループ、リスナー、ヘルスチェック設定

## 使い方

### リソース一覧の照会

1. 上部のタブで照会するリソースタイプを選択
2. テーブルでリソースを確認
3. 行をクリックして詳細情報パネルを開く

### リソースマップの活用

1. VPCs タブで **Resource Map** ボタンをクリック
2. 5 カラムビューでインフラ構造を確認
3. リソースをクリックして関連関係をハイライト
4. 検索ボックスで特定のリソースを探す

### Transit Gateway の分析

1. **Transit Gateway** タブを選択
2. TGW の行をクリック
3. 詳細パネルで:
   - Route Tables: TGW ルートテーブルの一覧
   - Routes: 各テーブルのルート(VPC CIDR → Attachment)
   - Attachments: 接続された VPC/VPN の一覧

## 活用のヒント

:::tip ネットワークのトラブルシューティング
AI アシスタントでネットワーク関連の質問をすると、**Network Gateway** が自動的に有効化されます。17 個の専門ツールを活用して:

- **Reachability Analyzer**: 2 つのエンドポイント間の接続経路を分析
- **VPC Flow Logs**: ネットワークトラフィックのパターンを分析
- **Transit Gateway ルーティング**: マルチ VPC ルーティングの問題を診断
- **Security Group ルールの検証**: インバウンド/アウトバウンドルールを分析

質問例:「EC2 i-xxx から RDS に接続できません」→ Reachability Analyzer を自動実行
:::

:::info Security Group ルールの確認
Security Groups タブで行をクリックすると、インバウンド/アウトバウンドルールをひと目で確認できます。0.0.0.0/0 に開放されたポートはオレンジ色で警告表示されます。
:::

## 関連ページ

- [Topology](../network/topology) - React Flow ベースのインフラ可視化
- [WAF](../network/waf) - Web Application Firewall ルールの管理
- [CloudFront](../network/cloudfront) - CDN ディストリビューションの管理
- [Security](../security) - Open Security Group の検出
