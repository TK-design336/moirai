import type { SpecialPanelData } from "../components/SpecialPanels";

export type TaskKind =
  | "schedule" | "map" | "transit" | "task"
  | "email" | "compare"
  | "note" | "quiz" | "timer" | "remind"
  | "draft"
  | "chat_nav"
  | "youtube"
  | "general";

/** Parsed from `<ui_action>` (client UI navigation). */
export type UiAction =
  | { type: "open_new_chat" }
  | { type: "open_inbox" }
  | { type: "open_hub" }
  | { type: "show_log_links"; query: string };

/** Rendered under an AI message when `show_log_links:` keyword search yields hits (click opens that tab). */
export interface OpenSessionNavLinkItem {
  key: string;
  titleBold: string;
  hitLabel: string;
  updatedLabel: string;
  surface: "session" | "scratch" | "inbox";
  sessionId?: string;
  branchId: string;
  messageId: number;
  inboxBranchId?: string | null;
  highlightQuery: string;
}

export type LLMMode = "fast" | "standard" | "reasoning";

export interface RouteResult {
  taskKinds: TaskKind[];
  mode: LLMMode;
  webSearch: boolean;
  extractedDates?: Date[];
}

export type AvatarState =
  | "idle" | "listening" | "thinking" | "fetching"
  | "drafting" | "speaking" | "approved" | "error" | "sleep";

export interface Citation {
  url: string;
  title: string;
  endIndex?: number; // character offset in parsed `body` string; undefined = no inline position
}

export interface TimerActionPayload {
  type: "timer" | "alarm";
  action?: "start" | "stop" | "reset" | "pomodoro";
  minutes?: number;
  seconds?: number;
  alarmTime?: string;
  alarmLabel?: string;
}

/** Parsed from `<remind>` — one-shot Inbox reminder at fireAt. */
export interface RemindPayload {
  fireAt: string;
  content: string;
}

export interface NotePatchHunk {
  startLine: number;
  endLine: number;
  newText: string;
}

export type YoutubePlayKind = "music" | "video";

export type YoutubeControlAction =
  | "pause"
  | "resume"
  | "play"
  | "volume_up"
  | "volume_down";

export interface YoutubePlayEntry {
  kind: YoutubePlayKind;
  query: string;
}

export interface YoutubeControlEntry {
  action: YoutubeControlAction;
}

export interface YoutubeEmbedState {
  kind: YoutubePlayKind;
  query: string;
  videoId?: string;
  fallbackUrl?: string;
}

/** Per-image lines for LLM history after pixel round-trips complete (client-managed). */
export interface ImageDescriptionUpdate {
  id: string;
  text: string;
}

export interface ParsedResponse {
  emotion: string;
  degree: number;
  body: string;
  /** ストリーム完了時の生テキスト（`Message.content` 保存用。未設定時は呼び出し側の ref にフォールバック） */
  rawText?: string;
  avatarState: AvatarState;
  panelData?: SpecialPanelData;
  taskData?: TaskPanelData;
  timerData?: TimerActionPayload;
  remindData?: RemindPayload | RemindPayload[];
  notePatch?: NotePatchHunk[];
  media: string[];
  prompts: string[];
  citations: Citation[];
  youtubePlays?: YoutubePlayEntry[];
  youtubeControls?: YoutubeControlEntry[];
  /** Stripped from body; merged into user message image vision state by ChatPanel. */
  imageDescriptionUpdates?: ImageDescriptionUpdate[];
  /** Stripped from `<ui_action>` (TaskKind `chat_nav`). */
  uiActions?: UiAction[];
  /** Hub surface only: stripped from body. */
  hubMeta?: { importance: 1 | 2 | 3 | 4 | 5; topicShift: boolean };
  /** Hub: recall chunk by STM title match (stripped from body). */
  hubRecallTitle?: string;
}

export interface STMState {
  summary: string;
  turnCount: number;
  lastUpdatedAt: string;
  /** Number of messages that were already included in the last STM compression. */
  lastCompressedMessageCount?: number;
}

export type LTMCategory =
  | "profile"
  | "habit"
  | "task"
  | "decision"
  | "learning";

export interface LTMEntry {
  id: string;
  category: LTMCategory;
  content: string;
  confirmedCount: number;
  status: "pending" | "active";
  createdAt: string;
  lastSeen: string;
  /** Per-entry TTL; omit for unlimited (category policy may still apply). */
  ttlDays?: number;
}

export interface LTMData {
  entries: LTMEntry[];
  schemaVersion: "2";
}

export interface TaskItem {
  id: string;
  title: string;
  priority: "high" | "normal" | "low";
  deadline?: string;
  estimatedMinutes?: number;
  notes?: string;
  subtasks: { id: string; title: string; done: boolean }[];
  status: "proposed" | "active" | "done" | "rejected";
  tags: string[];
  action?: "add" | "done" | "edit" | "delete";
}

export interface TaskPanelData {
  tasks: TaskItem[];
}

/** Multimodal image part aligned with client-side attachment id (per-message). */
export interface ChatMessageImagePart {
  clientImageId: string;
  base64: string;
  mimeType: string;
}

/** Hub の `<hub_meta importance="…"/>`（UI / Vision 入力用。LLM 履歴本文には XML として埋め込む）。 */
export type HubImportanceTag = 1 | 2 | 3 | 4 | 5;

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  /** When set, provider request uses this message’s image parts (not global `images`). */
  images?: ChatMessageImagePart[];
}

/** Attachment metadata passed from UI to LLM engine */
export interface SendAttachment {
  kind: "image" | "text" | "pdf-direct";
  name: string;
  mimeType: string;
  /** base64 string (no data: prefix) — used for image/pdf-direct */
  base64?: string;
  /** Extracted plain text — used for text kind */
  text?: string;
  /** Stable id for vision description merge (image kind). */
  clientImageId?: string;
}

/** Stored on user messages that had image attachments (ChatPanel). */
export interface ImageVisionState {
  byId: Record<string, string>;
  /** Completed API pixel round-trips for this message’s images — at/above the configured cap, history uses merged text only (Models タブの履歴設定). */
  pixelSendsDone: number;
}
