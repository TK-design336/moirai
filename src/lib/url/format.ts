import type { FetchedContent } from "./types";

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

export function buildFetchedUrlXml(content: FetchedContent): string {
  return `<fetched_url url="${escapeXmlAttr(content.url)}" source="${escapeXmlAttr(content.source)}">\n${content.body}\n</fetched_url>`;
}

export function buildContextXml(results: FetchedContent[]): string {
  if (results.length === 0) return "";
  return results.map(buildFetchedUrlXml).join("\n\n");
}

/** First non-empty line for UI preview chip. */
export function previewFromBody(body: string): string {
  const line = body.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}
