import { invoke } from "@tauri-apps/api/core";

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

async function fetchProxy(url: string, method = "GET", headers: Record<string, string> = {}, body?: string): Promise<string> {
  try {
    return await invoke<string>("fetch_proxy", { req: { url, method, headers, body: body ?? null } });
  } catch {
    const resp = await fetch(url, { method, headers, body });
    return resp.text();
  }
}

export async function notionRead(params: { pageId?: string; query?: string }): Promise<string> {
  const token = localStorage.getItem("pc-notion-api-token");
  if (!token) return "[Notion: 未接続]";

  const authHeaders = {
    "Authorization": `Bearer ${token}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };

  try {
    if (params.pageId) {
      const pageRaw = await fetchProxy(`${NOTION_API}/pages/${params.pageId}`, "GET", authHeaders);
      const pageData = JSON.parse(pageRaw);
      if (pageData.object === "error") return `[Notion error: ${pageData.message}]`;
      const title = extractNotionTitle(pageData);
      const blocksRaw = await fetchProxy(`${NOTION_API}/blocks/${params.pageId}/children?page_size=100`, "GET", authHeaders);
      const blocksData = JSON.parse(blocksRaw);
      if (blocksData.object === "error") return `[Notion error: ${blocksData.message}]`;
      const text = extractBlocksText(blocksData.results ?? []);
      return text.trim() ? `"${title}"\n\n${text.trim()}` : `Notion page: "${title}" (ID: ${params.pageId})`;
    }

    if (params.query) {
      const raw = await fetchProxy(`${NOTION_API}/search`, "POST", authHeaders,
        JSON.stringify({ query: params.query, page_size: 5 }));
      const data = JSON.parse(raw);
      if (data.object === "error") return `[Notion error: ${data.message}]`;
      const results = (data.results ?? []).map((item: Record<string, unknown>) => {
        const title = extractNotionTitle(item);
        return `- ${title} (${item.object}: ${item.id})`;
      });
      return results.length > 0
        ? `Notion search results for "${params.query}":\n${results.join("\n")}`
        : `No Notion pages found for "${params.query}"`;
    }

    return "[Notion: no pageId or query provided]";
  } catch (e) {
    return `[Notion fetch failed: ${e}]`;
  }
}

export async function notionWrite(params: { parentId: string; title: string; content: string }): Promise<string> {
  const token = localStorage.getItem("pc-notion-api-token");
  if (!token) return "[Notion: 未接続]";

  const authHeaders = {
    "Authorization": `Bearer ${token}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };

  const body = JSON.stringify({
    parent: { page_id: params.parentId },
    properties: { title: { title: [{ text: { content: params.title } }] } },
    children: [{
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: [{ text: { content: params.content } }] },
    }],
  });

  try {
    const raw = await fetchProxy(`${NOTION_API}/pages`, "POST", authHeaders, body);
    const data = JSON.parse(raw);
    if (data.object === "error") return `[Notion write error: ${data.message}]`;
    return `Notion page created: "${params.title}" (${data.id})`;
  } catch (e) {
    return `[Notion write failed: ${e}]`;
  }
}

export async function notionUpdatePage(pageId: string, content: string): Promise<string> {
  const token = localStorage.getItem("pc-notion-api-token");
  if (!token) return "[Notion: 未接続]";

  const authHeaders = {
    "Authorization": `Bearer ${token}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };

  const body = JSON.stringify({
    children: [{
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: [{ text: { content } }] },
    }],
  });

  try {
    const raw = await fetchProxy(`${NOTION_API}/blocks/${pageId}/children`, "POST", authHeaders, body);
    const data = JSON.parse(raw);
    if (data.object === "error") return `[Notion update error: ${data.message}]`;
    return "Updated.";
  } catch (e) {
    return `[Notion update failed: ${e}]`;
  }
}

function extractBlocksText(blocks: Array<Record<string, unknown>>): string {
  const lines: string[] = [];
  for (const block of blocks) {
    const type = block.type as string;
    const content = block[type] as { rich_text?: Array<{ plain_text?: string }> } | undefined;
    const text = content?.rich_text?.map((t) => t.plain_text ?? "").join("") ?? "";
    if (text) lines.push(text);
  }
  return lines.join("\n\n");
}

function extractNotionTitle(item: Record<string, unknown>): string {
  try {
    const props = item.properties as Record<string, unknown> | undefined;
    if (!props) return "(untitled)";
    const titleProp = props.title ?? props.Name ?? Object.values(props)[0];
    const titleArr = (titleProp as Record<string, unknown>)?.title as { plain_text?: string }[] | undefined;
    if (titleArr && titleArr.length > 0) {
      return titleArr.map((t) => t.plain_text ?? "").join("");
    }
  } catch {}
  return "(untitled)";
}
