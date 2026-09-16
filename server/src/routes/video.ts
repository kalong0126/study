/**
 * 英文故事（内网共享里的 mp4）
 *
 * 数据放在 app_kv，不新建表：
 *   · `videoWatch:<date>`  —— 当天在播哪一集 + 实看秒数 + 是否已完整看完（打卡的真相）
 *   · `videoWatched`       —— 跨天：看完过的集，抽片时优先避开，别连着几天抽到同一集
 *
 * 为什么打卡由后端算：孩子可能分几次看、可能看到一半去写作业、家长可能在别的设备上点过，
 * 前端本地那份 daily 很容易和真实进度脱节。真相在 `videoWatch:<date>` 里，
 * 每次上报进度 / 每次打开页面都重算一遍再回写打卡标记（与 language 同一套路）。
 *
 * 抽片规则：
 *   · **同一天进来不换片** —— 否则刷新一次就换一集，刚看一半的进度全废
 *   · 优先抽没看过的；整季看完了就从头再来
 *   · `complete` **当天只前进不回退** —— 孩子看完拿到 10 分后再点「换一个」，
 *     不该把已经到手的打卡和分数抹掉
 */
import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { loadConfig } from "../config.js";
import { todayStr } from "../db/index.js";
import { getDaily, kvGet, kvSet, setTaskDone, TASK_KEYS, type DailyState } from "../db/repo/state.js";
import { awardPoints, getBalance } from "../db/repo/points.js";
import { currentChildId } from "../services/child.js";
import { logVideo } from "../logger.js";
import {
  invalidateVideoCache,
  mimeOf,
  pickVideoItem,
  resolveVideoPath,
  scanVideos,
  type VideoItem,
  type VideoScan,
} from "../services/video.js";
import { ah, bStr, fail, ok } from "./helpers.js";

export const videoRouter = Router();

/** 当天观影记录 */
export interface VideoWatch {
  date: string;
  /** 当前在播的那一集（相对路径的 base64url 标识） */
  itemId: string;
  rel: string;
  title: string;
  /** 实看秒数（前端只在「正在播放」时累加，拖动进度条不算） */
  watchedSec: number;
  durationSec: number;
  /** 是否播到过结尾（浏览器 ended 事件） */
  ended: boolean;
  /** 今天是否已经完整看完过一集；一旦 true 当天不再回退 */
  complete: boolean;
  completeTitle: string;
  completeAt: string;
  updatedAt: string;
}

/** 看完判定：实看 ≥ 90% 时长。时长还没拿到（metadata 未加载）时，只认 ended + 至少 60 秒 */
const WATCH_RATIO = 0.9;
const FALLBACK_MIN_SEC = 60;

/** 跨天「看过」清单的上限（远超一般的集数，纯粹防止无限增长） */
const WATCHED_MAX = 500;

const watchKey = (date: string): string => `videoWatch:${date}`;

function normDate(v: unknown): string {
  const s = bStr(v).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : todayStr();
}

function blankWatch(date: string): VideoWatch {
  return {
    date,
    itemId: "",
    rel: "",
    title: "",
    watchedSec: 0,
    durationSec: 0,
    ended: false,
    complete: false,
    completeTitle: "",
    completeAt: "",
    updatedAt: new Date().toISOString(),
  };
}

function num(v: unknown, max = 24 * 3600): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(max, Math.round(n * 10) / 10);
}

function watchedEnough(w: VideoWatch): boolean {
  if (w.durationSec > 0) return w.watchedSec >= w.durationSec * WATCH_RATIO;
  return w.ended && w.watchedSec >= FALLBACK_MIN_SEC;
}

async function readWatched(childId: number): Promise<string[]> {
  const raw = await kvGet<unknown>(childId, "videoWatched");
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === "string");
}

/**
 * 记一笔「这一集看完了」。
 * 全部集数都进清单了 → 只留当前这一集，下一轮从头重来（否则清单只会越长越长，
 * 抽片永远命中不到「没看过的」）。
 */
async function rememberWatched(childId: number, itemId: string, scan: VideoScan): Promise<void> {
  const prev = await readWatched(childId);
  const next = [itemId, ...prev.filter((x) => x !== itemId)];
  const all = scan.files.length > 0 && scan.files.every((f) => next.includes(f.id));
  await kvSet(childId, "videoWatched", (all ? [itemId] : next).slice(0, WATCHED_MAX));
}

/* ------------------------------------------------- 打卡任务（第 5 项：英文故事） */

/**
 * 把「今天完整看完过一集」同步成打卡任务 `video`，并发 10 分。
 * 幂等：加分靠 ref_key（`video_done:<date>`）去重，重复调用不会重复入账。
 */
async function syncVideoTask(
  childId: number,
  date: string,
  watch?: VideoWatch | null,
): Promise<{ daily: DailyState; balance: number; complete: boolean }> {
  const w = watch !== undefined ? watch : await kvGet<VideoWatch>(childId, watchKey(date));
  const done = w?.complete === true;

  const daily = await getDaily(childId, date);
  if (done !== !!daily.tasks.video) await setTaskDone(childId, date, "video", done);

  if (done) {
    await awardPoints(childId, "video_done", `video_done:${date}`);
    // 这一项可能是「最后一块拼图」→ 顺手检查全勤奖（幂等）
    const after = await getDaily(childId, date);
    if (TASK_KEYS.every((k) => after.tasks[k])) await awardPoints(childId, "all_done", `all_done:${date}`);
  }

  return { daily: await getDaily(childId, date), balance: await getBalance(childId), complete: done };
}

/** 前端需要的字段（别把整个 KV 记录原样丢出去） */
function publicItem(it: VideoItem): Record<string, unknown> {
  return { id: it.id, title: it.title, name: it.name, ext: it.ext, sizeMB: Math.round(it.size / 1048576) };
}

function publicWatch(w: VideoWatch | null | undefined): Record<string, unknown> | null {
  if (!w) return null;
  return {
    itemId: w.itemId,
    title: w.title,
    watchedSec: w.watchedSec,
    durationSec: w.durationSec,
    complete: w.complete,
    completeTitle: w.completeTitle,
    hasItem: !!w.itemId,
  };
}

/* ------------------------------------------------------------------ 读取 */

/**
 * 当天的状态：要放哪一集 + 已经看了多久。
 *
 * 幂等：同一天反复进来拿到的都是同一集（除非孩子点「换一个」）。
 * 目录读不了时 `problem` 会有值，前端据此显示「共享断了」而不是干转圈。
 */
videoRouter.get(
  "/video/today",
  ah(async (req, res) => {
    const childId = await currentChildId();
    const date = normDate(req.query.date);
    const cfg = loadConfig();

    if (!cfg.video.enabled) {
      const daily = await getDaily(childId, date);
      ok(res, { date, enabled: false, daily, balance: await getBalance(childId) });
      return;
    }

    const scan = await scanVideos(cfg);
    const watchedIds = await readWatched(childId);
    let watch = await kvGet<VideoWatch>(childId, watchKey(date));

    // 当天指定的那一集：只要文件还在就继续用它（刷新、换设备都不会跳片）
    let item = watch?.itemId ? (scan.files.find((f) => f.id === watch?.itemId) ?? null) : null;

    if (!item && scan.files.length) {
      item = pickVideoItem(scan.files, { watched: watchedIds });
    }

    if (item && item.id !== watch?.itemId) {
      const prev = watch;
      // 换片时把「今天的完成」带过去 —— complete 当天只前进不回退
      watch = {
        ...blankWatch(date),
        complete: prev?.complete ?? false,
        completeTitle: prev?.completeTitle ?? "",
        completeAt: prev?.completeAt ?? "",
        itemId: item.id,
        rel: item.rel,
        title: item.title,
      };
      await kvSet(childId, watchKey(date), watch);
    }

    const sync = await syncVideoTask(childId, date, watch);

    if (scan.problem) logVideo.warn({ dir: scan.dir, problem: scan.problem }, "视频目录读取失败");

    ok(res, {
      date,
      enabled: true,
      problem: scan.problem,
      total: scan.files.length,
      unwatched: scan.files.filter((f) => !watchedIds.includes(f.id)).length,
      item: item ? publicItem(item) : null,
      watch: publicWatch(watch),
      daily: sync.daily,
      balance: sync.balance,
    });
  }),
);

/** 「换一个」：抽一集别的（优先没看过的），并把这天在播的换成它 */
videoRouter.post(
  "/video/next",
  ah(async (req, res) => {
    const childId = await currentChildId();
    const date = normDate((req.body ?? {}).date);
    const cfg = loadConfig();

    if (!cfg.video.enabled) {
      fail(res, 400, "英文故事功能已在配置里关闭");
      return;
    }

    const scan = await scanVideos(cfg);
    if (!scan.files.length) {
      fail(res, 409, scan.problem || "目录里没有能播放的视频（只支持 mp4 / webm / mov）");
      return;
    }

    const prev = await kvGet<VideoWatch>(childId, watchKey(date));
    const item = pickVideoItem(scan.files, { watched: await readWatched(childId), excludeId: prev?.itemId });
    if (!item) {
      fail(res, 409, "抽不出视频，请检查共享目录");
      return;
    }

    const watch: VideoWatch = {
      ...blankWatch(date),
      // complete 当天只前进不回退：已经看完拿过 10 分，换个片继续看不该把它抹掉
      complete: prev?.complete ?? false,
      completeTitle: prev?.completeTitle ?? "",
      completeAt: prev?.completeAt ?? "",
      itemId: item.id,
      rel: item.rel,
      title: item.title,
    };
    await kvSet(childId, watchKey(date), watch);

    const sync = await syncVideoTask(childId, date, watch);
    logVideo.info({ date, title: item.title, total: scan.files.length }, "换了一集英文故事");
    ok(res, { date, item: publicItem(item), watch: publicWatch(watch), daily: sync.daily, balance: sync.balance });
  }),
);

/** 共享刚挂上 / 目录刚加完文件时用：清缓存重扫一次 */
videoRouter.post(
  "/video/rescan",
  ah(async (_req, res) => {
    invalidateVideoCache();
    const scan = await scanVideos(loadConfig(), { force: true });
    ok(res, { total: scan.files.length, problem: scan.problem, dir: scan.dir });
  }),
);

/* ------------------------------------------------------------------ 上报 */

/**
 * 上报播放进度。前端每 15 秒 + 暂停 / 播完时各来一次。
 *
 * 判定：实看时长 ≥ 时长的 90%（前端只在**真正播放中**累加，拖动进度条不计），
 * 所以「拖到最后」骗不到这 10 分。
 */
videoRouter.post(
  "/video/progress",
  ah(async (req, res) => {
    const childId = await currentChildId();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const date = normDate(body.date);
    const cfg = loadConfig();

    if (!cfg.video.enabled) {
      fail(res, 400, "英文故事功能已在配置里关闭");
      return;
    }

    const id = bStr(body.id).trim();
    const watch = (await kvGet<VideoWatch>(childId, watchKey(date))) ?? blankWatch(date);

    // 上报的已经不是当天在播的那一集（孩子刚点了「换一个」）→ 忽略，不当错误处理
    if (!id || watch.itemId !== id) {
      const sync = await syncVideoTask(childId, date, watch);
      ok(res, { date, ignored: true, watch: publicWatch(watch), daily: sync.daily, balance: sync.balance });
      return;
    }

    const watch2: VideoWatch = { ...watch };
    // 单调递增：反复上报 / 页面重载回来，数字不会倒退
    watch2.watchedSec = Math.max(watch2.watchedSec, num(body.watchedSec));
    const dur = num(body.durationSec);
    if (dur > 0) watch2.durationSec = dur;
    if (body.ended === true) watch2.ended = true;
    watch2.updatedAt = new Date().toISOString();

    if (!watch2.complete && watchedEnough(watch2)) {
      watch2.complete = true;
      watch2.completeTitle = watch2.title;
      watch2.completeAt = watch2.updatedAt;
      await rememberWatched(childId, watch2.itemId, await scanVideos(cfg));
      logVideo.info(
        { date, title: watch2.title, watchedSec: watch2.watchedSec, durationSec: watch2.durationSec },
        "英文故事看完了",
      );
    }

    await kvSet(childId, watchKey(date), watch2);
    const sync = await syncVideoTask(childId, date, watch2);
    ok(res, { date, watch: publicWatch(watch2), daily: sync.daily, balance: sync.balance });
  }),
);

/* ------------------------------------------------------------------ 播放 */

/**
 * 视频流。
 *
 * 必须支持 Range：浏览器要靠 206 才能拖动进度条，某些安卓 Chrome 甚至要求服务端
 * 明确应答 Range 才会开始播。片段大小由浏览器决定（通常几 MB 一次）。
 *
 * 不做缓存：共享上的文件随时可能被替换，而 Range 请求本身足够轻。
 */
videoRouter.get(
  "/video/stream/:id",
  ah(async (req, res) => {
    const cfg = loadConfig();
    const id = String(req.params.id ?? "");
    const abs = resolveVideoPath(cfg, id);
    if (!abs) {
      fail(res, 400, "视频标识不合法");
      return;
    }

    let st: fs.Stats;
    try {
      st = await fs.promises.stat(abs);
    } catch (e) {
      // 共享断了 / 文件被删 —— 孩子那边表现为「播着播着停了」，所以要给出原因
      fail(res, 404, `读不到视频文件（${explain(e)}）`);
      return;
    }
    if (!st.isFile() || st.size <= 0) {
      fail(res, 404, "视频文件不可用");
      return;
    }

    const size = st.size;
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type", mimeOf(path.extname(abs)));
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Disposition", "inline");

    const range = parseRange(req.headers.range ?? "", size);
    if (range === "invalid") {
      res.setHeader("Content-Range", `bytes */${size}`);
      res.status(416).end();
      return;
    }

    const start = range ? range.start : 0;
    const end = range ? range.end : size - 1;
    res.status(range ? 206 : 200);
    if (range) res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
    res.setHeader("Content-Length", String(end - start + 1));

    if (req.method === "HEAD") {
      res.end();
      return;
    }

    const stream = fs.createReadStream(abs, { start, end });
    stream.on("error", (e) => {
      logVideo.warn({ err: e, file: abs }, "视频流读取中断");
      res.destroy();
    });
    // 孩子往回拖 / 关页面时立刻停掉底层读，别把 SMB 连接占着
    res.on("close", () => stream.destroy());
    stream.pipe(res);
  }),
);

/** 解析 Range 头：`bytes=start-end` / `bytes=start-` / `bytes=-suffix` */
function parseRange(header: string, size: number): { start: number; end: number } | "invalid" | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null; // 不认识的写法 → 当没有 Range，整份返回
  const [, s, e] = m;
  if (s === "" && e === "") return "invalid";

  if (s === "") {
    const n = Number(e);
    if (!Number.isFinite(n) || n <= 0) return "invalid";
    return { start: Math.max(0, size - n), end: size - 1 };
  }

  const start = Number(s);
  const end = e === "" ? size - 1 : Number(e);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "invalid";
  if (start > end || start >= size) return "invalid";
  return { start, end: Math.min(end, size - 1) };
}

function explain(e: unknown): string {
  const code = (e as NodeJS.ErrnoException)?.code ?? "";
  if (code === "ENOENT") return "共享里的文件不在了";
  if (code === "EACCES" || code === "EPERM") return "没有读取权限";
  if (["EBUSY", "ETIMEDOUT", "ENOTFOUND", "EHOSTDOWN", "EIO", "ECONNRESET"].includes(code)) return "共享连接断了";
  return (e as Error)?.message || String(e);
}
