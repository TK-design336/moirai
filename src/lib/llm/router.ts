import type { TaskKind, LLMMode, RouteResult, ChatMessage } from "../../types/engine";
import { extractDatesFromText } from "../dateExtractor";
import { callLLMOnce, getModelConfig } from "./client";

/* ---- keyword lists ---- */

const SCHEDULE_KEYWORDS = ["スケジュール","予定","カレンダー","空き時間","日程","締め切り","schedule","calendar"];
const MAP_KEYWORDS      = ["地図","マップ","場所","スポット","店","お店","観光","旅行","デート","旅行","観光","ツアー","コース","周遊","お出かけ","プロット","ピン","map","spot","place","location","venue"];
const TRANSIT_KEYWORDS  = ["乗換","電車","移動","ルート","出発","到着","交通","バス","地下鉄","transit","route","train"];
const TASK_KEYWORDS     = ["タスク","TODO","やること","リスト","期限","進捗","完了","締切","ルーティン","task","todo"];
const EMAIL_KEYWORDS    = ["メール","Gmail","返信","返事", "未読","受信","送信","メール下書き","返信文","email","mail","gmail"];
const DRAFT_KEYWORDS    = ["下書き","書き直し","推敲","原稿","段落","志望理由","自己PR","リライト","推敲して","書いて直して","下書き","回答","解答","答案","草稿","ドラフト","proofread","rewrite","draft block","本文を"];
const COMPARE_KEYWORDS  = ["比較","おすすめ","どっち","選んで","商品","店","献立","メニュー","価格","サービス","サブスク","プラン","候補","契約","見積","compare","vs","recommend"];
const QUIZ_KEYWORDS     = ["問題","クイズ","学習学習","テスト","練習","復習","覚え","試験","quiz","test","drill"];
const NOTE_KEYWORDS     = ["まとめ","要約","ノート","整理","記録","保存","メモ","note","summarize","summary"];
const TIMER_KEYWORDS    = ["タイマー","アラーム","タイマー設定","アラーム設定","pomodoro","ポモドーロ","timer","alarm"];
const REMIND_KEYWORDS   = ["リマインド","リマインドして","リマインダー","remind","reminder","忘れないで","忘れずに", "思い出", "通知"];
const CHAT_NAV_KEYWORDS = [
  "Inbox", "inbox", "インボックス",
  "Hub", "hub", "ハブ",
  "チャット", "セッション", "Log", "log", "ログ", "履歴", "会話", "タブ"
];
const YOUTUBE_KEYWORDS = [
  "かけて", "流して", "聞きたい", "動画", "映像", "曲",
  "youtube", "YouTube", "ユーチューブ", "再生して", "BGM",
];

const REASONING_KEYWORDS = ["なぜ","原因","分析","評価","判断","考察","比較検討","設計","アーキテクチャ","戦略","推論","why","analyze","design","strategy","architecture"];
const STANDARD_KEYWORDS  = ["作成","生成","書いて","計画","提案","作って","リスト","compare","create","generate","plan","propose"];
const FAST_KEYWORDS     = ["おはよう","こんにちは","こんばんは","おやすみ","やあ","よっ","ありがとう","了解","thanks","ok","okay","うん","はい","いいえ","そうだね","そうですね","ね","よろしく","hi","hello","bye","bye bye"];
const SEARCH_KEYWORDS    = ["最新","今日","天気","ニュース","価格","いくら","現在","今","latest","today","weather","news","price","current"];

function scoreKeywords(text: string, keywords: string[], weight = 2): number {
  return keywords.reduce((score, k) => score + (text.includes(k) ? weight : 0), 0);
}

function calcReasoningScore(text: string): number {
  return scoreKeywords(text, REASONING_KEYWORDS, 2);
}

function calcStandardScore(text: string): number {
  return scoreKeywords(text, STANDARD_KEYWORDS, 1);
}

function calcSearchScore(text: string): number {
  return scoreKeywords(text, SEARCH_KEYWORDS, 2);
}

function calcFastScore(text: string): number {
  return scoreKeywords(text, FAST_KEYWORDS, 2);
}

export function taskKindScores(text: string): Record<TaskKind, number> {
  const scores: Record<TaskKind, number> = {
    schedule: 0, map: 0, transit: 0, task: 0, email: 0,
    compare: 0, quiz: 0, note: 0, timer: 0, remind: 0, draft: 0, chat_nav: 0, youtube: 0, general: 0,
  };

  const score = (kind: TaskKind, keywords: string[], w = 2) => {
    keywords.forEach((k) => { if (text.includes(k)) scores[kind] += w; });
  };

  score("schedule", SCHEDULE_KEYWORDS, 3);
  score("map",      MAP_KEYWORDS,      3);
  score("transit",  TRANSIT_KEYWORDS,  3);
  score("task",     TASK_KEYWORDS,      2);
  score("email",    EMAIL_KEYWORDS,     3);
  score("draft",    DRAFT_KEYWORDS,     3);
  score("compare",  COMPARE_KEYWORDS,   2);
  score("quiz",     QUIZ_KEYWORDS,      3);
  score("note",     NOTE_KEYWORDS,      2);
  score("timer",    TIMER_KEYWORDS,     3);
  score("remind",   REMIND_KEYWORDS,    3);
  score("chat_nav", CHAT_NAV_KEYWORDS,  3);
  score("youtube",  YOUTUBE_KEYWORDS,    3);

  return scores;
}

export function ruleBasedRoute(text: string, webToggle: boolean): RouteResult {
  const scores = taskKindScores(text);

  const maxScore = Math.max(...(Object.keys(scores) as TaskKind[]).filter((k) => k !== "general").map((k) => scores[k]), 0);
  const taskKinds: TaskKind[] = maxScore > 0
    ? (Object.keys(scores) as TaskKind[]).filter((k) => k !== "general" && scores[k] >= maxScore)
    : ["general"];

  const reasoningScore = calcReasoningScore(text);
  const standardScore  = calcStandardScore(text);
  const fastScore     = calcFastScore(text);
  let mode: LLMMode = "standard";
  if (reasoningScore >= 3 && reasoningScore >= standardScore + 1) mode = "reasoning";
  else if (fastScore >= 2 && reasoningScore < 2 && standardScore < 2) mode = "fast";

  const searchScore = calcSearchScore(text);
  const webSearch = webToggle || searchScore >= 3;

  const extractedDates = extractDatesFromText(text, new Date());
  console.log("[Router] scores:", scores, "→ taskKinds:", taskKinds, "| mode:", mode, "| webSearch:", webSearch, "| dates:", extractedDates.length);
  return { taskKinds, mode, webSearch, extractedDates };
}

/* ---- LLM-based router (fallback) ---- */

const DEFAULT_ROUTER_SYSTEM = `You are a routing classifier. Given a user message, output EXACTLY one line in this format:
[TASK_KIND1,TASK_KIND2,...,MODE,WEB_SEARCH]

TASK_KIND (choose one or more based on user intent, comma-separated):
- schedule: 予定・カレンダー・空き時間・日程の相談
- map: 場所・スポット・地図・旅行プラン・ルート
- transit: 乗換・電車・バス・出発到着・交通
- task: タスク・TODO・やること・期限・完了
- email: メール・Gmail・返信・未読・新規メール下書き
- draft: 段落・原稿・推敲・書き直し・志望理由など編集可能な本文ブロック
- compare: 比較・おすすめ・どっち・選んで・商品
- note: まとめ・要約・ノート・整理・保存
- quiz: クイズ・テスト・練習・問題
- timer: タイマー・アラーム・ポモドーロ
- remind: 一度限りのリマインド・Inbox 通知・「〜したら教えて」
- chat_nav: アプリの画面切替・Inbox/Scratch・過去の会話を開く・別セッション
- youtube: YouTubeで音楽・動画の再生、またはアプリ内プレイヤーの操作（かけて/流して/聞きたい/動画/曲 など）
- general: 上記のいずれにも当てはまらない一般的な会話

- TASK_KIND: one or more of schedule|map|transit|task|email|draft|compare|note|quiz|timer|remind|chat_nav|youtube|general (comma-separated)
- MODE: default is standard. Use fast ONLY for simple greetings/acknowledgments (e.g. おはよう, ありがとう, ok). Use reasoning for complex analysis, design, strategy.
- WEB_SEARCH: true|false
Output NOTHING else.`;

export async function llmRoute(
  userText: string,
  _history: ChatMessage[],
  provider: "gpt" | "gemini" | "claude",
): Promise<RouteResult> {
  // Use a minimal single-turn call to the LLM
  try {
    const cfg = getModelConfig(provider, "router");
    const messages = [
      { role: "user" as const, content: userText },
    ];

    const result = await callLLMOnce(
      provider,
      cfg.model,
      DEFAULT_ROUTER_SYSTEM,
      messages,
      Math.min(cfg.maxTokens, 80),
      cfg.temperature,
      "router",
    );
    const match = result.trim().match(/\[([\w,]+),(fast|standard|reasoning),(true|false)\]/);
    if (match) {
      const kindStrs = match[1].split(",").map((s) => s.trim()).filter(Boolean);
      const validKinds: readonly TaskKind[] = [
        "schedule", "map", "transit", "task", "email", "draft", "compare", "note", "quiz", "timer", "remind", "chat_nav", "youtube", "general",
      ];
      const taskKinds = kindStrs.filter((k): k is TaskKind => validKinds.includes(k as TaskKind)) as TaskKind[];
      const extractedDates = extractDatesFromText(userText, new Date());
      return {
        taskKinds: taskKinds.length > 0 ? taskKinds : ["general"],
        mode: match[2] as LLMMode,
        webSearch: match[3] === "true",
        extractedDates,
      };
    }
  } catch (e) {
    console.warn("LLM router failed, falling back to rule-based:", e);
  }
  return ruleBasedRoute(userText, false);
}
