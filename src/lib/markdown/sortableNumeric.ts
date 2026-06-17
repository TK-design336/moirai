/**
 * Markdown 表セルが「数値のみ」「通貨」「単位付き数値」など並び替え用の数値として解釈できるか判定し、値を返す。
 * 解釈できない場合は null（当該列はソート対象外）。
 */

const FULLWIDTH_DIGITS = /[\uFF10-\uFF19]/g;

function normalizeDigits(s: string): string {
  return s.replace(FULLWIDTH_DIGITS, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xff10 + 0x30));
}

/** 末尾から順に長い単位を試す（2.5km が .5k にならないよう km を先に） */
const SUFFIX_UNITS = [
  "km/h",
  "kmh",
  "m/s",
  "cm²",
  "m²",
  "km²",
  "mm²",
  "kg",
  "㎏",
  "mg",
  "km",
  "cm",
  "mm",
  "ml",
  "min",
  "sec",
  "hrs",
  "hr",
  "lbs",
  "mph",
  "kph",
  "ton",
  "トン",
  "時間",
  "分間",
  "秒",
  "分",
  "円",
  "個",
  "本",
  "枚",
  "t",
  "g",
  "m",
  "L",
  "l",
  "h",
  "s",
];

function stripTrailingUnit(s: string): string {
  let t = s.trim();
  const lower = t.toLowerCase();
  for (const u of SUFFIX_UNITS) {
    const ul = u.toLowerCase();
    if (lower.endsWith(ul)) {
      t = t.slice(0, -u.length).trim();
      return t;
    }
  }
  return t;
}

/**
 * セル全文が数値・通貨・単位付き数値として解釈できるときだけ数値を返す。
 */
export function parseSortableNumeric(raw: string): number | null {
  let s = normalizeDigits(raw).trim();
  if (!s) return null;

  // 括弧だけ（会計表など）
  if (s.startsWith("(") && s.endsWith(")")) {
    s = s.slice(1, -1).trim();
  }

  // 先頭の通貨記号
  s = s.replace(/^[¥$€£￥]\s*/, "");

  // 末尾の通貨（稀）
  s = s.replace(/\s*[¥$€£￥]\s*$/, "");

  // パーセント
  if (s.endsWith("%") || s.endsWith("％")) {
    s = s.slice(0, -1).trim();
  }

  s = stripTrailingUnit(s);

  // 千区切りカンマのみ許容
  const numPart = s.replace(/,/g, "");
  if (!/^[\+\-]?\d+(\.\d+)?$/.test(numPart)) return null;
  const n = parseFloat(numPart);
  return Number.isFinite(n) ? n : null;
}

function cellTextAtColumn(row: HTMLTableRowElement, colIndex: number): string {
  let col = 0;
  for (const cell of Array.from(row.cells)) {
    const cs = cell.colSpan || 1;
    if (colIndex >= col && colIndex < col + cs) {
      return cell.textContent ?? "";
    }
    col += cs;
  }
  return "";
}

/** tbody の該当列がすべて parse 可能か（対象列に colspan がある行は除外不可のため false） */
export function isNumericSortableColumn(table: HTMLTableElement, colIndex: number): boolean {
  const tbody = table.querySelector("tbody");
  if (!tbody) return false;
  const rows = Array.from(tbody.querySelectorAll("tr"));
  if (rows.length === 0) return false;
  for (const row of rows) {
    let col = 0;
    let ok = false;
    for (const cell of Array.from(row.cells)) {
      const cs = cell.colSpan || 1;
      if (colIndex >= col && colIndex < col + cs) {
        if (cs !== 1) return false;
        const t = cell.textContent ?? "";
        if (parseSortableNumeric(t) === null) return false;
        ok = true;
        break;
      }
      col += cs;
    }
    if (!ok) return false;
  }
  return true;
}

export function sortTableBodyByColumn(table: HTMLTableElement, colIndex: number, ascending: boolean): void {
  const tbody = table.querySelector("tbody");
  if (!tbody) return;
  const rows = Array.from(tbody.querySelectorAll("tr"));
  if (rows.length <= 1) return;

  const keyed = rows.map((row) => {
    const text = cellTextAtColumn(row, colIndex);
    const v = parseSortableNumeric(text) ?? 0;
    return { row, v };
  });

  keyed.sort((a, b) => (ascending ? a.v - b.v : b.v - a.v));
  for (const { row } of keyed) {
    tbody.appendChild(row);
  }
}

/** 並べ替え前に保存した行の順で tbody を復元（参照が tbody に無い行はスキップ） */
export function restoreTableBodyRowOrder(tbody: HTMLTableSectionElement, rowsInOriginalOrder: HTMLTableRowElement[]): void {
  const set = new Set(Array.from(tbody.querySelectorAll("tr")));
  for (const row of rowsInOriginalOrder) {
    if (set.has(row)) tbody.appendChild(row);
  }
}
