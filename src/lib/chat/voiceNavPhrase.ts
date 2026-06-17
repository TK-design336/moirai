/**
 * 自動送信モード: 句読点除去後に画面遷移系フレーズのみかどうか。
 * マッチ時は ui_action 相当の遷移のみ実行（LLM 非送信・入力欄非表示・聞き取り継続）。
 *
 * フレーズは X（画面名）+ Y（任意の動作語）の組み合わせで判定する。
 */

import type { UiAction } from "../../types/engine";
import { stripAsrFillers } from "../voice/asrFiller";
import { normalizeVoiceStopPhrase } from "./voiceStopPhrase";

type NavActionType = Extract<UiAction["type"], "open_hub" | "open_inbox" | "open_new_chat">;

/** Y: なし（空文字）または共通の動作・遷移サフィックス */
const NAV_Y_COMMON = [
  "",
  "移動",
  "へ",
  "へ移動",
  "に移動",
  "へ移動して",
  "に移動して",
  "行って",
  "に行って",
  "へ行って",
  "開いて",
  "を開いて",
  "展開",
  "を展開",
  "展開して",
  "を展開して",
] as const;

/** open_new_chat 用の追加 Y */
const NAV_Y_NEW_CHAT_EXTRA = ["開始", "始めて", "スタート", "をスタート"] as const;

const NAV_X_RULES: ReadonlyArray<{
  type: NavActionType;
  xs: readonly string[];
  yExtra?: readonly string[];
}> = [
  {
    type: "open_hub",
    xs: ["ハブ", "hub", "ハブ画面", "ハブパネル", "ハブページ", "ハブタブ"],
  },
  {
    type: "open_inbox",
    xs: ["インボックス", "inbox", "インボックス画面", "インボックスパネル", "インボックスページ", "インボックスタブ"],
  },
  {
    type: "open_new_chat",
    xs: [
      "タブ",
      "新規タブ",
      "新規のタブ",
      "新しいタブ",
      "チャット",
      "新規チャット",
      "新規のチャット",
      "新しいチャット",
      "Chat",
      "chat",
      "新規セッション",
      "新規のセッション",
      "新規会話",
      "新規の会話",
      "新しい会話",
      "新しいセッション",
      "新規チャットタブ",
      "新規のチャットタブ",
      "新しいチャットタブ",
      "新規セッションタブ",
      "新規のセッションタブ",
      "新しいセッションタブ",
      "新規会話タブ",
      "新規の会話タブ",
      "新しい会話タブ",
    ],
    yExtra: NAV_Y_NEW_CHAT_EXTRA,
  },
];

function navYList(yExtra?: readonly string[]): readonly string[] {
  return yExtra ? [...NAV_Y_COMMON, ...yExtra] : NAV_Y_COMMON;
}

/** 最長 X 優先で X+Y の完全一致を返す */
export function matchAutoSendVoiceNav(text: string): UiAction | null {
  const n = normalizeVoiceStopPhrase(stripAsrFillers(text));
  if (!n) return null;

  let best: { type: NavActionType; xLen: number } | null = null;

  for (const rule of NAV_X_RULES) {
    const ys = navYList(rule.yExtra);
    for (const x of rule.xs) {
      const nx = normalizeVoiceStopPhrase(x);
      if (!n.startsWith(nx)) continue;
      const suffix = n.slice(nx.length);
      for (const y of ys) {
        const ny = normalizeVoiceStopPhrase(y);
        if (suffix !== ny) continue;
        if (!best || nx.length > best.xLen) {
          best = { type: rule.type, xLen: nx.length };
        }
      }
    }
  }

  return best ? { type: best.type } : null;
}

/**
 * まだ X または Y の途中（例: 「新しいセッションタブに」→ 次に「移動」が来うる）なら true。
 * 無音タイマーでの誤送信を防ぐ。
 */
export function isAutoSendVoiceNavIncomplete(text: string): boolean {
  const stripped = stripAsrFillers(text);
  const n = normalizeVoiceStopPhrase(stripped);
  if (!n) return false;
  if (matchAutoSendVoiceNav(stripped)) return false;

  for (const rule of NAV_X_RULES) {
    const ys = navYList(rule.yExtra);
    for (const x of rule.xs) {
      const nx = normalizeVoiceStopPhrase(x);
      if (nx.startsWith(n) && n.length < nx.length) return true;
      if (!n.startsWith(nx)) continue;
      const suffix = n.slice(nx.length);
      if (!suffix) continue;
      for (const y of ys) {
        const ny = normalizeVoiceStopPhrase(y);
        if (ny.startsWith(suffix) && suffix.length < ny.length) return true;
      }
    }
  }
  return false;
}
