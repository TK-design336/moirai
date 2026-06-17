import type { TaskKind } from "../../types/engine";
import { calendarRead } from "./calendar";
import { docsRead } from "./docs";
import { gmailRead } from "./gmail";

/* ---- Pre-fetch tools based on task kinds ---- */

export interface PrefetchOptions {
  taskKinds: TaskKind[];
  /** When provided and non-empty, use this date range for calendar prefetch (e.g. "今日明日の予定") */
  extractedDates?: Date[];
}

const MS_PER_DAY = 86400000;

function getSchedulePrefetchDays(): { daysBefore: number; daysAfter: number } {
  const before = parseInt(localStorage.getItem("pc-schedule-prefetch-days-before") ?? "2", 10);
  const after = parseInt(localStorage.getItem("pc-schedule-prefetch-days-after") ?? "7", 10);
  return {
    daysBefore: Number.isNaN(before) || before < 0 ? 2 : before,
    daysAfter: Number.isNaN(after) || after < 0 ? 7 : after,
  };
}

function formatDateYYYYMMDD(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function prefetchTools(options: PrefetchOptions | TaskKind[]): Promise<string> {
  const taskKinds = Array.isArray(options) ? options : options.taskKinds;
  const extractedDates = !Array.isArray(options) ? options.extractedDates : undefined;

  const { daysBefore, daysAfter } = getSchedulePrefetchDays();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let calFrom: string;
  let calTo: string;
  if (extractedDates && extractedDates.length > 0) {
    const sorted = [...extractedDates].sort((a, b) => a.getTime() - b.getTime());
    const baseStart = new Date(sorted[0]);
    const baseEnd = new Date(sorted[sorted.length - 1]);
    baseStart.setHours(0, 0, 0, 0);
    baseEnd.setHours(0, 0, 0, 0);
    const fromDate = new Date(baseStart.getTime() - daysBefore * MS_PER_DAY);
    const toDate = new Date(baseEnd.getTime() + daysAfter * MS_PER_DAY);
    calFrom = formatDateYYYYMMDD(fromDate);
    calTo = formatDateYYYYMMDD(toDate);
  } else {
    const fromDate = new Date(today.getTime() - daysBefore * MS_PER_DAY);
    const toDate = new Date(today.getTime() + daysAfter * MS_PER_DAY);
    calFrom = formatDateYYYYMMDD(fromDate);
    calTo = formatDateYYYYMMDD(toDate);
  }

  const results: string[] = [];

  try {
    if (taskKinds.includes("schedule")) {
      const calResult = await calendarRead({ dateRange: { from: calFrom, to: calTo } });
      if (!calResult.startsWith("[") || !calResult.includes("未接続")) {
        results.push(calResult);
      }
    }

    if (taskKinds.includes("email")) {
      const gmailResult = await gmailRead({ maxResults: 5, unreadOnly: true });
      if (!gmailResult.startsWith("[") || !gmailResult.includes("未接続")) {
        results.push(gmailResult);
      }
    }

    // Use the Doc currently selected in Free Note (Google Docs source); no separate Settings field.
    const currentDocId = localStorage.getItem("pc-google-docs-current-id");
    if ((taskKinds.includes("note") || taskKinds.includes("general")) && currentDocId?.trim()) {
      const docsResult = await docsRead({ documentId: currentDocId.trim() });
      if (!docsResult.startsWith("[") || !docsResult.includes("未接続")) {
        results.push(docsResult);
      }
    }
  } catch {
    // ignore prefetch failures
  }

  return results.join("\n\n");
}

/* ---- Connected tools list for system prompt ---- */

export function getConnectedToolsList(): string[] {
  const tools: string[] = [];
  if (localStorage.getItem("pc-google-access-token")) {
    tools.push("calendar_read: 予定確認・提案の前に必ず呼ぶ。dateRange:{from,to} でYYYY-MM-DD指定。keywordで検索可。");
    tools.push("gmail_read: Read Gmail messages. Params: {maxResults?,unreadOnly?}");
    tools.push("docs_read: Read Google Docs document by ID. Params: {documentId: string}. Document ID is in the URL: docs.google.com/document/d/DOCUMENT_ID/edit");
  }
  if (localStorage.getItem("pc-notion-api-token")) {
    tools.push("notion_read: Read Notion pages. Params: {pageId?,query?}");
  }
  return tools;
}
