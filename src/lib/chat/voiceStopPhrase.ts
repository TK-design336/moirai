/**
 * 自動送信モード: 句読点除去後に停止系フレーズのみかどうか。
 * マッチ時は TTS 停止・LLM 非送信・入力欄非表示・聞き取り停止。再生中なら YouTube も一時停止。
 */

import { stripAsrFillers } from "../voice/asrFiller";

const PUNCT_AND_SPACE = /[。、！？…．.!?,;:・「」『』（）()\[\]{}【】〈〉《》\s\u3000]+/g;

/** 句読点・空白除去後の比較用文字列 */
export function normalizeVoiceStopPhrase(text: string): string {
  return text
    .trim()
    .replace(PUNCT_AND_SPACE, "")
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .toLowerCase();
}

/** 正規化後に完全一致する停止フレーズ（英字は小文字化済み） */
const VOICE_STOP_ONLY_NORMALIZED = new Set([
  "ストップ",
  "ストップして",
  "ストッ",
  "stop",
  "停止",
  "停止して",
  "止めて",
  "止まって",
  "うるさい",
  "うるせえ",
  "しずかに",
  "静かに",
  "静かにして",
  "黙って",
  "黙れ",
  "呼んでない",
  "呼んで無い",
  "呼んでません",
  "かけてない",
  "かけて無い",
]);

export function isAutoSendVoiceStopOnly(text: string): boolean {
  const n = normalizeVoiceStopPhrase(stripAsrFillers(text));
  if (!n) return false;
  return VOICE_STOP_ONLY_NORMALIZED.has(n);
}
