import receiveStartUrl from "../../assets/sounds/chat-receive-start.mp3?url";
import sendUrl from "../../assets/sounds/chat-send.mp3?url";

const STORAGE_SEND = "pc-chat-send-sound";
const STORAGE_RECEIVE = "pc-chat-receive-sound";

const SEND_GAIN = 1.6;
const RECEIVE_GAIN = 1.4;

type SoundSlot = {
  url: string;
  gain: number;
  ctx: AudioContext | null;
  gainNode: GainNode | null;
  buffer: AudioBuffer | null;
  loadPromise: Promise<void> | null;
};

function createSlot(url: string, gain: number): SoundSlot {
  return { url, gain, ctx: null, gainNode: null, buffer: null, loadPromise: null };
}

const sendSlot = createSlot(sendUrl, SEND_GAIN);
const receiveSlot = createSlot(receiveStartUrl, RECEIVE_GAIN);

export function isChatSendSoundEnabled(): boolean {
  return (localStorage.getItem(STORAGE_SEND) ?? "true") === "true";
}

export function isChatReceiveStartSoundEnabled(): boolean {
  return (localStorage.getItem(STORAGE_RECEIVE) ?? "true") === "true";
}

function getSlotContext(slot: SoundSlot): AudioContext {
  if (!slot.ctx || slot.ctx.state === "closed") {
    slot.ctx = new AudioContext();
    slot.gainNode = slot.ctx.createGain();
    slot.gainNode.gain.value = slot.gain;
    slot.gainNode.connect(slot.ctx.destination);
  }
  return slot.ctx;
}

function preloadSlot(slot: SoundSlot): void {
  if (slot.buffer || slot.loadPromise) return;
  slot.loadPromise = (async () => {
    const ctx = getSlotContext(slot);
    const res = await fetch(slot.url);
    const data = await res.arrayBuffer();
    slot.buffer = await ctx.decodeAudioData(data);
  })().catch(() => {
    slot.loadPromise = null;
  });
}

async function playViaBuffer(slot: SoundSlot, ctx: AudioContext): Promise<boolean> {
  if (!slot.buffer) {
    if (slot.loadPromise) await slot.loadPromise;
  }
  if (!slot.buffer || !slot.gainNode) return false;
  const src = ctx.createBufferSource();
  src.buffer = slot.buffer;
  src.connect(slot.gainNode);
  src.start(0);
  return true;
}

async function playViaHtmlAudio(slot: SoundSlot): Promise<void> {
  const audio = new Audio(slot.url);
  audio.preload = "auto";
  audio.volume = 1;
  audio.currentTime = 0;
  await audio.play();
}

function playSlot(slot: SoundSlot): void {
  void (async () => {
    try {
      const ctx = getSlotContext(slot);
      if (ctx.state === "suspended") await ctx.resume();
      preloadSlot(slot);
      if (await playViaBuffer(slot, ctx)) return;
      await playViaHtmlAudio(slot);
    } catch {
      try {
        await playViaHtmlAudio(slot);
      } catch {
        /* autoplay / デバイス未接続など */
      }
    }
  })();
}

/** 起動時に decode しておく（初回送信・受信の遅延を避ける） */
export function preloadChatMessageSounds(): void {
  preloadSlot(sendSlot);
  preloadSlot(receiveSlot);
}

/** チャット送信時 */
export function playChatSendSoundIfEnabled(): void {
  if (!isChatSendSoundEnabled()) return;
  playSlot(sendSlot);
}

/** LLM ストリームの最初のチャンク到着時 */
export function playChatReceiveStartSoundIfEnabled(): void {
  if (!isChatReceiveStartSoundEnabled()) return;
  playSlot(receiveSlot);
}
