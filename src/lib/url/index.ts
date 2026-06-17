export { extractUrls, normalizeUrlInput, type ExtractedLink } from "./extract";
export {
  AUTO_PREFETCH_DOMAINS,
  UNAVAILABLE_DOMAINS,
  normalizeHost,
  isAutoPrefetchDomain,
  isUnavailableDomain,
  getDomainLabel,
} from "./domains";
export { routeUrl } from "./route";
export { buildFetchedUrlXml, buildContextXml, previewFromBody } from "./format";
export {
  fetchUrlContent,
  fetchUrlForAttach,
  preprocessUrlsForSend,
  toUrlContextAttachment,
  UnavailableUrlError,
} from "./prefetch";
export type {
  FetchStrategy,
  FetchedContent,
  UrlContextAttachment,
  ProcessedUrlPrefetch,
  FetchUrlOptions,
} from "./types";
export { TauriRequiredError, isTauriRuntime } from "../http/fetchProxy";
export { analyzeUnavailableUrlsForSend } from "./sendGuard";
