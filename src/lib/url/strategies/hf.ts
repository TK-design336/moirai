import { fetchArxivAbstract } from "./arxiv";

/** HuggingFace papers URL → extract arXiv ID and delegate to arXiv API. */
export async function fetchHfPaper(url: string): Promise<import("../types").FetchedContent> {
  const m = url.match(/arxiv[:\s]*(\d{4}\.\d{4,5}(?:v\d+)?)/i);
  if (!m) {
    // Try fetching page and looking for arxiv link via HF page structure
    const idMatch = url.match(/\/papers\/(\d{4}\.\d{4,5})/);
    if (idMatch) {
      const arxivUrl = `https://arxiv.org/abs/${idMatch[1]}`;
      return fetchArxivAbstract(arxivUrl, idMatch[1]);
    }
    throw new Error("Could not extract arXiv ID from HuggingFace paper URL");
  }
  const arxivUrl = `https://arxiv.org/abs/${m[1]}`;
  return fetchArxivAbstract(arxivUrl, m[1]);
}
