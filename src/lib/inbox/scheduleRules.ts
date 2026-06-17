import type { TaskKind } from "../../types/engine";

export type ScheduleUnit = "day" | "week" | "month";

export interface InboxScheduleRule {
  id: string;
  enabled: boolean;
  interval: number;
  unit: ScheduleUnit;
  dayOfWeek?: number;
  daysOfWeek?: number[];
  occurrenceOfMonth?: number;
  time: string;
  dayTimes?: Record<number, string>;
  prompt: string;
  /** @deprecated Use taskKinds. Kept for backward compat. */
  taskKind?: TaskKind;
  taskKinds?: TaskKind[];
  taskKindOffsetDays?: number;
  anchorDate?: string;
}

const STORAGE_KEY = "pc-inbox-schedule-rules";

/** 定刻を少し過ぎてから復帰したときの取りこぼし補償（同一日・同一スロットのみ） */
const GRACE_AFTER_MS = 5 * 60 * 1000;

const MAX_SCAN_DAYS = 800;
/** 次回 wake の上限（ルール変更の反映・setTimeout の安全上限） */
export const INBOX_SCHEDULE_MAX_WAKE_MS = Math.min(24 * 60 * 60 * 1000, 2147483647 - 1);

const FIRED_SLOTS_KEY = "pc-inbox-schedule-fired-slots";

const LAST_RUN_KEY = "pc-inbox-schedule-last-run";

export function loadScheduleRules(): InboxScheduleRule[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return [];
}

export function saveScheduleRules(rules: InboxScheduleRule[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(rules));
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("pc-inbox-schedule-rules-changed"));
  }
}

function getTargetMinutes(rule: InboxScheduleRule, dow: number): number {
  const t = rule.dayTimes?.[dow] ?? rule.time;
  const [h, m] = t.split(":").map((x) => parseInt(x, 10));
  return (h ?? 0) * 60 + (m ?? 0);
}

function formatLocalYmd(d: Date): string {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${day}`;
}

function formatHmFromTotalMinutes(totalMins: number): string {
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function makeSlotKey(ruleId: string, calDay: Date, totalMins: number): string {
  return `${ruleId}\x1f${formatLocalYmd(calDay)}\x1f${formatHmFromTotalMinutes(totalMins)}`;
}

function isNthWeekdayOfMonth(date: Date, n: number, targetDow: number): boolean {
  const first = new Date(date.getFullYear(), date.getMonth(), 1);
  let count = 0;
  let d = new Date(first);
  while (d.getMonth() === first.getMonth()) {
    if (d.getDay() === targetDow) {
      count++;
      if (count === n && d.getDate() === date.getDate()) return true;
    }
    d.setDate(d.getDate() + 1);
  }
  return false;
}

/** そのローカル日がカレンダー条件に合うか（時刻は見ない） */
export function dayMatchesRuleCalendar(rule: InboxScheduleRule, calDay: Date): boolean {
  if (!rule.enabled) return false;

  const today = new Date(calDay.getFullYear(), calDay.getMonth(), calDay.getDate());
  const dow = today.getDay();
  const anchor = rule.anchorDate ? new Date(rule.anchorDate) : today;
  anchor.setHours(0, 0, 0, 0);

  if (rule.unit === "day") {
    const daysSince = Math.floor((today.getTime() - anchor.getTime()) / (24 * 60 * 60 * 1000));
    return daysSince >= 0 && daysSince % rule.interval === 0;
  }

  if (rule.unit === "week") {
    const targetDows = rule.daysOfWeek?.length ? rule.daysOfWeek : rule.dayOfWeek !== undefined ? [rule.dayOfWeek] : [];
    if (!targetDows.includes(dow)) return false;
    const weeksSince = Math.floor((today.getTime() - anchor.getTime()) / (7 * 24 * 60 * 60 * 1000));
    return weeksSince >= 0 && weeksSince % rule.interval === 0;
  }

  if (rule.unit === "month") {
    const occ = rule.occurrenceOfMonth ?? 1;
    const targetDow = rule.dayOfWeek ?? 0;
    if (!isNthWeekdayOfMonth(today, occ, targetDow)) return false;
    const monthsSince = (today.getFullYear() - anchor.getFullYear()) * 12 + (today.getMonth() - anchor.getMonth());
    return monthsSince >= 0 && monthsSince % rule.interval === 0;
  }

  return false;
}

function scheduledInstantOnCalendarDay(calDay: Date, rule: InboxScheduleRule): Date {
  const dow = calDay.getDay();
  const mins = getTargetMinutes(rule, dow);
  const h = Math.floor(mins / 60);
  const mi = mins % 60;
  return new Date(calDay.getFullYear(), calDay.getMonth(), calDay.getDate(), h, mi, 0, 0);
}

function sameLocalHourMinute(a: Date, b: Date): boolean {
  return a.getHours() === b.getHours() && a.getMinutes() === b.getMinutes();
}

let firedSlotsCache: Set<string> | null = null;

function pruneFiredSlots(set: Set<string>): void {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 200);
  const cutoffStr = formatLocalYmd(cutoff);
  for (const s of [...set]) {
    const parts = s.split("\x1f");
    const ymd = parts[1];
    if (ymd && ymd < cutoffStr) set.delete(s);
  }
  if (set.size > 600) {
    const sorted = [...set].sort();
    sorted.slice(0, sorted.length - 500).forEach((k) => set.delete(k));
  }
}

function loadFiredSlots(): Set<string> {
  if (firedSlotsCache) return firedSlotsCache;
  firedSlotsCache = new Set<string>();
  try {
    const raw = localStorage.getItem(FIRED_SLOTS_KEY);
    if (raw) {
      const arr = JSON.parse(raw) as string[];
      for (const s of arr) firedSlotsCache.add(s);
    }
  } catch {}
  pruneFiredSlots(firedSlotsCache);
  return firedSlotsCache;
}

function persistFiredSlots(): void {
  if (!firedSlotsCache) return;
  pruneFiredSlots(firedSlotsCache);
  localStorage.setItem(FIRED_SLOTS_KEY, JSON.stringify([...firedSlotsCache]));
}

function markSlotFired(slotKey: string): void {
  const set = loadFiredSlots();
  set.add(slotKey);
  pruneFiredSlots(set);
  persistFiredSlots();
}

function isSlotFired(slotKey: string): boolean {
  return loadFiredSlots().has(slotKey);
}

/**
 * Returns true when local clock hour/minute matches the rule's configured time for that day.
 */
export function shouldRunRule(rule: InboxScheduleRule, now: Date): boolean {
  if (!rule.enabled) return false;

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dow = today.getDay();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const targetMinutes = getTargetMinutes(rule, dow);
  if (nowMinutes !== targetMinutes) return false;

  return dayMatchesRuleCalendar(rule, today);
}

function loadLastRunMap(): Map<string, number> {
  try {
    const raw = localStorage.getItem(LAST_RUN_KEY);
    if (raw) {
      const obj = JSON.parse(raw) as Record<string, number>;
      return new Map(Object.entries(obj));
    }
  } catch {}
  return new Map();
}

function saveLastRunMap(map: Map<string, number>): void {
  const obj = Object.fromEntries(map);
  localStorage.setItem(LAST_RUN_KEY, JSON.stringify(obj));
}

const lastRunMap = loadLastRunMap();

export function markRuleRun(ruleId: string): void {
  lastRunMap.set(ruleId, Date.now());
  saveLastRunMap(lastRunMap);
}

export function ensureAnchorDate(rule: InboxScheduleRule): InboxScheduleRule {
  if (rule.anchorDate) return rule;
  const today = new Date().toISOString().slice(0, 10);
  return { ...rule, anchorDate: today };
}

/**
 * `after` より後に来る最初の発火時刻（ローカル・秒は 0）。
 */
export function findNextInboxScheduleFireAfter(rule: InboxScheduleRule, after: Date): Date | null {
  if (!rule.enabled) return null;
  const afterTs = after.getTime();
  for (let d = 0; d < MAX_SCAN_DAYS; d++) {
    const day = new Date(after.getFullYear(), after.getMonth(), after.getDate() + d);
    if (!dayMatchesRuleCalendar(rule, day)) continue;
    const inst = scheduledInstantOnCalendarDay(day, rule);
    if (inst.getTime() > afterTs) return inst;
  }
  return null;
}

/**
 * 次のタイマーまでの遅延（ms）。有効ルールが無いときは 1 時間。
 */
export function getMsUntilNextInboxScheduleWake(now: Date, rulesParam?: InboxScheduleRule[]): number {
  const rules = rulesParam ?? loadScheduleRules();
  let minDelay = 60 * 60 * 1000;
  for (const rule of rules) {
    if (!rule.enabled || !rule.prompt.trim()) continue;
    const next = findNextInboxScheduleFireAfter(rule, now);
    if (next) {
      const d = next.getTime() - now.getTime();
      if (d > 0 && d < minDelay) minDelay = d;
    }
  }
  return Math.max(250, Math.min(minDelay, INBOX_SCHEDULE_MAX_WAKE_MS));
}

/**
 * いま発火すべきルールをまとめて返し、スロット済みマークと lastRun を記録する（二重実行防止）。
 * 取りこぼし: 同一ローカル日内で、定刻から GRACE 以内に復帰したときのみ。
 */
export function consumeInboxScheduleDueRuns(now: Date): InboxScheduleRule[] {
  const rules = loadScheduleRules();
  const due: InboxScheduleRule[] = [];
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  for (const rule of rules) {
    if (!rule.enabled || !rule.prompt.trim()) continue;
    if (!dayMatchesRuleCalendar(rule, todayStart)) continue;

    const at = scheduledInstantOnCalendarDay(todayStart, rule);
    const slotKey = makeSlotKey(rule.id, todayStart, getTargetMinutes(rule, todayStart.getDay()));
    if (isSlotFired(slotKey)) continue;

    if (now.getTime() < at.getTime()) continue;

    const lateMs = now.getTime() - at.getTime();
    const onTimeMinute = sameLocalHourMinute(now, at);
    if (!onTimeMinute && lateMs > GRACE_AFTER_MS) continue;

    markSlotFired(slotKey);
    markRuleRun(rule.id);
    due.push(rule);
  }

  return due;
}
