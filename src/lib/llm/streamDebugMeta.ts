/**
 * Structured LLM stream summaries + console logging.
 * Request/response logs are always emitted (see llmConsoleLog.ts).
 * Raw SSE chunk dumps: pc-debug-llm-raw === "true"
 */

import {
  estimateLLMCostUsd,
  formatTokenUsageForConsole,
  logLLMConsoleRequest,
  logLLMConsoleResponse,
  tokenCountsFromStreamSummary,
} from "./llmConsoleLog";

export interface StreamDebugSummary {
  provider: string;
  model: string | null;
  tokens: {
    prompt?: number;
    completion?: number;
    reasoning?: number;
    total?: number;
  };
  finishReason: string | null;
  toolCallsOccurred: boolean;
  toolCalls: { name: string; id?: string; arguments?: unknown }[];
  providerExtras: Record<string, unknown>;
}

export function shouldLogLLMStreamDebug(): boolean {
  try {
    return localStorage.getItem("pc-debug-llm-raw") === "true"
      || localStorage.getItem("pc-debug-llm-meta") === "true";
  } catch {
    return false;
  }
}

export function logDebugLLMRequest(payload: {
  label?: string;
  provider: string;
  model: string;
  /** Exact object passed to JSON.stringify for the HTTP body (not SDK-transformed; this app uses fetch). */
  requestBody: unknown;
  bodySource: "exact_json_stringify_before_fetch";
  extras?: Record<string, unknown>;
}): void {
  const { label = "chat-stream", provider, model, requestBody, bodySource, extras } = payload;
  logLLMConsoleRequest({
    label,
    provider,
    model,
    requestBody,
    extras: { bodySource, ...(extras ?? {}) },
  });
}

export function logDebugLLMResponse(summary: StreamDebugSummary, options?: { label?: string }): void {
  const label = options?.label ?? "chat-stream";
  const tokens = tokenCountsFromStreamSummary(summary);
  const cost = estimateLLMCostUsd(summary.provider, summary.model, tokens);
  logLLMConsoleResponse({
    label,
    provider: summary.provider,
    model: summary.model,
    tokens,
    extras: {
      finishReason: summary.finishReason,
      toolCallsOccurred: summary.toolCallsOccurred,
      toolCalls: summary.toolCalls,
      providerExtras: summary.providerExtras,
      usage: formatTokenUsageForConsole(tokens, cost),
    },
  });
}

/* ---- OpenAI Chat Completions stream ---- */

type OpenAIChatUsageChunk = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
};

export function summarizeOpenAIChatStream(rawChunks: string[]): StreamDebugSummary {
  let model: string | null = null;
  let finishReason: string | null = null;
  let usage: OpenAIChatUsageChunk | null = null;

  const toolAcc = new Map<number, { id?: string; name?: string; args: string }>();

  for (const raw of rawChunks) {
    if (raw === "[DONE]") continue;
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }
    const u = j.usage as OpenAIChatUsageChunk | undefined;
    if (u && typeof u === "object") usage = u;

    const m = j.model as string | undefined;
    if (m) model = m;

    const choice = (j.choices as Record<string, unknown>[] | undefined)?.[0] as Record<string, unknown> | undefined;
    if (!choice) continue;

    const fr = choice.finish_reason as string | null | undefined;
    if (fr != null && fr !== "") finishReason = fr;

    const delta = choice.delta as Record<string, unknown> | undefined;
    const tcs = delta?.tool_calls as Record<string, unknown>[] | undefined;
    if (tcs && Array.isArray(tcs)) {
      for (const tc of tcs) {
        const idx = typeof tc.index === "number" ? tc.index : 0;
        const cur = toolAcc.get(idx) ?? { args: "" };
        const id = (tc.id as string | undefined) ?? cur.id;
        const fn = tc.function as Record<string, unknown> | undefined;
        const name = (fn?.name as string | undefined) ?? cur.name;
        const argChunk = (fn?.arguments as string | undefined) ?? "";
        toolAcc.set(idx, { id, name, args: cur.args + argChunk });
      }
    }
  }

  const reasoning = usage?.completion_tokens_details?.reasoning_tokens;
  const toolCalls: { name: string; id?: string; arguments?: unknown }[] = [];
  for (const [, v] of [...toolAcc.entries()].sort((a, b) => a[0] - b[0])) {
    if (!v.name) continue;
    let args: unknown = v.args;
    if (v.args.trim()) {
      try {
        args = JSON.parse(v.args);
      } catch {
        args = v.args;
      }
    }
    toolCalls.push({ name: v.name, id: v.id, arguments: args });
  }

  return {
    provider: "gpt",
    model,
    tokens: {
      prompt: usage?.prompt_tokens,
      completion: usage?.completion_tokens,
      reasoning,
      total: usage?.total_tokens,
    },
    finishReason,
    toolCallsOccurred: toolCalls.length > 0,
    toolCalls,
    providerExtras: {
      reasoning_tokens_from_usage: reasoning ?? null,
      usage_completion_tokens_details: usage?.completion_tokens_details ?? null,
      usageRaw: usage,
      streamChunksParsed: rawChunks.filter((r) => r !== "[DONE]").length,
    },
  };
}

/* ---- OpenAI Responses API stream ---- */

export function summarizeOpenAIResponsesStream(rawChunks: string[]): StreamDebugSummary {
  let model: string | null = null;
  let usage: Record<string, unknown> | null = null;
  let finishReason: string | null = null;
  const toolCalls: { name: string; id?: string; arguments?: unknown }[] = [];

  for (const raw of rawChunks) {
    if (raw === "[DONE]") continue;
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }

    const t = j.type as string | undefined;
    if (t === "response.completed") {
      const resp = j.response as Record<string, unknown> | undefined;
      if (resp?.model) model = String(resp.model);
      const u = resp?.usage as Record<string, unknown> | undefined;
      if (u && typeof u === "object") usage = u;
      const status = resp?.status as string | undefined;
      if (status) finishReason = finishReason ?? status;
    }
    if (t === "response.created") {
      const resp = j.response as Record<string, unknown> | undefined;
      if (resp?.model) model = String(resp.model);
    }
    if (t?.startsWith("response.") && j.usage && typeof j.usage === "object") {
      usage = j.usage as Record<string, unknown>;
    }

    // Tool / function calls in output (best-effort; event names vary by API version)
    if (
      t === "response.output_item.done"
      || t === "response.output_item.added"
      || t === "response.function_call_arguments.done"
    ) {
      const item = (j.item ?? j.output_item) as Record<string, unknown> | undefined;
      const itemType = item?.type as string | undefined;
      if (itemType === "web_search_call") {
        toolCalls.push({ name: "web_search", id: item?.id as string | undefined, arguments: item });
      } else {
        const name = item?.name as string | undefined;
        if (name) {
          let args: unknown = item?.arguments ?? item?.input;
          if (typeof args === "string") {
            try {
              args = JSON.parse(args);
            } catch {
              /* keep string */
            }
          }
          toolCalls.push({ name, id: item?.id as string | undefined, arguments: args });
        }
      }
    }
  }

  const inputTok = usage?.input_tokens != null ? Number(usage.input_tokens) : undefined;
  const outTok = usage?.output_tokens != null ? Number(usage.output_tokens) : undefined;
  const reasoning =
    usage?.output_tokens_details && typeof usage.output_tokens_details === "object"
      ? (usage.output_tokens_details as Record<string, unknown>).reasoning_tokens != null
        ? Number((usage.output_tokens_details as Record<string, unknown>).reasoning_tokens)
        : undefined
      : undefined;
  const totalTok =
    usage?.total_tokens != null
      ? Number(usage.total_tokens)
      : inputTok != null && outTok != null
        ? inputTok + outTok
        : undefined;

  return {
    provider: "gpt-responses",
    model,
    tokens: {
      prompt: inputTok,
      completion: outTok,
      reasoning,
      total: totalTok,
    },
    finishReason,
    toolCallsOccurred: toolCalls.length > 0,
    toolCalls,
    providerExtras: {
      usage_output_tokens_details: usage?.output_tokens_details ?? null,
      usageRaw: usage,
      responseCompletedSeen: rawChunks.some((r) => {
        try {
          return (JSON.parse(r) as { type?: string }).type === "response.completed";
        } catch {
          return false;
        }
      }),
    },
  };
}

/* ---- Anthropic Messages stream ---- */

export function summarizeClaudeStream(rawChunks: string[]): StreamDebugSummary {
  let model: string | null = null;
  let finishReason: string | null = null;
  let lastUsage: Record<string, unknown> | null = null;

  const toolByIndex = new Map<number, { type: string; name?: string; id?: string }>();
  const jsonAcc = new Map<number, string>();

  for (const raw of rawChunks) {
    if (raw === "[DONE]") continue;
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }

    const t = j.type as string | undefined;
    if (t === "message_start") {
      const msg = j.message as Record<string, unknown> | undefined;
      if (msg?.model) model = String(msg.model);
      const u = msg?.usage as Record<string, unknown> | undefined;
      if (u && typeof u === "object") lastUsage = u;
    }
    if (t === "message_delta") {
      const d = j.delta as Record<string, unknown> | undefined;
      const sr = d?.stop_reason as string | undefined;
      if (sr != null) finishReason = sr;
      const u = j.usage as Record<string, unknown> | undefined;
      if (u && typeof u === "object") lastUsage = u;
    }

    if (t === "content_block_start") {
      const cb = j.content_block as Record<string, unknown> | undefined;
      const idx = typeof j.index === "number" ? j.index : 0;
      const cbt = cb?.type as string | undefined;
      if (cbt === "tool_use" || cbt === "server_tool_use") {
        toolByIndex.set(idx, {
          type: cbt,
          name: cb?.name as string | undefined,
          id: cb?.id as string | undefined,
        });
        jsonAcc.set(idx, "");
      }
    }

    if (t === "content_block_delta") {
      const idx = typeof j.index === "number" ? j.index : 0;
      const delta = j.delta as Record<string, unknown> | undefined;
      if (delta?.type === "input_json_delta") {
        const pj = (delta.partial_json as string) ?? "";
        jsonAcc.set(idx, (jsonAcc.get(idx) ?? "") + pj);
      }
    }
  }

  const toolCalls: { name: string; id?: string; arguments?: unknown }[] = [];
  for (const [idx, meta] of [...toolByIndex.entries()].sort((a, b) => a[0] - b[0])) {
    const rawJson = jsonAcc.get(idx) ?? "";
    let args: unknown = rawJson;
    if (rawJson.trim()) {
      try {
        args = JSON.parse(rawJson);
      } catch {
        args = rawJson;
      }
    } else {
      args = {};
    }
    if (meta.name) {
      toolCalls.push({ name: meta.name, id: meta.id, arguments: args });
    }
  }

  const cacheRead = lastUsage?.cache_read_input_tokens != null ? Number(lastUsage.cache_read_input_tokens) : undefined;
  const cacheCreate =
    lastUsage?.cache_creation_input_tokens != null ? Number(lastUsage.cache_creation_input_tokens) : undefined;
  const inputTok = lastUsage?.input_tokens != null ? Number(lastUsage.input_tokens) : undefined;
  const outTok = lastUsage?.output_tokens != null ? Number(lastUsage.output_tokens) : undefined;

  return {
    provider: "claude",
    model,
    tokens: {
      prompt: inputTok,
      completion: outTok,
      reasoning: undefined,
      total: inputTok != null && outTok != null ? inputTok + outTok : undefined,
    },
    finishReason,
    toolCallsOccurred: toolCalls.length > 0,
    toolCalls,
    providerExtras: {
      cache_read_input_tokens: cacheRead ?? null,
      cache_creation_input_tokens: cacheCreate ?? null,
      usageRaw: lastUsage,
    },
  };
}

/* ---- Gemini stream ---- */

export function summarizeGeminiStream(rawChunks: string[]): StreamDebugSummary {
  let model: string | null = null;
  let finishReason: string | null = null;
  let usageMeta: Record<string, unknown> | null = null;
  let lastGm: Record<string, unknown> | null = null;
  const toolCalls: { name: string; id?: string; arguments?: unknown }[] = [];

  for (const raw of rawChunks) {
    if (raw === "[DONE]") continue;
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }

    const um = j.usageMetadata as Record<string, unknown> | undefined;
    if (um && typeof um === "object") usageMeta = um;

    const cand = (j.candidates as Record<string, unknown>[] | undefined)?.[0];
    if (cand) {
      const fr = cand.finishReason as string | undefined;
      if (fr != null && fr !== "") finishReason = fr;
      const gm = cand.groundingMetadata as Record<string, unknown> | undefined;
      if (gm && typeof gm === "object") lastGm = gm;

      const parts = (cand.content as Record<string, unknown> | undefined)?.parts as Record<string, unknown>[] | undefined;
      if (parts && Array.isArray(parts)) {
        for (const p of parts) {
          const fc = (p.functionCall ?? p.function_call) as Record<string, unknown> | undefined;
          if (fc?.name) {
            toolCalls.push({
              name: String(fc.name),
              arguments: fc.args ?? fc.arguments ?? {},
            });
          }
        }
      }
    }
  }

  const promptTok =
    usageMeta?.promptTokenCount != null ? Number(usageMeta.promptTokenCount) : undefined;
  const outTok =
    usageMeta?.candidatesTokenCount != null
      ? Number(usageMeta.candidatesTokenCount)
      : usageMeta?.candidatesTokens != null
        ? Number(usageMeta.candidatesTokens)
        : undefined;
  const thoughtsTok =
    usageMeta?.thoughtsTokenCount != null ? Number(usageMeta.thoughtsTokenCount) : undefined;
  const totalTok = usageMeta?.totalTokenCount != null ? Number(usageMeta.totalTokenCount) : undefined;

  const webQueries = lastGm?.webSearchQueries as unknown;

  return {
    provider: "gemini",
    model,
    tokens: {
      prompt: promptTok,
      completion: outTok,
      reasoning: thoughtsTok,
      total: totalTok,
    },
    finishReason,
    toolCallsOccurred: toolCalls.length > 0,
    toolCalls,
    providerExtras: {
      thoughtsTokenCount: thoughtsTok ?? null,
      webSearchQueries: webQueries ?? null,
      usageMetadataRaw: usageMeta,
      groundingMetadataRaw: lastGm,
    },
  };
}

export function mergeStreamDebugSummary(
  base: StreamDebugSummary,
  providerExtrasPatch: Record<string, unknown>,
): StreamDebugSummary {
  return {
    ...base,
    providerExtras: { ...base.providerExtras, ...providerExtrasPatch },
  };
}
