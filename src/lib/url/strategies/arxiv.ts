import { XMLParser } from "fast-xml-parser";
import * as pdfjsLib from "pdfjs-dist";
import { fetchProxy, fetchProxyBase64 } from "../../http/fetchProxy";
import type { FetchedContent } from "../types";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).href;

const JINA_MAX_CHARS = 8000;

export function extractArxivId(url: string): string | null {
  try {
    const u = new URL(url);
    const absMatch = u.pathname.match(/^\/abs\/(.+)$/);
    if (absMatch) return absMatch[1].replace(/\.pdf$/, "");
    const pdfMatch = u.pathname.match(/^\/pdf\/(.+)$/);
    if (pdfMatch) return pdfMatch[1].replace(/\.pdf$/, "");
  } catch {
    /* ignore */
  }
  return null;
}

export async function fetchArxivAbstract(url: string, arxivId?: string): Promise<FetchedContent> {
  const id = arxivId ?? extractArxivId(url);
  if (!id) throw new Error("Invalid arXiv URL");

  const apiUrl = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`;
  const xml = await fetchProxy(apiUrl, "GET", { Accept: "application/atom+xml" });

  const parser = new XMLParser({ ignoreAttributes: false });
  const parsed = parser.parse(xml) as {
    feed?: {
      entry?: Record<string, unknown> | Array<Record<string, unknown>>;
    };
  };

  const entryRaw = parsed.feed?.entry;
  const entry = Array.isArray(entryRaw) ? entryRaw[0] : entryRaw;
  if (!entry) throw new Error("arXiv entry not found");

  const title = String(entry.title ?? "").replace(/\s+/g, " ").trim();
  const summary = String(entry.summary ?? "").replace(/\s+/g, " ").trim();

  let authors = "";
  const authorField = entry.author;
  if (Array.isArray(authorField)) {
    authors = authorField.map((a) => String((a as { name?: string }).name ?? "")).filter(Boolean).join(", ");
  } else if (authorField && typeof authorField === "object") {
    authors = String((authorField as { name?: string }).name ?? "");
  }

  const body = [
    `Title: ${title}`,
    authors ? `Authors: ${authors}` : "",
    `Abstract: ${summary}`,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    url,
    source: "arXiv API",
    body: body.slice(0, JINA_MAX_CHARS),
  };
}

async function extractPdfTextFromBase64(b64: string): Promise<string> {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
  const parts: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ");
    parts.push(text);
  }
  return parts.join("\n\n");
}

export async function fetchArxivPdf(url: string): Promise<FetchedContent> {
  const id = extractArxivId(url);
  if (!id) throw new Error("Invalid arXiv PDF URL");

  const pdfUrl = `https://arxiv.org/pdf/${id}.pdf`;
  const b64 = await fetchProxyBase64(pdfUrl, "GET", { Accept: "application/pdf" });
  const text = await extractPdfTextFromBase64(b64);

  if (!text.trim()) throw new Error("PDFからテキストを抽出できませんでした");

  return {
    url,
    source: "arXiv PDF",
    body: `Title: arXiv ${id}\n\n${text.slice(0, JINA_MAX_CHARS)}`,
  };
}
