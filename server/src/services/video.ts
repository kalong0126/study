/**
 * 英文故事视频：目录扫描 / 抽片 / 路径解析
 *
 * 视频放在**内网的共享目录**里（Windows 上是 UNC，NAS 上是 cifs 挂载点），
 * 由后端读出字节、按 HTTP Range 转发给浏览器。浏览器自己既读不了 `file://`，
 * 也打不开 `\\host\share\...` 这种 SMB 路径，所以这一步绕不开。
 *
 * 三个要注意的点：
 *   1. **只读**：那个目录是别人的共享，我们绝不创建 / 修改任何东西
 *      （所以 video.dir 不能进 `ensureDirs`）。目录不存在只是「读不了」，不是错误配置。
 *   2. **缓存**：SMB 上 readdir + 逐文件 stat 不便宜，清单缓存 60 秒。
 *      孩子点「换一个」不会把共享扫穿。
 *   3. **只放浏览器播得动的容器**：mkv / avi / rmvb 一律跳过（Chrome 播不了），
 *      否则孩子看到的是永远转圈的黑窗口，而不是一句能懂的提示。
 */
import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "../config.js";

export interface VideoItem {
  /** base64url(rel)，用作 URL 里的标识；不直接把文件名塞进 URL（中文 / 空格 / 特殊符号太容易出岔子） */
  id: string;
  /** 相对 video.dir 的路径，用 `/` 分隔（含子目录） */
  rel: string;
  /** 文件名（含扩展名），给家长排查用 */
  name: string;
  /** 展示用标题（把 `[1080p]`、下划线、多余空格收拾干净） */
  title: string;
  ext: string;
  size: number;
  mtimeMs: number;
}

export interface VideoScan {
  dir: string;
  files: VideoItem[];
  /** 目录读不了的原因（共享断了 / 路径写错 / 没权限）；正常时为空串 */
  problem: string;
  scannedAt: number;
}

/** 清单缓存时长（毫秒） */
const CACHE_MS = 60_000;
/** 一次最多列多少个文件，防止误把整个盘挂进来时把内存和共享拖死 */
const MAX_FILES = 5000;

let cache: { dir: string; at: number; scan: VideoScan } | null = null;

const MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  // 纯音频容器：默认 exts 里没有它，但如果家长把 wav / mp3 也配进来，得给对的类型，
  // 否则浏览器拿到 application/octet-stream 就得靠猜（回归测试也用 wav 当可解码样本）。
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
};

export function mimeOf(ext: string): string {
  return MIME[ext.toLowerCase()] ?? "application/octet-stream";
}

export function encodeId(rel: string): string {
  return Buffer.from(rel, "utf8").toString("base64url");
}

export function decodeId(id: string): string | null {
  try {
    return Buffer.from(id, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

/** 文件名 → 孩子看着舒服的标题 */
export function cleanTitle(fileName: string): string {
  const base = fileName.replace(/\.[A-Za-z0-9]{2,5}$/, "");
  const s = base
    .replace(/[[(（【][^\]）)】]*[\]）)】]/g, " ") // 去掉 [1080p]、【HDR】、（国语）这类标注
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s || base;
}

/** 把 fs 的错误翻译成家长看得懂的一句话 */
export function explainFsError(dir: string, e: unknown): string {
  const err = e as NodeJS.ErrnoException;
  const code = err?.code ?? "";
  if (code === "ENOENT") {
    // Docker 部署最常见的坑：宿主机上挂得好好的，但没 bind mount 进容器，
    // 容器里就是个不存在的路径 —— 这句提示专门为了让家长少绕这一圈。
    return `目录不存在：${dir}（共享没挂上、路径写错、大小写对不上；Docker 部署还要确认这个路径已挂进容器）`;
  }
  if (code === "EACCES" || code === "EPERM") return `没有权限读：${dir}（运行后端的账号没被授权访问这个共享）`;
  if (["EBUSY", "ETIMEDOUT", "ENOTFOUND", "EHOSTDOWN", "EIO", "ECONNRESET", "ENETUNREACH"].includes(code)) {
    return `连不上共享：${dir}（那台机器没开机，或 SMB 会话断了）`;
  }
  return `读取失败：${dir}（${err?.message || String(e)}）`;
}

async function walk(
  root: string,
  rel: string,
  depth: number,
  maxDepth: number,
  exts: Set<string>,
  out: VideoItem[],
): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(path.join(root, rel), { withFileTypes: true });
  } catch (e) {
    // 顶层读不了 = 真问题，往上抛；子目录读不了就跳过，别让一次坏目录毁掉整次扫描
    if (!rel) throw e;
    return;
  }

  for (const ent of entries) {
    if (out.length >= MAX_FILES) return;
    // 隐藏文件 + macOS 在网络盘上撒的 `._xxx` 影子文件
    if (ent.name.startsWith(".")) continue;

    const childRel = rel ? `${rel}/${ent.name}` : ent.name;

    if (ent.isDirectory()) {
      if (depth < maxDepth) await walk(root, childRel, depth + 1, maxDepth, exts, out);
      continue;
    }
    if (!ent.isFile()) continue;

    const ext = path.extname(ent.name).toLowerCase();
    if (!exts.has(ext)) continue;

    let st: fs.Stats;
    try {
      st = await fs.promises.stat(path.join(root, childRel));
    } catch {
      continue; // 扫到一半文件被删 / 共享抖动 → 当它不存在
    }
    if (st.size <= 0) continue; // 0 字节的多半是没下完的占位文件

    out.push({
      id: encodeId(childRel),
      rel: childRel,
      name: ent.name,
      title: cleanTitle(ent.name),
      ext,
      size: st.size,
      mtimeMs: st.mtimeMs,
    });
  }
}

/**
 * 列出目录里所有能播的视频。结果缓存 60 秒；`force` 用于页面上的「重试」按钮
 * （共享刚挂上时不用等缓存过期）。
 *
 * 目录读不了**不抛异常**：返回带 `problem` 的空清单，让前端能说清原因，
 * 而不是给孩子一个 500。
 */
export async function scanVideos(cfg: AppConfig, opts: { force?: boolean } = {}): Promise<VideoScan> {
  const dir = cfg.video.dir;
  if (!dir) {
    return {
      dir: "",
      files: [],
      problem: "还没配置视频目录（家长请在 config.yaml 或 .env 里填 video.dir / VIDEO_DIR）",
      scannedAt: Date.now(),
    };
  }
  if (!opts.force && cache && cache.dir === dir && Date.now() - cache.at < CACHE_MS) return cache.scan;

  const exts = new Set(cfg.video.exts.map((e) => e.toLowerCase()));
  const files: VideoItem[] = [];
  let problem = "";
  try {
    await walk(dir, "", 1, cfg.video.maxDepth, exts, files);
  } catch (e) {
    problem = explainFsError(dir, e);
  }

  // 剧集名里带集号（E01 / 第 3 集），用带数字感知的比较，免得 E10 排到 E2 前面
  files.sort((a, b) => a.rel.localeCompare(b.rel, "zh-Hans-CN", { numeric: true, sensitivity: "base" }));

  const scan: VideoScan = { dir, files, problem, scannedAt: Date.now() };
  cache = { dir, at: Date.now(), scan };
  return scan;
}

/** 家长后台「重试」用：清掉缓存下次重扫 */
export function invalidateVideoCache(): void {
  cache = null;
}

/**
 * 把 URL 里的 id 解析成**绝对路径**，并做三重校验：
 *   · 必须是 base64url 解出来的相对路径，且逐段没有 `.` / `..`
 *   · 解析后必须仍然落在 video.dir 里面（防路径穿越）
 *   · 扩展名必须在白名单里（别让人拿这个接口去读目录里的任意文件）
 * 任何一条不满足都返回 null。
 */
export function resolveVideoPath(cfg: AppConfig, id: string): string | null {
  if (!cfg.video.dir) return null;
  const rel = decodeId(id);
  if (!rel || rel.includes("\0")) return null;
  if (rel.startsWith("/") || rel.startsWith("\\") || /^[A-Za-z]:/.test(rel)) return null;

  const parts = rel.split("/").filter((p) => p.length > 0);
  if (!parts.length) return null;
  if (parts.some((p) => p === "." || p === "..")) return null;

  const root = path.resolve(cfg.video.dir);
  const abs = path.resolve(root, ...parts);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (!abs.startsWith(prefix)) return null;

  const ext = path.extname(abs).toLowerCase();
  if (!cfg.video.exts.map((e) => e.toLowerCase()).includes(ext)) return null;

  return abs;
}

/**
 * 抽一集：**优先抽没看过的**；整季都看完了就从头再来。
 * `excludeId` 用于「换一个」——尽量别再抽到正在看的那集（只有一集时允许重复）。
 */
export function pickVideoItem(
  files: VideoItem[],
  opts: { watched?: string[]; excludeId?: string; random?: () => number } = {},
): VideoItem | null {
  if (!files.length) return null;
  const watched = new Set(opts.watched ?? []);
  const rnd = opts.random ?? Math.random;
  const take = (list: VideoItem[]): VideoItem => list[Math.min(list.length - 1, Math.floor(rnd() * list.length))]!;

  let pool = files.filter((f) => f.id !== opts.excludeId);
  if (!pool.length) pool = files;

  const fresh = pool.filter((f) => !watched.has(f.id));
  return take(fresh.length ? fresh : pool);
}
