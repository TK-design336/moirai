import { normalizeColorToHex } from "../tools/calendarColors";
import type {
  CalendarPayload, CalendarEvent, CalendarDaySlice,
  MapPayload, MapSpot,
  TransitPayload,
  EmailPayload, EmailItem, EmailPriority,
  ComparePayload, CompareItem, CompareType,
  NotePayload,
  QuizPayload, QuizQuestion, QuizMode,
  QuestionPayload,
  QuestionItem,
  SpecialPanelData, PanelType,
} from "../../components/SpecialPanels";
import type { TaskPanelData, TaskItem } from "../../types/engine";
import { PANEL_TYPE_LABELS } from "../../components/SpecialPanels";
import { extractMapSpotLinksFromTag } from "../map/mapSpotLinks";

/* ---- attribute helpers ---- */

function attr(tag: string, name: string, fallback = ""): string {
  // Use plain string search to avoid regex issues with special chars in attribute names
  // (e.g. column names like "入力($1M)" contain (, $, ) which break RegExp patterns)
  const needle = name + '="';
  let pos = tag.indexOf(needle);
  while (pos !== -1) {
    const before = pos === 0 ? ' ' : tag[pos - 1];
    if (/[\s>]/.test(before)) {
      const valStart = pos + needle.length;
      const valEnd = tag.indexOf('"', valStart);
      return valEnd === -1 ? fallback : tag.slice(valStart, valEnd);
    }
    pos = tag.indexOf(needle, pos + 1);
  }
  return fallback;
}

function innerText(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  return m ? m[1].trim() : "";
}

function allTags(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}([^>]*?)(?:/>|>([\\s\\S]*?)<\\/${tag}>)`, "g");
  const results: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    results.push(m[0]);
  }
  return results;
}

/* ---- Calendar ---- */

function isDateLike(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}/.test(s);
}

function extractDateFromEventTag(tag: string): string | undefined {
  const dateAttr = attr(tag, "date");
  if (dateAttr && /^\d{4}-\d{2}-\d{2}/.test(dateAttr)) return dateAttr.slice(0, 10);
  const start = attr(tag, "start", "");
  const iso = start.match(/^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}/);
  if (iso) return iso[1];
  if (/^\d{4}-\d{2}-\d{2}$/.test(start)) return start;
  return undefined;
}

function calendarEventFromTag(tag: string): CalendarEvent {
  const startRaw = attr(tag, "start", "09:00");
  const endRaw = attr(tag, "end", "10:00");
  const eventDate = extractDateFromEventTag(tag);
  const start = eventDate && /^\d{4}-\d{2}-\d{2}T/.test(startRaw)
    ? startRaw.slice(11, 16)
    : startRaw;
  const end = eventDate && /^\d{4}-\d{2}-\d{2}T/.test(endRaw)
    ? endRaw.slice(11, 16)
    : endRaw;
  const allDayAttr = attr(tag, "allDay", "").toLowerCase();
  const allDay = allDayAttr === "true" || allDayAttr === "1" || isDateLike(start) || isDateLike(end);
  const colorAttr = attr(tag, "color", "1");
  const colorId = /^[1-9]|1[01]$/.test(colorAttr) ? colorAttr : undefined;
  const editOf = attr(tag, "editOf") || undefined;
  return {
    id: attr(tag, "id", `e-${Math.random()}`),
    title: attr(tag, "title", "Untitled"),
    start,
    end,
    color: normalizeColorToHex(colorAttr),
    colorId,
    editOf: editOf || undefined,
    type: (attr(tag, "type", "proposed") as CalendarEvent["type"]),
    description: attr(tag, "description") || undefined,
    location: attr(tag, "location") || undefined,
    allDay: allDay || undefined,
  };
}

function groupEventsByPerEventDate(eventTags: string[], fallbackToday: string): CalendarDaySlice[] | null {
  const perEventDates = eventTags.map(extractDateFromEventTag);
  if (!perEventDates.some(Boolean)) return null;

  const dayMap = new Map<string, CalendarEvent[]>();
  for (let i = 0; i < eventTags.length; i++) {
    const ev = calendarEventFromTag(eventTags[i]!);
    const d = perEventDates[i] ?? fallbackToday;
    const prev = dayMap.get(d) ?? [];
    dayMap.set(d, [...prev, ev]);
  }
  const sortedKeys = [...dayMap.keys()].sort();
  return sortedKeys.map((date) => ({ date, events: dayMap.get(date)! }));
}

/**
 * 日付の解決優先順位:
 * 1. 各 `<event date="YYYY-MM-DD">` または `start="YYYY-MM-DDTHH:MM"`
 * 2. 複数 `<date>` ブロック（直後～次 date 直前の event）
 * 3. 単一 `<date>` + event 群
 */
function extractCalendarDaySlices(inner: string): CalendarDaySlice[] {
  const trimmed = inner.trim();
  const fallbackToday = new Date().toISOString().slice(0, 10);
  const eventTags = allTags(trimmed, "event");

  if (eventTags.length === 0) {
    const raw = innerText(trimmed, "date");
    const date =
      raw && /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : fallbackToday;
    return [{ date, events: [] }];
  }

  const byEventDate = groupEventsByPerEventDate(eventTags, fallbackToday);
  if (byEventDate) return byEventDate;

  if (!/<date\b/i.test(trimmed)) {
    return [{ date: fallbackToday, events: eventTags.map(calendarEventFromTag) }];
  }

  const segments = trimmed.split(/(?=<date\b[^>]*>)/i).map((s) => s.trim()).filter(Boolean);
  const slices: CalendarDaySlice[] = [];
  let pending: CalendarEvent[] = [];

  for (const seg of segments) {
    const d = innerText(seg, "date");
    const events = allTags(seg, "event").map(calendarEventFromTag);
    if (d && /^\d{4}-\d{2}-\d{2}/.test(d)) {
      slices.push({ date: d.slice(0, 10), events: [...pending, ...events] });
      pending = [];
    } else {
      pending.push(...events);
    }
  }

  if (pending.length > 0) {
    if (slices.length > 0) {
      const head = slices[0]!;
      slices[0] = { ...head, events: [...pending, ...head.events] };
    } else {
      slices.push({ date: fallbackToday, events: pending });
    }
  }

  if (slices.length === 0) {
    const raw = innerText(trimmed, "date");
    const date =
      raw && /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : fallbackToday;
    return [{ date, events: eventTags.map(calendarEventFromTag) }];
  }

  return slices;
}

function extractCalendar(inner: string): CalendarPayload {
  const daySlices = extractCalendarDaySlices(inner);
  return {
    date: daySlices[0].date,
    events: daySlices[0].events,
    days: daySlices,
  };
}

/** 応答内の複数 `<calendar>...</calendar>` を1つのペイロードにまとめる（同一ブロック内の複数日も対象） */
export function mergeCalendarInners(inners: string[]): CalendarPayload {
  const dayMap = new Map<string, CalendarEvent[]>();

  for (const inner of inners) {
    const payload = extractCalendar(inner);
    const slices: CalendarDaySlice[] =
      payload.days?.length ? payload.days : [{ date: payload.date, events: payload.events }];
    for (const { date, events } of slices) {
      const prev = dayMap.get(date) ?? [];
      dayMap.set(date, [...prev, ...events]);
    }
  }

  if (dayMap.size === 0) {
    const today = new Date().toISOString().slice(0, 10);
    return { date: today, events: [], days: [{ date: today, events: [] }] };
  }

  const sortedKeys = [...dayMap.keys()].sort();
  const daySlices = sortedKeys.map((date) => ({ date, events: dayMap.get(date)! }));
  return {
    date: daySlices[0].date,
    events: daySlices[0].events,
    days: daySlices,
  };
}

/* ---- Map ---- */

function extractMap(inner: string): MapPayload {
  const modeStr = innerText(inner, "mode");
  const mode = modeStr === "route-plan" ? "route-plan" : "spot-compare";
  const title = innerText(inner, "title").trim() || undefined;
  const spots: MapSpot[] = allTags(inner, "spot").map((tag) => ({
    id: attr(tag, "id", `s-${Math.random()}`),
    name: attr(tag, "name", "Unknown"),
    address: attr(tag, "address") || undefined,
    arrivalTime: attr(tag, "arrivalTime") || undefined,
    stayMinutes: parseInt(attr(tag, "stayMinutes", "0")) || 0,
    transitMinutes: parseInt(attr(tag, "transitMinutes", "0")) || 0,
    links: extractMapSpotLinksFromTag(tag, attr, allTags),
    memo: attr(tag, "memo") || undefined,
  }));
  return { mode, spots, title };
}

/* ---- Transit ---- */

function extractTransit(inner: string): TransitPayload {
  const from = innerText(inner, "from").trim() || "";
  const to = innerText(inner, "to").trim() || "";
  const dateStr = innerText(inner, "date").trim() || undefined;
  const timeStr = innerText(inner, "time").trim() || innerText(inner, "departure").trim() || undefined;
  const typeStr = innerText(inner, "type").trim().toLowerCase();
  const type = ["departure", "arrival", "first", "last"].includes(typeStr)
    ? (typeStr as TransitPayload["type"])
    : undefined;
  const modeStr = attr(inner, "mode").trim().toLowerCase();
  const mode = ["station", "place"].includes(modeStr)
    ? (modeStr as TransitPayload["mode"])
    : undefined;
  return { from, to, date: dateStr || undefined, time: timeStr || undefined, type, mode };
}

/* ---- Email ---- */

function extractEmail(inner: string): EmailPayload {
  const emails: EmailItem[] = allTags(inner, "email").map((tag) => ({
    id: attr(tag, "id", `m-${Math.random()}`),
    subject: attr(tag, "subject", "(no subject)"),
    sender: attr(tag, "sender", "Unknown"),
    receivedAt: attr(tag, "receivedAt", ""),
    summary: attr(tag, "summary", ""),
    priority: (attr(tag, "priority", "normal") as EmailPriority),
    read: attr(tag, "read", "false") === "true",
  }));
  return { emails };
}

/* ---- Compare ---- */

function normalizeCompareType(raw: string): CompareType {
  const t = raw.trim();
  return t || "product";
}

function extractCompare(inner: string): ComparePayload {
  const compareType = normalizeCompareType(innerText(inner, "compareType") || "product");
  const colStr = innerText(inner, "columns");
  const columnDefs = colStr ? colStr.split(",").map((s) => s.trim()) : [];
  const items: CompareItem[] = allTags(inner, "item").map((tag) => {
    const name = attr(tag, "name", "Unknown");
    const price = attr(tag, "price") || undefined;
    const rating = parseFloat(attr(tag, "rating", "0")) || undefined;
    const prosStr = attr(tag, "pros", "");
    const consStr = attr(tag, "cons", "");
    const columns: Record<string, string> = {};
    columnDefs.forEach((col) => {
      const v = attr(tag, `col_${col}`);
      if (v) columns[col] = v;
    });
    return {
      id: attr(tag, "id", `i-${Math.random()}`),
      name,
      price,
      rating,
      columns,
      pros: prosStr ? prosStr.split(",").map((s) => s.trim()) : [],
      cons: consStr ? consStr.split(",").map((s) => s.trim()) : [],
      externalUrl: attr(tag, "url") || undefined,
    };
  });
  return { compareType, columnDefs, items };
}

/* ---- Note ---- */

function extractNote(inner: string): NotePayload {
  const title = innerText(inner, "title") || "Note";
  const markdown = innerText(inner, "markdown") || inner.replace(/<[^>]+>/g, "").trim();
  return { title, markdown };
}

/* ---- Question (clarification) ---- */

function extractQuestion(inner: string): QuestionPayload {
  const itemTags = allTags(inner, "item");
  const items: QuestionItem[] = itemTags.map((tag) => {
    const optStr = attr(tag, "options", "");
    const options = optStr
      ? optStr.split("|").map((s) => s.trim()).filter(Boolean).slice(0, 4)
      : [];
    const allowFreeRaw = attr(tag, "allowFree", "false").toLowerCase();
    const allowFree = allowFreeRaw === "true" || allowFreeRaw === "1";
    return {
      id: attr(tag, "id", `q-${Math.random()}`),
      text: attr(tag, "text", ""),
      allowFree,
      options,
    };
  });
  return { items };
}

/* ---- Quiz ---- */

function extractQuiz(inner: string): QuizPayload {
  const mode = (innerText(inner, "mode") || "drill") as QuizMode;
  const topic = innerText(inner, "topic") || "Quiz";
  const questions: QuizQuestion[] = allTags(inner, "question").map((tag) => {
    const choicesStr = attr(tag, "choices", "");
    const choices = choicesStr ? choicesStr.split("|") : [];
    const correctStr = attr(tag, "correct", "0");
    const correctIndices = correctStr.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
    return {
      id: attr(tag, "id", `q-${Math.random()}`),
      question: attr(tag, "text", ""),
      choices,
      correctIndices,
      explanation: attr(tag, "explanation", ""),
      type: "choice",
    };
  });
  return { mode, topic, questions };
}

/* ---- Task ---- */

export function extractTaskPanel(inner: string): TaskPanelData {
  const taskTags = allTags(inner, "task");
  const tasks: TaskItem[] = taskTags.map((tag) => {
    const subtaskTags = allTags(tag, "subtask");
    const subtasks = subtaskTags.map((st) => ({
      id: attr(st, "id", `st-${Math.random()}`),
      title: attr(st, "title", ""),
      done: false,
    }));
    const actionAttr = attr(tag, "action", "add").toLowerCase();
    const taskAction = (
      actionAttr === "done" ? "done" :
      actionAttr === "edit" ? "edit" :
      actionAttr === "delete" ? "delete" : "add"
    ) as TaskItem["action"];
    return {
      id: attr(tag, "id", `t-${Math.random()}`),
      title: attr(tag, "title", "Untitled Task"),
      priority: (attr(tag, "priority", "normal") as TaskItem["priority"]),
      notes: attr(tag, "notes") || undefined,
      deadline: (() => {
        const dl = attr(tag, "deadline");
        if (!dl) return undefined;
        // YYYY-MM-DD only (no time) → default to end of day 23:59
        return /^\d{4}-\d{2}-\d{2}$/.test(dl) ? `${dl}T23:59` : dl;
      })(),
      estimatedMinutes: parseInt(attr(tag, "estimatedMinutes", "0")) || undefined,
      tags: (attr(tag, "tags", "")).split(",").map((s) => s.trim()).filter(Boolean),
      subtasks,
      status: "proposed",
      action: taskAction,
    };
  });
  return { tasks };
}

/* ---- Main dispatcher ---- */

export function extractPanel(type: PanelType, inner: string): SpecialPanelData | undefined {
  try {
    let payload;
    switch (type) {
      case "calendar": payload = extractCalendar(inner); break;
      case "map":      payload = extractMap(inner); break;
      case "transit":  payload = extractTransit(inner); break;
      case "email":    payload = extractEmail(inner); break;
      case "compare":  payload = extractCompare(inner); break;
      case "note":     payload = extractNote(inner); break;
      case "quiz":     payload = extractQuiz(inner); break;
      case "question": payload = extractQuestion(inner); break;
      default: return undefined;
    }
    return {
      panelType: type,
      title:
        type === "map" && (payload as MapPayload).title
          ? (payload as MapPayload).title!
          : PANEL_TYPE_LABELS[type],
      payload,
    };
  } catch (e) {
    console.warn("Panel extraction failed for type", type, e);
    return undefined;
  }
}
