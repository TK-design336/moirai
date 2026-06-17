import type {
  ParsedResponse,
  AvatarState,
  TaskPanelData,
  TaskItem,
  TimerActionPayload,
  RemindPayload,
  NotePatchHunk,
  YoutubePlayEntry,
  YoutubeControlEntry,
  YoutubeControlAction,
  UiAction,
} from "../../types/engine";
import type { SpecialPanelData, PanelType } from "../../components/SpecialPanels";
import { PANEL_TYPE_LABELS } from "../../components/SpecialPanels";
import { extractPanel, extractTaskPanel, mergeCalendarInners } from "./panelExtractor";
import { stripHistoryTimestampComments } from "../chat/surfaceLogTimestamp";
import { peelLeadingEmotion, stripNoreadTagsForDisplay } from "../tts/streamSplitter";
import { stripHubMetaTags } from "./hubMetaParse";
import { parseRemindFireAt } from "../inbox/parseRemindFireAt";

const YT_CONTROL_ACTIONS = new Set<YoutubeControlAction>([
  "pause",
  "resume",
  "play",
  "volume_up",
  "volume_down",
]);

function normalizeYoutubeControlAction(raw: string): YoutubeControlAction | undefined {
  const a = raw.trim().toLowerCase() as YoutubeControlAction;
  return YT_CONTROL_ACTIONS.has(a) ? a : undefined;
}

export function parseResponse(raw: string): ParsedResponse {
  // peelLeadingEmotion strips leading emotion; history ts comments stripped again, out, and whole lines.
  const peeled = peelLeadingEmotion(stripHistoryTimestampComments(raw.trim()));
  let text = peeled.text;
  let emotion = peeled.emotion;
  let degree = peeled.degree;

  // 1b. Strip accidental "Body:" label the LLM occasionally emits
  text = text.replace(/^Body:\s*/i, "");

  // 1c. Strip any mid-body emotion tags the LLM generates between paragraphs
  //     (e.g. "...調べてくるね。[EMOTION:Happy]\n\n最新情報を...").
  //     The first-line tag was already handled above; this catches all remaining ones.
  text = text.replace(
    /\[(?:EMOTION:)?(?:Neutral|Happy|Angry|Sad|Surprised|Embarrassed)[^\]]*\]\s*\n?/gi,
    "",
  );

  // 2. Panel blocks: <note>...</note>, <calendar>...</calendar>, etc.
  const PANEL_TYPES = ["calendar","map","transit","email","compare","note","quiz","question","task"] as const;
  let panelData: SpecialPanelData | undefined;
  let taskData: TaskPanelData | undefined;

  // 2a. Direct tags (primary format)
  const panelRe = new RegExp(
    `<(${PANEL_TYPES.join("|")})[\\s>]([\\s\\S]*?)<\\/\\1>`,
    "gi"
  );

  const orderedPanels: { type: string; inner: string }[] = [];
  const panelScan = new RegExp(panelRe.source, panelRe.flags);
  let pm: RegExpExecArray | null;
  while ((pm = panelScan.exec(text)) !== null) {
    orderedPanels.push({ type: pm[1].toLowerCase(), inner: pm[2] });
  }

  for (const { type, inner } of orderedPanels) {
    if (type === "task") {
      const extracted = extractTaskPanel(inner);
      if (extracted.tasks.length > 0) {
        taskData = taskData
          ? { tasks: [...taskData.tasks, ...extracted.tasks] }
          : extracted;
      }
    }
  }

  const firstNonTask = orderedPanels.find((o) => o.type !== "task");
  if (firstNonTask?.type === "calendar") {
    const calInners = orderedPanels.filter((o) => o.type === "calendar").map((o) => o.inner);
    panelData = {
      panelType: "calendar",
      title: PANEL_TYPE_LABELS.calendar,
      payload: mergeCalendarInners(calInners),
    };
  } else if (firstNonTask && firstNonTask.type !== "task") {
    const extracted = extractPanel(firstNonTask.type as PanelType, firstNonTask.inner);
    if (extracted) panelData = extracted;
  }

  text = text.replace(panelRe, () => "");

  // Misplaced one-shot reminders (LLM sometimes uses <task type="reminder" time="..." message="..." />)
  const remindFromMisplacedTask: RemindPayload[] = [];

  // 2a-2. Self-closing <task .../> form — LLM sometimes emits individual tasks without an outer wrapper
  // Always collect (empty <task></task> wrappers must not block self-closing adds).
  const selfClosingTasks: TaskItem[] = [];
  text = text.replace(/<task([^>]*)\/>/gi, (_, attrs) => {
    if (/type\s*=\s*["']reminder["']/i.test(attrs)) {
      const timeMatch = attrs.match(/time=["']([^"']+)["']/i);
      const contentMatch =
        attrs.match(/message=["']([^"']+)["']/i) ??
        attrs.match(/content=["']([^"']+)["']/i);
      const timeText = timeMatch?.[1]?.trim() ?? "";
      const contentText = contentMatch?.[1]?.trim() ?? "";
      if (timeText && contentText && /\d{1,2}:\d{2}/.test(timeText)) {
        const d = parseRemindFireAt(timeText);
        if (d) remindFromMisplacedTask.push({ fireAt: d.toISOString(), content: contentText });
      }
      return "";
    }
    selfClosingTasks.push(...extractTaskPanel(`<task${attrs}/>`).tasks);
    return "";
  });
  if (selfClosingTasks.length > 0) {
    taskData = taskData
      ? { tasks: [...taskData.tasks, ...selfClosingTasks] }
      : { tasks: selfClosingTasks };
  }

  // 2b. Backward-compat: old <panel type="..."> format (session history may still contain it)
  text = text.replace(/<panel type="(\w+)">([\s\S]*?)<\/panel>/g, (_, type, inner) => {
    if (type === "task") {
      if (!taskData) taskData = extractTaskPanel(inner);
    } else if (!panelData) {
      const extracted = extractPanel(type as PanelType, inner);
      if (extracted) panelData = extracted;
    }
    return "";
  });

  // 3. <timer>...</timer> and <alarm .../>
  let timerData: TimerActionPayload | undefined;

  const parseTimerAttrs = (attrs: string, inner: string): TimerActionPayload => {
    const actionMatch = attrs.match(/action=["']([^"']*)["']/i);
    const action = (actionMatch?.[1] ?? "start") as TimerActionPayload["action"];
    const minsMatch =
      inner.match(/<minutes[^>]*>\s*(\d+)\s*<\/minutes>/i) ??
      attrs.match(/minutes=["'](\d+)["']/i);
    const secsMatch =
      inner.match(/<seconds[^>]*>\s*(\d+)\s*<\/seconds>/i) ??
      attrs.match(/seconds=["'](\d+)["']/i);
    return {
      type: "timer",
      action,
      minutes: minsMatch ? parseInt(minsMatch[1], 10) : undefined,
      seconds: secsMatch ? parseInt(secsMatch[1], 10) : undefined,
    };
  };

  text = text.replace(/<timer([^>]*)>([\s\S]*?)<\/timer>/gi, (_, attrs, inner) => {
    timerData = parseTimerAttrs(attrs, inner);
    return "";
  });

  // Self-closing <timer action="pomodoro"/> or <timer action="start" minutes="10" seconds="0"/>
  if (!timerData) {
    text = text.replace(/<timer([^>]*)\/>/gi, (_, attrs) => {
      timerData = parseTimerAttrs(attrs, "");
      return "";
    });
  }

  text = text.replace(/<alarm([^>]*)\/>/gi, (_, attrs) => {
    const timeMatch = attrs.match(/time="([^"]*)"/);
    const labelMatch = attrs.match(/label="([^"]*)"/);
    if (timeMatch) {
      timerData = {
        type: "alarm",
        alarmTime: timeMatch[1],
        alarmLabel: labelMatch?.[1] ?? "",
      };
    }
    return "";
  });

  // 3b. <remind>...</remind> — one-shot Inbox reminder
  const remindItems: RemindPayload[] = [];
  const parseRemindInner = (inner: string): RemindPayload | null => {
    const timeMatch = inner.match(/<time[^>]*>\s*([\s\S]*?)\s*<\/time>/i);
    const contentMatch = inner.match(/<content[^>]*>\s*([\s\S]*?)\s*<\/content>/i);
    const timeText = timeMatch?.[1]?.trim() ?? "";
    const contentText = contentMatch?.[1]?.trim() ?? "";
    if (!timeText || !contentText) return null;
    if (!/\d{1,2}:\d{2}/.test(timeText)) return null;
    const d = parseRemindFireAt(timeText);
    if (!d) return null;
    return { fireAt: d.toISOString(), content: contentText };
  };

  const parseRemindAttrs = (attrs: string): RemindPayload | null => {
    const timeMatch = attrs.match(/time=["']([^"']+)["']/i);
    const contentMatch = attrs.match(/content=["']([^"']+)["']/i);
    const timeText = timeMatch?.[1]?.trim() ?? "";
    const contentText = contentMatch?.[1]?.trim() ?? "";
    if (!timeText || !contentText) return null;
    if (!/\d{1,2}:\d{2}/.test(timeText)) return null;
    const d = parseRemindFireAt(timeText);
    if (!d) return null;
    return { fireAt: d.toISOString(), content: contentText };
  };

  text = text.replace(/<remind([^>]*)>([\s\S]*?)<\/remind>/gi, (_, _attrs, inner) => {
    const item = parseRemindInner(inner);
    if (item) remindItems.push(item);
    return "";
  });
  text = text.replace(/<remind\s+([^>]*)\/>/gi, (_, attrs) => {
    const item = parseRemindAttrs(attrs);
    if (item) remindItems.push(item);
    return "";
  });

  const allRemindItems = [...remindFromMisplacedTask, ...remindItems];
  const remindData: RemindPayload | RemindPayload[] | undefined =
    allRemindItems.length === 0
      ? undefined
      : allRemindItems.length === 1
        ? allRemindItems[0]
        : allRemindItems;

  // 4. <note_patch>...</note_patch>
  const notePatch: NotePatchHunk[] = [];
  text = text.replace(/<note_patch>([\s\S]*?)<\/note_patch>/gi, (_, inner) => {
    const hunkRe = /<hunk\s+start_line="(\d+)"\s+end_line="(\d+)">([\s\S]*?)<\/hunk>/gi;
    let m;
    while ((m = hunkRe.exec(inner)) !== null) {
      notePatch.push({
        startLine: parseInt(m[1], 10),
        endLine: parseInt(m[2], 10),
        newText: m[3],
      });
    }
    return "";
  });

  // 5. <media>...</media>（発話中の Unity 状態は TTS 側が担当）
  const avatarState: AvatarState = "idle";
  const media: string[] = [];
  text = text.replace(/<media>([\s\S]*?)<\/media>/g, (_, inner) => {
    media.push(...inner.trim().split("\n").filter(Boolean));
    return "";
  });

  // 6. <prompts>...</prompts>
  const prompts: string[] = [];
  text = text.replace(/<prompts>([\s\S]*?)<\/prompts>/g, (_, inner) => {
    prompts.push(...inner.trim().split("\n").filter(Boolean));
    return "";
  });

  // 7. <youtube_play kind="music|video">query</youtube_play>
  const youtubePlays: YoutubePlayEntry[] = [];
  text = text.replace(
    /<youtube_play(?:\s+kind="(music|video)")?\s*>([\s\S]*?)<\/youtube_play>/gi,
    (_, kindAttr: string | undefined, inner: string) => {
      const kind = (kindAttr?.toLowerCase() === "music" ? "music" : "video") as YoutubePlayEntry["kind"];
      const query = inner.trim();
      if (query) youtubePlays.push({ kind, query });
      return "";
    },
  );

  // 8. <youtube_control action="pause|..."/>
  const youtubeControls: YoutubeControlEntry[] = [];
  text = text.replace(/<youtube_control\s+action="([^"]*)"\s*\/>/gi, (_, actionRaw: string) => {
    const action = normalizeYoutubeControlAction(actionRaw);
    if (action) youtubeControls.push({ action });
    return "";
  });

  // Image vision end-tag block(s) — strip all; merge duplicate ids from multiple wrappers (model error)
  const imageDescriptionUpdatesRaw: { id: string; text: string }[] = [];
  text = text.replace(/<image_descriptions>([\s\S]*?)<\/image_descriptions>/gi, (_, inner) => {
    const itemRe = /<image\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/image>/gi;
    let im: RegExpExecArray | null;
    while ((im = itemRe.exec(inner)) !== null) {
      const id = im[1].trim();
      const t = im[2].trim();
      if (id) imageDescriptionUpdatesRaw.push({ id, text: t });
    }
    return "";
  });
  const byIdMerge = new Map<string, string>();
  for (const { id, text } of imageDescriptionUpdatesRaw) {
    const prev = byIdMerge.get(id);
    byIdMerge.set(id, prev ? `${prev}\n\n${text}` : text);
  }
  const imageDescriptionUpdates =
    byIdMerge.size > 0 ? [...byIdMerge.entries()].map(([id, t]) => ({ id, text: t })) : [];

  // ui_action (client navigation)
  const uiActions: UiAction[] = [];
  text = text.replace(/<ui_action>([\s\S]*?)<\/ui_action>/gi, (_, inner: string) => {
    const lines = inner
      .trim()
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    for (const line of lines) {
      const low = line.toLowerCase();
      if (low === "open_new_chat") uiActions.push({ type: "open_new_chat" });
      else if (low === "open_inbox") uiActions.push({ type: "open_inbox" });
      else if (low === "open_hub") uiActions.push({ type: "open_hub" });
      else {
        const m = line.match(/^show_log_links:(.*)$/i) ?? line.match(/^open_session:(.*)$/i);
        const q = m?.[1]?.trim();
        if (q) uiActions.push({ type: "show_log_links", query: q });
      }
    }
    return "";
  });

  text = stripNoreadTagsForDisplay(text);
  text = stripHistoryTimestampComments(text);

  const hubStripped = stripHubMetaTags(text);
  text = hubStripped.text;
  let hubMeta: ParsedResponse["hubMeta"] = hubStripped.hubMeta;

  let hubRecallTitle: string | undefined;
  text = text.replace(/<hub_recall\s+title="([^"]*)"\s*\/>/gi, (_, title: string) => {
    const t = title.trim();
    if (t) hubRecallTitle = t;
    return "";
  });

  return {
    emotion,
    degree,
    body: text.trim(),
    avatarState,
    panelData,
    taskData,
    timerData,
    remindData,
    notePatch: notePatch.length > 0 ? notePatch : undefined,
    media,
    prompts,
    citations: [],
    youtubePlays: youtubePlays.length > 0 ? youtubePlays : undefined,
    youtubeControls: youtubeControls.length > 0 ? youtubeControls : undefined,
    imageDescriptionUpdates: imageDescriptionUpdates.length > 0 ? imageDescriptionUpdates : undefined,
    uiActions: uiActions.length > 0 ? uiActions : undefined,
    hubMeta,
    hubRecallTitle,
  };
}
