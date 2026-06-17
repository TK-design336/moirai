/** Domains that trigger automatic prefetch on send. */
export const AUTO_PREFETCH_DOMAINS = [
  "github.com",
  "arxiv.org",
  "wikipedia.org",
  "youtube.com",
  "youtu.be",
  "huggingface.co",
  "zenn.dev",
  "qiita.com",
] as const;

export const UNAVAILABLE_DOMAINS = ["twitter.com", "x.com"] as const;

export function normalizeHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function isUnavailableDomain(host: string): boolean {
  return (UNAVAILABLE_DOMAINS as readonly string[]).includes(host);
}

export function isAutoPrefetchDomain(host: string): boolean {
  return AUTO_PREFETCH_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

export function getDomainLabel(url: string): string {
  const host = normalizeHost(url);
  return host || url;
}
