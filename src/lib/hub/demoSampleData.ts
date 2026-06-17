/**
 * Deterministic Hub demo (messages + chunk/STM state) for manual QA without LLM.
 * Loaded from Settings → General → デバッグ（QA）→「テスト用サンプルを Hub に読み込む」
 * (Settings 内の確認ダイアログ → `window` event `pc-hub-load-demo-sample`, handled in ChatPanel).
 */
import type { HubPersistedState, HubChunkRecord } from "./types";
import { ttlMsForImportance } from "./importanceTtl";
import { makeStmEntry } from "./hubStm";
import type { Citation } from "../../types/engine";
import type { AnyPayload, SpecialPanelData } from "../../components/SpecialPanels";
import {
  DEMO_CALENDAR,
  DEMO_MAP,
  cloneMapPayload,
  DEMO_TRANSIT,
  DEMO_EMAIL,
  DEMO_COMPARE,
  DEMO_NOTE,
  DEMO_QUIZ,
  type QuestionPayload,
} from "../../components/SpecialPanels";

const DEMO_QUESTION_CLARIFY: QuestionPayload = {
  items: [
    {
      id: "hq1",
      text: "主な用途はどれに近いですか？（複数可）",
      allowFree: true,
      options: ["開発（IDE）", "動画編集", "会議・資料", "ブラウザ中心", "ゲーム"],
    },
    {
      id: "hq2",
      text: "持ち運び頻度は？",
      allowFree: false,
      options: ["ほぼ据え置き", "週数日", "毎日カバン"],
    },
  ],
};

const DEMO_QUESTION_FOLLOWUP: QuestionPayload = {
  items: [
    {
      id: "hq3",
      text: "OS の希望はありますか？",
      allowFree: true,
      options: ["macOS", "Windows", "どちらでも"],
    },
  ],
};

/** Minimal message shape compatible with ChatPanel `Message`. */
export interface HubDemoMessage {
  id: number;
  role: "user" | "ai";
  content: string;
  timestamp?: string;
  hubImportance?: 1 | 2 | 3 | 4 | 5;
  specialData?: SpecialPanelData;
  citations?: Citation[];
  suggestedPrompts?: string[];
  emotionTag?: string;
}

export interface HubDemoSeed {
  messages: HubDemoMessage[];
  hub: HubPersistedState;
}

export function getHubDemoSampleSeed(): HubDemoSeed {
  const now = Date.now();
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();

  const citeCalendarBody =
    "午後は移動が入っているので、**既存予定の前後**に短いブロックを置くのが現実的です。参考: 社内カレンダーガイド `CIT:0`";
  const citeCalendar: Citation[] = [
    {
      url: "https://example.com/internal/calendar-guide",
      title: "社内カレンダー運用ガイド",
      endIndex: citeCalendarBody.indexOf("`CIT:0`"),
    },
  ];

  const citeTransitBody =
    "渋谷→品川は山手線か京急方面の乗り換えで15〜25分程度が目安です（時刻はパネル参照）。出典 `CIT:0`";
  const citeTransit: Citation[] = [
    {
      url: "https://www.jreast.co.jp/",
      title: "JR東日本（路線・時刻）",
      endIndex: citeTransitBody.indexOf("`CIT:0`"),
    },
  ];

  const messages: HubDemoMessage[] = [
    /* --- Chunk 1: trivial / single_line --- */
    { id: 920001, role: "user", content: "5分だけ休憩タイマーを", timestamp: iso(7200_000) },
    {
      id: 920002,
      role: "ai",
      content: "5分のタイマーをセットしました。鳴ったらストレッチでもどうぞ。",
      timestamp: iso(7199_000),
      hubImportance: 1,
    },

    /* --- Chunk 2: calendar + citation --- */
    {
      id: 920003,
      role: "user",
      content: "明日の午後、移動できる空き枠をカレンダー形式で見せて。提案イベントも足して",
      timestamp: iso(7100_000),
    },
    {
      id: 920004,
      role: "ai",
      content: citeCalendarBody,
      timestamp: iso(7098_000),
      hubImportance: 4,
      citations: citeCalendar,
      specialData: {
        panelType: "calendar",
        title: "明日のスケジュール",
        subtitle: "提案イベントはドラッグで調整できます",
        payload: DEMO_CALENDAR,
      },
    },

    /* --- Chunk 3: map then transit --- */
    { id: 920005, role: "user", content: "土曜の午前、渋谷から表参道周りを散歩ルートで組んで", timestamp: iso(5000_000) },
    {
      id: 920006,
      role: "ai",
      content: "滞在時間と移動をざっくり載せたルート案です。ピン番号の順で回ると自然です。",
      timestamp: iso(4998_000),
      hubImportance: 3,
      specialData: {
        panelType: "map",
        title: "散歩ルート（案）",
        subtitle: "route-plan",
        payload: cloneMapPayload(DEMO_MAP),
      },
    },
    { id: 920007, role: "user", content: "同じ日の昼過ぎに品川へ移動するなら？", timestamp: iso(4985_000) },
    {
      id: 920008,
      role: "ai",
      content: citeTransitBody,
      timestamp: iso(4983_000),
      hubImportance: 3,
      citations: citeTransit,
      specialData: {
        panelType: "transit",
        title: "渋谷 → 品川",
        subtitle: DEMO_TRANSIT.date,
        payload: DEMO_TRANSIT,
      },
    },

    /* --- Chunk 4: compare + question panels --- */
    { id: 920009, role: "user", content: "15万前後でノートPCを3機種くらい比較したい", timestamp: iso(3200_000) },
    {
      id: 920010,
      role: "ai",
      content:
        "価格帯が近い定番ど真ん中を並べました。重さ・バッテリー・画面のトレードオフが見えやすいです。",
      timestamp: iso(3198_000),
      hubImportance: 5,
      specialData: {
        panelType: "compare",
        title: "ノートPC 比較",
        subtitle: "compareType: product",
        payload: DEMO_COMPARE,
      },
    },
    { id: 920011, role: "user", content: "用途は開発メインで、週3くらいは持ち歩き", timestamp: iso(3180_000) },
    {
      id: 920012,
      role: "ai",
      content: "了解です。次の2点だけ押さえられれば絞り込みが一段進みます。",
      timestamp: iso(3178_000),
      hubImportance: 3,
      specialData: {
        panelType: "question",
        title: "追加の確認",
        payload: DEMO_QUESTION_CLARIFY,
      },
    },
    { id: 920013, role: "user", content: "Windows でもいいけど、キーボードは打鍵感重視", timestamp: iso(3160_000) },
    {
      id: 920014,
      role: "ai",
      content: "キーボード重視なら ThinkPad 系が強いですが、最終的に OS で絞るならこちらも。",
      timestamp: iso(3158_000),
      hubImportance: 2,
      specialData: {
        panelType: "question",
        title: "OS の希望",
        payload: DEMO_QUESTION_FOLLOWUP,
      },
    },

    /* --- Chunk 5: long multiturn (ellipsis / chunk body) --- */
    { id: 920015, role: "user", content: "日曜の夕食、鍋にしたい。人数は大人2子ども1", timestamp: iso(2100_000) },
    { id: 920016, role: "ai", content: "なら出汁は濃くしすぎず、昆布＋かつおで軽めが安全です。", timestamp: iso(2098_000), hubImportance: 3 },
    { id: 920017, role: "user", content: "具材はスーパーで揃えたい。定番で迷わない組み合わせは？", timestamp: iso(2085_000) },
    { id: 920018, role: "ai", content: "白菜・葱・豆腐・しめじ・豚バラ薄切り・つみれが扱いやすい定番セットです。", timestamp: iso(2083_000), hubImportance: 3 },
    { id: 920019, role: "user", content: "〆はうどんとごはん、どっちが子ども向け？", timestamp: iso(2070_000) },
    { id: 920020, role: "ai", content: "子どもは汁物慣れがあるならうどん、炭水化物欲しがるなら雑炊寄せのごはん〆も喜ばれます。", timestamp: iso(2068_000), hubImportance: 3 },
    { id: 920021, role: "user", content: "買い物リストを箇条書きでまとめて", timestamp: iso(2055_000) },
    {
      id: 920022,
      role: "ai",
      content:
        "- 昆布・かつおパック\n- 白菜 1/4\n- 葱 2本\n- 木綿豆腐 1丁\n- しめじ 1パック\n- 豚バラ 200g\n- つみれ\n- うどん（乾燥でも可）",
      timestamp: iso(2053_000),
      hubImportance: 3,
    },
    { id: 920023, role: "user", content: "あとデザートはコンビニで軽く", timestamp: iso(2040_000) },
    { id: 920024, role: "ai", content: "杏仁豆腐・プリン・フルーツゼリーのどれか一つだと後片付けも楽です。", timestamp: iso(2038_000), hubImportance: 3 },

    /* --- Chunk 6: email then note / chunk_card（2往復） --- */
    { id: 920025, role: "user", content: "朝いちばんに見るべきメールだけ要約して", timestamp: iso(900_000) },
    {
      id: 920026,
      role: "ai",
      content: "緊急フラグが付いている件から上に並べています。返信が必要なものはパネルから開けます。",
      timestamp: iso(898_000),
      hubImportance: 3,
      specialData: {
        panelType: "email",
        title: "受信トレイ（デモ）",
        payload: DEMO_EMAIL,
      },
    },
    { id: 920027, role: "user", content: "返信方針をメモに残したい", timestamp: iso(880_000) },
    {
      id: 920028,
      role: "ai",
      content: "要点だけ Markdown にまとめました。コピーしてそのまま送れます。",
      timestamp: iso(878_000),
      hubImportance: 2,
      specialData: {
        panelType: "note",
        title: "返信メモ",
        payload: DEMO_NOTE,
      },
    },

    /* --- Chunk 7: open — quiz + task notice + suggested prompts --- */
    { id: 920029, role: "user", content: "React の基礎をクイズ形式で復習したい", timestamp: iso(120_000) },
    {
      id: 920030,
      role: "ai",
      content: "drill モードのデモです。間違えても解説が出ます。別タスクとしてボード連携の案内も出しています。",
      timestamp: iso(118_000),
      hubImportance: 3,
      emotionTag: "happy",
      suggestedPrompts: ["次は exam モードで", "hooks だけに絞って", "解答を全部見せて"],
      specialData: {
        panelType: "quiz",
        title: "React 基礎クイズ",
        subtitle: DEMO_QUIZ.topic,
        payload: DEMO_QUIZ,
      },
    },
    {
      id: 920031,
      role: "ai",
      content: "あわせてタスクボード側で優先度付けする場合は、こちらのパネルから開いてください（デモ）。",
      timestamp: iso(110_000),
      hubImportance: 2,
      specialData: {
        panelType: "task",
        title: "タスク（デモ）",
        subtitle: "TaskBoard 連携",
        /** Task パネルは payload を描画しないが、型は AnyPayload のみ許可 */
        payload: { tasks: [] } as unknown as AnyPayload,
      },
    },
  ];

  const closedAt1 = iso(7150_000);
  const closedAt2 = iso(5050_000);
  const closedAt3 = iso(3300_000);
  const closedAt4 = iso(2120_000);
  const closedAt5 = iso(850_000);

  const chunkTrivial: HubChunkRecord = {
    id: "chk_hubdemo_trivial",
    messageIds: [920001, 920002],
    closedAt: closedAt1,
    maxImportance: 1,
    title: "",
    shortSummary: "",
    folderId: null,
    titleGenDone: true,
    collapsed: "single_line",
    expiresAtMs: now + ttlMsForImportance(1),
  };
  const chunkCalendar: HubChunkRecord = {
    id: "chk_hubdemo_calendar",
    messageIds: [920003, 920004],
    closedAt: closedAt1,
    maxImportance: 4,
    title: "午後の空き枠",
    shortSummary: "移動を踏まえ既存予定の前後に短いブロックを提案。",
    folderId: null,
    titleGenDone: true,
    collapsed: "chunk_card",
    expiresAtMs: now + ttlMsForImportance(4),
  };
  const chunkRoute: HubChunkRecord = {
    id: "chk_hubdemo_route",
    messageIds: [920005, 920006, 920007, 920008],
    closedAt: closedAt2,
    maxImportance: 3,
    title: "渋谷〜表参道〜品川",
    shortSummary: "散歩ルート案と昼過ぎの品川移動（路線デモ）。",
    folderId: null,
    titleGenDone: true,
    collapsed: "chunk_card",
    expiresAtMs: now + ttlMsForImportance(3),
  };
  const chunkLaptop: HubChunkRecord = {
    id: "chk_hubdemo_laptop",
    messageIds: [920009, 920010, 920011, 920012, 920013, 920014],
    closedAt: closedAt3,
    maxImportance: 5,
    title: "ノートPC選定",
    shortSummary: "3機種比較と用途・OSの確認パネル。",
    folderId: null,
    titleGenDone: true,
    collapsed: "chunk_card",
    expiresAtMs: now + ttlMsForImportance(5),
  };
  const chunkDinner: HubChunkRecord = {
    id: "chk_hubdemo_dinner",
    messageIds: [920015, 920016, 920017, 920018, 920019, 920020, 920021, 920022, 920023, 920024],
    closedAt: closedAt4,
    maxImportance: 3,
    title: "日曜夕食・鍋",
    shortSummary: "5往復で具材・〆・買い物リストとデザートまで整理。",
    folderId: null,
    titleGenDone: true,
    collapsed: "chunk_card",
    expiresAtMs: now + ttlMsForImportance(3),
  };
  const chunkInbox: HubChunkRecord = {
    id: "chk_hubdemo_inbox",
    messageIds: [920025, 920026, 920027, 920028],
    closedAt: closedAt5,
    maxImportance: 3,
    title: "朝のメールとメモ",
    shortSummary: "優先メールの要約と返信用ノート。",
    folderId: null,
    titleGenDone: true,
    collapsed: "chunk_card",
    expiresAtMs: now + ttlMsForImportance(3),
  };
  const chunkOpen: HubChunkRecord = {
    id: "chk_hubdemo_open",
    messageIds: [920029, 920030, 920031],
    closedAt: null,
    maxImportance: 3,
    title: "",
    shortSummary: "",
    folderId: null,
    titleGenDone: false,
    collapsed: "none",
  };

  const stmCalendar = makeStmEntry(
    chunkCalendar.id,
    chunkCalendar.title,
    chunkCalendar.shortSummary,
    4,
    false,
  );
  const stmRoute = makeStmEntry(chunkRoute.id, chunkRoute.title, chunkRoute.shortSummary, 3, false);
  const stmLaptop = makeStmEntry(chunkLaptop.id, chunkLaptop.title, chunkLaptop.shortSummary, 5, false);
  const stmDinner = makeStmEntry(chunkDinner.id, chunkDinner.title, chunkDinner.shortSummary, 3, false);
  const stmInbox = makeStmEntry(chunkInbox.id, chunkInbox.title, chunkInbox.shortSummary, 3, false);
  const stmOpenDraft = makeStmEntry(chunkOpen.id, "React 復習（進行中）", "クイズとタスク案内の open chunk。", 3, true);

  const hub: HubPersistedState = {
    schemaVersion: 1,
    chunks: [chunkTrivial, chunkCalendar, chunkRoute, chunkLaptop, chunkDinner, chunkInbox, chunkOpen],
    stmEntries: [stmCalendar, stmRoute, stmLaptop, stmDinner, stmInbox, stmOpenDraft],
    provisionalStm: {
      chunkId: chunkOpen.id,
      summary: "クイズの続きや hooks に絞った出題をここに蓄積（デモ）。",
      lastCompressedMessageCount: 3,
      updatedAt: iso(100_000),
    },
    recall: null,
    openChunkId: chunkOpen.id,
  };

  return { messages, hub };
}
