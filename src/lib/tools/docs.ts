import { invoke } from "@tauri-apps/api/core";
import { getValidGoogleToken } from "../googleAuth";

const DOCS_API = "https://docs.googleapis.com/v1/documents";
const DRIVE_API = "https://www.googleapis.com/drive/v3";

async function fetchProxy(
  url: string,
  method = "GET",
  headers: Record<string, string> = {},
  body?: string,
): Promise<string> {
  try {
    return await invoke<string>("fetch_proxy", { req: { url, method, headers, body: body ?? null } });
  } catch {
    const resp = await fetch(url, { method, headers, body });
    return resp.text();
  }
}

interface TextRun {
  content?: string;
  textStyle?: { bold?: boolean; fontSize?: { magnitude?: number } };
}

/** Recursively extract text from Docs API structural elements (paragraph, table, tableOfContents). Preserves bold as **...** and font size as HTML span. */
function readStructuralElements(elements: Array<Record<string, unknown>>): string {
  let text = "";
  for (const el of elements) {
    const p = el.paragraph as { elements?: Array<{ textRun?: TextRun }> } | undefined;
    if (p?.elements) {
      for (const e of p.elements) {
        const run = e.textRun as TextRun | undefined;
        if (!run?.content) continue;
        let chunk = run.content;
        const bold = run.textStyle?.bold === true;
        const fontSize = run.textStyle?.fontSize?.magnitude;
        if (bold) chunk = `**${chunk}**`;
        if (fontSize && fontSize !== 11) {
          chunk = `<span style="font-size:${fontSize}pt">${chunk}</span>`;
        }
        text += chunk;
      }
      continue;
    }
    const table = el.table as { tableRows?: Array<{ tableCells?: Array<{ content?: Array<Record<string, unknown>> }> }> } | undefined;
    if (table?.tableRows) {
      for (const row of table.tableRows) {
        for (const cell of row.tableCells ?? []) {
          if (cell.content?.length) text += readStructuralElements(cell.content as Array<Record<string, unknown>>);
        }
      }
      continue;
    }
    const toc = el.tableOfContents as { content?: Array<Record<string, unknown>> } | undefined;
    if (toc?.content?.length) {
      text += readStructuralElements(toc.content);
    }
  }
  return text;
}

export async function docsRead(params: { documentId: string }): Promise<string> {
  const token = await getValidGoogleToken();
  if (!token) return "[Google Docs: 未接続]";

  const url = `${DOCS_API}/${params.documentId}`;
  try {
    const raw = await fetchProxy(url, "GET", { Authorization: `Bearer ${token}` });
    const data = JSON.parse(raw) as { error?: { message?: string }; body?: { content?: Array<Record<string, unknown>> }; title?: string };
    if (data.error) return `[Docs error: ${data.error.message ?? "Unknown"}]`;

    const content = data.body?.content;
    if (!content?.length) return data.title ? `Document "${data.title}" (empty).` : "Document is empty.";

    const text = readStructuralElements(content);
    const title = data.title ? `"${data.title}"\n\n` : "";
    return text.trim() ? `${title}${text.trim()}` : (data.title ? `Document "${data.title}" (no text content).` : "Document has no text.");
  } catch (e) {
    return `[Docs fetch failed: ${e}]`;
  }
}

export interface DocsListItem {
  id: string;
  name: string;
}

export async function docsList(): Promise<DocsListItem[]> {
  const token = await getValidGoogleToken();
  if (!token) return [];

  const q = "mimeType='application/vnd.google-apps.document' and trashed=false";
  const url = `${DRIVE_API}/files?q=${encodeURIComponent(q)}&orderBy=modifiedTime%20desc&pageSize=50&fields=files(id,name)`;
  const raw = await fetchProxy(url, "GET", { Authorization: `Bearer ${token}` });
  const data = JSON.parse(raw) as { error?: { message?: string; code?: number }; files?: Array<{ id: string; name: string }> };
  if (data.error) {
    const msg = data.error.message ?? "Unknown error";
    throw new Error(data.error.code === 403 ? `Drive のスコープ不足: ${msg}` : msg);
  }
  return (data.files ?? []).map((f) => ({ id: f.id, name: f.name }));
}

export async function docsWrite(params: {
  documentId: string;
  content: string;
  mode: "replace" | "append";
}): Promise<string> {
  const token = await getValidGoogleToken();
  if (!token) return "[Google Docs: 未接続]";

  try {
    if (params.mode === "append") {
      const getRaw = await fetchProxy(`${DOCS_API}/${params.documentId}`, "GET", { Authorization: `Bearer ${token}` });
      const getData = JSON.parse(getRaw);
      if (getData.error) return `[Docs error: ${getData.error.message ?? "Unknown"}]`;
      const endIndex = (getData.body?.content?.[getData.body.content.length - 1] as { endIndex?: number })?.endIndex ?? 1;
      const requests = [{ insertText: { location: { index: endIndex - 1 }, text: "\n" + params.content } }];
      const batchRaw = await fetchProxy(
        `${DOCS_API}/${params.documentId}:batchUpdate`,
        "POST",
        { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        JSON.stringify({ requests }),
      );
      const batchData = JSON.parse(batchRaw);
      if (batchData.error) return `[Docs write error: ${batchData.error.message ?? "Unknown"}]`;
      return "Appended.";
    } else {
      const getRaw = await fetchProxy(`${DOCS_API}/${params.documentId}`, "GET", { Authorization: `Bearer ${token}` });
      const getData = JSON.parse(getRaw);
      if (getData.error) return `[Docs error: ${getData.error.message ?? "Unknown"}]`;
      const content = getData.body?.content ?? [];
      const lastEl = content[content.length - 1] as { endIndex?: number };
      const endIndex = lastEl?.endIndex ?? 1;
      const requests = [
        { deleteContent: { range: { startIndex: 1, endIndex: endIndex - 1 } } },
        { insertText: { location: { index: 1 }, text: params.content } },
      ];
      const batchRaw = await fetchProxy(
        `${DOCS_API}/${params.documentId}:batchUpdate`,
        "POST",
        { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        JSON.stringify({ requests }),
      );
      const batchData = JSON.parse(batchRaw);
      if (batchData.error) return `[Docs write error: ${batchData.error.message ?? "Unknown"}]`;
      return "Replaced.";
    }
  } catch (e) {
    return `[Docs write failed: ${e}]`;
  }
}

export async function docsCreate(title: string): Promise<{ id: string } | null> {
  const token = await getValidGoogleToken();
  if (!token) return null;

  const body = JSON.stringify({
    name: title || "Untitled",
    mimeType: "application/vnd.google-apps.document",
  });
  try {
    const raw = await fetchProxy(
      `${DRIVE_API}/files`,
      "POST",
      { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body,
    );
    const data = JSON.parse(raw);
    if (data.error) return null;
    return { id: data.id };
  } catch {
    return null;
  }
}
