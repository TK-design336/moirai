import type { ParsedResponse } from "../../types/engine";

const HUB_META_PATTERNS: Array<{ re: RegExp; impGroup: number; tsGroup: number }> = [
  { re: /<hub_meta\s+importance="([1-5])"\s+topic_shift="(true|false)"\s*\/?>/gi, impGroup: 1, tsGroup: 2 },
  { re: /<hub_meta\s+topic_shift="(true|false)"\s+importance="([1-5])"\s*\/?>/gi, impGroup: 2, tsGroup: 1 },
];

/** 本文から最後の hub_meta を読む（属性順のゆらぎに対応）。 */
export function parseLastHubMetaFromContent(content: string): ParsedResponse["hubMeta"] | undefined {
  let last: ParsedResponse["hubMeta"] | undefined;
  for (const { re, impGroup, tsGroup } of HUB_META_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const importance = Math.min(5, Math.max(1, parseInt(m[impGroup]!, 10))) as 1 | 2 | 3 | 4 | 5;
      const topicShift = m[tsGroup]!.toLowerCase() === "true";
      last = { importance, topicShift };
    }
  }
  return last;
}

/** hub_meta タグを本文から除去し、最後に見つかった meta を返す。 */
export function stripHubMetaTags(text: string): { text: string; hubMeta: ParsedResponse["hubMeta"] | undefined } {
  const hubMeta = parseLastHubMetaFromContent(text);
  let out = text;
  for (const { re } of HUB_META_PATTERNS) {
    out = out.replace(re, "");
  }
  return { text: out, hubMeta };
}
