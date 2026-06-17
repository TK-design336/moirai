import type { ChatMessage } from "../../types/engine";
import { callLLMOnce, getModelConfig } from "../llm/client";
import { DEFAULT_STM_PROMPT, getSTMInterval } from "../memory/stm";
import type { HubPersistedState, HubProvisionalStm } from "./types";
import { completedTurnsInChunk } from "./chunkLogic";

export function openChunkCompletedTurns(
  hubState: HubPersistedState,
  roleById: Map<number, "user" | "ai">,
  contentById: Map<number, string>,
): number {
  const openId = hubState.openChunkId;
  if (!openId) return 0;
  const ch = hubState.chunks.find((c) => c.id === openId && c.closedAt === null);
  if (!ch) return 0;
  return completedTurnsInChunk(ch.messageIds, roleById, contentById);
}

function countUserMessages(msgs: ChatMessage[]): number {
  return msgs.filter((m) => m.role === "user").length;
}

/** Completed user→assistant pairs (both non-empty) within a linear ChatMessage slice. */
function countCompletedPairs(msgs: ChatMessage[]): number {
  let n = 0;
  for (let i = 0; i < msgs.length - 1; i++) {
    const u = msgs[i]!;
    const a = msgs[i + 1]!;
    if (u.role === "user" && a.role === "assistant" && u.content.trim() && a.content.trim()) {
      n++;
      i++;
    }
  }
  return n;
}

/**
 * Merge-style Hub provisional STM (same prompt shape as session STM).
 * Runs LLM only when the interval-aligned user count fires or too many new completed pairs
 * since `lastCompressedMessageCount` would exceed the send-window safety margin.
 */
export async function updateHubProvisionalStm(
  provider: "gpt" | "gemini" | "claude",
  openChunkId: string,
  chunkMessagesAsChat: ChatMessage[],
  existing: HubProvisionalStm | null | undefined,
  maxSendHistory: number,
): Promise<HubProvisionalStm | null> {
  if (!openChunkId) return null;

  const fullList = chunkMessagesAsChat.filter((m) => m.content.trim() !== "");
  if (fullList.length === 0) return null;

  const effective: HubProvisionalStm =
    existing && existing.chunkId === openChunkId
      ? {
          chunkId: existing.chunkId,
          summary: existing.summary ?? "",
          lastCompressedMessageCount: Math.max(0, existing.lastCompressedMessageCount ?? 0),
          updatedAt: existing.updatedAt,
        }
      : {
          chunkId: openChunkId,
          summary: "",
          lastCompressedMessageCount: 0,
          updatedAt: new Date().toISOString(),
        };

  const from = Math.min(effective.lastCompressedMessageCount, fullList.length);
  const pending = fullList.slice(from);
  if (pending.length === 0) {
    return effective;
  }

  const interval = getSTMInterval();
  const safetyThreshold = Math.max(1, maxSendHistory - 1);
  const newPairCount = countCompletedPairs(pending);
  const userOrdinal = countUserMessages(fullList);
  const intervalHit = userOrdinal > 0 && userOrdinal % interval === 0;
  const safetyHit = newPairCount >= safetyThreshold;
  const needMerge = safetyHit || intervalHit;

  if (!needMerge) {
    return effective;
  }

  const stmPrompt = DEFAULT_STM_PROMPT;
  const conversationText = pending
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n");

  const userContent = effective.summary.trim()
    ? `Previous summary:\n${effective.summary}\n\nNew turns since last summary:\n${conversationText}`
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
      "hub-chunk-stm",
    );
    return {
      chunkId: openChunkId,
      summary: newSummary.trim(),
      lastCompressedMessageCount: fullList.length,
      updatedAt: new Date().toISOString(),
    };
  } catch (e) {
    console.warn("Hub provisional STM merge failed:", e);
    return effective;
  }
}
