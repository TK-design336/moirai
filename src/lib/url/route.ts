import type { FetchStrategy } from "./types";

export function routeUrl(url: string): FetchStrategy {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "jina";
  }

  const host = parsed.hostname.replace(/^www\./, "");
  const path = parsed.pathname;

  if (host === "github.com") {
    if (path.match(/^\/[^/]+\/[^/]+\/blob\//)) return "github_raw";
    if (path.match(/^\/[^/]+\/[^/]+\/issues\/\d+/)) return "github_issues_api";
    if (path.match(/^\/[^/]+\/[^/]+\/?$/)) return "github_readme_api";
    return "jina";
  }

  if (host === "arxiv.org") {
    if (path.startsWith("/abs/")) return "arxiv_abstract_api";
    if (path.startsWith("/pdf/")) return "arxiv_pdf_confirm";
  }

  if (host.includes("wikipedia.org")) return "wikipedia_api";

  if (host === "twitter.com" || host === "x.com") return "unavailable";

  if (host === "youtube.com" || host === "youtu.be") return "jina";

  if (host === "huggingface.co" && path.startsWith("/papers/")) return "hf_paper_api";

  if (host === "zenn.dev" || host === "qiita.com") return "jina";

  if (host.startsWith("docs.") || host.startsWith("developer.")) return "jina";

  return "jina";
}
