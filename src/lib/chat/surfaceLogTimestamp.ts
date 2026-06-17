import { formatLocalDatetime } from "../datetime/llmDatetime";

/** LLM 履歴: User ターン時刻（HTML コメント内。応答フォーマットではない） */
export const USER_TURN_AT_MARKER = "user@";
/** LLM 履歴: Assistant ターン時刻 */
export const ASSISTANT_TURN_AT_MARKER = "assistant@";
/** @deprecated {@link ASSISTANT_TURN_AT_MARKER} */
export const SURFACE_LOG_AT_MARKER = ASSISTANT_TURN_AT_MARKER;
/** @deprecated {@link USER_TURN_AT_MARKER} */
export const USER_LOG_AT_MARKER = USER_TURN_AT_MARKER;

/** 現行 + 旧マーカー（模倣除去・後方互換）。旧形式は先頭に `pc:` が付く場合あり。 */
const HISTORY_TURN_MARKERS =
  "(?:user@|assistant@|u@|a@|surface_log_at|user_log_at)";
const HISTORY_TS_MARKER_PREFIX = "(?:pc:)?";

/** Hub / Inbox の LLM 履歴用ローカル時刻（`formatLocalDatetime` と同形、iana_timezone 準拠） */
export function formatSurfaceLogTimestamp(iso: string): string {
  try {
    return formatLocalDatetime(new Date(iso));
  } catch {
    return iso;
  }
}

/** 旧: `[2026-05-18T15:32Z]` / `[2026-05-18 17:41]` 等 */
const LEGACY_BRACKET_SURFACE_LOG_RE = /^\s*\[\d{4}[/\-.][^\]]*\]\s*/;

const HISTORY_TS_LEADING_LINE_RE = new RegExp(
  `^\\s*<!--\\s*${HISTORY_TS_MARKER_PREFIX}${HISTORY_TURN_MARKERS}\\s+[\\s\\S]*?-->\\s*\\n?`,
  "i",
);

const HISTORY_TS_TRAILING_LINE_RE = new RegExp(
  `\\n?\\s*<!--\\s*${HISTORY_TS_MARKER_PREFIX}${HISTORY_TURN_MARKERS}\\s+[\\s\\S]*?-->\\s*$`,
  "i",
);

const HISTORY_TS_WHOLE_LINE_RE = new RegExp(
  `^\\s*<!--\\s*${HISTORY_TS_MARKER_PREFIX}${HISTORY_TURN_MARKERS}\\s+[\\s\\S]*?-->\\s*$`,
  "gim",
);

const HISTORY_TS_INCOMPLETE_OPEN_RE = new RegExp(
  `<!--\\s*${HISTORY_TS_MARKER_PREFIX}${HISTORY_TURN_MARKERS}\\b`,
  "i",
);

/** 先頭に履歴用タイムスタンプメタデータがあるか */
export function hasLeadingSurfaceLogMetadata(text: string): boolean {
  const t = text.trimStart();
  return HISTORY_TS_LEADING_LINE_RE.test(t) || LEGACY_BRACKET_SURFACE_LOG_RE.test(t);
}

/** 末尾に履歴用タイムスタンプメタデータがあるか */
export function hasTrailingSurfaceLogMetadata(text: string): boolean {
  return HISTORY_TS_TRAILING_LINE_RE.test(text.trimEnd());
}

export function formatSurfaceLogAtComment(iso: string): string {
  return `<!-- ${ASSISTANT_TURN_AT_MARKER} ${formatSurfaceLogTimestamp(iso)} -->`;
}

export function formatUserLogAtComment(iso: string): string {
  return `<!-- ${USER_TURN_AT_MARKER} ${formatSurfaceLogTimestamp(iso)} -->`;
}

/**
 * 1文チャンクが履歴用 HTML コメント行のみか（ストリーム TTS スキップ用）。
 */
export function isSurfaceLogHistoryMetadataSentence(sentence: string): boolean {
  const t = sentence.trim();
  if (!t) return false;
  if (HISTORY_TS_INCOMPLETE_OPEN_RE.test(t) && /-->\s*$/.test(t)) return true;
  return HISTORY_TS_WHOLE_LINE_RE.test(t);
}

/**
 * 応答・表示・保存用: 履歴タイムスタンプ HTML コメントを除去（先頭・末尾・単独行）。
 * LLM が履歴を模倣して付けた場合も対象。
 */
export function stripHistoryTimestampComments(text: string): string {
  let t = text;
  for (let i = 0; i < 6; i++) {
    const before = t.trimStart();
    let next = before.replace(HISTORY_TS_LEADING_LINE_RE, "");
    next = next.replace(LEGACY_BRACKET_SURFACE_LOG_RE, "");
    if (next === before) break;
    const lead = t.length - t.trimStart().length;
    t = t.slice(0, lead) + next;
  }
  t = t.replace(HISTORY_TS_WHOLE_LINE_RE, "");
  for (let i = 0; i < 6; i++) {
    const trimmed = t.trimEnd();
    const next = trimmed.replace(HISTORY_TS_TRAILING_LINE_RE, "");
    if (next === trimmed) break;
    t = next;
  }
  return t.replace(/\n{3,}/g, "\n\n");
}

/** @deprecated {@link stripHistoryTimestampComments} の先頭のみ版。互換用。 */
export function stripLeadingSurfaceLogMetadata(text: string): string {
  let t = text;
  for (let i = 0; i < 6; i++) {
    const before = t.trimStart();
    let next = before.replace(HISTORY_TS_LEADING_LINE_RE, "");
    next = next.replace(LEGACY_BRACKET_SURFACE_LOG_RE, "");
    if (next === before) break;
    const lead = t.length - t.trimStart().length;
    t = t.slice(0, lead) + next;
  }
  return t;
}

/** 末尾の履歴メタデータを除去 */
export function stripTrailingSurfaceLogMetadata(text: string): string {
  let t = text;
  for (let i = 0; i < 6; i++) {
    const trimmed = t.trimEnd();
    const next = trimmed.replace(HISTORY_TS_TRAILING_LINE_RE, "");
    if (next === trimmed) break;
    t = next;
  }
  return t.trimEnd();
}

/** 先頭・末尾・単独行の履歴メタデータを除去 */
export function stripAllSurfaceLogMetadata(text: string): string {
  return stripHistoryTimestampComments(text);
}

/** LLM 模倣出力の除去（保存・最終パース前）。先頭・末尾・単独行すべて対象。 */
export function sanitizeMimickedSurfaceLogFromAssistantOutput(text: string): string {
  return stripHistoryTimestampComments(text.trim());
}

/**
 * ストリーミング表示・TTS 用: 完結コメント除去 + 先頭/末尾の未閉じ `<!-- user@|assistant@ …` も除去。
 */
export function stripHistoryTimestampCommentsForStream(text: string): string {
  let t = stripHistoryTimestampComments(text);
  const lead = t.length - t.trimStart().length;
  const trimmedStart = t.trimStart();
  if (trimmedStart.startsWith("<!--") && !trimmedStart.includes("-->")) {
    t = t.slice(0, lead);
  }
  const trimmedEnd = t.trimEnd();
  const lastOpen = trimmedEnd.lastIndexOf("<!--");
  if (
    lastOpen >= 0 &&
    HISTORY_TS_INCOMPLETE_OPEN_RE.test(trimmedEnd.slice(lastOpen)) &&
    !trimmedEnd.slice(lastOpen).includes("-->")
  ) {
    const cutFrom = t.length - (trimmedEnd.length - lastOpen);
    t = t.slice(0, cutFrom);
  }
  return t;
}

/** @deprecated {@link stripHistoryTimestampCommentsForStream} */
export function stripLeadingSurfaceLogMetadataForStream(text: string): string {
  return stripHistoryTimestampCommentsForStream(text);
}

/** @deprecated 履歴は末尾付与に移行。後方互換のため残す。 */
export function prefixAssistantSurfaceLogContent(
  role: "user" | "ai",
  iso: string | undefined,
  content: string,
): string {
  if (role !== "ai" || !iso?.trim() || !content.trim()) return content;
  if (hasLeadingSurfaceLogMetadata(content) || hasTrailingSurfaceLogMetadata(content)) return content;
  return `${formatSurfaceLogAtComment(iso)}\n${content}`;
}

/** LLM 履歴: user 本文の直前に機械可読コメントを1行付与 */
export function prefixUserSurfaceLogContent(iso: string | undefined, content: string): string {
  if (!iso?.trim() || !content.trim()) return content;
  const trimmed = content.trimStart();
  if (HISTORY_TS_LEADING_LINE_RE.test(trimmed)) return content;
  return `${formatUserLogAtComment(iso)}\n${content}`;
}

/**
 * LLM 履歴: assistant 本文の末尾に機械可読コメントを1行付与。
 * 保存済み本文に模倣メタがあれば除去してから付与。
 */
export function appendAssistantSurfaceLogContent(
  role: "user" | "ai",
  iso: string | undefined,
  content: string,
): string {
  if (role !== "ai" || !iso?.trim() || !content.trim()) return content;
  let body = stripHistoryTimestampComments(content).trimEnd();
  if (hasTrailingSurfaceLogMetadata(body)) return body;
  return `${body}\n\n${formatSurfaceLogAtComment(iso)}`;
}

/** UI 用: ISO を短い時刻ラベルに（今日は HH:mm、昨日は 昨日 HH:mm、それ以外は M/D HH:mm） */
export function formatSurfaceLogMessageAt(iso: string, now: Date): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const msgDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const hm = d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (msgDay.getTime() === today.getTime()) return hm;
  if (msgDay.getTime() === yesterday.getTime()) return `昨日 ${hm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}
