import { extractUrls } from "./extract";
import { isUnavailableDomain, normalizeHost } from "./domains";
import type { UrlContextAttachment } from "./types";

export interface UnavailableUrlSendAnalysis {
  warn: boolean;
  reasons: string[];
}

/** 送信前にブロックすべき取得不可 URL（X/Twitter 等）を本文・明示添付から検出。 */
export function analyzeUnavailableUrlsForSend(
  message: string,
  explicitAttachments: UrlContextAttachment[] = [],
): UnavailableUrlSendAnalysis {
  const reasons: string[] = [];
  const seen = new Set<string>();

  for (const link of extractUrls(message)) {
    const host = normalizeHost(link.url);
    if (isUnavailableDomain(host) && !seen.has(link.url)) {
      seen.add(link.url);
      reasons.push(`${link.url} : X/Twitterのコンテンツは取得できません`);
    }
  }

  for (const att of explicitAttachments) {
    const host = normalizeHost(att.url);
    if (isUnavailableDomain(host) && !seen.has(att.url)) {
      seen.add(att.url);
      reasons.push(`${att.url} : X/Twitterのコンテンツは取得できません`);
    }
  }

  return { warn: reasons.length > 0, reasons };
}
