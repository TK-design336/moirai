/** Parse and patch `<draft>` / `<email-draft>` blocks in assistant message content. */

export type DraftBlockKind = "draft" | "email-draft";

export type MessageBodySegment =
  | { kind: "markdown"; text: string }
  | { kind: "draft"; id: string; inner: string }
  | { kind: "email-draft"; id: string; subject: string; inner: string };

const DRAFT_OPEN_RE = /<draft\s+([^>]*)>/i;
const EMAIL_DRAFT_OPEN_RE = /<email-draft\s+([^>]*)>/i;

function parseIdFromAttrs(attrs: string, fallback: string): string {
  const m = /\bid\s*=\s*["']([^"']+)["']/i.exec(attrs);
  return m?.[1]?.trim() || fallback;
}

function parseSubjectFromAttrs(attrs: string): string {
  const m = /\bsubject\s*=\s*["']([^"']*)["']/i.exec(attrs);
  return m?.[1] ?? "";
}

function findClosingTag(text: string, fromIndex: number, tagName: "draft" | "email-draft"): number {
  const close = `</${tagName}>`;
  const idx = text.indexOf(close, fromIndex);
  return idx === -1 ? -1 : idx;
}

/**
 * Split display body (panel XML already stripped) into markdown and draft segments.
 */
export function splitMessageByDraftBlocks(text: string): MessageBodySegment[] {
  const segments: MessageBodySegment[] = [];
  let i = 0;
  let draftCounter = 0;
  let emailCounter = 0;

  while (i < text.length) {
    const rest = text.slice(i);
    const draftOpen = DRAFT_OPEN_RE.exec(rest);
    const emailOpen = EMAIL_DRAFT_OPEN_RE.exec(rest);

    let useEmail = false;
    let openMatch: RegExpExecArray | null = null;
    if (draftOpen && emailOpen) {
      if (emailOpen.index < draftOpen.index) {
        useEmail = true;
        openMatch = emailOpen;
      } else {
        openMatch = draftOpen;
      }
    } else if (emailOpen) {
      useEmail = true;
      openMatch = emailOpen;
    } else if (draftOpen) {
      openMatch = draftOpen;
    }

    if (!openMatch || openMatch.index === undefined) {
      const tail = text.slice(i);
      if (tail) segments.push({ kind: "markdown", text: tail });
      break;
    }

    const openAt = i + openMatch.index;
    if (openAt > i) {
      segments.push({ kind: "markdown", text: text.slice(i, openAt) });
    }

    const attrs = openMatch[1] ?? "";
    const innerStart = openAt + openMatch[0].length;
    const tagName = useEmail ? "email-draft" : "draft";
    const closeIdx = findClosingTag(text, innerStart, tagName);

    if (closeIdx === -1) {
      segments.push({ kind: "markdown", text: text.slice(openAt) });
      break;
    }

    const inner = text.slice(innerStart, closeIdx);
    const afterClose = closeIdx + `</${tagName}>`.length;

    if (useEmail) {
      emailCounter += 1;
      segments.push({
        kind: "email-draft",
        id: parseIdFromAttrs(attrs, `e${emailCounter}`),
        subject: parseSubjectFromAttrs(attrs),
        inner,
      });
    } else {
      draftCounter += 1;
      segments.push({
        kind: "draft",
        id: parseIdFromAttrs(attrs, `d${draftCounter}`),
        inner,
      });
    }

    i = afterClose;
  }

  return segments;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function buildDraftTag(kind: DraftBlockKind, id: string, inner: string, subject?: string): string {
  if (kind === "email-draft") {
    const subj = escapeAttr(subject ?? "");
    return `<email-draft id="${escapeAttr(id)}" subject="${subj}">\n${inner}\n</email-draft>`;
  }
  return `<draft id="${escapeAttr(id)}">\n${inner}\n</draft>`;
}

/** Replace one draft block inside raw assistant content (preserves emotion line and panels). */
export function patchDraftInRawContent(
  raw: string,
  draftId: string,
  kind: DraftBlockKind,
  newInner: string,
  newSubject?: string,
): string {
  const openRe = kind === "email-draft" ? EMAIL_DRAFT_OPEN_RE : DRAFT_OPEN_RE;
  const tagName = kind;
  let result = raw;
  let searchFrom = 0;

  while (searchFrom < result.length) {
    const slice = result.slice(searchFrom);
    const m = openRe.exec(slice);
    if (!m || m.index === undefined) break;

    const openAt = searchFrom + m.index;
    const attrs = m[1] ?? "";
    const id = parseIdFromAttrs(attrs, "");
    const innerStart = openAt + m[0].length;
    const closeIdx = findClosingTag(result, innerStart, tagName);
    if (closeIdx === -1) break;

    if (id === draftId) {
      const replacement = buildDraftTag(
        kind,
        draftId,
        newInner,
        kind === "email-draft" ? newSubject : undefined,
      );
      result = result.slice(0, openAt) + replacement + result.slice(closeIdx + `</${tagName}>`.length);
      return result;
    }

    searchFrom = closeIdx + `</${tagName}>`.length;
  }

  return raw;
}

/** Plain text for TTS replay (strip lightweight markdown). */
export function draftPlainTextForTts(inner: string): string {
  return inner
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#+\s+/gm, "")
    .trim();
}

export function buildGmailComposeUrl(params: { subject: string; body: string }): string {
  const q = new URLSearchParams({
    view: "cm",
    fs: "1",
    su: params.subject,
    body: params.body,
  });
  return `https://mail.google.com/mail/?${q.toString()}`;
}

/** Parse LLM draft-rewrite response (single tag only). */
export function parseDraftRewriteResponse(
  raw: string,
  expectedKind: DraftBlockKind,
  expectedId: string,
): { inner: string; subject?: string } | null {
  const trimmed = raw.trim();
  const segments = splitMessageByDraftBlocks(trimmed);
  const match = segments.find(
    (s) =>
      (s.kind === "draft" && expectedKind === "draft") ||
      (s.kind === "email-draft" && expectedKind === "email-draft"),
  );
  if (!match || match.kind === "markdown") return null;
  if (match.id !== expectedId) return null;
  if (match.kind === "email-draft") {
    return { inner: match.inner, subject: match.subject };
  }
  return { inner: match.inner };
}
