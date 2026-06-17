import { formatLocalDatetime, getResolvedIanaTimeZone } from "../datetime/llmDatetime";

/**
 * Injected into the system prompt each request: local wall clock (IANA timezone),
 * browser language, and optional user-provided rough location (localStorage pc-user-location-hint).
 */
export function buildSessionContextBlock(now: Date): string {
  const timeZone = getResolvedIanaTimeZone();

  const browserLang = typeof navigator !== "undefined" ? navigator.language : "";

  let userLocationHint = "";
  try {
    userLocationHint = localStorage.getItem("pc-user-location-hint")?.trim() ?? "";
  } catch {
    /* ignore */
  }

  const lines = [
    "[Session context — automatic]",
    `local_datetime: ${formatLocalDatetime(now, timeZone)}`,
    `iana_timezone: ${timeZone}`,
    "time_basis: All timestamps use 24h local wall clock + TZ abbreviation per iana_timezone (e.g. 2026-05-25T01:02（JST）). No numeric UTC offset suffix. Never bare Z-only UTC.",
    `browser_language: ${browserLang || "(unknown)"}`,
  ];
  if (userLocationHint) {
    lines.push(`user_location_hint: ${userLocationHint}`);
  }

  return `${lines.join("\n")}\n\n`;
}
