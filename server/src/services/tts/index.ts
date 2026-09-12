/**
 * TTS 门面
 *
 * 对上层只暴露 synthesize(text, kind)：
 *   1. 先查磁盘缓存（命中直接返回，零延迟零网络）
 *   2. 未命中则调具体 Provider（当前只有 Edge）
 *   3. 写回缓存
 *
 * kind 会影响语速：单字最慢（孩子要听清声调），句子按配置语速。
 */
import { loadConfig } from "../../config.js";
import { logTts } from "../../logger.js";
import { buildCacheKey, cacheStats, clearCache, enforceMaxSize, readCache, writeCache } from "./cache.js";
import { TtsError, synthesizeEdge } from "./edge.js";

export { TtsError } from "./edge.js";
export { cacheStats, clearCache, enforceMaxSize, buildCacheKey, keyToPath } from "./cache.js";

export type TtsKind = "word" | "char" | "sentence";

export interface TtsResult {
  buf: Buffer;
  cached: boolean;
  ms: number;
  key: string;
  text: string;
  rate: string;
}

/** 在基准语速上叠加偏移，例如 "-12%" 再慢 10% 得到 "-22%" */
export function adjustRate(base: string, deltaPct: number): string {
  const m = /^\s*([+-]?)\s*(\d+(?:\.\d+)?)\s*%\s*$/.exec(base || "");
  if (!m) return base || "-10%";
  const sign = m[1] === "-" ? -1 : 1;
  const v = sign * Number(m[2]) + deltaPct;
  const s = v > 0 ? "+" : v < 0 ? "-" : "+";
  return `${s}${Math.abs(Math.round(v * 10) / 10)}%`;
}

function rateForKind(kind: TtsKind, baseRate: string): string {
  if (kind === "char") return adjustRate(baseRate, -10); // 单字再慢一点，听清声调
  if (kind === "word") return adjustRate(baseRate, -3);
  return baseRate; // sentence 用配置值
}

/**
 * 这段文本有没有可朗读的内容？
 *
 * 纯标点 / 纯符号（`……`、`——`、单独的 `”`、`，。`）送进 Edge 只会拿回空音频，
 * 报出来的错还是「语音服务返回了空音频」—— 把**请求方的输入问题**伪装成**服务方故障**，
 * 排查时会一路往 Edge 侧找。所以这里提前拦掉，给出准确的错因。
 */
const SPEAKABLE_RE = /[\p{L}\p{N}]/u;

export function isSpeakableText(text: string): boolean {
  return SPEAKABLE_RE.test(String(text ?? ""));
}

/**
 * 合成一段文本的语音。命中缓存时不产生任何网络请求。
 */
export async function synthesize(text: string, kind: TtsKind = "word"): Promise<TtsResult> {
  const cfg = loadConfig();
  const t0 = Date.now();
  const raw = String(text || "").trim();
  if (!raw) throw new TtsError("noinput", "文本为空，无法合成");
  if (!isSpeakableText(raw)) {
    throw new TtsError("noinput", `文本里没有可朗读的内容（纯标点/符号：${raw.slice(0, 12)}），已跳过合成`);
  }

  const clipped = raw.length > cfg.tts.maxTextLen ? raw.slice(0, cfg.tts.maxTextLen) : raw;
  if (clipped !== raw) {
    logTts.warn({ len: raw.length, max: cfg.tts.maxTextLen }, "文本超长已截断");
  }

  const rate = rateForKind(kind, cfg.tts.rate);
  const key = buildCacheKey({
    provider: cfg.tts.provider,
    voice: cfg.tts.voice,
    rate,
    volume: cfg.tts.volume,
    pitch: cfg.tts.pitch,
    text: clipped,
  });

  const hit = await readCache(key);
  if (hit) {
    logTts.debug({ text: clipped, kind, key: key.slice(0, 8), bytes: hit.length, ms: Date.now() - t0 }, "语音命中缓存");
    return { buf: hit, cached: true, ms: Date.now() - t0, key, text: clipped, rate };
  }

  let buf: Buffer;
  try {
    if (cfg.tts.provider === "edge") {
      buf = await synthesizeEdge(clipped, {
        voice: cfg.tts.voice,
        rate,
        volume: cfg.tts.volume,
        pitch: cfg.tts.pitch,
      });
    } else {
      throw new TtsError("provider", `不支持的 TTS provider：${cfg.tts.provider}`);
    }
  } catch (e) {
    const kindName = e instanceof TtsError ? e.kind : "provider";
    logTts.error(
      { text: clipped, kind, voice: cfg.tts.voice, rate, errKind: kindName, err: e, ms: Date.now() - t0 },
      "语音合成失败",
    );
    throw e;
  }

  await writeCache(key, buf);
  logTts.info(
    { text: clipped, kind, voice: cfg.tts.voice, rate, bytes: buf.length, cache: "MISS", ms: Date.now() - t0 },
    "语音合成成功",
  );

  // 顺带做一次容量控制（低频操作，失败不影响主流程）
  enforceMaxSize(cfg.tts.cacheMaxMB).catch(() => undefined);

  return { buf, cached: false, ms: Date.now() - t0, key, text: clipped, rate };
}

/** 单字听写时的朗读：先读词（语境消歧），再读字 */
export function dictationTexts(ch: string, word: string): { text: string; kind: TtsKind }[] {
  const w = (word || "").trim();
  const out: { text: string; kind: TtsKind }[] = [];
  if (w && w.length > 1 && w !== ch) out.push({ text: w, kind: "word" });
  out.push({ text: ch, kind: "char" });
  return out;
}

export interface PrewarmResult {
  total: number;
  ok: number;
  cached: number;
  failed: { text: string; reason: string }[];
  ms: number;
}

/**
 * 预热一课的生字音频。
 * 保存课文后异步跑一遍，下次孩子听写全部命中缓存。
 * 并发压到 3：Edge 是非官方接口，压太狠容易被限。
 */
export async function prewarmChars(
  chars: { ch: string; word: string }[],
  concurrency = 3,
): Promise<PrewarmResult> {
  const t0 = Date.now();
  const jobs: { text: string; kind: TtsKind }[] = [];
  for (const c of chars) {
    for (const j of dictationTexts(c.ch, c.word)) jobs.push(j);
  }

  let ok = 0;
  let cached = 0;
  const failed: { text: string; reason: string }[] = [];

  let cursor = 0;
  const worker = async () => {
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      try {
        const r = await synthesize(job.text, job.kind);
        ok++;
        if (r.cached) cached++;
      } catch (e) {
        failed.push({ text: job.text, reason: e instanceof Error ? e.message : String(e) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, jobs.length)) }, worker));

  const res: PrewarmResult = { total: jobs.length, ok, cached, failed, ms: Date.now() - t0 };
  logTts.info(
    { total: res.total, ok, cached, failed: failed.length, ms: res.ms },
    "音频预热完成",
  );
  return res;
}

/** 当前 TTS 配置摘要（脱敏，供 health 与后台展示） */
export function ttsInfo(): Record<string, unknown> {
  const cfg = loadConfig();
  return {
    provider: cfg.tts.provider,
    voice: cfg.tts.voice,
    rate: cfg.tts.rate,
    volume: cfg.tts.volume,
    pitch: cfg.tts.pitch,
    cacheDir: cfg.tts.cacheDir,
    cacheMaxMB: cfg.tts.cacheMaxMB,
  };
}

export async function ttsStats(): Promise<{ count: number; bytes: number; dir: string; maxMB: number }> {
  const cfg = loadConfig();
  const s = await cacheStats();
  return { ...s, maxMB: cfg.tts.cacheMaxMB };
}
