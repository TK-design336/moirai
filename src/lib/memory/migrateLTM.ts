import type { LTMData, LTMEntry } from "../../types/engine";

/** Pre-v2 persisted shape (localStorage). Not exported from engine types. */
export interface LTMDataV1 {
  preferences?: { category: string; value: string; updatedAt?: string }[];
  habitLogs?: {
    type: "place" | "product" | "meal" | "person";
    name: string;
    count: number;
    lastSeen: string;
    kind?: string;
    memo?: string;
    lastReference?: string;
  }[];
  learningGraph?: { topic: string; mistakes: string[]; masteredAt?: string; lastReference?: string }[];
  taskHistory?: {
    title: string;
    summary?: string;
    completedAt: string;
    tags: string[];
    lastReference?: string;
  }[];
  decisionLog?: { query: string; chosen: string; at: string; lastReference?: string }[];
  userTraits?: { trait: string; detail: string; observedAt: string }[];
}

function learningContent(g: NonNullable<LTMDataV1["learningGraph"]>[number]): string {
  const topic = (g.topic ?? "").trim();
  const mistakes = (g.mistakes ?? []).filter(Boolean);
  const tail = mistakes.length ? ` よく間違える点: ${mistakes.slice(0, 5).join("；")}` : "";
  return `${topic}${tail}`.trim() || "(learning topic)";
}

export function migrateLTMV1toV2(old: LTMDataV1): LTMData {
  const entries: LTMEntry[] = [];
  const now = new Date().toISOString();

  for (const p of old.preferences ?? []) {
    entries.push({
      id: crypto.randomUUID(),
      category: "profile",
      content: `${p.category}: ${p.value}`,
      confirmedCount: 2,
      status: "active",
      createdAt: now,
      lastSeen: p.updatedAt ?? now,
    });
  }

  for (const t of old.userTraits ?? []) {
    entries.push({
      id: crypto.randomUUID(),
      category: "profile",
      content: `${t.trait}: ${t.detail}`,
      confirmedCount: 2,
      status: "active",
      createdAt: now,
      lastSeen: t.observedAt ?? now,
    });
  }

  for (const h of old.habitLogs ?? []) {
    entries.push({
      id: crypto.randomUUID(),
      category: "habit",
      content: [h.type, h.name, h.kind, h.memo].filter(Boolean).join(" / "),
      confirmedCount: Math.min(h.count, 3),
      status: "active",
      createdAt: now,
      lastSeen: h.lastSeen ?? h.lastReference ?? now,
      ttlDays: 180,
    });
  }

  for (const t of old.taskHistory ?? []) {
    entries.push({
      id: crypto.randomUUID(),
      category: "task",
      content: `${t.title}${t.summary ? ": " + t.summary : ""}`,
      confirmedCount: 1,
      status: "active",
      createdAt: now,
      lastSeen: t.completedAt ?? t.lastReference ?? now,
      ttlDays: 90,
    });
  }

  for (const d of old.decisionLog ?? []) {
    entries.push({
      id: crypto.randomUUID(),
      category: "decision",
      content: `${d.query} → ${d.chosen}`,
      confirmedCount: 1,
      status: "active",
      createdAt: now,
      lastSeen: d.at ?? d.lastReference ?? now,
    });
  }

  for (const g of old.learningGraph ?? []) {
    entries.push({
      id: crypto.randomUUID(),
      category: "learning",
      content: learningContent(g),
      confirmedCount: 1,
      status: "active",
      createdAt: now,
      lastSeen: g.lastReference ?? g.masteredAt ?? now,
    });
  }

  return { schemaVersion: "2", entries };
}

export function isLTMV1Shape(raw: unknown): raw is LTMDataV1 {
  if (raw == null || typeof raw !== "object") return false;
  const o = raw as Record<string, unknown>;
  if (o.schemaVersion === "2" && Array.isArray(o.entries)) return false;
  return (
    Array.isArray(o.preferences) ||
    Array.isArray(o.habitLogs) ||
    Array.isArray(o.learningGraph) ||
    Array.isArray(o.taskHistory) ||
    Array.isArray(o.decisionLog) ||
    Array.isArray(o.userTraits)
  );
}
