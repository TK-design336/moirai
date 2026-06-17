import type { ChatMessage } from "../../types/engine";

/**
 * LLM 送信用に履歴を切り出す。
 * `maxCompletedTurns` = 直近に含める「完了ターン」（各ターンはユーザ発話から次のユーザ直前まで）の最大数。
 * 末尾の最新ユーザ発話（送信中の入力）は常に含め、直前の `maxCompletedTurns` 組の user→(assistant…)→user 境界で区切る。
 * アシスタント欠損時もユーザ位置で区切るため、空の trimmed content のメッセージは先に除く（従来どおり）。
 */
export function sliceChatHistoryForSendWindow(
    messages: ChatMessage[],
    maxCompletedTurns: number,
): ChatMessage[] {
  const n = Math.max(1, Math.floor(maxCompletedTurns));
  const msgs = messages.filter((m) => m.content.trim() !== "");
  const userIndices: number[] = [];
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role === "user") userIndices.push(i);
  }
  if (userIndices.length === 0) return [];
  const k = userIndices.length;
  const startUserOrdinal = Math.max(0, k - (n + 1));
  const start = userIndices[startUserOrdinal]!;
  return msgs.slice(start);
}

/**
 * Hub も通常チャットと同じ「直近 N 完了ターン」窓を使う。
 * （旧: importance 1 ターンを直前以外捨てると、閉じチャンク末尾などが欠落し不連続になった。）
 */
export function sliceChatHistoryForHubSendWindow(
  messages: ChatMessage[],
  maxCompletedTurns: number,
): ChatMessage[] {
  return sliceChatHistoryForSendWindow(messages, maxCompletedTurns);
}
