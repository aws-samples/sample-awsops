---
sidebar_position: 2
---

import Screenshot from '@site/src/components/Screenshot';

# Security

Security ページでは、AWS 環境のセキュリティ脆弱性を総合的にモニタリングします。Public S3 バケット、開放された Security Group、暗号化されていない EBS ボリューム、コンテナの CVE 脆弱性を 1 か所で確認できます。

<Screenshot src="/screenshots/security/security.png" alt="Security" />

## 要約統計

ページ上部で主要なセキュリティ指標を確認できます:

| 指標 | 説明 | 推奨値 |
|------|------|----------|
| Public Buckets | パブリックアクセスが可能な S3 バケット | 0 |
| MFA Issues | MFA が有効化されていないユーザー | 0 |
| Open SGs | 0.0.0.0/0 のインバウンドを許可する Security Group | 最小化 |
| Unencrypted Vols | 暗号化されていない EBS ボリューム | 0 |
| CVE Critical | Critical レベルの脆弱性 | 0 |
| CVE High | High レベルの脆弱性 | 最小化 |

## 可視化チャート

### CVE 深刻度の分布
円グラフで脆弱性の深刻度別分布を表示します:

- **CRITICAL**（赤）: 即時対応が必要
- **HIGH**（オレンジ）: 迅速な対応を推奨
- **MEDIUM**（紫）: 計画的な対応が必要
- **LOW**（シアン）: 低優先度

### セキュリティ問題の要約
棒グラフでカテゴリごとの問題数を比較します。CVE は Critical/High に分かれて表示され、0 件のカテゴリのバーは表示されません（すべて 0 件の場合はチャート自体が非表示）。

## タブ別の詳細情報

### Public Buckets

パブリックアクセスが許可された S3 バケットの一覧です。

| カラム | 説明 |
|------|------|
| Bucket Name | バケット名 |
| Region | バケットのリージョン |
| Policy Public | バケットポリシーがパブリックかどうか |
| Block ACLs | Public ACL のブロック有無 |
| Block Policy | Public Policy のブロック有無 |

:::tip パブリックバケットへの対応
パブリックバケットが見つかったら、意図されたものか確認してください。意図しない場合は、S3 Block Public Access 設定を有効化して即座にブロックできます。
:::

### MFA Status

MFA が有効化されていない IAM ユーザーの一覧です。

| カラム | 説明 |
|------|------|
| Username | ユーザー名 |
| User ID | AWS ユーザー ID |
| Created | 作成日 |
| Password Last Used | 最終ログイン |

### Open Security Groups

0.0.0.0/0 からのインバウンドトラフィックを許可する Security Group ルールです。

| カラム | 説明 |
|------|------|
| Group ID | Security Group ID |
| Group Name | Security Group 名 |
| VPC | 所属する VPC |
| Protocol | 許可プロトコル |
| From/To Port | 許可ポート範囲 |
| CIDR | ソース CIDR（0.0.0.0/0 を強調表示） |

:::info セキュリティグループの推奨事項
0.0.0.0/0 CIDR はすべての IP からのアクセスを許可します。Web サーバー（80、443）以外のポートでは、特定の IP 帯域に制限することを推奨します。
:::

### Unencrypted Volumes

暗号化されていない EBS ボリュームの一覧です。

| カラム | 説明 |
|------|------|
| Volume ID | EBS ボリューム ID |
| Name | ボリューム名タグ |
| Type | ボリュームタイプ（gp3、io2 など） |
| Size (GB) | ボリュームサイズ |
| State | ボリュームの状態 |
| AZ | アベイラビリティゾーン |

:::tip ボリュームの暗号化方法
既存のボリュームは直接暗号化できません。暗号化されたスナップショットを作成した後、そのスナップショットから新しいボリュームを作成してください。
:::

### CVE Vulnerabilities

Trivy スキャンで検出されたコンテナイメージの脆弱性です。

| カラム | 説明 |
|------|------|
| CVE ID | 脆弱性 ID（例: CVE-2024-1234） |
| Severity | 深刻度（CRITICAL/HIGH/MEDIUM/LOW） |
| Package | 脆弱なパッケージ名 |
| Installed | インストールされたバージョン |
| Fixed | 修正されたバージョン（なければ --） |
| Title | 脆弱性のタイトル |

## 詳細情報パネル

各テーブルで行をクリックすると、スライドパネルで詳細情報を確認できます:

- **S3 バケット**: Public Access 設定の全体
- **IAM ユーザー**: ARN、作成日、最終ログイン
- **Security Group**: ルールの詳細と対応の推奨
- **EBS ボリューム**: 作成日、状態、暗号化対応の案内
- **CVE**: 脆弱性の説明、影響を受けるパッケージ、修正バージョン

## データソース

| データ | ソース |
|--------|------|
| S3, IAM, SG, EBS | Steampipe AWS プラグイン |
| CVE 脆弱性 | Steampipe Trivy プラグイン（`trivy_scan_vulnerability` テーブル） |
