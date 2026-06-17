export interface ChatFolder {
  id: string;
  name: string;
  createdAt: string;
}

export const CHAT_FOLDERS_KEY = "pc-chat-folders";

/** Built-in category folders (10). Unassigned sessions use folderId null — no "不明" folder row. */
const DEFAULT_CATEGORY_SPECS: { id: string; name: string }[] = [
  { id: "folder-cat-translate", name: "翻訳" },
  { id: "folder-cat-doc", name: "文書作成" },
  { id: "folder-cat-research", name: "調査・まとめ" },
  { id: "folder-cat-analysis", name: "分析" },
  { id: "folder-cat-ideas", name: "アイデア出し" },
  { id: "folder-cat-learn", name: "質問・学習" },
  { id: "folder-cat-plan", name: "計画・設計" },
  { id: "folder-cat-summarize", name: "要約" },
  { id: "folder-cat-chat", name: "対話・雑談" },
  { id: "folder-cat-image", name: "画像生成" },
];

export function mergeDefaultChatFolders(stored: ChatFolder[]): ChatFolder[] {
  const now = new Date().toISOString();
  const result = [...stored];
  for (const spec of DEFAULT_CATEGORY_SPECS) {
    if (result.some((f) => f.id === spec.id)) continue;
    if (result.some((f) => f.name === spec.name)) continue;
    result.push({ id: spec.id, name: spec.name, createdAt: now });
  }
  return result;
}

function foldersNeedPersist(before: ChatFolder[], after: ChatFolder[]): boolean {
  if (after.length !== before.length) return true;
  const beforeIds = new Set(before.map((f) => f.id));
  return after.some((f) => !beforeIds.has(f.id));
}

export function loadChatFoldersRaw(): ChatFolder[] {
  try {
    const raw = localStorage.getItem(CHAT_FOLDERS_KEY);
    return raw ? (JSON.parse(raw) as ChatFolder[]) : [];
  } catch {
    return [];
  }
}

export function saveChatFolders(folders: ChatFolder[]): void {
  try {
    localStorage.setItem(CHAT_FOLDERS_KEY, JSON.stringify(folders));
  } catch {
    /* quota */
  }
}

/** Reads from localStorage, merges in missing default categories, persists if changed. */
export function loadChatFoldersWithDefaults(): ChatFolder[] {
  const raw = loadChatFoldersRaw();
  const merged = mergeDefaultChatFolders(raw);
  if (foldersNeedPersist(raw, merged)) {
    saveChatFolders(merged);
  }
  return merged;
}
