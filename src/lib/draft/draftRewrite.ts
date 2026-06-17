import type { ChatMessage } from "../../types/engine";
import { callLLMOnce, getModelConfig } from "../llm/client";
import { getDraftSpecForBlockKind } from "../llm/systemPrompt";
import { sliceChatHistoryForSendWindow } from "../llm/sendHistoryWindow";
import { getMaxSendHistory } from "../memory/stm";
import type { DraftBlockKind } from "./draftBlocks";
import { parseDraftRewriteResponse } from "./draftBlocks";

export type DraftRewriteProvider = "gpt" | "gemini" | "claude";

export function getDraftRewriteHistoryTurns(): number {
  const raw = localStorage.getItem("pc-draft-rewrite-history") ?? "5";
  const n = parseInt(raw, 10);
  const cap = getMaxSendHistory();
  if (!Number.isFinite(n) || n < 1) return Math.min(5, cap);
  return Math.min(n, cap);
}

function buildDraftRewriteSystem(
  kind: DraftBlockKind,
  draftId: string,
  messageId: number,
  rawAssistantContent: string,
  currentInner: string,
  userRequest: string,
  currentSubject?: string,
): string {
  const spec = getDraftSpecForBlockKind(kind);
  const subjectLine =
    kind === "email-draft" ? `\nCurrent subject attribute: ${JSON.stringify(currentSubject ?? "")}` : "";
  return `[Draft rewrite — sub-task]
You revise exactly ONE draft block inside a prior assistant message. Output ONLY the single tag below — no emotion line, no other tags, no prose outside the tag.

${spec}

Target:
- assistant message id: ${messageId}
- block id: ${JSON.stringify(draftId)}
- block kind: ${kind}
${subjectLine}

Current block inner text:
---
${currentInner}
---

Full assistant message for context (do not reproduce in full — only rewrite the target block):
---
${rawAssistantContent.slice(0, 12000)}
---

User change request:
${userRequest}

Output: exactly one <${kind} id="${draftId}"${kind === "email-draft" ? ` subject="..."` : ""}>…</${kind}> with the revised content.`;
}

export async function requestDraftRewrite(params: {
  provider: DraftRewriteProvider;
  kind: DraftBlockKind;
  draftId: string;
  messageId: number;
  rawAssistantContent: string;
  currentInner: string;
  currentSubject?: string;
  userRequest: string;
  history: ChatMessage[];
}): Promise<{ inner: string; subject?: string } | null> {
  const {
    provider,
    kind,
    draftId,
    messageId,
    rawAssistantContent,
    currentInner,
    currentSubject,
    userRequest,
    history,
  } = params;

  const turns = getDraftRewriteHistoryTurns();
  const windowed = sliceChatHistoryForSendWindow(history, turns);
  const cfg = getModelConfig(provider, "standard");
  const system = buildDraftRewriteSystem(
    kind,
    draftId,
    messageId,
    rawAssistantContent,
    currentInner,
    userRequest,
    currentSubject,
  );

  const messages: { role: "user" | "assistant"; content: string }[] = [
    ...windowed
      .filter((m): m is ChatMessage & { role: "user" | "assistant" } => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role, content: m.content })),
    {
      role: "user",
      content: `Apply the change request to <${kind} id="${draftId}"> only. Return the updated tag.`,
    },
  ];

  const raw = await callLLMOnce(
    provider,
    cfg.model,
    system,
    messages,
    Math.min(cfg.maxTokens, 4096),
    Math.min(cfg.temperature, 0.7),
    "draft-rewrite",
  );

  return parseDraftRewriteResponse(raw, kind, draftId);
}
