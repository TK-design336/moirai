import type { LTMData, LTMEntry, LTMCategory } from "../../types/engine";
import { LTM_POLICY } from "./ltmPolicy";
import { isLTMV1Shape, migrateLTMV1toV2 } from "./migrateLTM";

export const LTM_KEY = "pc-ltm-data";

const LTM_GLOBAL_LIFESPAN_KEY = "pc-ltm-lifespan-days";

function getGlobalLifespanDays(): number {
  return Math.max(0, parseInt(localStorage.getItem(LTM_GLOBAL_LIFESPAN_KEY) ?? "0", 10));
}

function effectiveTtlDays(entry: LTMEntry): number | undefined {
  return entry.ttlDays ?? LTM_POLICY[entry.category].ttlDays;
}

function isEntryExpiredByTtl(entry: LTMEntry, now: number): boolean {
  const ttl = effectiveTtlDays(entry);
  if (ttl == null) return false;
  return now - new Date(entry.lastSeen).getTime() >= ttl * 86_400_000;
}

function isEntryExpiredByGlobal(entry: LTMEntry, globalDays: number, now: number): boolean {
  if (globalDays <= 0) return false;
  return now - new Date(entry.lastSeen).getTime() >= globalDays * 86_400_000;
}

/** Drop expired entries by per-entry/category TTL and optional global age cap; sort by lastSeen desc. */
export function applyTTLAndSort(entries: LTMEntry[]): LTMEntry[] {
  const now = Date.now();
  const globalDays = getGlobalLifespanDays();
  return entries
    .filter((e) => !isEntryExpiredByTtl(e, now) && !isEntryExpiredByGlobal(e, globalDays, now))
    .sort((a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime());
}

export const DEFAULT_LTM: LTMData = {
  entries: [],
  schemaVersion: "2",
};

function normalizeLoaded(raw: unknown): LTMData {
  if (raw != null && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    if (o.schemaVersion === "2") {
      const ent = o.entries;
      return { schemaVersion: "2", entries: Array.isArray(ent) ? (ent as LTMEntry[]) : [] };
    }
    if (Array.isArray(o.entries)) {
      return { schemaVersion: "2", entries: o.entries as LTMEntry[] };
    }
    if (isLTMV1Shape(raw)) {
      return migrateLTMV1toV2(raw);
    }
  }
  return { ...DEFAULT_LTM };
}

function sanitizeLTM(data: LTMData): LTMData {
  const entries = (data.entries ?? [])
    .filter(
      (e) =>
        e != null &&
        typeof e === "object" &&
        typeof (e as LTMEntry).id === "string" &&
        typeof (e as LTMEntry).content === "string" &&
        (e as LTMEntry).content !== "",
    )
    .map((e) => {
      const x = e as LTMEntry;
      const cat = x.category;
      const valid: LTMCategory[] = ["profile", "habit", "task", "decision", "learning"];
      const category = valid.includes(cat) ? cat : "profile";
      return {
        ...x,
        category,
        confirmedCount: typeof x.confirmedCount === "number" && x.confirmedCount >= 0 ? x.confirmedCount : 0,
        status: x.status === "pending" || x.status === "active" ? x.status : "pending",
        createdAt: x.createdAt || new Date().toISOString(),
        lastSeen: x.lastSeen || x.createdAt || new Date().toISOString(),
      } satisfies LTMEntry;
    });

  return {
    schemaVersion: "2",
    entries: applyTTLAndSort(entries),
  };
}

export function loadLTM(): LTMData {
  const raw = localStorage.getItem(LTM_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      const wasV1 = isLTMV1Shape(parsed);
      const data = sanitizeLTM(normalizeLoaded(parsed));
      if (wasV1) saveLTM(data);
      return data;
    } catch {
      /* fall through */
    }
  }
  return { ...DEFAULT_LTM };
}

export function saveLTM(data: LTMData): void {
  localStorage.setItem(
    LTM_KEY,
    JSON.stringify({
      schemaVersion: "2" as const,
      entries: data.entries,
    }),
  );
}

/** Delta rows from LLM extraction (or tests); omit id for brand-new entries. */
export type LTMMergePatch = Pick<LTMEntry, "category" | "content" | "lastSeen"> & {
  id?: string;
  ttlDays?: number;
};

const CATEGORIES: LTMCategory[] = ["profile", "habit", "task", "decision", "learning"];

function normalizeIncomingCategory(raw: unknown): LTMCategory {
  const s = String(raw ?? "");
  return CATEGORIES.includes(s as LTMCategory) ? (s as LTMCategory) : "profile";
}

/**
 * Upsert by id from LLM extraction deltas. New entries get policy default ttlDays when omitted.
 */
export function mergeLTM(existing: LTMData, incoming: LTMMergePatch[]): LTMData {
  const map = new Map(existing.entries.map((e) => [e.id, e]));
  const nowIso = new Date().toISOString();

  for (const item of incoming) {
    const category = normalizeIncomingCategory(item.category);
    const policyTtl = LTM_POLICY[category].ttlDays;

    if (item.id != null && item.id !== "" && map.has(item.id)) {
      const prev = map.get(item.id)!;
      const nextCount = prev.confirmedCount + 1;
      const threshold = LTM_POLICY[prev.category].pendingToActive;
      map.set(item.id, {
        ...prev,
        content: item.content,
        confirmedCount: nextCount,
        lastSeen: item.lastSeen || nowIso,
        status: nextCount >= threshold ? "active" : prev.status,
        ttlDays: item.ttlDays !== undefined ? item.ttlDays : prev.ttlDays,
      });
    } else {
      const id =
        item.id != null && item.id !== "" && !map.has(item.id) ? item.id : crypto.randomUUID();
      const pendingTo = LTM_POLICY[category].pendingToActive;
      const newTtl = item.ttlDays !== undefined ? item.ttlDays : policyTtl;
      const newEntry: LTMEntry = {
        id,
        category,
        content: item.content,
        confirmedCount: 1,
        status: pendingTo <= 1 ? "active" : "pending",
        createdAt: nowIso,
        lastSeen: item.lastSeen || nowIso,
        ttlDays: newTtl,
      };
      map.set(id, newEntry);
    }
  }

  return {
    schemaVersion: "2",
    entries: applyTTLAndSort([...map.values()]),
  };
}

export function selectRelevantLTM(ltm: LTMData): string {
  const active = ltm.entries.filter((e) => e.status === "active");

  const byCategory = (cat: LTMCategory) =>
    active
      .filter((e) => e.category === cat)
      .slice(0, LTM_POLICY[cat].maxActive);

  const sections: string[] = [];

  const profile = byCategory("profile");
  const decisions = byCategory("decision");
  const tasks = byCategory("task");
  const habits = byCategory("habit");
  const learning = byCategory("learning");

  if (profile.length) sections.push(`[Profile]\n${profile.map((e) => `- ${e.content}`).join("\n")}`);
  if (decisions.length) sections.push(`[Decisions]\n${decisions.map((e) => `- ${e.content}`).join("\n")}`);
  if (tasks.length) {
    sections.push(
      `[Past task records]\n` +
        `These lines summarize work or topics already discussed or handled in past sessions. They are background memory — not a to-do list and not instructions you must execute now.\n` +
        `${tasks.map((e) => `- ${e.content}`).join("\n")}`,
    );
  }
  if (habits.length) sections.push(`[Habits]\n${habits.map((e) => `- ${e.content}`).join("\n")}`);
  if (learning.length) sections.push(`[Learning]\n${learning.map((e) => `- ${e.content}`).join("\n")}`);

  return sections.length ? sections.join("\n\n") : "(No relevant LTM)";
}
