import type { RemindPayload } from "../../types/engine";

export interface InboxReminder {
  id: string;
  fireAt: string;
  content: string;
  createdAt: string;
}

const STORAGE_KEY = "pc-inbox-reminders";

/** Min delay for wake timer (align with schedule rules). */
const MIN_WAKE_MS = 250;

/** Do not schedule closer than this (avoids instant fire from LLM clock skew). */
export const MIN_SCHEDULE_LEAD_MS = 2_000;

/** When LLM absolute <time> is already past, schedule this far ahead instead. */
export const REMIND_DEFAULT_DELAY_MS = 60_000;

/** Abandoned entries older than this are purged on load/schedule (no delivery). */
const ABANDONED_AGE_MS = 60 * 60 * 1000;

export const INBOX_REMIND_MAX_WAKE_MS = 24 * 60 * 60 * 1000;

function notifyChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("pc-inbox-reminders-changed"));
  }
}

export function loadReminders(): InboxReminder[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const arr = JSON.parse(raw) as InboxReminder[];
      if (Array.isArray(arr)) return arr.sort((a, b) => a.fireAt.localeCompare(b.fireAt));
    }
  } catch {}
  return [];
}

/** Remove a pending one-shot reminder by id (no Inbox delivery). */
export function deleteReminderById(id: string): void {
  const all = loadReminders();
  const next = all.filter((r) => r.id !== id);
  if (next.length !== all.length) {
    persistReminders(next);
  }
}

function persistReminders(items: InboxReminder[], notify = true): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  if (notify) notifyChanged();
}

/** Persist the full reminder list (sorted by fireAt). */
export function saveReminders(items: InboxReminder[]): void {
  const sorted = [...items].sort((a, b) => a.fireAt.localeCompare(b.fireAt));
  persistReminders(sorted);
}

/** Drop entries that were due more than ABANDONED_AGE_MS ago (no Inbox delivery). */
export function pruneAbandonedReminders(now: Date = new Date()): void {
  const nowTs = now.getTime();
  const abandonedCutoff = nowTs - ABANDONED_AGE_MS;
  const all = loadReminders();
  const remaining = all.filter((r) => {
    const ts = new Date(r.fireAt).getTime();
    if (Number.isNaN(ts)) return false;
    return !(ts <= nowTs && ts < abandonedCutoff);
  });
  if (remaining.length !== all.length) {
    saveReminders(remaining);
  }
}

/** Drop all past-due rows without delivering (used when scheduling a new remind). */
export function dropPastDueRemindersWithoutDelivery(now: Date = new Date()): void {
  const nowTs = now.getTime();
  const all = loadReminders();
  const remaining = all.filter((r) => {
    const ts = new Date(r.fireAt).getTime();
    return Number.isNaN(ts) || ts > nowTs;
  });
  if (remaining.length !== all.length) {
    saveReminders(remaining);
  }
}

function normalizePayloads(data: RemindPayload | RemindPayload[]): RemindPayload[] {
  return Array.isArray(data) ? data : [data];
}

/** Persist one-shot reminders from parsed LLM output. */
export function scheduleRemindersFromParsed(data: RemindPayload | RemindPayload[]): void {
  const payloads = normalizePayloads(data);
  if (payloads.length === 0) return;

  const now = new Date();
  const nowTs = now.getTime();
  dropPastDueRemindersWithoutDelivery(now);
  pruneAbandonedReminders(now);

  let existing = loadReminders();
  const nowIso = now.toISOString();
  const added: InboxReminder[] = [];

  for (const p of payloads) {
    const d = new Date(p.fireAt);
    if (Number.isNaN(d.getTime()) || !p.content.trim()) continue;

    let fireTs = d.getTime();
    if (fireTs < nowTs) {
      fireTs = nowTs + REMIND_DEFAULT_DELAY_MS;
    } else if (fireTs < nowTs + MIN_SCHEDULE_LEAD_MS) {
      fireTs = nowTs + MIN_SCHEDULE_LEAD_MS;
    }

    const content = p.content.trim();

    added.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      fireAt: new Date(fireTs).toISOString(),
      content,
      createdAt: nowIso,
    });
  }

  if (added.length === 0) return;
  existing = [...existing, ...added];
  saveReminders(existing);
}

/**
 * Returns reminders due at or before `now`, removes them from storage (one-shot).
 */
export function consumeDueReminders(now: Date): InboxReminder[] {
  const all = loadReminders();
  const nowTs = now.getTime();
  const due: InboxReminder[] = [];
  const remaining: InboxReminder[] = [];

  for (const r of all) {
    const ts = new Date(r.fireAt).getTime();
    if (!Number.isNaN(ts) && ts <= nowTs) due.push(r);
    else remaining.push(r);
  }

  if (due.length > 0) {
    saveReminders(remaining);
  }
  return due;
}

export function hasDueReminders(now: Date, remindersParam?: InboxReminder[]): boolean {
  const nowTs = now.getTime();
  const reminders = remindersParam ?? loadReminders();
  return reminders.some((r) => {
    const ts = new Date(r.fireAt).getTime();
    return !Number.isNaN(ts) && ts <= nowTs;
  });
}

/** Ms until the next pending reminder, or null if none scheduled. */
export function getMsUntilNextRemindWake(now: Date, remindersParam?: InboxReminder[]): number | null {
  const reminders = remindersParam ?? loadReminders();
  const nowTs = now.getTime();
  let minDelay: number | null = null;

  for (const r of reminders) {
    const ts = new Date(r.fireAt).getTime();
    if (Number.isNaN(ts)) continue;
    const d = ts - nowTs;
    if (d <= 0) continue;
    if (minDelay === null || d < minDelay) minDelay = d;
  }

  if (minDelay === null) return null;
  return Math.max(MIN_WAKE_MS, Math.min(minDelay, INBOX_REMIND_MAX_WAKE_MS));
}
