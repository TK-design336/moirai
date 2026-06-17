/**
 * 手動送信前の「未完っぽさ」ヒューリスティック（ルールベース）。
 * 誤検知より過検知を優先する前提。
 */

const TRAIL_PUNCT = /[。、！？…．.!?,]+$/;
const TRAIL_WS = /[\s\u3000]+$/;

/** 送信内容の同一性判定（改行の畳み込み + trim） */
export function incompleteSendFingerprint(text: string): string {
  return text.trim().replace(/\n{3,}/g, "\n\n");
}

function stripTrailingNoise(s: string): string {
  let t = s.trimEnd();
  for (;;) {
    const n = t.replace(TRAIL_PUNCT, "").replace(TRAIL_WS, "");
    if (n === t) break;
    t = n;
  }
  return t;
}

const CONJUNCTION_SUFFIXES: string[] = [
  "ところが",
  "すなわち",
  "しかし",
  "それで",
  "だから",
  "すると",
  "つまり",
  "ただし",
  "なので",
  "一方",
  "そして",
  "また",
  "なぜなら",
  "というのも",
  "そのうえ",
  "それに",
  "加えて",
  "しかも",
  "でも",
  "まず",
  "次に",
  "最後に",
];

/** 長い語から先にマッチ */
const CONJ_PARTICLE_SUFFIXES: string[] = [
  "けれども",
  "けれど",
  "だけど",
  "ですが",
  "ながら",
  "のに",
  "ても",
  "つつ",
  "ので",
  "から",
  "けど",
  "でも",
  "が",
];

const NOUN_PHRASE_SUFFIXES = ["について", "に関して", "としては", "において", "に対して"] as const;

const EXAMPLE_INTROS = ["例えば", "具体的には", "たとえば", "例を挙げると"] as const;

/** 直前が用言語尾っぽいときのみ「は」「の」を未完扱い（単独助詞の誤検知を減らす） */
function prevCharIsKana(s: string, i: number): boolean {
  if (i < 0) return false;
  const c = s[i]!;
  const cp = c.codePointAt(0)!;
  return (
    (cp >= 0x3040 && cp <= 0x309f) || // Hiragana
    (cp >= 0x30a0 && cp <= 0x30ff) || // Katakana
    cp === 0x30fc // prolonged sound
  );
}

function endsWithConjunction(tail: string): boolean {
  const s = stripTrailingNoise(tail);
  if (!s) return false;
  return CONJUNCTION_SUFFIXES.some((w) => s.endsWith(w));
}

function endsWithConnectingParticle(fullTrimmed: string): boolean {
  const s = stripTrailingNoise(fullTrimmed);
  if (!s) return false;
  for (const suf of CONJ_PARTICLE_SUFFIXES) {
    if (s.endsWith(suf)) return true;
  }
  if (s.endsWith("は") || s.endsWith("の")) {
    const i = s.length - 2;
    return prevCharIsKana(s, i);
  }
  return false;
}

const BRACKET_PAIRS: Record<string, string> = {
  "(": ")",
  "（": "）",
  "[": "]",
  "【": "】",
  "「": "」",
  "『": "』",
};

const CLOSE_TO_OPEN = new Map<string, string>(
  Object.entries(BRACKET_PAIRS).map(([o, c]) => [c, o]),
);

function unclosedBracketOrQuote(text: string): boolean {
  const stack: string[] = [];
  for (let i = 0; i < text.length; ) {
    const c = text[i]!;
    const cp = c.codePointAt(0)!;
    const len = cp > 0xffff ? 2 : 1;
    const ch = len === 2 ? text.slice(i, i + 2) : c;

    if (BRACKET_PAIRS[ch]) {
      stack.push(ch);
      i += len;
      continue;
    }
    if (CLOSE_TO_OPEN.has(ch)) {
      const wantOpen = CLOSE_TO_OPEN.get(ch)!;
      if (stack.length === 0 || stack[stack.length - 1] !== wantOpen) {
        return true; // 不整合も未完扱い
      }
      stack.pop();
      i += len;
      continue;
    }
    i += len;
  }
  return stack.length > 0;
}

function lastNonEmptyLine(text: string): string {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i]!.trim();
    if (t) return t;
  }
  return "";
}

function endsWithNumberedListMid(text: string): boolean {
  return /^\d+\.\s*$/.test(lastNonEmptyLine(text));
}

/** 丸数字のみの行、または本文末尾が丸数字（リスト途中のヒューリスティック） */
function endsWithCircledListMid(text: string): boolean {
  const lastLine = lastNonEmptyLine(text);
  if (/^[\u2460-\u2473\u24ea①②③④⑤⑥⑦⑧⑨⑩]+\s*$/.test(lastLine)) return true;
  const t = text.trimEnd();
  if (!t) return false;
  const runes = [...t];
  const lastCh = runes[runes.length - 1];
  if (!lastCh) return false;
  const cp = lastCh.codePointAt(0)!;
  if ((cp >= 0x2460 && cp <= 0x2473) || cp === 0x24ea) return true;
  if (cp >= 0x3251 && cp <= 0x325f) return true;
  return false;
}

function endsWithFullwidthLatinTail(text: string): boolean {
  const t = text.replace(TRAIL_WS, "").trimEnd();
  if (!t) return false;
  return /[\uff21-\uff3a\uff41-\uff5a]+$/.test(t);
}

function endsWithExampleIntroOnly(text: string): boolean {
  const s = stripTrailingNoise(text);
  if (!s) return false;
  return EXAMPLE_INTROS.some((w) => s === w || s.endsWith(`\n${w}`));
}

export interface IncompleteSendAnalysis {
  warn: boolean;
  reasons: string[];
}

/** 文末が明示終止の句読点（全角・半角の句点・疑問・感嘆）なら未完ガード対象外 */
function endsWithSentenceClosingPunct(text: string): boolean {
  const t = text.trimEnd();
  if (!t) return false;
  const last = [...t].at(-1);
  return last !== undefined && /[。.？?！!…]/.test(last);
}

/** 文末が読点（和文「、」「，」および英コンマ）。trimEnd のあと末尾1文字のみ見る */
function endsWithCommaLike(text: string): boolean {
  const t = text.trimEnd();
  if (!t) return false;
  const last = [...t].at(-1);
  return last !== undefined && /[、，,]/.test(last);
}

export function analyzeIncompleteSend(text: string): IncompleteSendAnalysis {
  const reasons: string[] = [];
  const t = text.trim();
  if (!t) return { warn: false, reasons: [] };

  if (endsWithSentenceClosingPunct(t)) {
    return { warn: false, reasons: [] };
  }

  if (endsWithCommaLike(t)) {
    reasons.push("読点（、）またはコンマで終わっている");
  }

  if (endsWithConjunction(t)) {
    reasons.push("接続詞で終わっている");
  }

  if (endsWithConnectingParticle(t)) {
    reasons.push("接続的な語尾（助詞・口語終止など）で終わっている");
  }

  if (unclosedBracketOrQuote(t)) {
    reasons.push("括弧や鉤括弧が閉じていない");
  }

  for (const suf of NOUN_PHRASE_SUFFIXES) {
    if (t.endsWith(suf)) {
      reasons.push("体言止め＋助詞句で終わっている");
      break;
    }
  }

  if (endsWithExampleIntroOnly(t)) {
    reasons.push("例示の導入句で終わっている");
  }

  if (endsWithNumberedListMid(t)) {
    reasons.push("数字リストの番号だけで終わっている");
  }

  if (endsWithCircledListMid(t)) {
    reasons.push("丸数字リストの途中で終わっている");
  }

  if (endsWithFullwidthLatinTail(t)) {
    reasons.push("文末が全角英字になっている");
  }

  const uniq = [...new Set(reasons)];
  return { warn: uniq.length > 0, reasons: uniq };
}
