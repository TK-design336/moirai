import type { HubChunkRecord, HubImportance, HubPersistedState, HubRecallState } from "./types";
import { closeChunk, completedTurnsInChunk, maxImp, newChunkId } from "./chunkLogic";
import { pruneExpiredStmEntries } from "./hubStm";

export function defaultHubMeta(): { importance: HubImportance; topicShift: boolean } {
  return { importance: 3, topicShift: false };
}

function chunkById(state: HubPersistedState, id: string): HubChunkRecord | undefined {
  return state.chunks.find((c) => c.id === id);
}

/** If no open chunk, create one holding `allMessageIds` (migration / first load). */
export function ensureOpenChunkExists(
  state: HubPersistedState,
  allMessageIds: number[],
): HubPersistedState {
  const openId = state.openChunkId;
  const open = openId ? chunkById(state, openId) : undefined;
  if (open && open.closedAt === null) return state;
  if (allMessageIds.length === 0) return state;
  const id = newChunkId();
  return {
    ...state,
    chunks: [
      ...state.chunks,
      {
        id,
        messageIds: [...allMessageIds],
        closedAt: null,
        maxImportance: 1,
        title: "",
        shortSummary: "",
        folderId: null,
        titleGenDone: false,
        collapsed: "none",
      },
    ],
    openChunkId: id,
  };
}

function messageIdsOwnedByClosedChunks(chunks: HubChunkRecord[]): Set<number> {
  const s = new Set<number>();
  for (const c of chunks) {
    if (c.closedAt === null) continue;
    for (const id of c.messageIds) s.add(id);
  }
  return s;
}

/**
 * When Hub scratch messages are truncated (e.g. resend from an earlier user turn), remove message ids
 * that no longer exist so chunk `lastId` / `applyHubMetaAfterAi` stay aligned with the linear thread.
 */
export function pruneHubChunksAfterScratchTruncate(
  state: HubPersistedState,
  orderedScratchMessageIds: number[],
): HubPersistedState {
  const existing = new Set(orderedScratchMessageIds);
  let chunks = state.chunks.map((c) => ({
    ...c,
    messageIds: c.messageIds.filter((id) => existing.has(id)),
  }));
  chunks = chunks.filter((c) => c.messageIds.length > 0 || c.closedAt === null);

  const inClosedAfterFilter = messageIdsOwnedByClosedChunks(chunks);
  chunks = chunks.map((c) => {
    if (c.closedAt !== null) return c;
    const deduped = c.messageIds.filter((id) => !inClosedAfterFilter.has(id));
    return deduped.length === c.messageIds.length ? c : { ...c, messageIds: deduped };
  });

  let openChunkId = state.openChunkId;
  let open = openChunkId ? chunks.find((c) => c.id === openChunkId && c.closedAt === null) : undefined;
  if (openChunkId && !open) {
    openChunkId = chunks.find((c) => c.closedAt === null)?.id ?? null;
    open = openChunkId ? chunks.find((c) => c.id === openChunkId && c.closedAt === null) : undefined;
  }

  if (open && open.messageIds.length === 0 && orderedScratchMessageIds.length > 0) {
    const repairOpenId = open.id;
    const inClosed = messageIdsOwnedByClosedChunks(chunks);
    const tailIds = orderedScratchMessageIds.filter((id) => !inClosed.has(id));
    // Only assign messages not already owned by closed chunks. Never fall back to the full
    // scratch list — that would pull every past chunk into the open chunk after a delete.
    if (tailIds.length > 0) {
      chunks = chunks.map((c) => (c.id === repairOpenId ? { ...c, messageIds: [...tailIds] } : c));
      open = chunks.find((c) => c.id === repairOpenId);
    }
  }

  if (!chunks.some((c) => c.closedAt === null)) {
    const inClosed = messageIdsOwnedByClosedChunks(chunks);
    const tailIds = orderedScratchMessageIds.filter((id) => !inClosed.has(id));
    const id = newChunkId();
    chunks = [
      ...chunks,
      {
        id,
        messageIds: tailIds.length > 0 ? [...tailIds] : [],
        closedAt: null,
        maxImportance: 1,
        title: "",
        shortSummary: "",
        folderId: null,
        titleGenDone: false,
        collapsed: "none",
      },
    ];
    openChunkId = id;
  }

  return { ...state, chunks, openChunkId };
}

/** Append a user message id to the open chunk (call at Hub user send, before LLM). */
export function appendUserIdToOpenChunk(state: HubPersistedState, userMsgId: number): HubPersistedState {
  const openId = state.openChunkId;
  if (!openId) return state;
  return {
    ...state,
    chunks: state.chunks.map((c) =>
      c.id === openId && c.closedAt === null
        ? { ...c, messageIds: c.messageIds.includes(userMsgId) ? c.messageIds : [...c.messageIds, userMsgId] }
        : c,
    ),
  };
}

/** Hub: 未閉じの open chunk が圧縮表示のとき、ユーザー送信に合わせて全文表示へ戻す。 */
export function expandOpenChunkIfCompressedOnUserSend(state: HubPersistedState): HubPersistedState {
  const openId = state.openChunkId;
  if (!openId) return state;
  let changed = false;
  const chunks = state.chunks.map((c) => {
    if (c.id !== openId || c.closedAt !== null) return c;
    if (c.collapsed === "none") return c;
    changed = true;
    return { ...c, collapsed: "none" as const };
  });
  return changed ? { ...state, chunks } : state;
}

export type SplitHubChunkAtUserOpts = {
  /** topic_shift 相当: 閉じる chunk 前半の往復数（single_line / chunk_card 推定用） */
  linearForTurnCount?: HubLinearForTurnCount[];
  /** 新 open chunk の maxImportance（尾側メッセージの最大 importance。省略時は 1） */
  newOpenMaxImportance?: HubImportance;
};

/**
 * 手動で `topic_shift` 相当の分割: いまの open chunk 内で `userMsgId` より前を閉じ、以降を新しい open chunk にする。
 * 先頭のユーザーメッセージ（chunk 先頭）・open 外のメッセージでは no-op。
 */
export function splitHubChunkAtUserMessage(
  state: HubPersistedState,
  userMsgId: number,
  opts?: SplitHubChunkAtUserOpts,
): HubPersistedState {
  const openId = state.openChunkId;
  if (!openId) return state;
  const open = chunkById(state, openId);
  if (!open || open.closedAt !== null) return state;
  const i = open.messageIds.indexOf(userMsgId);
  if (i <= 0) return state;
  const head = open.messageIds.slice(0, i);
  const tail = open.messageIds.slice(i);
  const nowIso = new Date().toISOString();
  let completedTurns: number | undefined;
  const linear = opts?.linearForTurnCount;
  if (linear?.length && head.length > 0) {
    const roleById = new Map(linear.map((m) => [m.id, m.role]));
    const contentById = new Map(linear.map((m) => [m.id, m.content]));
    completedTurns = completedTurnsInChunk(head, roleById, contentById);
  }
  const toClose = closeChunk(
    { ...open, messageIds: head, maxImportance: open.maxImportance },
    nowIso,
    completedTurns,
  );
  const nid = newChunkId();
  const tailImp: HubImportance = opts?.newOpenMaxImportance ?? 1;
  const newOpen: HubChunkRecord = {
    id: nid,
    messageIds: tail,
    closedAt: null,
    maxImportance: tailImp,
    title: "",
    shortSummary: "",
    folderId: null,
    titleGenDone: false,
    collapsed: "none",
  };
  return {
    ...state,
    chunks: [...state.chunks.filter((c) => c.id !== open.id), toClose, newOpen],
    openChunkId: nid,
    provisionalStm: null,
  };
}

/**
 * After assistant message is finalized with hub_meta.
 * On topic_shift=true: close open chunk without (userMsgId, aiMsgId); new open chunk [userMsgId, aiMsgId].
 * (importance may be 1 e.g. music/timer per system prompt — still split when the model marks a topic change.)
 */
export type HubLinearForTurnCount = { id: number; role: "user" | "ai"; content: string };

/** 同一 AI 完了に対する applyHubMetaAfterAi の二重実行を無害化（Strict Mode / 二重 flush 対策）。 */
function hubMetaTurnAlreadyApplied(
  state: HubPersistedState,
  userMsgId: number,
  aiMsgId: number,
): boolean {
  const settled = state.chunks.find(
    (c) => c.messageIds.includes(aiMsgId) && c.messageIds.includes(userMsgId),
  );
  if (!settled) return false;
  if (settled.closedAt !== null) return true;
  if (state.openChunkId === settled.id) return true;
  return false;
}

export function applyHubMetaAfterAi(
  state: HubPersistedState,
  userMsgId: number,
  aiMsgId: number,
  hubMeta: { importance: HubImportance; topicShift: boolean },
  nowIso: string,
  /** topic_shift で閉じる chunk の往復数算出用（省略時は importance のみで single_line / chunk_card を推定） */
  linearForTurnCount?: HubLinearForTurnCount[],
): HubPersistedState {
  if (hubMetaTurnAlreadyApplied(state, userMsgId, aiMsgId)) {
    return state;
  }
  let next: HubPersistedState = { ...state, chunks: [...state.chunks], stmEntries: [...state.stmEntries] };
  const openId = next.openChunkId;
  if (!openId) {
    return next;
  }
  const open = chunkById(next, openId);
  if (!open || open.closedAt !== null) {
    return next;
  }

  const imp = hubMeta.importance;
  const shift = hubMeta.topicShift;

  if (!shift) {
    next.chunks = next.chunks.map((c) =>
      c.id === open.id
        ? {
            ...c,
            messageIds: c.messageIds.includes(aiMsgId) ? c.messageIds : [...c.messageIds, aiMsgId],
            maxImportance: maxImp(c.maxImportance, imp),
          }
        : c,
    );
    return next;
  }

  const uIdx = open.messageIds.indexOf(userMsgId);
  if (uIdx < 0) {
    next.chunks = next.chunks.map((c) =>
      c.id === open.id
        ? {
            ...c,
            messageIds: c.messageIds.includes(aiMsgId) ? c.messageIds : [...c.messageIds, aiMsgId],
            maxImportance: maxImp(c.maxImportance, imp),
          }
        : c,
    );
    return next;
  }

  /** Strictly before this user message (handles queued later user ids while assistant was streaming). */
  const head = open.messageIds.slice(0, uIdx);
  /** After current user in open order (e.g. next user send already appended); exclude ai id if ever present. */
  const tailAfterUser = open.messageIds.slice(uIdx + 1).filter((id) => id !== aiMsgId);
  const newOpenMessageIds = [userMsgId, aiMsgId, ...tailAfterUser];

  let completedTurns: number | undefined;
  if (linearForTurnCount?.length && head.length > 0) {
    const roleById = new Map(linearForTurnCount.map((m) => [m.id, m.role]));
    const contentById = new Map(linearForTurnCount.map((m) => [m.id, m.content]));
    completedTurns = completedTurnsInChunk(head, roleById, contentById);
  }
  /** Head は「このターンより前」の会話のみ。新トピックの imp を混ぜると TTL が膨らむ（例: タイマー imp1 の head が次ターン wake imp5 で閉じられる）。 */
  const closedMax = open.maxImportance;
  const toClose: HubChunkRecord | null =
    head.length > 0
      ? closeChunk(
          {
            ...open,
            messageIds: head,
            maxImportance: closedMax,
          },
          nowIso,
          completedTurns,
        )
      : null;

  const nid = newChunkId();
  const newOpen: HubChunkRecord = {
    id: nid,
    messageIds: newOpenMessageIds,
    closedAt: null,
    maxImportance: imp,
    title: "",
    shortSummary: "",
    folderId: null,
    titleGenDone: false,
    collapsed: "none",
  };

  next.chunks = next.chunks.filter((c) => c.id !== open.id);
  if (toClose) next.chunks.push(toClose);
  next.chunks.push(newOpen);
  next.openChunkId = nid;
  return { ...next, provisionalStm: null };
}

export type PruneHubStateOpts = {
  /** Closed chunks past TTL are kept (not pruned) while listed here — e.g. Hub chunk expiry banner. */
  deferEvictionChunkIds?: ReadonlySet<string>;
};

export function pruneHubState(
  state: HubPersistedState,
  opts?: PruneHubStateOpts,
): {
  state: HubPersistedState;
  removedMessageIds: number[];
} {
  const now = Date.now();
  const stmEntries = pruneExpiredStmEntries(state.stmEntries, now);
  const removedMessageIds: number[] = [];
  const defer = opts?.deferEvictionChunkIds;
  const chunks = state.chunks.filter((c) => {
    if (c.closedAt === null) return true;
    if (c.expiresAtMs === undefined) return true;
    if (c.expiresAtMs > now) return true;
    if (defer?.has(c.id)) return true;
    removedMessageIds.push(...c.messageIds);
    return false;
  });
  return {
    state: { ...state, stmEntries, chunks },
    removedMessageIds,
  };
}

/**
 * Remove one chunk and its messages from Hub state (same message-id removal contract as TTL prune).
 * Clears recall / provisional STM when they reference this chunk; drops stmEntries rows for this chunk.
 */
export function evictHubChunkById(state: HubPersistedState, chunkId: string): {
  state: HubPersistedState;
  removedMessageIds: number[];
} {
  const chunk = state.chunks.find((c) => c.id === chunkId);
  if (!chunk) {
    return { state, removedMessageIds: [] };
  }
  const now = Date.now();
  const removedMessageIds = [...chunk.messageIds];
  const chunks = state.chunks.filter((c) => c.id !== chunkId);
  let recall = state.recall ?? null;
  if (recall?.chunkId === chunkId) recall = null;
  let provisionalStm = state.provisionalStm ?? null;
  if (provisionalStm?.chunkId === chunkId) provisionalStm = null;
  const stmEntries = pruneExpiredStmEntries(
    state.stmEntries.filter((e) => e.chunkId !== chunkId),
    now,
  );
  let openChunkId = state.openChunkId;
  if (openChunkId === chunkId) {
    openChunkId = chunks.find((c) => c.closedAt === null)?.id ?? null;
  }
  return {
    state: { ...state, chunks, stmEntries, recall, provisionalStm, openChunkId },
    removedMessageIds,
  };
}

/** One list line: `title` or `title: summary` when summary is non-empty. */
function formatHubMemoryListLine(title: string, summary: string): string {
  const t = title.trim();
  if (!t) return "";
  const s = summary.trim();
  if (!s || s === t) return t;
  return `${t}: ${s}`;
}

/**
 * Lines for `[Hub memory titles]` in the Hub system prompt.
 * STM rows and closed chunks with titles; each line includes short summary when available.
 */
export function hubStmTitlesForPrompt(state: HubPersistedState): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  const add = (title: string, summary: string) => {
    const line = formatHubMemoryListLine(title, summary);
    if (!line || seen.has(line)) return;
    seen.add(line);
    lines.push(line);
  };
  for (const e of state.stmEntries) {
    if (e.title.trim()) add(e.title, e.summary);
  }
  for (const c of state.chunks) {
    if (c.title.trim() && c.closedAt !== null) add(c.title, c.shortSummary ?? "");
  }
  return lines;
}

export function findChunkIdByTitle(state: HubPersistedState, title: string): string | undefined {
  const t = title.trim().toLowerCase();
  if (!t) return undefined;
  const exact = state.chunks.find((c) => c.title.trim().toLowerCase() === t);
  if (exact) return exact.id;
  const partial = state.chunks.find((c) => {
    const ct = c.title.trim().toLowerCase();
    return ct && (t.includes(ct) || ct.includes(t));
  });
  if (partial) return partial.id;
  const stm = state.stmEntries.find((e) => e.title.trim().toLowerCase() === t);
  if (stm) return stm.chunkId;
  const stmP = state.stmEntries.find((e) => {
    const et = e.title.trim().toLowerCase();
    return et && (t.includes(et) || et.includes(t));
  });
  return stmP?.chunkId;
}

export function reorderMessagesForRecall(
  chunkId: string,
  chunkMessageIds: number[],
  allLinearIds: number[],
): { reordered: number[]; recall: HubRecallState } {
  const inChunk = new Set(chunkMessageIds);
  const rest = allLinearIds.filter((id) => !inChunk.has(id));
  const chunkOrder = chunkMessageIds.filter((id) => allLinearIds.includes(id));
  return {
    reordered: [...rest, ...chunkOrder],
    recall: { chunkId, originalOrder: [...allLinearIds] },
  };
}

export function restoreOrderFromRecall(
  currentIds: number[],
  recall: HubRecallState,
): number[] {
  if (!recall.originalOrder.length) return currentIds;
  if (currentIds.length !== recall.originalOrder.length) return currentIds;
  const set = new Set(currentIds);
  for (const id of recall.originalOrder) {
    if (!set.has(id)) return currentIds;
  }
  return [...recall.originalOrder];
}

export function patchChunkMetadata(
  state: HubPersistedState,
  chunkId: string,
  patch: Partial<Pick<HubChunkRecord, "title" | "shortSummary" | "folderId" | "titleGenDone">>,
): HubPersistedState {
  return {
    ...state,
    chunks: state.chunks.map((c) => (c.id === chunkId ? { ...c, ...patch } : c)),
  };
}
