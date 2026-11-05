---
sidebar_position: 5
title: 認証フロー
description: Cognito 認証アーキテクチャとフローの詳細
---

import AuthFlow from '@site/src/components/diagrams/AuthFlow';

# 認証フロー

AWSops は Amazon Cognito + Lambda@Edge + CloudFront の組み合わせで認証を処理します。

<AuthFlow />

## Cognito の構成

| 項目 | 設定 |
|------|------|
| **User Pool** | `awsops-user-pool` (セルフサインアップ無効) |
| **ログイン方式** | メールアドレスまたはユーザー名 |
| **パスワードポリシー** | 8 文字以上、大文字/小文字 + 数字必須 |
| **OAuth** | Authorization Code Grant、OpenID/Email/Profile |
| **トークン有効期間** | 1 時間 |
| **ログイン UI** | カスタムログインページ (`/awsops/login`) — Cognito Hosted UI 不使用 |
| **認証フロー** | `USER_PASSWORD_AUTH` (InitiateAuth) via `/api/auth` |

## 認証フローの詳細

### 初回アクセス (Cookie なし)

1. ブラウザが `/awsops` にアクセス
2. CloudFront が viewer-request イベントで Lambda@Edge を呼び出し
3. Lambda@Edge が `awsops_token` Cookie を確認 → なし/期限切れ
4. **カスタムログインページ `/awsops/login` へ 302 リダイレクト** (Cognito Hosted UI ではない)
5. ユーザーがメールアドレス/パスワードを入力 → `POST /awsops/api/auth` (`action: login`)
6. サーバーが Cognito **InitiateAuth (`USER_PASSWORD_AUTH`)** を呼び出し → IdToken を取得
7. `awsops_token` を HttpOnly・Secure・SameSite=Lax の Cookie として設定 (1 時間)
8. 以降、認証済みリクエストが CloudFront → ALB → EC2 へ転送される

### 再アクセス (有効な Cookie あり)

1. ブラウザが `awsops_token` Cookie とともにアクセス
2. Lambda@Edge が JWT を検証 → 有効
3. リクエストがそのまま CloudFront → ALB → EC2 へ転送される

## Lambda@Edge

| 項目 | 設定 |
|------|------|
| **リージョン** | us-east-1 (Lambda@Edge の必須要件) |
| **ランタイム** | Python 3.12 (デプロイハンドラー; CDK スタブは Node.js 20) |
| **トリガー** | CloudFront viewer-request |
| **機能** | `awsops_token` JWT Cookie の検証、未認証時は `/awsops/login` へリダイレクト |

:::warning ログアウト
HttpOnly Cookie は JavaScript (`document.cookie`) では削除できません。AWSops は `POST /api/auth` を通じてサーバーサイドで Cookie を削除します。
:::

## 関連ページ

- [ログイン](./login) - ログイン方法
- [デプロイガイド](./deployment) - Cognito のデプロイ手順
- [ダッシュボード](../overview/dashboard) - システムアーキテクチャの概要
