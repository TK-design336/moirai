import { loadHubState, saveHubState } from "./store";
import { loadHubMessagesRaw, saveHubMessagesJson } from "./hubMessages";
import { pruneHubState } from "./hubAfterCompletion";
import type { HubPersistedState } from "./types";

/**
 * 起動時: TTL 切れチャンクを state から落とし、対応する線形メッセージを localStorage から除去して整合させる。
 */
export function bootstrapHubStorage(): { hubState: HubPersistedState; messages: unknown[] } {
  const p = pruneHubState(loadHubState());
  let messages: unknown[] = [];
  try {
    const raw = loadHubMessagesRaw();
    if (raw) messages = JSON.parse(raw) as unknown[];
  } catch {
    messages = [];
  }
  if (!Array.isArray(messages)) messages = [];
  if (p.removedMessageIds.length > 0) {
    const rm = new Set(p.removedMessageIds);
    const before = messages.length;
    messages = (messages as { id?: number }[]).filter(
      (m) => m && typeof m === "object" && typeof m.id === "number" && !rm.has(m.id),
    );
    if (messages.length !== before) {
      saveHubMessagesJson(JSON.stringify(messages));
    }
  }
  saveHubState(p.state);
  return { hubState: p.state, messages };
}
