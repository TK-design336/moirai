import { TauriRequiredError, isTauriRuntime } from "../http/fetchProxy";
import {
  clearFetchLoading,
  getCachedFetch,
  markFetchLoading,
  setCachedFetch,
} from "./cache";
import { isAutoPrefetchDomain, isUnavailableDomain, normalizeHost } from "./domains";
import { extractUrls } from "./extract";
import { buildContextXml, previewFromBody } from "./format";
import { routeUrl } from "./route";
import { fetchArxivAbstract, fetchArxivPdf } from "./strategies/arxiv";
import { fetchGithubIssue, fetchGithubRaw, fetchGithubReadme } from "./strategies/github";
import { fetchHfPaper } from "./strategies/hf";
import { fetchJina } from "./strategies/jina";
import { fetchWikipediaSummary } from "./strategies/wikipedia";
import type {
  FetchUrlOptions,
  FetchedContent,
  ProcessedUrlPrefetch,
  UrlContextAttachment,
} from "./types";

export class UnavailableUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnavailableUrlError";
  }
}

const MAX_URLS_PER_SEND = 5;

export async function fetchUrlContent(
  url: string,
  options?: FetchUrlOptions,
): Promise<FetchedContent> {
  const cached = getCachedFetch(url);
  if (cached) return cached;

  if (!markFetchLoading(url)) {
    // Wait briefly for in-flight fetch
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const done = getCachedFetch(url);
      if (done) return done;
    }
    throw new Error("URL fetch timeout");
  }

  try {
    const strategy = routeUrl(url);

    if (strategy === "unavailable") {
      throw new UnavailableUrlError("X/Twitterのコンテンツは取得できません");
    }

    let result: FetchedContent;

    switch (strategy) {
      case "github_readme_api":
        result = await fetchGithubReadme(url);
        break;
      case "github_raw":
        result = await fetchGithubRaw(url);
        break;
      case "github_issues_api":
        result = await fetchGithubIssue(url);
        break;
      case "arxiv_abstract_api":
        result = await fetchArxivAbstract(url);
        break;
      case "arxiv_pdf_confirm": {
        const confirm = options?.onArxivPdfConfirm;
        if (!confirm) {
          throw new UnavailableUrlError("arXiv PDF の取得には確認が必要です。From URL から再度お試しください。");
        }
        const ok = await confirm(url);
        if (!ok) throw new UnavailableUrlError("arXiv PDF の取得がキャンセルされました");
        result = await fetchArxivPdf(url);
        break;
      }
      case "wikipedia_api":
        result = await fetchWikipediaSummary(url);
        break;
      case "hf_paper_api":
        result = await fetchHfPaper(url);
        break;
      case "jina":
        result = await fetchJina(url);
        break;
      default:
        result = await fetchJina(url);
    }

    setCachedFetch(url, result);
    return result;
  } finally {
    clearFetchLoading(url);
  }
}

export function toUrlContextAttachment(content: FetchedContent): UrlContextAttachment {
  return {
    url: content.url,
    source: content.source,
    preview: previewFromBody(content.body),
    body: content.body,
  };
}

/** Fetch a single URL for explicit From URL attach (always fetches, uses cache). */
export async function fetchUrlForAttach(
  url: string,
  options?: FetchUrlOptions,
): Promise<UrlContextAttachment> {
  const content = await fetchUrlContent(url.trim(), options);
  return toUrlContextAttachment(content);
}

export async function preprocessUrlsForSend(
  message: string,
  explicitAttachments: UrlContextAttachment[] = [],
  options?: FetchUrlOptions,
): Promise<ProcessedUrlPrefetch> {
  const warnings: string[] = [];
  const results: FetchedContent[] = [];
  const seen = new Set<string>();

  if (!isTauriRuntime()) {
    const hasUrls =
      explicitAttachments.length > 0 || extractUrls(message).length > 0;
    if (hasUrls) {
      warnings.push("URL の取得には Tauri アプリでの起動が必要です");
    }
    return { injectedContext: "", warnings };
  }

  const urlsToFetch: string[] = [];

  for (const att of explicitAttachments) {
    if (!seen.has(att.url)) {
      seen.add(att.url);
      urlsToFetch.push(att.url);
    }
  }

  for (const link of extractUrls(message)) {
    const host = normalizeHost(link.url);
    if (isUnavailableDomain(host)) {
      continue;
    }
    if (!isAutoPrefetchDomain(host)) continue;
    if (!seen.has(link.url)) {
      seen.add(link.url);
      urlsToFetch.push(link.url);
    }
  }

  const limited = urlsToFetch.slice(0, MAX_URLS_PER_SEND);
  if (urlsToFetch.length > MAX_URLS_PER_SEND) {
    warnings.push(`URL prefetch は最大 ${MAX_URLS_PER_SEND} 件までです（残りはスキップ）`);
  }

  const settled = await Promise.allSettled(
    limited.map((url) => fetchUrlContent(url, options)),
  );

  for (let i = 0; i < settled.length; i++) {
    const url = limited[i];
    const outcome = settled[i];
    if (outcome.status === "fulfilled") {
      results.push(outcome.value);
    } else {
      const err = outcome.reason;
      if (err instanceof UnavailableUrlError) {
        warnings.push(`${url} : ${err.message}`);
      } else if (err instanceof TauriRequiredError) {
        warnings.push(err.message);
      } else {
        warnings.push(`${url} : コンテンツの取得に失敗しました`);
      }
    }
  }

  return {
    injectedContext: buildContextXml(results),
    warnings,
  };
}
