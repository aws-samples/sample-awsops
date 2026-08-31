---
sidebar_position: 4
title: アカウント管理
description: マルチアカウント AWS モニタリングのためのアカウント追加・削除・テスト管理ページ
---

import Screenshot from '@site/src/components/Screenshot';
import MultiAccountSetupFlow from '@site/src/components/diagrams/MultiAccountSetupFlow';

# アカウント管理

アカウント管理ページは、AWSops のマルチアカウントモニタリングのための管理者専用ページです。Host アカウントの自動検出、Target アカウントの追加/削除、接続テスト、機能検出を 1 か所で実行できます。

<Screenshot src="/screenshots/overview/accounts.png" alt="アカウント管理" />

:::tip 顧客セッションポイント
Steampipe Aggregator で**全アカウントを単一画面**から照会 — アカウントの追加/削除は `data/config.json` の `accounts[]` を修正するだけで、**コード変更は不要**です。→ [なぜ AWSops なのか](./why-awsops)
:::

## 設定フロー

以下のダイアグラムは、Host アカウントと Target アカウントの登録プロセス、および Admin アクセス制御のフローを示します。各ノードにマウスを合わせると詳細説明が表示されます。

<MultiAccountSetupFlow />

## 主な機能

### Host アカウント設定

アカウントが 1 つも登録されていない状態でページにアクセスすると、Host アカウント登録バナーが表示されます。

| 項目 | 説明 |
|------|------|
| **自動検出** | EC2 インスタンスクレデンシャルで STS GetCallerIdentity を呼び出し |
| **機能検出** | Cost Explorer、EKS、K8s API をプロービングして利用可能な機能を自動設定 |
| **Alias 入力** | Host アカウントの表示名を指定（デフォルト: "Host"） |
| **config.json 登録** | `data/config.json` の `accounts[]` 配列に `isHost: true` で登録 |

### 登録済みアカウントの管理

登録されたすべてのアカウントがテーブル形式で表示されます。

| カラム | 説明 |
|------|------|
| **Alias** | アカウント表示名 |
| **Account ID** | 12 桁の AWS アカウント ID |
| **Region** | デフォルトリージョン |
| **Type** | Host または Target |
| **Features** | Cost、EKS、K8s の有効化状態（バッジ形式） |
| **Actions** | 接続テスト、削除（Host アカウントは削除不可） |

### 新規アカウントの追加

Target アカウントを追加するには、以下の情報を入力します。

| フィールド | 形式 | 説明 |
|------|------|------|
| **Account ID** | 12 桁の数字 | AWS アカウント ID |
| **Alias** | 英数字/スペース/ハイフン/アンダースコア | ダッシュボードに表示される名前 |
| **Region** | 選択 | 主要 10 リージョンから選択 |
| **Role Name** | 文字列 | クロスアカウント IAM ロール名（デフォルト: `AWSopsReadOnlyRole`） |

追加前に必ず **Test Connection** で AssumeRole 接続を確認してください。

### Target アカウントの CloudFormation デプロイ

新しいアカウントを追加する前に、そのアカウントでクロスアカウント IAM ロールを先に作成する必要があります。

```bash
aws cloudformation deploy \
  --template-file infra-cdk/cfn-target-account-role.yaml \
  --stack-name awsops-target-role \
  --parameter-overrides HostAccountId=<HOST_ACCOUNT_ID> \
  --capabilities CAPABILITY_NAMED_IAM
```

このコマンドは以下を作成します:
- **AWSopsReadOnlyRole**: Host アカウントから AssumeRole 可能な読み取り専用ロール
- **Trust Policy**: Host アカウント ID を Principal に指定
- **権限**: ReadOnlyAccess + 必要な追加ポリシー

## Admin アクセス制御

アカウント管理ページには管理者のみアクセスできます。

| 項目 | 説明 |
|------|------|
| **設定場所** | `data/config.json` の `adminEmails` 配列 |
| **空配列** | `[]` の場合、認証済みのすべてのユーザーにアクセスを許可 |
| **検証フロー** | JWT からメールアドレスを抽出 → `adminEmails` 配列とマッチング → 許可/拒否 |
| **レート制限** | ユーザーあたり毎分 5 回のリクエスト制限 |
| **API 保護** | add-account、remove-account、init-host すべてに同一の admin チェックを適用 |

```json
{
  "adminEmails": ["admin@example.com", "ops@example.com"]
}
```

:::warning Admin 未設定の場合
`adminEmails` が空配列の場合、認証済みユーザーであれば誰でもアカウントを追加/削除できます。本番環境では必ず管理者メールアドレスを指定してください。
:::

## 使い方

1. **Host アカウント登録**: 初回アクセス時に表示されるバナーで Alias を入力し、「Detect & Register Host」をクリック
2. **Target アカウントの準備**: Target アカウントで CloudFormation スタックをデプロイ
3. **接続テスト**: Account ID を入力し、「Test Connection」で AssumeRole を検証
4. **アカウント追加**: Alias、Region を入力し、「Add Account」をクリック
5. **確認**: 登録済みアカウントテーブルで Features バッジを確認
6. **Steampipe 設定**: 新しいアカウントの Steampipe connection を構成（Aggregator に自動追加）

## Departments（Cognito グループベースのアクセス制御）

`/accounts` ページ下部の **Departments** セクションで、Cognito グループごとにページ・アカウント・EKS クラスター・外部データソースのアクセス権限を細かく設定できます。

| フィールド | 説明 |
|------|------|
| `name` | 部門名（例: "FinOps"、"SecOps"） |
| `cognitoGroup` | Cognito User Pool のグループ名（完全一致） |
| `accounts` | アクセス可能なアカウント ID の配列 — `["*"]` の場合は全体 |
| `pages` | アクセス可能なページパスの配列（`/ec2`、`/cost` など）— `["*"]` の場合は全体 |
| `eksClusterNames` | アクセス可能な EKS クラスター名 — `["*"]` の場合は全体 |
| `datasourceIds` | アクセス可能な外部データソース ID — `["*"]` の場合は全体 |

### 動作の仕組み
- Cognito JWT の `cognito:groups` クレームを読み取り、マッチする Department の制限を適用します。
- マッチする Department がない場合は admin かどうかに応じて動作します（admin は全アクセス、非 admin はブロック）。
- 空配列は「全体無効」→ **`["*"]` を明示**しないと全体許可になりません。

### API
```bash
# 部門一覧の照会
curl '/awsops/api/steampipe?action=config' | jq '.departments'

# 部門の保存（admin 専用）
curl -X POST '/awsops/api/steampipe?action=save-departments' \
  -H 'Content-Type: application/json' \
  -d '{"departments":[{"name":"FinOps","cognitoGroup":"finops","accounts":["*"],"pages":["/cost","/inventory","/bedrock"],"eksClusterNames":["*"],"datasourceIds":["*"]}]}'
```

:::caution Departments を空にすると無効化
`departments` 配列が空の場合、部門ベースのアクセス制御は**完全に無効**になります — すべてのログインユーザーのアクセス権限は admin/一般ポリシーのみで決定されます。
:::

## 使用上のヒント

:::tip 機能バッジ
アカウントが登録されると、Cost、EKS、K8s の機能が自動検出されます。バッジが表示されない機能は、そのアカウントで該当サービスが有効化されていないか、権限が不足している場合です。
:::

:::info Steampipe Aggregator パターン
`aws` connection はすべての登録アカウントのデータを統合照会します。個別アカウントの照会には `aws_{accountId}` connection を使用し、AccountSelector のドロップダウンから選択できます。
:::

:::tip アカウント削除時
Target アカウントを削除しても、そのアカウントの CloudFormation スタックは自動的に削除されません。必要に応じて Target アカウント側でスタックを個別に削除してください。
:::

## AI 分析のヒント

AI アシスタントに次のように質問すると、登録済みアカウントに関する情報をすばやく確認できます:

- 「登録されているアカウントの一覧を見せて」
- 「Cost Explorer が有効なアカウントは？」
- 「EKS クラスターがあるアカウントは？」
- 「Staging アカウントのリソース状況を教えて」
- 「すべてのアカウントの EC2 インスタンス数を比較して」

## 関連ページ

- [ダッシュボード](../overview/dashboard) - マルチアカウント統合ダッシュボード
- [AI アシスタント](../overview/ai-assistant) - AI ベースのアカウント分析
- [AgentCore](../overview/agentcore) - クロスアカウントツールの実行
