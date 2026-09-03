---
sidebar_position: 3
title: CloudTrail
description: AWS API アクティビティログを照会し、監査イベントを分析します。
---

import Screenshot from '@site/src/components/Screenshot';

# CloudTrail

AWS アカウントの API アクティビティを記録する CloudTrail のトレイルとイベントを照会できるページです。

<Screenshot src="/screenshots/monitoring/cloudtrail.png" alt="CloudTrail" />

## 主な機能

### トレイルサマリー
- **Total Trails**: 全トレイル数
- **Active**: ロギングが有効なトレイル数
- **Multi-Region**: マルチリージョントレイル数
- **Log Validated**: ログファイル検証が有効なトレイル数

### タブ構成
| タブ | 内容 |
|---|------|
| Trails | トレイル一覧、設定、S3 バケット |
| Recent Events | 最近の API イベント (全イベント) |
| Write Events | 書き込みイベントのみフィルタリング (リソース変更の監査) |

:::info Lazy Loading
Events および Write Events タブは、クリック時にのみデータをロードします (`eventsLoaded` フラグ)。ページ表示時には `summary` + `trailList` のみを照会し、ユーザーが Events/Writes タブのいずれかをクリックすると一度に両方をロードします — CloudTrail Lookup API は呼び出し回数が多く応答時間も長いため、CloudFront の 30 秒タイムアウトを回避するための最適化です。
:::

:::tip マルチアカウント
マルチアカウントモードでは、サイドバーの AccountSelector で対象アカウントを切り替えられ、トレイル一覧およびイベントに **Account** カラムが自動追加されます (AccountBadge でエイリアス + カラードットを表示)。トレイル詳細パネルでも、どのアカウントに属するかがヘッダーに明示されます。
:::

### トレイル詳細情報
トレイル行をクリックするとスライドパネルで確認できます:
- **Trail**: 名前、ARN、ホームリージョン、ロギング状態、Multi-Region の有無
- **Storage**: S3 バケット、プレフィックス、SNS トピック、KMS キー
- **CloudWatch**: ロググループ、IAM ロール、最終送信時刻
- **Validation**: ログファイル検証、最終配信時刻
- **Tags**: リソースタグ

### イベント詳細情報
イベント行をクリックすると確認できます:
- **Event**: ID、名前、ソース、時刻、ユーザー（Access Key は管理者専用）
- **Resource**: リソースタイプおよび名前
- **Raw Event**（管理者専用）: JSON 形式のプロジェクション済みイベントデータ — userIdentity は選別された身元属性に縮約され、資格情報系のキーは deny-list でマスキングされます（完全性の保証ではなく defense-in-depth — コピー前に内容の確認を推奨）

## 使い方

1. **Trails タブ**: トレイルの設定と状態を確認
2. **Events タブ**: 最近の API アクティビティを照会 (Read + Write)
3. **Write Events タブ**: リソース変更イベントのみをフィルタリングして監査
4. **詳細表示**: 行をクリックして全情報を確認

:::tip Read vs Write イベント
- **Read**: DescribeInstances、GetObject などの参照操作
- **Write**: CreateInstance、DeleteBucket などの変更操作
セキュリティ監査時は Write Events タブを重点的に確認してください。
:::

## 活用のヒント

### セキュリティベストプラクティスの確認
- **Multi-Region**: 全リージョンのアクティビティを記録するには必須
- **Log Validation**: ログファイルの改ざん検知
- **KMS 暗号化**: S3 に保存されるログファイルの暗号化

### 不審なアクティビティの検知
Write Events タブで次を確認してください:
- 通常と異なる時間帯の API 呼び出し
- 不明なユーザー名（管理者は Access Key も確認可能）
- 大量の削除 (Delete*) イベント
- IAM 関連の変更イベント

### CloudWatch Logs 連携
トレイル詳細で CloudWatch Log Group が設定されていれば、リアルタイム通知とメトリクスフィルターを使用できます。

:::info イベント保管期間
CloudTrail のイベント履歴はデフォルトで 90 日間保管されます。長期保管が必要な場合は、トレイルを作成して S3 に保存してください。
:::

## AI 分析のヒント

AI アシスタントで Monitoring Gateway を活用した質問の例:

- 「今日発生したセキュリティ関連イベントを分析して」
- 「特定ユーザーの最近のアクティビティ履歴を見せて」
- 「削除イベントの中で不審なパターンを見つけて」
- 「このトレイル設定がセキュリティベストプラクティスに合っているか確認して」

## 関連ページ

- [CloudWatch](../monitoring/cloudwatch) - アラーム管理
- [IAM](../security/iam) - ユーザーおよびロール管理
- [Compliance](../security/compliance) - CIS ベンチマーク
