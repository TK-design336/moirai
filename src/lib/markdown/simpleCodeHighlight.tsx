import React from "react";

/** True when this `code` is rendered inside a fenced `pre` (see Provider in ChatPanel). */
export const MarkdownFencedCodeContext = React.createContext(false);

const PY_KEYWORDS = new Set([
  "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif", "else",
  "except", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal", "not",
  "or", "pass", "raise", "return", "try", "while", "with", "yield", "True", "False", "None",
]);

const PY_BUILTINS = new Set([
  "len", "range", "str", "int", "float", "bool", "list", "dict", "set", "tuple", "type", "print", "open",
  "enumerate", "zip", "map", "filter", "sum", "min", "max", "abs", "round", "sorted", "isinstance",
  "hasattr", "getattr", "setattr", "super", "object", "bytes", "repr", "input", "next", "iter", "all", "any",
]);

const JS_KEYWORDS = new Set([
  "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do", "else",
  "export", "extends", "finally", "for", "function", "if", "import", "in", "instanceof", "let", "new",
  "return", "static", "super", "switch", "this", "throw", "try", "typeof", "var", "void", "while", "with",
  "yield", "await", "async", "of", "from", "as", "enum", "implements", "interface", "package", "private",
  "protected", "public", "abstract", "readonly", "get", "set", "declare", "namespace", "module", "keyof",
  "satisfies", "using",
  "true", "false", "null", "undefined",
]);

const JS_TYPES = new Set([
  "string", "number", "boolean", "bigint", "symbol", "any", "unknown", "never", "void",
]);

type LangMode = "python" | "javascript" | "generic";

function langFromClassName(className: string | undefined): LangMode {
  const m = /language-([\w-]+)/.exec(className ?? "");
  const id = (m?.[1] ?? "text").toLowerCase();
  if (id === "py" || id === "python") return "python";
  if (
    id === "js" ||
    id === "javascript" ||
    id === "jsx" ||
    id === "mjs" ||
    id === "cjs" ||
    id === "ts" ||
    id === "tsx" ||
    id === "typescript"
  ) {
    return "javascript";
  }
  return "generic";
}

function flattenCodePlainText(node: React.ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flattenCodePlainText).join("");
  if (React.isValidElement(node)) {
    const ch = (node.props as { children?: React.ReactNode }).children;
    if (ch !== undefined) return flattenCodePlainText(ch);
  }
  return "";
}

export function getCodePlainText(node: React.ReactNode): string {
  return flattenCodePlainText(node);
}

function isIdentStart(c: string): boolean {
  return /[A-Za-z_$]/.test(c);
}

function isIdentPart(c: string): boolean {
  return /[\w$]/.test(c);
}

function readIdentifier(source: string, start: number): { word: string; end: number } {
  let j = start + 1;
  while (j < source.length && isIdentPart(source[j]!)) j++;
  return { word: source.slice(start, j), end: j };
}

function readLineComment(source: string, start: number): { text: string; end: number } {
  let j = start;
  while (j < source.length && source[j] !== "\n" && source[j] !== "\r") j++;
  return { text: source.slice(start, j), end: j };
}

function readBlockComment(source: string, start: number): { text: string; end: number } | null {
  if (source[start] !== "/" || source[start + 1] !== "*") return null;
  let j = start + 2;
  while (j < source.length - 1) {
    if (source[j] === "*" && source[j + 1] === "/") {
      return { text: source.slice(start, j + 2), end: j + 2 };
    }
    j++;
  }
  return { text: source.slice(start), end: source.length };
}

function readString(
  source: string,
  start: number,
  quote: '"' | "'" | "`",
): { text: string; end: number } {
  let j = start + 1;
  while (j < source.length) {
    const c = source[j]!;
    if (c === "\\" && j + 1 < source.length) {
      j += 2;
      continue;
    }
    if (c === quote) {
      return { text: source.slice(start, j + 1), end: j + 1 };
    }
    j++;
  }
  return { text: source.slice(start), end: source.length };
}

function readNumber(source: string, start: number): { text: string; end: number } | null {
  let j = start;
  if (source[j] === "0" && (source[j + 1] === "x" || source[j + 1] === "X")) {
    j += 2;
    while (j < source.length && /[\da-fA-F]/.test(source[j]!)) j++;
    if (j > start + 2) return { text: source.slice(start, j), end: j };
    return null;
  }
  if (!/\d/.test(source[j]!)) return null;
  while (j < source.length && /\d/.test(source[j]!)) j++;
  if (source[j] === "." && j + 1 < source.length && /\d/.test(source[j + 1]!)) {
    j++;
    while (j < source.length && /\d/.test(source[j]!)) j++;
  }
  if (source[j] === "e" || source[j] === "E") {
    j++;
    if (source[j] === "+" || source[j] === "-") j++;
    while (j < source.length && /\d/.test(source[j]!)) j++;
  }
  if (j > start) return { text: source.slice(start, j), end: j };
  return null;
}

function classifyIdent(word: string, mode: LangMode): "keyword" | "builtin" | "type" | "text" {
  if (mode === "python") {
    if (PY_KEYWORDS.has(word)) return "keyword";
    if (PY_BUILTINS.has(word)) return "builtin";
    if (/^[A-Z][\w$]*$/.test(word) && word.length > 1) return "type";
    return "text";
  }
  if (mode === "javascript") {
    const lower = word.toLowerCase();
    if (JS_KEYWORDS.has(lower)) return "keyword";
    if (JS_TYPES.has(lower)) return "type";
    if (/^[A-Z][\w$]*$/.test(word) && word.length > 1) return "type";
    return "text";
  }
  // generic: union heuristics
  const lower = word.toLowerCase();
  if (PY_KEYWORDS.has(word) || JS_KEYWORDS.has(lower)) return "keyword";
  if (PY_BUILTINS.has(word)) return "builtin";
  if (JS_TYPES.has(lower)) return "type";
  if (/^[A-Z][\w$]*$/.test(word) && word.length > 1) return "type";
  return "text";
}

export function highlightCodeSourceToNodes(source: string, className: string | undefined): React.ReactNode[] {
  const mode = langFromClassName(className);
  const allowHashComment = mode === "python" || mode === "generic";
  const out: React.ReactNode[] = [];
  let buf = "";
  let key = 0;

  const flushBuf = () => {
    if (buf.length === 0) return;
    out.push(
      <span key={`t-${key++}`} className="md-code-hl-text">
        {buf}
      </span>,
    );
    buf = "";
  };

  const pushSpan = (cls: string, text: string) => {
    flushBuf();
    out.push(
      <span key={`t-${key++}`} className={cls}>
        {text}
      </span>,
    );
  };

  let i = 0;
  while (i < source.length) {
    const c = source[i]!;

    // Line comments
    if (source.startsWith("//", i)) {
      const { text, end } = readLineComment(source, i);
      pushSpan("md-code-hl-comment", text);
      i = end;
      continue;
    }
    if (allowHashComment && c === "#") {
      const { text, end } = readLineComment(source, i);
      pushSpan("md-code-hl-comment", text);
      i = end;
      continue;
    }
    const block = readBlockComment(source, i);
    if (block) {
      pushSpan("md-code-hl-comment", block.text);
      i = block.end;
      continue;
    }

    // Strings
    if (c === '"' || c === "'" || c === "`") {
      const { text, end } = readString(source, i, c);
      pushSpan("md-code-hl-string", text);
      i = end;
      continue;
    }

    // Numbers
    const num = readNumber(source, i);
    if (num) {
      pushSpan("md-code-hl-number", num.text);
      i = num.end;
      continue;
    }

    // Identifiers / keywords
    if (isIdentStart(c)) {
      const { word, end } = readIdentifier(source, i);
      const cls = classifyIdent(word, mode);
      if (cls === "text") {
        buf += word;
      } else {
        pushSpan(`md-code-hl-${cls}`, word);
      }
      i = end;
      continue;
    }

    buf += c;
    i++;
  }
  flushBuf();
  return out;
}
