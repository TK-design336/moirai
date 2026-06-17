import type { HubChunkRecord, HubImportance, HubPersistedState } from "./types";
import { ttlMsForImportance } from "./importanceTtl";

export function newChunkId(): string {
  return `chk_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export function maxImp(a: HubImportance, b: HubImportance): HubImportance {
  return (Math.max(a, b) as HubImportance);
}

export function closeChunk(
  chunk: HubChunkRecord,
  closedAt: string,
  /** 指定時: 完了往復が 1 以下なら常に single_line（importance に依らない）。2 往復超は chunk_card。 */
  completedTurns?: number,
): HubChunkRecord {
  const expiresAtMs = Date.now() + ttlMsForImportance(chunk.maxImportance);
  const collapsed: HubChunkRecord["collapsed"] =
    completedTurns != null
      ? completedTurns > 1
        ? "chunk_card"
        : "single_line"
      : chunk.maxImportance <= 1
        ? "single_line"
        : "chunk_card";
  return {
    ...chunk,
    closedAt,
    expiresAtMs,
    collapsed,
  };
}

export function findChunkContainingMessage(
  state: HubPersistedState,
  messageId: number,
): HubChunkRecord | undefined {
  return state.chunks.find((c) => c.messageIds.includes(messageId));
}

export function getOpenChunk(state: HubPersistedState): HubChunkRecord | undefined {
  if (!state.openChunkId) return undefined;
  return state.chunks.find((c) => c.id === state.openChunkId && c.closedAt === null);
}

/** Completed user→assistant pairs inside a chunk (for send-window counting). */
export function completedTurnsInChunk(
  messageIds: number[],
  roleById: Map<number, "user" | "ai">,
  contentById: Map<number, string>,
): number {
  let turns = 0;
  for (let i = 0; i < messageIds.length; i++) {
    const id = messageIds[i]!;
    if (roleById.get(id) !== "user") continue;
    const uContent = (contentById.get(id) ?? "").trim();
    if (!uContent) continue;
    const nextId = messageIds[i + 1];
    if (nextId === undefined) break;
    if (roleById.get(nextId) !== "ai") continue;
    const aContent = (contentById.get(nextId) ?? "").trim();
    if (!aContent) continue;
    turns++;
    i++;
  }
  return turns;
}
