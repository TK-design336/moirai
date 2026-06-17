/**
 * Unified console logging for all LLM calls (streaming + callLLMOnce).
 * Request/response logs are always emitted; raw SSE dumps remain behind pc-debug-llm-raw.
 */

import type { StreamDebugSummary } from "./streamDebugMeta";
import { recordLLMUsageFromResponse } from "./usageTracker";

export const TAG_LLM_REQ = "[LLM][REQUEST]";
export const TAG_LLM_RES = "[LLM][RESPONSE]";

export interface LLMTokenCounts {
  input?: number;
  reasoning?: number;
  output?: number;
  total?: number;
}

export interface LLMCostEstimate {
  usd: number | null;
  inputUsd: number | null;
  reasoningUsd: number | null;
  outputUsd: number | null;
  ratesSource: string;
}

/** USD per 1M tokens (approximate list prices; unknown models fall back to provider default). */
type ModelRates = { input: number; output: number; reasoning?: number };

const PROVIDER_DEFAULT_RATES: Record<string, ModelRates> = {
  gpt: { input: 0.15, output: 0.6 },
  "gpt-responses": { input: 0.15, output: 0.6 },
  claude: { input: 0.8, output: 4 },
  gemini: { input: 0.1, output: 0.4 },
};

const MODEL_RATES: Record<string, ModelRates> = {
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4.1": { input: 2, output: 8 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4 },
  "o3": { input: 2, output: 8, reasoning: 8 },
  "o3-mini": { input: 1.1, output: 4.4, reasoning: 4.4 },
  "o4-mini": { input: 1.1, output: 4.4, reasoning: 4.4 },
  "claude-opus-4-6": { input: 15, output: 75 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5-20251001": { input: 0.8, output: 4 },
  "claude-3-5-haiku": { input: 0.8, output: 4 },
  "gemini-2.0-flash": { input: 0.1, output: 0.4 },
  "gemini-2.0-flash-lite": { input: 0.075, output: 0.3 },
  "gemini-2.0-flash-thinking-exp": { input: 0.1, output: 0.4, reasoning: 0.4 },
  "gemini-2.5-flash": { input: 0.15, output: 0.6, reasoning: 0.6 },
  "gemini-2.5-pro": { input: 1.25, output: 10, reasoning: 10 },
};

function resolveModelRates(provider: string, model: string | null | undefined): { rates: ModelRates; source: string } {
  const m = (model ?? "").toLowerCase();
  if (m && MODEL_RATES[m]) {
    return { rates: MODEL_RATES[m]!, source: `model:${m}` };
  }
  for (const [key, rates] of Object.entries(MODEL_RATES)) {
    if (m.startsWith(key) || m.includes(key)) {
      return { rates, source: `prefix:${key}` };
    }
  }
  const prov = provider.replace(/-responses$/, "");
  const fallback = PROVIDER_DEFAULT_RATES[provider] ?? PROVIDER_DEFAULT_RATES[prov] ?? PROVIDER_DEFAULT_RATES.gpt;
  return { rates: fallback, source: `provider-default:${provider}` };
}

export function estimateLLMCostUsd(
  provider: string,
  model: string | null | undefined,
  tokens: LLMTokenCounts,
): LLMCostEstimate {
  const { rates, source } = resolveModelRates(provider, model);
  const inTok = tokens.input ?? 0;
  const reasonTok = tokens.reasoning ?? 0;
  const outTok = tokens.output ?? 0;
  const reasonRate = rates.reasoning ?? rates.output;

  if (inTok === 0 && reasonTok === 0 && outTok === 0) {
    return {
      usd: null,
      inputUsd: null,
      reasoningUsd: null,
      outputUsd: null,
      ratesSource: source,
    };
  }

  const inputUsd = (inTok / 1_000_000) * rates.input;
  const reasoningUsd = (reasonTok / 1_000_000) * reasonRate;
  const outputUsd = (outTok / 1_000_000) * rates.output;

  return {
    usd: inputUsd + reasoningUsd + outputUsd,
    inputUsd,
    reasoningUsd,
    outputUsd,
    ratesSource: source,
  };
}

export function tokenCountsFromStreamSummary(summary: StreamDebugSummary): LLMTokenCounts {
  const { prompt, completion, reasoning, total } = summary.tokens;
  return {
    input: prompt,
    reasoning,
    output: completion,
    total: total ?? (prompt != null && completion != null ? prompt + completion + (reasoning ?? 0) : undefined),
  };
}

export function extractTokenCountsFromOnceResponse(
  provider: "gpt" | "gemini" | "claude",
  data: Record<string, unknown>,
): LLMTokenCounts {
  if (provider === "gpt") {
    const u = data.usage as Record<string, unknown> | undefined;
    if (!u) return {};
    const reasoning =
      (u.completion_tokens_details as { reasoning_tokens?: number } | undefined)?.reasoning_tokens;
    return {
      input: u.prompt_tokens != null ? Number(u.prompt_tokens) : undefined,
      output: u.completion_tokens != null ? Number(u.completion_tokens) : undefined,
      reasoning: reasoning != null ? Number(reasoning) : undefined,
      total: u.total_tokens != null ? Number(u.total_tokens) : undefined,
    };
  }
  if (provider === "claude") {
    const u = data.usage as Record<string, unknown> | undefined;
    if (!u) return {};
    const input = u.input_tokens != null ? Number(u.input_tokens) : undefined;
    const output = u.output_tokens != null ? Number(u.output_tokens) : undefined;
    return {
      input,
      output,
      total: input != null && output != null ? input + output : undefined,
    };
  }
  const u = data.usageMetadata as Record<string, unknown> | undefined;
  if (!u) return {};
  const input = u.promptTokenCount != null ? Number(u.promptTokenCount) : undefined;
  const output =
    u.candidatesTokenCount != null
      ? Number(u.candidatesTokenCount)
      : u.candidatesTokens != null
        ? Number(u.candidatesTokens)
        : undefined;
  const reasoning = u.thoughtsTokenCount != null ? Number(u.thoughtsTokenCount) : undefined;
  const total = u.totalTokenCount != null ? Number(u.totalTokenCount) : undefined;
  return { input, output, reasoning, total };
}

function formatUsd(n: number | null): string {
  if (n == null) return "—";
  if (n < 0.0001) return `$${n.toExponential(2)}`;
  return `$${n.toFixed(6)}`;
}

export function formatTokenUsageForConsole(tokens: LLMTokenCounts, cost: LLMCostEstimate): Record<string, unknown> {
  return {
    input_tokens: tokens.input ?? null,
    reasoning_tokens: tokens.reasoning ?? null,
    output_tokens: tokens.output ?? null,
    total_tokens: tokens.total ?? null,
    estimated_cost_usd: cost.usd != null ? Number(cost.usd.toFixed(8)) : null,
    cost_breakdown_usd: {
      input: cost.inputUsd != null ? Number(cost.inputUsd.toFixed(8)) : null,
      reasoning: cost.reasoningUsd != null ? Number(cost.reasoningUsd.toFixed(8)) : null,
      output: cost.outputUsd != null ? Number(cost.outputUsd.toFixed(8)) : null,
    },
    cost_rates: cost.ratesSource,
    cost_note: "estimated from public list prices (USD); actual billing may differ",
  };
}

export function logLLMConsoleRequest(payload: {
  label: string;
  provider: string;
  model: string;
  system?: string;
  messages?: { role: string; content: string }[];
  requestBody?: unknown;
  extras?: Record<string, unknown>;
}): void {
  const { label, provider, model, system, messages, requestBody, extras } = payload;
  console.groupCollapsed(`${TAG_LLM_REQ} ${label} | ${provider} | ${model}`);
  if (system != null) console.log("system:", system);
  if (messages != null) console.log("messages:", messages);
  if (requestBody != null) console.log("requestBody:", requestBody);
  if (extras && Object.keys(extras).length > 0) console.log("extras:", extras);
  console.groupEnd();
}

export function logLLMConsoleResponse(payload: {
  label: string;
  provider: string;
  model: string | null;
  text?: string;
  status?: number;
  statusText?: string;
  tokens: LLMTokenCounts;
  errorBody?: unknown;
  extras?: Record<string, unknown>;
}): void {
  const { label, provider, model, text, status, statusText, tokens, errorBody, extras } = payload;
  const cost = estimateLLMCostUsd(provider, model, tokens);
  const usageLine = formatTokenUsageForConsole(tokens, cost);

  console.groupCollapsed(`${TAG_LLM_RES} ${label} | ${provider} | ${model ?? "?"}`);
  if (status != null) console.log("http:", status, statusText ?? "");
  if (text !== undefined) console.log("text:", text);
  if (errorBody !== undefined) console.log("errorBody:", errorBody);
  console.log("usage:", usageLine);
  console.log(
    `tokens — input: ${tokens.input ?? "—"}, reasoning: ${tokens.reasoning ?? "—"}, output: ${tokens.output ?? "—"}, total: ${tokens.total ?? "—"} | cost: ${formatUsd(cost.usd)} USD`,
  );
  if (extras && Object.keys(extras).length > 0) console.log("extras:", extras);
  console.groupEnd();

  recordLLMUsageFromResponse({ label, provider, model, tokens });
}
