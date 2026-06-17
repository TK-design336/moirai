import { HUB_MESSAGES_KEY } from "./types";
import { SCRATCH_MESSAGES_KEY } from "../chat/scratchSurface";

/**
 * Load Hub linear messages. Migrates from `pc-scratch-messages` once into `pc-hub-messages`.
 */
export function loadHubMessagesRaw(): string | null {
  const hub = localStorage.getItem(HUB_MESSAGES_KEY);
  if (hub !== null && hub !== "") return hub;
  const scratch = localStorage.getItem(SCRATCH_MESSAGES_KEY);
  if (scratch !== null && scratch !== "") {
    try {
      localStorage.setItem(HUB_MESSAGES_KEY, scratch);
    } catch {
      return scratch;
    }
  }
  return localStorage.getItem(HUB_MESSAGES_KEY);
}

export function saveHubMessagesJson(json: string): void {
  try {
    localStorage.setItem(HUB_MESSAGES_KEY, json);
  } catch {
    /* quota */
  }
}

/**
 * Hub 線形履歴（`loadHubMessagesRaw`）の末尾から、`avatarId` 付きの最後の AI メッセージ id。
 * 通常セッションの `findLastAiAvatarId` と対になる（Hub は `openSessions` ではないため別経路で復元が必要）。
 */
export function findLastHubLinearAiAvatarId(): string | undefined {
  try {
    if (typeof localStorage === "undefined") return undefined;
    const raw = loadHubMessagesRaw();
    if (!raw) return undefined;
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return undefined;
    for (let i = arr.length - 1; i >= 0; i--) {
      const m = arr[i] as { role?: string; avatarId?: string } | null;
      if (m && m.role === "ai" && m.avatarId) return m.avatarId;
    }
  } catch {
    return undefined;
  }
  return undefined;
}
