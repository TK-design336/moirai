import type { InboxScheduleRule } from "./scheduleRules";
import {
  consumeInboxScheduleDueRuns,
  ensureAnchorDate,
  getMsUntilNextInboxScheduleWake,
  loadScheduleRules,
  saveScheduleRules,
} from "./scheduleRules";
import {
  consumeDueReminders,
  getMsUntilNextRemindWake,
  hasDueReminders,
  pruneAbandonedReminders,
  type InboxReminder,
} from "./reminders";

export type InboxScheduleRunner = (prompt: string, rule: InboxScheduleRule) => void;
export type InboxReminderDeliverer = (reminder: InboxReminder) => void;

const MIN_WAKE_MS = 250;

let wakeTimeoutId: ReturnType<typeof setTimeout> | null = null;
let bootTimeoutId: ReturnType<typeof setTimeout> | null = null;
let started = false;
let dueCycleRunning = false;

const scheduleRunnerRef: { current: InboxScheduleRunner | null } = { current: null };
const reminderDelivererRef: { current: InboxReminderDeliverer | null } = { current: null };

function clearWake(): void {
  if (wakeTimeoutId != null) {
    clearTimeout(wakeTimeoutId);
    wakeTimeoutId = null;
  }
}

function runDueCycle(): void {
  if (dueCycleRunning) return;
  dueCycleRunning = true;
  try {
    const now = new Date();
    let rules = loadScheduleRules();
    const dueRules = consumeInboxScheduleDueRuns(now);
    const runSchedule = scheduleRunnerRef.current;
    if (runSchedule) {
      for (const rule of dueRules) {
        const updated = ensureAnchorDate(rule);
        if (updated.anchorDate !== rule.anchorDate) {
          rules = rules.map((r) => (r.id === rule.id ? updated : r));
          saveScheduleRules(rules);
        }
        runSchedule(rule.prompt, rule);
      }
    }

    const deliver = reminderDelivererRef.current;
    if (deliver) {
      for (const reminder of consumeDueReminders(now)) {
        deliver(reminder);
      }
    }
  } finally {
    dueCycleRunning = false;
  }
}

function armNextWake(): void {
  clearWake();
  const now = new Date();
  const rules = loadScheduleRules();
  let delay = getMsUntilNextInboxScheduleWake(now, rules);
  const remindDelay = getMsUntilNextRemindWake(now);
  if (remindDelay != null) {
    delay = Math.min(delay, remindDelay);
  } else if (hasDueReminders(now)) {
    delay = Math.min(delay, MIN_WAKE_MS);
  }

  wakeTimeoutId = window.setTimeout(() => {
    wakeTimeoutId = null;
    runDueCycle();
    armNextWake();
  }, delay);
}

function onBecameVisible(): void {
  if (document.visibilityState !== "visible") return;
  runDueCycle();
  armNextWake();
}

function onScheduleRulesChanged(): void {
  runDueCycle();
  armNextWake();
}

function onRemindersChanged(): void {
  armNextWake();
}

function ensureInboxWakeSchedulerStarted(): void {
  if (started) return;
  started = true;
  pruneAbandonedReminders();
  document.addEventListener("visibilitychange", onBecameVisible);
  window.addEventListener("focus", onBecameVisible);
  window.addEventListener("pc-inbox-schedule-rules-changed", onScheduleRulesChanged);
  window.addEventListener("pc-inbox-reminders-changed", onRemindersChanged);
  bootTimeoutId = window.setTimeout(() => {
    bootTimeoutId = null;
    runDueCycle();
    armNextWake();
  }, MIN_WAKE_MS);
}

/**
 * Register handlers and ensure the global Inbox wake loop is running.
 * Handlers are refreshed on each ChatPanel mount; the timer survives layout remounts.
 */
export function registerInboxWakeHandlers(handlers: {
  runSchedule: InboxScheduleRunner;
  deliverReminder: InboxReminderDeliverer;
}): void {
  scheduleRunnerRef.current = handlers.runSchedule;
  reminderDelivererRef.current = handlers.deliverReminder;
  ensureInboxWakeSchedulerStarted();
}

/** Re-arm the wake timer after reminders are persisted. */
export function kickInboxWakeScheduler(): void {
  if (!started) return;
  armNextWake();
}
