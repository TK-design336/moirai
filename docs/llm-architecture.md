# LLM Pipeline Architecture

Personal Concierge — LLM engine reference for developers.

---

## 1. Overview

Every user message flows through an 11-stage pipeline:

```
User input
    │
    ▼
[1] Router          ← rule-based keyword scoring OR one-shot LLM call
    │  RouteResult { taskKind, mode, webSearch }
    ▼
[2] Tool Prefetch   ← fetch live data (calendar, Gmail, Notion) before prompt build
    │  toolContext: string
    ▼
[3] Memory Load     ← STM summary + selective LTM facts
    │  stm: STMState, ltm: LTMData
    ▼
[4] Avatar Persona  ← selected avatar's personaSetting from pc-avatars
    │  avatarPersona: string
    ▼
[5] System Prompt   ← 9-section prompt assembled from all of the above
    │  system: string
    ▼
[6] Model Config    ← provider × mode → { model, maxTokens, temperature }
    │  modelConfig
    ▼
[7] History Slice   ← last 10 ChatMessages from current branch
    │  recentHistory: ChatMessage[]
    ▼
[8] LLM Stream      ← SSE streaming (GPT / Claude / Gemini)
    │  chunks → onToken callbacks + TTS sentence splitter
    ▼
[9] Response Parse  ← tag extraction: emotion → panel → avatar → tools → media → prompts
    │  ParsedResponse
    ▼
[10] Tool Execute   ← run any <tools> requests returned by LLM
    │  toolResults (currently logged; second LLM call not yet implemented)
    ▼
[11] STM Update     ← async compression every 4 turns
```

---

## 2. Router

**File:** `src/lib/llm/router.ts`

### Rule-based (default)

`ruleBasedRoute(text, webToggle)` scores the user's message against 8 keyword lists:


| TaskKind   | Weight | Example keywords     |
| ---------- | ------ | -------------------- |
| `schedule` | 3      | スケジュール, calendar, 旅行 |
| `transit`  | 3      | 乗換, route, train     |
| `email`    | 3      | メール, Gmail, mail     |
| `quiz`     | 3      | クイズ, quiz, test      |
| `task`     | 2      | タスク, TODO, todo      |
| `news`     | 2      | ニュース, news, latest   |
| `compare`  | 2      | 比較, compare, vs      |
| `note`     | 2      | まとめ, note, summary   |
| `general`  | —      | fallback (score 0)   |


The highest-scoring kind wins. Mode is determined separately:

- `reasoning` — if reasoning keywords score ≥ 3 and outpace standard by ≥ 1
- `standard` — if standard keywords score ≥ 2
- `fast` — otherwise

`webSearch` is true when `webToggle` is on OR search-signal keywords score ≥ 3 (today, weather, price, 最新, etc.).

### LLM-based fallback

`llmRoute(userText, history, provider)` sends a single lightweight call to the active provider with a strict system prompt that returns `[TASK_KIND,MODE,WEB_SEARCH]` on one line. Falls back to rule-based if the call fails or the response is unparseable.

The router model is read from `pc-model-{provider}-router` localStorage key (defaults: `gpt-4o-mini`, `claude-haiku-4-5-20251001`, `gemini-2.0-flash`).

Toggle via `pc-use-rule-router` = `"true"` | `"false"` (read in `ChatPanel.tsx`).

---

## 3. System Prompt Assembly

**File:** `src/lib/llm/systemPrompt.ts`

`buildSystemPrompt(options)` concatenates 9 sections in order:

```
[Core Instruction]        ← pc-prompt-core or DEFAULT_CORE
[Mode Instruction]        ← pc-prompt-mode + TASK_MODE_HINTS[taskKind]
[Persona Setting]         ← avatar.personaSetting or pc-prompt-persona
[Temporal Context]        ← ISO datetime + pc-prompt-temporal
[Short-Term State]        ← stm.summary (compressed conversation history)
[Long-Term Memory]        ← selectRelevantLTM(ltm, taskKind)
[Available Tools]         ← list of connected service names + prefetched data
RESPONSE_FORMAT_INSTRUCTION  ← strict XML tag + emotion format (see §10)
```

`TASK_MODE_HINTS` provides per-kind panel instructions (Japanese + English). For example, `schedule` tells the model to emit `<panel type="calendar">` with `type="proposed"` for suggested events.

All section content can be overridden via Settings → Prompts tab.

---

## 4. LLM Streaming Client

**File:** `src/lib/llm/client.ts`

`streamLLM(options): AsyncGenerator<string>` dispatches to one of three provider generators:


| Provider | Endpoint                                                            | Stream format                                      |
| -------- | ------------------------------------------------------------------- | -------------------------------------------------- |
| `gpt`    | `https://api.openai.com/v1/chat/completions`                        | SSE, `data: {...}` with `choices[0].delta.content` |
| `claude` | `https://api.anthropic.com/v1/messages`                             | SSE, `content_block_delta` event with `delta.text` |
| `gemini` | `generativelanguage.googleapis.com/…:streamGenerateContent?alt=sse` | SSE, `candidates[0].content.parts[0].text`         |


All three share `parseSSEStream(resp, extract)` — a line-buffered SSE reader that decodes chunks, splits on `\n`, and yields non-null results of the provider-specific `extract` function.

`getModelConfig(provider, role)` reads `pc-model-{provider}-{role}` from localStorage. If absent, defaults are:


| Key                | Model                         | maxTokens | temperature |
| ------------------ | ----------------------------- | --------- | ----------- |
| `gpt-fast`         | gpt-4o-mini                   | 1000      | 0.7         |
| `gpt-standard`     | gpt-4o                        | 2000      | 0.7         |
| `gpt-reasoning`    | o3-mini                       | 4000      | 1.0         |
| `claude-fast`      | claude-haiku-4-5-20251001     | 1000      | 0.7         |
| `claude-standard`  | claude-sonnet-4-6             | 2000      | 0.7         |
| `claude-reasoning` | claude-opus-4-6               | 4000      | 0.7         |
| `gemini-fast`      | gemini-2.0-flash-lite         | 1000      | 0.7         |
| `gemini-standard`  | gemini-2.0-flash              | 2000      | 0.7         |
| `gemini-reasoning` | gemini-2.0-flash-thinking-exp | 4000      | 0.7         |


---

## 5. Response Parser

**File:** `src/lib/response/parser.ts`

`parseResponse(raw): ParsedResponse` processes the full streamed text in tag-extraction order:

1. **Emotion** — `[EMOTION:DEGREE]` on line 1 (e.g. `[Happy:2]`). Stripped from body.
2. **Panel** — `<panel type="…">…</panel>` regex. Dispatches to `panelExtractor`. Stripped from body.
3. **Avatar state** — `<avatar state="…" …/>`. Stripped from body.
4. **Tools** — `<tools>TOOL:JSON_PARAMS</tools>`. Each line parsed as `tool:params`. Stripped from body.
5. **Media** — `<media>…</media>`. Lines collected as string array. Stripped from body.
6. **Prompts** — `<prompts>…</prompts>`. Lines collected as suggested follow-up prompts. Stripped from body.

The remaining text after all substitutions is `body` (Markdown prose rendered in the chat bubble).

`ParsedResponse` shape:

```ts
{
  emotion: string;      // e.g. "Happy"
  degree: number;       // 1 | 2 | 3
  body: string;         // cleaned Markdown text
  avatarState: AvatarState;
  panelData?: SpecialPanelData;
  taskData?: TaskPanelData;
  media: string[];
  prompts: string[];
  toolRequests: ToolRequest[];
}
```

---

## 6. Panel Extractor

**File:** `src/lib/response/panelExtractor.ts`

`extractPanel(type, inner)` dispatches to one of 8 typed extractors. Returns `SpecialPanelData | undefined`.

`extractTaskPanel(inner)` is a separate export (task panels flow to `TaskBoard`, not `SpecialPanels`).

### Attribute helpers


| Helper                      | Purpose                                                   |
| --------------------------- | --------------------------------------------------------- |
| `attr(tag, name, fallback)` | Reads `name="value"` from a tag string                    |
| `innerText(xml, tag)`       | Extracts text between `<tag>…</tag>`                      |
| `allTags(xml, tag)`         | Returns all matching tag strings (self-closing or paired) |


### Panel extractors


| Type       | Root element                  | Child elements                                                                            |
| ---------- | ----------------------------- | ----------------------------------------------------------------------------------------- |
| `calendar` | `<date>`                      | `<event id title start end color type description location/>`                             |
| `map`      | `<mode>`                      | `<spot id name address arrivalTime stayMinutes transitMinutes link_label link_url memo/>` |
| `transit`  | `<from>` `<to>` `<departure>` | `<candidate id method duration transfers cost walk tags delayInfo/>`                      |
| `email`    | —                             | `<email id subject sender receivedAt priority summary read/>`                             |
| `news`     | —                             | `<article id title topic source summary url/>`                                            |
| `compare`  | `<compareType>` `<columns>`   | `<item id name price rating col_* pros cons url/>`                                        |
| `note`     | `<title>` `<markdown>`        | —                                                                                         |
| `quiz`     | `<mode>` `<topic>`            | `<question id type text choices correct explanation/>`                                    |
| `task`     | —                             | `<task id title priority deadline estimatedMinutes tags>` + `<subtask id title/>`         |


---

## 7. Special Panels UI

**File:** `src/components/SpecialPanels.tsx`

`SpecialPanelShell` renders a toggle bar under AI messages that opens the panel to the right. The `switch` on `panelData.panelType` renders one of 8 panel components.

`PANEL_TYPE_LABELS` maps each `PanelType` to a display string. `PANEL_ICONS` maps each type to a Material-style icon character.

Task panels (`type="task"`) flow to `TaskBoard.tsx` (draggable floating overlay) via `onTaskData` callback from `ChatPanel`.

Demo data for all panel types is generated by `makeDemoSession()` in `ChatPanel.tsx` and loaded on first render.

---

## 8. Memory

### Short-Term Memory (STM)

**File:** `src/lib/memory/stm.ts` | localStorage key: `pc-stm-data`

`maybeTriggerSTMUpdate(turnCount, messages, provider)` fires every 4 turns (`STM_INTERVAL = 4`). It sends the last N messages plus the previous summary to the provider using a compression prompt (`pc-prompt-stm`), then writes the new compact summary (max 200 words) back to localStorage.

The summary is injected verbatim into the `[Short-Term State]` section of the system prompt on every request.

### Long-Term Memory (LTM)

**File:** `src/lib/memory/ltm.ts` | localStorage key: `pc-ltm-data`

`LTMData` holds structured facts: `preferences`, `habits`, `importantDates`, `contacts`, and `customFacts`.

`selectRelevantLTM(ltm, taskKind)` filters the LTM to facts relevant to the current task kind, reducing prompt length. The selected facts are injected into the `[Long-Term Memory]` section.

---

## 9. useLLMEngine Hook

**File:** `src/hooks/useLLMEngine.ts`

Exports `useLLMEngine()` → `{ send, stop, avatarState, setAvatarState }`.

### `send(userText, history, options, callbacks)`

Full 11-stage flow (see §1). Key behaviors:

- Uses `AbortController` — abort propagates into `streamLLM` via `signal`.
- TTS: `StreamSentenceSplitter` detects sentence boundaries in streaming chunks. Sentences inside XML tags (`<panel>`, `<prompts>`, `<media>`, `<tools>`, `<avatar>`) are suppressed by tracking open/close tag counts across the accumulated full text.
- Debug logging: a collapsible `[LLM Request]` group is logged to the browser console before streaming starts, containing the route result, provider, model, full system prompt, and message array.
- STM update runs async (`maybeTriggerSTMUpdate(...).catch(console.error)`) so it never blocks the response.

### `stop()`

Aborts the current request, stops TTS playback, resets avatar to `"idle"`.

### Callbacks


| Callback               | Fires                           |
| ---------------------- | ------------------------------- |
| `onToken(chunk)`       | Each streamed text chunk        |
| `onSentence(sentence)` | Each TTS sentence boundary      |
| `onComplete(parsed)`   | After full response is parsed   |
| `onAvatarState(state)` | On each avatar state transition |
| `onError(err)`         | On non-abort errors             |


---

## 10. LLM Response Format

The model is instructed to follow `RESPONSE_FORMAT_INSTRUCTION` (defined in `systemPrompt.ts`):

```
[Happy:2]
Sure, here's your schedule for tomorrow.

<panel type="calendar">
  <date>2026-03-09</date>
  <event id="e1" type="proposed" title="Team Standup" start="09:00" end="09:30" color="#1a73e8"/>
</panel>

<avatar state="speaking" emotion="Happy" degree="2"/>
<prompts>
What else should I add?
Show me the week view.
</prompts>
```

**Line 1:** `[EMOTION:DEGREE]` — one of:
`Neutral | Happy | Angry | Sad | Surprised | Embarrassed | Curious | Worried | Thinking`
Degree `1`–`3` (intensity).

**Body:** Markdown prose (everything between line 1 and end-tags).

**Panel block:** One `<panel type="TYPE">…</panel>` per response. Must appear before end-tags.

**End-tags section:**

- `<avatar state="STATE" …/>` — state: `idle | speaking | thinking | fetching | error`
- `<tools>TOOL_NAME:JSON_PARAMS</tools>` — one tool request per line
- `<media>image_query:QUERY</media>` — image search queries
- `<prompts>…</prompts>` — suggested follow-up prompts (one per line)

---

## 11. localStorage Keys — Quick Reference


| Key                          | Type                                   | Purpose                           |
| ---------------------------- | -------------------------------------- | --------------------------------- |
| `pc-llm-model`               | `"gpt"` | `"gemini"` | `"claude"`      | Active provider                   |
| `pc-api-openai`              | string                                 | OpenAI API key                    |
| `pc-api-anthropic`           | string                                 | Anthropic API key                 |
| `pc-api-google`              | string                                 | Google API key                    |
| `pc-model-{provider}-{role}` | JSON `{model, maxTokens, temperature}` | Per-provider model config         |
| `pc-use-rule-router`         | `"true"` | `"false"`                   | Router strategy toggle            |
| `pc-tts-provider`            | `"aivis"` | `"browser"` | `"off"`      | TTS engine                        |
| `pc-tts-model`               | string                                 | TTS model id (Aivis)              |
| `pc-prompt-core`             | string                                 | Core instruction override         |
| `pc-prompt-mode`             | string                                 | Mode instruction override         |
| `pc-prompt-persona`          | string                                 | Persona text override             |
| `pc-prompt-temporal`         | string                                 | Temporal context override         |
| `pc-prompt-stm`              | string                                 | STM compression prompt override   |
| `pc-prompt-router`           | string                                 | LLM router system prompt override |
| `pc-stm-data`                | JSON `STMState`                        | Short-term memory state           |
| `pc-ltm-data`                | JSON `LTMData`                         | Long-term memory data             |
| `pc-tasks`                   | JSON `TaskItem[]`                      | Persisted task board items        |
| `pc-avatars`                 | JSON `AvatarData[]`                    | Avatar definitions                |
| `pc-selected-avatar`         | string                                 | Active avatar id                  |
| `pc-selected-costume`        | string                                 | Active costume id                 |
| `pc-google-access-token`     | string                                 | Google OAuth access token         |
| `pc-notion-api-token`        | string                                 | Notion integration token          |
| `pc-svc-{service-id}`        | `"true"`                               | Service enabled flag              |


