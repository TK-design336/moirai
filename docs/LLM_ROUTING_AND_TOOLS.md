# ルーティングとLLM送信情報・ツール仕様

この文書では、現状の**ルーティング**、ルート結果に応じて**LLMに送る情報**、および**LLMが利用可能な各種ツール（function）の動作**をまとめます。

---

## 1. ルーティング

### 1.1 概要

ユーザー発話を受け取ると、まず**ルーティング**で以下を決定します。


| 項目               | 型            | 説明                    |
| ---------------- | ------------ | --------------------- |
| `taskKinds`      | `TaskKind[]` | タスク種別（複数可）            |
| `mode`           | `LLMMode`    | 推論モード（モデル・パラメータ選択に使用） |
| `webSearch`      | `boolean`    | Web検索ツールを有効にするか       |
| `extractedDates` | `Date[]`     | 発話から抽出した日付            |


- **TaskKind**: `schedule`  `map`  `transit`  `task`  `email`  `compare`  `note`  `quiz`  `timer`  `general`
- **LLMMode**: `fast`  `standard`  `reasoning`

ルーティングは次のいずれかで実行されます。

- **上書き**: `overrideTaskKinds` が指定されている場合はルーティングをスキップし、指定値を使用（例: Inboxのスケジュールルール）。
- **ルールベース**: `useRuleRouter === true`（デフォルト）のとき `ruleBasedRoute()` を使用。
- **LLMベース**: `useRuleRouter === false` のとき `llmRoute()` を使用。APIキー不足やパース失敗時は `ruleBasedRoute()` にフォールバック。

ルーティング後、**直近3件のユーザーメッセージ**それぞれでルーティングを再実行し、`taskKinds`・`extractedDates`・`mode` をマージする。mode は fast &lt; standard &lt; reasoning の優先度で、最も重いものを採用。

### 1.2 ルールベースルーター (`ruleBasedRoute`)

- **キーワードスコア**: 各 `TaskKind` ごとにキーワードリストを持ち、発話に含まれるとスコア加算（重み 2 または 3）。
  - 例: `schedule` → スケジュール, 予定, カレンダー, 空き時間, 日程, 締め切り, schedule, calendar など
  - `map` → 地図, マップ, 場所, スポット, 旅行, デート, map, spot, place など
  - その他も同様にキーワードでスコア付け。
- **taskKinds**: スコアが最大のタスク種別（複数同点可）。いずれも 0 の場合は `["general"]`。
- **mode**（デフォルトは `standard`。直近3件のユーザーメッセージそれぞれでルーティングし、得られた mode のうち最も重いものを採用）:
  - `reasoning`: 推論系キーワード（なぜ, 原因, 分析, 設計, 戦略 など）のスコアが 3 以上かつ standard より 1 以上高いとき。
  - `fast`: 挨拶・簡単な相槌キーワード（おはよう, ありがとう, ok など）のスコアが 2 以上かつ、reasoning/standard のいずれにも当てはまらないときのみ。
  - 上記以外は `standard`。
- **webSearch**: UIのWeb検索トグルがON、または検索系キーワード（最新, 今日, 天気, ニュース, 価格 など）のスコアが 3 以上のとき `true`。
- **extractedDates**: `extractDatesFromText(text, new Date())` で発話から日付を抽出。

### 1.3 LLMベースルーター (`llmRoute`)

- 1ターンのLLM呼び出しで、プロンプトに従い **1行** で次の形式を出力させます:  
`[TASK_KIND1,TASK_KIND2,...,MODE,WEB_SEARCH]`
- 使用プロンプト: `pc-prompt-router` の内容、未設定時は `DEFAULT_ROUTER_SYSTEM`（タスク種別・MODE・WEB_SEARCH の説明付き）。
- モデル: 各プロバイダの `pc-model-{provider}-router`（未設定時は gpt-4o-mini / claude-haiku-4-5 / gemini-2.0-flash 等）。
- パースに失敗した場合やAPIエラー時は `ruleBasedRoute(userText, false)` にフォールバック。
- **extractedDates** はルールベースと同様に `extractDatesFromText(userText, new Date())` で取得。

---

## 2. ルート結果に応じてLLMに送る情報

ルーティング結果（`route`）とメモリ・設定をもとに **システムプロンプト** を組み立て、**メッセージ** と合わせてLLMに送ります。

### 2.1 システムプロンプトの構成 (`buildSystemPrompt`)

次のブロックが順に連結されます。


| ブロック                       | 条件・内容                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **[Auto-run]**             | `isAutoRun === true` のときのみ。定刻タスクの自動実行である旨と、事務的な文体の指示。                                                         |
| **[Core Instruction]**     | `pc-prompt-core`（未設定時は DEFAULT_CORE）。言語・捏造禁止・根拠ある情報の利用など。                                                     |
| **[Mode Instruction]**     | `pc-prompt-mode` + **タスク種別ごとのヒント**（後述）。                                                                       |
| **[Persona Setting]**      | アバターの `personaSetting` または `pc-prompt-persona`。                                                               |
| **[User mentioned dates]** | `extractedDates` が存在するとき、ISO日付のリスト。                                                                           |
| **[Short-Term State]**     | `stm.summary`。直近会話の要約。                                                                                        |
| **[Long-Term Memory]**     | `selectRelevantLTM(ltm, taskKinds)` の結果（後述）。                                                                  |
| **[Connected Services]**   | `getConnectedToolsList()` で取得した接続済みツールの説明一覧。                                                                  |
| **[Pre-fetched Context]**  | `toolContext`（prefetch + Goal/Routine/Task の文脈）。                                                              |
| **[Free Note]**            | `noteContent` があるとき、行番号付きで「ユーザーの作業用ドキュメント」として記載。プロフィールではない旨を明記。                                               |
| **Panel specs / Format**   | `getFormatInstructionForTaskKinds(taskKinds)` で、出力形式・パネル仕様・感情タグ・`<prompts>` / `<media>` / `<note_patch>` の説明。 |


### 2.2 タスク種別ごとのヒント（TASK_MODE_HINTS）

`taskKinds` に応じて、どのパネル（`<calendar>`, `<map>`, `<transit>`, `<email>`, `<compare>`, `<note>`, `<quiz>`, `<task>`, `<timer>`, `<alarm>`）をいつ出力すべきかが指示されます。

- **schedule**: 予定・カレンダー相談時のみ `<calendar>`。既存予定はパネルが Google Calendar から取得するため、LLM は `type="proposed"` の新規提案のみ出力する。単なる予定確認の場合は、空の `<calendar><date>YYYY-MM-DD</date></calendar>` を返すとユーザーにその日のカレンダーを表示できる。Connected Services に `calendar_read` がある場合は、回答前に必ず `calendar_read` を呼ぶよう指示。
- **map**: 旅程・旅行・日帰り・デート・お出かけプラン、複数スポット案、店舗・飲食店・観光地など具体施設の候補提示では原則 `<map>`（推奨）。`route-plan` / `spot-compare`。地図上の施設比較は `<compare>` より `<map>`。抽象説明のみのときは本文のみ。
- **transit**: 乗換・交通情報を出すときのみ `<transit>`（station / place の区別あり）。
- **task**: タスク追加・完了・編集・削除時のみ `<task>`。
- **email**: メール整理・確認・返信時のみ `<email>`。
- **compare**: 比較・推薦時のみ `<compare>`。columns と col_* の対応も指示。
- **note**: 後で見返す資料としての要約・保存を求められたときのみ `<note>`。
- **quiz**: クイズ・練習問題を求められたときのみ `<quiz>`。
- **timer**: タイマー・アラームを明示的に求められたときのみ `<timer>` / `<alarm>`。
- **general**: パネルは意味のある構造化情報がある場合のみ。それ以外は本文のみでよい旨。

### 2.3 フォーマット指示とパネル種別の対応

`getFormatInstructionForTaskKinds(taskKinds)` は、**taskKind → パネル** の対応に基づき、出力すべきパネル仕様だけを付けます。

- **schedule** → calendar, map, transit, task  
- **map** → calendar, map, transit  
- **transit** → transit  
- **task** → calendar, task, email  
- **note** → note, quiz  
- **quiz** → note, quiz  
- **timer** → timer-alarm  
- **email** → email  
- **compare** → compare  
- **general** → パネル仕様なし（共通の出力形式のみ）

複数 taskKind にマッチする場合は、対応するパネル仕様の**和集合**がシステムプロンプトに含まれます。

### 2.4 Pre-fetched Context（toolContext）

`toolContext` は次の2つを `\n\n` で連結した文字列です。

1. **prefetchTools({ taskKinds, extractedDates })**
  - **schedule**: Google Calendar 接続時、`calendarRead` で対象期間の予定を取得（各予定の説明 description も含む）。期間は **extractedDates** があれば「その最小日 − 前の日数」〜「その最大日 ＋ 後の日数」、なければ「今日 − 前の日数」〜「今日 ＋ 後の日数」。前後の日数は Settings → General の「スケジュール Pre-fetch 前の日数」「スケジュール Pre-fetch 後の日数」で指定（デフォルト 2 日・7 日）。localStorage キー: `pc-schedule-prefetch-days-before`, `pc-schedule-prefetch-days-after`。
  - **email**: Gmail 接続時、`gmailRead({ maxResults: 5, unreadOnly: true })` で未読メール概要を取得。
  - **note** または **general**: Free Note で Google Docs を選択中なら、その Doc ID（`pc-google-docs-current-id`）で `docsRead` を実行。選択中でなければ Doc の prefetch は行わない。
  - 取得結果が「未接続」等のエラーでない場合のみ、その文字列が `[Pre-fetched Context]` に含まれる。
2. **loadGoalRoutineTaskContext(taskKinds)**
  - `schedule` / `task` / `timer` のいずれかが含まれるときのみ有効。
  - localStorage の `pc-goals`, `pc-routines`, `pc-tasks` を読み、`[Goals]`, `[Routines]`, `[Tasks]` の形で整形して連結。

これらがシステムプロンプトの **[Pre-fetched Context]** にそのまま入ります。

### 2.5 Long-Term Memory（LTM）の選択

`selectRelevantLTM(ltm, taskKinds)` は、**常に含める項目** と **taskKinds に依存する項目** に分けてLTMをフィルタし、文字列化します。

- **常に含める**
  - **User Traits**: 最大3件。
  - **User Preferences**: 最大10件。
  - **Task History**: `lastReference` でソートし、`pc-ltm-max-records-per-session`（デフォルト20）件まで。
  - **Decision Log**: 同様にソート・件数制限。
- **taskKinds に依存**
  - **compare** または **map** が含まれるとき: **Habit Logs** を最大10件（または max records）まで。
  - **quiz** が含まれるとき: **Learning Graph** を最大5件（または max records）まで。

有効期限（`pc-ltm-lifespan-days`）や最大件数は `loadLTM()` 内でサニタイズされた後の `ltm` が渡されます。

### 2.6 Connected Services リスト

`getConnectedToolsList()` は、**実際にトークンが存在するサービス** に応じて、LLM向けの短い説明を返します。

- **Google（pc-google-access-token あり）**
  - `calendar_read`: 予定確認・提案の前に必ず呼ぶ。dateRange.{from,to} で YYYY-MM-DD 指定。keyword で検索可。
  - `gmail_read`: Gmail メッセージ一覧。Params: {maxResults?, unreadOnly?}
  - `docs_read`: Google Docs を documentId で読む。URL の DOCUMENT_ID を利用。
- **Notion（pc-notion-api-token あり）**
  - `notion_read`: Notion ページの読み取り。Params: {pageId?, query?}

これが **[Connected Services]** としてシステムプロンプトに挿入され、ツールの「存在」と使い方のヒントが伝わります。

### 2.7 メッセージ・添付

- **メッセージ**: 直近 `pc-max-send-history` 件（デフォルト20）の会話。空のメッセージは除外。
- **画像**: `attachments` の `kind === "image"` かつ base64 ありのものを、最後のユーザーメッセージに画像パートとして付与。
- **PDF**: プロバイダが対応している場合、`kind === "pdf-direct"` をネイティブドキュメントとして送信。
- **テキスト添付**: 抽出テキストを「添付資料『名前』: 内容」の形で、最後のユーザーメッセージの末尾に連結。

### 2.8 モデル設定

- **getModelConfig(provider, route.mode)** で、`pc-model-{provider}-{mode}` から model / maxTokens / temperature を取得。
- 未設定時はプロバイダ・mode ごとのデフォルト（例: fast → gpt-4o-mini, standard → gpt-4o, reasoning → o3 など）が使われます。

---

## 3. LLMが利用可能なツール（Function Calling）

### 3.1 ツール利用の有無

- **有効なツールが1つでもある場合**（`getEnabledTools().length > 0`）: **ストリーミングは使わず**、`runLLMWithToolsLoop` で **非ストリーミング + ツールループ** が実行されます。
- **有効なツールが0個の場合**: 従来どおり `streamLLM` でストリーミングし、プロバイダ組み込みの **Web検索** のみ利用可能（`webSearch` が true のとき）。

ツールの有効/無効は **localStorage の `pc-tool-{ツール名}`** で制御します。  

- キーが無い、または値が `"true"` のとき有効。  
- 値が `"false"` のとき無効。  
- `getConnectedToolsList()` は「接続済みサービスの説明リスト」であり、ツールの on/off とは別です。

### 3.2 ツールループの流れ（runLLMWithToolsLoop）

1. 有効なツール定義を OpenAI / Claude / Gemini の形式に変換して渡す。
2. システムプロンプト + メッセージで **callLLMOnceWithTools** を呼ぶ（最大5ラウンド）。
3. 応答に **tool_calls** が含まれる場合:
  - 各ツール呼び出しに対して **executeTool(name, arguments)** を実行。
  - 結果を **tool_results** としてメッセージに追加し、同一モデルで再度呼び出し。
4. **tool_calls** がなくなるか、最大ラウンドに達するまで繰り返し。
5. 最終的なアシスタントのテキストを返し、その後は通常と同様にパース・TTS・STM更新などが行われます。

### 3.3 ツール一覧と動作


| ツール名               | 説明                                  | パラメータ                                                                                                  | 動作概要                                                                                                                                         |
| ------------------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **calendar_read**  | 予定確認。スケジュール回答や `<calendar>` 出力前に呼ぶ。 | `dateRange: { from, to }` (YYYY-MM-DD), `keyword?`                                                     | Google Calendar API で指定期間のイベント取得（説明 description 含む）。接続未設定時はエラー文字列を返す。                                                                                           |
| **calendar_write** | 予定の新規作成。                              | `title`, `start`, `end`, `description?`, `location?`, `allDay?`, `colorId?` ("1"–"11"), `recurrence?` (RRULE配列)               | Google Calendar にイベント作成。allDay のときは YYYY-MM-DD で指定。colorId は Google の事前定義色（1=Cocoa,2=Flamingo,…11=Citron）。パネルで提案の承認時に呼ばれる。                                                                                          |
| **calendar_update** | 既存予定の更新。                              | `eventId`, `title?`, `start?`, `end?`, `description?`, `location?`, `allDay?`                          | パネルで既存予定を編集し「変更を反映」を押したときに呼ばれる。LLM は `type="proposed"` で編集内容を出力し、ユーザーがパネルで該当既存予定を選んで承認する。                                                                                          |
| **task_read**      | アプリ内タスク一覧（Google Tasks 同期）。         | なし                                                                                                     | `syncGoogleTasks()` 後に `pc-tasks` を読み、タイトル・期限・完了・メモ概要をテキストで返す。                                                                               |
| **task_write**     | タスクの追加・編集・削除。                       | `action: "add" | "edit" | "delete"`, `id?`, `title?`, `notes?`, `due_date?`, `completed?`, `subtasks?` | add: Google Tasks に push し localStorage に追加。edit/delete: id または title+due_date で既存を特定し、Google API と localStorage を更新。`pc-tasks-changed` を発火。 |
| **gmail_list**     | Gmail メッセージ一覧。                      | `maxResults?`, `unreadOnly?`, `q?`, `after?`, `before?`, `from?`                                       | Gmail API でメッセージID一覧取得後、メタデータで Subject/From を取得し、行リストで返す。                                                                                    |
| **gmail_read**     | 1通のメール本文を取得。                        | `messageId`                                                                                            | Gmail API で指定 messageId のメール内容を取得して返す。                                                                                                       |
| **docs_read**      | Google Docs の内容を読む。                 | `documentId`                                                                                           | Google Docs API でドキュメント本文を取得。                                                                                                                |
| **docs_write**     | Google Doc に追記または上書き。新規作成も可。        | `content`, `documentId?`, `title?`, `mode?` ("append" | "replace")                                     | documentId あり: 既存ドキュメントに append/replace。なし: `docsCreate(title)` で新規作成してから replace。                                                           |
| **notion_read**    | Notion ページの読み取り・検索。                 | `pageId?`, `query?`                                                                                    | Notion API でページ取得または検索。                                                                                                                      |
| **notion_write**   | Notion ページの作成・更新。                   | `parentId?`, `pageId?`, `title?`, `content`                                                            | pageId + content: 既存ページ更新。parentId + title + content: 新規ページ作成。                                                                               |


実行時エラーは `[Tool error: ...]` の形で文字列として返し、そのままツール結果としてLLMに渡されます。

### 3.4 プロバイダ別ツール形式

- **OpenAI**: `type: "function"`, `function: { name, description, parameters }`。
- **Claude**: `name`, `description`, `input_schema`（properties + required）。
- **Gemini**: `function_declarations` の配列で `name`, `description`, `parameters`。

いずれも **executeTool** は共通で、戻り値の文字列がそのまま次のターンのツール結果として渡されます。

---

## 4. プロバイダ組み込みツール（ストリーミング時）

ツールが **1つも有効でない** ときは `streamLLM` が使われ、このときのみ **Web検索** が利用可能です。


| プロバイダ      | Web検索の有効化                | ツール名・備考                                                                                                                   |
| ---------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| **GPT**    | `webSearch === true` のとき | `tools: [{ type: "web_search_preview" }]`（Responses API 使用時）。                                                             |
| **Claude** | 同左                       | `tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }]`。`anthropic-beta: web-search-2025-03-05` ヘッダー。 |
| **Gemini** | 同左                       | `tools: [{ google_search: {} }]`。応答の grounding メタデータから引用を取得。                                                              |


Web検索結果や引用（citations）は、各プロバイダのストリーム/レスポンスから取り出し、`citationsRef.value` に設定されます。フロントではパース後の `body` に対する `endIndex` 付き引用として表示されます。

---

## 5. まとめ

- **ルーティング**: ルールまたはLLMで `taskKinds` / `mode` / `webSearch` / `extractedDates` を決定。
- **LLMに送る情報**: 上記ルートに基づき、システムプロンプト（Core, Mode, Persona, STM, LTM, Connected Services, Pre-fetched Context, Free Note, フォーマット・パネル仕様）と、メッセージ・画像・PDF・テキスト添付を組み合わせて送信。モデルは `route.mode` で選択。
- **Function Calling ツール**: calendar_read/write, task_read/write, gmail_list/read, docs_read/write, notion_read/write。有効なツールが1つでもあるとツールループが動き、ストリーミングは使わない。
- **Web検索**: ツールが0個のときのみストリーミングが使われ、`webSearch` が true のときにプロバイダ別の検索ツールが有効になる。

