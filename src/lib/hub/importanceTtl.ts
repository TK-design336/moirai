import type { HubImportance } from "./types";

/** localStorage JSON: `{ "1": hours, ... }` — チャンク完了後 Hub に残す時間（時間） */
export const HUB_IMPORTANCE_TTL_HOURS_KEY = "pc-hub-importance-ttl-hours";

/** 旧バージョン（分）。読み込み時に時間へ変換して新キーへ移行する */
const LEGACY_HUB_IMPORTANCE_TTL_MINUTES_KEY = "pc-hub-importance-ttl-minutes";

/** 下限 ~1 分（分単位 UI からの後方互換と同一粒度） */
export const HUB_TTL_MIN_HOURS = 1 / 60;

/** 上限 1 年 */
export const HUB_TTL_MAX_HOURS = 8760;

/** 既定値は従来の固定 TTL（1→2h, 2→24h, 3→48h, 4/5→72h）と一致 */
export const DEFAULT_HUB_IMPORTANCE_TTL_HOURS: Record<HubImportance, number> = {
  1: 2,
  2: 24,
  3: 48,
  4: 72,
  5: 72,
};

export const HUB_IMPORTANCE_LEVELS: HubImportance[] = [1, 2, 3, 4, 5];

function clampHoursForImportance(imp: HubImportance, raw: number): number {
  const fallback = DEFAULT_HUB_IMPORTANCE_TTL_HOURS[imp];
  if (!Number.isFinite(raw)) return fallback;
  if (raw < HUB_TTL_MIN_HOURS) return fallback;
  return Math.min(raw, HUB_TTL_MAX_HOURS);
}

function parseHoursJson(s: string): Record<HubImportance, number> | null {
  const parsed = JSON.parse(s) as unknown;
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  const out: Record<HubImportance, number> = { ...DEFAULT_HUB_IMPORTANCE_TTL_HOURS };
  for (const imp of HUB_IMPORTANCE_LEVELS) {
    const v = o[String(imp)];
    if (typeof v === "number") {
      out[imp] = clampHoursForImportance(imp, v);
    }
  }
  return out;
}

function migrateLegacyMinutesToHours(): Record<HubImportance, number> | null {
  try {
    const s = localStorage.getItem(LEGACY_HUB_IMPORTANCE_TTL_MINUTES_KEY);
    if (!s) return null;
    const parsed = JSON.parse(s) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const o = parsed as Record<string, unknown>;
    const out: Record<HubImportance, number> = { ...DEFAULT_HUB_IMPORTANCE_TTL_HOURS };
    for (const imp of HUB_IMPORTANCE_LEVELS) {
      const v = o[String(imp)];
      if (typeof v === "number") {
        const hours = v / 60;
        out[imp] = clampHoursForImportance(imp, hours);
      }
    }
    localStorage.setItem(HUB_IMPORTANCE_TTL_HOURS_KEY, JSON.stringify(out));
    localStorage.removeItem(LEGACY_HUB_IMPORTANCE_TTL_MINUTES_KEY);
    return out;
  } catch {
    return null;
  }
}

/** 設定画面・TTL 計算の双方で使う。不正キーは既定で埋める */
export function loadHubImportanceTtlHours(): Record<HubImportance, number> {
  const defaults = { ...DEFAULT_HUB_IMPORTANCE_TTL_HOURS };
  try {
    const hRaw = localStorage.getItem(HUB_IMPORTANCE_TTL_HOURS_KEY);
    if (hRaw) {
      const parsed = parseHoursJson(hRaw);
      if (parsed) return parsed;
      return defaults;
    }
    const migrated = migrateLegacyMinutesToHours();
    if (migrated) return migrated;
  } catch {
    /* keep defaults */
  }
  return defaults;
}

/** TTL after chunk close, in milliseconds. */
export function ttlMsForImportance(maxImportance: HubImportance): number {
  const hours = loadHubImportanceTtlHours()[maxImportance];
  return hours * 3600 * 1000;
}
