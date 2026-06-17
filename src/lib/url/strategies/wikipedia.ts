import { fetchProxy } from "../../http/fetchProxy";
import type { FetchedContent } from "../types";

const JINA_MAX_CHARS = 8000;

function extractWikipediaTitle(url: string): { lang: string; title: string } | null {
  try {
    const u = new URL(url);
    const langMatch = u.hostname.match(/^([a-z]+)\.wikipedia\.org$/);
    if (!langMatch) return null;
    const pathMatch = u.pathname.match(/^\/wiki\/(.+)$/);
    if (!pathMatch) return null;
    return {
      lang: langMatch[1],
      title: decodeURIComponent(pathMatch[1].replace(/_/g, " ")),
    };
  } catch {
    return null;
  }
}

export async function fetchWikipediaSummary(url: string): Promise<FetchedContent> {
  const info = extractWikipediaTitle(url);
  if (!info) throw new Error("Invalid Wikipedia URL");

  const apiTitle = encodeURIComponent(info.title.replace(/ /g, "_"));
  const summaryUrl = `https://${info.lang}.wikipedia.org/api/rest_v1/page/summary/${apiTitle}`;
  const raw = await fetchProxy(summaryUrl, "GET", { Accept: "application/json" });

  const json = JSON.parse(raw) as {
    title?: string;
    description?: string;
    extract?: string;
    content_urls?: { desktop?: { page?: string } };
  };

  // Fetch section list only (not full article)
  const sectionsUrl = `https://${info.lang}.wikipedia.org/w/api.php?action=parse&page=${apiTitle}&prop=sections&format=json`;
  let sectionList = "";
  try {
    const sectionsRaw = await fetchProxy(sectionsUrl, "GET", { Accept: "application/json" });
    const sectionsJson = JSON.parse(sectionsRaw) as {
      parse?: { sections?: Array<{ line?: string; number?: string }> };
    };
    const sections = sectionsJson.parse?.sections ?? [];
    sectionList = sections
      .map((s) => `- ${s.number ?? ""}: ${s.line ?? ""}`)
      .filter((l) => l.trim().length > 2)
      .join("\n");
  } catch {
    /* sections optional */
  }

  const body = [
    `Title: ${json.title ?? info.title}`,
    json.description ? `Description: ${json.description}` : "",
    "",
    json.extract ?? "",
    sectionList ? `\nSections:\n${sectionList}` : "",
  ]
    .filter((line, i, arr) => i > 0 || line.length > 0)
    .join("\n");

  return {
    url,
    source: "Wikipedia API",
    body: body.slice(0, JINA_MAX_CHARS),
  };
}
