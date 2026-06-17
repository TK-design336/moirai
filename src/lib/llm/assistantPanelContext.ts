import { sanitizeMimickedSurfaceLogFromAssistantOutput } from "../chat/surfaceLogTimestamp";
import { parseResponse } from "../response/parser";

/** 旧形式: パネル JSON を本文末尾に付けていたマーカー（後方互換で表示時に除去） */
export const PC_SPECIAL_PANEL_CTX_START = "\n\n<<PC_SPECIAL_PANEL_CONTEXT>>\n";
export const PC_SPECIAL_PANEL_CTX_END = "\n<<END_PC_SPECIAL_PANEL_CONTEXT>>";

/** アシスタント `Message.content` に保存する生の LLM 出力（模倣タイムスタンプ除去＋トリム）。 */
export function storeAssistantRawContent(raw: string): string {
  return sanitizeMimickedSurfaceLogFromAssistantOutput(raw);
}

/** 旧メッセージ用: `<<PC_SPECIAL_PANEL_CONTEXT>>` JSON ブロックを除去 */
export function stripAssistantPanelContext(content: string): string {
  const i = content.indexOf(PC_SPECIAL_PANEL_CTX_START);
  if (i === -1) return content;
  return content.slice(0, i).trimEnd();
}

/** チャット UI・コピー・TTS・STM 圧縮用: 生レスポンスから表示用本文を得る */
export function stripAssistantContentForDisplay(content: string): string {
  const legacyStripped = stripAssistantPanelContext(content);
  if (!legacyStripped.trim()) return "";
  return parseResponse(legacyStripped).body;
}
