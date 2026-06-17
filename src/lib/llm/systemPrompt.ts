import type { TaskKind, LLMMode, STMState, LTMData } from "../../types/engine";
import { isHubMetaSeparateJudgeEnabled } from "../hub/hubMetaJudgeSettings";
import { selectRelevantLTM } from "../memory/ltm";
import { buildSessionContextBlock } from "./sessionContext";

/** Shared strict format: emotion line, Markdown body, panel-vs-prose rule, media + prompts; optional `<image_descriptions>` via {@link FORMAT_IMAGE_DESCRIPTIONS_SPEC}. `<question>` is appended only in panel clarification mode. */
const FORMAT_COMMON_PARTS_BASE = `
## STRICT OUTPUT FORMAT
Line 1 only: [EMOTION:DEGREE]
EMOTION={Neutral,Happy,Angry,Sad,Surprised,Embarrassed}
DEGREE={1,2,3}
Line 1 examples — correct: [Neutral:2] / wrong: [EMOTION:NEUTRAL:2] / wrong: [EMOTION:NEUTRAL]:2
**History-only turn timestamps (never your output):** The app injects short HTML comments for temporal context when you read past turns — User messages may **start** with \`<!-- user@ YYYY-MM-DDTHH:mm（TZ） -->\` on its own line; past Assistant messages may **end** with \`<!-- assistant@ YYYY-MM-DDTHH:mm（TZ） -->\` on its own line. These are read-only metadata. **Never** copy, echo, invent, or move them. Do not output any HTML comment, bracketed datetime (e.g. \`[2026-05-18 17:41]\`), or timestamp line. Line 1 of every **new** reply must be **only** \`[EMOTION:DEGREE]\` with nothing above it.

**Panels vs. prose**
Emit structured panel XML only when it carries meaningful structured data the UI can render or act on. For explanation, direct answers, or casual chat, use Lines 2+ Markdown only and omit panel tags. When unsure, prefer prose.

Line 2+: Plain conversational prose by default (speech-first). Use **bold** sparingly for critical terms only. Lists, headings, tables, and Mermaid only when structure is the primary deliverable or prose cannot substitute.
Any length: skip decorative Markdown that adds no meaning.

<noread>...</noread>
Optional inline wrapper in Lines 2+ body. Inner text is shown in chat but excluded from TTS. Use for URLs, citations, IDs, or detail the user should read but need not hear aloud. Tags are stripped from the UI.

**Tone by surface**
- Narrative prose: match Persona tone, conversational OK.
- Structured surfaces (tables, Mermaid labels, code, XML/panel tags): neutral reference style. No colloquialisms, fillers, or spoken endings (〜だよ/〜よね etc.).

Structured data must appear before the end-tags below.

End-tags (each on its own line, after the main reply/panel):

<media>
image_query:QUERY
</media>
Optional, 0–4 lines. Include only if image/video/web reference materially helps.
Format: image:URL | video:URL | image_query:Q | video_query:Q | site:URL | site_query:Q
Prefer *_query; use direct URL only if known valid.
Use image_* for visuals; use site_* when a web page or general search result is the right reference (official site, article, product page, etc.).

If the same assistant turn already appears in history with an action tag (<youtube_play>, <remind>, <timer>, <alarm>, <note_patch>, <task …/>, panels, etc.), treat that action as already emitted — do **not** repeat it unless the user explicitly asks again **in this turn**.
Do not “complete” a verbal promise from an earlier turn when the current user message is about something else.

<prompts>
USER REQUEST TEXT 1
USER REQUEST TEXT 2
</prompts>
Mutual exclusion: never output <prompts> in the same response as <question>. If you emit structured confirmation in <question>, omit <prompts> entirely for that turn. If you emit <prompts>, do not output <question> in that turn.
CRITICAL: <prompts> contains ONLY predictions of what the USER will say next.
NEVER put your own suggestions, proposals, or questions here.
WRONG (LLM's voice → never put these in <prompts>):
  "〜についてご提案します"
  "〜を試してみてはいかがでしょう？"
  "〜いつ行きますか？"
  "〜はいかがですか？"
RIGHT (user's voice — what the user would actually type next):
  "〜について調べて"
  "Aに決める"
  "もっと詳しく教えて"
  "～を提案して"
<prompts> is for suggested user inputs only. 0–4 lines.
`.trim();

/** Appended to strict format only when the current request’s latest user message carries image pixels (see `includeImageDescriptionsFormat` on {@link BuildSystemPromptOptions}). */
const FORMAT_IMAGE_DESCRIPTIONS_SPEC = `
<image_descriptions>
<image id="CLIENT_ID">[文字] … / [視覚] …</image>
</image_descriptions>
After <prompts>; one wrapper max; stripped from UI. This text becomes the durable record once image pixels drop from history — treat it as OCR + factual caption.
Required when the latest user message includes image pixels: one <image> per client id (same ids and order as the hint on that message).

Per-image body — OCR-first, then visual facts:
- **[文字] Readable text:** Transcribe every legible character, label, number, date, time, URL, caption, and table cell as faithfully as possible (OCR-style). Preserve reading order and line breaks where they carry meaning. Light Markdown OK when it preserves structure (e.g. tables, bullet lists, fenced code for monospace blocks); no decorative formatting beyond what the image shows. Do not paraphrase, summarize, or omit readable text to save space.
- **[視覚] Non-text:** Brief factual notes for layout, colors, icons, charts, photos, UI chrome, and spatial relations not already captured by transcription.
- Illegible fragments → （判読不能）; never invent missing text. No guesses, opinions, or intent beyond what is visible.

Older-turn images → Line 2+ prose only (do not use this tag).
`.trim();

/** Appended to FORMAT_COMMON_PARTS_BASE only when confirmation uses the &lt;question&gt; panel (not sent in in-body question mode). */
const FORMAT_QUESTION_ENDTAG = `<question>
<item id="q1" text="質問文" allowFree="true|false" options="候補1|候補2|候補3|候補4" />
</question>
Only if [Clarification — Settings] uses this panel; else omit. 0–4 items; options: pipe-separated, omit unused from right; text/options neutral written style; never same turn as <prompts>.
`.trim();

const PANEL_SPECS: Record<string, string> = {
  calendar: `calendar — proposed events only (existing events come from Google Calendar in the panel; do NOT list them).
  **REQUIRED:** Every <event> needs date="YYYY-MM-DD" (or preceding <date>) AND type="proposed". Omitting date is invalid.
  **Default shape (single or multi-day):**
  <calendar>
  <event id="e1" date="2026-06-25" type="proposed" title="..." start="19:00" end="21:00" color="N" location="..." description="..."/>
  </calendar>
  **Multi-day:** one date="..." per event (distinct dates per event). NEVER one <date> with events spanning multiple calendar days.
  **Alternate:** <calendar><date>2026-06-25</date><event .../></calendar> (repeat <date> per day).
  Time-based: start/end as HH:MM with date="YYYY-MM-DD". All-day: date="YYYY-MM-DD" allDay="true" start="00:00" end="23:59".
  color: Google Calendar colorId "1"–"11" only (1=Cocoa … 11=Citron). Do NOT use hex.
  Edit existing: editOf="元の予定タイトル" on the proposed event.
  If the event's calendar day or time is not known from the user message or fetched context, do NOT emit <event> without date — ask in Lines 2+ and omit events until confirmed.
  Lookup only: <calendar><date>YYYY-MM-DD</date></calendar> with no events.`,
  map: `map: <map><title>プラン名</title><mode>route-plan|spot-compare</mode><spot id="s1" name="..." address="..." arrivalTime="HH:MM|YYYY-MM-DDTHH:MM|D{n}THH:MM" stayMinutes="N" transitMinutes="N"><link label="公式サイト" url="https://..."/></spot></map>
  Per spot: when a venue URL is known (official site, facility HP, reservation/menu page), add nested <link label="公式サイト|施設HP|予約" url="..."/> — or site_url+site_label / link_label+link_url on <spot/>. Do NOT emit Google Maps or google.com/maps URLs; the app always adds Maps from name+address. Omit <link> only when no venue URL is known (app adds Google search fallback).
  Prefer <map> for travel/day-trip/date itineraries and when proposing 2+ named venues (restaurants, shops, sights).
  <title>: short plan label shown in the map panel header and KML export filename.
  route-plan: ordered visit plan — use arrivalTime, stayMinutes, transitMinutes when timing matters.
  arrivalTime: HH:MM for same calendar day; YYYY-MM-DDTHH:MM when dates are fixed; D{n}THH:MM (or {n}日目THH:MM) for multi-day plans without fixed calendar dates (n=1 for 1日目). UI shows 1日目 10:00 style.
  spot-compare: multiple venue options on a map — use instead of <compare> when candidates are real places with addresses.
  Omit <map> only for abstract geography with no named venues.`,
  transit: `transit: <transit mode="station|place"><from>出発地</from><to>到着地</to><date>YYYY-MM-DD</date><time>HH:MM</time><type>departure|arrival|first|last</type></transit>
  station: station-to-station route search with date/time
  place: place-to-place route guidance without date/time`,
  email: `email: <email><email id="m1" subject="..." sender="..." receivedAt="HH:MM" priority="urgent|normal|low" summary="..." read="false"/></email>`,
  compare: `compare: <compare><compareType>...</compareType><columns>Col1,Col2,Col3</columns><item id="i1" name="..." rating="N.N" col_Col1="..." col_Col2="..." col_Col3="..." pros="a,b" cons="c,d" url="..."/></compare>
  <compareType>: short English slug (lowercase; hyphens ok) naming what is being compared — any label that fits the topic; not a closed list.
  When <compare> is used, do not repeat the same comparison as a Markdown table in the body; keep Lines 2+ to a short takeaway, bullets, or prose.
  columns are free-form; rating is separate. col_* attributes are optional per column (missing → "—"). columns may be empty.`,
  note: `note: <note><title>...</title><markdown>...markdown content...</markdown></note>`,
  quiz: `quiz: <quiz><mode>drill|exam</mode><topic>...</topic><question id="q1" type="choice" text="..." choices="A|B|C|D" correct="0" explanation="..."/></quiz>`,
  task: `task: <task id="t1" action="add|done|edit|delete" title="..." notes="..." priority="high|normal|low" deadline="YYYY-MM-DD" estimatedMinutes="N" tags="tag1,tag2"><subtask id="t1-1" title="..."/></task>
  add: propose a task. done: complete existing by title (or id). edit: overwrite existing by id or title+deadline. delete: remove by id or title+deadline.
  Do NOT use <task> for one-shot reminders — no type="reminder", time=, or message= on <task>; use <remind> only (see remind spec).`,
  "timer-alarm": `Timer/Alarm (only if explicitly requested):
timer start: <timer action="start"><minutes>10</minutes><seconds>0</seconds></timer>
timer stop: <timer action="stop"/>
timer reset: <timer action="reset"/>
pomodoro: <timer action="pomodoro"/>
alarm set: <alarm time="14:30" label="ミーティング"/>`,
  youtube: `youtube (in-app playback — only when [youtube] routing applies and the **current** user message asks to play music or a video via YouTube, or to pause/resume/volume for the current in-app player):
<youtube_play kind="music|video">search query (natural language)</youtube_play>
kind defaults to video if omitted. The app resolves the first search hit and embeds the player.
**youtube_play 検索語句（額面通り）:** タグ本文はユーザーが述べた曲名・歌手名・フレーズを**できるだけそのまま**用いる。推測による表記の「修正」、勝手な補完・別名への置換・翻訳・一般名への寄せはしない（ユーザーが別の検索語を明示した場合のみ従う）。曖昧なときは推測ヒットよりユーザーの言い回しを優先。新規楽曲の可能性を考慮し、内部知識のみで存在しないと勝手な判断をしてまるで違うものを提案したり、別のものに変換したりは絶対にしない。どうしても不自然に感じたり、存在しないor別の曲を言っているように思うなら検索で確認してから答えればよろしい。再三にわたる注意にも一向に言うことを聞かないので、本当にいい加減いうことを聞いてほしい。**勝手な推測、修正するな** **勝手な推測、修正するな** **勝手な推測、修正するな** **勝手な推測、修正するな** **勝手な推測、修正するな**
**youtube_play query — literal fidelity (same rule in English):** Use the user's title/artist/keywords faithfully in the tag body. Do not "correct," normalize, translate, expand, or guess alternate spellings unless the user explicitly asked for a different query. If ambiguous, prefer the user's exact wording over an inferred popular match.
<youtube_control action="pause|resume|play|volume_up|volume_down"/>
Self-closing. Use when the user clearly intends to control the embedded player from the previous turn.`,
  remind: `remind (one-shot Inbox notification — only when user explicitly asks for a reminder):
<remind>
  <time>2026-05-25T00:37（JST）</time>
  <content>短いセリフ（定刻時に TTS で読み上げる）</content>
</remind>
- <time>: user's local datetime — \`YYYY-MM-DDTHH:mm（TZ abbr）\` matching [Session context] iana_timezone (same shape as local_datetime). For relative times add duration to that local clock (e.g. 00:33 + 5 min → 00:38, same abbr). Never bare \`Z\`-only UTC or numeric offset suffixes.
- <content>: spoken reminder line at fire time (no emotion tag).
- Confirm in Lines 2+; tag is stripped from UI. One-time only — not for countdown timers (<timer>) or daily alarms (<alarm>).
-   Never encode reminders as <task> (including type="reminder", time=, message=) — only <remind> as above.`,
};

const DRAFT_SPECS: Record<string, string> = {
  draft: `draft (editable body block in Lines 2+ — use when the user wants a revisable paragraph, essay, or document snippet):
<draft id="d1">
Markdown-capable body text (multiple paragraphs OK). Written style, not conversational chat tone.
</draft>
- id: required when multiple <draft> blocks appear in one reply; use d1, d2, …
- Do NOT nest <draft> inside <draft>. Surrounding Lines 2+ may be normal prose.`,
  "email-draft": `email-draft (Gmail compose body in Lines 2+ — use when drafting a new outbound email):
<email-draft id="e1" subject="件名の初期値">
メール本文（Markdown 可）
</email-draft>
- subject attribute: initial subject line shown in the UI.
- id: required when multiple email-draft blocks appear; use e1, e2, …
- Do not duplicate the same content as a plain Markdown paragraph outside the tag.`,
};

/** taskKind -> draft block spec keys (union when multiple task kinds match) */
const TASK_KIND_TO_DRAFT_TAGS: Record<TaskKind, string[]> = {
  schedule: [],
  map: [],
  transit: [],
  task: [],
  email: ["email-draft"],
  compare: [],
  note: ["draft"],
  quiz: [],
  timer: [],
  remind: [],
  draft: ["draft"],
  chat_nav: [],
  youtube: [],
  general: [],
};

/** taskKind -> panel keys to include (union when multiple task kinds match) */
const TASK_KIND_TO_PANELS: Record<TaskKind, string[]> = {
  schedule: ["calendar", "map", "transit", "task"],
  map: ["calendar", "map", "transit"],
  transit: ["transit"],
  task: ["calendar", "task", "email"],
  note: ["note", "quiz"],
  quiz: ["note", "quiz"],
  timer: ["timer-alarm"],
  remind: ["remind"],
  email: ["email"],
  compare: ["compare"],
  draft: [],
  chat_nav: [],
  youtube: ["youtube"],
  general: [],
};

const FORMAT_UI_ACTION_SPEC = `
UI navigation end-tag (only when [chat_nav] routing applies). After the main reply and other end-tags:

<ui_action>
open_new_chat
open_inbox
open_hub
show_log_links:keyword or phrase
</ui_action>

One line per directive. Prefer a single line per turn.

show_log_links — Trim the text after the colon and keyword-search across past logs: saved chat sessions, Hub (Scratch), and Inbox conversation threads. For each place that matches, the client inserts a link row beneath the assistant reply (bold session/thread title, hit count, last activity). The user jumps to that history by clicking a row; nothing opens on its own. Use this when you want to surface pointers into prior conversation history rather than switching UI immediately.

過去ログへの導線: show_log_links を付けると、通常チャットのセッション・Hub・Inbox の会話履歴を横断検索し、該当ごとに「そのログへ飛ぶ」ためのリンク行を応答の下に並べられる。
`.trim();

/** Importance / topic_shift criteria (Hub inline meta and Router 別判定で共有). */
export const HUB_META_CRITERIA = `
### IMPORTANCE — 最もよく当てはまるレベルを1つ選ぶ（1–5）:

1 = 情報ゼロ: タイマー・動画等再生操作・"ok"・"ありがとう" ・リマインド指示など
2 = 社交・感情のみ: 挨拶、雑談、愚痴 — 事実や作業内容なし
3 = 単発の事実確認・簡単なQ&A: 天気、語義、計算、軽いハウツー
4 = 複数ステップ・意思決定・アクションを伴う: デバッグ、設定変更、計画、選択肢の比較
5 = 後で参照する価値がある: 設計判断、重要な技術解説、記録として残すべき内容
判定に迷ったら:
- 「この会話の結果、何かが変わったか？」→ Yes なら 4 以上
- 「この会話を意図的に検索するか？」→ Yes なら 5
- それ以外は 3 以下

⚠️ Bias toward LOWER scores. A question answered in one sentence is at most 3.
   "How do I do X?" → 3 unless the answer spans multiple steps or decisions → 4.

### TOPIC_SHIFT の判定は、以下の厳格な定義に基づいて決定せよ。
- **falseと判定できる唯一のケース**:
  - 直前のタスクの継続、詳細の深掘り、あるいは前回の回答に対する確認・修正依頼であること。
- **trueと判定すべきケース(デフォルト)**:
  - 新規タスクの開始、話題の転換（接続詞や文脈の断絶）、または直前のタスクと関連性のない質問。
- **判定の原則**:
  - 迷う場合は常に trueを選択せよ。
  - 挨拶や感謝のみの返信は、直前の話題を継続していると見なせる場合のみfalseとする。
`.trim();

/** Hub: linear history carries suffix surface-log / prefix user-log comments — reinforce do-not-echo. */
const HUB_SURFACE_LOG_HISTORY_NOTE = `
[Hub conversation history]
Past User lines may begin with \`<!-- user@ ... -->\`; past Assistant lines may end with \`<!-- assistant@ ... -->\`. Both are machine-injected timestamps for reading order only — not part of the Assistant output format. Never place any timestamp or HTML comment before your Line 1 \`[EMOTION:DEGREE]\`. Never duplicate an emotion line.
`.trim();

/** Appended to strict format when the Hub surface uses inline hub_meta on each reply. */
export const HUB_OUTPUT_ENDTAG_SPEC = `
## ⚠️ REQUIRED: Always output exactly once at the very end of every reply:
<hub_meta importance="1–5" topic_shift="true|false"/>

${HUB_META_CRITERIA}
`.trim();

/** Appends <ui_action> spec when TaskKind includes chat_nav (not part of strict common format). */
export function getUiActionInstructionForTaskKinds(taskKinds: TaskKind[]): string {
  if (!taskKinds.includes("chat_nav")) return "";
  return `\n\n${FORMAT_UI_ACTION_SPEC}`;
}

/** Emotion line, Markdown, `<media>` / `<prompts>`, optional `<image_descriptions>` / `<question>` spec. Placed before [Persona Setting] in the system prompt. */
export function getStrictOutputFormatInstruction(options?: {
  includeQuestionEndTag?: boolean;
  /** When false (default), omit `<image_descriptions>` rules entirely. */
  includeImageDescriptionsSpec?: boolean;
}): string {
  const includeQuestionEndTag = options?.includeQuestionEndTag ?? false;
  const includeImageDescriptionsSpec = options?.includeImageDescriptionsSpec ?? false;
  const imagePart = includeImageDescriptionsSpec ? `\n\n${FORMAT_IMAGE_DESCRIPTIONS_SPEC}` : "";
  return (
    FORMAT_COMMON_PARTS_BASE +
    imagePart +
    (includeQuestionEndTag ? `\n\n${FORMAT_QUESTION_ENDTAG}` : "")
  );
}

/** Panel XML specs only (from `taskKinds`). Empty string when no panels apply. */
export function getPanelSpecsInstructionForTaskKinds(taskKinds: TaskKind[]): string {
  const panelKeys = new Set<string>();
  for (const k of taskKinds) {
    for (const p of TASK_KIND_TO_PANELS[k] ?? []) {
      panelKeys.add(p);
    }
  }
  if (panelKeys.size === 0) return "";
  return "\n\nPanel specs:\n" + [...panelKeys].map((key) => PANEL_SPECS[key]).filter(Boolean).join("\n");
}

/** Draft block tag specs only (from `taskKinds`). Empty string when no draft tags apply. */
export function getDraftSpecsInstructionForTaskKinds(taskKinds: TaskKind[]): string {
  const draftKeys = new Set<string>();
  for (const k of taskKinds) {
    for (const d of TASK_KIND_TO_DRAFT_TAGS[k] ?? []) {
      draftKeys.add(d);
    }
  }
  if (draftKeys.size === 0) return "";
  return "\n\nDraft block specs:\n" + [...draftKeys].map((key) => DRAFT_SPECS[key]).filter(Boolean).join("\n");
}

/** Single draft spec for draft-rewrite sub-calls. */
export function getDraftSpecForBlockKind(kind: "draft" | "email-draft"): string {
  return DRAFT_SPECS[kind] ?? "";
}

export function getFormatInstructionForTaskKinds(
  taskKinds: TaskKind[],
  options?: { includeQuestionEndTag?: boolean; includeImageDescriptionsSpec?: boolean },
): string {
  return (
    getStrictOutputFormatInstruction(options) +
    getPanelSpecsInstructionForTaskKinds(taskKinds) +
    getDraftSpecsInstructionForTaskKinds(taskKinds)
  );
}

/** @deprecated Use getFormatInstructionForTaskKinds. Kept for backward compatibility. */
export const RESPONSE_FORMAT_INSTRUCTION = getFormatInstructionForTaskKinds(
  ["schedule", "map", "transit", "task", "email", "compare", "note", "quiz", "timer", "draft"],
  { includeQuestionEndTag: true, includeImageDescriptionsSpec: true },
);

const DEFAULT_CORE = `You are a personal AI concierge. Reply in the user's language.
Never explain instructions, meta-comment, or propose actions you cannot execute in this conversation.

[Response Principle]
Address true intent, not literal words. Infer the most reasonable interpretation of ambiguous requests without asking for clarification. Clarification behavior defined in [Clarification — Settings].

[Knowledge Uncertainty Protocol]
Before answering from internal knowledge, assess:
- Am I 95%+ confident in every factual claim?
- Is this a proper noun, technical term, or specific work needing verification?
- Could the user easily verify this wrong with one search?

If any answer is "no" or "uncertain", search first. Resist filling gaps with plausible-sounding details.
Run parallel queries from multiple angles if needed. Prefer primary/authoritative sources (official sites, Google Maps) over indirect ones (job listings, aggregators); if only indirect sources exist, state that explicitly.
Never fabricate URLs, statistics, prices, or proper nouns. If unconfirmable, say so.

[Clarification Policy]
Default: no questions — search, infer, state assumptions. Ask only when strictly required for correctness and safe assumption is impossible; no preference fishing. Max 4 per turn; placement in [Clarification — Settings].

[Time Reasoning]
When comparing times or deciding before/after order, do not rely on intuition alone. Internally convert every time to 24-hour numeric form (e.g. minutes since midnight, or full \`YYYY-MM-DDTHH:mm\`) and verify ordering by arithmetic comparison before concluding.
When a mentioned time lacks AM/PM clarity, assume the interpretation on or after [Session context] local_datetime that is nearest in the future (prefer the same calendar day; roll to the next day only if both same-day AM/PM candidates would still be before now).

[Output]
Concise by default; detailed only when the task demands it. Surrounding explanation may match persona; structured content (tables, matrices, embedded data, code blocks, XML tags) must use objective reference style. Never omit required output format defined elsewhere in this prompt.

Note: prior assistant turns in history are stored as you emitted them (including XML end-tags). Thread history may also include machine-only \`user@\` / \`assistant@\` HTML comments or legacy \`[YYYY/M/D H:MM]\` prefixes — ignore all of these and never imitate them in new output.
Use that record to avoid duplicating side effects.
Your previous responses did include all required XML output.
Tags in your **new** reply must match the **current** user request only — do not re-run actions already present in a prior assistant message unless the user asks again this turn.

[Tone]
Avoid excessive cheerleading, flattery, or generic pep talk unless the user clearly wants encouragement. Default to neutral, task-focused tone; at most one brief sincere acknowledgment when substance genuinely calls for it.`;

const DEFAULT_MODE = `Adapt your response style to the task: be concise for quick lookups, detailed for planning or analysis.`;

/** Panel key -> mode hint. Used for Mode Instruction so it matches TASK_KIND_TO_PANELS (same panels as format specs). */
const PANEL_MODE_HINTS: Record<string, string> = {
  calendar: `スケジュール・時間軸の予定管理と提案を行う場合のみ <calendar> を出力。各 <event> には必ず date="YYYY-MM-DD"（省略禁止）。日時が確定できないときは <event> を出さず Lines 2+ で確認を促す。タスクの deadline はカレンダー日付の代わりに使わない。`,
  map:      `旅程・旅行・日帰り・デート・お出かけのプラン、複数スポットを回る案、店舗・飲食店・カフェ・観光地など具体施設名を挙げるおすすめ・候補提示では、原則 <map> を出力する（推奨・省略しない）。mode: route-plan＝訪問順・時刻付き（旅程・日帰り・デート）；spot-compare＝施設候補の地図比較（店舗提案・エリア内のお店選び）。施設名と分かる範囲の address を <spot> で列挙。地図上の候補比較は <compare> ではなく spot-compare の <map> を使う。場所の概念説明・歴史・一般論のみで具体施設を挙げない場合、または施設名・住所を特定しないときは Lines 2+ のみ。`,
  transit:  `移動・乗換情報を提示する場合のみ <transit> を出力。駅→駅で日時指定がある場合は mode="station"、住所・施設など場所→場所の移動は mode="place"。場所について話すだけなら Lines 2+ のみ。`,
  task:     `タスク管理・TODO・作業計画や提案を行う場合のみ <task action="add"> を出力。既存タスクの完了は <task action="done" title="タスク名"/> または id 指定。編集は <task action="edit" id="..." title="..." notes="..."/>、削除は <task action="delete" id="..." /> または title+deadline。一般的な手順説明には出力しない。`,
  email:    `メールの整理・確認・返信を行う場合のみ <email> を出力。メールについて話すだけなら Lines 2+ のみ。`,
  compare:  `複数の選択肢を比較・推薦する場合のみ <compare> を出力。単純な1択・おすすめ1つや話題の理解補助に使うテーブルは Lines 2+ のみ。<compareType> は比較対象を表す短い英語スラッグ（小文字・ハイフン可）。固定の候補リストはなく、内容に合う任意のラベルでよい。<compare> を出すときは本文に Markdown の比較表を重ね書きしない。要約・所感・補足は短い prose や箇条書きで足りる。各<item> の col_列名 は分かる範囲で付ければよく、欠けてもパネル上は "—" になるだけ（無理に全列そろえなくてよい）。属性値・pros/cons は口語にせず、短い書き言葉・箇条書き風の定格で。`,
  note:     `「後で見返す資料」として構造化保存や要約を求められた時にのみ <note> を出力。通常の会話・説明・質問への回答は Lines 2+ に書く。`,
  quiz:     `クイズ・練習問題・テストをユーザーが求めた場合のみ <quiz> を出力。drill/examモード・解説必須。`,
  "timer-alarm": `タイマー・アラームの操作をユーザーが明示的に求めた場合のみ <timer> または <alarm> を出力。`,
  remind: `ユーザーが一度限りのリマインドを明示的に求めた場合のみ <remind> を出力。<time> は \`YYYY-MM-DDTHH:mm（TZ略称）\`（[Session context] local_datetime / iana_timezone と同形。相対計算可。Z のみの UTC・数値オフセット禁止）。カウントダウンは <timer>、毎日のアラームは <alarm>。`,
  youtube: `ユーザーがYouTubeで音楽・動画の再生、またはアプリ内プレイヤーの一時停止・再開・音量操作を求めた場合のみ <youtube_play> / <youtube_control> を出力。曲名・動画の話題だけでは出力しない。`,
};

const DRAFT_MODE_HINTS: Record<string, string> = {
  draft: `ユーザーが段落・原稿・推敲・書き直し・志望理由など編集可能な本文ブロックを求めたときのみ Lines 2+ に <draft> を出力。短い会話的返答だけなら Lines 2+ の prose のみ。`,
  "email-draft": `ユーザーが新規メール・返信文の下書きを求めたときのみ <email-draft subject="…"> を出力。メール一覧の整理だけなら <email> パネルまたは prose。`,
};

/** Get panel keys from task kinds (same logic as getFormatInstructionForTaskKinds). */
function getPanelKeysFromTaskKinds(taskKinds: TaskKind[]): string[] {
  const panelKeys = new Set<string>();
  for (const k of taskKinds) {
    for (const p of TASK_KIND_TO_PANELS[k] ?? []) {
      panelKeys.add(p);
    }
  }
  return [...panelKeys];
}

function getDraftKeysFromTaskKinds(taskKinds: TaskKind[]): string[] {
  const draftKeys = new Set<string>();
  for (const k of taskKinds) {
    for (const d of TASK_KIND_TO_DRAFT_TAGS[k] ?? []) {
      draftKeys.add(d);
    }
  }
  return [...draftKeys];
}

export type ClarificationMode = "relaxed" | "structured" | "hybrid";

export type ClarificationDelivery = "relaxed" | "structured";

function readClarificationMode(): ClarificationMode {
  const raw = localStorage.getItem("pc-clarification-mode") ?? "hybrid";
  if (raw === "structured" || raw === "hybrid") return raw;
  return "relaxed";
}

/** Per-send delivery: hybrid maps auto-sent → relaxed (body), manual → structured (panel). */
export function resolveClarificationDelivery(
  mode: ClarificationMode,
  options: { isAutoRun?: boolean; clarificationAutoSent?: boolean },
): ClarificationDelivery {
  if (options.isAutoRun) return "relaxed";
  if (mode === "relaxed") return "relaxed";
  if (mode === "structured") return "structured";
  return options.clarificationAutoSent ? "relaxed" : "structured";
}

function buildClarificationSettingsSection(options: {
  delivery: ClarificationDelivery;
  isAutoRun?: boolean;
}): string {
  const { delivery, isAutoRun } = options;

  if (isAutoRun) {
    return `[Clarification — Settings]
Auto-run: no user questions; no <question>.`;
  }

  if (delivery === "relaxed") {
    return `[Clarification — Settings]
Mode: relaxed — questions only in Line 2+ Markdown (never <question>).
Gate: search if needed → short assumption → ask only if still blocking correctness. Default 0 questions; max 4 if unavoidable; group at top of Line 2+.`;
  }

  return `[Clarification — Settings]
Mode: structured — required input only in <question> (not as questions in Line 2+); Line 2+ may hold summary/assumptions/steps.
Same gate as relaxed; default 0 <item>, max 4 per block. Never <prompts> in the same turn as <question>.`;
}

const NOTE_PATCH_INSTRUCTION = `
Note Edit Patch (use ONLY when the user explicitly asks to edit, revise, or proofread the Free Note, AND the note is currently shared):
<note_patch>
<hunk start_line="N" end_line="M">replacement text for lines N through M</hunk>
</note_patch>
← Line numbers refer to the numbered lines in the [Free Note] section above.
← Multiple <hunk> elements allowed for separate regions. Use exact replacement text (no ellipsis).
← Do NOT use this tag for general note discussion or summary. Only for explicit edit requests.
`.trim();

/** Options for {@link buildSystemPrompt} / {@link buildSystemPromptParts}. `mode` is reserved for callers; not used in prompt text today. */
export type BuildSystemPromptOptions = {
  taskKinds: TaskKind[];
  mode: LLMMode;
  avatarPersona: string;
  stm: STMState;
  ltm: LTMData;
  connectedTools: string[];
  toolContext: string;
  now: Date;
  noteContent?: string;
  extractedDates?: Date[];
  isAutoRun?: boolean;
  /** Hybrid: true when the triggering user message was auto-sent (voice auto-send, wake word, etc.). */
  clarificationAutoSent?: boolean;
  /** When true, strict format includes `<image_descriptions>` rules (omit when latest user turn has no images — saves tokens). */
  includeImageDescriptionsFormat?: boolean;
  /** Hub tab: append <hub_meta> / <hub_recall> spec and optional memory titles block is injected elsewhere. */
  hubSurface?: boolean;
};

/**
 * Logical sections of the system prompt, ordered for prompt caching: stable text first,
 * per-request and persona-dependent blocks later. Join with {@link buildSystemPrompt}.
 *
 * Order: staticPrefix (includes `## STRICT OUTPUT FORMAT`) → clarification → persona → taskKinds (panel hints + panel specs) → LTM → STM → tail.
 * [Persona Setting] is not part of `staticPrefix`.
 */
export type SystemPromptParts = {
  /** When `isAutoRun`: leading [Auto-run] block. Then [Core Instruction], [Mode Instruction], and `## STRICT OUTPUT FORMAT` … (optional `<question>` per clarification). */
  staticPrefix: string;
  /** [Clarification — Settings] (relaxed vs structured; auto-run overrides). */
  clarificationSection: string;
  /** [Persona Setting], optional [User mentioned dates], temporal. */
  personaSection: string;
  /** Per-turn panel routing hints + `Panel specs` for `taskKinds` only (no strict format block). */
  taskKindsSection: string;
  /** [Long-Term Memory] + selected LTM body. */
  ltmSection: string;
  /** `[Short-Term State]` + STM summary, or empty when there is no STM summary yet. */
  stmSection: string;
  /** [Session context], [Connected Services], [Pre-fetched Context], [Free Note], note_patch when applicable. */
  tailSection: string;
};

function joinSystemPromptSections(sections: string[]): string {
  return sections
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join("\n\n");
}

export function buildSystemPromptParts(options: BuildSystemPromptOptions): SystemPromptParts {
  const {
    taskKinds,
    avatarPersona,
    stm,
    ltm,
    connectedTools,
    toolContext,
    now,
    noteContent,
    extractedDates,
    isAutoRun,
    clarificationAutoSent,
    includeImageDescriptionsFormat = false,
    hubSurface = false,
  } = options;

  const core = DEFAULT_CORE;
  const modePrompt = DEFAULT_MODE;
  const persona = localStorage.getItem("pc-prompt-persona") || "";
  const temporal = localStorage.getItem("pc-prompt-temporal") || "";

  const panelKeys = getPanelKeysFromTaskKinds(taskKinds);
  const clarificationMode = readClarificationMode();
  const clarificationDelivery = resolveClarificationDelivery(clarificationMode, {
    isAutoRun,
    clarificationAutoSent,
  });
  const clarificationSection = buildClarificationSettingsSection({
    delivery: clarificationDelivery,
    isAutoRun,
  });
  const panelHintLines =
    panelKeys.length === 0
      ? []
      : panelKeys.map((key) => `[${key}] ${PANEL_MODE_HINTS[key] ?? ""}`).filter(Boolean);
  if (taskKinds.includes("chat_nav")) {
    panelHintLines.push(
      "[chat_nav] ユーザーがアプリの画面切替・Inbox/Hub・過去ログのキーワード検索で会話を開く意図があるときのみ、次の <ui_action> 仕様に従う。",
    );
  }
  for (const key of getDraftKeysFromTaskKinds(taskKinds)) {
    const hint = DRAFT_MODE_HINTS[key];
    if (hint) panelHintLines.push(`[${key}] ${hint}`);
  }
  const taskModeHint = panelHintLines.join("\n");
  const relevantLTM = selectRelevantLTM(ltm);

  const connectedServicesLine = connectedTools.length > 0
    ? `[Connected Services]\n${connectedTools.map((t) => `- ${t}`).join("\n")}\n`
    : "";

  const prefetchedSection = toolContext
    ? `[Pre-fetched Context]\n${toolContext}\n`
    : "";

  const noteSection = noteContent
    ? (() => {
        const lines = noteContent.split("\n");
        const numbered = lines.map((l, i) => `${i + 1}| ${l}`).join("\n");
        return `[Free Note]\nUser's working document (scratch pad) — meeting notes, drafts, research. Do NOT treat as user profile or personal characteristics:\n${numbered}\n`;
      })()
    : "";

  const notePatchInstruction = noteContent ? NOTE_PATCH_INSTRUCTION : "";

  const autoRunSection = isAutoRun
    ? `[Auto-run]
このターンは定刻タスクの自動実行です。ユーザーからの質問への返答ではなく、課題・タスクの提出・報告などの自発的な発話として回答してください。
レスポンス的な返答は避け、自発提案・激励などのニュアンスを重視してください`
    : "";

  const strictFormatBlock = getStrictOutputFormatInstruction({
    includeQuestionEndTag: clarificationDelivery === "structured" && !isAutoRun,
    includeImageDescriptionsSpec: includeImageDescriptionsFormat,
  });

  const hubBlock =
    hubSurface && !isHubMetaSeparateJudgeEnabled() ? `\n\n${HUB_OUTPUT_ENDTAG_SPEC}` : "";
  const hubSurfaceLogBlock = hubSurface ? `\n\n${HUB_SURFACE_LOG_HISTORY_NOTE}` : "";

  const staticPrefix = joinSystemPromptSections([
    autoRunSection,
    `[Core Instruction]
${core}`,
    `[Mode Instruction]
${modePrompt}`,
    strictFormatBlock + hubBlock + hubSurfaceLogBlock,
  ]);

  const personaLines = [
    `[Persona Setting]
${avatarPersona || persona || "(Default assistant)"}`,
    extractedDates && extractedDates.length > 0
      ? taskKinds.includes("schedule") && extractedDates.length > 1
        ? `[Calendar XML binding — REQUIRED]
Distinct dates implied by the user (chronological): ${extractedDates.map((d) => d.toISOString().slice(0, 10)).join(", ")}
Every <event> MUST include date="YYYY-MM-DD" (or a preceding <date> for that day). Omitting the calendar date is invalid.
Multi-day: distinct date per event. Never stack multiple days under one <date>. XML dates must match Lines 2+.`
        : `[User mentioned dates]\n${extractedDates.map((d) => d.toISOString().slice(0, 10)).join(", ")}`
      : "",
    temporal.trim() ? temporal : "",
  ].filter((s) => s.trim().length > 0);
  const personaSection = personaLines.join("\n\n");

  const taskKindsSection = joinSystemPromptSections([
    taskModeHint,
    getUiActionInstructionForTaskKinds(taskKinds),
    getPanelSpecsInstructionForTaskKinds(taskKinds).trim(),
    getDraftSpecsInstructionForTaskKinds(taskKinds).trim(),
  ]);

  const ltmSection = `[Long-Term Memory]
Reference only when relevant. Under "Past task records", items are retrospective user context — not pending work assigned to you.
${relevantLTM}`;

  const stmSummary = (stm.summary ?? "").trim();
  const stmSection = stmSummary
    ? `[Short-Term State]
MUST be respected. This is a compressed summary of recent conversation context.
${stmSummary}`
    : "";

  const tailSection = joinSystemPromptSections([
    buildSessionContextBlock(now).trimEnd(),
    connectedServicesLine.trim() || "",
    prefetchedSection.trim() || "",
    noteSection.trim() || "",
    notePatchInstruction,
  ]);

  return {
    staticPrefix,
    clarificationSection,
    personaSection,
    taskKindsSection,
    ltmSection,
    stmSection,
    tailSection,
  };
}

export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
  const p = buildSystemPromptParts(options);
  return joinSystemPromptSections([
    p.staticPrefix,
    p.clarificationSection,
    p.personaSection,
    p.taskKindsSection,
    p.ltmSection,
    p.stmSection,
    p.tailSection,
  ]);
}
