import type { STMState, ChatMessage } from "../../types/engine";
import { callLLMOnce, getModelConfig } from "../llm/client";

export const STM_KEY_PREFIX = "pc-stm-";

/** Default STM update interval (per user message). Overridden by pc-stm-interval, capped by pc-max-send-history. */
export const STM_INTERVAL_DEFAULT = 4;

export const DEFAULT_STM_PROMPT = `You are a context compressor. You will be given (1) the previous summary and (2) only the NEW conversation turns since that summary was produced. Produce an updated compact summary (max 200 words) that incorporates these new turns and captures key facts, decisions, and ongoing tasks from the whole conversation. Respond in the same language as the conversation. Output ONLY the summary text, no meta-commentary.`;

/**
 * Completed-turn cap for LLM send window (main chat, Hub, STM interval clamp, etc.).
 * Key: `pc-max-send-history`.
 */
export function getMaxSendHistory(): number {
  return Math.max(1, parseInt(localStorage.getItem("pc-max-send-history") ?? "20", 10) || 20);
}

/**
 * Effective STM update interval: from pc-stm-interval (every Nth user message), capped by pc-max-send-history
 * (same unit: completed-turn count used for the send window). Hub の仮想 STM も同じ値を参照します。
 */
export function getSTMInterval(): number {
  const raw = localStorage.getItem("pc-stm-interval");
  const interval = raw !== null ? Math.max(1, parseInt(raw, 10) || STM_INTERVAL_DEFAULT) : STM_INTERVAL_DEFAULT;
  const maxSend = getMaxSendHistory();
  return Math.min(interval, maxSend);
}

export function loadSTM(sessionId: string): STMState {
  const raw = localStorage.getItem(STM_KEY_PREFIX + sessionId);
  if (raw) {
    try { return JSON.parse(raw); } catch {}
  }
  return { summary: "", turnCount: 0, lastUpdatedAt: "" };
}

export function saveSTM(sessionId: string, state: STMState): void {
  localStorage.setItem(STM_KEY_PREFIX + sessionId, JSON.stringify(state));
}

/**
 * Triggers STM compression every getSTMInterval() turns. Only messages that were not yet
 * included in the last compression are sent; the LLM is asked to merge them into the existing summary.
 * @param allBranchMessages - When provided, messages from ALL branches in the session are used
 *   for compression instead of only the current branch's recent history.
 */
export async function maybeTriggerSTMUpdate(
  sessionId: string,
  turnCount: number,
  recentMessages: ChatMessage[],
  provider: "gpt" | "gemini" | "claude",
  allBranchMessages?: ChatMessage[],
): Promise<void> {
  const interval = getSTMInterval();
  if (turnCount % interval !== 0 || turnCount === 0) return;

  const stmPrompt = DEFAULT_STM_PROMPT;
  const current = loadSTM(sessionId);

  // Full list: all-branch (deduped) or current branch recent messages
  const fullList: ChatMessage[] = (() => {
    if (allBranchMessages && allBranchMessages.length > 0) {
      const seen = new Set<string>();
      return allBranchMessages.filter((m) => {
        const key = `${m.role}::${m.content}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    return recentMessages;
  })();

  const from = current.lastCompressedMessageCount ?? 0;
  const newMessagesOnly = fullList.slice(from);
  if (newMessagesOnly.length === 0) return;

  const conversationText = newMessagesOnly
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n");

  const userContent = current.summary
    ? `Previous summary:\n${current.summary}\n\nNew turns since last summary:\n${conversationText}`
    : `Conversation:\n${conversationText}`;

  try {
    const cfg = getModelConfig(provider, "stm");
    const newSummary = await callLLMOnce(
      provider,
      cfg.model,
      stmPrompt,
      [{ role: "user", content: userContent }],
      Math.min(cfg.maxTokens, 300),
      cfg.temperature,
      "stm-compress",
    );
    saveSTM(sessionId, {
      summary: newSummary,
      turnCount,
      lastUpdatedAt: new Date().toISOString(),
      lastCompressedMessageCount: fullList.length,
    });
  } catch (e) {
    console.warn("STM compression failed:", e);
  }
}
