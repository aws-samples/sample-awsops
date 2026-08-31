---
sidebar_position: 3
title: WAF
description: AWS WAF Web ACL、ルールグループ、IP Sets のモニタリング
---

import Screenshot from '@site/src/components/Screenshot';

# WAF

AWS Web Application Firewall をモニタリングし、ルールを確認するページです。

<Screenshot src="/screenshots/network/waf.png" alt="WAF" />

## 主な機能

### サマリー統計

上部のカードで WAF リソースの状況を確認します:

| 指標 | 説明 | 色 |
|------|------|------|
| **Web ACLs** | Web ACL の総数 | cyan |
| **Rule Groups** | ルールグループの総数 | purple |
| **IP Sets** | IP セットの総数 | orange |

### Web ACL 一覧

テーブルですべての Web ACL を確認します:

- **Name**: Web ACL 名
- **ID**: 一意の識別子
- **Scope**: REGIONAL または CLOUDFRONT
- **Capacity**: WCU(Web ACL Capacity Units)の使用量
- **Description**: 説明
- **Region**: リージョン(CLOUDFRONT は Global)

### 詳細パネル

Web ACL の行をクリックすると詳細情報を確認できます:

**Web ACL セクション**
- Name、ID、ARN
- Scope、Capacity
- Description
- Default Action (Allow/Block)

**Rules セクション**
- ルール名と Priority
- Action (Allow, Block, Count)
- Managed Rule Group の参照

## 使い方

### Web ACL の状況確認

1. WAF ページにアクセス
2. 上部のサマリーカードでリソース全体の数を把握
3. テーブルで Web ACL の一覧を確認
4. Scope で Regional/CloudFront を区別

### Web ACL ルールの分析

1. テーブルで Web ACL の行をクリック
2. 詳細パネルで Rules セクションを確認
3. 各ルールの:
   - **Name**: ルール名
   - **Priority**: 評価順序(小さいほど先)
   - **Action**: マッチ時の動作

### Scope を理解する

| Scope | 関連付け対象 | リージョン |
|-------|----------|------|
| **REGIONAL** | ALB, API Gateway, AppSync | 特定のリージョン |
| **CLOUDFRONT** | CloudFront Distribution | us-east-1 (Global) |

## 活用のヒント

:::tip AWS Managed Rules の活用
AWS はさまざまな Managed Rule Group を提供しています:
- **AWSManagedRulesCommonRuleSet**: OWASP Top 10 への対応
- **AWSManagedRulesSQLiRuleSet**: SQL Injection のブロック
- **AWSManagedRulesKnownBadInputsRuleSet**: 既知の悪意ある入力のブロック

Managed Rules は AWS が継続的に更新するため、手動管理の負担が軽減されます。
:::

:::info WCU(Web ACL Capacity Units)
各ルールは WCU を消費します。Web ACL のデフォルト上限は 1,500 WCU です。Capacity の値が高い場合は、ルール数を減らすか AWS Support に上限引き上げをリクエストしてください。
:::

:::tip Default Action の設定
- **Allow(デフォルト)**: ルールにマッチしなければ許可(明示的ブロック方式)
- **Block(デフォルト)**: ルールにマッチしなければブロック(明示的許可方式)

ほとんどの場合、**Allow** のデフォルト設定 + ブロックルールを追加する方式を推奨します。
:::

## 関連ページ

- [CloudFront](../network/cloudfront) - WAF が関連付けられた CDN ディストリビューション
- [VPC](../network/vpc) - ALB が配置されている VPC の確認
- [Compliance](../security/compliance) - WAF 関連のコンプライアンスチェック
