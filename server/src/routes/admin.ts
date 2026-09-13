/**
 * 家长内容后台接口
 *
 * 内容（课文 / 生字 / 组词）从代码里解放出来，家长可以自己录新篇章。
 * 内网不鉴权，靠「不告诉孩子这个网址」做隔离；将来要上公网再开 auth.enabled。
 */
import { Router } from "express";
import { loadConfig, resolveLlm } from "../config.js";
import { todayStr } from "../db/index.js";
import {
  bulkImportChars,
  createLesson,
  deleteChar,
  deleteLesson,
  getLesson,
  listLessons,
  replaceChars,
  updateChar,
  updateLesson,
} from "../db/repo/lessons.js";
import { resetAll, resetToday } from "../db/repo/state.js";
import { currentChildId } from "../services/child.js";
import { clearCache } from "../services/tts/cache.js";
import { listEdgeVoices } from "../services/tts/edge.js";
import { chat } from "../services/llm.js";
import { SUGGEST_SYSTEM, buildWordSuggestPrompt, parseWordSuggest } from "../services/prompts/wordSuggest.js";
import { seedLessons } from "../seed/index.js";
import { SEED_STATS } from "../seed/lessons.js";
import { ah, bStr, fail, handleLlmError, ok } from "./helpers.js";

export const adminRouter = Router();

/* -------------------------------------------------------------- 课文 CRUD */
adminRouter.get(
  "/admin/lessons",
  ah(async (_req, res) => {
    ok(res, { lessons: await listLessons(true), seedStats: SEED_STATS });
  }),
);

adminRouter.get(
  "/admin/lessons/:id",
  ah(async (req, res) => {
    const lesson = await getLesson(Number(req.params.id));
    if (!lesson) {
      fail(res, 404, "课文不存在");
      return;
    }
    ok(res, { lesson });
  }),
);

adminRouter.post(
  "/admin/lessons",
  ah(async (req, res) => {
    const title = bStr(req.body?.title).trim();
    if (!title) {
      fail(res, 400, "标题不能为空");
      return;
    }
    const id = await createLesson({
      title,
      unit: bStr(req.body?.unit),
      note: bStr(req.body?.note),
      content: bStr(req.body?.content),
      sortNo: Number.isFinite(Number(req.body?.sortNo)) ? Number(req.body.sortNo) : undefined,
    });
    ok(res, { id, lesson: await getLesson(id) });
  }),
);

adminRouter.put(
  "/admin/lessons/:id",
  ah(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await getLesson(id);
    if (!existing) {
      fail(res, 404, "课文不存在");
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    await updateLesson(id, {
      title: body.title !== undefined ? String(body.title).trim() : undefined,
      unit: body.unit !== undefined ? String(body.unit) : undefined,
      note: body.note !== undefined ? String(body.note) : undefined,
      content: body.content !== undefined ? String(body.content) : undefined,
      sortNo: Number.isFinite(Number(body.sortNo)) ? Number(body.sortNo) : undefined,
    });
    ok(res, { lesson: await getLesson(id) });
  }),
);

adminRouter.delete(
  "/admin/lessons/:id",
  ah(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await getLesson(id);
    if (!existing) {
      fail(res, 404, "课文不存在");
      return;
    }
    await deleteLesson(id);
    ok(res, { deleted: id });
  }),
);

/* ------------------------------------------------------------ 生字录入 */
/** 批量粘贴：自动拆字、去重、注音 */
adminRouter.post(
  "/admin/lessons/:id/chars/bulk",
  ah(async (req, res) => {
    const id = Number(req.params.id);
    const lesson = await getLesson(id);
    if (!lesson) {
      fail(res, 404, "课文不存在");
      return;
    }
    const text = bStr(req.body?.text);
    if (!text.trim()) {
      fail(res, 400, "请粘贴要录入的生字");
      return;
    }
    const r = await bulkImportChars(id, text);
    ok(res, { ...r, lesson: await getLesson(id) });
  }),
);

/** 整表替换（后台编辑器保存时用）—— hidden 要一起带上，否则「隐藏」会被保存动作重置 */
adminRouter.put(
  "/admin/lessons/:id/chars",
  ah(async (req, res) => {
    const id = Number(req.params.id);
    const lesson = await getLesson(id);
    if (!lesson) {
      fail(res, 404, "课文不存在");
      return;
    }
    const raw = Array.isArray(req.body?.chars) ? req.body.chars : [];
    const chars = raw
      .map((c: Record<string, unknown>) => ({
        ch: String(c?.ch ?? "").trim(),
        word: String(c?.word ?? "").trim(),
        hidden: c?.hidden === true,
      }))
      .filter((c: { ch: string }) => c.ch);
    await replaceChars(id, chars);
    ok(res, { lesson: await getLesson(id) });
  }),
);

/** 改单个字的组词（会自动重算拼音——多音字靠组词消歧） */
adminRouter.put(
  "/admin/lessons/:id/chars/:ch",
  ah(async (req, res) => {
    const id = Number(req.params.id);
    const ch = decodeURIComponent(String(req.params.ch));
    const lesson = await getLesson(id);
    if (!lesson) {
      fail(res, 404, "课文不存在");
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    await updateChar(id, ch, {
      word: body.word !== undefined ? String(body.word) : undefined,
      hidden: body.hidden !== undefined ? body.hidden === true : undefined,
    });
    ok(res, { lesson: await getLesson(id) });
  }),
);

adminRouter.delete(
  "/admin/lessons/:id/chars/:ch",
  ah(async (req, res) => {
    const id = Number(req.params.id);
    const ch = decodeURIComponent(String(req.params.ch));
    const lesson = await getLesson(id);
    if (!lesson) {
      fail(res, 404, "课文不存在");
      return;
    }
    await deleteChar(id, ch);
    ok(res, { lesson: await getLesson(id) });
  }),
);

/* ---------------------------------------------------------- AI 组词建议 */
adminRouter.post(
  "/admin/lessons/:id/words/suggest",
  ah(async (req, res) => {
    const id = Number(req.params.id);
    const lesson = await getLesson(id);
    if (!lesson) {
      fail(res, 404, "课文不存在");
      return;
    }
    const onlyEmpty = req.body?.onlyEmpty !== false;
    const visible = lesson.chars.filter((c) => !c.hidden);
    const targets = (onlyEmpty ? visible.filter((c) => !c.word.trim()) : visible).map((c) => c.ch);
    if (!targets.length) {
      ok(res, { cands: {}, reason: onlyEmpty ? "所有生字都已有组词" : "该课没有生字" });
      return;
    }
    const cfg = loadConfig();
    try {
      const r = await chat({
        tag: "suggest",
        provider: resolveLlm(cfg, "suggest"),
        maxTokens: 200 + targets.length * 60,
        messages: [
          { role: "system", content: SUGGEST_SYSTEM },
          { role: "user", content: buildWordSuggestPrompt(lesson.title, targets) },
        ],
      });
      ok(res, { cands: parseWordSuggest(r.text, targets), targets, ms: r.ms });
    } catch (e) {
      if (handleLlmError(res, e)) return;
      throw e;
    }
  }),
);

/* ------------------------------------------------------------ 缓存与种子 */
adminRouter.post(
  "/admin/tts/clear",
  ah(async (_req, res) => {
    const r = await clearCache();
    ok(res, { removed: r.removed, mb: Math.round((r.bytes / 1024 / 1024) * 10) / 10 });
  }),
);

adminRouter.get(
  "/admin/voices",
  ah(async (_req, res) => {
    try {
      const voices = await listEdgeVoices("zh-");
      ok(res, { voices });
    } catch (e) {
      fail(res, 503, `获取音色列表失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }),
);

adminRouter.post(
  "/admin/seed",
  ah(async (req, res) => {
    const reset = req.body?.reset === true;
    ok(res, { result: await seedLessons({ reset }) });
  }),
);

/* ---------------------------------------------------------- 重置学习数据 */

/**
 * 重置孩子的学习数据（开发自测 / 重新开始用）
 *   · scope=today（默认）：只清今天 —— 任务打勾、口算题组、今天相关 KV
 *   · scope=all：清掉该孩子的全部 daily / math_sets / wrong / stories / read_titles / mark_* / app_kv
 *     保留：lessons / lesson_chars / mastery / children / 系统级 KV（seeded_at 等）
 *   · date（可选）：重置日期；scope=today 时用，scope=all 时忽略
 */
adminRouter.post(
  "/admin/reset",
  ah(async (req, res) => {
    const childId = await currentChildId();
    const scope = req.body?.scope === "all" ? "all" : "today";
    const dateRaw = bStr(req.body?.date).trim();
    const date = /^\d{4}-\d{2}-\d{2}$/.test(dateRaw) ? dateRaw : todayStr();

    if (scope === "all") {
      const removed = await resetAll(childId);
      ok(res, { scope, removed, date });
      return;
    }
    const removed = await resetToday(childId, date);
    ok(res, { scope, removed, date });
  }),
);
