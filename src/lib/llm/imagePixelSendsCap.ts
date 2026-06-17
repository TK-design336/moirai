/** Models tab: 同じユーザ発話の画像をピクセル付きで送る回数の上限（到達後は説明テキストのみ）。 */
export const IMAGE_PIXEL_SENDS_CAP_KEY = "pc-image-pixel-sends-cap";

export const DEFAULT_IMAGE_PIXEL_SENDS_CAP = 2;

const CAP_MAX = 32;

export function getImagePixelSendsCap(): number {
  try {
    const raw = localStorage.getItem(IMAGE_PIXEL_SENDS_CAP_KEY);
    const n = parseInt(raw ?? "", 10);
    if (!Number.isFinite(n) || n < 1) return DEFAULT_IMAGE_PIXEL_SENDS_CAP;
    return Math.min(n, CAP_MAX);
  } catch {
    return DEFAULT_IMAGE_PIXEL_SENDS_CAP;
  }
}
