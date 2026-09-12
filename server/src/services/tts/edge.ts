/**
 * Edge TTS 实现（微软 Edge 朗读接口，免费）
 *
 * 这是「TtsProvider」的一个具体实现。之所以先抽象再实现，是因为
 * 这类非官方接口随时可能变动或限流，留好切换口子（云厂商 / 本地模型）
 * 就能在出问题时改一行配置换掉。
 */
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";

export interface EdgeSynthOptions {
  voice: string;
  rate: string;
  volume: string;
  pitch: string;
  timeoutMs?: number;
}

export class TtsError extends Error {
  constructor(
    /**
     * noinput  —— 请求本身的文本没法读（空 / 纯标点），不该重试，也不是服务方的锅
     * empty    —— 服务方返回了空音频
     * timeout  —— 超时
     * network  —— 连不上
     * provider —— 服务方报错或返回了非音频数据
     */
    public readonly kind: "noinput" | "empty" | "timeout" | "network" | "provider",
    message: string,
  ) {
    super(message);
    this.name = "TtsError";
  }
}

export async function synthesizeEdge(text: string, opts: EdgeSynthOptions): Promise<Buffer> {
  const timeoutMs = opts.timeoutMs ?? 20000;
  const tts = new MsEdgeTTS();

  const stream = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        tts.close();
      } catch {
        /* ignore */
      }
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new TtsError("timeout", `语音合成超时（${Math.round(timeoutMs / 1000)} 秒）`))),
      timeoutMs,
    );

    tts
      .setMetadata(opts.voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3)
      .then(() => {
        const { audioStream } = tts.toStream(text, {
          rate: opts.rate,
          volume: opts.volume,
          pitch: opts.pitch,
        });
        audioStream.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
        audioStream.on("end", () => finish(() => resolve(Buffer.concat(chunks))));
        audioStream.on("error", (e: Error) =>
          finish(() => reject(new TtsError("provider", `语音流错误：${e.message}`))),
        );
      })
      .catch((e: Error) => {
        const msg = e?.message ?? String(e);
        const kind = /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket|network/i.test(msg) ? "network" : "provider";
        finish(() => reject(new TtsError(kind, `连接语音服务失败：${msg}`)));
      });
  });

  if (!stream.length) {
    throw new TtsError("empty", "语音服务返回了空音频");
  }
  // MP3 帧同步字 0xFF 0xEx/0xFx，或 ID3 标签；都不是则说明拿到的不是音频
  const head = stream.subarray(0, 3);
  const isMp3 = (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) || stream.subarray(0, 3).toString("ascii") === "ID3";
  if (!isMp3) {
    throw new TtsError("provider", `语音服务返回的不是音频数据（前 16 字节：${stream.subarray(0, 16).toString("hex")}）`);
  }
  return stream;
}

/** 拉取可用音色（家长后台选音色时用） */
export async function listEdgeVoices(localePrefix = "zh-"): Promise<{ name: string; gender: string; locale: string }[]> {
  const tts = new MsEdgeTTS();
  try {
    const voices = await tts.getVoices();
    return voices
      .filter((v) => v.Locale.toLowerCase().startsWith(localePrefix))
      .map((v) => ({ name: v.ShortName, gender: v.Gender, locale: v.Locale }));
  } finally {
    try {
      tts.close();
    } catch {
      /* ignore */
    }
  }
}
