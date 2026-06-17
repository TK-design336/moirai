export type FetchStrategy =
  | "github_raw"
  | "github_issues_api"
  | "github_readme_api"
  | "arxiv_abstract_api"
  | "arxiv_pdf_confirm"
  | "wikipedia_api"
  | "hf_paper_api"
  | "jina"
  | "unavailable";

export interface FetchedContent {
  url: string;
  source: string;
  body: string;
}

export interface UrlContextAttachment {
  url: string;
  source: string;
  preview: string;
  /** Fetched body — stored on sent messages for in-chat review. */
  body: string;
}

export interface ProcessedUrlPrefetch {
  injectedContext: string;
  warnings: string[];
}

export interface FetchUrlOptions {
  /** Called before arXiv PDF download; return false to abort. */
  onArxivPdfConfirm?: (url: string) => Promise<boolean>;
}
