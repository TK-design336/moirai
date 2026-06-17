/** localStorage 書き込み失敗（容量超過など）を UI に通知する */

export const STORAGE_QUOTA_EVENT = "pc-storage-quota";

export type StorageQuotaDetail = { key: string };

function isQuotaExceeded(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: string }).name;
  if (name === "QuotaExceededError") return true;
  const code = (err as { code?: number }).code;
  return code === 22 || code === 1014;
}

let lastQuotaNotifyMs = 0;
const QUOTA_NOTIFY_COOLDOWN_MS = 30_000;

function notifyQuotaExceeded(key: string): void {
  const now = Date.now();
  if (now - lastQuotaNotifyMs < QUOTA_NOTIFY_COOLDOWN_MS) return;
  lastQuotaNotifyMs = now;
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<StorageQuotaDetail>(STORAGE_QUOTA_EVENT, { detail: { key } }),
  );
}

/** @returns true if persisted */
export function safeLocalStorageSetItem(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (err) {
    if (isQuotaExceeded(err)) notifyQuotaExceeded(key);
    return false;
  }
}
