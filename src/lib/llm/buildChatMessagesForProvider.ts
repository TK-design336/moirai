import type {
  ChatMessage,
  ChatMessageImagePart,
  HubImportanceTag,
  ImageVisionState,
} from "../../types/engine";
import { dataUrlToBase64 } from "../attachments/extract";
import {
  appendAssistantSurfaceLogContent,
  prefixUserSurfaceLogContent,
} from "../chat/surfaceLogTimestamp";
import { isHubMetaSeparateJudgeEnabled } from "../hub/hubMetaJudgeSettings";
import { stripHubMetaTags } from "../response/hubMetaParse";
import { getImagePixelSendsCap } from "./imagePixelSendsCap";

/** Stable id when the UI omitted one (resend/backward compat). */
export function stableFallbackImageId(messageId: number, index: number): string {
  return `pcimg_${messageId}_${index}`;
}

export function newClientImageId(): string {
  return `pcimg_${crypto.randomUUID()}`;
}

const RECORD_PREFIX = "\n\n[ユーザー送信画像の記録]\n";

function injectImageVisionText(base: string, vision: ImageVisionState, orderedIds: string[]): string {
  const lines = orderedIds.map((id) => {
    const desc = vision.byId[id]?.trim() || "（記録なし）";
    return `- id \`${id}\`: ${desc}`;
  });
  return `${base}${RECORD_PREFIX}${lines.join("\n")}`;
}

/** Input shape matches ChatPanel `Message` fields used for vision. */
export interface VisionBuildMessageInput {
  id: number;
  role: "user" | "ai";
  content: string;
  /** Hub / Inbox: LLM 履歴用の応答時刻（ISO）。未指定時は id から近似。 */
  surfaceLogTimestampIso?: string;
  /** Hub: assistant の `<hub_meta/>`（履歴本文に XML として付与）。 */
  hubImportance?: HubImportanceTag;
  hubTopicShift?: boolean;
  attachments?: Array<{
    type: "image" | "file";
    data: string;
    mimeType: string;
    name: string;
    clientImageId?: string;
  }>;
  imageVision?: ImageVisionState;
}

export interface MessageToChatRowResult {
  chat: ChatMessage;
  /** True when this row carries image bytes to the provider on this request. */
  includedPixels: boolean;
  orderedImageIds: string[];
}

/**
 * Turn one UI message into a `ChatMessage` for the LLM.
 * After `pixelSendsDone >= cap` (see {@link getImagePixelSendsCap}), drop images and append merged descriptions to text.
 */
export function messageToChatMessageRow(msg: VisionBuildMessageInput): MessageToChatRowResult {
  const imageAtts = (msg.attachments ?? []).filter((a) => a.type === "image" && a.data);
  const orderedImageIds = imageAtts.map((a, i) => a.clientImageId ?? stableFallbackImageId(msg.id, i));

  let content = msg.content;
  let images: ChatMessageImagePart[] | undefined;
  let includedPixels = false;

  if (msg.role === "user" && msg.surfaceLogTimestampIso) {
    content = prefixUserSurfaceLogContent(msg.surfaceLogTimestampIso, content);
  }

  if (msg.role === "user" && imageAtts.length > 0) {
    const vision = msg.imageVision;
    const done = vision?.pixelSendsDone ?? 0;
    const cap = getImagePixelSendsCap();
    if (done >= cap) {
      content = injectImageVisionText(
        content,
        vision ?? { byId: {}, pixelSendsDone: cap },
        orderedImageIds,
      );
      images = undefined;
      includedPixels = false;
    } else {
      images = imageAtts.map((a, i) => ({
        clientImageId: orderedImageIds[i]!,
        base64: dataUrlToBase64(a.data),
        mimeType: a.mimeType,
      }));
      includedPixels = true;
      content = `${content}\n\n（このメッセージの画像 id — 応答の <image id> と一致: ${orderedImageIds.join(", ")}）`;
    }
  }

  return {
    chat: {
      role: "user",
      content,
      ...(images && images.length > 0 ? { images } : {}),
    },
    includedPixels,
    orderedImageIds,
  };
}

/** LLM 履歴用: 本文末尾に self-closing の hub_meta を付与（`response/parser.ts` と同形）。 */
export function appendHubMetaXmlToAssistantContentForLlm(
  content: string,
  importance: HubImportanceTag,
  topicShift: boolean,
): string {
  const ts = topicShift ? "true" : "false";
  return `${content}\n\n<hub_meta importance="${importance}" topic_shift="${ts}"/>`;
}

function rowAi(msg: VisionBuildMessageInput): MessageToChatRowResult {
  const iso = msg.surfaceLogTimestampIso ?? new Date(msg.id).toISOString();
  let content = msg.content;
  if (isHubMetaSeparateJudgeEnabled()) {
    content = stripHubMetaTags(content).text.trim();
  } else if (msg.hubImportance !== undefined && !/<hub_meta\s/i.test(content)) {
    content = appendHubMetaXmlToAssistantContentForLlm(
      content,
      msg.hubImportance,
      msg.hubTopicShift === true,
    );
  }
  content = appendAssistantSurfaceLogContent("ai", iso, content);
  return {
    chat: {
      role: "assistant",
      content,
    },
    includedPixels: false,
    orderedImageIds: [],
  };
}

export interface BuildLlmChatMessagesResult {
  messages: ChatMessage[];
  /** User message ids that included image bytes in this request (pixel-send accounting). */
  pixelSourceUserMsgIds: number[];
}

/**
 * Map an ordered list of branch messages (excluding empty content) to API messages.
 */
export function buildLlmChatMessagesFromVisionMessages(
  linearMessages: VisionBuildMessageInput[],
): BuildLlmChatMessagesResult {
  const pixelSourceUserMsgIds: number[] = [];
  const messages: ChatMessage[] = [];

  for (const msg of linearMessages) {
    if (msg.content.trim() === "") continue;
    const pack =
      msg.role === "user" ? messageToChatMessageRow(msg) : rowAi(msg);
    if (pack.includedPixels) pixelSourceUserMsgIds.push(msg.id);
    messages.push(pack.chat);
  }

  return { messages, pixelSourceUserMsgIds };
}
