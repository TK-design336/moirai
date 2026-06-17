import { parseUtcDatetime } from "../datetime/llmDatetime";

/** Parse `<remind><time>…</time>` — `YYYY-MM-DDTHH:mm（TZ）` or legacy offset/Z forms. */
export function parseRemindFireAt(timeText: string): Date | null {
  return parseUtcDatetime(timeText);
}
