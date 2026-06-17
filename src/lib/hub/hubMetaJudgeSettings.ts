/** Hub: importance / topic_shift を Hub 本体ではなく Router モデルで別判定する（既定: true）。 */
export const HUB_META_SEPARATE_JUDGE_KEY = "pc-hub-meta-separate-judge";

export function isHubMetaSeparateJudgeEnabled(): boolean {
  const raw = localStorage.getItem(HUB_META_SEPARATE_JUDGE_KEY);
  if (raw === null) return true;
  return raw === "true";
}

export function setHubMetaSeparateJudgeEnabled(enabled: boolean): void {
  localStorage.setItem(HUB_META_SEPARATE_JUDGE_KEY, String(enabled));
}
