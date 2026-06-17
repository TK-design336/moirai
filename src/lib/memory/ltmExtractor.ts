import type { ChatMessage, LTMCategory } from "../../types/engine";
import { callLLMOnce, getModelConfig } from "../llm/client";
import { loadLTM, saveLTM, mergeLTM, type LTMMergePatch } from "./ltm";

export const DEFAULT_LTM_PROMPT = `You are a long-term memory builder for a conversational AI concierge.

OBJECTIVE: From the conversation AND current LTM entries, return ONLY the minimal
set of entries needed for satisfying concierge behavior across sessions.

━━ SCHEMA ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[
  {
    "id": "existing UUID to update, or omit for new",
    "category": "profile|habit|task|decision|learning",
    "content": "one or two plain sentences",
    "lastSeen": "ISO8601"
  }
]

━━ CATEGORY ROUTING ━━━━━━━━━━━━━━━━━━━━━━━━━━━
- profile  : stable personality, preferences, skills, constraints
             (combined — do NOT split into separate trait/preference keys)
- habit    : recurring places, activities, or people
- task     : **COMPLETED / HANDLED WORK LOG (retrospective memory only).**
             Store facts about topics the user has already discussed, processed,
             or settled in past turns — e.g. projects they progressed, travel plans
             they firmed up, errands they reported as done.
             **NOT** open to-dos, **NOT** "next steps" the assistant must execute,
             **NOT** imperative checklists that look like commands to the model.
             If something is still pending or requested of the assistant, leave it
             out of \`task\` (or only note the *background* in neutral prose, never
             as an action list for the assistant).
             Write \`content\` as descriptive past/present-background statements
             (third person or neutral), not as "you should…" or numbered duties.
- decision : confirmed choices or standing policies
- learning : topics actively being studied

━━ POLLUTION GUARD ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- One-off emotional reactions or throwaway remarks → NEVER goes to profile
- Role-play or hypothetical content               → store NOTHING
- Unfinished requests to the assistant            → do NOT file under \`task\` as to-dos
- Omit when uncertain. Less is more.

━━ UPDATE RULES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- To update an existing entry: return it with the same "id"
- To add a new entry: omit "id"
- Do NOT return entries that have not changed

━━ OUTPUT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
A single valid JSON array only.
No explanation, no markdown, no code fences.
Return an empty array [] if nothing needs updating.`;

const CATEGORIES: LTMCategory[] = ["profile", "habit", "task", "decision", "learning"];

function toArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

type R = Record<string, unknown>;

function normalizeCategory(raw: unknown): LTMCategory {
  const s = String(raw ?? "").toLowerCase();
  return CATEGORIES.includes(s as LTMCategory) ? (s as LTMCategory) : "profile";
}

function normalizeExtractionItem(raw: unknown): LTMMergePatch | null {
  if (raw == null || typeof raw !== "object") return null;
  const e = raw as R;
  const idRaw = e.id != null && String(e.id).trim() !== "" ? String(e.id).trim() : undefined;
  const content = String(e.content ?? e.text ?? e.summary ?? "").trim();
  if (!content) return null;
  const category = normalizeCategory(e.category ?? e.type);
  const lastSeen = String(
    e.lastSeen ?? e.observedAt ?? e.at ?? e.completedAt ?? e.updatedAt ?? new Date().toISOString(),
  );
  const ttlDays = typeof e.ttlDays === "number" ? e.ttlDays : undefined;

  const patch: LTMMergePatch = { category, content, lastSeen };
  if (idRaw) patch.id = idRaw;
  if (ttlDays !== undefined) patch.ttlDays = ttlDays;
  return patch;
}

function parseExtractionPayload(parsed: unknown): LTMMergePatch[] {
  let arr: unknown[] = [];
  if (Array.isArray(parsed)) {
    arr = parsed;
  } else if (parsed != null && typeof parsed === "object") {
    const o = parsed as R;
    if (Array.isArray(o.entries)) arr = o.entries;
  }
  return arr.map(normalizeExtractionItem).filter((x): x is LTMMergePatch => x != null);
}

/**
 * Extracts long-term memory from a completed session and merges it into the persisted LTM store.
 */
export async function extractAndMergeLTM(
  allMessages: ChatMessage[],
  sessionEndedAt: string,
  provider: "gpt" | "gemini" | "claude",
): Promise<void> {
  if (allMessages.length === 0) return;

  const system = DEFAULT_LTM_PROMPT;
  const cfg = getModelConfig(provider, "ltm");

  const conversationText = allMessages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n");

  const currentLTM = loadLTM();
  const userContent = `Session ended at: ${sessionEndedAt}

Current LTM entries (use "id" to update existing rows; omit "id" only for brand-new facts):
${JSON.stringify(currentLTM.entries, null, 2)}

Conversation:
${conversationText}`;

  const raw = await callLLMOnce(
    provider,
    cfg.model,
    system,
    [{ role: "user", content: userContent }],
    cfg.maxTokens,
    cfg.temperature,
    "ltm-extract",
  );

  const jsonText = raw.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    console.warn("[LTM] Failed to parse LTM extraction response:", jsonText.slice(0, 200));
    return;
  }

  const delta = parseExtractionPayload(parsed);
  if (delta.length === 0) {
    console.groupCollapsed("[LTM] No delta from extraction");
    console.log("Parsed:", parsed);
    console.groupEnd();
    return;
  }

  const existing = loadLTM();
  const merged = mergeLTM(existing, delta);
  saveLTM(merged);
  console.groupCollapsed("[LTM] Updated successfully");
  console.log("Delta:", delta);
  console.log("Merged store:", merged);
  console.groupEnd();
}
