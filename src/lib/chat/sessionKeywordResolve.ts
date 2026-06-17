import { SCRATCH_BRANCH_ID } from "./scratchSurface";

export interface KeywordSearchMessage {
  id: number;
  content: string;
}

export interface KeywordSearchBranch {
  id: string;
  label: string;
  messages: KeywordSearchMessage[];
}

export interface KeywordSearchSession {
  id: string;
  branches: KeywordSearchBranch[];
}

export interface InboxSearchPart {
  branchId: string | null;
  branchLabel: string;
  messages: KeywordSearchMessage[];
}

export type SessionKeywordResolveResult =
  | {
      kind: "open_session";
      sessionId: string;
      branchId: string;
      branchLabel: string;
      messageId: number;
    }
  | { kind: "open_hub"; messageId: number }
  | { kind: "open_inbox"; inboxBranchId: string | null; messageId: number }
  | { kind: "show_search" }
  | { kind: "noop" };

type UnitKey =
  | { type: "session"; sessionId: string }
  | { type: "scratch" }
  | { type: "inbox" };

function norm(q: string): string {
  return q.trim().toLowerCase();
}

/**
 * Count keyword hits per surface (session / scratch / inbox) and pick a single open target,
 * or `show_search` when the top hit count is tied across multiple units.
 * Optional `excludeMessageIds`: messages that must not contribute hits (e.g. the assistant
 * reply that emitted `<ui_action>show_log_links` and the preceding user message).
 */
export function resolveSessionKeyword(options: {
  query: string;
  sessions: KeywordSearchSession[];
  scratchMessages: KeywordSearchMessage[];
  inboxParts: InboxSearchPart[];
  excludeMessageIds?: number[];
}): SessionKeywordResolveResult {
  const q = norm(options.query);
  if (!q) return { kind: "noop" };

  const exclude =
    options.excludeMessageIds && options.excludeMessageIds.length > 0
      ? new Set(options.excludeMessageIds)
      : null;

  type HitInfo = { count: number; first: { branchId: string; branchLabel: string; messageId: number } };

  const sessionHits = new Map<string, HitInfo>();

  const bumpSession = (
    sessionId: string,
    branchId: string,
    branchLabel: string,
    msgId: number,
  ) => {
    let h = sessionHits.get(sessionId);
    if (!h) {
      h = { count: 0, first: { branchId, branchLabel, messageId: msgId } };
      sessionHits.set(sessionId, h);
    }
    h.count += 1;
  };

  for (const s of options.sessions) {
    for (const br of s.branches) {
      for (const m of br.messages) {
        if (exclude?.has(m.id)) continue;
        if (m.content.toLowerCase().includes(q)) {
          bumpSession(s.id, br.id, br.label, m.id);
        }
      }
    }
  }

  let scratchHit: HitInfo | null = null;
  for (const m of options.scratchMessages) {
    if (exclude?.has(m.id)) continue;
    if (m.content.toLowerCase().includes(q)) {
      if (!scratchHit) {
        scratchHit = { count: 0, first: { branchId: SCRATCH_BRANCH_ID, branchLabel: "Scratch", messageId: m.id } };
      }
      scratchHit.count += 1;
    }
  }

  let inboxHit: HitInfo | null = null;
  for (const part of options.inboxParts) {
    for (const m of part.messages) {
      if (exclude?.has(m.id)) continue;
      if (m.content.toLowerCase().includes(q)) {
        if (!inboxHit) {
          inboxHit = {
            count: 0,
            first: {
              branchId: part.branchId == null ? INBOX_ROOT_BRANCH_TOKEN : part.branchId,
              branchLabel: part.branchLabel,
              messageId: m.id,
            },
          };
        }
        inboxHit.count += 1;
      }
    }
  }

  type Scored = { key: UnitKey; count: number; first: HitInfo["first"] };

  const scored: Scored[] = [];
  for (const [sessionId, h] of sessionHits) {
    scored.push({ key: { type: "session", sessionId }, count: h.count, first: h.first });
  }
  if (scratchHit && scratchHit.count > 0) {
    scored.push({
      key: { type: "scratch" },
      count: scratchHit.count,
      first: scratchHit.first,
    });
  }
  if (inboxHit && inboxHit.count > 0) {
    scored.push({
      key: { type: "inbox" },
      count: inboxHit.count,
      first: inboxHit.first,
    });
  }

  if (scored.length === 0) return { kind: "noop" };
  if (scored.length === 1) {
    const only = scored[0]!;
    return unitToResult(only.key, only.first);
  }

  const max = Math.max(...scored.map((s) => s.count));
  const top = scored.filter((s) => s.count === max);
  if (top.length > 1) return { kind: "show_search" };
  const win = top[0]!;
  return unitToResult(win.key, win.first);
}

function unitToResult(
  key: UnitKey,
  first: { branchId: string; branchLabel: string; messageId: number },
): SessionKeywordResolveResult {
  if (key.type === "session") {
    return {
      kind: "open_session",
      sessionId: key.sessionId,
      branchId: first.branchId,
      branchLabel: first.branchLabel,
      messageId: first.messageId,
    };
  }
  if (key.type === "scratch") {
    return { kind: "open_hub", messageId: first.messageId };
  }
  const inboxBranchId = first.branchId === "__inbox_root__" ? null : first.branchId;
  return { kind: "open_inbox", inboxBranchId, messageId: first.messageId };
}

/** Stable id for inbox root in search results (not a real branch id). */
export const INBOX_ROOT_BRANCH_TOKEN = "__inbox_root__";

export type KeywordHitRow =
  | {
      surface: "session";
      sessionId: string;
      branchId: string;
      messageId: number;
      hitCount: number;
    }
  | {
      surface: "scratch";
      branchId: string;
      messageId: number;
      hitCount: number;
    }
  | {
      surface: "inbox";
      inboxBranchId: string | null;
      branchLabel: string;
      messageId: number;
      hitCount: number;
    };

/**
 * Lists every surface that has keyword hits (one row per chat session, one for Hub/Scratch,
 * one per Inbox branch group), sorted by hit count descending.
 * Unlike `resolveSessionKeyword`, does not collapse to a single winner or search view.
 */
export function collectKeywordHitRows(options: {
  query: string;
  sessions: KeywordSearchSession[];
  scratchMessages: KeywordSearchMessage[];
  inboxParts: InboxSearchPart[];
  excludeMessageIds?: number[];
}): KeywordHitRow[] {
  const q = norm(options.query);
  if (!q) return [];

  const exclude =
    options.excludeMessageIds && options.excludeMessageIds.length > 0
      ? new Set(options.excludeMessageIds)
      : null;

  type HitInfo = { count: number; first: { branchId: string; branchLabel: string; messageId: number } };

  const sessionHits = new Map<string, HitInfo>();

  const bumpSession = (
    sessionId: string,
    branchId: string,
    branchLabel: string,
    msgId: number,
  ) => {
    let h = sessionHits.get(sessionId);
    if (!h) {
      h = { count: 0, first: { branchId, branchLabel, messageId: msgId } };
      sessionHits.set(sessionId, h);
    }
    h.count += 1;
  };

  for (const s of options.sessions) {
    for (const br of s.branches) {
      for (const m of br.messages) {
        if (exclude?.has(m.id)) continue;
        if (m.content.toLowerCase().includes(q)) {
          bumpSession(s.id, br.id, br.label, m.id);
        }
      }
    }
  }

  let scratchHit: HitInfo | null = null;
  for (const m of options.scratchMessages) {
    if (exclude?.has(m.id)) continue;
    if (m.content.toLowerCase().includes(q)) {
      if (!scratchHit) {
        scratchHit = { count: 0, first: { branchId: SCRATCH_BRANCH_ID, branchLabel: "Scratch", messageId: m.id } };
      }
      scratchHit.count += 1;
    }
  }

  const inboxRows: KeywordHitRow[] = [];
  for (const part of options.inboxParts) {
    let count = 0;
    let firstMsgId = 0;
    for (const m of part.messages) {
      if (exclude?.has(m.id)) continue;
      if (m.content.toLowerCase().includes(q)) {
        if (count === 0) firstMsgId = m.id;
        count += 1;
      }
    }
    if (count > 0) {
      inboxRows.push({
        surface: "inbox",
        inboxBranchId: part.branchId,
        branchLabel: part.branchLabel,
        messageId: firstMsgId,
        hitCount: count,
      });
    }
  }

  const rows: KeywordHitRow[] = [];
  for (const [sessionId, h] of sessionHits) {
    rows.push({
      surface: "session",
      sessionId,
      branchId: h.first.branchId,
      messageId: h.first.messageId,
      hitCount: h.count,
    });
  }
  if (scratchHit && scratchHit.count > 0) {
    rows.push({
      surface: "scratch",
      branchId: scratchHit.first.branchId,
      messageId: scratchHit.first.messageId,
      hitCount: scratchHit.count,
    });
  }
  rows.push(...inboxRows);

  rows.sort((a, b) => b.hitCount - a.hitCount);
  return rows;
}
