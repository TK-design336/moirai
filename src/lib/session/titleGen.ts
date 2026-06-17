import type { ChatMessage } from "../../types/engine";
import { getMaxSendHistory } from "../memory/stm";
import { callLLMOnce, getModelConfig } from "../llm/client";
import { sliceChatHistoryForSendWindow } from "../llm/sendHistoryWindow";
import type { ChatFolder } from "./chatFolders";

const DEFAULT_TITLE_PROMPT = `You classify the chat session and write a short title.
Requirements:
- Title: same language as the conversation, maximum ~20 characters, capture the main topic.
- Output ONLY a single JSON object, no markdown fences, no other text.
- Keys: "title" (string), "folderId" (string or null).
- folderId must be exactly one of the folder ids listed under "Available folders" below, or null if none fit or uncertain (unassigned).`;

function cleanTitle(s: string): string {
  return s.trim().replace(/^["「『]|["」』]$/g, "").slice(0, 30);
}

/** Strip leading/trailing markdown code fences (handles truncated responses without closing ```). */
function stripCodeFences(raw: string): string {
  let t = raw.trim();
  if (!/^```/.test(t)) return t;
  t = t.replace(/^```(?:json)?\s*\r?\n?/i, "");
  const fence = t.lastIndexOf("```");
  if (fence >= 0) t = t.slice(0, fence);
  return t.trim();
}

function normalizeFolderId(
  folderId: unknown,
  allowedIds: Set<string>,
): string | null {
  if (folderId === null || folderId === undefined) return null;
  if (typeof folderId !== "string") return null;
  const t = folderId.trim();
  if (t === "") return null;
  return allowedIds.has(t) ? t : null;
}

function tryParseTitleFolderJson(raw: string): { title: string; folderId: unknown } | null {
  let text = stripCodeFences(raw);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    text = text.slice(start, end + 1);
  }
  try {
    const obj = JSON.parse(text) as { title?: unknown; folderId?: unknown };
    const title = typeof obj.title === "string" ? obj.title.trim() : "";
    if (!title) return null;
    return { title, folderId: obj.folderId };
  } catch {
    return null;
  }
}

export interface SessionTitleAndFolder {
  title: string;
  folderId: string | null;
}

/** Hub chunk card + session transfer (folderId used only on separate-save). */
export interface HubChunkTitleSummaryFolder {
  title: string;
  folderId: string | null;
  /** Required when turnCount >= 2; else empty string. */
  summary: string;
}

/** Optional inputs for Hub chunk title LLM (provisional memory + tail send window). */
export interface HubChunkTitleGenOptions {
  /** Same-chunk provisional STM text captured before topic_shift clears it. */
  provisionalSummary?: string;
  /** Max completed turns in the tail window; defaults to `pc-max-send-history`（通常チャットと同じ）。 */
  latestTurnsMax?: number;
  /** Dev-only context for `[Hub chunk title LLM]` console logs. */
  debugChunkId?: string;
}

/** Session title: STM summary + tail window (same completed-turn rule as main chat send). */
export interface SessionTitleGenOptions {
  /** `loadSTM(sessionId).summary` when non-empty. */
  provisionalSummary?: string;
  /** Overrides `pc-max-send-history` (completed-turn cap for the tail slice). */
  latestTurnsMax?: number;
}

const C0_NO_TAB_NL_CR = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** One-line Hub chunk titles in lists/cards: strip BOM/controls, collapse whitespace, cap length. */
export function sanitizeHubChunkTitleForUi(s: string): string {
  if (typeof s !== "string") return "";
  return s
    .replace(/\uFEFF/g, "")
    .replace(C0_NO_TAB_NL_CR, "")
    .replace(/[\t\n\r]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

/** Hub chunk recap blurbs under the title: same hygiene, preserve as a single readable line. */
export function sanitizeHubChunkSummaryForUi(s: string): string {
  if (typeof s !== "string") return "";
  const t = s
    .replace(/\uFEFF/g, "")
    .replace(C0_NO_TAB_NL_CR, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\t/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" ")
    .trim();
  return t.slice(0, 4000);
}

/** Folder list for LLM system prompts (ids are canonical; names are hints only). */
function formatFolderBlockForLlm(folders: ChatFolder[]): string {
  if (folders.length === 0) {
    return "Available folders:\n(none — set folderId to null)";
  }
  return `Available folders (folderId must match an id on the left):\n${folders.map((f) => `- ${f.id}: ${f.name}`).join("\n")}`;
}

/** Hub-only default system text (no session-title prompt concatenation). */
function buildDefaultHubChunkSystem(requireSummary: boolean, folderBlock: string): string {
  const summaryBullet = requireSummary
    ? `- "summary" (string): same language as the conversation. Dense and direct—no preamble, no hedging, no polite register (ですます調). Cover topic, key exchanges, and conclusions in 1-4 sentences max. Must be non-empty.`
    : `- "summary" (string): MUST be exactly "" (empty string). This segment has fewer than 2 completed user→assistant exchanges; the user message states the turn count.`;
  return `You summarize a short Hub conversation segment for a chunk card: a short title, which folder it belongs in, and when applicable a recap of the segment.

Output ONLY a single JSON object, no markdown fences, no other text.
Keys:
- "title" (string): same language as the conversation, max ~20 characters, main topic.
- "folderId" (string or null): exactly one of the folder ids listed under "Available folders" below, or null if none fit or uncertain.
${summaryBullet}

${folderBlock}`;
}

function countCompletedTurns(messages: ChatMessage[]): number {
  let n = 0;
  for (let i = 0; i < messages.length - 1; i++) {
    if (messages[i]?.role === "user" && messages[i + 1]?.role === "assistant") {
      const u = (messages[i]?.content ?? "").trim();
      const a = (messages[i + 1]?.content ?? "").trim();
      if (u && a) n++;
      i++;
    }
  }
  return n;
}

function tryParseHubChunkJson(
  raw: string,
  allowedIds: Set<string>,
  requireSummary: boolean,
): HubChunkTitleSummaryFolder | null {
  let text = stripCodeFences(raw);
  const brace = text.indexOf("{");
  if (brace >= 0) text = text.slice(brace);
  const end = text.lastIndexOf("}");
  if (end > 0) text = text.slice(0, end + 1);
  try {
    const obj = JSON.parse(text) as { title?: unknown; folderId?: unknown; summary?: unknown };
    const title = typeof obj.title === "string" ? cleanTitle(obj.title) : "";
    if (!title) return null;
    const folderId = normalizeFolderId(obj.folderId, allowedIds);
    let summary = typeof obj.summary === "string" ? obj.summary.trim() : "";
    if (!requireSummary) summary = "";
    return { title, folderId, summary };
  } catch {
    return null;
  }
}

/**
 * When JSON.parse fails (markdown fences, preamble, or token-truncated JSON), recover title/summary/folderId heuristically.
 */
function recoverHubChunkFromLooseModelOutput(
  raw: string,
  allowedIds: Set<string>,
  requireSummary: boolean,
): HubChunkTitleSummaryFolder | null {
  const t = stripCodeFences(raw);
  const brace = t.indexOf("{");
  const slice = brace >= 0 ? t.slice(brace) : t;

  const titleClosed = slice.match(/"title"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const titleTrunc = !titleClosed ? slice.match(/"title"\s*:\s*"([^"]*)/) : null;
  const titleRaw = (titleClosed?.[1] ?? titleTrunc?.[1] ?? "")
    .replace(/\\n/g, " ")
    .replace(/\\"/g, '"')
    .trim();
  const title = cleanTitle(titleRaw);
  if (!title) return null;

  const summClosed = slice.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const summTrunc = !summClosed ? slice.match(/"summary"\s*:\s*"([^"]*)/) : null;
  let summary = (summClosed?.[1] ?? summTrunc?.[1] ?? "")
    .replace(/\\n/g, " ")
    .replace(/\\"/g, '"')
    .trim();
  if (!requireSummary) summary = "";

  let folderId: string | null = null;
  if (/\bfolderId\s*:\s*null\b/.test(slice)) folderId = null;
  else {
    const fm = slice.match(/"folderId"\s*:\s*"([^"]*)"/);
    if (fm) folderId = normalizeFolderId(fm[1], allowedIds);
  }

  return { title, folderId, summary };
}

/**
 * Title + optional summary + folder for a Hub chunk (same model role as session title).
 * Summary is only required when `firstMessages` has 2+ completed user→assistant turns.
 */
export async function generateHubChunkTitleSummaryAndFolder(
  firstMessages: ChatMessage[],
  provider: "gpt" | "gemini" | "claude",
  folders: ChatFolder[],
  options?: HubChunkTitleGenOptions,
): Promise<HubChunkTitleSummaryFolder> {
  if (firstMessages.length === 0) return { title: "", folderId: null, summary: "" };

  const turns = countCompletedTurns(firstMessages);
  const requireSummary = turns >= 2;

  const folderBlock = formatFolderBlockForLlm(folders);
  const system = buildDefaultHubChunkSystem(requireSummary, folderBlock);

  const cfg = getModelConfig(provider, "title");
  const allowedIds = new Set(folders.map((f) => f.id));

  const latestTurns = Math.max(1, options?.latestTurnsMax ?? getMaxSendHistory());
  const windowMsgs = sliceChatHistoryForSendWindow(firstMessages, latestTurns);
  const conversationText = windowMsgs
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content.slice(0, 400)}`)
    .join("\n\n");

  const prov = (options?.provisionalSummary ?? "").trim();
  const provBlock = prov
    ? `Provisional chunk memory (may be incomplete):\n${prov}\n\n`
    : "";

  const userContent = `${provBlock}Completed user→assistant turns in the full chunk: ${turns}. ${requireSummary ? "Include a non-empty summary." : "Set summary to empty string \"\"."}\nThe following is the latest active conversation window (tail, up to ${latestTurns} completed-turn send cap).\n\nConversation:\n\n${conversationText}`;

  const logTag = "[Hub chunk title LLM]";
  const logMeta = {
    chunkId: options?.debugChunkId,
    provider,
    model: cfg.model,
    turns,
    requireSummary,
    messageCount: firstMessages.length,
    provisionalIncluded: Boolean((options?.provisionalSummary ?? "").trim()),
  };
  console.log(`${logTag} meta`, logMeta);

  const raw = await callLLMOnce(
    provider,
    cfg.model,
    system,
    [{ role: "user", content: userContent }],
    Math.max(cfg.maxTokens, requireSummary ? 400 : 200),
    cfg.temperature,
    "hub-chunk-title",
  );

  const parsed = tryParseHubChunkJson(raw, allowedIds, requireSummary);
  if (parsed) return parsed;

  const recovered = recoverHubChunkFromLooseModelOutput(raw, allowedIds, requireSummary);
  if (recovered) return recovered;

  const legacy = tryParseTitleFolderJson(raw);
  if (legacy) {
    return {
      title: cleanTitle(legacy.title),
      folderId: normalizeFolderId(legacy.folderId, allowedIds),
      summary: "",
    };
  }
  return { title: "", folderId: null, summary: "" };
}

/**
 * Generates a short LLM-based title and optional folder id for a chat session.
 * Uses persisted STM summary when provided plus the tail of `branchMessages` (same
 * `sliceChatHistoryForSendWindow` / completed-turn cap as main chat: `pc-max-send-history`).
 */
export async function generateSessionTitleAndFolder(
  branchMessages: ChatMessage[],
  provider: "gpt" | "gemini" | "claude",
  folders: ChatFolder[],
  options?: SessionTitleGenOptions,
): Promise<SessionTitleAndFolder> {
  if (branchMessages.length === 0) return { title: "", folderId: null };

  const system = `${DEFAULT_TITLE_PROMPT}\n\n${formatFolderBlockForLlm(folders)}`;
  const cfg = getModelConfig(provider, "title");
  const allowedIds = new Set(folders.map((f) => f.id));

  const latestTurns = Math.max(1, options?.latestTurnsMax ?? getMaxSendHistory());
  const windowMsgs = sliceChatHistoryForSendWindow(branchMessages, latestTurns);
  const conversationText = windowMsgs
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content.slice(0, 400)}`)
    .join("\n\n");

  const prov = (options?.provisionalSummary ?? "").trim();
  const provBlock = prov
    ? `Session STM summary (compact memory, may be incomplete):\n${prov}\n\n`
    : "";

  const userContent = `${provBlock}The following is the latest conversation window (tail, up to ${latestTurns} completed-turn send cap; same rule as main chat).\n\nConversation:\n\n${conversationText}`;

  const raw = await callLLMOnce(
    provider,
    cfg.model,
    system,
    [{ role: "user", content: userContent }],
    Math.max(cfg.maxTokens, 120),
    cfg.temperature,
    "session-title",
  );

  const jsonParsed = tryParseTitleFolderJson(raw);
  if (jsonParsed) {
    return {
      title: cleanTitle(jsonParsed.title),
      folderId: normalizeFolderId(jsonParsed.folderId, allowedIds),
    };
  }

  const legacy = cleanTitle(raw);
  return { title: legacy, folderId: null };
}
