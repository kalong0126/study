/**
 * 音频层：后端的 Edge TTS（mp3）为主，浏览器 Web Speech 为兜底。
 *
 * 平板上的三个坑，这里一次性解决：
 *   1. iOS/Android 禁止无用户手势的播放 → 首次点击时播一段静音 WAV 完成解锁；
 *   2. 连续朗读必须用 <audio> 的 ended 事件串行推进，不能用 setInterval（会重叠、会跑偏）；
 *   3. 进课文页时把该课生字音频批量拉成 Blob，点击即播，避免网络抖动。
 *
 * 另外：Edge TTS 是非官方接口，服务器出不了外网或被限流时会失败。
 * 这时自动降级到浏览器自带的 speechSynthesis，孩子依然能听到读音（音色差一些）。
 */
import { ref } from "vue";
import { api } from "@/api";
import { isSpeakable, splitSentences } from "@/utils/sentences";

// 断句逻辑统一放在 utils/sentences（StoryReader 也用它，避免两处正则各写一份再次跑偏）
export { isSpeakable, splitSentences };

export type TtsKind = "word" | "char" | "sentence";
export interface PlayItem {
  text: string;
  kind: TtsKind;
}

/* --------------------------------------------------------------- 单例音频元素 */
let el: AudioElement | null = null;
type AudioElement = HTMLAudioElement;

const blobCache = new Map<string, string>(); // "kind:text" -> objectURL
const CACHE_MAX = 400;

/**
 * 降级到浏览器语音（speechSynthesis）的状态。
 *
 * 这里必须带**冷却时间**，不能一次失败就永久降级 —— 之前是 `degradedToSpeech = true`
 * 一置到底，任何一次抖动（比如某段文本合成失败、服务刚好重启）都会让孩子这一整场
 * 都听到系统音色，只有刷新页面才能恢复。现在的规则：
 *   · 连续失败达到 FAIL_THRESHOLD 次才判定「后端 TTS 真的不可用」
 *   · 降级只维持 COOLDOWN_MS，到点后自动再试一次后端
 */
const FAIL_THRESHOLD = 2;
const COOLDOWN_MS = 60_000;

const degradedToSpeech = ref(false);
const playing = ref(false);
const currentText = ref("");

let consecutiveFailures = 0;
let degradedUntil = 0;

function syncDegradedFlag(): void {
  const on = Date.now() < degradedUntil;
  if (degradedToSpeech.value !== on) degradedToSpeech.value = on;
}

function noteTtsOk(): void {
  consecutiveFailures = 0;
  degradedUntil = 0;
  syncDegradedFlag();
}

function noteTtsFail(): void {
  consecutiveFailures += 1;
  if (consecutiveFailures >= FAIL_THRESHOLD) degradedUntil = Date.now() + COOLDOWN_MS;
  syncDegradedFlag();
}

function audio(): AudioElement {
  if (el) return el;
  const a = new Audio();
  a.preload = "auto";
  (a as HTMLAudioElement & { playsInline?: boolean }).playsInline = true;
  el = a;
  return a;
}

/** 生成一段 0.03s 的静音 WAV（8kHz 单声道 8bit），只用于解锁自动播放 */
function silentWavUrl(): string {
  const sampleRate = 8000;
  const samples = 240;
  const buf = new ArrayBuffer(44 + samples);
  const view = new DataView(buf);
  const wstr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  wstr(0, "RIFF");
  view.setUint32(4, 36 + samples, true);
  wstr(8, "WAVE");
  wstr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  wstr(36, "data");
  view.setUint32(40, samples, true);
  for (let i = 0; i < samples; i++) view.setUint8(44 + i, 128);
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}

let unlocked = false;
/** 在第一次用户手势里调用 */
export function unlockAudioPlayback(): void {
  if (unlocked) return;
  unlocked = true;
  try {
    const a = audio();
    a.muted = true;
    a.src = silentWavUrl();
    void a
      .play()
      .catch(() => undefined)
      .finally(() => {
        a.pause();
        a.muted = false;
        a.removeAttribute("src");
      });
    // Web Audio 也要顺手解锁，音效才响
    void import("@/composables/useSound").then((m) => m.unlockAudio());
  } catch {
    /* 忽略 */
  }
}

/* ------------------------------------------------------------------ Blob 缓存 */

function keyOf(text: string, kind: TtsKind): string {
  return `${kind}:${text}`;
}

function putCache(key: string, url: string): void {
  if (blobCache.size >= CACHE_MAX) {
    const first = blobCache.keys().next().value;
    if (first !== undefined) {
      const old = blobCache.get(first);
      blobCache.delete(first);
      if (old) URL.revokeObjectURL(old);
    }
  }
  blobCache.set(key, url);
}

/** 拉取一段音频并缓存为 Blob URL；失败返回 null */
export async function preload(text: string, kind: TtsKind): Promise<string | null> {
  const t = (text || "").trim();
  if (!t) return null;
  // 纯标点/符号没有可读内容：后端合成只会拿到空音频并报 503，这里直接不发请求
  if (!isSpeakable(t)) return null;
  const key = keyOf(t, kind);
  const hit = blobCache.get(key);
  if (hit) return hit;
  try {
    const res = await fetch(api.ttsUrl(t, kind));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    if (!blob.size) throw new Error("空音频");
    const url = URL.createObjectURL(blob);
    putCache(key, url);
    return url;
  } catch {
    return null;
  }
}

/** 批量预加载（并发压到 3，避免同时打满后端） */
export async function preloadMany(items: PlayItem[], concurrency = 3): Promise<void> {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const it = items[cursor++];
      await preload(it.text, it.kind);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
}

export function clearAudioCache(): void {
  for (const url of blobCache.values()) URL.revokeObjectURL(url);
  blobCache.clear();
}

/* ------------------------------------------------------------- 中止（停止播放） */

/**
 * 「停止朗读」必须能**立刻**掐断整条队列，而不是只把当前这一句暂停。
 *
 * 曾经的 bug：stopAudio() 只是 pause() 当前 <audio>，但 playSequence 里那句
 * `await playOne(...)` 还在挂着 —— 它要等到自己的超时定时器（长句可达数十秒）
 * 才会 resolve。醒来后循环令牌没变，于是若无其事地继续读下一句：
 * 用户看到的现象就是「点了停止，停了一下又接着往后读」。
 *
 * 现在用两个东西解决：
 *   · stopEpoch  —— 每次 stop 自增，所有排队中的流程都拿它当「我是否已作废」的依据；
 *   · abortWaiters —— 正在等待（播放/兜底朗读）的 Promise 注册一个「立刻结束」回调，
 *                     stop 时统一触发，await 当帧就返回，不必等超时。
 */
let stopEpoch = 0;
const abortWaiters = new Set<() => void>();

/** 注册一个「被停止时立刻执行」的回调，返回注销函数 */
function onAbort(fn: () => void): () => void {
  abortWaiters.add(fn);
  return () => abortWaiters.delete(fn);
}

/** 停止时统一唤醒所有等待者 */
function fireAbort(): void {
  const list = Array.from(abortWaiters);
  abortWaiters.clear();
  for (const fn of list) {
    try {
      fn();
    } catch {
      /* 忽略 */
    }
  }
}

/* ------------------------------------------------------------------ 播放控制 */

function stopSpeech(): void {
  try {
    window.speechSynthesis?.cancel();
  } catch {
    /* 忽略 */
  }
}

export function stopAudio(): void {
  // 先作废整个播放序列的「世代」，再叫醒所有挂着的等待
  stopEpoch += 1;
  fireAbort();

  const a = audio();
  a.onended = null;
  a.onerror = null;
  a.pause();
  try {
    a.currentTime = 0;
  } catch {
    /* 忽略 */
  }
  stopSpeech();
  playing.value = false;
  currentText.value = "";
}

function speakFallback(text: string, kind: TtsKind): Promise<void> {
  return new Promise((resolve) => {
    const synth = window.speechSynthesis;
    if (!synth) {
      resolve();
      return;
    }
    let offAbort: () => void = () => undefined;
    let timer = 0;
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      offAbort();
      window.clearTimeout(timer);
      resolve();
    };
    // 被「停止」时立刻结束，不等 onend / 超时
    offAbort = onAbort(() => {
      try {
        synth.cancel();
      } catch {
        /* 忽略 */
      }
      finish();
    });
    try {
      synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "zh-CN";
      u.rate = kind === "char" ? 0.62 : 0.72;
      u.pitch = 1.05;
      u.onend = finish;
      u.onerror = finish;
      // 兜底：万一 onend 不触发也别把队列卡死
      timer = window.setTimeout(finish, 1200 + text.length * 700);
      synth.speak(u);
    } catch {
      finish();
    }
  });
}

/** 播一段文本（优先 Blob 缓存 / 后端 TTS，失败降级到浏览器朗读） */
async function playOne(
  text: string,
  kind: TtsKind,
  timeoutMs: number,
  epoch: number,
): Promise<void> {
  const t = (text || "").trim();
  if (!t) return;
  // 纯标点片段直接跳过：没有可读内容，不算失败，也不该把后端判成不可用
  if (!isSpeakable(t)) return;
  // 队列在进入本句之前就已经被停止
  if (epoch !== stopEpoch) return;
  currentText.value = t;

  syncDegradedFlag(); // 冷却到期后这里会把标记复位，重新尝试后端音色

  let url: string | null = null;
  if (!degradedToSpeech.value) {
    url = await preload(t, kind);
    if (url) noteTtsOk();
    else noteTtsFail();
  }
  // 等待网络期间用户点了停止 → 不要再出声
  if (epoch !== stopEpoch) return;
  if (!url) {
    await speakFallback(t, kind);
    return;
  }

  const a = audio();
  await new Promise<void>((resolve) => {
    let done = false;
    let offAbort: () => void = () => undefined;
    let timer = 0;
    const finish = (): void => {
      if (done) return;
      done = true;
      offAbort();
      a.onended = null;
      a.onerror = null;
      window.clearTimeout(timer);
      resolve();
    };
    // 被「停止」时立刻结束本段等待（否则要干等 timeoutMs 才醒）
    offAbort = onAbort(() => {
      try {
        a.pause();
        a.currentTime = 0;
      } catch {
        /* 忽略 */
      }
      finish();
    });
    timer = window.setTimeout(finish, timeoutMs);
    a.onended = finish;
    a.onerror = finish;
    try {
      a.src = url as string;
      a.currentTime = 0;
      void a.play().catch(() => {
        // 播放被拦（少见，通常发生在没解锁时）→ 走兜底，并计入失败次数
        noteTtsFail();
        finish();
      });
    } catch {
      finish();
    }
  });
}

export interface PlayOptions {
  /** 每开始一段时回调（用于逐句高亮）；-1 表示播放结束 */
  onIndex?: (i: number) => void;
  /** 每段音频的大致超时，默认按文本长度估算 */
  timeoutPerItem?: number;
}

let seqToken = 0;

/**
 * 串行播放一串文本；新的一次调用会打断上一次，stopAudio() 会立即整条中止。
 */
export async function playSequence(items: PlayItem[], opts: PlayOptions = {}): Promise<void> {
  const token = ++seqToken;
  const epoch = stopEpoch; // 本次序列绑定的「世代」，被 stop 后立即作废
  playing.value = true;
  try {
    for (let i = 0; i < items.length; i++) {
      // 令牌变了（被新的 playSequence 顶掉）或世代变了（被 stop）→ 整条队列立刻结束
      if (token !== seqToken || epoch !== stopEpoch) return;
      opts.onIndex?.(i);
      const est = opts.timeoutPerItem ?? 2500 + items[i].text.length * 700;
      await playOne(items[i].text, items[i].kind, est, epoch);
    }
  } finally {
    if (token === seqToken) {
      playing.value = false;
      currentText.value = "";
      opts.onIndex?.(-1);
    }
  }
}

/** 播一段（不串行） */
export async function playText(text: string, kind: TtsKind = "word"): Promise<void> {
  await playSequence([{ text, kind }]);
}

/**
 * 播放多段「文本 + 是否换行分隔」的通用入口：
 * 用于把一组带标记的句子串起来播放。
 */
export function isPlaying(): boolean {
  return playing.value;
}

export function useAudioState(): {
  playing: typeof playing;
  currentText: typeof currentText;
  degraded: typeof degradedToSpeech;
} {
  return { playing, currentText, degraded: degradedToSpeech };
}

/* -------------------------------------------------- 听写用：先读词再读字 */

/**
 * 单字听写的朗读文本序列：先读组词（语境消歧），再读单字。
 * 与后端 dictationTexts() 的规则保持一致。
 */
export function dictationItems(ch: string, word: string): PlayItem[] {
  const w = (word || "").trim();
  const out: PlayItem[] = [];
  if (w && w.length > 1 && w !== ch) out.push({ text: w, kind: "word" });
  out.push({ text: ch, kind: "char" });
  return out;
}

/* ------------------------------------------------------------------ 断句 */
// splitSentences / isSpeakable 已移到 @/utils/sentences 并在本文件顶部 re-export，
// 目的是让 StoryReader 的高亮切分与这里的朗读队列用**同一份**逻辑。
// 老实现在这里另写了一份正则，收尾引号会被切出来单独成句（`“我不怕。”` → `“我不怕。` + `”`），
// 那个孤立的 `”` 送去合成必然拿到空音频 —— 两处各写一份正是这个 bug 的温床，别再拆开。
