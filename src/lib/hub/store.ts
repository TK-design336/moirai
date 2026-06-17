import type { HubPersistedState, HubProvisionalStm } from "./types";
import { EMPTY_HUB_STATE, HUB_STATE_KEY } from "./types";
import { SCRATCH_MESSAGES_KEY } from "../chat/scratchSurface";
import { safeLocalStorageSetItem } from "../storage/safeLocalStorage";

/** Migrate legacy `lastMessageCount` (pre-merge rollout) to `lastCompressedMessageCount`. */
function normalizeHubProvisional(raw: unknown): HubProvisionalStm | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.chunkId !== "string") return null;
  const summary = typeof p.summary === "string" ? p.summary : "";
  const updatedAt = typeof p.updatedAt === "string" ? p.updatedAt : new Date().toISOString();
  let lastCompressed: number;
  if (typeof p.lastCompressedMessageCount === "number") {
    lastCompressed = p.lastCompressedMessageCount;
  } else if (typeof p.lastMessageCount === "number") {
    lastCompressed = p.lastMessageCount;
  } else {
    lastCompressed = 0;
  }
  return {
    chunkId: p.chunkId,
    summary,
    lastCompressedMessageCount: Math.max(0, Math.floor(lastCompressed)),
    updatedAt,
  };
}

export function loadHubState(): HubPersistedState {
  try {
    const raw = localStorage.getItem(HUB_STATE_KEY);
    if (!raw) return migrateHubStateFromScratchIfNeeded();
    const parsed = JSON.parse(raw) as HubPersistedState;
    if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.chunks)) {
      return { ...EMPTY_HUB_STATE };
    }
    return {
      ...EMPTY_HUB_STATE,
      ...parsed,
      chunks: parsed.chunks ?? [],
      stmEntries: parsed.stmEntries ?? [],
      provisionalStm: normalizeHubProvisional(parsed.provisionalStm),
    };
  } catch {
    return { ...EMPTY_HUB_STATE };
  }
}

export function saveHubState(state: HubPersistedState): void {
  safeLocalStorageSetItem(HUB_STATE_KEY, JSON.stringify(state));
}

/**
 * If no pc-hub-state but legacy scratch messages exist, create one open chunk
 * holding all message ids (Importance filled on next AI reply).
 */
function migrateHubStateFromScratchIfNeeded(): HubPersistedState {
  try {
    const rawScratch = localStorage.getItem(SCRATCH_MESSAGES_KEY);
    if (!rawScratch) return { ...EMPTY_HUB_STATE };
    const msgs = JSON.parse(rawScratch) as { id: number }[];
    if (!Array.isArray(msgs) || msgs.length === 0) return { ...EMPTY_HUB_STATE };

    const openChunkId = `chk_mig_${Date.now()}`;
    const ids = msgs.map((m) => m.id);
    const state: HubPersistedState = {
      schemaVersion: 1,
      chunks: [
        {
          id: openChunkId,
          messageIds: ids,
          closedAt: null,
          maxImportance: 1,
          title: "",
          shortSummary: "",
          folderId: null,
          titleGenDone: false,
          collapsed: "none",
        },
      ],
      stmEntries: [],
      provisionalStm: null,
      recall: null,
      openChunkId,
    };
    saveHubState(state);
    return state;
  } catch {
    return { ...EMPTY_HUB_STATE };
  }
}
