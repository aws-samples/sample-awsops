---
sidebar_position: 2
title: カスタムエージェント
description: AI アシスタントのエージェント・スキル・連携・ツール構成を管理する管理者画面
---

import Screenshot from '@site/src/components/Screenshot';

# カスタムエージェント

AI アシスタントがどのように動作するかを、エージェント・スキル・連携・ツールで直接構成できるページです。

<Screenshot src="/screenshots/operations/custom-agents.png" alt="カスタムエージェント & スキル" />

:::info 管理者専用
このページには**管理者**のみがアクセスできます（Cognito 管理者グループまたは SSM 管理者許可リスト）。権限のないユーザーにはアクセス拒否画面が表示されます。
:::

## 主な機能

### New Agent（新しいエージェント）
アシスタントの応答方法を定義する新しいエージェントを作成します。

- **name**: エージェント名（kebab-case）
- **description**: エージェントの説明
- **persona**: システムプロンプト（エージェントの口調・観点）
- **gateway**: 担当領域 — **network**、**container**、**iac**、**data**、**security**、**monitoring**、**cost**、**ops**
- **routing keywords**: 質問をこのエージェントに振り分けるルーティングキーワード（カンマ区切り）
- **agent type**: ロールの種類 — **generic**、**on_demand**、**triage**、**rca**、**mitigation**、**evaluation**

### New Skill（新しいスキル）
複数のエージェントが共有する再利用可能なスキルを作成します。

- **name** / **description**: スキルの名前と説明
- **instructions**: スキル実行の指示
- **agent types (targeting)**: このスキルを適用する対象エージェントタイプ（チェックボックスで複数選択）

### Agents / Skills 一覧
- 新しく作成したエージェント・スキルは**無効（Disabled）**状態で始まり、一覧でトグルして有効化します。
- 標準提供の項目には **built-in** ラベルが表示され、トグルの対象ではありません。

### Integrations (advanced)
読み取り専用のオブザーバビリティデータソース（**Prometheus**、**Loki**、**Tempo**、**Mimir**、**ClickHouse**）とコネクタ（**Notion** など）は、現在このページではなく**連携（Integrations）ハブ**（`/integrations`）の**データソース** / **コネクタ**タブで、接続・認証情報の登録・スキーマキャッシュを管理します。このセクションには、そのカテゴリに含まれない**カスタム egress/ingress 連携**を直接登録する **Register integration** のみが残っています。

### Agent Space
アカウントで有効化するエージェント・スキル・連携と**ツール許可リスト（tool allowlist）**を選択して保存します。保存するたびにバージョンが上がります。

## 使い方
1. サイドバーの**連携**（`/integrations`）→ **Agents & Skills** タブのリンクからこのページ（`/customization`）に入ります（サイドバーには直接表示されません）
2. **New Agent** で name・description・persona を入力し、**gateway**・**agent type** を選択したうえでルーティングキーワードを記入して作成します
3. 必要に応じて **New Skill** でスキルを作成し、適用する **agent types** を選択します
4. 下の **Agents** / **Skills** 一覧で新しい項目をトグルして有効化します
5. データソース・コネクタの接続はサイドバーの**連携**（`/integrations`）で行います — このページの **Integrations (advanced)** セクションは、そのカテゴリ外のカスタム連携の登録用です
6. **Agent Space** で有効化する項目とツール許可リストを選択し、**Save Agent Space** で保存します

:::tip 無効の状態から始まります
新しく作成したエージェント・スキルは自動では有効化されません。一覧でトグルし、**Agent Space** に含めて保存することで、アシスタントに反映されます。
:::

:::info 認証情報は再表示されません
連携の認証情報は保存後、画面に表示されません。変更するには値を再入力して **Update** してください。
:::

## 関連ページ
- [データソース探索](../observability/datasources) - 連携ハブで接続したオブザーバビリティデータソースの探索
- [AI アシスタント](../overview/assistant) - 構成したエージェントとの対話
