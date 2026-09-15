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
import { Router } from "express";
import { loadConfig, resolveLlm } from "../config.js";
import { todayStr } from "../db/index.js";
import { kvGet, kvSet } from "../db/repo/state.js";
import { currentChildId } from "../services/child.js";
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

/** 当天的题集与作答进度（家长后台重置后前端刷新即用） */
languageRouter.get(
  "/language/today",
  ah(async (req, res) => {
    const childId = await currentChildId();
    const date = normDate(req.query.date);
    const set = (await kvGet<LanguageSet>(childId, setKey(date))) ?? null;
    const progress = (await kvGet<LanguageProgress>(childId, progKey(date))) ?? {};
    const recent = await readRecent(childId);
    ok(res, { date, set, progress, themes: recent.themes });
  }),
);

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
        ok(res, {
          set: existing,
          cached: true,
          ms: existing.ms,
          model: existing.model,
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
    // 换一套题 = 之前的作答作废
    await kvSet(childId, progKey(date), {});
    await pushRecent(childId, out.set);

    logLlm.info(
      { date, theme: out.set.theme, questions: out.set.questions.length, ms: out.ms, model: out.model },
      "语言强化出题完成",
    );
    ok(res, { set: out.set, cached: false, ms: out.ms, model: out.model });
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
    ok(res, { progress });
  }),
);

/** 清掉当天的题目与作答（家长后台「重置今日」也会清这两个键） */
languageRouter.post(
  "/language/reset",
  ah(async (req, res) => {
    const childId = await currentChildId();
    const date = normDate((req.body ?? {}).date);
    await kvSet(childId, setKey(date), null);
    await kvSet(childId, progKey(date), {});
    ok(res, { date });
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
