/** Canonical clock for LLM session context, history prefixes, and `<remind><time>`. */
const HAS_INSTANT_TZ_SUFFIX = /[zZ]$|[+-]\d{2}:?\d{2}(?::?\d{2})?$/;

const LOCAL_WALL_CLOCK_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

/** Trailing label e.g. `（JST）`, `(PDT)`, `（UTC+9）` — stripped before parse. */
const TZ_LABEL_SUFFIX_RE = /\s*[（(][^）)]+[）)]\s*$/;

export function getResolvedIanaTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  } catch {
    return "UTC";
  }
}

function getTimeZoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(instant);
  const g = (type: string) => parseInt(parts.find((p) => p.type === type)?.value ?? "0", 10);
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
  return asUtc - instant.getTime();
}

function getTimeZoneAbbreviation(instant: Date, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "short",
    }).formatToParts(instant);
    return parts.find((p) => p.type === "timeZoneName")?.value ?? timeZone;
  } catch {
    return timeZone;
  }
}

/** `2026-05-25T01:02（JST）` — 24h wall clock + TZ abbr for the given IANA timezone (no numeric offset). */
export function formatLocalDatetime(date: Date, timeZone?: string): string {
  const tz = timeZone ?? getResolvedIanaTimeZone();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const g = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  const wall = `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}`;
  const abbr = getTimeZoneAbbreviation(date, tz);
  return `${wall}（${abbr}）`;
}

/** @deprecated Use {@link formatLocalDatetime}. Kept for backward-compatible imports. */
export function formatUtcDatetime(date: Date): string {
  return formatLocalDatetime(date);
}

function localWallClockToDate(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  sec: number,
  timeZone: string,
): Date {
  const utcGuess = Date.UTC(y, mo, d, h, mi, sec);
  const offset = getTimeZoneOffsetMs(new Date(utcGuess), timeZone);
  return new Date(utcGuess - offset);
}

/** Strip optional trailing timezone label before parsing. */
export function stripTimezoneLabelSuffix(text: string): string {
  return text.replace(TZ_LABEL_SUFFIX_RE, "").trim();
}

/**
 * Parse LLM datetime:
 * - `YYYY-MM-DDTHH:mm（ABBR）`, legacy `±HH:MM` forms, or `Z` (absolute instant)
 * - bare `YYYY-MM-DDTHH:mm` → wall clock in `timeZone` (default: browser IANA)
 */
export function parseUtcDatetime(timeText: string, timeZone?: string): Date | null {
  const defaultTz = timeZone ?? getResolvedIanaTimeZone();
  const s = stripTimezoneLabelSuffix(timeText.trim());
  if (!s) return null;

  if (HAS_INSTANT_TZ_SUFFIX.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const bare = s.match(LOCAL_WALL_CLOCK_RE);
  if (bare) {
    const dt = localWallClockToDate(
      parseInt(bare[1], 10),
      parseInt(bare[2], 10) - 1,
      parseInt(bare[3], 10),
      parseInt(bare[4], 10),
      parseInt(bare[5], 10),
      parseInt(bare[6] ?? "0", 10),
      defaultTz,
    );
    return Number.isNaN(dt.getTime()) ? null : dt;
  }

  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}
