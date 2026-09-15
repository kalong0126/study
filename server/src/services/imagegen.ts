/**
 * 文生图（阿里云百炼 · 千问-文生图 qwen-image 系列）
 *
 * 为什么是「同步接口 + 本地落盘」这两个选择：
 *
 *   1. 用同步接口（/services/aigc/multimodal-generation/generation）而不是万相那套
 *      异步任务（创建任务 → 轮询结果）：一次请求直接拿到图片地址，代码和超时都好控制。
 *      实测 qwen-image-plus 出图约 6~15 秒，孩子的耐心扛得住。
 *
 *   2. 拿到的是**只有 24 小时有效期的 OSS 签名地址**，绝不能把它直接下发给前端 ——
 *      孩子第二天再打开看图题，图就变成裂图了。所以拿到地址后立刻下载到
 *      server/data/images/ 存起来，前端只访问我们自己的 /api/language/image/:date。
 *
 * Key 用的是「判卷（mark）」那把阿里云百炼 Key —— 同一个平台上，判卷能用的 Key
 * 画图也能用，家长不需要再申请一份。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, resolveImagegen, type AppConfig, type ResolvedImagegen } from "../config.js";
import { logLlm } from "../logger.js";
import { LlmError } from "./llm.js";

/**
 * 统一画风前缀。两件事必须由我们钉死，不能交给模型自由发挥：
 *   · 画风统一（每次出题都是同一套视觉风格，孩子有熟悉感）
 *   · **画面里不能出现任何文字** —— 提示词文档本身也要求「不出现任何文字」，
 *     否则模型很容易把场景描述里的字画进图里，孩子看图就变成了读字
 */
const STYLE_PROMPT =
  "儿童绘本插画风格，明亮温暖的配色，简洁可爱的卡通造型，线条清楚，构图干净，" +
  "适合小学二年级学生看图观察。画面温馨安全。";

const NO_TEXT_RULE = "画面中绝对不能出现任何文字、汉字、字母、数字、水印或标识。";

const NEGATIVE_PROMPT =
  "文字,汉字,字母,数字,水印,签名,logo,低分辨率,低画质,肢体畸形,手指畸形,多余的手," +
  "多余的人,画面过饱和,蜡像感,人脸无细节,过度光滑,构图混乱,血腥,恐怖,暴力,武器";

/** 场景描述超过这个长度就截断（接口本身也有 token 上限） */
const MAX_SCENE_CHARS = 260;

/** 把模型的场景描述包成完整的文生图提示词 */
export function buildKidPrompt(scene: string): string {
  const s = String(scene ?? "").trim().slice(0, MAX_SCENE_CHARS);
  return `${STYLE_PROMPT}${NO_TEXT_RULE}\n画面内容：${s}`;
}

/** 文件名按「日期 + 场景哈希」确定性生成：同一场景重复请求会算成同一个文件，天然去重 */
export function imageFileName(date: string, scene: string): string {
  const h = crypto.createHash("sha1").update(String(scene ?? "")).digest("hex").slice(0, 10);
  return `language-${date}-${h}.png`;
}

export interface ImagegenResult {
  /** 落盘后的文件名（不含目录） */
  file: string;
  model: string;
  ms: number;
  /** 实际发给模型的提示词（留痕，便于家长/开发排查画得不对的原因） */
  prompt: string;
  bytes: number;
}

/** 从厂商响应里抠出图片地址（不同系列字段位置略有差异，都兜住） */
function extractImageUrl(data: unknown): string {
  const out = (data as { output?: unknown })?.output as Record<string, unknown> | undefined;
  if (!out) return "";

  // qwen-image 同步接口：output.choices[0].message.content[0].image
  const choices = out.choices;
  if (Array.isArray(choices) && choices.length) {
    const content = (choices[0] as { message?: { content?: unknown } })?.message?.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        const img = (part as { image?: unknown })?.image;
        if (typeof img === "string" && img) return img;
      }
    }
  }

  // 万相异步接口的形态：output.results[0].url
  const results = out.results;
  if (Array.isArray(results) && results.length) {
    for (const r of results) {
      const url = (r as { url?: unknown })?.url;
      if (typeof url === "string" && url) return url;
    }
  }

  return "";
}

/** 从错误响应体里抠出厂商原话 */
function extractErrorText(raw: string): string {
  try {
    const j = JSON.parse(raw) as { error?: { message?: string }; message?: string; code?: string };
    return j?.error?.message ?? j?.message ?? j?.code ?? raw.slice(0, 200);
  } catch {
    return raw.slice(0, 200);
  }
}

/**
 * 生成一张图并落到磁盘。
 *
 * 同一「日期 + 场景」的并发请求会共用同一个 Promise —— 否则孩子手快连点两下，
 * 就会白花两次钱。
 */
const inflight = new Map<string, Promise<ImagegenResult>>();

export async function generateImage(
  date: string,
  scene: string,
  cfgIn?: AppConfig,
): Promise<ImagegenResult> {
  const cfg = cfgIn ?? loadConfig();
  const ig = resolveImagegen(cfg);
  const file = imageFileName(date, scene);

  if (!ig.enabled) {
    throw new LlmError("config", "文生图功能已关闭（config.yaml 里 imagegen.enabled = false）", {
      purpose: "imagegen",
    });
  }
  if (!ig.configured) {
    throw new LlmError(
      "config",
      "没有可用的文生图 API Key：它默认复用「判卷」那把阿里云百炼 Key，" +
        "请先在后台「系统与数据」里填写判卷模型的 API Key，或单独配置 IMAGEGEN_API_KEY",
      { purpose: "imagegen" },
    );
  }

  const key = `${date}::${file}`;
  const running = inflight.get(key);
  if (running) return running;

  const task = runGenerate(cfg, ig, date, scene, file).finally(() => inflight.delete(key));
  inflight.set(key, task);
  return task;
}

async function runGenerate(
  cfg: AppConfig,
  ig: ResolvedImagegen,
  date: string,
  scene: string,
  file: string,
): Promise<ImagegenResult> {
  const prompt = buildKidPrompt(scene);
  const dest = path.join(ig.dir, file);
  const t0 = Date.now();

  fs.mkdirSync(ig.dir, { recursive: true });

  /* ---------------- 1. 调接口拿临时地址 ---------------- */
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ig.timeoutMs);
  let tempUrl = "";
  let status = 0;

  try {
    const res = await fetch(ig.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ig.apiKey}` },
      body: JSON.stringify({
        model: ig.model,
        input: { messages: [{ role: "user", content: [{ text: prompt }] }] },
        parameters: {
          size: ig.size,
          negative_prompt: NEGATIVE_PROMPT,
          // 关掉提示词智能改写：观察问题是照着原场景描述出的，
          // 一旦让模型自行「润色」画面，图和孩子要回答的问题就可能对不上。
          prompt_extend: false,
          watermark: false,
          n: 1,
        },
      }),
      signal: ac.signal,
    });
    status = res.status;
    const raw = await res.text();

    if (!res.ok) {
      const apiMsg = extractErrorText(raw);
      const retryable = status === 429 || status >= 500;
      throw new LlmError("http", `文生图接口返回 HTTP ${status}：${apiMsg}`, { status, apiMsg }, retryable);
    }

    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new LlmError("parse", "文生图接口返回的不是 JSON（Base URL 可能写错了）", {
        bodyHead: raw.slice(0, 200),
      });
    }

    tempUrl = extractImageUrl(data);
    if (!tempUrl) {
      throw new LlmError("empty", "文生图接口没有返回图片地址", { bodyHead: raw.slice(0, 300) });
    }
  } catch (e) {
    const ms = Date.now() - t0;
    if (e instanceof LlmError) {
      logLlm.error({ tag: "imagegen", model: ig.model, kind: e.kind, ms, err: e }, "文生图失败");
      throw e;
    }
    const name = (e as { name?: string })?.name;
    if (name === "AbortError" || name === "TimeoutError") {
      throw new LlmError("timeout", `文生图超时（${Math.round(ig.timeoutMs / 1000)} 秒未响应）`, {
        timeoutMs: ig.timeoutMs,
        ms,
      }, true);
    }
    const cause = (e as { cause?: { code?: string } })?.cause;
    throw new LlmError("network", `文生图网络不通（${cause?.code ?? String(e)}）`, { url: ig.url, ms }, true);
  } finally {
    clearTimeout(timer);
  }

  /* ---------------- 2. 把图下载到本地 ---------------- */
  // 厂商给的是 24 小时有效的签名地址，必须当场取回，不能直接存地址。
  let bytes = 0;
  try {
    const ac2 = new AbortController();
    const t2 = setTimeout(() => ac2.abort(), 60000);
    try {
      const res = await fetch(tempUrl, { signal: ac2.signal });
      if (!res.ok) {
        throw new LlmError("http", `下载生成的图片失败：HTTP ${res.status}`, { status: res.status });
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) throw new LlmError("empty", "下载到的图片是空的");
      await fs.promises.writeFile(dest, buf);
      bytes = buf.length;
    } finally {
      clearTimeout(t2);
    }
  } catch (e) {
    const ms = Date.now() - t0;
    const err =
      e instanceof LlmError
        ? e
        : new LlmError("network", `下载生成的图片失败：${(e as Error).message}`, { ms }, true);
    logLlm.error({ tag: "imagegen", model: ig.model, ms, err }, "文生图下载失败");
    throw err;
  }

  const ms = Date.now() - t0;
  // 落盘后清掉同一天更早的旧图（换过主题时留下的孤儿文件），避免磁盘越攒越多
  await cleanupDateImages(ig.dir, date, file).catch(() => undefined);
  // 顺便淘汰很久以前的图（家长重置今日会清 KV，但磁盘文件不会立刻删，靠这条兜底）
  await cleanupOldImages(ig.dir, IMAGE_KEEP_DAYS).catch(() => undefined);

  logLlm.info(
    { tag: "imagegen", model: ig.model, ms, file, bytes, date },
    "文生图完成并已落盘",
  );

  return { file, model: ig.model, ms, prompt, bytes };
}

/** 删掉同一天除 keepFile 之外的图片（换主题后旧图不再被引用） */
export async function cleanupDateImages(dir: string, date: string, keepFile: string): Promise<number> {
  let removed = 0;
  let files: string[];
  try {
    files = await fs.promises.readdir(dir);
  } catch {
    return 0;
  }
  for (const f of files) {
    if (f === keepFile) continue;
    if (!f.startsWith(`language-${date}-`)) continue;
    try {
      await fs.promises.unlink(path.join(dir, f));
      removed++;
    } catch {
      /* 删不掉就算了，不影响功能 */
    }
  }
  return removed;
}

/** 图片文件是否已存在（存在就直接复用，不用再花钱重新画） */
export function imageExists(dir: string, file: string): boolean {
  try {
    return Boolean(file) && fs.statSync(path.join(dir, file)).size > 0;
  } catch {
    return false;
  }
}

/** 配图保留天数：超过就从磁盘删掉（每天最多一两张，30 天足够回溯） */
const IMAGE_KEEP_DAYS = 30;

/**
 * 删掉超过保留期的配图。
 *
 * 为什么需要：家长后台「重置今日」只清 KV（repo 层不该碰文件系统），
 * 换主题重画也会让上一张变成孤儿 —— 这些文件没人引用，但会一直占磁盘。
 * 文件名里带着日期，所以不用额外记账，扫一遍目录就能判断。
 */
export async function cleanupOldImages(dir: string, keepDays = IMAGE_KEEP_DAYS): Promise<number> {
  const cutoff = new Date(Date.now() - keepDays * 86400000).toISOString().slice(0, 10);
  let files: string[];
  try {
    files = await fs.promises.readdir(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const f of files) {
    const m = /^language-(\d{4}-\d{2}-\d{2})-/.exec(f);
    if (!m) continue;
    if (m[1] >= cutoff) continue; // 字符串比较即可，ISO 日期天然可比
    try {
      await fs.promises.unlink(path.join(dir, f));
      removed++;
    } catch {
      /* 删不掉就算了 */
    }
  }
  if (removed) logLlm.info({ tag: "imagegen", dir, removed, keepDays }, "已清理过期配图");
  return removed;
}

/** 缓存目录里现在有几张图（诊断页展示用） */
export async function imageCount(dir: string): Promise<number> {
  try {
    const files = await fs.promises.readdir(dir);
    return files.filter((f) => f.endsWith(".png")).length;
  } catch {
    return 0;
  }
}

/** 启动日志 / 诊断页用的摘要 */
export function imagegenInfo(): Record<string, unknown> {
  const r = resolveImagegen(loadConfig());
  return {
    enabled: r.enabled,
    model: r.model,
    url: r.url,
    size: r.size,
    dir: r.dir,
    keyFrom: r.keyFrom,
    configured: r.configured,
  };
}
