/** Hub / chunk importance (from `<hub_meta importance="…"/>`). */
export type HubImportance = 1 | 2 | 3 | 4 | 5;

export const HUB_STATE_KEY = "pc-hub-state";
export const HUB_MESSAGES_KEY = "pc-hub-messages";

/** One closed or open topic segment in Hub linear history. */
export interface HubChunkRecord {
  id: string;
  messageIds: number[];
  /** null while the segment is still the active open chunk (not yet closed by topic_shift or other rules). */
  closedAt: string | null;
  maxImportance: HubImportance;
  title: string;
  shortSummary: string;
  folderId: string | null;
  /** Title/summary/folder from generateHubChunkTitleSummaryAndFolder; false while loading. */
  titleGenDone?: boolean;
  /** How this chunk is shown when idle / TTL. */
  collapsed: "none" | "single_line" | "chunk_card";
  /** Epoch ms when TTL removes this chunk (set when closed). */
  expiresAtMs?: number;
}

/** STM-style row for Recall + send-window injection (separate from session STM). */
export interface HubStmEntry {
  id: string;
  chunkId: string;
  title: string;
  summary: string;
  maxImportance: HubImportance;
  createdAt: string;
  expiresAtMs: number;
  provisional?: boolean;
}

export interface HubProvisionalStm {
  chunkId: string;
  summary: string;
  /** Index boundary in the linear ChatMessage list: messages before this index are folded into `summary`. */
  lastCompressedMessageCount: number;
  updatedAt: string;
}

/** Recall: chunk lifted to tail until next reply or cancel. */
export interface HubRecallState {
  chunkId: string;
  /** Message ids in linear order before recall. */
  originalOrder: number[];
}

export interface HubPersistedState {
  schemaVersion: 1;
  chunks: HubChunkRecord[];
  stmEntries: HubStmEntry[];
  provisionalStm?: HubProvisionalStm | null;
  recall?: HubRecallState | null;
  /** Current open chunk id (last segment). */
  openChunkId: string | null;
}

export const EMPTY_HUB_STATE: HubPersistedState = {
  schemaVersion: 1,
  chunks: [],
  stmEntries: [],
  provisionalStm: null,
  recall: null,
  openChunkId: null,
};
