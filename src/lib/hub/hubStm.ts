import type { HubImportance, HubStmEntry } from "./types";
import { ttlMsForImportance } from "./importanceTtl";

export function pruneExpiredStmEntries(entries: HubStmEntry[], nowMs: number): HubStmEntry[] {
  return entries.filter((e) => e.expiresAtMs > nowMs);
}

export function makeStmEntry(
  chunkId: string,
  title: string,
  summary: string,
  maxImportance: HubImportance,
  provisional: boolean,
): HubStmEntry {
  const createdAt = new Date().toISOString();
  const expiresAtMs = Date.now() + ttlMsForImportance(maxImportance);
  return {
    id: `hstm_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    chunkId,
    title,
    summary,
    maxImportance,
    createdAt,
    expiresAtMs,
    provisional,
  };
}
