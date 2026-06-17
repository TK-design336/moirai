/**
 * Normalizes markdown bold/italic so that CommonMark parses them correctly.
 * LLMs (or IME) sometimes emit spaces inside delimiters (e.g. ** text **, **text **)
 * which CommonMark treats as literal asterisks rather than emphasis.
 * Uses [ \t\u3000]+ (not \s+) to preserve newlines — \s would match newlines and corrupt line breaks.
 *
 * CommonMark does not treat ** as bold when the opening ** is immediately after a word
 * character (e.g. B**「A」) or the closing ** is immediately before a word character (e.g. 「A」**C).
 * A narrow no-break space (U+00A0) at those boundaries fixes CJK cases without visible gaps.
 */
const NBSP = "\u00A0";
const SPACE = "[ \\t\u3000]+";

/** Opening bracket after ** that needs a boundary when ** was preceded by a "word" char */
const OPEN_AFTER_BOLD = "[「『【［（]";
const CJK_OR_LATIN_AFTER_CLOSE =
  "[\u3040-\u309F\u30A0-\u30FF\u3400-\u9FFF0-9A-Za-z]";

export function normalizeMarkdownBoldItalic(text: string): string {
  let c = text;
  // Fix "** text **" → "**text**": spaces (not newlines) inside bold delimiters (both sides)
  c = c.replace(new RegExp(`\\*\\*${SPACE}(\\S[^\\n]*?\\S|\\S)${SPACE}\\*\\*`, "g"), "**$1**");
  // Fix "**text **" → "**text**": trailing space(s) only before closing **
  c = c.replace(new RegExp(`\\*\\*([^*\\n]+?)${SPACE}\\*\\*`, "g"), "**$1**");
  // Fix "** text**" → "**text**": leading space(s) only after opening **
  c = c.replace(new RegExp(`\\*\\*${SPACE}([^*\\n]+?)\\*\\*`, "g"), "**$1**");
  // Fix "* text *" → "*text*": spaces inside italic delimiters (not **)
  c = c.replace(new RegExp(`(?<!\\*)\\*${SPACE}(\\S[^\\n]*?\\S|\\S)${SPACE}\\*(?!\\*)`, "g"), "*$1*");
  c = c.replace(new RegExp(`(?<!\\*)\\*([^*\\n]+?)${SPACE}\\*(?!\\*)`, "g"), "*$1*");
  c = c.replace(new RegExp(`(?<!\\*)\\*${SPACE}([^*\\n]+?)\\*(?!\\*)`, "g"), "*$1*");

  // Closing ** immediately before hiragana/katakana/kanji/digits/Latin → NBSP after **
  c = c.replace(
    new RegExp(`(?<=[^\\s*])(\\*\\*)(?=${CJK_OR_LATIN_AFTER_CLOSE})`, "g"),
    `**${NBSP}`,
  );

  // Word char (ASCII or CJK) before ** then opening bracket → NBSP before ** (left-flanking)
  c = c.replace(
    new RegExp(
      `(?<=[A-Za-z0-9_\\u3040-\\u309F\\u30A0-\\u30FF\\u3400-\\u9FFF\\uFF66-\\uFF9F])(\\*\\*)(?=${OPEN_AFTER_BOLD})`,
      "g",
    ),
    `${NBSP}**`,
  );

  return c;
}

/** Map a character offset in `source` to the corresponding index in `normalizeMarkdownBoldItalic(source)` using prefix normalization. */
export function mapMarkdownOffsetToNormalized(source: string, offsetInSource: number): number {
  const clamped = Math.max(0, Math.min(offsetInSource, source.length));
  return normalizeMarkdownBoldItalic(source.slice(0, clamped)).length;
}
