/**
 * Google Calendar イベント用の事前定義色パレット。
 * colorId は Google Calendar API の event.colorId で使用する文字列（"1"〜"11"）。
 * UI 表示用に Google Calendar の実際の色に合わせた hex 値を使用。
 * @see https://developers.google.com/workspace/calendar/api/v3/reference/colors
 */
export const GOOGLE_CALENDAR_EVENT_COLORS = [
  { id: "1", name: "Red", hex: "#EA4335" },
  { id: "2", name: "Coral", hex: "#F0938B" },
  { id: "3", name: "Orange", hex: "#FBBC04" },
  { id: "4", name: "Yellow", hex: "#FBD604" },
  { id: "5", name: "Mint Green", hex: "#34A853" },
  { id: "6", name: "Dark Green", hex: "#0F9D58" },
  { id: "7", name: "Blue", hex: "#4285F4" },
  { id: "8", name: "Periwinkle", hex: "#676AF9" },
  { id: "9", name: "Lavender", hex: "#A7B7E8" },
  { id: "10", name: "Purple", hex: "#884CC2" },
  { id: "11", name: "Grey", hex: "#5F6368" },
] as const;

export type GoogleCalendarColorId = typeof GOOGLE_CALENDAR_EVENT_COLORS[number]["id"];

/** API から取得した色のキャッシュ。fetchGoogleCalendarColors で更新。 */
let apiColorsCache: Record<string, string> | null = null;

/** API 取得色をキャッシュに設定（CalendarPanel 等で fetch 後に呼ぶ）。 */
export function setGoogleCalendarColorsCache(colors: Record<string, string>): void {
  apiColorsCache = colors;
}

/** colorId から hex を取得。API キャッシュ優先、なければ静的フォールバック。 */
export function colorIdToHex(colorId: string | undefined): string {
  if (!colorId) return "#4285f4";
  if (apiColorsCache && apiColorsCache[colorId]) return apiColorsCache[colorId];
  const found = GOOGLE_CALENDAR_EVENT_COLORS.find((c) => c.id === colorId);
  return found?.hex ?? "#4285f4";
}

/** hex から最も近い colorId を返す。 */
export function hexToColorId(hex: string | undefined): string {
  if (!hex || !hex.startsWith("#")) return "1";
  const h = hex.toLowerCase();
  let bestId = "1";
  let bestDist = Infinity;
  for (const c of GOOGLE_CALENDAR_EVENT_COLORS) {
    const dist = colorDistance(h, c.hex.toLowerCase());
    if (dist < bestDist) {
      bestDist = dist;
      bestId = c.id;
    }
  }
  return bestId;
}

function colorDistance(a: string, b: string): number {
  const ar = parseInt(a.slice(1, 3), 16);
  const ag = parseInt(a.slice(3, 5), 16);
  const ab = parseInt(a.slice(5, 7), 16);
  const br = parseInt(b.slice(1, 3), 16);
  const bg = parseInt(b.slice(3, 5), 16);
  const bb = parseInt(b.slice(5, 7), 16);
  return (ar - br) ** 2 + (ag - bg) ** 2 + (ab - bb) ** 2;
}

/** color 属性（colorId または hex）を表示用 hex に正規化。 */
export function normalizeColorToHex(color: string | undefined): string {
  if (!color) return "#4285f4";
  if (/^[1-9]|1[01]$/.test(color)) return colorIdToHex(color);
  if (/^#[0-9a-fA-F]{6}$/.test(color)) return color;
  return "#4285f4";
}
