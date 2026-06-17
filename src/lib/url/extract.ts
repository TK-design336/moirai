/** Ensure pasted URLs without a scheme are fetchable. */
export function normalizeUrlInput(raw: string): string {
  const t = raw.trim();
  if (!t) return t;
  if (/^https?:\/\//i.test(t)) return t;
  return `https://${t}`;
}

export interface ExtractedLink {
  url: string;
  label: string;
  citationIndex?: number;
}

/** Extract bare URLs and Markdown links from text. */
export function extractUrls(text: string): ExtractedLink[] {
  const links: ExtractedLink[] = [];
  const seen = new Set<string>();

  const mdLinkRe = /\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = mdLinkRe.exec(text)) !== null) {
    if (!seen.has(m[2])) {
      seen.add(m[2]);
      links.push({ url: m[2], label: m[1] || m[2] });
    }
  }

  const bareRe = /(?<!\]\()(https?:\/\/[^\s)>\]]+)/g;
  while ((m = bareRe.exec(text)) !== null) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      links.push({ url: m[1], label: m[1] });
    }
  }

  return links;
}
