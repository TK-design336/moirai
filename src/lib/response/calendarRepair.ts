import type { CalendarPayload, CalendarDaySlice, CalendarEvent } from "../../components/SpecialPanels";

export function normalizeCalendarDaySlices(payload: CalendarPayload): CalendarDaySlice[] {
  if (payload.days?.length) return payload.days;
  return [{ date: payload.date, events: payload.events }];
}

function collectProposedEvents(slices: CalendarDaySlice[]): CalendarEvent[] {
  return slices.flatMap((s) => s.events).filter((e) => e.type === "proposed");
}

/** 複数の proposed が単一日に集中しているか（修復・警告のトリガー） */
export function isCalendarSingleDayCluster(payload: CalendarPayload): boolean {
  const slices = normalizeCalendarDaySlices(payload);
  const proposed = collectProposedEvents(slices);
  if (proposed.length <= 1) return false;
  const datesWithProposed = new Set(
    slices.filter((s) => s.events.some((e) => e.type === "proposed")).map((s) => s.date),
  );
  return datesWithProposed.size === 1;
}

/** 修復後も残る疑わしい状態（UI 警告用） */
export function isCalendarSingleDayAnomaly(payload: CalendarPayload): boolean {
  if (!isCalendarSingleDayCluster(payload)) return false;
  const proposed = collectProposedEvents(normalizeCalendarDaySlices(payload));
  if (proposed.filter((e) => /第\s*\d+\s*回/.test(e.title)).length >= 2) return true;
  return proposed.length >= 3;
}

/** 日付属性・<date> なしで proposed がある（修復できなかった場合の UI 警告） */
export function isCalendarMissingDateWarning(payload: CalendarPayload): boolean {
  return payload.dateUnresolved === true;
}

function expandWeeklySeries(start: string, count: number): string[] | null {
  const base = new Date(`${start}T12:00:00`);
  if (Number.isNaN(base.getTime()) || count < 2) return null;
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(base);
    d.setDate(d.getDate() + i * 7);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function looksLikeWeeklySeries(proposed: CalendarEvent[]): boolean {
  if (proposed.length < 2) return false;
  if (proposed.filter((e) => /第\s*\d+\s*回/.test(e.title)).length >= 2) return true;
  const slots = new Set(proposed.map((e) => `${e.start}-${e.end}`));
  return slots.size === 1;
}

function rebuildPayload(proposed: CalendarEvent[], dates: string[]): CalendarPayload {
  const dayMap = new Map<string, CalendarEvent[]>();
  proposed.forEach((ev, i) => {
    const d = dates[i]!;
    const prev = dayMap.get(d) ?? [];
    dayMap.set(d, [...prev, ev]);
  });
  const sortedKeys = [...dayMap.keys()].sort();
  const daySlices = sortedKeys.map((date) => ({ date, events: dayMap.get(date)! }));
  return {
    date: daySlices[0]!.date,
    events: daySlices[0]!.events,
    days: daySlices,
  };
}

/**
 * 単一日に誤ってまとまった proposed を、外部から得た日付リストで日ごとに再配分する。
 * repairDates は昇順ユニークの YYYY-MM-DD 配列。
 */
export function repairCalendarPayload(
  payload: CalendarPayload,
  repairDates: string[],
): { payload: CalendarPayload; repaired: boolean } {
  if (!isCalendarSingleDayCluster(payload)) {
    return { payload, repaired: false };
  }

  const slices = normalizeCalendarDaySlices(payload);
  const proposed = collectProposedEvents(slices);
  const uniqueSorted = [...new Set(repairDates.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort();

  let datesToUse: string[] | null = null;

  if (uniqueSorted.length === proposed.length) {
    datesToUse = uniqueSorted;
  } else if (uniqueSorted.length === 1 && proposed.length > 1 && looksLikeWeeklySeries(proposed)) {
    datesToUse = expandWeeklySeries(uniqueSorted[0]!, proposed.length);
  } else if (uniqueSorted.length > proposed.length && proposed.length > 1) {
    // 余分な日付が混ざる場合は先頭 N 件を使用（本文・ユーザー文脈の時系列順を想定）
    datesToUse = uniqueSorted.slice(0, proposed.length);
  }

  if (!datesToUse || datesToUse.length !== proposed.length) {
    return { payload, repaired: false };
  }

  return { payload: rebuildPayload(proposed, datesToUse), repaired: true };
}

/** 応答 XML に明示的なカレンダー日付（`<date>` / `event@date` / ISO start）があるか */
export function calendarXmlHadExplicitDate(raw: string): boolean {
  const re = /<calendar>([\s\S]*?)<\/calendar>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const inner = m[1]!;
    if (/<date\b[^>]*>\s*\d{4}-\d{2}-\d{2}/i.test(inner)) return true;
    if (/<event\b[^>]*\sdate=["']\d{4}-\d{2}-\d{2}/i.test(inner)) return true;
    if (/<event\b[^>]*\sstart=["']\d{4}-\d{2}-\d{2}T/i.test(inner)) return true;
  }
  return false;
}

/**
 * 複数日が単一日に誤ってまとまったときだけ、ユーザー文・本文から得た日付で再配分する。
 * 単発の日付省略やタスク期限など別文脈の日付では推測しない。
 */
export function repairCalendarDates(
  payload: CalendarPayload,
  repairDates: string[],
  options?: { hadExplicitDate?: boolean },
): { payload: CalendarPayload; repaired: boolean } {
  if (options?.hadExplicitDate) return { payload, repaired: false };
  return repairCalendarPayload(payload, repairDates);
}
