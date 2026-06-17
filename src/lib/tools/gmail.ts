import { invoke } from "@tauri-apps/api/core";
import { getValidGoogleToken } from "../googleAuth";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

async function fetchProxy(url: string, method = "GET", headers: Record<string, string> = {}, body?: string): Promise<string> {
  try {
    return await invoke<string>("fetch_proxy", { req: { url, method, headers, body: body ?? null } });
  } catch {
    const resp = await fetch(url, { method, headers, body });
    return resp.text();
  }
}

export async function gmailList(params: {
  maxResults?: number;
  unreadOnly?: boolean;
  q?: string;
  after?: string;
  before?: string;
  from?: string;
}): Promise<string> {
  const token = await getValidGoogleToken();
  if (!token) return "[Gmail: 未接続]";

  const parts: string[] = [];
  if (params.unreadOnly) parts.push("is:unread");
  if (params.q) parts.push(params.q);
  if (params.after) parts.push(`after:${params.after}`);
  if (params.before) parts.push(`before:${params.before}`);
  if (params.from) parts.push(`from:${params.from}`);
  const q = parts.join(" ");
  const max = params.maxResults ?? 20;
  const listUrl = `${GMAIL_API}/messages?maxResults=${max}${q ? `&q=${encodeURIComponent(q)}` : ""}`;

  try {
    const listRaw = await fetchProxy(listUrl, "GET", { Authorization: `Bearer ${token}` });
    const listData = JSON.parse(listRaw);
    if (listData.error) return `[Gmail error: ${listData.error.message}]`;

    const messages = listData.messages ?? [];
    if (messages.length === 0) return "No emails found.";

    const summaries: string[] = [];
    for (const m of messages) {
      const msgRaw = await fetchProxy(`${GMAIL_API}/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`, "GET", { Authorization: `Bearer ${token}` });
      const msgData = JSON.parse(msgRaw);
      if (msgData.error) continue;
      const headers: { name: string; value: string }[] = msgData.payload?.headers ?? [];
      const subject = headers.find((h) => h.name === "Subject")?.value ?? "(no subject)";
      const from = headers.find((h) => h.name === "From")?.value ?? "Unknown";
      summaries.push(`- From: ${from} | Subject: ${subject} (id: ${m.id})`);
    }
    return summaries.join("\n");
  } catch (e) {
    return `[Gmail list failed: ${e}]`;
  }
}

export async function gmailRead(params: { maxResults?: number; unreadOnly?: boolean }): Promise<string> {
  const token = await getValidGoogleToken();
  if (!token) return "[Gmail: 未接続]";

  const q = params.unreadOnly ? "is:unread" : "";
  const max = params.maxResults ?? 10;
  const listUrl = `${GMAIL_API}/messages?maxResults=${max}${q ? `&q=${encodeURIComponent(q)}` : ""}`;

  try {
    const listRaw = await fetchProxy(listUrl, "GET", { Authorization: `Bearer ${token}` });
    const listData = JSON.parse(listRaw);
    if (listData.error) return `[Gmail error: ${listData.error.message}]`;

    const messages = listData.messages ?? [];
    if (messages.length === 0) return "No emails found.";

    const summaries: string[] = [];
    for (const m of messages.slice(0, 5)) {
      const msgRaw = await fetchProxy(`${GMAIL_API}/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`, "GET", { Authorization: `Bearer ${token}` });
      const msgData = JSON.parse(msgRaw);
      if (msgData.error) continue;
      const headers: { name: string; value: string }[] = msgData.payload?.headers ?? [];
      const subject = headers.find((h) => h.name === "Subject")?.value ?? "(no subject)";
      const from = headers.find((h) => h.name === "From")?.value ?? "Unknown";
      const snippet = msgData.snippet ?? "";
      summaries.push(`- From: ${from}\n  Subject: ${subject}\n  Preview: ${snippet.slice(0, 100)}`);
    }

    return `Recent emails:\n${summaries.join("\n\n")}`;
  } catch (e) {
    return `[Gmail fetch failed: ${e}]`;
  }
}

export async function gmailReadMessage(messageId: string): Promise<string> {
  const token = await getValidGoogleToken();
  if (!token) return "[Gmail: 未接続]";

  try {
    const msgRaw = await fetchProxy(`${GMAIL_API}/messages/${messageId}?format=full`, "GET", { Authorization: `Bearer ${token}` });
    const msgData = JSON.parse(msgRaw);
    if (msgData.error) return `[Gmail error: ${msgData.error.message}]`;

    const payload = msgData.payload;
    if (!payload) return "No content.";

    const headers: { name: string; value: string }[] = payload.headers ?? [];
    const subject = headers.find((h) => h.name === "Subject")?.value ?? "(no subject)";
    const from = headers.find((h) => h.name === "From")?.value ?? "Unknown";

    let body = "";
    if (payload.body?.data) {
      body = atob(payload.body.data.replace(/-/g, "+").replace(/_/g, "/"));
    } else if (payload.parts) {
      for (const p of payload.parts) {
        if (p.mimeType === "text/plain" && p.body?.data) {
          body = atob(p.body.data.replace(/-/g, "+").replace(/_/g, "/"));
          break;
        }
      }
    }
    return `From: ${from}\nSubject: ${subject}\n\n${body || "(no body)"}`;
  } catch (e) {
    return `[Gmail read failed: ${e}]`;
  }
}

export async function gmailDraft(params: { to: string; subject: string; body: string }): Promise<string> {
  const token = await getValidGoogleToken();
  if (!token) return "[Gmail: 未接続]";

  const rawEmail = [
    `To: ${params.to}`,
    `Subject: ${params.subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    params.body,
  ].join("\n");

  const encoded = btoa(unescape(encodeURIComponent(rawEmail)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  try {
    const raw = await fetchProxy(`${GMAIL_API}/drafts`, "POST", {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    }, JSON.stringify({ message: { raw: encoded } }));
    const data = JSON.parse(raw);
    if (data.error) return `[Gmail draft error: ${data.error.message}]`;
    return `Draft created: ${data.id}`;
  } catch (e) {
    return `[Gmail draft failed: ${e}]`;
  }
}
