---
sidebar_position: 2
title: CloudFront
description: CloudFront ディストリビューションの状態、ドメイン、オリジン、キャッシュポリシーのモニタリング
---

import Screenshot from '@site/src/components/Screenshot';

# CloudFront

Amazon CloudFront CDN ディストリビューションをモニタリング・管理するページです。

<Screenshot src="/screenshots/network/cloudfront.png" alt="CloudFront" />

## 主な機能

### サマリー統計

上部のカードで CloudFront ディストリビューション全体の状況を確認します:

| 指標 | 説明 |
|------|------|
| **Distributions** | ディストリビューションの総数 |
| **Enabled** | 有効なディストリビューション数 |
| **Disabled** | 無効なディストリビューション数 |
| **HTTP Allowed** | HTTP を許可しているディストリビューション(セキュリティ警告) |

:::info HTTP 許可の警告
HTTP Allowed カードがオレンジ色で表示された場合は、HTTPS 専用の設定を推奨します。「Consider HTTPS only」というメッセージが併せて表示されます。
:::

### ディストリビューション一覧

テーブルですべての CloudFront ディストリビューションを確認します:

- **Distribution ID**: 一意の識別子
- **Name**: ディストリビューション名(タグベース)
- **Domain**: CloudFront ドメイン(xxx.cloudfront.net)
- **Status**: Deployed、InProgress など
- **Enabled**: 有効かどうか
- **Protocol**: Viewer Protocol Policy

### 詳細パネル

ディストリビューションの行をクリックすると詳細情報を確認できます:

**Distribution セクション**
- ID、ARN、Domain
- HTTP Version、IPv6 サポート
- Price Class(PriceClass_All、PriceClass_100 など)
- WAF ACL の関連付けの有無

**Origins セクション**
- 各 Origin の ID と Domain
- S3、ALB、Custom Origin の区分

**Aliases (CNAMEs) セクション**
- 関連付けられた代替ドメイン名の一覧

**Tags セクション**
- リソースタグのキーと値のペア

## 使い方

### ディストリビューションの状態確認

1. CloudFront ページにアクセス
2. 上部のサマリーカードで全体の状況を把握
3. テーブルで特定のディストリビューションを確認
4. Status カラムでデプロイ状態を確認

### ディストリビューションの詳細情報を照会

1. テーブルでディストリビューションの行をクリック
2. 右側のスライドパネルが開く
3. セクションごとに詳細情報を確認:
   - Distribution: 基本設定
   - Origins: オリジンサーバー構成
   - Aliases: CNAME 設定
   - Tags: リソースタグ

### セキュリティ設定のレビュー

1. HTTP Allowed カードを確認(0 なら安全)
2. ディストリビューションの詳細で Protocol を確認
3. WAF ACL の関連付けの有無を確認(セキュリティ強化)

## 活用のヒント

:::tip HTTPS 設定の推奨
すべての CloudFront ディストリビューションでは **redirect-to-https** または **https-only** の Viewer Protocol Policy を使用することを推奨します。HTTP Allowed が 0 になるとカードが緑色に変わります。
:::

:::tip WAF の関連付け
本番環境のディストリビューションには WAF Web ACL を関連付けて、Web 攻撃(SQL Injection、XSS など)をブロックしてください。詳細パネルの WAF ACL フィールドで関連付けの状態を確認できます。
:::

:::info Price Class の最適化
Price Class によって料金とパフォーマンスが変わります:
- **PriceClass_All**: 世界中のすべてのエッジロケーション(最高性能、最高コスト)
- **PriceClass_200**: ほとんどのリージョン(バランス型)
- **PriceClass_100**: 北米/ヨーロッパのみ(最低コスト)
:::

## 関連ページ

- [WAF](../network/waf) - CloudFront に関連付けられた WAF ルールの管理
- [VPC](../network/vpc) - オリジンサーバーが配置されている VPC の確認
- [Cost](../monitoring/cost) - CloudFront のコスト分析
