import { fetchProxy } from "../../http/fetchProxy";
import type { FetchedContent } from "../types";

export const JINA_MAX_CHARS = 8000;

export async function fetchJina(url: string): Promise<FetchedContent> {
  const jinaUrl = `https://r.jina.ai/${url}`;
  const text = await fetchProxy(jinaUrl, "GET", {
    Accept: "text/plain",
    "User-Agent": "Personal-Concierge",
  });

  const trimmed =
    text.length > JINA_MAX_CHARS
      ? `${text.slice(0, JINA_MAX_CHARS)}\n\n[… trimmed from ${text.length} chars]`
      : text;

  return {
    url,
    source: "Jina Reader",
    body: trimmed,
  };
}
