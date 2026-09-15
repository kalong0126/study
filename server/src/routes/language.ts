/**
 * 语言强化训练（AI 出题 · 9 种题型）
 *
 * 数据落在 app_kv，不新建表：
 *   · `language:<date>`           —— 当天那一套 9 道题（含主题 / 参考答案，JSON）
 *   · `languageProgress:<date>`   —— 当天每题的作答状态（自动判卷 或 家长判定）
 *   · `languageRecent`            —— 跨天：最近用过的主题 / 词语 / 场景，用于「最近不要重复」
 *
 * 为什么放 KV 而不是新表：一套题就是一个整体 JSON，按天读一次、整体覆盖写，
 * 没有按字段查询的需求 —— 这正是 app_kv 的适用场景（与 reviewTarget / mathElapsed 同一套路）。
 *
 * 出题走 `story` 用途的大模型配置（该用途的接口地址被固定在 DeepSeek）。
 */
import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { loadConfig, resolveImagegen, resolveLlm } from "../config.js";
import { todayStr } from "../db/index.js";
import { getDaily, kvGet, kvSet, setTaskDone, TASK_KEYS, type DailyState } from "../db/repo/state.js";
import { awardPoints, getBalance } from "../db/repo/points.js";
import { currentChildId } from "../services/child.js";
import { generateImage, imageExists, imageFileName } from "../services/imagegen.js";
import { chat, LlmError } from "../services/llm.js";
import { logLlm } from "../logger.js";
import {
  LANGUAGE_SYSTEM,
  buildLanguagePrompt,
  buildLanguageRetryPrompt,
  parseLanguageSet,
  pickTheme,
  type LanguageSet,
} from "../services/prompts/languagePrompt.js";
import { ah, bStr, fail, ok, qInt } from "./helpers.js";

export const languageRouter = Router();

/** 每题当天的作答状态 */
export interface LanguageProgressEntry {
  questionId: number;
  /** done = 做对/通过；wrong = 做错/没通过 */
  status: "done" | "wrong";
  /** auto = 系统自动判卷；parent = 家长判定 */
  judgedBy: "auto" | "parent";
  /** 孩子提交的内容（选择题所选 / 填空题所填 / 排序结果），仅留痕 */
  answer: string;
  attempts: number;
  at: string;
}

export type LanguageProgress = Record<string, LanguageProgressEntry>;

/** 跨天的去重记忆 */
interface LanguageRecent {
  themes: string[];
  words: string[];
  scenes: string[];
}

const RECENT_THEMES_MAX = 20;
const RECENT_WORDS_MAX = 40;
const RECENT_SCENES_MAX = 10;

function normDate(v: unknown): string {
  const s = bStr(v).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : todayStr();
}

const setKey = (date: string): string => `language:${date}`;
const progKey = (date: string): string => `languageProgress:${date}`;
const imgKey = (date: string): string => `languageImage:${date}`;

/**
 * 当天看图题的配图元信息（图片文件落在 imagegen.dir 下）。
 * `file` 同时当前端拿图的缓存版本号用 —— 换过主题、重画过，文件名就变了，
 * 浏览器不会拿到上一张旧图。
 */
export interface LanguageImageMeta {
  file: string;
  model: string;
  ms: number;
  /** 实际发给文生图模型的提示词（画得不对时便于排查） */
  prompt: string;
  createdAt: string;
}

/* ------------------------------------------------- 打卡任务（第 5 项：语言强化） */

/** 当天语言强化的「题量 / 已完成数」——只数题目数组里真实存在的题 */
function languageCounts(
  set: LanguageSet | null,
  progress: LanguageProgress,
): { total: number; done: number } {
  const questions = set?.questions ?? [];
  const done = questions.filter((q) => progress[String(q.id)]?.status === "done").length;
  return { total: questions.length, done };
}

/**
 * 把「9 道题全部做完」同步成当天的打卡任务 `language`，并发放 20 分。
 *
 * 为什么由后端算而不是让前端打勾：
 *   语言强化有 9 道小题，孩子可能分几次做完、家长可能中途把某题打回「再练一练」，
 *   前端本地那份 daily 很容易和真实进度脱节。真相在 `languageProgress:<date>`，
 *   所以每次作答 / 每次打开页面都重算一遍再回写打卡标记 —— 换设备、刷新、
 *   甚至前端是旧缓存版本，都不会漏掉这 20 分。
 *
 * 规则：**9 道全做完才算完成，一分不给提前量**（用户明确要求「未完成不加分」）；
 * 做完拿到 20 分后若被家长打回一题，打卡标记会取消，但积分**不追回**（见 points.ts 注释）。
 *
 * 幂等：加分靠 ref_key（`language_done:<date>`）去重，重复调用不会重复入账。
 */
async function syncLanguageTask(
  childId: number,
  date: string,
  opt?: { set?: LanguageSet | null; progress?: LanguageProgress },
): Promise<{ daily: DailyState; balance: number; total: number; done: number }> {
  const set = opt?.set !== undefined ? opt.set : ((await kvGet<LanguageSet>(childId, setKey(date))) ?? null);
  const progress =
    opt?.progress !== undefined
      ? opt.progress
      : ((await kvGet<LanguageProgress>(childId, progKey(date))) ?? ({} as LanguageProgress));

  const { total, done } = languageCounts(set, progress);
  const all = total === 9 && done === total;

  const daily = await getDaily(childId, date);
  if (all !== !!daily.tasks.language) await setTaskDone(childId, date, "language", all);

  if (all) {
    await awardPoints(childId, "language_done", `language_done:${date}`);
    // 这一项可能是「最后一块拼图」→ 顺手检查全勤奖（幂等，重复调用不会重复发）
    const after = await getDaily(childId, date);
    if (TASK_KEYS.every((k) => after.tasks[k])) await awardPoints(childId, "all_done", `all_done:${date}`);
  }

  return { daily: await getDaily(childId, date), balance: await getBalance(childId), total, done };
}

async function readRecent(childId: number): Promise<LanguageRecent> {
  const r = await kvGet<Partial<LanguageRecent>>(childId, "languageRecent");
  return {
    themes: Array.isArray(r?.themes) ? (r?.themes ?? []).filter((x): x is string => typeof x === "string") : [],
    words: Array.isArray(r?.words) ? (r?.words ?? []).filter((x): x is string => typeof x === "string") : [],
    scenes: Array.isArray(r?.scenes) ? (r?.scenes ?? []).filter((x): x is string => typeof x === "string") : [],
  };
}

/** 把新的一套题并入「最近用过」清单（旧的留在尾部，超出上限丢弃） */
async function pushRecent(childId: number, set: LanguageSet): Promise<void> {
  const prev = await readRecent(childId);
  const words = set.questions.flatMap((q) => [q.word, ...q.keywords]).filter(Boolean);
  const scene = set.questions[6]?.imagePrompt ?? "";
  const next: LanguageRecent = {
    themes: [set.theme, ...prev.themes.filter((t) => t !== set.theme)].slice(0, RECENT_THEMES_MAX),
    words: Array.from(new Set([...words, ...prev.words])).slice(0, RECENT_WORDS_MAX),
    scenes: [scene, ...prev.scenes.filter((s) => s !== scene)].filter(Boolean).slice(0, RECENT_SCENES_MAX),
  };
  await kvSet(childId, "languageRecent", next);
}

/** 调一次大模型并解析；解析失败时带「纠错话术」重试一次 */
async function generateSet(
  childId: number,
  date: string,
  difficulty: number,
  theme: string,
): Promise<{ set: LanguageSet; ms: number; model: string }> {
  const cfg = loadConfig();
  const provider = resolveLlm(cfg, "story");
  const recent = await readRecent(childId);

  const messages = [
    { role: "system" as const, content: LANGUAGE_SYSTEM },
    {
      role: "user" as const,
      content: buildLanguagePrompt({
        theme,
        difficulty,
        weakAbilities: [],
        recentWords: recent.words.slice(0, 30),
        recentScenes: recent.scenes.slice(0, 6),
      }),
    },
  ];

  const base = {
    tag: "language",
    provider,
    temperature: 0.9,
    maxTokens: 6000,
    timeoutMs: 90000,
  };

  let reason = "";
  let lastErr: unknown = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const msgs = attempt === 1 ? messages : [...messages, { role: "user" as const, content: buildLanguageRetryPrompt(reason) }];

    let result;
    try {
      result = await chat({ ...base, messages: msgs, responseFormat: "json_object" });
    } catch (e) {
      // 少数网关不认 response_format（返回 400）→ 去掉它再试一次，别让家长看到无意义的失败
      const isFmtReject =
        e instanceof LlmError &&
        e.kind === "http" &&
        Number((e.detail as { status?: number })?.status) === 400 &&
        /response_format|json_object/i.test(String((e.detail as { apiMsg?: string })?.apiMsg ?? ""));
      if (!isFmtReject) throw e;
      logLlm.warn({ err: e }, "服务端不支持 response_format=json_object，已去掉该参数重试");
      result = await chat({ ...base, messages: msgs });
    }

    try {
      const set = parseLanguageSet(result.text, { date, model: result.model, ms: result.ms, difficulty, theme });
      return { set, ms: result.ms, model: result.model };
    } catch (e) {
      reason = e instanceof Error ? e.message : String(e);
      lastErr = e;
      logLlm.warn(
        { attempt, reason, bodyHead: result.text.slice(0, 200) },
        "语言强化出题结果无法解析，准备重试",
      );
    }
  }

  throw lastErr instanceof LlmError
    ? lastErr
    : new LlmError("parse", `模型连续两次没有按要求返回 9 道题：${reason}`, { reason });
}

/* ------------------------------------------------------------------ 读取 */

/** 看图题的旧引导文案 → 新文案（只在「还是没有真图」的版本里生成过这几句） */
const STALE_IMAGE_HOWTO: Record<string, string> = {
  "先读两三遍画面描述，再一个问题一个问题地说给大人听。": "先仔细看图，再一个问题一个问题地说给大人听。",
  "按提示的问题，一段一段地说，最后连起来说一遍。": "看着图，按提示的问题一段一段地说，最后连起来说一遍。",
};

/**
 * 修正老题集里看图题的引导文案。
 *
 * 在本版本之前，「看图观察 / 看图说话」只有一段文字描述、没有真图，所以引导文案
 * 写的是「先读两三遍画面描述」；现在真的配了图，那句话就自相矛盾了。
 * 用**精确匹配**只换掉我们自己生成过的旧句子（howTo 从不来自模型，不会误伤），
 * 改完就地回写，省得家长为了看到正确文案还得把整套题换掉。
 */
function fixStaleHowTo(set: LanguageSet): boolean {
  let changed = false;
  for (const q of set.questions) {
    if (q.type !== "image_observation" && q.type !== "image_speaking") continue;
    const next = STALE_IMAGE_HOWTO[q.howTo];
    if (next) {
      q.howTo = next;
      changed = true;
    }
  }
  return changed;
}

/** 当天的题集与作答进度（家长后台重置后前端刷新即用） */
languageRouter.get(
  "/language/today",
  ah(async (req, res) => {
    const childId = await currentChildId();
    const date = normDate(req.query.date);
    const set = (await kvGet<LanguageSet>(childId, setKey(date))) ?? null;
    if (set && fixStaleHowTo(set)) await kvSet(childId, setKey(date), set);
    const progress = (await kvGet<LanguageProgress>(childId, progKey(date))) ?? {};
    const recent = await readRecent(childId);
    // 打开页面时顺手对一遍打卡标记：家长在别的设备上判定过 / 上次刷新过快没写进去，这里都能自愈
    const sync = await syncLanguageTask(childId, date, { set, progress });
    ok(res, {
      date,
      set,
      progress,
      themes: recent.themes,
      image: await imageState(childId, date),
      daily: sync.daily,
      balance: sync.balance,
      counts: { total: sync.total, done: sync.done },
    });
  }),
);

/* ------------------------------------------------------------------ 配图 */

/**
 * 当前配图状态。
 *
 * 三种情况都要让前端能区分开：
 *   · file 有、磁盘上也有  → 可以直接 <img src>
 *   · 题集里的场景变了      → 之前那张图作废（应重新画）
 *   · 从没画过 / 文件丢了   → 前端显示「正在画画」并触发生成
 */
async function imageState(
  childId: number,
  date: string,
): Promise<{ ready: boolean; url: string; version: string; model: string; createdAt: string } | null> {
  const meta = await kvGet<LanguageImageMeta>(childId, imgKey(date));
  if (!meta?.file) return null;
  const dir = resolveImagegen(loadConfig()).dir;
  const ready = imageExists(dir, meta.file);
  return {
    ready,
    // 用 file 当版本号：重画之后 url 变化，浏览器缓存自然失效
    url: `/api/language/image/${date}?v=${encodeURIComponent(meta.file)}`,
    version: meta.file,
    model: meta.model,
    createdAt: meta.createdAt,
  };
}

/**
 * 给当天的「看图观察 / 看图说话」画一张真实的图。
 *
 * 幂等：已经画过、且场景没变（文件名一致）就直接返回，不重复花钱。
 * 画完把图片下载到本地（厂商给的地址只有 24 小时有效），只把元信息存 KV。
 */
languageRouter.post(
  "/language/image",
  ah(async (req, res) => {
    const childId = await currentChildId();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const date = normDate(body.date);
    const force = body.force === true;

    const set = await kvGet<LanguageSet>(childId, setKey(date));
    if (!set) {
      fail(res, 404, `还没有 ${date} 的语言强化题目，请先生成`);
      return;
    }
    const scene = String(set.questions[6]?.imagePrompt ?? "").trim();
    if (!scene) {
      fail(res, 400, "今天的第 7 题（看图观察）没有画面描述，无法配图");
      return;
    }

    const cfg = loadConfig();
    const ig = resolveImagegen(cfg);
    const file = imageFileName(date, scene);
    const prev = await kvGet<LanguageImageMeta>(childId, imgKey(date));

    if (!force && prev?.file === file && imageExists(ig.dir, file)) {
      ok(res, { image: await imageState(childId, date), cached: true });
      return;
    }

    let out;
    try {
      out = await generateImage(date, scene, cfg);
    } catch (e) {
      if (!handleImageError(res, e)) throw e;
      return;
    }

    const meta: LanguageImageMeta = {
      file: out.file,
      model: out.model,
      ms: out.ms,
      prompt: out.prompt,
      createdAt: new Date().toISOString(),
    };
    await kvSet(childId, imgKey(date), meta);

    ok(res, {
      image: await imageState(childId, date),
      cached: false,
      ms: out.ms,
      model: out.model,
      bytes: out.bytes,
    });
  }),
);

/**
 * 取当天的配图。
 *
 * 只认 KV 里记着的那个文件名 —— 不拿 URL 参数去拼磁盘路径（避免路径穿越），
 * 文件本身是按「日期 + 场景哈希」生成的，天然不会重名。
 */
languageRouter.get(
  "/language/image/:date",
  ah(async (req, res) => {
    const childId = await currentChildId();
    const date = normDate(req.params.date);
    const meta = await kvGet<LanguageImageMeta>(childId, imgKey(date));
    if (!meta?.file) {
      fail(res, 404, `还没有 ${date} 的配图`);
      return;
    }
    const ig = resolveImagegen(loadConfig());
    const abs = path.join(ig.dir, path.basename(meta.file));
    if (!imageExists(ig.dir, path.basename(meta.file))) {
      fail(res, 404, "配图文件已丢失，请重新生成");
      return;
    }
    // 文件名带场景哈希（即版本号），换了图 url 就变 → 可以放心长缓存
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.sendFile(abs);
  }),
);

/** 清掉当天的题目、作答与配图（家长后台「重置今日」也会清这几个键） */
languageRouter.post(
  "/language/reset",
  ah(async (req, res) => {
    const childId = await currentChildId();
    const date = normDate((req.body ?? {}).date);
    const meta = await kvGet<LanguageImageMeta>(childId, imgKey(date));
    await kvSet(childId, setKey(date), null);
    await kvSet(childId, progKey(date), {});
    await kvSet(childId, imgKey(date), null);
    // 题目没了 → 打卡标记退回「待完成」（已发的积分不追回）
    const sync = await syncLanguageTask(childId, date, { set: null, progress: {} });
    // 图片文件一并删掉：今天画的图今天作废，留着只会占磁盘
    if (meta?.file) {
      const ig = resolveImagegen(loadConfig());
      await cleanupOne(ig.dir, meta.file);
    }
    ok(res, { date, daily: sync.daily });
  }),
);

async function cleanupOne(dir: string, file: string): Promise<void> {
  try {
    await fs.promises.unlink(path.join(dir, path.basename(file)));
  } catch {
    /* 文件不在了也无所谓 */
  }
}

/* ------------------------------------------------------------------ 出题 */

/**
 * 生成当天的 9 道题。
 *   · 已有当天题集且 force !== true → 直接返回（幂等，避免重复花钱、重复刷新孩子正在做的题）
 *   · theme 不传则从主题池里随机挑一个最近没用过的
 */
languageRouter.post(
  "/language/generate",
  ah(async (req, res) => {
    const childId = await currentChildId();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const date = normDate(body.date);
    const force = body.force === true;

    if (!force) {
      const existing = await kvGet<LanguageSet>(childId, setKey(date));
      if (existing?.questions?.length === 9) {
        if (fixStaleHowTo(existing)) await kvSet(childId, setKey(date), existing);
        const sync = await syncLanguageTask(childId, date, { set: existing });
        ok(res, {
          set: existing,
          cached: true,
          ms: existing.ms,
          model: existing.model,
          daily: sync.daily,
          balance: sync.balance,
        });
        return;
      }
    }

    const recent = await readRecent(childId);
    const theme = bStr(body.theme).trim() || pickTheme(recent.themes);
    const difficulty = qInt(body.difficulty, 2, 1, 5);

    let out;
    try {
      out = await generateSet(childId, date, difficulty, theme);
    } catch (e) {
      if (!handleLanguageError(res, e)) throw e;
      return;
    }

    await kvSet(childId, setKey(date), out.set);
    // 换一套题 = 之前的作答作废 → 打卡标记也要跟着退回「待完成」（已发的 20 分不追回）
    await kvSet(childId, progKey(date), {});
    await pushRecent(childId, out.set);
    const sync = await syncLanguageTask(childId, date, { set: out.set, progress: {} });

    logLlm.info(
      { date, theme: out.set.theme, questions: out.set.questions.length, ms: out.ms, model: out.model },
      "语言强化出题完成",
    );
    ok(res, {
      set: out.set,
      cached: false,
      ms: out.ms,
      model: out.model,
      daily: sync.daily,
      balance: sync.balance,
    });
  }),
);

/* ------------------------------------------------------------------ 作答 */

/** 保存一题的作答结果（自动判卷 / 家长判定都走这里） */
languageRouter.post(
  "/language/progress",
  ah(async (req, res) => {
    const childId = await currentChildId();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const date = normDate(body.date);

    const set = await kvGet<LanguageSet>(childId, setKey(date));
    if (!set) {
      fail(res, 404, `还没有 ${date} 的语言强化题目，请先生成`);
      return;
    }

    const questionId = qInt(body.questionId, 0, 1, 99);
    const question = set.questions.find((q) => q.id === questionId);
    if (!question) {
      fail(res, 400, `第 ${questionId} 题不存在`);
      return;
    }

    const status = body.status === "done" ? "done" : body.status === "wrong" ? "wrong" : null;
    if (!status) {
      fail(res, 400, "status 只能是 done 或 wrong");
      return;
    }

    const progress = (await kvGet<LanguageProgress>(childId, progKey(date))) ?? {};
    const prev = progress[String(questionId)];
    progress[String(questionId)] = {
      questionId,
      status,
      judgedBy: body.judgedBy === "parent" ? "parent" : "auto",
      answer: bStr(body.answer).slice(0, 300),
      attempts: (prev?.attempts ?? 0) + 1,
      at: new Date().toISOString(),
    };
    await kvSet(childId, progKey(date), progress);
    // 9 道全做完 → 打勾首页那一项 + 发 20 分；少一道都不给（顺便处理「被家长打回一题」的情况）
    const sync = await syncLanguageTask(childId, date, { set, progress });
    ok(res, { progress, daily: sync.daily, balance: sync.balance, counts: { total: sync.total, done: sync.done } });
  }),
);

/* ------------------------------------------------------------ 错误翻译 */

/** 语言强化的失败提示：比通用文案更具体（家长一看就知道该改哪儿） */
function handleLanguageError(res: import("express").Response, e: unknown): boolean {
  if (!(e instanceof LlmError)) return false;
  const kind = e.kind;
  const status = kind === "config" ? 400 : kind === "timeout" ? 504 : 502;
  const hint =
    kind === "config"
      ? "（家长请在后台「系统与数据」里确认故事模型的 API Key 已填写）"
      : kind === "timeout"
        ? "（题目较长，可以稍后再点一次；或在 config.yaml 里放宽 llm.timeoutMs.story）"
        : kind === "parse"
          ? "（模型这次没有按格式返回 9 道题，点「再来一套」会重新出一份）"
          : "";
  res.status(status).json({
    ok: false,
    error: `${e.message}${hint}`,
    kind,
    detail: e.detail,
  });
  return true;
}

/**
 * 配图失败的提示。
 * 配图是「锦上添花」的一步：失败时前端会退回纯文字画面描述，题目照样能做，
 * 所以文案要说明「不影响做题」，别让家长以为整套练习都坏了。
 */
function handleImageError(res: import("express").Response, e: unknown): boolean {
  if (!(e instanceof LlmError)) return false;
  const kind = e.kind;
  const status = kind === "config" ? 400 : kind === "timeout" ? 504 : 502;
  const hint =
    kind === "config"
      ? "（家长请在后台「系统与数据」里确认判卷模型的 API Key 已填写 —— 画图默认复用它那把阿里云百炼 Key；也可以单独配 IMAGEGEN_API_KEY）"
      : kind === "timeout"
        ? "（画图比较慢，可以再点一次试试）"
        : kind === "http" && Number((e.detail as { status?: number })?.status) === 401
          ? "（API Key 无效或不属于阿里云百炼北京地域，画图接口拒绝了这个 Key）"
          : "（不影响做题，这题会退回用文字描述画面）";
  res.status(status).json({
    ok: false,
    error: `画图失败：${e.message}${hint}`,
    kind,
    detail: e.detail,
  });
  return true;
}
