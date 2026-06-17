import type { ChatMessage, Citation } from "../../types/engine";
import {
  extractTokenCountsFromOnceResponse,
  logLLMConsoleRequest,
  logLLMConsoleResponse,
} from "./llmConsoleLog";
import {
  logDebugLLMRequest,
  logDebugLLMResponse,
  mergeStreamDebugSummary,
  summarizeClaudeStream,
  summarizeGeminiStream,
  summarizeOpenAIChatStream,
  summarizeOpenAIResponsesStream,
} from "./streamDebugMeta";

export interface ImageAttachment {
  base64: string;
  mimeType: string;
}

/** PDF (or other document) to send natively to models that support it */
export interface PdfAttachment {
  base64: string;
  name?: string;
}

export interface StreamOptions {
  provider: "gpt" | "gemini" | "claude";
  model: string;
  messages: ChatMessage[];
  system: string;
  maxTokens: number;
  temperature: number;
  webSearch?: boolean;
  images?: ImageAttachment[];
  /** PDFs to send as native document blocks (Claude/Gemini only) */
  pdfAttachments?: PdfAttachment[];
  signal?: AbortSignal;
  citationsRef?: { value: Citation[] }; // written by stream function on completion
  /** Console log label (default: chat-stream) */
  debugLabel?: string;
}

// Injected by vite.config.ts at build time. True when running inside Tauri desktop.
declare const __IS_TAURI__: boolean;

const ANTHROPIC_BASE = __IS_TAURI__ ? "https://api.anthropic.com" : "/api/anthropic";
const OPENAI_BASE    = __IS_TAURI__ ? "https://api.openai.com"    : "/api/openai";
const GOOGLE_BASE    = __IS_TAURI__
  ? "https://generativelanguage.googleapis.com"
  : "/api/google";

export { ANTHROPIC_BASE, OPENAI_BASE, GOOGLE_BASE };

function getApiKey(provider: "gpt" | "gemini" | "claude"): string {
  if (provider === "gpt") return localStorage.getItem("pc-api-openai") ?? "";
  if (provider === "claude") return localStorage.getItem("pc-api-anthropic") ?? "";
  return localStorage.getItem("pc-api-google") ?? "";
}

/** Merge legacy last-user-only `images` into `messages` when per-message `images` absent. */
function normalizeMessagesWithLegacyImages(
  messages: ChatMessage[],
  legacy?: ImageAttachment[],
): ChatMessage[] {
  if (!legacy || legacy.length === 0) return messages;
  const last = messages.length - 1;
  if (last < 0) return messages;
  const tail = messages[last];
  if (tail?.role !== "user" || (tail.images && tail.images.length > 0)) return messages;
  const merged: ChatMessage = {
    ...tail,
    images: legacy.map((img, i) => ({
      clientImageId: `pcimg_legacy_${i}`,
      base64: img.base64,
      mimeType: img.mimeType,
    })),
  };
  return [...messages.slice(0, -1), merged];
}

export async function* streamLLM(options: StreamOptions): AsyncGenerator<string> {
  const {
    provider,
    model,
    system,
    maxTokens,
    temperature,
    webSearch = false,
    images,
    pdfAttachments,
    signal,
    citationsRef,
    debugLabel = "chat-stream",
  } = options;
  const messages = normalizeMessagesWithLegacyImages(options.messages, images);
  const apiKey = getApiKey(provider);
  if (!apiKey) throw new Error(`API key for ${provider} is not set.`);

  if (provider === "gpt") {
    yield* streamGPT(apiKey, model, system, messages, maxTokens, temperature, webSearch, signal, citationsRef, debugLabel);
  } else if (provider === "claude") {
    yield* streamClaude(apiKey, model, system, messages, maxTokens, temperature, webSearch, pdfAttachments, signal, citationsRef, debugLabel);
  } else {
    yield* streamGemini(apiKey, model, system, messages, maxTokens, temperature, webSearch, pdfAttachments, signal, citationsRef, debugLabel);
  }
}

/* ---- GPT (OpenAI) ---- */

function isResponsesAPIModel(model: string): boolean {
  return /^gpt-5/.test(model) || /^o\d/.test(model);
}

function gptResponsesUserContent(msg: ChatMessage): string | unknown[] {
  if (msg.role !== "user" || !msg.images?.length) return msg.content;
  return [
    { type: "input_text", text: msg.content },
    ...msg.images.map((img) => ({
      type: "input_image",
      image_url: `data:${img.mimeType};base64,${img.base64}`,
    })),
  ];
}

async function* streamGPTResponses(
  apiKey: string,
  model: string,
  system: string,
  messages: ChatMessage[],
  maxTokens: number,
  _temperature: number,
  webSearch: boolean,
  signal?: AbortSignal,
  citationsRef?: { value: Citation[] },
  debugLabel = "chat-stream",
): AsyncGenerator<string> {
  const input: unknown[] = [{ role: "system", content: system }];

  for (const msg of messages) {
    if (msg.role === "assistant") {
      input.push({ role: "assistant", content: msg.content });
    } else {
      input.push({ role: "user", content: gptResponsesUserContent(msg) });
    }
  }

  const requestBody: Record<string, unknown> = {
    model,
    input,
    max_output_tokens: maxTokens,
    reasoning: { effort: "low" },
    stream: true,
  };
  if (webSearch) {
    requestBody.tools = [{ type: "web_search_preview" }];
  }

  logDebugLLMRequest({
    label: debugLabel,
    provider: "gpt-responses",
    model,
    requestBody,
    bodySource: "exact_json_stringify_before_fetch",
    extras: {
      reasoning_effort: (requestBody.reasoning as { effort?: string } | undefined)?.effort ?? "not_set",
      reasoning_object: requestBody.reasoning ?? "not_sent",
    },
  });

  const resp = await fetch(`${OPENAI_BASE}/v1/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify(requestBody),
    signal,
  });

  console.log("[LLM Response] gpt-responses status:", resp.status, resp.statusText);
  if (!resp.ok) {
    const errText = await resp.text();
    console.error("[LLM Error Body] gpt-responses:", errText);
    throw new Error(`OpenAI Responses API error ${resp.status}: ${errText}`);
  }

  const rawCitations: Citation[] = [];
  let totalChunks = 0;
  let contentChunks = 0;
  const rawChunksRef = { value: [] as string[] };
  yield* parseSSEStream(resp, (data) => {
    if (data === "[DONE]") return null;
    try {
      const json = JSON.parse(data);
      totalChunks++;

      if (json.type === "response.output_text.annotation") {
        const ann = json.annotation;
        if (ann?.type === "url_citation") {
          rawCitations.push({ url: ann.url, title: ann.title ?? "", endIndex: ann.end_index });
        }
        return null;
      }

      if (json.type === "response.output_text.delta") {
        const delta = json.delta ?? null;
        if (delta != null) contentChunks++;
        return delta;
      }

      return null;
    } catch (e) {
      console.warn("[GPT-Responses] SSE parse error:", e, "raw:", data);
      return null;
    }
  }, { provider: "gpt-responses", rawChunksRef, signal });
  console.log(`[GPT-Responses] SSE summary: ${contentChunks}/${totalChunks} chunks had content`);
  if (contentChunks === 0 && rawChunksRef.value.length > 0 && !shouldLogRawSSE()) {
    logRawSSEChunks("gpt-responses (empty response)", rawChunksRef.value);
  }
  if (citationsRef) citationsRef.value = rawCitations;

  logDebugLLMResponse(
    mergeStreamDebugSummary(summarizeOpenAIResponsesStream(rawChunksRef.value), {
      reasoning_effort_sent: (requestBody.reasoning as { effort?: string } | undefined)?.effort ?? "not_set",
    }),
    { label: debugLabel },
  );
}

function gptChatUserContent(msg: ChatMessage): string | unknown[] {
  if (msg.role !== "user" || !msg.images?.length) return msg.content;
  return [
    { type: "text", text: msg.content },
    ...msg.images.map((img) => ({
      type: "image_url",
      image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
    })),
  ];
}

async function* streamGPT(
  apiKey: string,
  model: string,
  system: string,
  messages: ChatMessage[],
  maxTokens: number,
  temperature: number,
  webSearch: boolean,
  signal?: AbortSignal,
  citationsRef?: { value: Citation[] },
  debugLabel = "chat-stream",
): AsyncGenerator<string> {
  if (isResponsesAPIModel(model)) {
    yield* streamGPTResponses(apiKey, model, system, messages, maxTokens, temperature, webSearch, signal, citationsRef, debugLabel);
    return;
  }

  const openaiMessages: unknown[] = [{ role: "system", content: system }];

  for (const msg of messages) {
    if (msg.role === "assistant") {
      openaiMessages.push({ role: "assistant", content: msg.content });
    } else {
      openaiMessages.push({ role: "user", content: gptChatUserContent(msg) });
    }
  }

  // OpenAI models increasingly restrict temperature (o-series, gpt-5-*, …).
  // Omit it entirely and let the API use its default to avoid model-specific 400 errors.
  const requestBody: Record<string, unknown> = {
    model,
    messages: openaiMessages,
    max_completion_tokens: maxTokens,
    stream: true,
    stream_options: { include_usage: true },
  };
  logDebugLLMRequest({
    label: debugLabel,
    provider: "gpt",
    model,
    requestBody,
    bodySource: "exact_json_stringify_before_fetch",
    extras: {
      reasoning_effort: "not_sent",
      note: "Chat Completions API — reasoning_effort はリクエストに含めていません（モデル既定）。",
    },
  });

  const resp = await fetch(`${OPENAI_BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify(requestBody),
    signal,
  });

  console.log("[LLM Response] gpt status:", resp.status, resp.statusText);
  if (!resp.ok) {
    const errText = await resp.text();
    console.error("[LLM Error Body] gpt:", errText);
    throw new Error(`OpenAI error ${resp.status}: ${errText}`);
  }

  const rawCitations: Citation[] = [];
  let totalChunks = 0;
  let contentChunks = 0;
  const rawChunksRef = { value: [] as string[] };
  yield* parseSSEStream(resp, (data) => {
    if (data === "[DONE]") return null;
    try {
      const json = JSON.parse(data);
      totalChunks++;

      const anns = json.choices?.[0]?.delta?.annotations;
      if (anns && Array.isArray(anns) && anns.length > 0) {
        console.log("[GPT] Annotations:", anns);
        for (const ann of anns) {
          if (ann.type === "url_citation") {
            rawCitations.push({
              url: ann.url_citation.url,
              title: ann.url_citation.title ?? "",
              endIndex: ann.url_citation.end_index,
            });
          }
        }
      }

      const content = json.choices?.[0]?.delta?.content;
      if (content == null) {
        if (shouldLogRawSSE()) {
          const finishReason = json.choices?.[0]?.finish_reason;
          const deltaKeys = Object.keys(json.choices?.[0]?.delta ?? {});
          console.log("[GPT] non-content chunk", { finishReason, deltaKeys, raw: json });
        }
      } else {
        contentChunks++;
      }

      return content ?? null;
    } catch (e) {
      console.warn("[GPT] SSE parse error:", e, "raw:", data);
      return null;
    }
  }, { provider: "gpt", rawChunksRef, signal });
  console.log(`[GPT] SSE summary: ${contentChunks}/${totalChunks} chunks had content`);
  if (contentChunks === 0 && rawChunksRef.value.length > 0 && !shouldLogRawSSE()) {
    logRawSSEChunks("gpt (empty response)", rawChunksRef.value);
  }
  if (citationsRef) citationsRef.value = rawCitations;

  logDebugLLMResponse(
    mergeStreamDebugSummary(summarizeOpenAIChatStream(rawChunksRef.value), {
      reasoning_effort: "not_sent",
    }),
    { label: debugLabel },
  );
}

/* ---- Claude (Anthropic) ---- */

async function* streamClaude(
  apiKey: string,
  model: string,
  system: string,
  messages: ChatMessage[],
  maxTokens: number,
  temperature: number,
  webSearch: boolean,
  pdfAttachments?: PdfAttachment[],
  signal?: AbortSignal,
  citationsRef?: { value: Citation[] },
  debugLabel = "chat-stream",
): AsyncGenerator<string> {
  const hasPdfs = pdfAttachments && pdfAttachments.length > 0;
  const filtered = messages.filter((m) => m.role !== "system");
  let lastUserIndex = -1;
  for (let i = filtered.length - 1; i >= 0; i--) {
    if (filtered[i]!.role === "user") {
      lastUserIndex = i;
      break;
    }
  }

  const anthropicMessages = filtered.map((msg, idx) => {
    const attachPdfsHere = hasPdfs && idx === lastUserIndex && msg.role === "user";
    const hasImgs = msg.role === "user" && (msg.images?.length ?? 0) > 0;

    if (msg.role === "user" && (hasImgs || attachPdfsHere)) {
      const parts: unknown[] = [{ type: "text" as const, text: msg.content }];
      if (hasImgs) {
        for (const img of msg.images ?? []) {
          parts.push({
            type: "image" as const,
            source: {
              type: "base64" as const,
              media_type: img.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
              data: img.base64,
            },
          });
        }
      }
      if (attachPdfsHere) {
        for (const pdf of pdfAttachments ?? []) {
          parts.push({
            type: "document" as const,
            source: { type: "base64" as const, media_type: "application/pdf" as const, data: pdf.base64 },
          });
        }
      }
      if (parts.length === 1) {
        return { role: "user" as const, content: msg.content };
      }
      return { role: "user" as const, content: parts };
    }
    return { role: (msg.role === "assistant" ? "assistant" : "user") as "user" | "assistant", content: msg.content };
  });

  // Collect required beta headers
  const betaHeaders: string[] = [];
  if (webSearch) betaHeaders.push("web-search-2025-03-05");
  if (hasPdfs) betaHeaders.push("pdfs-2024-09-25");

  const claudeBody = {
    model,
    system,
    messages: anthropicMessages,
    max_tokens: maxTokens,
    temperature,
    ...(webSearch ? { tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }] } : {}),
    stream: true,
  };
  logDebugLLMRequest({
    label: debugLabel,
    provider: "claude",
    model,
    requestBody: claudeBody,
    bodySource: "exact_json_stringify_before_fetch",
    extras: {
      thinking: "not_sent",
      thinking_budget_tokens: "unset",
      note: "extended thinking / thinking ブロックはリクエストに含めていません。",
    },
  });

  const resp = await fetch(`${ANTHROPIC_BASE}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      ...(__IS_TAURI__ ? { "anthropic-dangerous-direct-browser-access": "true" } : {}),
      ...(betaHeaders.length > 0 ? { "anthropic-beta": betaHeaders.join(",") } : {}),
    },
    body: JSON.stringify(claudeBody),
    signal,
  });

  console.log("[LLM Response] claude status:", resp.status, resp.statusText);
  if (!resp.ok) {
    const errText = await resp.text();
    console.error("[LLM Error Body] claude:", errText);
    throw new Error(`Anthropic error ${resp.status}: ${errText}`);
  }

  const rawCitations: Citation[] = [];
  let contentChunks = 0;
  const rawChunksRef = { value: [] as string[] };
  yield* parseSSEStream(resp, (data) => {
    try {
      const json = JSON.parse(data);
      // Capture web search results from content_block_start events
      if (json.type === "content_block_start" &&
          json.content_block?.type === "web_search_tool_result") {
        const results = json.content_block.content ?? [];
        console.log("[Claude] Web Search Results:", results);
        for (const r of results) {
          if (r.type === "web_search_result") {
            rawCitations.push({ url: r.url, title: r.title ?? "", endIndex: undefined });
          }
        }
      }
      if (json.type === "content_block_delta" && json.delta?.type === "text_delta") {
        const text = json.delta.text ?? null;
        if (text) contentChunks++;
        return text;
      }
      return null;
    } catch {
      return null;
    }
  }, { provider: "claude", rawChunksRef, signal });
  if (contentChunks === 0 && rawChunksRef.value.length > 0 && !shouldLogRawSSE()) {
    logRawSSEChunks("claude (empty response)", rawChunksRef.value);
  }
  if (citationsRef) citationsRef.value = rawCitations;

  const sum = summarizeClaudeStream(rawChunksRef.value);
  logDebugLLMResponse(
    mergeStreamDebugSummary(sum, {
      thinking_request: { sent: false, budget_tokens: "unset" },
    }),
    { label: debugLabel },
  );
}

/* ---- Gemini (Google) ---- */

async function* streamGemini(
  apiKey: string,
  model: string,
  system: string,
  messages: ChatMessage[],
  maxTokens: number,
  temperature: number,
  webSearch: boolean,
  pdfAttachments?: PdfAttachment[],
  signal?: AbortSignal,
  citationsRef?: { value: Citation[] },
  debugLabel = "chat-stream",
): AsyncGenerator<string> {
  const hasPdfs = pdfAttachments && pdfAttachments.length > 0;
  const filtered = messages.filter((m) => m.role !== "system");
  let lastUserIndex = -1;
  for (let i = filtered.length - 1; i >= 0; i--) {
    if (filtered[i]!.role === "user") {
      lastUserIndex = i;
      break;
    }
  }

  const contents = filtered.map((msg, idx) => {
    const attachPdfsHere = hasPdfs && idx === lastUserIndex && msg.role === "user";
    const hasImgs = msg.role === "user" && (msg.images?.length ?? 0) > 0;

    if (msg.role === "user" && (hasImgs || attachPdfsHere)) {
      const parts: Array<{ text?: string; inline_data?: { mime_type: string; data: string } }> = [{ text: msg.content }];
      if (hasImgs) {
        for (const img of msg.images ?? []) {
          parts.push({ inline_data: { mime_type: img.mimeType, data: img.base64 } });
        }
      }
      if (attachPdfsHere) {
        for (const pdf of pdfAttachments ?? []) {
          parts.push({ inline_data: { mime_type: "application/pdf", data: pdf.base64 } });
        }
      }
      return {
        role: "user",
        parts,
      };
    }
    return {
      role: msg.role === "assistant" ? "model" : "user",
      parts: [{ text: msg.content }],
    };
  });

  const url = `${GOOGLE_BASE}/v1beta/models/${model}:streamGenerateContent?key=${apiKey}&alt=sse`;
  const geminiBody = {
    system_instruction: { parts: [{ text: system }] },
    contents,
    generationConfig: { maxOutputTokens: maxTokens, temperature },
    ...(webSearch ? { tools: [{ google_search: {} }] } : {}),
  };
  const genCfg = geminiBody.generationConfig as Record<string, unknown>;
  const thinkingCfg = genCfg.thinkingConfig;
  logDebugLLMRequest({
    label: debugLabel,
    provider: "gemini",
    model,
    requestBody: geminiBody,
    bodySource: "exact_json_stringify_before_fetch",
    extras: {
      generationConfig_thinkingConfig: thinkingCfg !== undefined ? thinkingCfg : "unset",
      thinkingLevel: (thinkingCfg as Record<string, unknown> | undefined)?.thinkingLevel ?? "unset",
      thinkingBudget: (thinkingCfg as Record<string, unknown> | undefined)?.thinkingBudget ?? "unset",
    },
  });

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(geminiBody),
    signal,
  });

  console.log("[LLM Response] gemini status:", resp.status, resp.statusText);
  if (!resp.ok) {
    const errText = await resp.text();
    console.error("[LLM Error Body] gemini:", errText);
    throw new Error(`Gemini error ${resp.status}: ${errText}`);
  }

  let latestGeminiCitations: Citation[] = [];
  let contentChunks = 0;
  const rawChunksRef = { value: [] as string[] };
  yield* parseSSEStream(resp, (data) => {
    try {
      const json = JSON.parse(data);
      // Capture grounding metadata (overwrite with latest chunk)
      const gm = json.candidates?.[0]?.groundingMetadata;
      if (gm) {
        if (shouldLogRawSSE()) {
          console.log("[Gemini] Grounding Metadata:", gm);
        }
        const chunks: Citation[] = [];
        const supports: unknown[] = gm.groundingSupports ?? [];
        for (const sup of supports as Array<{ segment?: { endIndex?: number }; groundingChunkIndices?: number[] }>) {
          const endIdx: number | undefined = sup.segment?.endIndex;
          for (const ci of sup.groundingChunkIndices ?? []) {
            const web = (gm.groundingChunks?.[ci] as { web?: { uri?: string; title?: string } } | undefined)?.web;
            if (web?.uri) {
              chunks.push({ url: web.uri, title: web.title ?? "", endIndex: endIdx });
            }
          }
        }
        latestGeminiCitations = chunks;
      }
      const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
      if (text) contentChunks++;
      return text;
    } catch {
      return null;
    }
  }, { provider: "gemini", rawChunksRef, signal });
  if (contentChunks === 0 && rawChunksRef.value.length > 0 && !shouldLogRawSSE()) {
    logRawSSEChunks("gemini (empty response)", rawChunksRef.value);
  }
  if (citationsRef) citationsRef.value = latestGeminiCitations;

  const sum = summarizeGeminiStream(rawChunksRef.value);
  logDebugLLMResponse(
    mergeStreamDebugSummary(sum, {
      model_resolved: sum.model ?? model,
      generationConfig_thinkingConfig_sent: thinkingCfg !== undefined ? thinkingCfg : "unset",
    }),
    { label: debugLabel },
  );
}

/* ---- SSE parser ---- */

/**
 * When true, log every raw SSE chunk and empty non-streaming responses.
 * Set in console: localStorage.setItem("pc-debug-llm-raw", "true")
 * Structured [DEBUG][REQUEST]/[DEBUG][RESPONSE] metadata: also set "pc-debug-llm-meta" to "true"
 * (either flag enables stream debug metadata in src/lib/llm/streamDebugMeta.ts).
 * When false, raw chunks are logged only when the stream yielded no content (empty response).
 */
function shouldLogRawSSE(): boolean {
  try {
    return localStorage.getItem("pc-debug-llm-raw") === "true";
  } catch {
    return false;
  }
}

function logRawSSEChunks(provider: string, rawChunks: string[]): void {
  if (rawChunks.length === 0) return;
  console.groupCollapsed(`[LLM Raw SSE] ${provider} — ${rawChunks.length} chunks (click to expand)`);
  rawChunks.forEach((chunk, i) => {
    if (chunk === "[DONE]") {
      console.log(i, chunk);
    } else {
      try {
        console.log(i, JSON.parse(chunk));
      } catch {
        console.log(i, chunk);
      }
    }
  });
  console.groupEnd();
}

async function* parseSSEStream(
  resp: Response,
  extract: (data: string) => string | null,
  opts?: { provider: string; rawChunksRef?: { value: string[] }; signal?: AbortSignal },
): AsyncGenerator<string> {
  const provider = opts?.provider ?? "llm";
  const rawChunksRef = opts?.rawChunksRef ?? { value: [] };
  const signal = opts?.signal;
  const reader = resp.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = "";
  rawChunksRef.value = [];

  try {
  while (true) {
    if (signal?.aborted) {
      await reader.cancel().catch(() => {});
      return;
    }
    const { done, value } = await reader.read();
    if (signal?.aborted) {
      await reader.cancel().catch(() => {});
      return;
    }
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const raw = line.slice(6).trim();
        rawChunksRef.value.push(raw);
        const text = extract(raw);
        if (text) yield text;
      }
    }
  }
  // flush remaining
  if (buffer.startsWith("data: ")) {
    const raw = buffer.slice(6).trim();
    rawChunksRef.value.push(raw);
    const text = extract(raw);
    if (text) yield text;
  }

  if (shouldLogRawSSE() && rawChunksRef.value.length > 0) {
    logRawSSEChunks(provider, rawChunksRef.value);
  }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released / cancelled */
    }
  }
}

/* ---- Model config helpers ---- */

export function getModelConfig(provider: "gpt" | "gemini" | "claude", role: string): {
  model: string;
  maxTokens: number;
  temperature: number;
} {
  const key = `pc-model-${provider}-${role}`;
  const raw = localStorage.getItem(key);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      return {
        model: String(parsed.model),
        maxTokens: Math.floor(Number(parsed.maxTokens)),
        temperature: Number(parsed.temperature),
      };
    } catch {}
  }
  const defaults: Record<string, { model: string; maxTokens: number; temperature: number }> = {
    "gpt-standard":    { model: "gpt-4o",       maxTokens: 2000, temperature: 0.7 },
    "gpt-fast":        { model: "gpt-4o-mini",  maxTokens: 1000, temperature: 0.7 },
    "gpt-reasoning":   { model: "o3",           maxTokens: 4000, temperature: 1 },
    "gpt-router":      { model: "gpt-4o-mini",  maxTokens: 256,  temperature: 0.0 },
    "gpt-stm":         { model: "gpt-4o-mini",  maxTokens: 2048, temperature: 0.3 },
    "gpt-ltm":         { model: "gpt-4o-mini",  maxTokens: 2048, temperature: 0.3 },
    "gpt-title":       { model: "gpt-4o-mini",  maxTokens: 30,   temperature: 0.3 },
    "claude-standard": { model: "claude-sonnet-4-6",           maxTokens: 2000, temperature: 0.7 },
    "claude-fast":     { model: "claude-haiku-4-5-20251001",   maxTokens: 1000, temperature: 0.7 },
    "claude-reasoning":{ model: "claude-opus-4-6",             maxTokens: 4000, temperature: 0.7 },
    "claude-router":   { model: "claude-3-5-haiku",            maxTokens: 256,  temperature: 0.0 },
    "claude-stm":      { model: "claude-3-5-haiku",            maxTokens: 2048, temperature: 0.3 },
    "claude-ltm":      { model: "claude-3-5-haiku",            maxTokens: 2048, temperature: 0.3 },
    "claude-title":    { model: "claude-3-5-haiku",            maxTokens: 30,   temperature: 0.3 },
    "gemini-standard": { model: "gemini-2.0-flash",            maxTokens: 2000, temperature: 0.7 },
    "gemini-fast":     { model: "gemini-2.0-flash-lite",       maxTokens: 1000, temperature: 0.7 },
    "gemini-reasoning":{ model: "gemini-2.0-flash-thinking-exp", maxTokens: 4000, temperature: 0.7 },
    "gemini-router":   { model: "gemini-2.0-flash",            maxTokens: 256,  temperature: 0.0 },
    "gemini-stm":      { model: "gemini-2.0-flash",            maxTokens: 2048, temperature: 0.3 },
    "gemini-ltm":      { model: "gemini-2.0-flash",            maxTokens: 2048, temperature: 0.3 },
    "gemini-title":    { model: "gemini-2.0-flash-lite",       maxTokens: 30,   temperature: 0.3 },
  };
  return defaults[`${provider}-${role}`] ?? defaults[`gpt-${role}`] ?? { model: "gpt-4o-mini", maxTokens: 1000, temperature: 0.7 };
}

/**
 * Non-streaming single LLM completion. Used by router, STM, LTM, title, hub meta judge, etc.
 */
export async function callLLMOnce(
  provider: "gpt" | "gemini" | "claude",
  model: string,
  system: string,
  messages: { role: "user" | "assistant"; content: string }[],
  maxTokens: number,
  temperature = 0.3,
  debugLabel = "llm-once",
): Promise<string> {
  const apiKey = getApiKey(provider);
  if (!apiKey) throw new Error(`No API key for ${provider}`);

  if (provider === "gpt") {
    const requestBody = {
      model,
      messages: [{ role: "system", content: system }, ...messages],
      max_tokens: maxTokens,
      temperature,
    };
    logLLMConsoleRequest({ label: debugLabel, provider, model, system, messages, requestBody });
    const resp = await fetch(`${OPENAI_BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify(requestBody),
    });
    const data = (await resp.json()) as Record<string, unknown>;
    const text = (data.choices as { message?: { content?: string } }[] | undefined)?.[0]?.message?.content ?? "";
    const tokens = extractTokenCountsFromOnceResponse("gpt", data);
    logLLMConsoleResponse({
      label: debugLabel,
      provider,
      model: (data.model as string | undefined) ?? model,
      text,
      status: resp.status,
      statusText: resp.statusText,
      tokens,
      errorBody: resp.ok ? undefined : data,
    });
    if (!text && shouldLogRawSSE()) {
      console.groupCollapsed(`[LLM Raw Response] ${debugLabel} gpt (empty text)`);
      console.log(data);
      console.groupEnd();
    }
    if (!resp.ok) throw new Error(`OpenAI error ${resp.status}`);
    return text;
  }

  if (provider === "claude") {
    const requestBody = { model, system, messages, max_tokens: maxTokens, temperature };
    logLLMConsoleRequest({ label: debugLabel, provider, model, system, messages, requestBody });
    const resp = await fetch(`${ANTHROPIC_BASE}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        ...(__IS_TAURI__ ? { "anthropic-dangerous-direct-browser-access": "true" } : {}),
      },
      body: JSON.stringify(requestBody),
    });
    const data = (await resp.json()) as Record<string, unknown>;
    const content = data.content as { text?: string }[] | undefined;
    const text = content?.[0]?.text ?? "";
    const tokens = extractTokenCountsFromOnceResponse("claude", data);
    logLLMConsoleResponse({
      label: debugLabel,
      provider,
      model: (data.model as string | undefined) ?? model,
      text,
      status: resp.status,
      statusText: resp.statusText,
      tokens,
      errorBody: resp.ok ? undefined : data,
    });
    if (!text && shouldLogRawSSE()) {
      console.groupCollapsed(`[LLM Raw Response] ${debugLabel} claude (empty text)`);
      console.log(data);
      console.groupEnd();
    }
    if (!resp.ok) throw new Error(`Anthropic error ${resp.status}`);
    return text;
  }

  const requestBody = {
    system_instruction: { parts: [{ text: system }] },
    contents: messages.map((m) => ({
      role: m.role === "user" ? "user" : "model",
      parts: [{ text: m.content }],
    })),
    generationConfig: { maxOutputTokens: maxTokens, temperature },
  };
  logLLMConsoleRequest({ label: debugLabel, provider, model, system, messages, requestBody });
  const resp = await fetch(`${GOOGLE_BASE}/v1beta/models/${model}:generateContent?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
  });
  const data = (await resp.json()) as Record<string, unknown>;
  const candidates = data.candidates as { content?: { parts?: { text?: string }[] } }[] | undefined;
  const text = candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  const tokens = extractTokenCountsFromOnceResponse("gemini", data);
  logLLMConsoleResponse({
    label: debugLabel,
    provider,
    model,
    text,
    status: resp.status,
    statusText: resp.statusText,
    tokens,
    errorBody: resp.ok ? undefined : data,
  });
  if (!text && shouldLogRawSSE()) {
    console.groupCollapsed(`[LLM Raw Response] ${debugLabel} gemini (empty text)`);
    console.log(data);
    console.groupEnd();
  }
  if (!resp.ok) throw new Error(`Gemini error ${resp.status}`);
  return text;
}
