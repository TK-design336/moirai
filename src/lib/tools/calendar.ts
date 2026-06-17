import { invoke } from "@tauri-apps/api/core";
import { getValidGoogleToken } from "../googleAuth";
import { colorIdToHex, hexToColorId } from "./calendarColors";

const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

async function fetchProxy(url: string, method = "GET", headers: Record<string, string> = {}, body?: string): Promise<string> {
  // In Tauri: use Rust proxy to avoid CORS
  try {
    return await invoke<string>("fetch_proxy", { req: { url, method, headers, body: body ?? null } });
  } catch {
    // Browser mode: direct fetch (may fail with CORS)
    const resp = await fetch(url, { method, headers, body });
    return resp.text();
  }
}

export async function calendarRead(params: {
  dateRange: { from: string; to: string };
  keyword?: string;
}): Promise<string> {
  const token = await getValidGoogleToken();
  if (!token) return "[Google Calendar: 未接続]";

  let url = `${CALENDAR_API}/calendars/primary/events?timeMin=${params.dateRange.from}T00:00:00Z&timeMax=${params.dateRange.to}T23:59:59Z&singleEvents=true&orderBy=startTime&maxResults=100`;
  if (params.keyword?.trim()) {
    url += `&q=${encodeURIComponent(params.keyword.trim())}`;
  }
  try {
    const raw = await fetchProxy(url, "GET", { Authorization: `Bearer ${token}` });
    const data = JSON.parse(raw);
    if (data.error) return `[Calendar error: ${data.error.message}]`;

    let events = (data.items ?? []).map((e: Record<string, unknown>) => {
      const startObj = e.start as Record<string, string> | undefined;
      const endObj = e.end as Record<string, string> | undefined;
      const start = startObj?.dateTime ?? startObj?.date ?? "";
      const end = endObj?.dateTime ?? endObj?.date ?? "";
      const isAllDay = !!startObj?.date && !startObj?.dateTime;
      const suffix = isAllDay ? " (終日)" : "";
      const desc = (e.description as string)?.trim();
      const descPart = desc ? ` | 説明: ${desc.replace(/\s+/g, " ").slice(0, 120)}${desc.length > 120 ? "…" : ""}` : "";
      return `- ${e.summary ?? "(no title)"}: ${start} ~ ${end}${suffix}${e.location ? ` @ ${e.location}` : ""}${descPart}`;
    });
    if (params.keyword?.trim()) {
      const kw = params.keyword.toLowerCase();
      events = events.filter((s: string) => s.toLowerCase().includes(kw));
    }

    return events.length > 0
      ? `Calendar events (${params.dateRange.from} to ${params.dateRange.to}):\n${events.join("\n")}`
      : `No events found from ${params.dateRange.from} to ${params.dateRange.to}.`;
  } catch (e) {
    return `[Calendar fetch failed: ${e}]`;
  }
}

/** Structured event for panel display. start/end as HH:MM for time-based, or 00:00/23:59 for all-day. */
export interface CalendarEventStructured {
  id: string;
  googleEventId: string;
  title: string;
  start: string;
  end: string;
  description?: string;
  location?: string;
  allDay?: boolean;
  color: string;
  colorId?: string;
}

function parseGoogleEventToStructured(e: Record<string, unknown>): CalendarEventStructured | null {
  const startObj = e.start as Record<string, string> | undefined;
  const endObj = e.end as Record<string, string> | undefined;
  const dateTimeStart = startObj?.dateTime;
  const dateStart = startObj?.date;
  const dateTimeEnd = endObj?.dateTime;
  const dateEnd = endObj?.date;
  const isAllDay = !!dateStart && !dateTimeStart;
  const id = (e.id as string) ?? "";

  let start: string;
  let end: string;
  if (isAllDay) {
    start = "00:00";
    end = "23:59";
  } else {
    const startStr = dateTimeStart ?? dateStart ?? "";
    const endStr = dateTimeEnd ?? dateEnd ?? "";
    start = startStr.length >= 16 ? startStr.slice(11, 16) : "09:00";
    end = endStr.length >= 16 ? endStr.slice(11, 16) : "10:00";
  }

  const colorId = e.colorId as string | undefined;
  const bgHex = e.backgroundColor as string | undefined;
  const color = bgHex || (colorId ? colorIdToHex(colorId) : "#4285f4");

  return {
    id,
    googleEventId: id,
    title: (e.summary as string) ?? "(no title)",
    start,
    end,
    description: (e.description as string)?.trim() || undefined,
    location: (e.location as string) || undefined,
    allDay: isAllDay || undefined,
    color,
    colorId,
  };
}

export async function calendarReadStructured(params: {
  dateRange: { from: string; to: string };
}): Promise<CalendarEventStructured[]> {
  const token = await getValidGoogleToken();
  if (!token) return [];

  const url = `${CALENDAR_API}/calendars/primary/events?timeMin=${params.dateRange.from}T00:00:00Z&timeMax=${params.dateRange.to}T23:59:59Z&singleEvents=true&orderBy=startTime&maxResults=100`;
  try {
    const raw = await fetchProxy(url, "GET", { Authorization: `Bearer ${token}` });
    const data = JSON.parse(raw);
    if (data.error) return [];

    const items = (data.items ?? []) as Record<string, unknown>[];
    const result: CalendarEventStructured[] = [];
    for (const e of items) {
      const ev = parseGoogleEventToStructured(e);
      if (ev) result.push(ev);
    }
    return result;
  } catch {
    return [];
  }
}

/** Google Calendar API の色パレットを取得。event.1〜11 の background (hex) を返す。 */
export async function fetchGoogleCalendarColors(): Promise<Record<string, string>> {
  const token = await getValidGoogleToken();
  if (!token) return {};

  try {
    const raw = await fetchProxy(`${CALENDAR_API}/colors`, "GET", { Authorization: `Bearer ${token}` });
    const data = JSON.parse(raw);
    if (data.error) return {};

    const eventColors = data.event as Record<string, { background?: string }> | undefined;
    if (!eventColors || typeof eventColors !== "object") return {};

    const result: Record<string, string> = {};
    for (const [id, def] of Object.entries(eventColors)) {
      if (def?.background && /^#[0-9a-fA-F]{6}$/.test(def.background)) {
        result[id] = def.background;
      }
    }
    return result;
  } catch {
    return {};
  }
}

export interface CalendarEventInput {
  title: string;
  start: string; // ISO datetime or YYYY-MM-DD for all-day
  end: string;
  description?: string;
  location?: string;
  allDay?: boolean;
  /** Google Calendar colorId "1"–"11" */
  colorId?: string;
  /** RRULE strings e.g. ["RRULE:FREQ=WEEKLY;BYDAY=MO"] */
  recurrence?: string[];
}

export async function calendarWrite(event: CalendarEventInput): Promise<string> {
  const token = await getValidGoogleToken();
  if (!token) return "[Google Calendar: 未接続]";

  const isAllDay = event.allDay ?? /^\d{4}-\d{2}-\d{2}$/.test(event.start);
  const startPayload = isAllDay
    ? { date: event.start.slice(0, 10) }
    : { dateTime: event.start, timeZone: "Asia/Tokyo" };
  const endPayload = isAllDay
    ? { date: event.end.slice(0, 10) }
    : { dateTime: event.end, timeZone: "Asia/Tokyo" };

  const bodyObj: Record<string, unknown> = {
    summary: event.title,
    description: event.description,
    location: event.location,
    start: startPayload,
    end: endPayload,
  };
  if (event.colorId && /^[1-9]|1[01]$/.test(event.colorId)) {
    bodyObj.colorId = event.colorId;
  }
  if (event.recurrence && event.recurrence.length > 0) {
    bodyObj.recurrence = event.recurrence.map((r) =>
      r.startsWith("RRULE:") ? r : `RRULE:${r}`
    );
  }
  const body = JSON.stringify(bodyObj);

  try {
    const raw = await fetchProxy(`${CALENDAR_API}/calendars/primary/events`, "POST", {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    }, body);
    const data = JSON.parse(raw);
    if (data.error) return `[Calendar write error: ${data.error.message}]`;
    return `Event created: ${data.summary} (${data.id})`;
  } catch (e) {
    return `[Calendar write failed: ${e}]`;
  }
}

export async function calendarUpdate(
  eventId: string,
  patch: Partial<CalendarEventInput>,
): Promise<string> {
  const token = await getValidGoogleToken();
  if (!token) return "[Google Calendar: 未接続]";

  const bodyObj: Record<string, unknown> = {};
  if (patch.title !== undefined) bodyObj.summary = patch.title;
  if (patch.description !== undefined) bodyObj.description = patch.description;
  if (patch.location !== undefined) bodyObj.location = patch.location;
  if (patch.colorId !== undefined && /^[1-9]|1[01]$/.test(patch.colorId)) {
    bodyObj.colorId = patch.colorId;
  }
  if (patch.start !== undefined && patch.end !== undefined) {
    const isAllDay = patch.allDay ?? /^\d{4}-\d{2}-\d{2}$/.test(patch.start);
    bodyObj.start = isAllDay
      ? { date: patch.start.slice(0, 10) }
      : { dateTime: patch.start, timeZone: "Asia/Tokyo" };
    bodyObj.end = isAllDay
      ? { date: patch.end.slice(0, 10) }
      : { dateTime: patch.end, timeZone: "Asia/Tokyo" };
  }

  const body = JSON.stringify(bodyObj);
  try {
    const raw = await fetchProxy(
      `${CALENDAR_API}/calendars/primary/events/${encodeURIComponent(eventId)}`,
      "PATCH",
      { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body,
    );
    const data = JSON.parse(raw);
    if (data.error) return `[Calendar update error: ${data.error.message}]`;
    return `Event updated: ${data.summary} (${data.id})`;
  } catch (e) {
    return `[Calendar update failed: ${e}]`;
  }
}

export async function calendarDelete(eventId: string): Promise<string> {
  const token = await getValidGoogleToken();
  if (!token) return "[Google Calendar: 未接続]";

  try {
    const raw = await fetchProxy(
      `${CALENDAR_API}/calendars/primary/events/${encodeURIComponent(eventId)}`,
      "DELETE",
      { "Authorization": `Bearer ${token}` },
    );
    if (!raw || raw.trim() === "") return "Event deleted.";
    const data = JSON.parse(raw);
    if (data.error) return `[Calendar delete error: ${data.error.message}]`;
    return "Event deleted.";
  } catch (e) {
    return `[Calendar delete failed: ${e}]`;
  }
}
