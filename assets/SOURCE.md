# Screenshots & demo video for README

README から参照しているメディアをこのフォルダに配置してください。

| ファイル | 内容の目安 |
|----------|------------|
| **`demo.mp4`** | アプリ全体の操作デモ（会話 → TTS → パネル展開など）。README は `<video>` で埋め込み。 |
| `screenshot_01.png` | フルスクリーン or split レイアウト — VRM アバターとチャット |
| `screenshot_02.png` | Special Panel — カレンダー / 比較 / 地図など右ペイン展開 |
| `screenshot_03.png` | Hub（Scratch）— チャンク圧縮表示・チャンクレール・複数タブ |
| `screenshot_inbox.png` | Inbox タブ — 定刻通知・スケジュールルール実行 |
| `screenshot_branch.png` | 樹形分岐 — パンくず・兄弟ブランチ遷移 |
| `screenshot_turn_nav.png` | ターン番号ナビ（サブバー）と ↑↓ キー移動 |
| `screenshot_tts.png` | TTS 読み上げ中の文ハイライト |
| `screenshot_suggest.png` | `<prompts>` 提案ボタンと `/` ショートカット |
| `screenshot_stm_summary.png` | 通常チャット — STM サマリー FAB（右上）と展開パネル |

## `demo.mp4` の作り方

### 収録内容（推奨・30秒前後）

1. **fullscreen** または **split** でアバターが映っている状態
2. 送信: `今日のスケジュールを確認して、夜の時間に空いてるところに軽い運動を入れて提案して`
3. 応答の **TTS ハイライト** とアバターのリップシンク（音声 ON 推奨）
4. **カレンダー Special Panel** を開き、提案を1件操作
5. **提案ボタン**（`<prompts>`）を1つクリックして終わり

待ち時間は編集でカット。1本に詰めすぎるより、上記の流れが一通り見えること優先。

### エンコード

| 項目 | 推奨 |
|------|------|
| 形式 | **MP4（H.264 + AAC）** — GitHub README 互換が高い |
| 解像度 | 幅 1280〜1920px（README 上は `width="100%"` で縮小表示） |
| 長さ | 20〜45 秒 |
| サイズ | できれば **10 MB 未満**（大きいと clone / 表示が重い） |

OBS・ScreenToGif（MP4 出力）・ffmpeg などで可。

```bash
# 例: 軽く再エンコード（ffmpeg）
ffmpeg -i demo_raw.mp4 -c:v libx264 -crf 23 -preset slow -c:a aac -b:a 128k -movflags +faststart assets/demo.mp4
```

### README 側の挙動

- `muted autoplay loop` — GIF 代わりに自動ループ（ブラウザの自動再生ポリシー対応）
- `controls` — ユーザーが再生・一時停止・**ミュート解除**（TTS 音声を聞ける）
- ローカルで `<video>` が効かないビューアでは、同じパスのリンクから直接開ける

未配置の静止画は README 上でパス参照のみ。追加後にそのまま表示されます。
