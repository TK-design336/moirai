import type { FetchedContent } from "./types";

const urlFetchCache = new Map<string, FetchedContent | "loading">();

export function getCachedFetch(url: string): FetchedContent | undefined {
  const v = urlFetchCache.get(url);
  if (v && v !== "loading") return v;
  return undefined;
}

export function setCachedFetch(url: string, content: FetchedContent): void {
  urlFetchCache.set(url, content);
}

export function markFetchLoading(url: string): boolean {
  if (urlFetchCache.has(url)) return false;
  urlFetchCache.set(url, "loading");
  return true;
}

export function clearFetchLoading(url: string): void {
  if (urlFetchCache.get(url) === "loading") {
    urlFetchCache.delete(url);
  }
}
