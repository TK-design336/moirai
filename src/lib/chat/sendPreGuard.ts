import { analyzeIncompleteSend, incompleteSendFingerprint } from "./incompleteSendGuard";
import { analyzeUnavailableUrlsForSend } from "../url/sendGuard";
import type { UrlContextAttachment } from "../url/types";

export interface SendPreGuardAnalysis {
  reasons: string[];
  hasIncomplete: boolean;
  hasUrl: boolean;
}

export function analyzeSendPreGuard(
  userText: string,
  pendingUrlContexts: UrlContextAttachment[],
  incompleteGuardEnabled: boolean,
): SendPreGuardAnalysis {
  const urlAnalysis = analyzeUnavailableUrlsForSend(userText, pendingUrlContexts);
  const incompleteAnalysis = incompleteGuardEnabled
    ? analyzeIncompleteSend(userText)
    : { warn: false, reasons: [] as string[] };

  const reasons = [
    ...urlAnalysis.reasons,
    ...(incompleteAnalysis.warn ? incompleteAnalysis.reasons : []),
  ];

  return {
    reasons,
    hasIncomplete: incompleteAnalysis.warn,
    hasUrl: urlAnalysis.warn,
  };
}

/** 2回目の「このまま送信」照合用（本文 + 警告理由を含む） */
export function sendPreGuardFingerprint(text: string, reasons: string[]): string {
  return `${incompleteSendFingerprint(text)}\n<<send-pre-guard>>\n${reasons.join("\n")}`;
}

export function sendPreGuardTitle(flags: { hasIncomplete: boolean; hasUrl: boolean }): string {
  if (flags.hasIncomplete && flags.hasUrl) return "送信前の確認";
  if (flags.hasUrl) return "URLの取得に問題があります";
  return "文末が未完の可能性があります";
}
