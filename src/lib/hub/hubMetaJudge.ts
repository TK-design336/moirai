import type { ParsedResponse } from "../../types/engine";
import {
  appendAssistantSurfaceLogContent,
  stripHistoryTimestampComments,
} from "../chat/surfaceLogTimestamp";
import { callLLMOnce, getModelConfig } from "../llm/client";
import { HUB_META_CRITERIA } from "../llm/systemPrompt";
import { parseLastHubMetaFromContent } from "../response/hubMetaParse";
import { peelLeadingEmotion, stripNoreadTagsForDisplay } from "../tts/streamSplitter";
import { defaultHubMeta } from "./hubAfterCompletion";
import { isHubMetaSeparateJudgeEnabled } from "./hubMetaJudgeSettings";
import type { HubImportance } from "./types";

/** Router 送信用: XML・感情タグ・タイムスタンプを除去してプレーンテキスト化。 */
export function stripContentForHubMetaJudge(text: string): string {
  let t = text;
  t = t.replace(/<hub_meta\s[^>]*\/?>/gi, "");
  for (let i = 0; i < 8; i++) {
    const next = t.replace(/<([a-zA-Z][\w-]*)[^>]*>[\s\S]*?<\/\1>/gi, "");
    if (next === t) break;
    t = next;
  }
  t = t.replace(/<[^>]+\/>/gi, "");
  t = t.replace(/<[^>]+>/gi, "");
  let trimmed = t.trimStart();
  for (let i = 0; i < 8 && trimmed.length > 0; i++) {
    const afterMeta = stripHistoryTimestampComments(trimmed);
    const peeled = peelLeadingEmotion(afterMeta);
    if (afterMeta === trimmed && peeled.text === trimmed) break;
    trimmed = peeled.text.trimStart();
  }
  t = trimmed;
  t = t.replace(/^\s*\[(?:EMOTION:)?(?:Neutral|Happy|Angry|Sad|Surprised|Embarrassed)\s*:\s*[123][^\]]*\]\s*/gim, "");
  t = t.replace(/^\s*<(?:Neutral|Happy|Angry|Sad|Surprised|Embarrassed):[123]>\s*/gim, "");
  t = stripNoreadTagsForDisplay(t);
  t = stripHistoryTimestampComments(t);
  t = t.replace(/\n\n\[ユーザー送信画像の記録\][\s\S]*/g, "");
  return t.replace(/\n{3,}/g, "\n\n").trim();
}

export type HubMetaJudgeMessage = { role: "user" | "ai"; content: string };

/** 直近3往復（User/Assistant × 3 = 6ターン）を判定コンテキストに使う。 */
export const HUB_META_JUDGE_MAX_TURNS = 6;

export function formatHubMetaJudgeConversation(messages: HubMetaJudgeMessage[]): string {
  return messages
    .filter((m) => m.content.trim())
    .slice(-HUB_META_JUDGE_MAX_TURNS)
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${stripContentForHubMetaJudge(m.content)}`)
    .join("\n\n");
}

const HUB_META_JUDGE_SYSTEM = `You classify the LATEST assistant reply in a short Hub conversation excerpt.
Output ONLY one JSON object on a single line, no markdown:
{"importance":1-5,"topic_shift":true|false}

Judge importance and topic_shift for the final Assistant message only, using the User/Assistant turns below as context.

${HUB_META_CRITERIA}`;

function parseHubMetaJudgeResponse(raw: string): { importance: HubImportance; topicShift: boolean } | null {
  const trimmed = raw.trim();
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const o = JSON.parse(jsonMatch[0]) as { importance?: unknown; topic_shift?: unknown; topicShift?: unknown };
      const imp = Number(o.importance);
      if (imp >= 1 && imp <= 5) {
        const tsRaw = o.topic_shift ?? o.topicShift;
        const topicShift = tsRaw === true || String(tsRaw).toLowerCase() === "true";
        return { importance: Math.round(imp) as HubImportance, topicShift };
      }
    } catch {
      /* fall through */
    }
  }
  const fromTag = parseLastHubMetaFromContent(trimmed);
  if (fromTag) {
    return { importance: fromTag.importance, topicShift: fromTag.topicShift };
  }
  return null;
}

export async function judgeHubMetaFromRecentMessages(
  messages: HubMetaJudgeMessage[],
  provider: "gpt" | "gemini" | "claude",
): Promise<{ importance: HubImportance; topicShift: boolean }> {
  const conversation = formatHubMetaJudgeConversation(messages);
  if (!conversation.trim()) return defaultHubMeta();

  const cfg = getModelConfig(provider, "router");
  const userContent = `Recent turns (latest Assistant reply is what you judge):\n\n${conversation}`;

  const raw = await callLLMOnce(
    provider,
    cfg.model,
    HUB_META_JUDGE_SYSTEM,
    [{ role: "user", content: userContent }],
    Math.max(cfg.maxTokens, 64),
    cfg.temperature,
    "hub-meta-judge",
  );

  const parsed = parseHubMetaJudgeResponse(raw);
  if (parsed) return parsed;

  console.warn("[Hub meta judge] unparseable response, using default:", raw);
  return defaultHubMeta();
}

/** Hub 応答完了時: 別判定なら Router、統合なら応答内 hub_meta。 */
export async function resolveHubMetaForAssistantTurn(
  parsed: ParsedResponse,
  judgeMessages: HubMetaJudgeMessage[],
  provider: "gpt" | "gemini" | "claude",
): Promise<{ importance: HubImportance; topicShift: boolean }> {
  if (isHubMetaSeparateJudgeEnabled()) {
    try {
      return await judgeHubMetaFromRecentMessages(judgeMessages, provider);
    } catch (e) {
      console.warn("[Hub meta judge] failed, using default:", e);
      return defaultHubMeta();
    }
  }
  return parsed.hubMeta ?? defaultHubMeta();
}

/** 判定用に直近ターンを組み立て（ストリーム確定本文を AI 側に反映）。 */
export function buildHubMetaJudgeMessages(
  linear: Array<{ role: "user" | "ai"; content: string; surfaceLogTimestampIso?: string }>,
  userContent: string,
  aiContent: string,
  aiTimestampIso?: string,
): HubMetaJudgeMessage[] {
  const body = aiTimestampIso
    ? appendAssistantSurfaceLogContent("ai", aiTimestampIso, aiContent)
    : aiContent;
  const withTurn: HubMetaJudgeMessage[] = [
    ...linear
      .filter((m) => m.content.trim())
      .map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: userContent },
    { role: "ai", content: body },
  ];
  return withTurn.slice(-HUB_META_JUDGE_MAX_TURNS);
}
