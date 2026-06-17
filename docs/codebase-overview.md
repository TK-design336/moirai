# コードベース概観（フォルダ・主要モジュール）

**Personal Concierge（パッケージ名 `moirai`）** は Tauri v2 デスクトップ＋ブラウザ SPA 兼用の React / TypeScript フロントと Rust バックエンドからなるアプリです。永続化は主に `localStorage`（キーは `pc-` 接頭辞）です。

この文書は**各フォルダの役割**と、**代表的なエクスポート・状態の意味**を短くまとめたものです。全ファイルの全メソッド／全変数の網羅ではありません（巨大コンポーネントはファイル内コメント・既存の `CLAUDE.md` / `docs/*.md` を参照してください）。

---

## ルート直下

| パス | 内容 |
|------|------|
| `src/` | アプリの本体（React）。 |
| `src-tauri/` | Tauri（Rust）エントリ、`invoke` コマンド、ネイティブ ASR など。 |
| `public/` | 静的アセット（Vite がそのまま配信）。`postinstall` で SoundTouch の worklet をコピー。 |
| `docs/` | 設計・挙動の補足ドキュメント（LLM、TTS、VRM など）。 |
| `scripts/` | ビルド周辺ユーティリティ（例: `convert-splash-webp.mjs`、uLipSync プロファイル export）。 |
| `crates/` | Rust 周辺の補助（例: Windows 向けプリビルドガード）。アプリ主処理は `src-tauri`。 |
| `.cursor/` | Cursor 向けルール・エージェント設定。 |
| `uLipSync-main/` | 参照用の uLipSync（Unity）サンプル資産。アプリ実行時には直接バンドルされない。 |
| `design.md` | デザインシステム・トークン（実装時の正）。 |
| `vite.config.ts` | Vite 設定。`TAURI_ENV_TARGET_TRIPLE` の有無で Tauri 判定し、`__IS_TAURI__` と `@tauri-apps/api/core` のエイリアス（ブラウザ時はモック）を切り替え。 |

---

## `src/` 配下

### `src/main.tsx`

- **役割**: React マウント、チャットガラス適用、Aivis モデルマネージャ初期化、Tauri 時の外部ブラウザで `_blank` を開くフック、Google OAuth ポップアップの `postMessage` 処理。
- **主な識別子**: `__IS_TAURI__`（ビルド時定数）。

### `src/App.tsx`

- **役割**: `ThemeProvider` 配下のルート UI。レイアウトモード（`split` / `compact` / `fullscreen`）、スプリッタ・全画面オーバーレイ、設定モーダル、`AvatarPanel` / `ChatPanel` / `NotePanel` の配置。
- **主な状態例**: `layoutMode`, `fullscreenLayoutStep`（チャット位置・非表示）、`settingsOpen`, `noteCollapsed`, フロントレイヤ表示（`avatarFrontCompact` など）。

### `src/components/`

UI コンポーネント（スタイルは原則 `global.css` のクラス）。

| ファイル | 役割の要約 |
|----------|------------|
| `ChatPanel.tsx` | チャット UI の中枢。セッション／ブランチ、送信、特別パネル、インボックス、Hub、検索、添付、ルーティング連携など。 |
| `AvatarPanel.tsx` | アバター表示、コスチューム、感情タグ、レイアウトモード連動のカメラ状態（localStorage キーは `cameraOrbitKey` 等で共有）。 |
| `VrmViewport.tsx` | Three.js / VRM ビューポート。ランタイム準備コールバック、遷移・出演イベント定数。 |
| `SpecialPanels.tsx` | AI メッセージ用構造化パネル（カレンダー、地図、交通、メール、比較、ノート、クイズ、質問など）の型と `SpecialPanelShell`。 |
| `SettingsModal.tsx` | 設定タブ一式（テーマ、API、プロンプト、サービス連携など）。 |
| `NotePanel.tsx` | フリーノート（Markdown 等）のパネル。 |
| `TaskBoard.tsx` | タスク板 UI（承認／却下フロー）。 |
| `ViewportSafeSelect.tsx` | ビューポート外にはみ出さないセレクト／アンカー付きリストメニュー。 |
| `ChatMessagesOverlayScroll.tsx` | チャットメッセージ領域のオーバーレイスクロール補助。 |
| `SplashScreen.tsx` | 起動スプラッシュ。 |
| `TauriWindowChrome.tsx` | デスクトップ窓のクローム UI。 |
| `YoutubeEmbedPlayer.tsx` / `YoutubePipOverlay.tsx` | YouTube 埋め込みと PiP オーバーレイ。 |
| `integrationServiceIcons.tsx` / `googleWorkspaceProductIcons.tsx` | 連携サービス・Google 製品の SVG アイコン。 |
| `AvatarMoiraiTransitionLogo.tsx` | ブランド／遷移用ロゴ表示。 |

### `src/context/`

| ファイル | 役割 |
|----------|------|
| `ThemeContext.tsx` | `data-theme` と CSS 変数（`--bg-primary`, `--accent` 等）を適用。`theme`, `lightColors`, `darkColors`, `toggleTheme` などを Context で提供。 |

### `src/data/`

デフォルトデータと localStorage 用のローダ／セーバ（アバター、背景、モーションセット、VRM 設定など）。

| ファイル | 役割の要約 |
|----------|------------|
| `avatarData.ts` | アバター定義の読み書き（`pc-avatars` 等）。 |
| `backgroundData.ts` | 背景オプション。 |
| `motionSetData.ts` | VRM モーションセット。 |
| `vrmSettings.ts` | VRM 表示まわりの設定デフォルト。 |

### `src/hooks/`

|               ファイル               | 役割                                                                                         |
| ------------------------------------ | -------------------------------------------------------------------------------------------- |
| `useLLMEngine.ts`                  | 送信パイプラインのフック：ルーティング、システムプロンプト、`streamLLM`、パース、TTS、STM 更新など。`sendMessage` 系の集約。 |
| `useAnchoredMenuPosition.ts`         | アンカー基準の `fixed` メニュー位置計算とリスナ（`computeAnchoredMenuStyle` 等）。           |

### `src/lib/`（ドメインロジック）

サブフォルダごとの役割です。ファイル単位の詳細は各モジュール先頭コメント・型定義を参照。

| フォルダ | 役割の要約 |
|----------|------------|
| `lib/attachments/` | PDF 等の添付抽出・プロバイダ対応判定。 |
| `lib/chat/` | チャットまわりの補助（未完成送信ガード、キーワード解決、Hub 用スクラッチ面 ID など）。`incompleteSendGuard.ts` は `pc-incomplete-send-guard` と連動。 |
| `lib/context/` | LLM に渡す補助コンテキスト（目標・ルーティン・タスク等、`goalRoutineTask.ts`）。 |
| `lib/hub/` | **Hub**（話題チャンク、STM 風追憶、メッセージ履歴）の型（`HUB_STATE_KEY` 等）、ストア、チャンク分割・重要度 TTL、完了後処理、デモシード。 |
| `lib/inbox/` | インボックスのスケジュールルールなど。 |
| `lib/lipsync/` | リップシンク用アルゴリズム、スムージング、オーディオタップ、TTS 連携ジョブ、プロファイル型。 |
| `lib/llm/` | ルータ（`router.ts`）、システムプロンプト（`systemPrompt.ts`）、プロバイダ別ストリーム（`client.ts`）、送信履歴ウィンドウ、画像ピクセル上限、ストリームデバッグ、セッションコンテキスト組み立て。 |
| `lib/markdown/` | Markdown 向け正規化・コードハイライト・番号ソート等。 |
| `lib/memory/` | **STM / LTM**（短期・長期記憶）の読み込み、圧縮トリガ、方針、マイグレーション、抽出器。 |
| `lib/response/` | LLM 応答文字列のパース（`parser.ts`）、パネル抽出（`panelExtractor.ts`）。 |
| `lib/session/` | セッションタイトル生成、チャットフォルダなど。 |
| `lib/sync/` | 外部同期（例: Google Tasks）。 |
| `lib/tools/` | **ツール呼び出し**（Calendar / Gmail / Docs / Notion 等）と、ルーティング結果に応じた **prefetch**（`prefetchTools`）、システムプロンプト用の接続ツール一覧（`getConnectedToolsList`）。 |
| `lib/tts/` | TTS クライアント、ビセーム、ストリーム分割、Aivis モデル管理、クライアント側処理。 |
| `lib/unity/` | Unity 連携を想定したアバター状態・カメラ入力などの橋渡し型。 |
| `lib/vrm/` | VRM ローダ、ステージ整列、表情パース、ランタイム（`VRMViewportRuntime`）、リップシンクデバッグ、FPS デバッグなど。 |
| `lib/youtube/` | 検索ファースト結果、PiP ストア、制御ブリッジ。 |

**ルートに近い単発ファイル（例）**

- `layoutFractions.ts`: パネル幅の比率 persisted リサイズ（`useFractionResizable` 用キー・デフォルト）。
- `chatGlass.ts`: チャット面板のガラス効果の読み込みと `document` 適用。
- `googleAuth.ts` / `googleApiError.ts`: Google OAuth・API エラー整形。
- `nativeAsrConfig.ts`: ネイティブ ASR 設定と Tauri 連携。
- `tauri-browser-mock.ts`: ブラウザ開発時の `invoke` スタブ。
- `dateExtractor.ts`: ユーザ文から日付抽出（prefetch レンジ等に利用）。
- `avatarFrontLayer.ts`: アバター前面レイヤ表示モードの永続化。
- `splashPeriod.ts`: スプラッシュ表示期間の制御補助。

### `src/styles/`

| ファイル | 役割 |
|----------|------|
| `global.css` | アプリ全体のスタイル一元管理。`[data-theme="light"|"dark"]` と `var(--…)` トークン。 |

### `src/types/`

| ファイル | 役割 |
|----------|------|
| `engine.ts` | チャット・LLM・タスク種別（`TaskKind`）、ルート結果（`RouteResult`）、アバター状態（`AvatarState`）、引用、YouTube 操作、UI 操作タグなど、アプリ横断の型。 |
| `speech-recognition.d.ts` 等 | ブラウザ API の型補完。 |

---

## `src-tauri/`（Rust）

| パス | 役割 |
|------|------|
| `src/main.rs` | バイナリエントリ。 |
| `src/lib.rs` | `run()` で Tauri ビルダー起動。登録コマンド例: `fetch_og_meta`, `fetch_proxy`, OAuth 補助、`snap_window_work_area_outer`, **native_asr_**\* 系。 |
| `src/ogp.rs` | OGP / リンクプレビュー取得（`fetch_og_meta`）。 |
| `src/proxy.rs` | プロキシ経由フェッチ（CORS 回避等）。 |
| `src/oauth_server.rs` | ローカル OAuth コードフロー補助・トークンリフレッシュ等。 |
| `src/window_snap.rs` | ウィンドウをワークエリアにスナップ。 |
| `src/native_asr/` | オンデバイス音声認識（Whisper 系モデル、デバイス一覧、設定、ストリーム、セグメントビルダ等）。 |

---

## 既存の詳細ドキュメント（深掘り用）

- `docs/llm-architecture.md`, `docs/LLM_ROUTING_AND_TOOLS.md` — LLM とツール。
- `docs/tts-architecture.md`, `docs/tts-operation-mechanism.md` — TTS。
- `docs/vrm-motion-control.md` — VRM・リップシンク・モーション。

---

## メンテナンス

新しいフォルダや「正」のエントリポイントを追加したら、このファイルの該当節に**1〜2 行**追記すると、全体像が保ちやすくなります。
