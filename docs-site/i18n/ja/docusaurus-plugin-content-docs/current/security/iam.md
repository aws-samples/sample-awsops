---
sidebar_position: 1
---

import Screenshot from '@site/src/components/Screenshot';

# IAM

IAM（Identity and Access Management）ページでは、AWS アカウントのユーザー、ロール、ポリシーを一目で確認できます。**admin 専用**ページで、`data/config.json` の `adminEmails` に登録されたユーザーのみアクセスできます。

<Screenshot src="/screenshots/security/iam.png" alt="IAM" />

:::caution Admin 専用
ページに入る際、`/awsops/api/steampipe?action=admin-check` で権限を確認します。一般ユーザーには **Access Denied** 画面が表示されます。IAM のユーザー/ロール/ポリシーは機密情報であるため、意図された動作です。
:::

## マルチアカウントでの動作
マルチアカウント環境では、サイドバーの **AccountSelector** で対象アカウントを切り替えられます。データテーブルは `data[0].account_id` を検出すると **Account** カラムを自動追加し、`AccountBadge` でエイリアス+カラードットを表示します。

## 主な機能

### 要約統計

ページ上部で IAM リソースの状況を確認できます:

- **Users**: IAM ユーザーの総数
- **Roles**: IAM ロールの総数
- **Custom Policies**: カスタマー管理ポリシーの数
- **MFA Not Enabled**: MFA が有効化されていないユーザー数

:::tip MFA セキュリティ勧告
MFA が有効化されていないユーザーがいる場合、上部に警告バナーが表示されます。すべての IAM ユーザーに MFA を有効化することを推奨します。
:::

### MFA 状態チャート

円グラフで MFA の有効化状況を可視化します:

- **緑**: MFA が有効化されたユーザー
- **赤**: MFA が有効化されていないユーザー

## IAM ユーザー一覧

すべての IAM ユーザーをテーブル形式で表示します:

| カラム | 説明 |
|------|------|
| Username | ユーザー名 |
| User ID | AWS が付与した一意の ID |
| Created | ユーザー作成日 |
| Password Last Used | 最後にパスワードが使用された日（コンソールログイン） |

### ユーザー詳細情報

テーブルでユーザーをクリックすると、スライドパネルで詳細情報を確認できます:

- ユーザー名、ID、ARN
- パス（Path）
- 作成日と最後のパスワード使用日
- タグ情報

## IAM ロール一覧

すべての IAM ロールをテーブル形式で表示します:

| カラム | 説明 |
|------|------|
| Role Name | ロール名 |
| Role ID | AWS が付与した一意の ID |
| Path | ロールのパス |
| Description | ロールの説明 |
| Created | ロール作成日 |
| Max Session | 最大セッション持続時間 |

### ロール詳細情報

テーブルでロールをクリックすると詳細情報を確認できます:

**基本情報**
- ロール名、ID、ARN、パス
- 説明と作成日
- 最大セッション持続時間
- 権限境界（Permissions Boundary）の ARN

**最終使用情報**
- 最後に使用された日時
- 最後に使用されたリージョン

**インスタンスプロファイル**
- 関連付けられたインスタンスプロファイル ARN の一覧

**信頼ポリシー**
- `AssumeRolePolicyDocument` を JSON 形式で表示
- どのエンティティ（サービス、アカウント、ユーザー）がこのロールを引き受けられるかを確認

:::info 信頼ポリシーの分析
信頼ポリシーは、ロールを引き受け（Assume）できる主体を定義します。`Principal` フィールドで許可されたサービス、アカウント ID、ユーザー ARN を確認してください。
:::

## データの更新

右上の更新ボタンをクリックすると、`bustCache=true` で 5 分キャッシュを無効化し、最新データを照会します。

## クエリ構造

ページが呼び出す SQL クエリ（`src/lib/queries/iam.ts`）:

| クエリキー | 用途 |
|---------|------|
| `summary` | Users / Roles / Custom Policies / MFA Not Enabled のカウント |
| `userList` | ユーザー一覧 + account_id カラム |
| `roleList` | ロール一覧 + account_id カラム |
| `userDetail` | クリック時の動的 SQL（名前の置換） |
| `roleDetail` | クリック時の動的 SQL — 信頼ポリシー + インスタンスプロファイルを含む |

:::info SCP でブロックされるカラムの回避
`mfa_enabled`、`attached_policy_arns` は一覧クエリから除外されます（組織の SCP が `ListMFADevices`、`ListAttachedUserPolicies` をブロックする環境への対応）。MFA 統計は別の `summary` クエリで集計します。
:::

## 関連ページ
- [Security](./security.md) — Public S3、Open SG、未暗号化 EBS などの総合セキュリティ診断
- [Compliance](./compliance) — CIS ベンチマーク（IAM の統制を多数含む）
- [Accounts](../overview/accounts) — アカウントの追加 + Department（Cognito グループ）の管理

## 参考
- `src/lib/queries/iam.ts` — SQL クエリ定義
- ADR-024: admin 専用ページゲート（`adminEmails` マトリクス）
