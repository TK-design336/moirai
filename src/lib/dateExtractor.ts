/**
 * Extracts date/time expressions from text and normalizes them to Date objects.
 * Supports: relative (今日/明日), slash (3/10), kanji (3月10日),
 * weekday (月曜 / 今週月曜 / 来週金曜 / 再来週火曜), ranges (AからBまで inclusive),
 * n days later/before, ISO (2026-03-10).
 */

const DOW_NAMES: Record<string, number> = {
  日: 0, 月: 1, 火: 2, 水: 3, 木: 4, 金: 5, 土: 6,
};

function localYmd(d: Date): string {
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function calendarMonday(today: Date): Date {
  const dow = today.getDay();
  const mondayOffset = dow === 0 ? -6 : -(dow - 1);
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  monday.setDate(monday.getDate() + mondayOffset);
  return monday;
}

/** weekOffset: 0=今週, 1=来週, 2=再来週（月曜始まりの週） */
function dateAtWeekOffsetWeekday(today: Date, weekOffset: number, targetDow: number): Date {
  const monday = calendarMonday(today);
  const dayOffsetFromMon = targetDow === 0 ? 6 : targetDow - 1;
  const d = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate());
  d.setDate(d.getDate() + weekOffset * 7 + dayOffsetFromMon);
  return d;
}

function nextOccurrenceWeekday(today: Date, targetDow: number): Date {
  const dow = today.getDay();
  let diff = (targetDow - dow + 7) % 7;
  if (diff === 0) diff = 7;
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  d.setDate(d.getDate() + diff);
  return d;
}

const WEEKDAY_IN_TEXT =
  /(?:(再来週|来週|今週)の?)?([日月火水木金土])\s*曜\s*(?:日)?/g;

function weekdayDatesFromMatch(
  today: Date,
  weekLabel: string | undefined,
  kanji: string,
): Date | null {
  const targetDow = DOW_NAMES[kanji];
  if (targetDow === undefined) return null;
  if (weekLabel === "今週") return dateAtWeekOffsetWeekday(today, 0, targetDow);
  if (weekLabel === "来週") return dateAtWeekOffsetWeekday(today, 1, targetDow);
  if (weekLabel === "再来週") return dateAtWeekOffsetWeekday(today, 2, targetDow);
  return nextOccurrenceWeekday(today, targetDow);
}

/** レンジの端など、短い断片から「1つの」基準日を取る */
function parseSingleDatePhrase(fragment: string, today: Date, now: Date): Date | null {
  const text = fragment.trim();
  if (!text) return null;

  const isoYmd = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2})?)?$/);
  if (isoYmd) {
    const y = parseInt(isoYmd[1], 10);
    const mo = parseInt(isoYmd[2], 10);
    const da = parseInt(isoYmd[3], 10);
    const d = new Date(y, mo - 1, da);
    return isNaN(d.getTime()) ? null : d;
  }

  if (/今日|きょう|today\b/i.test(text)) {
    return new Date(today.getFullYear(), today.getMonth(), today.getDate());
  }
  if (/明日|あした|あす|tomorrow\b/i.test(text)) {
    const d = new Date(today);
    d.setDate(d.getDate() + 1);
    return d;
  }
  if (/明後日|あさって|day after tomorrow/i.test(text)) {
    const d = new Date(today);
    d.setDate(d.getDate() + 2);
    return d;
  }
  if (/昨日|きのう|yesterday\b/i.test(text)) {
    const d = new Date(today);
    d.setDate(d.getDate() - 1);
    return d;
  }
  if (/一昨日|おととい|day before yesterday/i.test(text)) {
    const d = new Date(today);
    d.setDate(d.getDate() - 2);
    return d;
  }

  WEEKDAY_IN_TEXT.lastIndex = 0;
  const wmEarly = WEEKDAY_IN_TEXT.exec(text);
  if (wmEarly && wmEarly.index === 0 && wmEarly[0].length === text.length) {
    return weekdayDatesFromMatch(today, wmEarly[1], wmEarly[2]);
  }

  const dow = today.getDay();
  if (/(?:^|[^再])来週(?!の?[月火水木金土]\s*曜)|らいしゅう|next week/i.test(text)) {
    const d = new Date(today);
    d.setDate(d.getDate() + ((7 - dow + 1) % 7 || 7));
    return d;
  }
  if (/今週末|こしゅうまつ|this weekend/i.test(text)) {
    const sat = new Date(today);
    sat.setDate(sat.getDate() + ((6 - dow + 7) % 7));
    return sat;
  }
  if (/先週|せんしゅう|last week/i.test(text)) {
    const d = new Date(today);
    d.setDate(d.getDate() - 7);
    return d;
  }

  const ndLater = text.match(/^(\d+)\s*日\s*後|^(\d+)\s*日後/);
  if (ndLater) {
    const n = parseInt(ndLater[0].replace(/\D/g, ""), 10);
    if (n >= 0 && n <= 365) {
      const d = new Date(today);
      d.setDate(d.getDate() + n);
      return d;
    }
  }
  const ndBefore = text.match(/^(\d+)\s*日\s*前|^(\d+)\s*日前/);
  if (ndBefore) {
    const n = parseInt(ndBefore[0].replace(/\D/g, ""), 10);
    if (n >= 0 && n <= 365) {
      const d = new Date(today);
      d.setDate(d.getDate() - n);
      return d;
    }
  }

  const slashOne = text.match(/^(\d{4}\/)?(\d{1,2})\/(\d{1,2})$/);
  if (slashOne) {
    const full = slashOne[0];
    const parts = full.split("/").map((p) => parseInt(p, 10));
    const y = now.getFullYear();
    let year = y;
    let month: number;
    let day: number;
    if (parts.length === 3 && parts[0] > 1000) {
      [year, month, day] = parts;
    } else if (parts.length === 3) {
      [, month, day] = parts;
    } else {
      [month, day] = parts;
    }
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const d = new Date(year, month - 1, day);
      return isNaN(d.getTime()) ? null : d;
    }
  }

  const toHalf = (s: string) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  const kanjiOne = text.match(/^[\d０-９]+\s*月\s*[\d０-９]+\s*日$/);
  if (kanjiOne) {
    const normalized = toHalf(kanjiOne[0]);
    const ps = normalized.replace(/月|日/g, " ").trim().split(/\s+/).filter(Boolean);
    if (ps.length >= 2) {
      const month = parseInt(ps[0], 10);
      const day = parseInt(ps[1], 10);
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        const d = new Date(now.getFullYear(), month - 1, day);
        return isNaN(d.getTime()) ? null : d;
      }
    }
  }

  return null;
}

const RANGE_RE = /([\s\S]{1,48}?)から\s*[、,]?\s*([\s\S]{1,48}?)まで/g;

function addInclusiveRange(add: (d: Date) => void, start: Date, end: Date): void {
  const a = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const b = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  if (a.getTime() > b.getTime()) {
    addInclusiveRange(add, end, start);
    return;
  }
  for (let cur = new Date(a);;) {
    add(new Date(cur.getFullYear(), cur.getMonth(), cur.getDate()));
    if (localYmd(cur) === localYmd(b)) break;
    cur.setDate(cur.getDate() + 1);
  }
}

export function extractDatesFromText(text: string, now: Date): Date[] {
  const results: Date[] = [];
  const seen = new Set<string>();

  function add(d: Date) {
    const key = localYmd(d);
    if (!seen.has(key)) {
      seen.add(key);
      results.push(new Date(d.getFullYear(), d.getMonth(), d.getDate()));
    }
  }

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  let rest = text;
  let rangeMatch: RegExpExecArray | null;
  const rangeRe = new RegExp(RANGE_RE.source, "g");
  while ((rangeMatch = rangeRe.exec(text)) !== null) {
    const left = parseSingleDatePhrase(rangeMatch[1], today, now);
    const right = parseSingleDatePhrase(rangeMatch[2], today, now);
    if (left && right) {
      addInclusiveRange(add, left, right);
      const full = rangeMatch[0];
      rest = rest.split(full).join(" ");
    }
  }

  const isoMatch = rest.match(/\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?)?/g);
  if (isoMatch) {
    for (const m of isoMatch) {
      const ymd = m.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (ymd) {
        const d = new Date(parseInt(ymd[1], 10), parseInt(ymd[2], 10) - 1, parseInt(ymd[3], 10));
        if (!isNaN(d.getTime())) add(d);
      }
    }
  }

  if (/今日|きょう|today\b/i.test(rest)) add(today);
  if (/明日|あした|あす|tomorrow\b/i.test(rest)) {
    const d = new Date(today);
    d.setDate(d.getDate() + 1);
    add(d);
  }
  if (/明後日|あさって|day after tomorrow/i.test(rest)) {
    const d = new Date(today);
    d.setDate(d.getDate() + 2);
    add(d);
  }
  if (/昨日|きのう|yesterday\b/i.test(rest)) {
    const d = new Date(today);
    d.setDate(d.getDate() - 1);
    add(d);
  }
  if (/一昨日|おととい|day before yesterday/i.test(rest)) {
    const d = new Date(today);
    d.setDate(d.getDate() - 2);
    add(d);
  }

  const dow = today.getDay();
  if (/(?:^|[^再])来週(?!の?[月火水木金土]\s*曜)|らいしゅう|next week/i.test(rest)) {
    const d = new Date(today);
    d.setDate(d.getDate() + ((7 - dow + 1) % 7 || 7));
    add(d);
  }
  if (/今週末|こしゅうまつ|this weekend/i.test(rest)) {
    const sat = new Date(today);
    sat.setDate(sat.getDate() + ((6 - dow + 7) % 7));
    add(sat);
    const sun = new Date(today);
    sun.setDate(sun.getDate() + ((7 - dow + 7) % 7));
    add(sun);
  }
  if (/先週|せんしゅう|last week/i.test(rest)) {
    const d = new Date(today);
    d.setDate(d.getDate() - 7);
    add(d);
  }

  const ndLater = rest.match(/(\d+)\s*日\s*後|(\d+)\s*日後/g);
  if (ndLater) {
    for (const m of ndLater) {
      const n = parseInt(m.replace(/\D/g, ""), 10);
      if (n >= 0 && n <= 365) {
        const d = new Date(today);
        d.setDate(d.getDate() + n);
        add(d);
      }
    }
  }
  const ndBefore = rest.match(/(\d+)\s*日\s*前|(\d+)\s*日前/g);
  if (ndBefore) {
    for (const m of ndBefore) {
      const n = parseInt(m.replace(/\D/g, ""), 10);
      if (n >= 0 && n <= 365) {
        const d = new Date(today);
        d.setDate(d.getDate() - n);
        add(d);
      }
    }
  }

  const slashMatch = rest.match(/(\d{4}\/)?(\d{1,2})\/(\d{1,2})/g);
  if (slashMatch) {
    const y = now.getFullYear();
    for (const m of slashMatch) {
      const parts = m.split("/").map((p) => parseInt(p, 10));
      let year = y;
      let month: number;
      let day: number;
      if (parts.length === 3 && parts[0] > 1000) {
        [year, month, day] = parts;
      } else if (parts.length === 3) {
        [, month, day] = parts;
      } else {
        [month, day] = parts;
      }
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        const d = new Date(year, month - 1, day);
        if (!isNaN(d.getTime())) add(d);
      }
    }
  }

  const toHalf = (s: string) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  const kanjiMatch = rest.match(/[\d０-９]+\s*月\s*[\d０-９]+\s*日/g);
  if (kanjiMatch) {
    for (const m of kanjiMatch) {
      const normalized = toHalf(m);
      const parts = normalized.replace(/月|日/g, " ").trim().split(/\s+/).filter(Boolean);
      if (parts.length >= 2) {
        const month = parseInt(parts[0], 10);
        const day = parseInt(parts[1], 10);
        if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
          const d = new Date(now.getFullYear(), month - 1, day);
          if (!isNaN(d.getTime())) add(d);
        }
      }
    }
  }

  WEEKDAY_IN_TEXT.lastIndex = 0;
  let wm: RegExpExecArray | null;
  while ((wm = WEEKDAY_IN_TEXT.exec(rest)) !== null) {
    const d = weekdayDatesFromMatch(today, wm[1], wm[2]);
    if (d) add(d);
  }

  results.sort((a, b) => a.getTime() - b.getTime());
  return results;
}
