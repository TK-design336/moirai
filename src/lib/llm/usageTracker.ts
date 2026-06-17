/**
 * LLM usage & estimated cost tracking (last 30 days).
 * Persists to localStorage for UI and appends JSONL to an external log file (Tauri).
 */

import { invoke } from "@tauri-apps/api/core";
import {
  estimateLLMCostUsd,
  type LLMTokenCounts,
} from "./llmConsoleLog";

declare const __IS_TAURI__: boolean;

export const LLM_USAGE_RETENTION_DAYS = 30;
export const LLM_USAGE_CHANGED_EVENT = "pc-llm-usage-changed";
const STORAGE_ENTRIES = "pc-llm-usage-entries";
const BROWSER_JSONL_KEY = "pc-llm-usage-jsonl";

export type LLMUsageProvider = "gpt" | "gemini" | "claude";

export interface LLMUsageRecord {
  ts: string;
  label: string;
  provider: LLMUsageProvider;
  model: string;
  tokens: LLMTokenCounts;
  costUsd: number | null;
}

export interface LLMUsageProviderTotals {
  calls: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export interface LLMUsageLabelBreakdown {
  label: string;
  displayLabel: string;
  calls: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export interface LLMUsageProviderSummary {
  totals: LLMUsageProviderTotals;
  byLabel: LLMUsageLabelBreakdown[];
}

export interface LLMUsageSummary {
  total: LLMUsageProviderTotals;
  gpt: LLMUsageProviderSummary;
  gemini: LLMUsageProviderSummary;
  claude: LLMUsageProviderSummary;
  periodDays: number;
  entryCount: number;
}

const USAGE_LABEL_DISPLAY: Record<string, string> = {
  chat: "通常応答",
  "chat-stream": "通常応答",
  "hub-meta-judge": "Hub meta judge",
  "stm-compress": "STM 圧縮",
  "hub-chunk-stm": "Hub STM",
  "ltm-extract": "LTM 抽出",
  router: "Router",
  "draft-rewrite": "ドラフト修正",
  "hub-chunk-title": "Hub チャンクタイトル",
  "session-title": "セッションタイトル",
  "llm-once": "その他",
};

export function formatUsageLabelDisplay(label: string): string {
  return USAGE_LABEL_DISPLAY[label] ?? label;
}

const EMPTY_TOTALS = (): LLMUsageProviderTotals => ({
  calls: 0,
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
});

function retentionCutoffMs(): number {
  return Date.now() - LLM_USAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
}

export function normalizeUsageProvider(provider: string): LLMUsageProvider | null {
  const p = provider.toLowerCase().replace(/-responses$/, "");
  if (p === "gpt" || p === "openai") return "gpt";
  if (p === "gemini" || p === "google") return "gemini";
  if (p === "claude" || p === "anthropic") return "claude";
  return null;
}

function loadEntriesRaw(): LLMUsageRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_ENTRIES);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is LLMUsageRecord =>
        e != null
        && typeof e === "object"
        && typeof (e as LLMUsageRecord).ts === "string"
        && typeof (e as LLMUsageRecord).provider === "string",
    );
  } catch {
    return [];
  }
}

function saveEntries(entries: LLMUsageRecord[]): void {
  try {
    localStorage.setItem(STORAGE_ENTRIES, JSON.stringify(entries));
  } catch {
    /* quota */
  }
}

function pruneEntries(entries: LLMUsageRecord[]): LLMUsageRecord[] {
  const cutoff = retentionCutoffMs();
  return entries.filter((e) => {
    const t = Date.parse(e.ts);
    return Number.isFinite(t) && t >= cutoff;
  });
}

function emitUsageChanged(): void {
  window.dispatchEvent(new CustomEvent(LLM_USAGE_CHANGED_EVENT));
}

function appendBrowserJsonlLine(line: string): void {
  try {
    const prev = localStorage.getItem(BROWSER_JSONL_KEY) ?? "";
    const next = prev ? `${prev}\n${line}` : line;
    localStorage.setItem(BROWSER_JSONL_KEY, next);
  } catch {
    /* quota */
  }
}

async function appendExternalLogLine(record: LLMUsageRecord): Promise<void> {
  const line = JSON.stringify({
    ts: record.ts,
    label: record.label,
    provider: record.provider,
    model: record.model,
    tokens: record.tokens,
    cost_usd: record.costUsd,
  });

  if (typeof __IS_TAURI__ !== "undefined" && __IS_TAURI__) {
    try {
      await invoke("llm_usage_append", { line });
      return;
    } catch (err) {
      console.warn("[LLM usage] external log append failed:", err);
    }
  }
  appendBrowserJsonlLine(line);
}

export function recordLLMUsageFromResponse(payload: {
  label: string;
  provider: string;
  model: string | null;
  tokens: LLMTokenCounts;
}): void {
  const normalized = normalizeUsageProvider(payload.provider);
  if (!normalized) return;

  const cost = estimateLLMCostUsd(payload.provider, payload.model, payload.tokens);
  const record: LLMUsageRecord = {
    ts: new Date().toISOString(),
    label: payload.label,
    provider: normalized,
    model: payload.model ?? "?",
    tokens: { ...payload.tokens },
    costUsd: cost.usd,
  };

  const entries = pruneEntries([...loadEntriesRaw(), record]);
  saveEntries(entries);
  emitUsageChanged();
  void appendExternalLogLine(record);
}

function foldEntry(totals: LLMUsageProviderTotals, entry: LLMUsageRecord): void {
  totals.calls += 1;
  totals.costUsd += entry.costUsd ?? 0;
  totals.inputTokens += entry.tokens.input ?? 0;
  totals.outputTokens += entry.tokens.output ?? 0;
  totals.reasoningTokens += entry.tokens.reasoning ?? 0;
}

function emptyProviderSummary(): LLMUsageProviderSummary {
  return { totals: EMPTY_TOTALS(), byLabel: [] };
}

function foldLabelEntry(
  map: Map<string, LLMUsageLabelBreakdown>,
  entry: LLMUsageRecord,
): void {
  const displayLabel = formatUsageLabelDisplay(entry.label);
  let row = map.get(displayLabel);
  if (!row) {
    row = {
      label: entry.label,
      displayLabel,
      calls: 0,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    };
    map.set(displayLabel, row);
  }
  row.calls += 1;
  row.costUsd += entry.costUsd ?? 0;
  row.inputTokens += entry.tokens.input ?? 0;
  row.outputTokens += entry.tokens.output ?? 0;
  row.reasoningTokens += entry.tokens.reasoning ?? 0;
}

function finalizeByLabel(map: Map<string, LLMUsageLabelBreakdown>): LLMUsageLabelBreakdown[] {
  return [...map.values()].sort((a, b) => {
    if (b.costUsd !== a.costUsd) return b.costUsd - a.costUsd;
    return b.calls - a.calls;
  });
}

export function getLLMUsageSummary(): LLMUsageSummary {
  const entries = pruneEntries(loadEntriesRaw());
  const summary: LLMUsageSummary = {
    total: EMPTY_TOTALS(),
    gpt: emptyProviderSummary(),
    gemini: emptyProviderSummary(),
    claude: emptyProviderSummary(),
    periodDays: LLM_USAGE_RETENTION_DAYS,
    entryCount: entries.length,
  };

  const labelMaps: Record<LLMUsageProvider, Map<string, LLMUsageLabelBreakdown>> = {
    gpt: new Map(),
    gemini: new Map(),
    claude: new Map(),
  };

  for (const entry of entries) {
    foldEntry(summary.total, entry);
    foldEntry(summary[entry.provider].totals, entry);
    foldLabelEntry(labelMaps[entry.provider], entry);
  }

  for (const provider of ["gpt", "gemini", "claude"] as const) {
    summary[provider].byLabel = finalizeByLabel(labelMaps[provider]);
  }

  return summary;
}

export function formatLLMCostUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value === 0) return "$0.00";
  if (value < 0.0001) return `$${value.toExponential(2)}`;
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

let cachedLogPath: string | null = null;

export async function fetchLLMUsageLogPath(): Promise<string | null> {
  if (cachedLogPath) return cachedLogPath;
  if (typeof __IS_TAURI__ === "undefined" || !__IS_TAURI__) {
    return "llm-usage.jsonl (browser / localStorage)";
  }
  try {
    cachedLogPath = await invoke<string>("llm_usage_log_path");
    return cachedLogPath;
  } catch {
    return null;
  }
}

export async function revealLLMUsageLog(): Promise<void> {
  if (typeof __IS_TAURI__ !== "undefined" && __IS_TAURI__) {
    const path = await fetchLLMUsageLogPath();
    if (!path) return;
    try {
      const opener = await import("@tauri-apps/plugin-opener");
      await (opener as unknown as { revealItemInDir: (p: string) => Promise<void> }).revealItemInDir(path);
    } catch (err) {
      console.warn("[LLM usage] reveal log failed:", err);
    }
    return;
  }

  try {
    const content = localStorage.getItem(BROWSER_JSONL_KEY) ?? "";
    const blob = new Blob([content], { type: "application/x-ndjson;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "llm-usage.jsonl";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err) {
    console.warn("[LLM usage] download log failed:", err);
  }
}
